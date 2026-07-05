/**
 * queen-warm-session — L2 of queen-memory-hybrid-2026-07-02 (owner-approved hybrid).
 *
 * Under FLAGS.QUEEN_WARM_SESSION the queen's wakes prefer the wake-executor
 * liveness ladder (inject-if-live / `claude --resume`-if-exited — the proven
 * B-LOOP-3 machinery that keeps su engine-loop sessions warm) over a cold
 * invoke-once spawn: continuity + prompt-cache warmth by default. This module is
 * the DETERMINISTIC REBIRTH decider — the safety valve that bounds
 * summary-drift/poisoning and keeps the restart-tolerance that makes
 * fresh-per-turn safe. A rebirth is NOT an error path: it falls through to the
 * cold spawn (today's exact behavior), and the brief + carry-journal + standing
 * facts make it cost warmth, never correctness.
 *
 * PURE — unit-tested with no IO; the wake chokepoint supplies the inputs.
 */

/** Max warm-session age before a scheduled rebirth (L2b). */
export const QUEEN_SESSION_MAX_AGE_MS = 24 * 3600 * 1000;

export type QueenWakeMode = 'warm' | 'rebirth' | 'cold';

export interface QueenRebirthInputs {
  /** Boot id recorded when the warm session was born. */
  sessionBootId: string | null;
  /** The host's current boot id. */
  currentBootId: string | null;
  /** ms epoch when the warm session was born. */
  sessionStartedMs: number | null;
  nowMs: number;
  /** The queen's autoloop consecutive_errors (anomaly signal). */
  consecutiveErrors?: number;
  /** The latest hive-coordination-health scorecard is red / missing (anomaly). */
  scorecardUnhealthy?: boolean;
}

/** Why a rebirth (or cold start) was chosen — stamped into the wake-mode metric. */
export interface QueenWakeDecision {
  mode: QueenWakeMode;
  reason: string;
}

/**
 * Decide warm-resume vs rebirth for a queen wake. `cold` = no resumable session
 * exists at all (first wake / caller found nothing to resume). Rebirth wins on
 * ANY of: boot-id change (the process world restarted under the session),
 * session older than {@link QUEEN_SESSION_MAX_AGE_MS}, or an anomaly signal
 * (error streak / unhealthy scorecard) — a struggling warm session must never
 * be resumed into, that is how drift compounds.
 */
/**
 * The IMPURE warm-wake attempt the blueprint-run fire chokepoint calls BEFORE
 * its cold /invoke spawn. Returns true when the wake was delivered WARM (the
 * caller must then SKIP the cold spawn); false = fall through to the cold spawn
 * (today's exact behavior). FAIL-SOFT by contract: any error → false.
 *
 * v1 scoping: queen role only; "same boot" proxied by session started AFTER
 * this process booted (adv_sessions carries no boot id — the reclaim sweep
 * kills cross-boot sessions anyway, EI-2186). Anomaly input = the queen's
 * autoloop consecutive_errors. Delivery rides wakeRecipients → the
 * wake-executor liveness ladder (inject if live, `claude --resume` if exited —
 * EI-908: the executor is the liveness authority, never the caller).
 */
export async function queenWarmWakeAttempt(args: {
  installSlug: string;
  workspaceId: string;
  role: string;
  kickoff?: string;
}): Promise<{ delivered: boolean; decision?: QueenWakeDecision }> {
  try {
    if (args.role !== 'queen' && args.role !== 'mug' && args.role !== 'brain')
      return { delivered: false };
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    if (!(await getFlag(FLAGS.QUEEN_WARM_SESSION, 'system'))) return { delivered: false };

    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{ coord_owner_id: string | null; started_at: string }>
    >`
      SELECT coord_owner_id, started_at::text
        FROM harness_shared.adv_sessions
       WHERE role = ${args.role} AND coord_owner_id IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 1`;
    const row = rows[0];
    const processBootMs = Date.now() - process.uptime() * 1000;
    const errRows = await sql<Array<{ consecutive_errors: number }>>`
      SELECT consecutive_errors FROM harness_shared.autoloop_state
       WHERE harness_slug = ${args.installSlug} AND role = ${args.role} LIMIT 1`;
    const decision = decideQueenWakeMode({
      sessionBootId: row ? 'this-boot-proxy' : null,
      currentBootId: 'this-boot-proxy',
      sessionStartedMs: row ? Date.parse(row.started_at) : null,
      nowMs: Date.now(),
      consecutiveErrors: errRows[0]?.consecutive_errors ?? 0,
    });
    // Boot proxy: a session started BEFORE this process booted is cross-boot → rebirth.
    const crossBoot = row && Date.parse(row.started_at) < processBootMs;
    if (decision.mode !== 'warm' || crossBoot || !row?.coord_owner_id) {
      return { delivered: false, decision: crossBoot ? { mode: 'rebirth', reason: 'session predates this process boot' } : decision };
    }
    const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
    const res = await wakeRecipients([row.coord_owner_id], {
      summary:
        `Queen wake (WARM resume — queen-memory-hybrid L2). ${args.kickoff ?? 'Survey the fleet and act.'} ` +
        'Your brief mechanisms (standing facts / carry-journal / background recall) still apply; ' +
        'durable state remains the source of truth.',
      payload: { kind: 'queen-warm-wake', installSlug: args.installSlug },
      source: 'queen-warm-session',
      workspaceId: args.workspaceId,
    });
    const woken = (res as { woken?: number } | undefined)?.woken ?? 0;
    // A wake that reached NO live/resumable session must fall through to the cold
    // spawn — never strand the queen on an undelivered warm wake.
    return woken > 0 ? { delivered: true, decision } : { delivered: false, decision: { mode: 'cold', reason: 'warm wake undeliverable (woken=0)' } };
  } catch {
    return { delivered: false };
  }
}

export function decideQueenWakeMode(inputs: QueenRebirthInputs): QueenWakeDecision {
  if (!inputs.sessionBootId || inputs.sessionStartedMs == null) {
    return { mode: 'cold', reason: 'no resumable session recorded' };
  }
  if (inputs.currentBootId && inputs.sessionBootId !== inputs.currentBootId) {
    return { mode: 'rebirth', reason: `boot-id changed (${inputs.sessionBootId} → ${inputs.currentBootId})` };
  }
  const age = inputs.nowMs - inputs.sessionStartedMs;
  if (age >= QUEEN_SESSION_MAX_AGE_MS) {
    return { mode: 'rebirth', reason: `session age ${Math.round(age / 3600_000)}h ≥ 24h scheduled rebirth` };
  }
  if ((inputs.consecutiveErrors ?? 0) > 0) {
    return { mode: 'rebirth', reason: `anomaly: consecutive_errors=${inputs.consecutiveErrors}` };
  }
  if (inputs.scorecardUnhealthy === true) {
    return { mode: 'rebirth', reason: 'anomaly: hive-coordination-health unhealthy' };
  }
  return { mode: 'warm', reason: 'resumable session healthy + fresh' };
}
