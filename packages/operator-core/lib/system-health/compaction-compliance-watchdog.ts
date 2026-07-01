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
import { estimateContextTokensForOwner } from '../compaction-usage';
import { setContextEstimate } from '../agent-tools/coordination/presence';

/** How often the watchdog sweeps. Off the hot path, so a relaxed cadence. */
const DEFAULT_INTERVAL_MS = 2 * 60_000; // 2 min
/** At/over this fraction of the limit ⇒ the agent should have compacted already. */
const OVER_LIMIT_FRACTION = 1.0;

/** In-memory escalation dedup: warn only on the FIRST crossing; clear on recovery. */
const overLimitOwners = new Set<string>();

export interface CompactionComplianceResult {
  /** owners whose estimate was refreshed this pass. */
  estimated: string[];
  /** owners currently over their compaction_limit. */
  overLimit: string[];
}

/**
 * One pass: refresh + cache each limit-setting live session's context estimate;
 * flag any that ran past its own limit. Never throws (best-effort backstop).
 */
export async function checkCompactionCompliance(sql: Sql): Promise<CompactionComplianceResult> {
  const out: CompactionComplianceResult = { estimated: [], overLimit: [] };
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
