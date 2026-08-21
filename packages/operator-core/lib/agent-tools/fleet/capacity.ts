/**
 * fleet:capacity — the Queen's SOURCE-side read of the shared inference-capacity oracle
 * (queen-capacity-aware-dispatch-2026-06-22 P-003, the dispatch counterpart to the gateway's SINK-side
 * priority tiers). It projects the live gateway `/stats` (the SHARED capacity oracle, D-007) into a
 * placement-decision read-model: the bee-tier `dispatchBudget` (spare slots = cap − inFlight − queued),
 * the per-tier caps, pool saturation (utilization / paused / queue), `healthyAccounts`, and a clamped
 * `recommendedHeadroom` for a proposed fresh-spawn count.
 *
 * It does NOT fork any logic: the read-model (`buildCapacityReport`) + the saturation curve live in the
 * `fleet/capacity-dispatch` domain module that `place_batch` already enforces automatically (so what the
 * Queen READS here matches what the placement path DOES), and the signal is the same `fetchGatewayHeadroom`
 * projection the `/admin` surface renders. Read-only; gateway-unreachable ⇒ a fail-safe "no clamp" report.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { parsePriorityTierMap } from '@papercusp/papercusp-shared/agent';
import { COORD_ROLES } from '../coordination/roles';
import { fetchGatewayHeadroom } from '../../inference-gateway/observability';
import {
  buildCapacityReport,
  deriveEdgeThrottleEvidence,
  egressIdentityOf,
  type AccountPoolAvailability,
  type EdgeThrottleSnapshotEntry,
} from '../../fleet/capacity-dispatch';
import { activeWorkspaceId } from '../../workspace-registry';
import type { AccountProvider } from '../../deployment/account-pool';
import type { AccountStatusRow } from '../../deployment/account-pool-store';

/** What each of the two capacity stores says, and whether they disagree. */
export interface CapacityStoreDivergence {
  /** True only when both sides are readable AND they disagree. An unreadable side is `null`, never
   *  `false` — "I could not compare" must not render as "they agree". */
  diverged: boolean | null;
  /** The GATEWAY's live in-memory exclusion state. */
  gatewayUsable: number | null;
  /** The account-pool PROJECTION, written from upstream by accounts:probe-capacity. */
  upstreamAvailable: number | null;
  summary: string;
  /** The concrete action that converges them, or null when there is nothing to reconcile. */
  reconcile: string | null;
}

/**
 * Name the disagreement between the gateway's in-memory view and the upstream-written projection.
 *
 * These are two different stores answering two different questions, and for most of this system's life
 * nothing compared them. That let a real, expensive failure hide in plain sight: the gateway benches an
 * account for an edge throttle, its count drops, the serviceable-admission clamp reads that count and pins
 * fleet-wide admission — while upstream the account is serving 200s and the projection says so. Both
 * numbers are correct; the CONFLICT is the finding, and only this surface can see both halves.
 */
export function divergenceBetweenStores(report: {
  usableAccounts: number | null;
  availableAccounts: number | null;
  blind: boolean;
  blindAccounts: number | null;
}): CapacityStoreDivergence {
  const gatewayUsable = report.usableAccounts;
  const upstreamAvailable = report.availableAccounts;
  if (gatewayUsable == null || upstreamAvailable == null) {
    return {
      diverged: null,
      gatewayUsable,
      upstreamAvailable,
      summary:
        'cannot compare the two stores — ' +
        (gatewayUsable == null ? 'the gateway usable count' : 'the upstream projection') +
        ' is unreadable. This is NOT evidence that they agree.',
      reconcile: 'accounts:probe-capacity { apply: true } re-measures upstream and converges the gateway.',
    };
  }
  if (gatewayUsable === upstreamAvailable) {
    return {
      diverged: false,
      gatewayUsable,
      upstreamAvailable,
      summary: `both stores agree: ${gatewayUsable} account(s).`,
      reconcile: null,
    };
  }
  const staleNote = report.blind
    ? ` ⚠ ${report.blindAccounts ?? 'several'} account(s) carry a stale or missing reading, so the projection side is itself unrefreshed.`
    : '';
  return {
    diverged: true,
    gatewayUsable,
    upstreamAvailable,
    summary:
      `THE TWO STORES DISAGREE — gateway (in-memory rotation): ${gatewayUsable} usable; ` +
      `upstream projection: ${upstreamAvailable} available. They answer different questions, so neither is ` +
      `simply "wrong" — but any verdict quoting one of them alone is unsafe.${staleNote}` +
      (gatewayUsable < upstreamAvailable
        ? ' The gateway is the TIGHTER side, and its count feeds the serviceable-admission clamp — so this gap is actively throttling admission.'
        : ''),
    reconcile:
      'accounts:probe-capacity { apply: true } — it re-measures upstream AND now readmits into the gateway, converging both in one action.',
  };
}

// Re-exported so existing importers (tests, the queen-brief gather) can reach the read-model via either path.
export { buildCapacityReport, type CapacityReport } from '../../fleet/capacity-dispatch';

/** The legacy/default provider for bee/cup placement (EI-12282). */
const BEE_PROVIDER: AccountProvider = 'claude';

/** Infer a provider only from model families with an unambiguous wire backend. */
export function providerForModel(model: string | undefined): AccountProvider | undefined {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/^(?:gpt(?:-|$)|o\d|codex(?:-|$)|openai(?:-|$))/.test(normalized)) return 'codex';
  return 'claude';
}

interface CapacityScopeArgs {
  provider?: AccountProvider;
  model?: string;
  account?: string;
}

interface ResolvedCapacityScope {
  provider: AccountProvider;
  modelProvider?: AccountProvider;
  accountRows?: AccountStatusRow[];
  accountFound?: boolean;
}

/** Resolve the requested backend before reading either gateway or account-pool capacity. */
async function resolveCapacityScope(args: CapacityScopeArgs): Promise<ResolvedCapacityScope> {
  const modelProvider = providerForModel(args.model);
  let accountRows: AccountStatusRow[] | undefined;
  let accountProvider: AccountProvider | undefined;

  // An account pin is itself enough to select a provider. Reuse this read below so an account-only
  // Codex request cannot fall through to the legacy Claude default (the incident's failure shape).
  if (args.account && !args.provider && !modelProvider) {
    try {
      const { accountStatus } = await import('../../deployment/account-pool-store');
      accountRows = await accountStatus(activeWorkspaceId());
      accountProvider = accountRows.find((row) => row.id === args.account)?.provider;
    } catch {
      // Keep the scope explicit but unknown; the later availability read remains fail-safe.
    }
  }

  return {
    provider: args.provider ?? modelProvider ?? accountProvider ?? BEE_PROVIDER,
    modelProvider,
    accountRows,
    accountFound: args.account ? accountRows?.some((row) => row.id === args.account) : undefined,
  };
}

/**
 * EI-18683773458136367: process-local memory of the LAST read's per-account edge-throttle state, so
 * `deriveEdgeThrottleEvidence` can tell a re-arming cooldown (deadline advancing, penalty climbing —
 * a backoff-loop bug) from one genuinely counting down. Deliberately ephemeral (in-memory, not
 * persisted) — this is a live diagnostic heuristic over consecutive `fleet:capacity` reads within one
 * process's lifetime, not a durable record; a restart just means the first post-restart read has no
 * prior snapshot to compare against (rearming reports `undefined` until a second read lands).
 */
const lastEdgeThrottleSnapshot = new Map<string, EdgeThrottleSnapshotEntry>();

/**
 * Best-effort snapshot of REAL account-pool availability for one provider (accounts:status), used to
 * cross-check the gateway's queue-slot dispatchBudget. Returns undefined on any read failure (fail-safe —
 * a missing cross-check leaves the report byte-identical to before this fix).
 *
 * Exported (WI-37161) so `fleet:leader-brief` can build the SAME `CapacityReport` this tool reports —
 * reuse-first: the alternative was leader-brief forking its own account-pool-availability read.
 */
export async function readProviderAvailability(
  provider: AccountProvider,
  accountId?: string,
  preloadedRows?: AccountStatusRow[],
): Promise<AccountPoolAvailability | undefined> {
  try {
    const ws = activeWorkspaceId();
    const { accountStatus } = await import('../../deployment/account-pool-store');
    const rows = (preloadedRows ?? (await accountStatus(ws))).filter(
      (r) => r.provider === provider && (!accountId || r.id === accountId),
    );
    if (rows.length === 0) return undefined;

    // EI-19932168784507536: raw pool-health (accountStatus above) is blind to the owner's
    // session-account-override (allow-list/exclude-list) — the SAME override spawn admission
    // (spawn-env.ts resolveSpawnGatewayEnv) actually enforces and refuses a route for. Without
    // this, an account pool-health calls healthy/usable was counted here even though every real
    // spawn into it would be rejected outright, so this cross-check reported an abundant pool
    // while admission refused every route into the excluded slice.
    const { getAccountOverride, applyAccountOverride } = await import('../../deployment/account-session-override');
    const override = await getAccountOverride(ws);
    const allowedIds = new Set(applyAccountOverride(rows.map((r) => r.id), override));
    const overrideExcludedCount = rows.length - allowedIds.size;

    // EI-18683773458136367: derive the shared-egress / re-arm evidence that gates whether the
    // "down egress proxy, escalate to the owner" claim is actually supportable (see capacity-dispatch.ts).
    const snapshotPrefix = `${ws ?? ''}::`;
    const prevSnapshot = new Map(
      [...lastEdgeThrottleSnapshot]
        .filter(([key]) => key.startsWith(snapshotPrefix))
        .map(([key, v]) => [key.slice(snapshotPrefix.length), v] as const),
    );
    const { sharedEgress, rearming, nextSnapshot } = deriveEdgeThrottleEvidence(
      rows.map((r) => ({
        id: r.id,
        edgeThrottled: r.edgeThrottled,
        edgeThrottleResetAt: r.edgeThrottleResetAt,
        penaltyCount: r.rate.penaltyCount,
        // P-009: was `proxyUrl ?? localAddress ?? undefined`, which reported an account with no explicit
        // binding as UNKNOWN. It is not unknown — it is on the box's default SHARED egress, and saying so
        // is what lets deriveEdgeThrottleEvidence conclude sharedEgress at all. With the proxy entries
        // pulled (permanent per owner directive 2026-08-09) every account hit that branch, so every
        // identity was undefined and the shared-egress diagnosis was structurally unreachable.
        // EI-20613616736215896: pass `egressPool` TOO — it supersedes the singular `egress`, and reading
        // only the singular collapsed every pool-routed account onto one identity, flipping P-009's
        // total-fallback into an affirmative (and wrong) sharedEgress:true → a false owner escalation.
        egressIdentity: egressIdentityOf(r.egress, r.egressPool),
      })),
      prevSnapshot,
    );
    // Replace this workspace's slice wholesale — an account that drops out of throttle and later
    // re-enters should NOT be compared against a stale, unrelated prior episode.
    for (const key of [...lastEdgeThrottleSnapshot.keys()]) {
      if (key.startsWith(snapshotPrefix)) lastEdgeThrottleSnapshot.delete(key);
    }
    for (const [id, v] of nextSnapshot) lastEdgeThrottleSnapshot.set(`${snapshotPrefix}${id}`, v);

    return {
      provider,
      total: rows.length,
      // Excludes accounts the owner's session override forbids routing to — an account can be
      // pool-healthy AND forbidden, and admission (spawn-env.ts) refuses that route regardless.
      available: rows.filter((r) => r.available && allowedIds.has(r.id)).length,
      // A truly-usable account can serve, is not in an edge-throttle cooldown (a bare-429/IP wall),
      // AND is not excluded by the session override.
      usable: rows.filter((r) => r.available && !r.edgeThrottled && allowedIds.has(r.id)).length,
      // How many accounts the override excluded from the counts above — lets a caller distinguish
      // "genuinely no capacity" from "capacity exists but is fenced off by the owner's override".
      overrideExcludedCount,
      // Keep the exact steer alongside the derived counts. A zero usable count can be a
      // deliberate owner restriction, not quota exhaustion; consumers need the active input
      // to explain that distinction without reconstructing it from a refusal.
      sessionOverride: override,
      // EI-18664933641195210: break out WHY unusable accounts are unusable, so a poolExhausted advice
      // can name egress-throttle (owner-infra) vs usage-wall (just wait) instead of lumping both into
      // one vague "walled/rate-paused/edge-throttled" phrase that reads as generic quota exhaustion.
      edgeThrottledCount: rows.filter((r) => r.edgeThrottled).length,
      usageWalledCount: rows.filter((r) => r.usageWalled).length,
      // EI-18791793869559327: a sustainedlyLimited account is still `available`/not-edge-throttled (it
      // counts toward `usable` above), so without this the DEGRADED tier in buildCapacityReport can never
      // fire from a live read — the capacity advisor stayed blind to the pool's own scale-out signal.
      //
      // EI-19944752041493781: this MUST use the exact same predicate as `usable` above (line 102), not a
      // bare `rows.filter`. `AccountPoolAvailability.sustainedlyLimitedCount`'s own doc comment says "how
      // many of the `usable` accounts are sustainedlyLimited" and `degraded` in capacity-dispatch.ts compares
      // it directly against `acct.usable` — but a bare filter counts sustainedlyLimited across ALL accounts,
      // including ones that are unavailable/edge-throttled/override-excluded and therefore NOT in `usable`
      // at all. That mismatch let an unavailable (usage-walled) account's sustainedlyLimited flag get
      // counted against a DIFFERENT, actually-usable account — collapsing `degraded` to true (and the
      // advice to "all N/M usable accounts are sustainedly rate-limited") even when every truly-usable
      // account was fine. Measured live: usable=1 (avi_storewolf, sustainedlyLimited:false), yet the bare
      // filter reported sustainedlyLimitedCount=1 because aviynw (walled, NOT usable) was sustainedlyLimited
      // — a false "DEGRADED" verdict that was relayed to the owner and had to be retracted.
      sustainedlyLimitedCount: rows.filter(
        (r) => r.available && !r.edgeThrottled && allowedIds.has(r.id) && r.sustainedlyLimited,
      ).length,
      edgeThrottledSharedEgress: sharedEgress,
      edgeThrottledRearming: rearming,
      // EI-19281217347369076: `lastProbeFailedAt` is set the moment an accounts:probe-capacity attempt
      // came back 'no-reading' (the probe request itself failed) and cleared the moment ANY real
      // observation lands (recordAccountWindow) — so its presence here means "the last thing we tried
      // on this account got no answer", not "unmeasured in general". A majority of the pool carrying
      // this flag is the network-shaped signal buildCapacityReport degrades `poolExhausted`'s confidence
      // on (see its `blind` computation) instead of reporting a quota-shaped verdict off a stale store.
      //
      // EI-19928050541357086: fold a merely-STALE (never-refreshed) usage-window reading into this same
      // "unreliable" bucket, alongside an outright probe failure — `readingStatus` (accountReadingStatus,
      // account-pool-store.ts) already tracks exactly this ('never-observed'|'stale'|'fresh'), but nothing
      // here consulted it: only an actual probe FAILURE counted toward `blindCount`, so a pool that simply
      // hadn't been re-probed in 30-99 minutes (readingStatus:'stale', lastProbeFailedAt never set) reported
      // blind:false and a confident poolExhausted:true + owner-gated-egress-escalation verdict — which one
      // accounts:probe-capacity call then flatly contradicted (poolExhausted:false, usableAccounts:1) with
      // no other change. Both conditions mean the same thing to a caller: this row's available/usageWalled
      // verdict rests on data that is not a live measurement, so both belong in the one caveat.
      blindCount: rows.filter((r) => r.lastProbeFailedAt != null || r.readingStatus !== 'fresh').length,
    };
  } catch {
    return undefined;
  }
}

/** Backwards-compatible Claude read for the leader brief and existing callers. */
export async function readBeeProviderAvailability(accountId?: string): Promise<AccountPoolAvailability | undefined> {
  return readProviderAvailability(BEE_PROVIDER, accountId);
}

export default defineTool({
  name: 'fleet:capacity',
  description:
    'Read live inference-pool capacity for an explicit provider/model/account scope (the gateway /stats oracle): dispatchBudget (spare slots = cap − inFlight − queued), per-tier caps, pool utilization / paused / queue depth, healthyAccounts, and the reserved tier-1 floor. The legacy default is Claude; pass `provider:"codex"`, `model:"gpt-5.6-luna"`, or a Codex `account` to read the Codex backend. Cross-checks dispatchBudget against REAL account-pool availability and sets `poolExhausted:true` (with factor 0) only for the selected provider. An unmeasured or contradictory scope returns `verdict:"unknown"` instead of borrowing another provider\'s data. Pass `headroom` (a proposed fresh-spawn count) to get it clamped to spare capacity. Returns {ok, verdict, scope, ...CapacityReport}. Gateway-unreachable ⇒ a fail-safe no-clamp report.',
  guidance: {
    when: 'Before a placement round, to size how many FRESH members to spawn: select the provider/model/account scope, then place up to dispatchBudget when scarce (top-ranked first), broadly when abundant. Re-read each cycle — capacity moves.',
    notWhen: 'Inspecting the gateway pool config / confirming a hot-reload — that is gateway:status. Editing the pool — accounts:* + gateway:reload.',
    chaining: 'fleet:capacity { provider: "codex", model: "gpt-5.6-luna", headroom: <members you want to place> } → fleet:place_batch (which ALSO clamps automatically under MUG_CAPACITY_DISPATCH; this tool lets you reason about it first).',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    headroom: z.number().int().min(0).max(10000).optional().describe('A proposed fresh-spawn count to clamp to spare capacity.'),
    provider: z.enum(['claude', 'codex']).optional().describe('Inference provider to inspect; defaults to Claude for backward compatibility.'),
    model: z.string().min(1).max(120).optional().describe('Requested model family; gpt/o/codex models select the Codex backend when provider is omitted.'),
    account: z.string().min(1).max(200).optional().describe('Optional pinned account id. An account-only request resolves its provider from accounts:status.'),
  }),
  async handler(args) {
    const scope = await resolveCapacityScope(args);
    const scopePayload = {
      provider: scope.provider,
      model: args.model ?? null,
      account: args.account ?? null,
    };
    const modelProviderMismatch = !!args.provider && !!scope.modelProvider && args.provider !== scope.modelProvider;
    const accountOnlyScopeUnknown =
      !!args.account && !args.provider && !scope.modelProvider && scope.accountFound !== true;
    if (modelProviderMismatch || accountOnlyScopeUnknown) {
      const reason = modelProviderMismatch
        ? `model '${args.model}' belongs to provider '${scope.modelProvider}', not '${scope.provider}'`
        : `account '${args.account}' has no measured provider row`;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, verdict: 'unknown', provider: scope.provider, model: args.model ?? null, account: args.account ?? null, scope: scopePayload, reason }),
          },
        ],
      };
    }
    let clampArmed = false;
    try {
      const [{ FLAGS }, { getFlag }] = await Promise.all([import('@papercusp/flags'), import('@papercusp/flags/server')]);
      clampArmed = await getFlag(FLAGS.MUG_CAPACITY_DISPATCH, 'system').catch(() => false);
    } catch {
      /* flags unavailable → report clampArmed:false (best-effort) */
    }
    const hr = await fetchGatewayHeadroom({ timeoutMs: 1500, provider: scope.provider });
    const tierMap = parsePriorityTierMap(process.env.GATEWAY_PRIORITY_MAP);
    // EI-12282: cross-check the gateway's queue-slot dispatchBudget against REAL account-pool availability
    // (accounts:status) for the SAME provider/account scope. The gateway's own healthyAccounts can be
    // split-brain-stale; a cross-provider read is never a valid reason to reject a launch.
    const accountAvailability = await readProviderAvailability(scope.provider, args.account, scope.accountRows);
    const report = buildCapacityReport(hr, { clampArmed, headroom: args.headroom, tierMap, accountAvailability });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            // `measured` USED TO MEAN "an availability object exists" — bookkeeping — while being read as
            // "these numbers were measured". Those come apart precisely when it matters: on 2026-08-18 this
            // returned verdict:'measured' with poolExhausted:true while `blind` was true for 6 of 7 accounts,
            // i.e. the exhaustion verdict rested on stale/missing readings. A blind reading now DEMOTES the
            // verdict instead of being a footnote under a confident one (EI-19928050541357086: one
            // probe-capacity call flipped poolExhausted true→false with no other change).
            verdict: !accountAvailability ? 'unknown' : report.blind ? 'blind' : 'measured',
            provider: scope.provider,
            model: args.model ?? null,
            account: args.account ?? null,
            scope: scopePayload,
            ...report,
            // THE TWO STORES, SIDE BY SIDE, WITH THE CONTRADICTION NAMED. `usableAccounts` is the GATEWAY's
            // in-memory exclusion state; `availableAccounts` comes from the account-pool projection that
            // accounts:probe-capacity writes from upstream. Nothing reconciled them, so both could be
            // "right" about different objects and an agent would relay them as one fact. Only this surface
            // sees both halves, so it owns the contradiction rather than leaving it to be noticed.
            divergence: divergenceBetweenStores(report),
          }),
        },
      ],
    };
  },
});
