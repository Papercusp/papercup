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
  type AccountBindingTerms,
  type EdgeThrottleSnapshotEntry,
} from '../../fleet/capacity-dispatch';
import { activeWorkspaceId } from '../../workspace-registry';
import type { AccountProvider } from '../../deployment/account-pool';
import type { AccountStatusRow } from '../../deployment/account-pool-store';
import { advSessionsByCoordOwner } from '../../adv-sessions';
import { listFleetRosterDiagnosed } from '../../fleet/fleet-roster';
import { resolveAgentIdentity, deriveFleetMembership, type AgentIdentity } from '../coordination/identity';
import { resolvePresenceFleet } from '../coordination/presence-fleet';

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

/**
 * Resolve the inference backends represented by a fleet's CURRENT members.
 *
 * This is intentionally the same member-scoping rule used by fleet:leader-brief:
 * dead historical rows and the observing leader do not describe the pool the
 * workers pull from; visible sessions with no model tier use their authoritative
 * adv-session backend. Unknown/OMP-only rows are ignored, but a fleet with no
 * measured backend is never guessed as Claude.
 */
export function fleetCapacityProvidersForMembers(
  members: ReadonlyArray<{
    agentId?: string;
    model?: string | null;
    alive?: boolean;
    sessionState?: string | null;
    fleetRole?: string | null;
  }>,
  agentByOwner: ReadonlyMap<string, 'claude' | 'omp' | 'codex' | null | undefined> = new Map(),
): AccountProvider[] {
  const providers = new Set<AccountProvider>();
  for (const member of members) {
    if (member.alive === false || member.sessionState === 'ended' || member.sessionState === 'suspect') continue;
    if (member.fleetRole === 'leader') continue;

    const modelProvider = providerForModel(member.model ?? undefined);
    if (modelProvider) {
      providers.add(modelProvider);
      continue;
    }

    const agent = member.agentId ? agentByOwner.get(member.agentId) : undefined;
    if (agent === 'claude' || agent === 'codex') providers.add(agent);
  }
  return [...providers].sort();
}

interface CapacityScopeArgs {
  provider?: AccountProvider;
  model?: string;
  account?: string;
  fleet?: string;
  headroom?: number;
}

interface ResolvedCapacityScope {
  provider: AccountProvider;
  modelProvider?: AccountProvider;
  accountRows?: AccountStatusRow[];
  accountFound?: boolean;
}

type ProviderSource = 'explicit' | 'fleet' | 'legacy-default';

interface FleetScopeContext {
  fleetSlug: string | null;
  ownerId?: string;
  workspaceId: string | null;
}

interface FleetProviderResolution {
  providers: AccountProvider[];
  reason?: string;
}

function resolveWorkspaceId(identity?: AgentIdentity): string | null {
  if (identity?.workspaceId) return identity.workspaceId;
  try {
    return activeWorkspaceId();
  } catch {
    return null;
  }
}

/** Resolve explicit fleet scope or the caller's authoritative current membership. */
async function resolveFleetScope(
  args: CapacityScopeArgs,
  ctx: unknown,
  inferMembership: boolean,
): Promise<FleetScopeContext> {
  let identity: AgentIdentity | undefined;
  try {
    identity = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]);
  } catch {
    // Handler unit tests and non-coordination callers may not carry an identity.
    // They can still use an explicit fleet, while an implicit fleet falls back to
    // the launch label only when that label is available.
  }

  const launchMembership = deriveFleetMembership();
  const explicitFleet = args.fleet?.trim() || null;
  if (explicitFleet) {
    return {
      fleetSlug: explicitFleet,
      ...(identity?.ownerId ? { ownerId: identity.ownerId } : {}),
      workspaceId: resolveWorkspaceId(identity),
    };
  }
  if (!inferMembership) {
    return { fleetSlug: null, workspaceId: resolveWorkspaceId(identity) };
  }

  const membership = identity
    ? await resolvePresenceFleet(identity.ownerId, launchMembership)
    : launchMembership;
  return {
    fleetSlug: membership.fleetSlug,
    ...(identity?.ownerId ? { ownerId: identity.ownerId } : {}),
    workspaceId: resolveWorkspaceId(identity),
  };
}

/** Read the fleet's provider set; every failure is UNKNOWN rather than legacy Claude. */
async function resolveFleetProviders(
  fleetSlug: string,
  workspaceId: string | null,
  ownerId?: string,
): Promise<FleetProviderResolution> {
  try {
    const [roster, sessions] = await Promise.all([
      listFleetRosterDiagnosed({ fleetSlug, workspaceId, leaderOwnerId: ownerId }),
      advSessionsByCoordOwner(),
    ]);
    const agentByOwner = new Map(
      [...sessions].map(([id, session]) => [id, session.agent] as const),
    );
    const providers = fleetCapacityProvidersForMembers(roster.entries, agentByOwner);
    if (providers.length > 0) return { providers };
    return {
      providers,
      reason: roster.degradedLegs.length > 0
        ? `fleet '${fleetSlug}' roster was incomplete (${roster.degradedLegs.join(', ')}); no member backend was measured`
        : `fleet '${fleetSlug}' has no live member backend with a measured provider`,
    };
  } catch {
    return {
      providers: [],
      reason: `fleet '${fleetSlug}' provider scope could not be measured`,
    };
  }
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
    const now = Date.now();
    const futureTerm = (value: number | undefined): number | undefined =>
      value != null && Number.isFinite(value) && value > now ? value : undefined;

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
      // EI-19995356951235246: counts are only marginal evidence. Project the active reset terms for
      // routable accounts so capacity-dispatch can identify the constraint that actually gates the
      // earliest recovery. Expired terms and override-excluded rows must not steer that diagnosis.
      accountBindingTerms: rows
        .filter((r) => allowedIds.has(r.id))
        .map((r): AccountBindingTerms => ({
          id: r.id,
          ...(r.usageWalled && futureTerm(r.usageResetAt) != null
            ? { usageResetAt: futureTerm(r.usageResetAt) }
            : {}),
          ...(r.edgeThrottled && futureTerm(r.edgeThrottleResetAt) != null
            ? { edgeThrottleResetAt: futureTerm(r.edgeThrottleResetAt) }
            : {}),
          ...(futureTerm(r.rate.pausedUntil) != null ? { ratePausedUntil: futureTerm(r.rate.pausedUntil) } : {}),
        }))
        .filter((terms) => terms.usageResetAt != null || terms.edgeThrottleResetAt != null || terms.ratePausedUntil != null),
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

async function readClampArmed(): Promise<boolean> {
  try {
    const [{ FLAGS }, { getFlag }] = await Promise.all([import('@papercusp/flags'), import('@papercusp/flags/server')]);
    return await getFlag(FLAGS.MUG_CAPACITY_DISPATCH, 'system').catch(() => false);
  } catch {
    return false;
  }
}

interface ProviderCapacityReading {
  provider: AccountProvider;
  model: string | null;
  account: string | null;
  verdict: 'blind' | 'measured' | 'unknown';
  [key: string]: unknown;
}

/** One provider-scoped reading, shared by uniform and mixed-fleet responses. */
async function readCapacityForProvider(
  args: CapacityScopeArgs,
  provider: AccountProvider,
  clampArmed: boolean,
  preloadedRows?: AccountStatusRow[],
): Promise<ProviderCapacityReading> {
  const hr = await fetchGatewayHeadroom({ timeoutMs: 1500, provider });
  const accountAvailability = await readProviderAvailability(provider, args.account, preloadedRows);
  const tierMap = parsePriorityTierMap(process.env.GATEWAY_PRIORITY_MAP);
  const report = buildCapacityReport(hr, {
    clampArmed,
    headroom: args.headroom,
    tierMap,
    accountAvailability,
  });
  const accountPool = accountAvailability
    ? {
        provider: accountAvailability.provider ?? provider,
        total: accountAvailability.total,
        available: accountAvailability.available,
        usable: accountAvailability.usable,
        edgeThrottledAccounts: accountAvailability.edgeThrottledCount ?? null,
        usageWalledAccounts: accountAvailability.usageWalledCount ?? null,
        sustainedlyLimitedAccounts: accountAvailability.sustainedlyLimitedCount ?? null,
        overrideExcludedAccounts: accountAvailability.overrideExcludedCount ?? null,
        blindAccounts: accountAvailability.blindCount ?? null,
      }
    : null;
  return {
    provider,
    model: args.model ?? null,
    account: args.account ?? null,
    verdict: !accountAvailability ? 'unknown' : report.blind ? 'blind' : 'measured',
    ...report,
    accountPool,
  };
}

export default defineTool({
  name: 'fleet:capacity',
  description:
    'Read live gateway /stats capacity for an explicit provider/model/account or the caller\'s fleet: dispatchBudget (= cap − inFlight − queued), tier caps, utilization/pauses/queue, healthyAccounts, and reserved floor. `fleet` selects a named fleet; omitted resolves the current fleet. Explicit scope wins; mixed-provider fleets return per-provider readings, never a guessed aggregate. The legacy Claude default applies only outside fleets. Only measured selected-provider exhaustion sets poolExhausted:true/factor 0; contradictory or unmeasured scope returns verdict:"unknown". `headroom` clamps a proposed spawn count. Gateway-unreachable returns fail-safe no-clamp data.',
  guidance: {
    when: 'Before a placement round, to size how many FRESH members to spawn: select the provider/model/account scope, then place up to dispatchBudget when scarce (top-ranked first), broadly when abundant. Re-read each cycle — capacity moves.',
    notWhen: 'Inspecting the gateway pool config / confirming a hot-reload — that is gateway:status. Editing the pool — accounts:* + gateway:reload.',
    chaining: 'fleet:capacity { fleet: "my-fleet", headroom: <members you want to place> } → fleet:place_batch (which ALSO clamps automatically under MUG_CAPACITY_DISPATCH; this tool lets you reason about it first).',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    headroom: z.number().int().min(0).max(10000).optional().describe('A proposed fresh-spawn count to clamp to spare capacity.'),
    provider: z.enum(['claude', 'codex']).optional().describe('Inference provider to inspect; defaults to Claude for backward compatibility.'),
    model: z.string().min(1).max(120).optional().describe('Requested model family; gpt/o/codex models select the Codex backend when provider is omitted.'),
    account: z.string().min(1).max(200).optional().describe('Optional pinned account id. An account-only request resolves its provider from accounts:status.'),
    fleet: z.string().min(1).max(200).optional().describe('Optional named fleet to scope capacity to. Without an explicit backend, a caller in a fleet uses its current live member providers.'),
  }),
  async handler(args, ctx) {
    const scope = await resolveCapacityScope(args);
    const explicitBackend = Boolean(args.provider || args.model || args.account);
    const fleetScope = await resolveFleetScope(args, ctx, !explicitBackend || !!args.fleet);
    const providerSource: ProviderSource = explicitBackend
      ? 'explicit'
      : fleetScope.fleetSlug
        ? 'fleet'
        : 'legacy-default';
    const fleetPayload = fleetScope.fleetSlug ? { fleet: fleetScope.fleetSlug } : {};
    const scopePayload = {
      provider: scope.provider,
      model: args.model ?? null,
      account: args.account ?? null,
      ...fleetPayload,
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
            text: JSON.stringify({
              ok: true,
              verdict: 'unknown',
              provider: scope.provider,
              model: args.model ?? null,
              account: args.account ?? null,
              scope: scopePayload,
              providerSource,
              ...fleetPayload,
              reason,
            }),
          },
        ],
      };
    }

    let providers: AccountProvider[];
    let fleetReason: string | undefined;
    if (!explicitBackend && fleetScope.fleetSlug) {
      const fleetResolution = await resolveFleetProviders(
        fleetScope.fleetSlug,
        fleetScope.workspaceId,
        fleetScope.ownerId,
      );
      providers = fleetResolution.providers;
      fleetReason = fleetResolution.reason;
      if (providers.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                verdict: 'unknown',
                provider: null,
                model: null,
                account: null,
                scope: { ...scopePayload, provider: null },
                providerSource,
                ...fleetPayload,
                providers: [],
                reason: fleetReason,
              }),
            },
          ],
        };
      }
    } else {
      providers = [scope.provider];
    }
    const clampArmed = await readClampArmed();
    const readings = await Promise.all(
      providers.map((provider) => readCapacityForProvider(args, provider, clampArmed, scope.accountRows)),
    );

    if (readings.length > 1) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              verdict: 'unknown',
              provider: null,
              model: null,
              account: null,
              scope: { ...scopePayload, provider: null },
              providerSource,
              ...fleetPayload,
              providers,
              providerReadings: readings,
              reason:
                fleetReason ??
                `fleet '${fleetScope.fleetSlug ?? 'unknown'}' has mixed member providers; no single capacity verdict is valid`,
            }),
          },
        ],
      };
    }

    const reading = readings[0]!;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            ...reading,
            scope: { ...scopePayload, provider: reading.provider },
            providerSource,
            ...fleetPayload,
          }),
        },
      ],
    };
  },
});
