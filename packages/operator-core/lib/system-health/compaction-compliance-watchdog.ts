/**
 * compaction-compliance-watchdog — the backstop for agent-managed compaction
 * (agent-managed-compaction-2026-07-01 P-009).
 *
 * On a cadence (OFF the per-turn hot path) it estimates each limit-setting session's
 * context size and caches it on coord_presence.context_tokens — the value the
 * coord:inbox usage signal reads to render `context: N/L (X%)` (P-007). It also logs
 * a warning when a session has run PAST its own compaction_limit without compacting.
 *
 * Trust-the-agent design (D-008): the agent self-manages off the injected signal;
 * this only catches the ones that don't. Active escalation (fleet broadcast /
 * force-inject `/compact`) is a documented follow-up rung — v1 caches + logs.
 *
 * Process-level (NOT a DBOS routine), like the git-sync / green / mcp-dark
 * watchdogs. Kill-switch: PAPERCUSP_COMPACTION_WATCHDOG='0'.
 */
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import {
  detectContextDeathForOwner,
  estimateContextTokensForOwner,
  resolveModelSpecForOwner,
} from '../compaction-usage';
import { setContextEstimate, setCompactionLimit } from '../agent-tools/coordination/presence';
import { defaultCompactionLimitForSpec, type ModelTier } from '../agent-config-constants';
import { listActiveClaimFreshnessForOwner } from '../work-item-claims';
import { classifyStaleClaims, type StaleClaim } from '../agent-tools/coordination/tools/inbox-flush-gate';

/** How often the watchdog sweeps. Off the hot path, so a relaxed cadence. */
const DEFAULT_INTERVAL_MS = 2 * 60_000; // 2 min
/** At/over this fraction of the limit ⇒ the agent should have compacted already. */
const OVER_LIMIT_FRACTION = 1.0;
/** Max limit-less live sessions seeded per pass — bounds fs/PG work per sweep. */
const MAX_SEEDS_PER_PASS = 25;

/** In-memory escalation dedup: warn only on the FIRST crossing; clear on recovery. */
const overLimitOwners = new Set<string>();

/** P-019 context-death dedup: one coord escalation per dead owner per process. */
const contextDeathEscalated = new Set<string>();

/** Test seam (P-019). */
export function resetContextDeathEscalationsForTests(): void {
  contextDeathEscalated.clear();
}

/**
 * P-019 member-death detector: a session whose transcript tail carries the
 * "Prompt is too long" window-overflow error is DEAD (it cannot take another
 * turn — a single-exchange overflow cannot be compacted), and it died
 * SILENTLY: presence keeps beating until the process reaps, so leaders see
 * "alive" while nothing works (6 fleet members died this way on 2026-07-01).
 * Raise ONE coord escalation per dead owner so the leader/owner relaunches it
 * (fleet persona tier / trimmed context / a wider-window model).
 */
async function escalateContextDeath(ownerId: string, ownerLabel: string): Promise<void> {
  if (contextDeathEscalated.has(ownerId)) return;
  contextDeathEscalated.add(ownerId);
  console.warn(
    `[compaction-watchdog] ${ownerLabel} (${ownerId}) DIED on "Prompt is too long" — escalating for relaunch (P-019).`,
  );
  try {
    const { openEscalation } = await import('../agent-tools/coordination/escalations');
    // Synthetic system identity — the steering-lease precedent shape.
    await openEscalation(
      {
        ownerId: 'compaction-watchdog',
        ownerLabel: 'system · compaction-watchdog',
        source: 'principal',
        workspaceId: null,
        userId: null,
      },
      {
        severity: 'blocker',
        summary: `fleet member ${ownerLabel} (${ownerId}) died on "Prompt is too long" — context overflowed its model window; it cannot take another turn`,
        body:
          `The session's transcript ends in the window-overflow API error, so every subsequent wake fails silently while presence keeps beating. ` +
          `Relaunch it (fleet:launch-on-plan / psu) with less baseline context: --persona-tier=fleet, --context-size=trimmed, or a wider-window ([1m]) model. ` +
          `Its claims are reclaimable via the stale-claim lane. (context-trimming-tiers-2026-07-01 P-019)`,
      },
    );
  } catch (e) {
    // Best-effort — never fail the sweep; un-dedup so the next pass retries.
    contextDeathEscalated.delete(ownerId);
    console.warn(
      `[compaction-watchdog] context-death escalation failed (will retry): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * D-006 honor leg (context-trimming-tiers P-009): an EXPLICIT per-tier
 * compactionLimit rides the SPAWN RECORD and takes precedence over the
 * model-derived default — spawned_agents.model_tier resolved against the
 * workspace tier menu; a recorded model_spec still beats the fs/argv resolver
 * (a fleet bee's session settings.json rarely names the model). The child's
 * coord ownerId IS its spawnId (sessionOwner: spawnId in operator-spawn), so
 * the lookup keys on either column. Best-effort: null ⇒ resolver fallback.
 */
async function resolveSpawnRecordLimit(
  sql: Sql,
  ownerId: string,
  tierMenu: () => Promise<readonly ModelTier[] | undefined>,
  fleetMember = false,
): Promise<number | null> {
  try {
    const rows = await sql<{ model_spec: string | null; model_tier: string | null }[]>`
      SELECT model_spec, model_tier
        FROM harness_shared.spawned_agents
       WHERE spawn_id = ${ownerId} OR session_owner = ${ownerId}
       ORDER BY started_at DESC
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    if (row.model_tier) {
      const tiers = await tierMenu();
      const tier = tiers?.find((t) => t.name === row.model_tier);
      // parseTiers already clamped a stored explicit limit to the spec's window.
      if (tier?.compactionLimit != null) return tier.compactionLimit;
      if (tier?.spec) return defaultCompactionLimitForSpec(tier.spec, { fleetMember });
    }
    if (row.model_spec) return defaultCompactionLimitForSpec(row.model_spec, { fleetMember });
    return null;
  } catch {
    return null;
  }
}

export interface CompactionComplianceResult {
  /** owners whose estimate was refreshed this pass. */
  estimated: string[];
  /** owners currently over their compaction_limit. */
  overLimit: string[];
  /** owners seeded with a model-derived default limit this pass. */
  seeded: string[];
  /** P-019: owners whose transcript tail carries "Prompt is too long" (dead). */
  contextDeaths: string[];
  /** flush-to-proceed P-003: over-limit sessions holding a work-item claim whose checkpoint is
   *  stale (unflushed work about to be lost to a compaction/reclaim). SURFACED, never seized
   *  (D-008). One entry per (owner, stale claim). */
  unflushedClaims: Array<{ owner: string; workItemId: string; reason: StaleClaim['reason']; staleMs: number }>;
}

/**
 * One pass: SEED a model-derived default limit into limit-less live sessions
 * (context-trimming-tiers P-006/D-006 — the hook that arms the whole
 * agent-managed-compaction loop: signal + self-compaction only engage for
 * limit-carrying sessions), then refresh + cache each limit-setting live
 * session's context estimate and flag any that ran past its own limit.
 * Never throws (best-effort backstop).
 */
export async function checkCompactionCompliance(sql: Sql): Promise<CompactionComplianceResult> {
  const out: CompactionComplianceResult = { estimated: [], overLimit: [], seeded: [], contextDeaths: [], unflushedClaims: [] };
  // Seeding step — one server-side place instead of N spawn paths (D-006).
  // Precedence: the spawn record (explicit tier limit > tier/recorded spec's
  // default) > the argv/fs model resolver (launch argv → session
  // settings.json) > the conservative 200k-window default (~158k). An agent's
  // own config:set-compaction-limit overwrites this at any time.
  try {
    // fleet_slug/fleet_role ride the presence row (mig 418 projection of
    // fleet_membership_events): a named-fleet MEMBER (any role but 'leader')
    // seeds the leaner [1m] member default (owner directive 2026-07-03) —
    // its state reconstructs cheaply from the work-item, so a smaller window
    // cuts per-wake cache spend; leaders keep the full default.
    const unseeded = await sql<
      { owner_id: string; fleet_slug: string | null; fleet_role: string | null }[]
    >`
      SELECT owner_id, fleet_slug, fleet_role
        FROM harness_shared.coord_presence
       WHERE compaction_limit IS NULL
         AND heartbeat_at > now() - interval '10 minutes'
       LIMIT ${MAX_SEEDS_PER_PASS}
    `;
    // Lazy per-pass tier menu: one workspace-config read even when many owners
    // seed; fail-soft to undefined (⇒ spec-derived defaults only).
    let tiersPromise: Promise<readonly ModelTier[] | undefined> | null = null;
    const tierMenu = () =>
      (tiersPromise ??= (async () => {
        try {
          const [{ effectiveTierConfig }, { readAgentConfig }] = await Promise.all([
            import('../fleet/model-tiers'),
            import('../agent-config'),
          ]);
          const cfg = await readAgentConfig().catch(() => null);
          return effectiveTierConfig(cfg, null).tiers;
        } catch {
          return undefined;
        }
      })());
    for (const r of unseeded) {
      try {
        const fleetMember = r.fleet_slug != null && r.fleet_role !== 'leader';
        const fromSpawn = await resolveSpawnRecordLimit(sql, r.owner_id, tierMenu, fleetMember);
        const limit =
          fromSpawn ??
          defaultCompactionLimitForSpec(await resolveModelSpecForOwner(r.owner_id), {
            fleetMember,
          });
        await setCompactionLimit(r.owner_id, limit);
        out.seeded.push(r.owner_id);
      } catch {
        /* best-effort per owner */
      }
    }
    if (out.seeded.length > 0) {
      console.log(`[compaction-watchdog] seeded default compaction limits for ${out.seeded.length} session(s)`);
    }
  } catch (e) {
    console.warn(
      `[compaction-watchdog] seed pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    const rows = await sql<{ owner_id: string; owner_label: string; compaction_limit: number }[]>`
      SELECT owner_id, owner_label, compaction_limit
        FROM harness_shared.coord_presence
       WHERE compaction_limit IS NOT NULL
         AND heartbeat_at > now() - interval '10 minutes'
    `;
    for (const r of rows) {
      // P-019 member-death detector: a "Prompt is too long" transcript tail means
      // the session is dead-but-still-beating — escalate once for relaunch. Runs
      // before the estimate gate (a dead session's estimate is exactly the kind
      // that looks "over limit" or fails to resolve).
      try {
        if (await detectContextDeathForOwner(r.owner_id)) {
          out.contextDeaths.push(r.owner_id);
          await escalateContextDeath(r.owner_id, r.owner_label);
          continue; // no point estimating/flagging a dead session
        }
      } catch {
        /* best-effort per owner */
      }
      const est = await estimateContextTokensForOwner(r.owner_id);
      if (est == null) continue;
      await setContextEstimate(r.owner_id, est).catch(() => {});
      out.estimated.push(r.owner_id);
      if (est >= r.compaction_limit * OVER_LIMIT_FRACTION) {
        out.overLimit.push(r.owner_id);
        // flush-to-proceed P-003 SURFACE (not seize, D-008): a session over its compaction limit
        // that holds a work-item whose CHECKPOINT is stale is about to lose unflushed work to the
        // imminent compaction/reclaim — the exact failure the discipline targets. Name it (reusing
        // the P-002 classifier over a fleet-wide freshness read on the watchdog's own sql seam) so
        // the loss is visible in the over-limit warning + the result. Best-effort; auto-reclaim is
        // deliberately NOT wired here. Owner is a globally-unique session uuid ⇒ null workspace.
        let unflushed: StaleClaim[] = [];
        try {
          const fresh = await listActiveClaimFreshnessForOwner(null, r.owner_id, { sql });
          unflushed = classifyStaleClaims(fresh, Date.now());
          for (const s of unflushed) {
            out.unflushedClaims.push({ owner: r.owner_id, workItemId: s.workItemId, reason: s.reason, staleMs: s.staleMs });
          }
        } catch {
          /* best-effort per owner */
        }
        if (!overLimitOwners.has(r.owner_id)) {
          overLimitOwners.add(r.owner_id);
          const flushNote =
            unflushed.length > 0
              ? ` HOLDING UNFLUSHED WORK: ${unflushed.map((s) => s.workItemId).join(', ')} — its checkpoint is stale, so a compaction/reclaim here loses that state (flush-to-proceed P-003).`
              : '';
          console.warn(
            `[compaction-watchdog] ${r.owner_label} (${r.owner_id}) is over its compaction limit: ` +
              `~${est}/${r.compaction_limit} tokens (${Math.round((est / r.compaction_limit) * 100)}%) — ` +
              `should have called session:request_compaction.${flushNote}`,
          );
        }
      } else {
        overLimitOwners.delete(r.owner_id); // recovered (compacted / back under limit)
      }
    }
  } catch (e) {
    console.warn(
      `[compaction-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return out;
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the compaction-compliance watchdog: a recurring process-level sweep.
 * Idempotent. Kill-switch: PAPERCUSP_COMPACTION_WATCHDOG='0'.
 */
export function startCompactionComplianceWatchdog(
  sql: Sql,
  opts: { intervalMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_COMPACTION_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval(
    'compaction-compliance-watchdog',
    intervalMs,
    () => {
      void checkCompactionCompliance(sql);
    },
    { category: 'watchdog' },
  );
}
