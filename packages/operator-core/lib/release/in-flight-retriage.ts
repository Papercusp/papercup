/**
 * in-flight-retriage.ts — a stale-candidate auto-refire IN PROGRESS, made visible (EI-18669342433807110).
 *
 * ## The gap this closes
 *
 * green-checkpoint.ts's stale-candidate re-triage (see green-checkpoint.ts's `classifyRedAgainstTip`)
 * can decide a red is stale and re-fire the WHOLE gate on a newer tip — but it does that by
 * RECURSING into itself synchronously (`return runGreenCheckpoint(cfg, deps, { candidate: tip, ... })`).
 * The recursion can run a full suite again (minutes), and nothing is written to `gate_health` for
 * that intermediate step — only the run's FINAL verdict (once every refire attempt bottoms out) gets
 * recorded (`recordCheckpointVerdict` / `trackGateStall`, a full-replace write of `gate_health`).
 *
 * So while a refire is in flight, any concurrent reader (`coord:orient.pipeline`, `dev:why`, the
 * /admin Git tab) sees whatever `gate_health` the PREVIOUS completed run left — typically a plain
 * red, with the "a red gate is YOURS to green" directive attached, and no hint that this exact red
 * is already being re-verified. Observed live 2026-07-26: a manual checkpoint run logged `red at
 * 30f88df7 ... re-triage: stale-candidate ... auto-refiring (attempt 1/2)` while every wake in the
 * fleet kept reading `gate: red, failingFiles: [...]` and dutifully going to "fix" tests that were
 * already proven to pass at the tip this same run was mid-way through confirming.
 *
 * ## The fix
 *
 * The refiring run merges (never replaces) a small `gate_health.inFlightRetriage` marker the
 * INSTANT it decides to auto-refire — before the (possibly long) recursive run starts — naming the
 * candidate this red pertains to, the tip being re-verified, and the attempt/cap. A reader
 * (`gate-verdict-freshness.ts`) treats a fresh marker whose `fromCandidate` matches the cached red's
 * candidate as proof the verdict is currently being re-earned, exactly like the other freshness
 * rules — reusing the SAME `verdictStale` plumbing every consumer (gateLabel, gateStage, the
 * `coord:orient` pipeline fold) already respects, so nothing downstream needs its own new branch.
 *
 * The marker self-clears the normal way: the run's eventual FINAL write (`recordCheckpointVerdict`)
 * replaces the whole `gate_health` object and simply does not include `inFlightRetriage`, so it
 * vanishes the moment a real verdict lands. `IN_FLIGHT_RETRIAGE_MAX_AGE_MS` bounds the one failure
 * mode that final write can't cover — a run that crashes mid-refire and never reaches it — so an
 * abandoned marker cannot wedge every future read into "still refiring" forever.
 */
import type { GateVerdictTarget } from './gate-verdict-target';

/** Bounded by green-checkpoint.ts's `SELF_WATCHDOG_MS` (3h): a run that hangs past that self-kills
 *  and writes a real red verdict, so any in-flight marker older than this is definitely abandoned
 *  (a crashed/orphaned run that never reached its final write), not a genuinely long refire. */
export const IN_FLIGHT_RETRIAGE_MAX_AGE_MS = 3 * 60 * 60_000;

/** What a currently-running stale-candidate auto-refire tells a concurrent reader about itself. */
export interface InFlightRetriageInfo {
  /** The candidate the CACHED red (`gate_health.lastFrom` / the verdict a reader has in hand) was
   *  recorded against — short sha. A reader only trusts this marker for a red pertaining to the
   *  SAME candidate; a marker for a different (already-superseded) red must not silence a genuinely
   *  new one. */
  fromCandidate: string;
  /** The newer tip this refire is re-verifying. */
  refiringCandidate: string;
  /** 1-based attempt number, so a reader can say "attempt N/maxRefires". */
  refireAttempt: number;
  maxRefires: number;
  /** The failing file(s) this refire is trying to disprove — echoed for a human-readable note. */
  failingFiles: string[];
}

/** The shape persisted to `gate_health.inFlightRetriage` — `InFlightRetriageInfo` plus the
 *  write-time stamp a reader needs to judge freshness. */
export interface StoredInFlightRetriage extends InFlightRetriageInfo {
  observedAtMs: number;
}

/**
 * Merge an in-flight-refire marker into the green-checkpoint routine's `gate_health` blob — a
 * shallow merge (`gate_health = gate_health || {inFlightRetriage: ...}`), never a replace, so it
 * cannot clobber the red streak / failing-tests / any other field a concurrent read depends on.
 *
 * Best-effort: swallows its own errors. This is a diagnostic aid riding alongside the real
 * checkpoint run — a write failure here must never break (or even slow) the run itself.
 */
export async function recordInFlightRetriage(target: GateVerdictTarget, info: InFlightRetriageInfo): Promise<void> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const stored: StoredInFlightRetriage = { ...info, observedAtMs: Date.now() };
    await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{gate_health}',
                COALESCE(metadata->'gate_health', '{}'::jsonb) || $2::jsonb,
                true
              ),
              updated_at = now()
        WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
      [target.installSlug, JSON.stringify({ inFlightRetriage: stored })],
    );
  } catch {
    /* best-effort diagnostic — never let this break the checkpoint run it rides alongside */
  }
}

/**
 * PURE: interpret the raw `gate_health.inFlightRetriage` value a snapshot read got back from PG.
 * Returns `null` for anything not trustworthy right now — missing, malformed (an old blob / a
 * shape this reader doesn't recognize), or older than {@link IN_FLIGHT_RETRIAGE_MAX_AGE_MS} (an
 * abandoned marker from a crashed run). Unit-testable without PG.
 */
export function parseInFlightRetriage(raw: unknown, nowMs: number = Date.now()): StoredInFlightRetriage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const fromCandidate = typeof r.fromCandidate === 'string' ? r.fromCandidate : null;
  const refiringCandidate = typeof r.refiringCandidate === 'string' ? r.refiringCandidate : null;
  const refireAttempt = typeof r.refireAttempt === 'number' ? r.refireAttempt : null;
  const maxRefires = typeof r.maxRefires === 'number' ? r.maxRefires : null;
  const observedAtMs = typeof r.observedAtMs === 'number' ? r.observedAtMs : null;
  if (!fromCandidate || !refiringCandidate || refireAttempt == null || maxRefires == null || observedAtMs == null) {
    return null;
  }
  if (nowMs - observedAtMs > IN_FLIGHT_RETRIAGE_MAX_AGE_MS) return null; // abandoned — see doc above.
  const failingFiles = Array.isArray(r.failingFiles) ? r.failingFiles.filter((f): f is string => typeof f === 'string') : [];
  return { fromCandidate, refiringCandidate, refireAttempt, maxRefires, failingFiles, observedAtMs };
}
