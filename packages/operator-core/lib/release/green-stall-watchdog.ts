/**
 * green-stall-watchdog — EI-455 bug #2: a "no green verdict in N hours" /
 * "green-checkpoint stopped firing" alarm that runs INDEPENDENTLY of the
 * green-checkpoint routine.
 *
 * THE GAP: the in-routine stall detector (`trackGateStall` in
 * harness/routines/release-actions.ts) fires only when green-checkpoint
 * produces a verdict. It already catches stuck-red, no-green-while-firing
 * (>6h), and a crashing/timing-out suite (counted as a red). But it is
 * structurally BLIND to the one failure that actually bit us on 2026-06-13/19:
 * the green-checkpoint routine NOT FIRING AT ALL (the dead-executor dedup
 * wedge). When the routine never runs, `trackGateStall` never runs either —
 * `gate_health` just freezes (`consecutiveReds:0, lastGreenAt:stale,
 * stallAlerted:false`) and NOTHING alarms. `main` froze for ~23h, silently.
 *
 * THE FIX: a process-level watcher — deliberately NOT a DBOS routine, for the
 * same reason the dead-executor reaper isn't one: a routine-based watchdog
 * would queue on the very engine that wedges, so it couldn't fire when most
 * needed. This runs in the operator process, independent of the routine
 * engine, and alarms on EITHER:
 *   1. fire-staleness  — an ACTIVE green-checkpoint routine whose `last_fired_at`
 *      is older than FIRE_STALE_MS (cron is hourly, so ~3 missed fires ⇒ the
 *      scheduler isn't running it). This is the novel signal the in-routine
 *      detector cannot see.
 *   2. verdict-staleness — no GREEN verdict (`lastGreenAt`) in NO_GREEN_MS
 *      (12h). A deep backstop, set well past the in-routine 6h alarm so the two
 *      don't double-ping in the overlap; this only trips if the in-routine path
 *      somehow failed to alarm too.
 *
 * It reuses the exact alarm surfaces of the in-routine detector — an urgent
 * `notifyAttention` + a durable `harness_escalations` row — under its OWN phase
 * (`green-checkpoint-watchdog`) and its OWN dedup flag (`watchdogAlerted`) so it
 * never clobbers the in-routine `green-checkpoint-stall` row/flag. Both can
 * coexist; in the wedge case only the watchdog can fire. Recovery (the routine
 * fires + greens again) clears the flag + escalation idempotently.
 *
 * Kill-switch: PAPERCUSP_GREEN_STALL_WATCHDOG='0'.
 */
import type { Sql } from 'postgres';
import { execFileSync } from 'node:child_process';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { broadcastSevereEvent, broadcastSevereEventResolved } from '../severe-event-broadcast';
import { readRoutineEngineLiveness } from './routine-engine-liveness';
import {
  isCheckpointRunLockHeldCheap,
  readCheckpointRunPhaseCheap,
} from '../release-checkpoint-launch';
import { integrationRoot } from '../release-deploy-launch';
import { resolveCheckpointRouting } from '../harness/routines/hive-release-env';
import { resolveWorkspaceForHarness } from '../harness/workspace-for-harness';

/** An ACTIVE green-checkpoint that hasn't FIRED in this long ⇒ the scheduler isn't
 *  running it (cron is hourly at :15, so this is ~3 missed fires). */
const DEFAULT_FIRE_STALE_MS = 3 * 60 * 60 * 1000; // 3h
/** No GREEN verdict in this long ⇒ alarm. A deep backstop past the in-routine 6h
 *  alarm (STALL_AGE_MS) so the two detectors don't double-ping. */
const DEFAULT_NO_GREEN_MS = 12 * 60 * 60 * 1000; // 12h
/** How often the watchdog sweeps. green-checkpoint is hourly, so 15m is ample. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 15 * 60 * 1000; // 15 min

/** EI-9762: `main` can fall behind `staging` for hours WITHOUT tripping either
 *  alarm above — the routine keeps firing (fireStale stays false) and each fire
 *  keeps producing a verdict, just a RED one (verdictStale's 12h backstop only
 *  fires on the ABSENCE of green, not on main failing to advance). A run can also
 *  be externally killed (SIGKILL) before it ever writes a verdict at all — same
 *  blind spot. Both leave `main` frozen with nothing watching it: the 2026-07-11
 *  incident sat ~4.8h/56 commits behind before the OWNER had to ask. This is a
 *  DIFFERENT, tighter, more direct signal than the 12h no-green backstop: it
 *  doesn't care why main isn't advancing (red suite, killed run, wedged engine),
 *  only that staging has pulled meaningfully ahead for meaningfully long. */
const DEFAULT_MAIN_BEHIND_COMMITS = 20;
const DEFAULT_MAIN_BEHIND_MS = 60 * 60 * 1000; // 1h — deliberately far tighter than the 12h verdict-stale backstop
/** EI-10202: even a deep+old backlog is NOT a stall if the green-checkpoint gate
 *  has ADVANCED main within this long — that is normal churn (dozens of agents'
 *  staging commits briefly outrunning the ~15-20-min full-suite cycle), not a
 *  wedge. green-checkpoint's cron is hourly, so ~2 cycles (2h) is the "advanced
 *  recently" window the bug asks for; only NO green advance in >2h alongside a
 *  deep old backlog is the genuinely-stuck signature (persistent red / killed
 *  runs) EI-9762 was built to catch. */
const DEFAULT_MAIN_BEHIND_RECENT_GREEN_MS = 2 * 60 * 60 * 1000; // 2h ≈ ~2 hourly green-checkpoint cycles
/** WI-38340: how far `behindMs` may exceed `lastGreenAgeMs` before a recent
 *  advance stops counting as evidence the backlog is being CONSUMED.
 *
 *  EI-10202's suppression asks "did the gate advance main recently?" and answers
 *  a DIFFERENT question — "is main catching up?" — by assuming the two are the
 *  same. WI-38218's partial-green salvage broke that equivalence: it advances
 *  `main` to the longest green PREFIX while the tip stays red, so the gate can
 *  emit advance after advance (each one resetting `lastGreenAt`) while the old
 *  end of the backlog never moves. Measured 2026-08-12: a 3-commit prefix
 *  advance against a 327-commit backlog reset the suppression and fired an
 *  all-clear. Worse, it RE-ARMS on every partial advance, so the alarm can
 *  never fire again while the tip stays red.
 *
 *  The fix is to stop inferring progress from motion and MEASURE it, using a
 *  signal we already compute. `behindMs` is the age of the OLDEST commit on
 *  staging but not main — the old END of the backlog, which only a genuine
 *  advance consumes. Right after a FULL advance `main` IS the candidate, so
 *  everything older than that candidate's cut is gone and `behindMs` collapses
 *  to roughly the candidate's own age; from there it grows one-for-one with
 *  elapsed time. So a real advance `t` ago leaves `behindMs ≲ t + (one suite
 *  cut)`. When `behindMs` runs FURTHER ahead than that, whatever the gate
 *  advanced was not the old backlog, and the advance proves nothing about
 *  catch-up — do not suppress.
 *
 *  Deliberately measured rather than keyed on the gate's `advanced-prefix`
 *  status: the same hole opens for any future mechanism that moves `main`
 *  without consuming the backlog (a pin moved outside the routine by a manual
 *  prefix promotion already does), and a depth/age measurement cannot fall
 *  behind a taxonomy it does not know about. 2h covers a full ~55-min
 *  green-checkpoint suite plus slack. */
const DEFAULT_MAIN_BEHIND_ADVANCE_HORIZON_MS = 2 * 60 * 60 * 1000; // 2h ≈ one full suite + slack
const MAIN_BEHIND_PHASE = 'main-behind-staging-watchdog';

/** Phase + kind for the durable escalation — distinct from the in-routine
 *  `green-checkpoint-stall` so the two never clobber each other. */
const WATCHDOG_PHASE = 'green-checkpoint-watchdog';
const WATCHDOG_KIND = 'green-checkpoint-watchdog';

export interface GreenStallThresholds {
  fireStaleMs?: number;
  noGreenMs?: number;
  /** How long a durable green-checkpoint-stall row may sit before recovery is retried. */
  greenCheckpointStallRecoveryStaleMs?: number;
  /** Maximum number of bounded recovery dispatch attempts for one stall episode. */
  greenCheckpointStallRecoveryMaxAttempts?: number;
}

/**
 * The in-routine green-checkpoint-stall row is written at the alert edge and then
 * deliberately stays quiet until a green tick clears it. Three hourly cycles is
 * long enough to avoid racing the normal fixer path while still bounding an
 * unowned red gate.
 */
const DEFAULT_GREEN_CHECKPOINT_STALL_RECOVERY_STALE_MS = 3 * 60 * 60 * 1000;
const DEFAULT_GREEN_CHECKPOINT_STALL_RECOVERY_MAX_ATTEMPTS = 3;

export interface GreenCheckpointStallRecoveryMarker {
  attempts: number;
  lastAttemptAt: number | null;
  outcome: 'claimed' | 'dispatched' | 'no-progress' | 'max-attempts' | null;
  notifiedAt: number | null;
}

export interface GreenCheckpointStallEscalation {
  /** The original JSON object, preserved so recovery markers never discard evidence. */
  raw: Record<string, unknown>;
  installSlug: string | null;
  candidate: string | null;
  failingTests: string[];
  ownershipCovered: boolean | null;
  recovery: GreenCheckpointStallRecoveryMarker;
}

export interface GreenCheckpointStallRecoveryDecision {
  action: 'none' | 'dispatch' | 'notify';
  reason: 'not-stale' | 'covered' | 'invalid' | 'retry' | 'max-attempts';
  nextAttempt: number;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const finiteNonNegativeInt = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
};

const finiteTimestamp = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Parse the existing TEXT escalation body without trusting malformed/legacy rows.
 * A candidate and at least one named failing test are required by the recovery
 * decision; the parser keeps those checks separate so callers can report why a
 * row was skipped rather than treating malformed JSON as a live red.
 */
export function parseGreenCheckpointStallEscalation(raw: unknown): GreenCheckpointStallEscalation | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const record = asRecord(value);
  if (!record || record.kind !== 'green-checkpoint-stall') return null;

  const candidateValue = typeof record.candidate === 'string' ? record.candidate.trim() : '';
  const candidate = candidateValue.length >= 4 && candidateValue.length <= 128 ? candidateValue : null;
  const failingTests = Array.isArray(record.failingTests)
    ? record.failingTests
        .filter((test): test is string => typeof test === 'string' && test.trim().length > 0)
        .map((test) => test.trim())
        .slice(0, 20)
    : [];
  const ownership = asRecord(record.ownership);
  const recoveryRecord = asRecord(record.recovery);

  return {
    raw: record,
    installSlug: typeof record.harness_slug === 'string' && record.harness_slug.trim() ? record.harness_slug.trim() : null,
    candidate,
    failingTests,
    ownershipCovered: typeof ownership?.covered === 'boolean' ? ownership.covered : null,
    recovery: {
      attempts: finiteNonNegativeInt(recoveryRecord?.attempts, 0),
      lastAttemptAt: finiteTimestamp(recoveryRecord?.lastAttemptAt),
      outcome:
        recoveryRecord?.outcome === 'claimed' ||
        recoveryRecord?.outcome === 'dispatched' ||
        recoveryRecord?.outcome === 'no-progress' ||
        recoveryRecord?.outcome === 'max-attempts'
          ? recoveryRecord.outcome
          : null,
      notifiedAt: finiteTimestamp(recoveryRecord?.notifiedAt),
    },
  };
}

/**
 * Pure recovery gate for one stale in-routine escalation. It is intentionally
 * stricter than the alarm itself: only a known uncovered owner, a usable candidate,
 * and named failing tests may cause an automated re-dispatch. Attempts are bounded
 * so a broken launch path becomes a loud owner/fleet signal instead of a spawn loop.
 */
export function decideGreenCheckpointStallRecovery(opts: {
  mtimeMs: number | null;
  nowMs: number;
  ownershipCovered: boolean | null;
  candidate: string | null;
  failingTests: readonly string[];
  recoveryAttempts?: number;
  recoveryNotifiedAt?: number | null;
  staleMs?: number;
  maxAttempts?: number;
}): GreenCheckpointStallRecoveryDecision {
  const attempts = finiteNonNegativeInt(opts.recoveryAttempts, 0);
  const staleMs = Math.max(0, opts.staleMs ?? DEFAULT_GREEN_CHECKPOINT_STALL_RECOVERY_STALE_MS);
  const maxAttempts = Math.max(
    1,
    finiteNonNegativeInt(opts.maxAttempts, DEFAULT_GREEN_CHECKPOINT_STALL_RECOVERY_MAX_ATTEMPTS),
  );
  if (opts.mtimeMs == null || !Number.isFinite(opts.mtimeMs) || opts.nowMs - opts.mtimeMs <= staleMs) {
    return { action: 'none', reason: 'not-stale', nextAttempt: attempts };
  }
  if (opts.ownershipCovered !== false) {
    return { action: 'none', reason: 'covered', nextAttempt: attempts };
  }
  if (!opts.candidate || opts.failingTests.length === 0) {
    return { action: 'none', reason: 'invalid', nextAttempt: attempts };
  }
  if (attempts >= maxAttempts) {
    return {
      action: opts.recoveryNotifiedAt == null ? 'notify' : 'none',
      reason: 'max-attempts',
      nextAttempt: attempts,
    };
  }
  return { action: 'dispatch', reason: 'retry', nextAttempt: attempts + 1 };
}

/** The bits of one green-checkpoint routine row the verdict is computed from. */
export interface GreenStallSnapshot {
  /** epoch ms of the routine's last fire (`last_fired_at`), or null if never fired. */
  lastFiredMs: number | null;
  /** epoch ms of the last green verdict (`gate_health.lastGreenAt`), or null. */
  lastGreenAt: number | null;
  /** the watchdog's own dedup flag (`gate_health.watchdogAlerted`). */
  watchdogAlerted: boolean;
  /** The root routine engine is stale; infra-liveness owns this root-cause alarm. */
  routineEngineStale?: boolean;
  /** EI-7505: the failing verdict test(s) from the last red green-checkpoint tick
   *  (`gate_health.failingTests`, threaded through by `trackGateStall` in
   *  release-actions.ts), when the stall is verdict-staleness (a failing suite)
   *  rather than fire-staleness (the routine engine not running). Absent/empty
   *  when the stall is fire-stale or the field predates this fix. */
  failingTests?: string[];
  /** EI-20378004056924553: the per-root checkpoint run-lock was held by a live process when
   *  the phase marker was read. A missing value is UNKNOWN and must not suppress an alarm. */
  checkpointRunActive?: boolean;
  /** EI-20378004056924553: the run's published phase, when its marker was readable. Only an
   *  active `delivering` phase is a suppression; missing/unreadable phase fails open. */
  checkpointRunPhase?: string | null;
}

export interface GreenStallVerdict {
  stalled: boolean;
  /** the routine is active but hasn't fired in fireStaleMs (the scheduler is wedged). */
  fireStale: boolean;
  /** no green verdict in noGreenMs (the deep backstop). */
  verdictStale: boolean;
  /**
   * P-016: this pass DECLINED TO JUDGE — the root routine engine is stale, so
   * infra-liveness owns the root-cause alarm and this symptom-level one is
   * deliberately muted (EI-2994).
   *
   * ⚠ `suppressed` is NOT `!stalled`, and collapsing the two is the defect this
   * field exists to end. Both render `stalled: false`, but they mean opposite
   * things: healthy means "I looked and the gate is fine", suppressed means "I
   * did not look". Treating suppressed as healthy makes the watchdog broadcast
   * `green-checkpoint RECOVERED — the gate is producing verdicts again` off a
   * code path that explicitly refused to evaluate whether the gate is producing
   * verdicts. It is a false all-clear, and because engine staleness flickers
   * around its own threshold on a loaded box it emits one on every flicker —
   * which is how STALLED/RECOVERED alternated several times inside one window
   * on oddsmith. Read this field before taking the recovery branch.
   */
  suppressed: boolean;
  /** human reason for the alarm body, or null when not stalled. */
  reason: string | null;
}

const hrs = (ms: number): number => Math.round(ms / 3_600_000);

/**
 * Pure: decide whether one ACTIVE green-checkpoint routine is in a silent stall
 * the in-routine detector cannot see. Exported for unit testing (the DB wiring
 * around it is integration-covered, like the reaper's live self-test).
 *
 * A never-fired routine (`lastFiredMs === null` with no `lastGreenAt`) is a fresh
 * install — no evidence it SHOULD have greened — and never alarms.
 */
export function evaluateGreenStall(
  s: GreenStallSnapshot,
  now: number,
  opts: GreenStallThresholds = {},
): GreenStallVerdict {
  const fireStaleMs = opts.fireStaleMs ?? DEFAULT_FIRE_STALE_MS;
  const noGreenMs = opts.noGreenMs ?? DEFAULT_NO_GREEN_MS;

  // EI-2994: when the root DBOS routinesTick is stale, green-checkpoint not
  // firing is a downstream symptom. The request-path infra-liveness alarm owns
  // the single "background routine engine frozen" escalation and auto-resolves
  // it; suppress this symptom-level alarm to avoid a restart cascade being
  // triaged as independent release failures. Unknown liveness is fail-open.
  const rootEngineStale = s.routineEngineStale === true;
  // EI-20378004056924553: partial-green salvage publishes `delivering` only after
  // the suite has completed and while the run is still actively publishing its
  // bounded result. That phase is a real in-flight run, not evidence of a silent
  // gate. Suppress only on the exact pair; a stale marker, missing lock, unknown
  // route, or any other phase must fail open to the ordinary stall verdict.
  const checkpointRunDelivering =
    s.checkpointRunActive === true && s.checkpointRunPhase === 'delivering';
  const suppressed = rootEngineStale || checkpointRunDelivering;
  const fireStale = !suppressed && s.lastFiredMs != null && now - s.lastFiredMs > fireStaleMs;
  const verdictStale = !suppressed && s.lastGreenAt != null && now - s.lastGreenAt > noGreenMs;
  const stalled = fireStale || verdictStale;

  let reason: string | null = null;
  if (stalled) {
    const parts: string[] = [];
    if (fireStale && s.lastFiredMs != null) {
      parts.push(
        `the routine has not FIRED in ~${hrs(now - s.lastFiredMs)}h (active, cron hourly) — the routine scheduler/engine is not running it`,
      );
    }
    if (verdictStale && s.lastGreenAt != null) {
      parts.push(`no GREEN verdict in ~${hrs(now - s.lastGreenAt)}h`);
    }
    reason = parts.join('; ');
    // EI-7505: name the failing test(s) directly in the alarm reason so a
    // responder doesn't have to hand-spelunk harness_shared.test_runs (which
    // mixes every agent's local dev-test runs with the verdict run and is
    // inconclusive) just to start diagnosing a verdict-staleness stall.
    const tests = (s.failingTests ?? []).slice(0, 20);
    if (tests.length) {
      reason += `. Failing verdict test(s): ${tests.slice(0, 5).join(', ')}${tests.length > 5 ? ` (+${tests.length - 5} more)` : ''}`;
    }
  }
  return { stalled, fireStale, verdictStale, suppressed, reason };
}

/** Pure: the `harness_escalations` body for a watchdog-detected stall (testable). */
export function greenStallEscalationBody(opts: {
  installSlug: string;
  verdict: GreenStallVerdict;
  lastFiredMs: number | null;
  lastGreenAt: number | null;
  nowMs: number;
  /** EI-7505: gate_health.failingTests, when available (verdict-staleness only). */
  failingTests?: string[];
}): string {
  return JSON.stringify({
    kind: WATCHDOG_KIND,
    harness_slug: opts.installSlug,
    fireStale: opts.verdict.fireStale,
    verdictStale: opts.verdict.verdictStale,
    lastFiredAt: opts.lastFiredMs != null ? new Date(opts.lastFiredMs).toISOString() : null,
    lastGreenAt: opts.lastGreenAt != null ? new Date(opts.lastGreenAt).toISOString() : null,
    failingTests: (opts.failingTests ?? []).slice(0, 20),
    emitted_at: opts.nowMs,
    // `verdict.reason` already carries the failing-test suffix (EI-7505) when present.
    detail: `green-checkpoint silent stall (watchdog): ${opts.verdict.reason}. ` +
      `\`main\` is frozen and the in-routine stall detector cannot see this (it runs only when the routine fires). ` +
      `The dead-executor reaper should auto-recover a wedge; if this persists the bg-host / DBOS engine needs a look.`,
  });
}

// ── verdict-stale ATTRIBUTION (WI-39704) ──────────────────────────────────────

/**
 * WI-39704: what this alarm said about a verdict-staleness stall used to be a GUESS
 * dressed as a finding. `verdictStale` measures exactly ONE thing — no green verdict in
 * 12h — and the broadcast then asserted the cause: "verdict-staleness ⇒ a failing suite.
 * release:checkpoint-run forces a fresh gate run." That inference is wrong for every
 * stall whose gate never reached the tests, and wrong in the most expensive direction:
 * it sends each reader hunting failing tests that do not exist, and its remedy costs a
 * full ~55min suite that then dies exactly where the last one did.
 *
 * Measured on oddsmith 2026-08-17: the gate fired hourly on schedule, the suite PASSED,
 * and every run died in the publish step — `git push origin <sha>:refs/heads/main exited
 * 128: fatal: could not read Username for 'https://github.com'` (a missing push
 * credential, WI-39549). gate_health recorded 359 consecutive "reds" with
 * `failingTests: []`; the alarm said "no green verdicts … a failing suite"; WI-39671
 * spent an entire investigation establishing that the tests were fine — and then the
 * condition singleton re-minted the identical alarm (WI-39704) 34 seconds after that
 * item closed, primed to cost the next reader the same investigation.
 *
 * The datum was never missing. The run's own pipeline_event already records
 * `crashed: true` and the thrown error's text; it simply never reached the alarm. That
 * is the same defect WI-38340 fixed two functions down in this very file — an alarm
 * that misstates its own trigger sends the reader after a wedged gate that is running
 * fine — so this extends that convention rather than inventing one.
 *
 * ⚠ This deliberately does NOT suppress the alarm. Deploys really are frozen; that half
 * was always true. It changes only WHICH of the alarm's several possible causes it
 * claims, and makes it QUOTE the evidence instead of inferring from it.
 */
export interface LastGateRunEvidence {
  /** the run crashed before rendering a verdict (`CheckpointResult.crashed`). */
  crashed: boolean;
  /** the suite verdict the run rendered — or null when it never rendered one, which is
   *  what `buildCrashCheckpointResult` writes (EI-20702428259478130: `null`, not `false`,
   *  precisely so "no verdict exists" cannot be read as "the code is RED"). */
  green: boolean | null;
  /** FIRST line of the crash summary — the fault itself, QUOTED, never pattern-matched.
   *  The later stack frames are noise to a responder; the first line is the blocker. */
  firstLine: string | null;
  candidate: string | null;
  observedAt: string | null;
}

/**
 * Read the newest green_checkpoint verdict this install recorded. Fail-soft by design
 * (any error ⇒ null): this only ENRICHES an alarm that is already firing, so a read
 * problem must degrade the alarm's wording, never suppress or break the alarm itself.
 */
export async function readLastGateRunEvidence(
  sql: Sql,
  installSlug: string,
): Promise<LastGateRunEvidence | null> {
  try {
    const rows = await sql<
      {
        detail: {
          crashed?: unknown;
          green?: unknown;
          summary?: unknown;
          candidate?: unknown;
        } | null;
        created_at: Date | string | null;
      }[]
    >`
      SELECT detail, created_at
        FROM harness_shared.pipeline_events
       WHERE install_slug = ${installSlug}
         AND kind = 'green_checkpoint'
       ORDER BY created_at DESC
       LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    const d = row.detail ?? {};
    const summary = typeof d.summary === 'string' ? d.summary : null;
    const firstLine = summary ? (summary.split('\n')[0] ?? '').trim().slice(0, 400) : null;
    let observedAt: string | null = null;
    if (row.created_at != null) {
      const t = new Date(row.created_at as string | Date);
      observedAt = Number.isNaN(t.getTime()) ? null : t.toISOString();
    }
    return {
      crashed: d.crashed === true,
      green: typeof d.green === 'boolean' ? d.green : null,
      firstLine: firstLine || null,
      candidate: typeof d.candidate === 'string' ? d.candidate.slice(0, 12) : null,
      observedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Pure: given what the ledger actually recorded, say which cause of "no green verdict"
 * was OBSERVED — and give the remedy that matches THAT cause. Exported for unit testing,
 * matching the `evaluateGreenStall` / `mainBehindRecoverySummary` convention in this file.
 *
 * The ordering is by strength of evidence, not by likelihood:
 *   1. named failing tests  — the only branch entitled to say "a failing suite".
 *   2. a crash              — the gate never reached a verdict; zero tests are implicated.
 *   3. a red with no test   — a real red the gate could not attribute; say so rather than
 *                             implying a test list exists to go fix.
 *   4. anything else / no run on record — state the gap instead of filling it with a guess.
 */
export function attributeVerdictStale(opts: {
  failingTests: string[];
  last: LastGateRunEvidence | null;
}): { summary: string; cause: string; remedy: string } {
  const { failingTests, last } = opts;
  const when = last?.observedAt ? ` at ${last.observedAt}` : '';
  const cand = last?.candidate ? ` (candidate ${last.candidate})` : '';

  if (failingTests.length > 0) {
    return {
      summary: 'no green verdicts; deploys frozen (a failing suite).',
      cause: `The last verdict named ${failingTests.length} failing test(s), so this IS a failing suite.`,
      remedy: 'Fix the named test(s), then release:checkpoint-run for a fresh verdict.',
    };
  }

  if (last?.crashed) {
    return {
      summary:
        'deploys frozen — the gate\'s last run CRASHED before rendering a verdict, naming NO failing test. This is NOT a failing suite.',
      cause:
        `⚠ NOT a failing suite — the gate's last run${cand}${when} CRASHED before rendering a verdict and named ZERO failing tests. ` +
        `The crash: ${last.firstLine ?? '(no summary was recorded)'}`,
      remedy:
        'Fix THAT, not the tests. Do NOT reflexively fire release:checkpoint-run — a fresh run costs a full suite (~55min) and then dies at the same step. ' +
        'A crash inside a `git push` to origin means the CODE IS FINE and the PUBLISH step is blocked (credential / remote), which no amount of test-fixing reaches. ' +
        "Confirm from the run's own trailer: `grep -o 'GATE_PROMOTION candidate=.*' <run log> | tail -1` — `green=true promoted=false` names the step that blocked it.",
    };
  }

  if (last && last.green === false) {
    return {
      summary: 'no green verdicts; deploys frozen (last verdict RED, but it named no failing test).',
      cause: `The last run${cand}${when} rendered a RED verdict but named no failing test — an unattributable red.`,
      remedy:
        "Read that run's own record before re-firing: its AFFECTED_TESTS_FAILING_FILES line names the failing files (read `coverage` first — `files=[]` means \"not attributable\", NOT \"nothing failed\").",
    };
  }

  if (last) {
    return {
      summary: 'no green verdicts; deploys frozen (the last run recorded no green, and named no failing test).',
      cause:
        `The last run${cand}${when} recorded green=${String(last.green)} and named no failing test, yet no green verdict has landed in the window.`,
      remedy:
        "Read that run's own record before re-firing — a verdict that did not COUNT (held, superseded, or green-but-not-promoted) reads here as \"no green\" while the tests are fine.",
    };
  }

  return {
    summary: 'no green verdicts; deploys frozen (no run on record to attribute it to).',
    cause:
      'No green-checkpoint run is on record for this install, so the cause of the missing green cannot be attributed from the ledger.',
    remedy:
      'Check whether the routine is firing at all (fire-staleness is reported separately above), then release:checkpoint-run for a fresh verdict.',
  };
}

export interface GreenStallWatchdogResult {
  /** install slugs that crossed into a stall this pass (one-shot, deduped). */
  alarmed: string[];
  /** install slugs whose prior stall recovered this pass. */
  recovered: string[];
  /**
   * P-016: install slugs this pass DECLINED TO JUDGE because the root routine
   * engine is stale — muted, not healthy, and deliberately absent from both
   * `alarmed` and `recovered`. Reported so a mute is OBSERVABLE: previously a
   * suppressed pass was indistinguishable from a recovery in this result, which
   * is the same conflation the `suppressed` verdict field exists to end.
   */
  suppressed: string[];
}

/**
 * Resolve and read the checkpoint run state for one routine row.
 *
 * The watchdog runs in the operator process, while a subject hive's run-lock
 * lives under that hive's routed integration root and log directory. Keep the
 * routing and both cheap reads together so this path cannot accidentally inspect
 * the operator-home lock for every hive. Any routing/read uncertainty is UNKNOWN
 * and returns an empty partial snapshot: evaluateGreenStall deliberately fails
 * open unless it can prove both a live lock and the exact `delivering` phase.
 */
async function readCheckpointRunState(
  installSlug: string,
  workspaceId: string,
): Promise<Pick<GreenStallSnapshot, 'checkpointRunActive' | 'checkpointRunPhase'>> {
  try {
    const routing = await resolveCheckpointRouting({ installSlug, workspaceId }, integrationRoot());
    if (routing.skip) return {};

    const root = routing.extraEnv.PAPERCUSP_INTEGRATION_ROOT ?? routing.root;
    const checkpointLogDir = routing.extraEnv.PAPERCUSP_CHECKPOINT_LOG_DIR;
    const lock = isCheckpointRunLockHeldCheap(root, undefined, undefined, undefined, checkpointLogDir);
    const phase = readCheckpointRunPhaseCheap(root, checkpointLogDir)?.phase ?? null;
    return { checkpointRunActive: lock.held, checkpointRunPhase: phase };
  } catch (error) {
    // The alert must remain useful when registry/routing state is temporarily
    // unreadable. Unknown is not "no run": it simply cannot suppress a stall.
    console.warn(
      `[green-stall-watchdog] checkpoint run state unavailable for '${installSlug}'; fail-open: ${error instanceof Error ? error.message : error}`,
    );
    return {};
  }
}

type GreenCheckpointStallEscalationRow = {
  harness_slug: string;
  workspace_id: string;
  escalation: unknown;
  mtime_ms: string | number | null;
};

const GREEN_CHECKPOINT_STALL_PHASE = 'green-checkpoint-stall';

const recoveryBody = (
  parsed: GreenCheckpointStallEscalation,
  recovery: GreenCheckpointStallRecoveryMarker,
): string => JSON.stringify({ ...parsed.raw, recovery });

/**
 * Deliver the owner/fleet signal for a recovery that could not make progress.
 * The escalation row is already the durable evidence; these two rails are best-effort
 * and deliberately one-shot via the recovery marker in that row.
 */
async function notifyGreenCheckpointStallRecovery(opts: {
  installSlug: string;
  workspaceId: string;
  candidate: string;
  failingTests: readonly string[];
  attempts: number;
  reason: 'no-progress' | 'max-attempts';
}): Promise<void> {
  const title = `green-checkpoint-stall recovery blocked on ${opts.installSlug}`;
  const body =
    `The green-checkpoint-stall escalation for ${opts.installSlug} remains stale and uncovered ` +
    `(candidate ${opts.candidate.slice(0, 12)}; recovery attempts: ${opts.attempts}). ` +
    `${opts.reason === 'max-attempts' ? 'The bounded release-fixer retry budget is exhausted.' : 'A release-fixer dispatch made no progress.'} ` +
    `Named failing test(s): ${opts.failingTests.slice(0, 5).join(', ')}. ` +
    `Inspect the gate row and release-fixer liveness before taking further action.`;
  const fleetSlug = (process.env.PAPERCUSP_FLEET_SLUG ?? '').trim();
  const route = fleetSlug
    ? {
        ownerSelector: `@fleet-leader:${fleetSlug}`,
        reason: `green-checkpoint-stall recovery for ${opts.installSlug} needs fleet-leader attention`,
      }
    : undefined;

  try {
    const { notifyAttention } = await import('../attention-notify');
    await notifyAttention({
      kind: 'intervention',
      title,
      body,
      importance: 'urgent',
      workspaceId: opts.workspaceId,
      data: {
        installSlug: opts.installSlug,
        candidate: opts.candidate.slice(0, 12),
        failingTests: opts.failingTests.slice(0, 20),
        attempts: opts.attempts,
        reason: opts.reason,
      },
    });
  } catch (e) {
    console.warn(`[green-stall-watchdog] recovery notify failed: ${e instanceof Error ? e.message : e}`);
  }

  try {
    await broadcastSevereEvent({
      summary: title,
      body,
      category: 'severe-event',
      conditionKey: `green-checkpoint-stall-recovery:${opts.installSlug}`,
      oneShot: true,
      ...(route ? { route } : {}),
    });
  } catch (e) {
    console.warn(`[green-stall-watchdog] recovery broadcast failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Revisit old in-routine stall rows independently of a fresh checkpoint verdict.
 * `trackGateStall` records the exact red signature, but its normal dispatcher only
 * runs while a verdict is being produced; this sweep closes that silent gap.
 */
async function recoverStaleGreenCheckpointStalls(
  sql: Sql,
  nowMs: number,
  opts: GreenStallThresholds,
): Promise<void> {
  let rows: GreenCheckpointStallEscalationRow[];
  try {
    rows = await sql<GreenCheckpointStallEscalationRow[]>`
      SELECT harness_slug, workspace_id, escalation, mtime_ms
        FROM harness_shared.harness_escalations
       WHERE phase = ${GREEN_CHECKPOINT_STALL_PHASE}
         AND escalation IS NOT NULL`;
  } catch (e) {
    console.warn(`[green-stall-watchdog] green-checkpoint-stall recovery scan failed: ${e instanceof Error ? e.message : e}`);
    return;
  }

  const staleMs = opts.greenCheckpointStallRecoveryStaleMs ?? DEFAULT_GREEN_CHECKPOINT_STALL_RECOVERY_STALE_MS;
  const maxAttempts = opts.greenCheckpointStallRecoveryMaxAttempts ?? DEFAULT_GREEN_CHECKPOINT_STALL_RECOVERY_MAX_ATTEMPTS;

  for (const row of rows) {
    const parsed = parseGreenCheckpointStallEscalation(row.escalation);
    if (!parsed || parsed.installSlug !== row.harness_slug) continue;
    const mtimeMs = finiteTimestamp(row.mtime_ms);
    const decision = decideGreenCheckpointStallRecovery({
      mtimeMs,
      nowMs,
      ownershipCovered: parsed.ownershipCovered,
      candidate: parsed.candidate,
      failingTests: parsed.failingTests,
      recoveryAttempts: parsed.recovery.attempts,
      recoveryNotifiedAt: parsed.recovery.notifiedAt,
      staleMs,
      maxAttempts,
    });
    if (decision.action === 'none') continue;

    const originalBody = typeof row.escalation === 'string' ? row.escalation : JSON.stringify(row.escalation);
    if (!originalBody) continue;

    const claimedRecovery: GreenCheckpointStallRecoveryMarker =
      decision.action === 'notify'
        ? {
            attempts: parsed.recovery.attempts,
            lastAttemptAt: parsed.recovery.lastAttemptAt,
            outcome: 'max-attempts',
            notifiedAt: nowMs,
          }
        : {
            attempts: decision.nextAttempt,
            lastAttemptAt: nowMs,
            outcome: 'claimed',
            notifiedAt: parsed.recovery.notifiedAt,
          };
    const claimedBody = recoveryBody(parsed, claimedRecovery);
    let claimed: { count?: number };
    try {
      claimed = await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = ${claimedBody}
         WHERE harness_slug = ${row.harness_slug}
           AND phase = ${GREEN_CHECKPOINT_STALL_PHASE}
           AND escalation IS NOT DISTINCT FROM ${originalBody}`;
    } catch (e) {
      console.warn(`[green-stall-watchdog] recovery claim failed for ${row.harness_slug}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (claimed.count !== 1) continue; // another watchdog process owns this row

    if (decision.action === 'notify') {
      if (parsed.candidate && parsed.failingTests.length > 0) {
        await notifyGreenCheckpointStallRecovery({
          installSlug: row.harness_slug,
          workspaceId: row.workspace_id,
          candidate: parsed.candidate,
          failingTests: parsed.failingTests,
          attempts: parsed.recovery.attempts,
          reason: 'max-attempts',
        });
      }
      continue;
    }

    let dispatched = false;
    try {
      const { dispatchReleaseFixer } = await import('../harness/routines/release-actions');
      dispatched =
        (await dispatchReleaseFixer(
          { installSlug: row.harness_slug, workspaceId: row.workspace_id },
          parsed.candidate!,
          parsed.failingTests,
        )) != null;
    } catch (e) {
      console.warn(`[green-stall-watchdog] recovery dispatch failed for ${row.harness_slug}: ${e instanceof Error ? e.message : e}`);
    }

    const outcome: GreenCheckpointStallRecoveryMarker['outcome'] = dispatched ? 'dispatched' : 'no-progress';
    const finalRecovery: GreenCheckpointStallRecoveryMarker = { ...claimedRecovery, outcome };
    try {
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = ${recoveryBody(parsed, finalRecovery)}
         WHERE harness_slug = ${row.harness_slug}
           AND phase = ${GREEN_CHECKPOINT_STALL_PHASE}
           AND escalation IS NOT DISTINCT FROM ${claimedBody}`;
    } catch (e) {
      console.warn(`[green-stall-watchdog] recovery result write failed for ${row.harness_slug}: ${e instanceof Error ? e.message : e}`);
    }

    if (!dispatched && parsed.candidate && parsed.failingTests.length > 0 && parsed.recovery.notifiedAt == null) {
      await notifyGreenCheckpointStallRecovery({
        installSlug: row.harness_slug,
        workspaceId: row.workspace_id,
        candidate: parsed.candidate,
        failingTests: parsed.failingTests,
        attempts: decision.nextAttempt,
        reason: 'no-progress',
      });
      // Best-effort one-shot latch. The marker is deliberately written without touching mtime_ms.
      try {
        await sql`
          UPDATE harness_shared.harness_escalations
             SET escalation = ${recoveryBody(parsed, { ...finalRecovery, notifiedAt: nowMs })}
           WHERE harness_slug = ${row.harness_slug}
             AND phase = ${GREEN_CHECKPOINT_STALL_PHASE}
             AND escalation IS NOT DISTINCT FROM ${recoveryBody(parsed, finalRecovery)}`;
      } catch (e) {
        console.warn(`[green-stall-watchdog] recovery notify marker failed for ${row.harness_slug}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

/**
 * One watchdog pass: scan every ACTIVE green-checkpoint routine, alarm once per
 * stall transition (cross-process exactly-once via a conditional flag flip), and
 * clear the flag + escalation on recovery. Never throws — it rides boot + an
 * interval and must not break either.
 */
export async function checkGreenStall(
  sql: Sql,
  opts: GreenStallThresholds = {},
): Promise<GreenStallWatchdogResult> {
  const out: GreenStallWatchdogResult = { alarmed: [], recovered: [], suppressed: [] };
  try {
    const rows = await sql<
      {
        install_slug: string;
        workspace_id: string;
        last_fired_ms: string | number | null;
        gh: { lastGreenAt?: number; watchdogAlerted?: boolean; failingTests?: string[] } | null;
      }[]
    >`
      SELECT install_slug,
             workspace_id,
             extract(epoch from last_fired_at) * 1000 AS last_fired_ms,
             metadata->'gate_health' AS gh
        FROM harness_shared.routines
       WHERE target_role = 'system:green-checkpoint'
         AND active = true`;

    const now = Date.now();
    await recoverStaleGreenCheckpointStalls(sql, now, opts);
    const routineEngine = await readRoutineEngineLiveness(sql, { nowMs: now });
    for (const row of rows) {
      const lastFiredMs = row.last_fired_ms != null ? Number(row.last_fired_ms) : null;
      const lastGreenAt = row.gh?.lastGreenAt ?? null;
      const watchdogAlerted = row.gh?.watchdogAlerted ?? false;
      // EI-7505: gate_health.failingTests, threaded through by trackGateStall
      // (release-actions.ts) on the last red green-checkpoint tick.
      const failingTests = row.gh?.failingTests ?? [];
      const checkpointRun = await readCheckpointRunState(row.install_slug, row.workspace_id);
      const verdict = evaluateGreenStall(
        {
          lastFiredMs,
          lastGreenAt,
          watchdogAlerted,
          routineEngineStale: routineEngine.stale,
          failingTests,
          ...checkpointRun,
        },
        now,
        opts,
      );

      if (verdict.stalled) {
        if (watchdogAlerted) continue; // already alarmed; one-shot until recovery
        // Cross-process exactly-once: only the writer that flips watchdogAlerted
        // false→true gets to alarm. jsonb_set merges into the existing gate_health
        // so we never drop consecutiveReds/lastGreenAt/etc.
        const flip = await sql`
          UPDATE harness_shared.routines
             SET metadata = jsonb_set(
                   COALESCE(metadata, '{}'::jsonb),
                   '{gate_health}',
                   COALESCE(metadata->'gate_health', '{}'::jsonb) || '{"watchdogAlerted":true}'::jsonb
                 ),
                 updated_at = now()
           WHERE install_slug = ${row.install_slug}
             AND target_role = 'system:green-checkpoint'
             AND COALESCE((metadata->'gate_health'->>'watchdogAlerted')::boolean, false) = false`;
        if (flip.count !== 1) continue; // another process won the flip

        // WI-39704: attribute a verdict-staleness stall from the LEDGER before saying
        // anything about its cause. One query, only on the transition that actually
        // alarms (we have already won the one-shot flip), so a healthy sweep pays
        // nothing. Fail-soft: no evidence ⇒ `attributeVerdictStale` says so plainly
        // rather than falling back to the old "⇒ a failing suite" guess.
        const lastRun = verdict.verdictStale
          ? await readLastGateRunEvidence(sql, row.install_slug)
          : null;
        const attribution = verdict.verdictStale
          ? attributeVerdictStale({ failingTests, last: lastRun })
          : null;
        const reasonText = attribution
          ? `${verdict.reason} — ${attribution.cause}`
          : (verdict.reason ?? '');

        try {
          const { notifyAttention } = await import('../attention-notify');
          await notifyAttention({
            kind: 'intervention',
            title: 'Release pipeline STALLED — green-checkpoint not producing greens',
            body: `green-checkpoint (${row.install_slug}) silent stall: ${reasonText}. \`main\` is frozen and the per-verdict detector can't see this. ${attribution?.remedy ?? 'The dead-executor reaper should auto-recover a wedge; manual help may be needed if it persists.'}`,
            importance: 'urgent',
            workspaceId: row.workspace_id,
            data: {
              fireStale: verdict.fireStale,
              verdictStale: verdict.verdictStale,
              lastRunCrashed: lastRun?.crashed ?? null,
            },
          });
        } catch (e) {
          console.warn(`[green-stall-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
        }
        // Fleet broadcast (owner-requested): inject-only (wake=false) so every running agent
        // sees it next turn and someone can claim greening the gate, without a wake storm.
        await broadcastSevereEvent({
          // WI-39704: the summary is the highest-leverage string in this whole path — it is
          // what every agent sees in its inbox AND what the condition bridge titles the
          // owning work-item. "no green verdicts" unqualified reads as "the suite is red",
          // which is the misattribution itself, so it is now stated by the evidence.
          summary: `green-checkpoint STALLED on ${row.install_slug} — ${attribution?.summary ?? 'no green verdicts; deploys frozen.'}`,
          body:
            `${reasonText}\n\nThe release gate isn't producing greens, so nothing new can deploy. ` +
            (verdict.fireStale
              ? `fire-staleness ⇒ the routine engine/DBOS is wedged (a reaper should recover; manual help if it persists). `
              : '') +
            (attribution?.remedy ?? `release:checkpoint-run forces a fresh gate run.`),
          category: 'severe-event',
          // WI-1444 condition lifecycle: recovery below broadcasts the matching
          // resolution, so late inbox readers see this alarm annotated resolved.
          conditionKey: `green-stall:${row.install_slug}`,
          // WI-6228: one-shot until recovery (see `watchdogAlerted` above) — our
          // silence is deliberate, never evidence the gate recovered.
          oneShot: true,
        });
        try {
          await sql`
            INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
            VALUES (${row.install_slug}, ${WATCHDOG_PHASE}, ${greenStallEscalationBody({
              installSlug: row.install_slug,
              // WI-39704: the DURABLE record carries the attributed reason too. An
              // escalation row outlives the broadcast, so leaving the un-attributed text
              // here would just relocate the misattribution to the surface a responder
              // reaches for last (and trusts most).
              verdict: { ...verdict, reason: reasonText },
              lastFiredMs,
              lastGreenAt,
              nowMs: now,
              failingTests,
            })}, ${now}, ${row.workspace_id})
            ON CONFLICT (harness_slug, phase)
            DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
        } catch (e) {
          console.warn(`[green-stall-watchdog] escalation write failed: ${e instanceof Error ? e.message : e}`);
        }
        out.alarmed.push(row.install_slug);
        console.warn(`[green-stall-watchdog] ALARM ${row.install_slug}: ${reasonText}`);
      } else if (verdict.suppressed) {
        // P-016: DECLINED TO JUDGE — not healthy. The root routine engine is stale,
        // so infra-liveness owns the root-cause alarm and this symptom-level one is
        // muted (EI-2994). Muting must be SILENT: falling through to the recovery
        // branch would clear `watchdogAlerted`, wipe a still-valid escalation row,
        // and broadcast "the gate is producing verdicts again" — an all-clear issued
        // by the one code path that deliberately did not look at whether the gate is
        // producing verdicts. Engine staleness flickers around its own threshold on a
        // loaded box, so that false all-clear fired on every flicker and produced the
        // observed STALLED/RECOVERED alternation within a single window on oddsmith.
        // Leaving the alarm state UNTOUCHED is what makes the mute a pause rather
        // than a retraction: if the gate really was stalled, the alarm is still up
        // when the engine steadies and we re-evaluate.
        out.suppressed.push(row.install_slug);
        continue;
      } else {
        // Healthy — and we actually looked. Clear the watchdog flag (a green verdict
        // already wipes gate_health, so this is belt-and-suspenders) and the
        // escalation row, both idempotently.
        if (watchdogAlerted) {
          await sql`
            UPDATE harness_shared.routines
               SET metadata = jsonb_set(
                     COALESCE(metadata, '{}'::jsonb),
                     '{gate_health}',
                     COALESCE(metadata->'gate_health', '{}'::jsonb) || '{"watchdogAlerted":false}'::jsonb
                   ),
                   updated_at = now()
             WHERE install_slug = ${row.install_slug}
               AND target_role = 'system:green-checkpoint'`;
        }
        // Independent of the flag: a green-verdict wipe can clear watchdogAlerted while
        // leaving our escalation row, so always run the idempotent clear (no-op when null).
        const cleared = await sql`
          UPDATE harness_shared.harness_escalations
             SET escalation = NULL, mtime_ms = ${now}
           WHERE harness_slug = ${row.install_slug}
             AND phase = ${WATCHDOG_PHASE}
             AND escalation IS NOT NULL`;
        if (cleared.count === 1 || watchdogAlerted) {
          // WI-1444: supersede the fleet alarm — coord:inbox annotates every prior
          // `green-stall:<slug>` broadcast resolved, so a late reader never chases
          // a gate stall that already cleared. Guarded on the same transition edge
          // as `recovered` so a routinely-healthy pass broadcasts nothing.
          await broadcastSevereEventResolved({
            conditionKey: `green-stall:${row.install_slug}`,
            summary: `green-checkpoint RECOVERED on ${row.install_slug} — the gate is producing verdicts again; the earlier stall alarm is stale.`,
          });
          out.recovered.push(row.install_slug);
        }
      }
    }
    return out;
  } catch (e) {
    console.warn(`[green-stall-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}

// ── main-behind-staging guard (EI-9762) ────────────────────────────────────────

export interface MainBehindStagingSnapshot {
  /** `git rev-list --count <mainBranch>..<stagingBranch>` — null if unresolvable
   *  (e.g. a branch missing in a fresh/partial checkout — fail-open, never alarm). */
  commitsBehind: number | null;
  /** How long `staging` has been ahead of `main` by at least one commit — the age
   *  (ms) of the OLDEST commit reachable from staging but not main. null if
   *  commitsBehind is 0/null. This is the "~4.8h" half of the EI-9762 signal. */
  behindMs: number | null;
  /** EI-10202: ms since the green-checkpoint gate last ADVANCED `main` (an age
   *  derived from `gate_health.lastGreenAt`, like `behindMs` is derived from the
   *  oldest commit's timestamp). null when unreadable / the gate never greened —
   *  in which case we cannot prove the gate is advancing, so we fall back to the
   *  depth+age-only signal (never silently suppress a possible real stall). A
   *  SMALL value means the gate is demonstrably still advancing main every cycle,
   *  so a deep backlog is normal churn, NOT a wedge. */
  lastGreenAgeMs?: number | null;
  /** EI-19459452257836856: is a green-checkpoint run held by a LIVE process right
   *  now? This alarm is broadcast hive-wide as a severe-event, and its remedy used
   *  to tell EVERY agent to fire `release:checkpoint-run` unconditionally — the one
   *  action the repo guide flags in bold as never-do-while-a-run-is-live (firing
   *  inside a run's re-triage window discards an in-progress rescue and costs a
   *  full ~55min suite). An agent did exactly that during the 2026-08-03 stall and
   *  conceded it was premature. THREE states, deliberately:
   *    - `true`      a run IS in flight → the remedy must say WAIT, never "fire".
   *    - `false`     no run in flight  → firing really is the right remedy.
   *    - `undefined`/`null` UNKNOWN    → its own arm. Treating unknown as `true`
   *      would suppress the remedy on a genuine stall; treating it as `false` is
   *      exactly the bug this field fixes. So we alarm, and say "check first".
   *  Note this gates only the REMEDY TEXT, never `stalled`: a run being in flight
   *  does not mean the gate is healthy (it may be the 12th consecutive red), and
   *  suppressing the alarm on it would hide a real wedge. Gate-is-advancing
   *  suppression is `lastGreenAgeMs`'s job (EI-10202), not this field's. */
  runInFlight?: boolean | null;
  /** Seconds the in-flight run has been going, when measurable — turns "wait" into
   *  "wait, it started ~Nm ago". null/undefined when no run or unmeasurable. */
  runInFlightElapsedSec?: number | null;
}

export interface MainBehindStagingVerdict {
  stalled: boolean;
  reason: string | null;
}

/** Pure: decide whether `main`'s lag behind `staging` has crossed from "normal
 *  promotion latency" into "the gate stopped advancing main". THREE conditions —
 *  depth + age must BOTH trip (a lot of commits queued in the last few minutes is
 *  normal churn; a small lag sitting for hours is also normal on a quiet day),
 *  AND (EI-10202) the gate must NOT have advanced `main` recently. That last
 *  condition is the fix for the false STALLED alarm: a healthy gate greening
 *  every ~15-20 min still lets `main` fall dozens of commits / >1h behind under a
 *  busy fleet (staging outruns the full-suite cycle) — but that is backlog depth,
 *  not a wedge. Only when the gate has produced NO green advance in >recentGreenMs
 *  alongside the deep old backlog is it the genuinely-stuck signature (persistent
 *  red / killed runs) EI-9762 targets. A null `lastGreenAgeMs` (gate signal
 *  unreadable) falls back to depth+age only — we never hide a possible real stall.
 *  Exported for unit testing. */
export function evaluateMainBehindStaging(
  s: MainBehindStagingSnapshot,
  opts: {
    commitsThreshold?: number;
    msThreshold?: number;
    recentGreenMs?: number;
    advanceHorizonMs?: number;
  } = {},
): MainBehindStagingVerdict {
  const commitsThreshold = opts.commitsThreshold ?? DEFAULT_MAIN_BEHIND_COMMITS;
  const msThreshold = opts.msThreshold ?? DEFAULT_MAIN_BEHIND_MS;
  const recentGreenMs = opts.recentGreenMs ?? DEFAULT_MAIN_BEHIND_RECENT_GREEN_MS;
  const advanceHorizonMs = opts.advanceHorizonMs ?? DEFAULT_MAIN_BEHIND_ADVANCE_HORIZON_MS;
  if (s.commitsBehind == null || s.behindMs == null) return { stalled: false, reason: null };
  // EI-10202: the gate is demonstrably advancing main → a deep backlog is churn,
  // not a stall. Only known-and-recent green suppresses; an unknown/absent signal
  // does not (fall through to depth+age so a real stall still alarms).
  // WI-38340: …and only when that advance actually CONSUMED the backlog. A recent
  // advance whose `behindMs` still runs far ahead of it moved the tip end, not the
  // old end (the partial-green salvage's signature) — motion, not progress. See
  // DEFAULT_MAIN_BEHIND_ADVANCE_HORIZON_MS for the derivation of the bound.
  const advanceConsumedBacklog =
    s.lastGreenAgeMs != null && s.behindMs <= s.lastGreenAgeMs + advanceHorizonMs;
  const recentlyAdvanced =
    s.lastGreenAgeMs != null && s.lastGreenAgeMs <= recentGreenMs && advanceConsumedBacklog;
  const stalled = s.commitsBehind > commitsThreshold && s.behindMs > msThreshold && !recentlyAdvanced;
  if (!stalled) return { stalled: false, reason: null };
  const hoursBehind = (s.behindMs / 3_600_000).toFixed(1);
  // When we know the gate has ALSO not greened for a while, name it — it turns the
  // alarm from "main is behind" (ambiguous) into "main is behind AND the gate has
  // not advanced it in ~Xh" (the actual stall), and proves the depth number wasn't
  // the sole trigger (EI-10202).
  // WI-38340: there are now TWO ways to reach this alarm, and they need OPPOSITE
  // responses, so they must not share one sentence. The clause below used to be
  // emitted off `lastGreenAgeMs != null` alone — which, once a recent-but-
  // unproductive advance could reach here, would have printed "no green-checkpoint
  // advance in ~0.1h" about a gate that had just advanced. An alarm that misstates
  // its own trigger sends the reader hunting a wedged gate that is running fine.
  const advanceAgeHours = s.lastGreenAgeMs != null ? (s.lastGreenAgeMs / 3_600_000).toFixed(1) : null;
  // The gate advanced main recently, yet the old end of the backlog did not move:
  // the partial-green-salvage signature (WI-38218 promotes the longest green PREFIX
  // while the tip stays red). Motion without progress.
  const advancedButUnproductive =
    s.lastGreenAgeMs != null && s.lastGreenAgeMs <= recentGreenMs && !advanceConsumedBacklog;
  const noGreenClause = advancedButUnproductive
    ? ` (the gate DID advance main ~${advanceAgeHours}h ago, but the oldest un-promoted commit is still ~${hoursBehind}h old — it advanced the tip end, not this backlog)`
    : advanceAgeHours != null
      ? ` (no green-checkpoint advance in ~${advanceAgeHours}h)`
      : '';
  const notAdvancing = advancedButUnproductive
    ? 'the gate is not consuming this backlog'
    : 'the gate is not advancing main';
  const lede =
    `\`main\` is ${s.commitsBehind} commits / ~${hoursBehind}h behind \`staging\`${noGreenClause} — ${notAdvancing}, regardless ` +
    `of why (red verdicts, a killed/wedged run, or a wedged routine engine). `;
  // EI-19459452257836856: the remedy is the part that was wrong, and it is read by
  // every agent in the hive at once. Point at the run's OWN authoritative break-set
  // line rather than the old undirected "find whatever is failing" — the agent who
  // mis-fired during the 2026-08-03 stall did exactly that and verified ONE red,
  // never the failing SET.
  const breakSet =
    `its verdict's own AFFECTED_TESTS_FAILING_FILES line names the failing files ` +
    `(read \`coverage\` first — \`files=[]\` means "not attributable", NOT "nothing failed").`;
  if (s.runInFlight === true) {
    const started =
      s.runInFlightElapsedSec != null ? ` (started ~${Math.round(s.runInFlightElapsedSec / 60)}m ago)` : '';
    return {
      stalled: true,
      reason:
        lede +
        `A green-checkpoint run IS IN FLIGHT right now${started} — do NOT launch another: the run lock would refuse ` +
        `it, and firing inside a live run's re-triage window DISCARDS an in-progress rescue and costs a full suite. ` +
        `Wait for this run's verdict (checkpoint:await); if it reds, ${breakSet}`,
    };
  }
  if (s.runInFlight === false) {
    return {
      stalled: true,
      reason:
        lede +
        `No checkpoint run is in flight. Fire a fresh gate run (release:checkpoint-run), then fix what it names — ${breakSet}`,
    };
  }
  // UNKNOWN — never the old unconditional instruction (that is the defect), and
  // never silent suppression either. Alarm, and make the check the first step.
  return {
    stalled: true,
    reason:
      lede +
      `Whether a checkpoint run is currently in flight could NOT be determined here — CHECK FIRST ` +
      `(dev:pipeline_position → gate.checkpointRunInFlight) before launching one: firing inside a live run's ` +
      `re-triage window discards an in-progress rescue. If none is running, fire one — then fix what it names: ${breakSet}`,
  };
}

/** WI-38340: the all-clear text for the main-behind-staging alarm.
 *
 *  The bug that produced this function: the recovery broadcast was a CONSTANT
 *  string asserting `main` was "no longer meaningfully behind staging", emitted
 *  purely off `stalled` flipping false. But `stalled` can flip false via the
 *  recent-advance suppression ALONE, with `commitsBehind` untouched — so on
 *  2026-08-12T23:03Z the fleet was told main had recovered while it was measured
 *  327 commits behind. An all-clear must never claim a property it did not
 *  measure; both arms below state the number they actually read.
 *
 *  The two arms are genuinely different situations and are worded so a reader can
 *  tell them apart:
 *    · caught up  — the backlog really is at/below the alarm threshold.
 *    · suppressed — the alarm is CLEARED, but main is still deep behind; what
 *      changed is that the gate is advancing again. Saying "recovered" flatly
 *      here is the false all-clear this fixes.
 *
 *  Pure + exported for a DB-free regression test, matching the convention
 *  `evaluateMainBehindStaging` / `shouldWarnOnStallClearMiss` already set. */
export function mainBehindRecoverySummary(
  harnessSlug: string,
  s: Pick<MainBehindStagingSnapshot, 'commitsBehind'>,
  opts: { commitsThreshold?: number } = {},
): string {
  const commitsThreshold = opts.commitsThreshold ?? DEFAULT_MAIN_BEHIND_COMMITS;
  const behind = s.commitsBehind;
  // Unmeasurable depth (a branch missing / git error) is its own arm: the alarm is
  // cleared because the signal went unreadable, which is NOT evidence main caught
  // up. Never dress that up as a recovery.
  if (behind == null) {
    return (
      `main-behind-staging alarm CLEARED on ${harnessSlug} — but the staging/main distance could NOT be measured ` +
      `on this pass, so this is not a confirmation that main caught up. Re-check with dev:pipeline_position.`
    );
  }
  if (behind <= commitsThreshold) {
    return `main RECOVERED on ${harnessSlug} — now ${behind} commits behind staging (at/below the ${commitsThreshold} threshold); the earlier stall alarm is stale.`;
  }
  return (
    `main-behind-staging alarm CLEARED on ${harnessSlug}, but main is STILL ${behind} commits behind staging — ` +
    `cleared because the gate has advanced main recently and is consuming the backlog, NOT because main caught up. ` +
    `Do not read this as "the pipeline is fine": re-check the real distance with dev:pipeline_position.`
  );
}

function gitOut(root: string, args: string[]): string | null {
  try {
    // EI-9922 (EI-8794 class): a failing git call — e.g. this watchdog's boot pass
    // running in a PACKAGED install's non-repo dir — must NOT leak "fatal: not a git
    // repository" onto the parent's own stderr/serve.log. `execFileSync`'s default
    // stdio inherits the child's stderr; pin it to ['ignore','pipe','ignore'] so we
    // capture stdout but discard stderr (mirrors build-info.ts / workspace-map.ts).
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Reads the live commits-behind + how-long-behind gap between `main` and
 *  `staging` in `root` via plain git shell-outs — deliberately NOT importing
 *  from apps/operator/lib/release/* (wrong dependency direction for
 *  operator-core; mirrors dev-deploy-state.ts's own self-contained pattern).
 *  Fails open (all-null) on any git error — a missing branch/checkout must
 *  never itself trigger the alarm it's trying to compute. */
export function computeMainBehindStaging(
  root: string,
  mainBranch = 'main',
  stagingBranch = 'staging',
): MainBehindStagingSnapshot {
  const countRaw = gitOut(root, ['rev-list', '--count', `${mainBranch}..${stagingBranch}`]);
  const commitsBehind = countRaw != null && /^\d+$/.test(countRaw) ? Number(countRaw) : null;
  if (commitsBehind == null || commitsBehind === 0) return { commitsBehind: commitsBehind ?? null, behindMs: null };

  // The OLDEST commit reachable from staging but not main — its age is how
  // long main has been behind by at least this much (a fresh-only lag from
  // commits landing in the last minute reads as ~0, not an hours-old stall).
  const oldestTsRaw = gitOut(root, [
    'log',
    `${mainBranch}..${stagingBranch}`,
    '--format=%ct',
    '--reverse',
  ]);
  const oldestTs = oldestTsRaw ? Number(oldestTsRaw.split('\n')[0]) : NaN;
  if (!Number.isFinite(oldestTs)) return { commitsBehind, behindMs: null };
  return { commitsBehind, behindMs: Math.max(0, Date.now() - oldestTs * 1000) };
}

/** EI-10202: read ms-since the green-checkpoint gate last ADVANCED `main` for a
 *  harness (`gate_health.lastGreenAt`, the same field trackGateStall stamps to
 *  Date.now() on every green tick). Fail-soft: any read error / missing routine /
 *  never-greened gate returns null, and evaluateMainBehindStaging then falls back
 *  to the depth+age-only signal — an unreadable gate must never SUPPRESS a real
 *  stall, only a demonstrably-recent green does. */
export async function readGateLastGreenAgeMs(
  sql: Sql,
  installSlug: string,
  nowMs: number,
): Promise<number | null> {
  try {
    const rows = await sql<{ last_green_at: string | number | null }[]>`
      SELECT (metadata->'gate_health'->>'lastGreenAt') AS last_green_at
        FROM harness_shared.routines
       WHERE install_slug = ${installSlug}
         AND target_role = 'system:green-checkpoint'
         AND active = true
       LIMIT 1`;
    const raw = rows[0]?.last_green_at;
    if (raw == null) return null;
    const lastGreenAt = Number(raw);
    if (!Number.isFinite(lastGreenAt)) return null;
    return Math.max(0, nowMs - lastGreenAt);
  } catch {
    return null;
  }
}

/** One watchdog pass for the main-behind-staging guard, scoped to a single git
 *  root (the operator's own home harness — this is a local-git-tree signal,
 *  not a per-tenant DB one, so it does not loop over `harness_shared.routines`
 *  the way `checkGreenStall` does). Reuses the exact alarm plumbing
 *  (notifyAttention + broadcastSevereEvent + harness_escalations) under its OWN
 *  phase so it never clobbers either of the other two conditions' dedup state.
 *  Dedup is the escalation row's own presence — no gate_health flag needed.
 *  Never throws — rides the same interval as checkGreenStall and must not
 *  break it. */
export async function checkMainBehindStaging(
  sql: Sql,
  opts: {
    root?: string;
    harnessSlug?: string;
    workspaceId?: string;
    commitsThreshold?: number;
    msThreshold?: number;
    recentGreenMs?: number;
    /** WI-38340 — threaded straight through to evaluateMainBehindStaging. */
    advanceHorizonMs?: number;
    mainBranch?: string;
    stagingBranch?: string;
  } = {},
): Promise<{ alarmed: boolean; recovered: boolean }> {
  const out = { alarmed: false, recovered: false };
  try {
    const root =
      opts.root ??
      process.env.PAPERCUSP_INTEGRATION_ROOT ??
      gitOut(process.cwd(), ['rev-parse', '--show-toplevel']) ??
      process.cwd();
    const harnessSlug = opts.harnessSlug ?? 'papercusp';
    const gitSnapshot = computeMainBehindStaging(root, opts.mainBranch, opts.stagingBranch);
    // EI-10202: fold in "has the gate advanced main recently?" so a deep-but-
    // healthy backlog (gate greening every cycle) is not mislabeled STALLED.
    // Only read the DB signal when the git snapshot could even alarm — a quiet
    // in-sync tree short-circuits without touching PG.
    const lastGreenAgeMs =
      gitSnapshot.commitsBehind && gitSnapshot.behindMs != null
        ? await readGateLastGreenAgeMs(sql, harnessSlug, Date.now())
        : null;
    // EI-19459452257836856: is a run in flight RIGHT NOW? Same gating as above —
    // only read when the git snapshot could even alarm. `isCheckpointRunLockHeldCheap`
    // reads only the file-based run-lock's owner.json (no subprocess) and
    // pid-liveness-verifies the owner, so it sees CRON and MANUAL runs alike — both
    // hold the same lock for the run's whole duration. It is documented fail-soft,
    // but this watchdog must never throw, and "unknown" is a real, deliberately
    // distinct arm of the remedy (see MainBehindStagingSnapshot.runInFlight), so a
    // throw degrades to unknown rather than to a wrong `false`.
    let runInFlight: boolean | undefined;
    let runInFlightElapsedSec: number | null | undefined;
    if (gitSnapshot.commitsBehind && gitSnapshot.behindMs != null) {
      try {
        const lock = isCheckpointRunLockHeldCheap(root);
        runInFlight = lock.held;
        runInFlightElapsedSec = lock.elapsedSec;
      } catch {
        runInFlight = undefined; // UNKNOWN — never silently "no run in flight"
      }
    }
    const snapshot: MainBehindStagingSnapshot = {
      ...gitSnapshot,
      lastGreenAgeMs,
      runInFlight,
      runInFlightElapsedSec,
    };
    const verdict = evaluateMainBehindStaging(snapshot, opts);

    const existing = await sql<{ escalation: unknown }[]>`
      SELECT escalation FROM harness_shared.harness_escalations
       WHERE harness_slug = ${harnessSlug} AND phase = ${MAIN_BEHIND_PHASE}`;
    const alreadyAlarmed = existing.length > 0 && existing[0].escalation != null;

    if (verdict.stalled) {
      if (alreadyAlarmed) return out; // one-shot until recovery, like checkGreenStall
      // EI-10103: harness_escalations.workspace_id is NOT NULL (default ''); this check is
      // single-harness-scoped (unlike checkGreenStall's per-tenant `routines` scan, which
      // gets a real workspace_id off each row) and had no caller ever pass opts.workspaceId,
      // so the insert below explicitly wrote NULL — bypassing the column default (a default
      // only applies when the column is OMITTED, not when it's explicitly set to NULL) and
      // violating the not-null constraint on every real stall, silently swallowed by this
      // function's own outer catch (the watchdog that should escalate a promotion stall
      // could never actually write its escalation). Resolve the real workspace the harness
      // lives in, lazily (only on an actual stall, not every quiet pass); never let a
      // resolution failure block the escalation itself (an empty string falls back to
      // exactly what the column's own default would have been for an unresolvable harness).
      const workspaceId =
        opts.workspaceId ??
        (await resolveWorkspaceForHarness(harnessSlug).catch((e) => {
          console.warn(
            `[main-behind-staging-watchdog] workspace resolution failed for '${harnessSlug}': ${e instanceof Error ? e.message : e}`,
          );
          return '';
        }));
      try {
        const { notifyAttention } = await import('../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title: 'Release pipeline STALLED — main is falling behind staging',
          body: verdict.reason ?? '',
          importance: 'urgent',
          workspaceId,
          data: { commitsBehind: snapshot.commitsBehind, behindMs: snapshot.behindMs },
        });
      } catch (e) {
        console.warn(`[main-behind-staging-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
      }
      await broadcastSevereEvent({
        summary: `main is ${snapshot.commitsBehind} commits behind staging on ${harnessSlug} — promotion pipeline stalled.`,
        body: verdict.reason ?? '',
        category: 'severe-event',
        conditionKey: `main-behind-staging:${harnessSlug}`,
        // WI-6228: one-shot until recovery (`alreadyAlarmed` below) — our silence
        // is deliberate, never evidence main caught up.
        oneShot: true,
      });
      await sql`
        INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
        VALUES (${harnessSlug}, ${MAIN_BEHIND_PHASE}, ${JSON.stringify({
          kind: MAIN_BEHIND_PHASE,
          harness_slug: harnessSlug,
          commitsBehind: snapshot.commitsBehind,
          behindMs: snapshot.behindMs,
          detail: verdict.reason,
          emitted_at: Date.now(),
        })}, ${Date.now()}, ${workspaceId})
        ON CONFLICT (harness_slug, phase)
        DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
      out.alarmed = true;
      console.warn(`[main-behind-staging-watchdog] ALARM ${harnessSlug}: ${verdict.reason}`);
    } else if (alreadyAlarmed) {
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = NULL, mtime_ms = ${Date.now()}
         WHERE harness_slug = ${harnessSlug} AND phase = ${MAIN_BEHIND_PHASE} AND escalation IS NOT NULL`;
      await broadcastSevereEventResolved({
        conditionKey: `main-behind-staging:${harnessSlug}`,
        // WI-38340: state the depth we actually measured on THIS pass. The old
        // constant claimed main was "no longer meaningfully behind staging" off
        // nothing but `stalled` going false, and broadcast that to the whole fleet
        // while main was 327 commits behind.
        summary: mainBehindRecoverySummary(harnessSlug, snapshot, opts),
      });
      out.recovered = true;
    }
    return out;
  } catch (e) {
    console.warn(`[main-behind-staging-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}

// ── release-trigger silent-freeze guard (WI-4322) ──────────────────────────────

/** How long release-trigger may sit PAUSED (active:false) while green code is
 *  deployable-but-not-live before this alarms. Default 30 min: this failure mode
 *  (the routine auto-tripped during a deploy incident and never re-enabled
 *  itself — recurred 2026-06-18 + 2026-07-12, both times completely silent) can
 *  NEVER self-recover, so a much tighter window than the other two checks in
 *  this file is correct — a paused routine has no cadence to eventually catch
 *  up on its own, unlike a merely-stalled one. 30 min still absorbs a short
 *  deliberate manual pause (e.g. "pause auto-deploy, I'm fixing the checkout by
 *  hand") without false-alarming on it. `<=0` disables the check. */
const DEFAULT_RELEASE_TRIGGER_FREEZE_MS = 30 * 60 * 1000; // 30 min
const RELEASE_TRIGGER_FREEZE_PHASE = 'release-trigger-freeze-watchdog';

export interface ReleaseTriggerFreezeSnapshot {
  /** the release-trigger routine's `active` flag, or null when the row doesn't
   *  exist (a hive with no deploy target never seeds one — never alarm on that). */
  active: boolean | null;
  /** epoch ms of the routine row's `updated_at` — routines:set is the ONLY
   *  writer of `active` (the playbook forbids raw UPDATE) and always stamps
   *  `updated_at = now()` on every flip, so this doubles as "since when it went
   *  inactive" without a dedicated column. null if unresolvable. */
  updatedAtMs: number | null;
  /** green commits deployable but not live right now
   *  (`release-deploy-launch`'s `computeDeployStatus().deploy.deployedBehindGreenPin`). */
  deployedBehindGreenPin: number | null;
}

export interface ReleaseTriggerFreezeVerdict {
  frozen: boolean;
  reason: string | null;
}

/**
 * WI-4329: WHO paused release-trigger, so an alarm/responder can coordinate with the actual
 * owner instead of blind-toggling it back on (which just fights a still-in-progress protective
 * pause and produces the exact re-disable ping-pong that made WI-4322's recurrence look like an
 * unexplained "auto-disable" for weeks). `routines:set`'s gateway-control audit trail only
 * records `actor: role:${ctx.role}` (e.g. `role:operator`) — never WHICH session — so this reads
 * the richer `harness_shared.tool_invocations` telemetry instead, which carries `coord_owner_id`
 * for every MCP call. Best-effort / fail-soft: a lookup failure or empty history must never block
 * the alarm itself.
 */
export async function lastReleaseTriggerPauseOwner(
  sql: Sql,
): Promise<{ ownerId: string; invokedAtMs: number } | null> {
  try {
    const rows = await sql<{ coord_owner_id: string | null; invoked_at_ms: number | string | null }[]>`
      SELECT coord_owner_id, extract(epoch from invoked_at) * 1000 AS invoked_at_ms
        FROM harness_shared.tool_invocations
       WHERE tool_name = 'routines:set'
         AND status = 'ok'
         AND (args_json->>'name') = 'release-trigger'
         AND (args_json->>'active') = 'false'
       ORDER BY invoked_at DESC
       LIMIT 1`;
    const row = rows[0];
    if (!row?.coord_owner_id) return null;
    const invokedAtMs = row.invoked_at_ms != null ? Number(row.invoked_at_ms) : null;
    if (invokedAtMs == null || Number.isNaN(invokedAtMs)) return null;
    return { ownerId: row.coord_owner_id, invokedAtMs };
  } catch {
    return null;
  }
}

/**
 * Pure: is release-trigger PAUSED while green code is stranded, long enough to
 * call it a silent freeze rather than a normal short pause? Exported for unit
 * testing.
 */
export function evaluateReleaseTriggerFreeze(
  s: ReleaseTriggerFreezeSnapshot,
  now: number,
  opts: { thresholdMs?: number } = {},
): ReleaseTriggerFreezeVerdict {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_RELEASE_TRIGGER_FREEZE_MS;
  if (thresholdMs <= 0) return { frozen: false, reason: null };
  if (s.active !== false) return { frozen: false, reason: null }; // no row, or actively running
  if (s.deployedBehindGreenPin == null || s.deployedBehindGreenPin <= 0) {
    return { frozen: false, reason: null }; // nothing green is waiting — a paused trigger is harmless
  }
  // An unresolvable `updated_at` is treated as maximally stale (never assumed
  // fresh) — mirrors evaluateDeployStaleness's handling of a null deployedAtMs
  // in the sibling release-deploy-staleness-watchdog.
  const ageMs = s.updatedAtMs != null ? now - s.updatedAtMs : Number.POSITIVE_INFINITY;
  if (ageMs <= thresholdMs) return { frozen: false, reason: null };
  const mins = Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : null;
  return {
    frozen: true,
    reason:
      `release-trigger has been PAUSED (active:false)${mins != null ? ` for ~${mins}m` : ' — pause duration unknown'} ` +
      `while ${s.deployedBehindGreenPin} green commit(s) are deployable but not live: a SILENT fleet-wide deploy ` +
      `freeze — this exact signature has recurred twice (2026-06-18, 2026-07-12) with no auto-recovery. It will ` +
      `NEVER self-clear (a paused routine has no cadence to catch up on). Resume it: routines:set { name: ` +
      `'release-trigger', active: true }; then expedite with release:deploy { op: 'trigger', confirm: true } if ` +
      `code has been waiting a while.`,
  };
}

/**
 * One watchdog pass for the release-trigger silent-freeze guard, scoped to a
 * single install (mirrors `checkMainBehindStaging`'s single-harness shape —
 * this reads ONE routine row + the deploy pipeline snapshot, not every hive's
 * routines the way `checkGreenStall` scans). Reuses the exact alarm plumbing
 * (notifyAttention + broadcastSevereEvent + harness_escalations) under its OWN
 * phase so it never clobbers either of the other two conditions' dedup state.
 * Never throws — rides the same interval as the other two checks and must not
 * break them.
 */
export async function checkReleaseTriggerFreeze(
  sql: Sql,
  opts: {
    installSlug?: string;
    workspaceId?: string;
    thresholdMs?: number;
  } = {},
): Promise<{ alarmed: boolean; recovered: boolean }> {
  const out = { alarmed: false, recovered: false };
  try {
    const installSlug = opts.installSlug ?? 'papercusp';
    const rows = await sql<{ active: boolean; updated_at_ms: string | number | null; workspace_id: string }[]>`
      SELECT active, extract(epoch from updated_at) * 1000 AS updated_at_ms, workspace_id
        FROM harness_shared.routines
       WHERE install_slug = ${installSlug} AND name = 'release-trigger'
       LIMIT 1`;
    if (rows.length === 0) return out; // no deploy target declared for this hive — nothing to guard

    const workspaceId = opts.workspaceId ?? rows[0].workspace_id;
    const { gitPipelineSnapshot } = await import('../git-pipeline-stats');
    const { computeDeployStatus } = await import('../release-deploy-launch');
    const snap = await gitPipelineSnapshot(installSlug);
    const status = computeDeployStatus(snap);
    const now = Date.now();
    const verdict = evaluateReleaseTriggerFreeze(
      {
        active: rows[0].active,
        updatedAtMs: rows[0].updated_at_ms != null ? Number(rows[0].updated_at_ms) : null,
        deployedBehindGreenPin: status.deploy.deployedBehindGreenPin,
      },
      now,
      opts,
    );

    const existing = await sql<{ escalation: unknown }[]>`
      SELECT escalation FROM harness_shared.harness_escalations
       WHERE harness_slug = ${installSlug} AND phase = ${RELEASE_TRIGGER_FREEZE_PHASE}`;
    const alreadyAlarmed = existing.length > 0 && existing[0].escalation != null;

    if (verdict.frozen) {
      if (alreadyAlarmed) return out; // one-shot until recovery
      // WI-4329: attribute the pause so the alarm reads "coordinate with su-X", not just "someone
      // paused this" — cuts the ping-pong of a responder blind-re-enabling a still-needed pause.
      const pausedBy = await lastReleaseTriggerPauseOwner(sql);
      const pausedByLine = pausedBy
        ? `\n\nLast paused by ${pausedBy.ownerId} (routines:set active:false) at ${new Date(pausedBy.invokedAtMs).toISOString()}. ` +
          `Coordinate with them before re-enabling — a repeated pause is often a deliberate protective hold (e.g. a long-running ` +
          `demo/capture session that a deploy restart would kill), not a stuck bug; blind-toggling it back on just fights their hold.`
        : '';
      const reasonWithOwner = (verdict.reason ?? '') + pausedByLine;
      try {
        const { notifyAttention } = await import('../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title: 'Release pipeline FROZEN — release-trigger is paused with green code stranded',
          body: reasonWithOwner,
          importance: 'urgent',
          workspaceId,
          data: { deployedBehindGreenPin: status.deploy.deployedBehindGreenPin, pausedBy: pausedBy?.ownerId ?? null },
        });
      } catch (e) {
        console.warn(`[release-trigger-freeze-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
      }
      await broadcastSevereEvent({
        summary: `release-trigger is PAUSED on ${installSlug} with ${status.deploy.deployedBehindGreenPin} green commit(s) stranded — silent fleet-wide deploy freeze.`,
        body: reasonWithOwner,
        category: 'severe-event',
        conditionKey: `release-trigger-freeze:${installSlug}`,
        // WI-6228: one-shot until recovery (`alreadyAlarmed` below) — our silence
        // is deliberate, never evidence the deploy freeze lifted.
        oneShot: true,
      });
      try {
        await sql`
          INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
          VALUES (${installSlug}, ${RELEASE_TRIGGER_FREEZE_PHASE}, ${JSON.stringify({
            kind: RELEASE_TRIGGER_FREEZE_PHASE,
            harness_slug: installSlug,
            deployedBehindGreenPin: status.deploy.deployedBehindGreenPin,
            detail: reasonWithOwner,
            pausedBy: pausedBy?.ownerId ?? null,
            pausedAtMs: pausedBy?.invokedAtMs ?? null,
            emitted_at: now,
          })}, ${now}, ${workspaceId})
          ON CONFLICT (harness_slug, phase)
          DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
      } catch (e) {
        console.warn(`[release-trigger-freeze-watchdog] escalation write failed: ${e instanceof Error ? e.message : e}`);
      }
      out.alarmed = true;
      console.warn(`[release-trigger-freeze-watchdog] ALARM ${installSlug}: ${reasonWithOwner}`);
    } else if (alreadyAlarmed) {
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = NULL, mtime_ms = ${now}
         WHERE harness_slug = ${installSlug} AND phase = ${RELEASE_TRIGGER_FREEZE_PHASE} AND escalation IS NOT NULL`;
      await broadcastSevereEventResolved({
        conditionKey: `release-trigger-freeze:${installSlug}`,
        summary: `release-trigger RECOVERED on ${installSlug} — active again (or nothing green is stranded); the earlier freeze alarm is stale.`,
      });
      out.recovered = true;
    }
    return out;
  } catch (e) {
    console.warn(`[release-trigger-freeze-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}

// ── release-trigger fire-staleness guard (EI-14003) ────────────────────────────

/** release-trigger's documented cadence is <=15 min (cron fires every 15 minutes,
 *  seed-release-routines.ts). An ACTIVE routine that hasn't FIRED (`last_fired_at`)
 *  in this long, while green code is deployable-but-not-live, means the tick
 *  engine silently stopped driving it — a DIFFERENT failure mode than
 *  `checkReleaseTriggerFreeze` above, which only catches an EXPLICITLY PAUSED
 *  routine (active:false). This is the fire-staleness half of the same class
 *  `checkGreenStall` already covers for green-checkpoint — release-trigger never
 *  had the equivalent. EI-14003 (2026-07-17, reproduced via journalctl): a real
 *  65-min silent gap (03:34->05:35, cron is 15-min) went completely undetected
 *  because `active` stayed true the whole time (no pause, so
 *  checkReleaseTriggerFreeze never looked at it) and nothing else watches
 *  `last_fired_at` for this specific routine. 30 min = 2x the documented cadence
 *  + jitter headroom, well under the 65-min real gap. Independent of the 60-min
 *  `DEPLOY_BACKOFF_MS` (release-actions.ts): a routine correctly backing off
 *  still TICKS / updates `last_fired_at` every cron fire (`claim.ts` stamps it
 *  unconditionally at claim time, before the target action's own business logic
 *  runs), so a legitimate backoff never trips this false. `<=0` disables the
 *  check. */
const DEFAULT_RELEASE_TRIGGER_FIRE_STALE_MS = 30 * 60 * 1000; // 30 min
const RELEASE_TRIGGER_FIRE_STALE_PHASE = 'release-trigger-fire-stale-watchdog';

export interface ReleaseTriggerFireStaleSnapshot {
  /** the release-trigger routine's `active` flag, or null when the row doesn't
   *  exist (never alarm — mirrors ReleaseTriggerFreezeSnapshot). */
  active: boolean | null;
  /** epoch ms of the routine row's `last_fired_at` (claim.ts stamps this
   *  unconditionally on every claimed tick, regardless of whether the action
   *  found work to do) — null if never fired. */
  lastFiredMs: number | null;
  /** green commits deployable but not live right now. */
  deployedBehindGreenPin: number | null;
}

export interface ReleaseTriggerFireStaleVerdict {
  stale: boolean;
  reason: string | null;
}

/**
 * Pure: is release-trigger ACTIVE but silently not firing on its documented
 * cadence, while green code is stranded? Exported for unit testing.
 */
export function evaluateReleaseTriggerFireStale(
  s: ReleaseTriggerFireStaleSnapshot,
  now: number,
  opts: { thresholdMs?: number } = {},
): ReleaseTriggerFireStaleVerdict {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_RELEASE_TRIGGER_FIRE_STALE_MS;
  if (thresholdMs <= 0) return { stale: false, reason: null };
  // No row, or explicitly paused — checkReleaseTriggerFreeze owns the paused case.
  if (s.active !== true) return { stale: false, reason: null };
  if (s.deployedBehindGreenPin == null || s.deployedBehindGreenPin <= 0) {
    return { stale: false, reason: null }; // nothing green waiting — a quiet tick is healthy, not stale
  }
  // An unresolvable last_fired_at while green code is waiting is treated as
  // maximally stale — mirrors the sibling checks' "unknown ⇒ never assumed fresh".
  const ageMs = s.lastFiredMs != null ? now - s.lastFiredMs : Number.POSITIVE_INFINITY;
  if (ageMs <= thresholdMs) return { stale: false, reason: null };
  const mins = Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : null;
  return {
    stale: true,
    reason:
      `release-trigger is ACTIVE but has not FIRED${mins != null ? ` in ~${mins}m` : ' (never fired)'} while ` +
      `${s.deployedBehindGreenPin} green commit(s) are deployable but not live — the documented cadence is ` +
      `<=15min, so the scheduler/tick engine appears to have silently stopped driving this routine (a DIFFERENT ` +
      `failure than a PAUSED routine — active is still true). Check schedule:inventory / routines:list for ` +
      `release-trigger's health; release:deploy { op:'trigger', confirm:true } expedites once it's ticking again.`,
  };
}

/**
 * One watchdog pass for the release-trigger fire-staleness guard. Mirrors
 * `checkReleaseTriggerFreeze`'s shape (own routine-row read, own alarm plumbing,
 * own escalation phase/conditionKey so it never clobbers the paused-freeze
 * check's dedup state) but keys off `last_fired_at` instead of `updated_at`, and
 * fires on `active:true` instead of `active:false` — the two are deliberately
 * independent checks, not a shared branch, so each debounces on its own
 * transition. Never throws — rides the same interval as the other checks.
 */
export async function checkReleaseTriggerFireStale(
  sql: Sql,
  opts: { installSlug?: string; workspaceId?: string; thresholdMs?: number } = {},
): Promise<{ alarmed: boolean; recovered: boolean }> {
  const out = { alarmed: false, recovered: false };
  try {
    const installSlug = opts.installSlug ?? 'papercusp';
    const rows = await sql<{ active: boolean; last_fired_ms: string | number | null; workspace_id: string }[]>`
      SELECT active, extract(epoch from last_fired_at) * 1000 AS last_fired_ms, workspace_id
        FROM harness_shared.routines
       WHERE install_slug = ${installSlug} AND name = 'release-trigger'
       LIMIT 1`;
    if (rows.length === 0) return out; // no deploy target declared for this hive — nothing to guard

    const workspaceId = opts.workspaceId ?? rows[0].workspace_id;
    const { gitPipelineSnapshot } = await import('../git-pipeline-stats');
    const { computeDeployStatus } = await import('../release-deploy-launch');
    const snap = await gitPipelineSnapshot(installSlug);
    const status = computeDeployStatus(snap);
    const now = Date.now();
    const verdict = evaluateReleaseTriggerFireStale(
      {
        active: rows[0].active,
        lastFiredMs: rows[0].last_fired_ms != null ? Number(rows[0].last_fired_ms) : null,
        deployedBehindGreenPin: status.deploy.deployedBehindGreenPin,
      },
      now,
      opts,
    );

    const existing = await sql<{ escalation: unknown }[]>`
      SELECT escalation FROM harness_shared.harness_escalations
       WHERE harness_slug = ${installSlug} AND phase = ${RELEASE_TRIGGER_FIRE_STALE_PHASE}`;
    const alreadyAlarmed = existing.length > 0 && existing[0].escalation != null;

    if (verdict.stale) {
      if (alreadyAlarmed) return out; // one-shot until recovery
      try {
        const { notifyAttention } = await import('../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title: 'Release pipeline STALLED — release-trigger has stopped firing on cadence',
          body: verdict.reason ?? '',
          importance: 'urgent',
          workspaceId,
          data: { deployedBehindGreenPin: status.deploy.deployedBehindGreenPin },
        });
      } catch (e) {
        console.warn(`[release-trigger-fire-stale-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
      }
      await broadcastSevereEvent({
        summary: `release-trigger has gone silent on ${installSlug} — ${status.deploy.deployedBehindGreenPin} green commit(s) stranded.`,
        body: verdict.reason ?? '',
        category: 'severe-event',
        conditionKey: `release-trigger-fire-stale:${installSlug}`,
        // WI-6228: one-shot until recovery (`alreadyAlarmed` below) — our silence
        // is deliberate, never evidence release-trigger started firing again.
        oneShot: true,
      });
      try {
        await sql`
          INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
          VALUES (${installSlug}, ${RELEASE_TRIGGER_FIRE_STALE_PHASE}, ${JSON.stringify({
            kind: RELEASE_TRIGGER_FIRE_STALE_PHASE,
            harness_slug: installSlug,
            deployedBehindGreenPin: status.deploy.deployedBehindGreenPin,
            detail: verdict.reason,
            emitted_at: now,
          })}, ${now}, ${workspaceId})
          ON CONFLICT (harness_slug, phase)
          DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
      } catch (e) {
        console.warn(`[release-trigger-fire-stale-watchdog] escalation write failed: ${e instanceof Error ? e.message : e}`);
      }
      out.alarmed = true;
      console.warn(`[release-trigger-fire-stale-watchdog] ALARM ${installSlug}: ${verdict.reason}`);
    } else if (alreadyAlarmed) {
      await sql`
        UPDATE harness_shared.harness_escalations
           SET escalation = NULL, mtime_ms = ${now}
         WHERE harness_slug = ${installSlug} AND phase = ${RELEASE_TRIGGER_FIRE_STALE_PHASE} AND escalation IS NOT NULL`;
      await broadcastSevereEventResolved({
        conditionKey: `release-trigger-fire-stale:${installSlug}`,
        summary: `release-trigger RECOVERED on ${installSlug} — firing on cadence again (or nothing green is stranded); the earlier stall alarm is stale.`,
      });
      out.recovered = true;
    }
    return out;
  } catch (e) {
    console.warn(`[release-trigger-fire-stale-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the watchdog: an immediate boot check + a recurring process-level sweep.
 * Idempotent (a second call replaces the timer). Kill-switch:
 * PAPERCUSP_GREEN_STALL_WATCHDOG='0'. The timer is unref'd so it never keeps the
 * process alive on shutdown.
 */
export function startGreenStallWatchdog(
  sql: Sql,
  opts: GreenStallThresholds & { intervalMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_GREEN_STALL_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;

  const run = (): void => {
    void checkGreenStall(sql, opts).then((r) => {
      if (r.alarmed.length > 0) {
        console.warn(`[green-stall-watchdog] alarmed on: ${r.alarmed.join(', ')}`);
      }
    });
    // EI-9762: independent of the above — see checkMainBehindStaging's own doc
    // for why this can't share its DB-row loop. Failure here must never affect
    // the check above (each is wrapped/caught independently).
    void checkMainBehindStaging(sql);
    // WI-4322: release-trigger auto-disabling during a deploy incident and never
    // self-re-enabling has recurred twice (2026-06-18, 2026-07-12) with zero
    // detection either time — same independent-of-the-routine-engine rationale
    // as the two checks above (this is a process-level watcher, not a DBOS
    // routine, specifically so it can catch a routine going silently dark).
    void checkReleaseTriggerFreeze(sql);
    // EI-14003: release-trigger can go silent (stop firing on its <=15min cadence)
    // WITHOUT ever being paused (active stays true) — checkReleaseTriggerFreeze
    // above cannot see that case at all (it only looks at active:false). Same
    // independent-of-the-routine-engine rationale as the checks above.
    void checkReleaseTriggerFireStale(sql);
  };

  run(); // boot check
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval('green-stall-watchdog', intervalMs, run, { category: 'watchdog' });
}
