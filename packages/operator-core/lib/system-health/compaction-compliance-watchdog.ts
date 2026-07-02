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
import { estimateContextTokensForOwner, resolveModelSpecForOwner } from '../compaction-usage';
import { setContextEstimate, setCompactionLimit } from '../agent-tools/coordination/presence';
import { defaultCompactionLimitForSpec, type ModelTier } from '../agent-config-constants';

/** How often the watchdog sweeps. Off the hot path, so a relaxed cadence. */
const DEFAULT_INTERVAL_MS = 2 * 60_000; // 2 min
/** At/over this fraction of the limit ⇒ the agent should have compacted already. */
const OVER_LIMIT_FRACTION = 1.0;
/** Max limit-less live sessions seeded per pass — bounds fs/PG work per sweep. */
const MAX_SEEDS_PER_PASS = 25;

/** In-memory escalation dedup: warn only on the FIRST crossing; clear on recovery. */
const overLimitOwners = new Set<string>();

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
      if (tier?.spec) return defaultCompactionLimitForSpec(tier.spec);
    }
    if (row.model_spec) return defaultCompactionLimitForSpec(row.model_spec);
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
  const out: CompactionComplianceResult = { estimated: [], overLimit: [], seeded: [] };
  // Seeding step — one server-side place instead of N spawn paths (D-006).
  // Precedence: the spawn record (explicit tier limit > tier/recorded spec's
  // default) > the fs/argv model resolver (session settings.json → launch
  // argv) > the conservative 200k-window default (~158k). An agent's own
  // config:set-compaction-limit overwrites this at any time.
  try {
    const unseeded = await sql<{ owner_id: string }[]>`
      SELECT owner_id
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
        const fromSpawn = await resolveSpawnRecordLimit(sql, r.owner_id, tierMenu);
        const limit =
          fromSpawn ??
          defaultCompactionLimitForSpec(await resolveModelSpecForOwner(r.owner_id));
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
      const est = await estimateContextTokensForOwner(r.owner_id);
      if (est == null) continue;
      await setContextEstimate(r.owner_id, est).catch(() => {});
      out.estimated.push(r.owner_id);
      if (est >= r.compaction_limit * OVER_LIMIT_FRACTION) {
        out.overLimit.push(r.owner_id);
        if (!overLimitOwners.has(r.owner_id)) {
          overLimitOwners.add(r.owner_id);
          console.warn(
            `[compaction-watchdog] ${r.owner_label} (${r.owner_id}) is over its compaction limit: ` +
              `~${est}/${r.compaction_limit} tokens (${Math.round((est / r.compaction_limit) * 100)}%) — ` +
              `should have called session:request_compaction.`,
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
