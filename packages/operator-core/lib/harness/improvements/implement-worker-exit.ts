/**
 * implement-worker-exit.ts — the auto-implement lane's WORKER-EXIT BACK-EDGE
 * (self-improvement-consume-edges-2026-06-12, EI-404 + EI-406).
 *
 * The dispatch fires the implement worker fire-and-forget through the /invoke
 * route (it cannot fire durably — it runs inside a DBOS step, EI-403). The route
 * is the ONE thing that awaits the worker subprocess to exit, so it is where the
 * back-edge lives: when a dispatched worker exits WITHOUT having called
 * `improvements:resolve` (crashed, exited non-zero, or exited 0 but forgot to
 * resolve), record the death on the dispatch ledger row AT CLOSE TIME instead of
 * leaving it for the 2h orphan collector to notice (EI-404 — the common
 * worker-dies-host-lives case is now visible in seconds, with the worker's last
 * output captured for diagnosis).
 *
 * EI-406 — DON'T charge an ENVIRONMENT failure as a real attempt. A worker that
 * dies dead-on-arrival on a rate-limit / credential / spawn-infra failure says
 * NOTHING about the item; charging it burns the per-item attempt cap, and during
 * a credential outage every tick drains one attempt off the top eligible item
 * until the whole auto pool graduates to human-only. So an env-failure exit rolls
 * the item's attempt counter BACK — the cap stays for genuine could-not-fix loops,
 * not transient outages. (A host RESTART mid-dispatch kills the route too, so the
 * back-edge can't fire — that recovery is EI-403 Option B's job, not this one.)
 *
 * Pure classifier (`isEnvFailureExit`) + thin IO (`recordImplementWorkerExit`,
 * deps injectable for unit tests), mirroring the resolve-core / dispatch-ledger split.
 */

import { markDispatchOrphaned } from './dispatch-ledger';
import { mergeIssuePayload, getIssue } from '../../issues-engineer';

export interface WorkerExitInfo {
  /** Subprocess exit code (0 = clean exit). */
  exitCode: number;
  /** Wall-clock the worker ran, ms (the route measures it around spawnInvokeOnce). */
  runtimeMs: number;
  stdout?: string;
  stderr?: string;
  /**
   * WI-2162: the invoke route's `timeoutMs` for THIS dispatch (resolveInvokeTimeoutMs /
   * implementTimeoutMs) — the wall-clock bound the route itself SIGTERM's the child at.
   * Threaded through so `isEnvFailureExit` can tell "the worker was killed by our own
   * clock" from "the worker crashed on its own": both look identical to a text-pattern
   * scan (often EMPTY output — a bare SIGTERM has no last words to grep). Optional so
   * a caller that doesn't know it (or an older test) still gets the pre-existing
   * classification unchanged.
   */
  configuredTimeoutMs?: number;
}

/**
 * Output signatures of an ENVIRONMENT failure (rate-limit / auth / connectivity)
 * — the death is about the host's credentials/network, not the item. Matched
 * case-insensitively against stdout+stderr. The live EI-75 DOA was the weekly-limit
 * line ("You've hit your weekly limit · resets Jun 18, 7am"); the rest cover the
 * adjacent auth/quota/connectivity shapes.
 */
const ENV_FAILURE_PATTERNS: readonly RegExp[] = [
  /weekly limit/i,
  /rate.?limit/i,
  /hit your .*limit/i,
  /usage limit/i,
  /\bresets\b.*\b(am|pm)\b/i,
  /\bquota\b/i,
  /\b401\b|\b403\b/,
  /unauthorized/i,
  /authentication|authenticate/i,
  /\bcredential/i,
  /subscription access/i,
  /\borg(anization)?\b.*(disabled|block)/i,
  /econnrefused|enotfound|etimedout|socket hang up/i,
  // Transient UPSTREAM model-API 5xx / overload (EI-6876): the provider's own server
  // erroring mid-call — a 500/502/503/504/529, "Overloaded", or a truncated
  // "Server error mid-response" — is about the provider being briefly unhealthy, NOT
  // the item, and self-heals on retry, exactly like the rate-limit/connectivity shapes
  // above. The live EI-6876 death was "API Error: Server error mid-response. The
  // response above may be incomplete." (exit 1 after 866s). Without these it charged
  // the attempt AND tagged the death plain 'worker-exit-backedge', so the
  // orphaned-dispatch watchdog read it as "the lane is broken" and filed a major EI —
  // the very self-amplifying noise loop the resolved_by tagging below exists to avoid.
  /server error/i, // "Server error mid-response" + "internal server error"
  /overloaded/i, // Anthropic 529 overloaded_error
  /service unavailable/i, // 503
  /bad gateway/i, // 502
  /gateway time-?out/i, // 504
  // EI-6890: the INFERENCE-GATEWAY's own transient-upstream wrapper reports the NUMERIC
  // status + "upstream error: fetch failed" / "This is a server-side issue", NOT the
  // English "bad gateway"/"service unavailable" phrasings the EI-6876 patterns above
  // matched — so the live EI-6476 death ("API Error: 502 inference-gateway upstream
  // error: fetch failed. This is a server-side issue…", exit 1 after 249s) slipped
  // through, was charged, and tagged plain 'worker-exit-backedge', so the
  // orphaned-dispatch watchdog read it as "the lane is broken" and filed a false major
  // EI (EI-6890) — the SAME self-amplifying noise loop EI-6876 fixed for the English
  // shapes. Catch the numeric 5xx code + the gateway/undici transient signatures too.
  /\bfetch failed\b/i, // undici transient connectivity failure (DNS / socket / connection reset)
  /\bupstream error\b/i, // the inference-gateway wrapper for a failing upstream
  /server-?side issue/i, // the gateway's "This is a server-side issue, usually temporary" phrasing
  /\b5(?:0[0-9]|29)\b/, // a bare HTTP 5xx status code (500-509 / 529 overloaded), e.g. "API Error: 502 …"
];

/**
 * WI-716 — output signatures of a CONTEXT-OVERFLOW death: the worker's agentic
 * session exceeded the model's input window during a long reproduce+fix run. This
 * is an infra/context-management limit, NOT an item-quality signal (the item was
 * never really attempted-and-failed) — but unlike a generic env failure it is
 * usually NOT self-healing on a bare retry (the same oversized item tends to
 * overflow again), so it gets its own bounded-escalation path instead of the
 * indefinite env-failure rollback (see `classifyContextOverflow` / the
 * CONTEXT_OVERFLOW_ESCALATE_CAP bound in `recordImplementWorkerExit`).
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i,
  /exceeds (?:the )?(?:model'?s? )?(?:context|input) (?:window|length)/i,
  /context.?length.?exceeded/i,
  /input is too long for the requested model/i,
];

/** After this many context-overflow deaths for the SAME item, stop rolling the
 *  attempt back and route to needs-human instead — bounded so an oversized item
 *  can't thrash the auto-implement lane forever (WI-716's "naive fix is unsafe"
 *  caveat: unconditionally rolling back causes an infinite re-dispatch loop). */
export const CONTEXT_OVERFLOW_ESCALATE_CAP = 2;

/**
 * WI-2162 — a WORKER-TIMEOUT death: the invoke route's own clock (resolveInvokeTimeoutMs /
 * implementTimeoutMs, currently 2_700_000ms = 45min) SIGTERM'd the child while it was still
 * doing legitimate work, NOT because the worker crashed or gave up. Root-caused live
 * 2026-07-04: the dominant CURRENT cause of "Auto-implement dispatch died — orphaned worker"
 * signals (17+ duplicate EIs) is exit code 143 (SIGTERM) at ~2700-2850s runtime — the worker
 * cut off mid-investigation ("Let me check...", "I'll start by reading...") every time, never
 * having reached a fix attempt, let alone `improvements:resolve`. Before this, these fell
 * through to the generic `worker-exit-backedge` bucket — CHARGED as a real attempt AND
 * eligible for the "lane is broken" signal, even though the death says nothing about the
 * item OR the lane: the clock simply ran out. Like context-overflow (WI-716), a bare retry
 * with the SAME time budget tends to overflow again on a genuinely large item, so this gets
 * the identical bounded-escalation shape instead of the indefinite env-failure rollback.
 * (isHostRestartVictim/host-restart-recovery and env-failure deaths were ALREADY correctly
 * excluded from lane-breakage signaling — orphaned-dispatch.ts's isLaneBreakageOrphan — so
 * this classifier gap was the actual mechanism generating the false "lane broken" backlog,
 * not host-restart frequency, which — while real per the dispatch-ledger stats — never
 * reaches the signal path at all.)
 */
export const TIMEOUT_ESCALATE_CAP = 2;

/** Exit codes a SIGTERM (143 = 128+15) or SIGKILL (137 = 128+9) subprocess kill produces —
 *  the two signals the route / OS could plausibly use to enforce the worker timeout. */
const TIMEOUT_KILL_EXIT_CODES: ReadonlySet<number> = new Set([143, 137]);

/** How far UNDER the configured timeout a death may fall and still count as a timeout-kill —
 *  covers measurement/scheduling jitter between the route's setTimeout firing and the
 *  wall-clock `runtimeMs` the caller measured. No upper bound: running longer than the
 *  configured timeout before dying is definitionally a timeout kill, whether the SIGKILL
 *  grace period added a few seconds or (per the observed EI-6966 outlier) over a thousand. */
const TIMEOUT_KILL_TOLERANCE_MS = 10_000;

/**
 * True when this exit is shaped like the invoke route's OWN timeout enforcement rather than
 * the worker's own choice to exit: a SIGTERM/SIGKILL exit code at or past the configured
 * limit (minus jitter tolerance). Requires `configuredTimeoutMs` — callers that don't know it
 * (or old call sites) get `false` here and fall through to the pre-existing classification,
 * unchanged. Pure.
 */
export function isWorkerTimeoutExit(info: WorkerExitInfo): boolean {
  if (info.configuredTimeoutMs == null || info.configuredTimeoutMs <= 0) return false;
  if (!TIMEOUT_KILL_EXIT_CODES.has(info.exitCode)) return false;
  return info.runtimeMs >= info.configuredTimeoutMs - TIMEOUT_KILL_TOLERANCE_MS;
}

/**
 * A real implement worker (reproduce + fix + regression test + test:affected) takes
 * minutes. A non-zero exit UNDER this floor with ~no output is a dead-on-arrival
 * spawn (the binary never did work) — an env/infra death, not an attempt.
 */
export const ENV_FAILURE_RUNTIME_FLOOR_MS = 30_000;

/** Bounded output kept on the ledger row for diagnosis (a dead worker's last words). */
const TAIL_CHARS = 300;

export interface EnvFailureVerdict {
  env: boolean;
  /** Why it was classed env (for the ledger detail / tests); undefined when not env. */
  reason?: string;
  /** WI-716/WI-2162: 'context-overflow' when this death matched CONTEXT_OVERFLOW_PATTERNS,
   *  'timeout' when it matches the invoke route's own SIGTERM-at-the-limit shape — both
   *  still `env: true` (not charged on a first/second death) but routed through the
   *  bounded escalation path in `recordImplementWorkerExit` instead of the plain
   *  indefinite env-failure rollback. Absent for a generic env failure / DOA. */
  class?: 'context-overflow' | 'timeout';
}

/**
 * Whether a worker exit is an ENVIRONMENT failure (don't charge the attempt) vs a
 * genuine worker outcome. A clean exit (0) is never an env failure — it resolved,
 * or it's a real exited-0-without-resolve worker bug. Non-zero: a recognizable
 * context-overflow or env signature in the output, a WORKER-TIMEOUT kill shape
 * (WI-2162 — checked before the generic sub-floor DOA rule since a timeout death is
 * ALWAYS past the floor and often has substantive-but-cut-off output, the opposite
 * of a DOA), or a sub-floor near-empty death (DOA). Pure.
 */
export function isEnvFailureExit(info: WorkerExitInfo): EnvFailureVerdict {
  if (info.exitCode === 0) return { env: false };
  const text = `${info.stdout ?? ''}\n${info.stderr ?? ''}`;
  const overflowHit = CONTEXT_OVERFLOW_PATTERNS.find((re) => re.test(text));
  if (overflowHit) return { env: true, reason: `context overflow ${overflowHit}`, class: 'context-overflow' };
  if (isWorkerTimeoutExit(info)) {
    return {
      env: true,
      reason: `worker timeout (exit ${info.exitCode} at ${info.runtimeMs}ms >= configured ${info.configuredTimeoutMs}ms)`,
      class: 'timeout',
    };
  }
  const hit = ENV_FAILURE_PATTERNS.find((re) => re.test(text));
  if (hit) return { env: true, reason: `env signature ${hit}` };
  if (info.runtimeMs < ENV_FAILURE_RUNTIME_FLOOR_MS && text.trim().length < 200) {
    return {
      env: true,
      reason: `dead-on-arrival (exit ${info.exitCode} in ${Math.round(info.runtimeMs / 1000)}s, ~empty output)`,
    };
  }
  return { env: false };
}

function boundedTail(info: WorkerExitInfo): string {
  const raw = (info.stdout ?? '').trim() || (info.stderr ?? '').trim();
  if (!raw) return '';
  return raw.length > TAIL_CHARS ? `…${raw.slice(-TAIL_CHARS)}` : raw;
}

export interface ImplementWorkerExitInput extends WorkerExitInfo {
  /** The dispatch ledger row id (improvement_dispatches.id). */
  dispatchId: string;
  /** The improvement item dispatched (for the attempt rollback). */
  itemId: string;
  /** The attempt number stamped for THIS dispatch (== payload.implementAttempts). */
  attempt: number;
}

/** Injectable deps (unit tests run without PG). */
export interface ImplementWorkerExitDeps {
  markOrphaned: (dispatchId: string, by: string, detail?: string) => Promise<boolean>;
  mergePayload: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  /** WI-716/WI-2162: read the item's current payload, to find the PRIOR
   *  contextOverflowDeaths / timeoutDeaths count before deciding whether this death
   *  trips its escalation cap. Only called on the (rare) context-overflow/timeout
   *  path — every other exit path is unchanged. Best-effort: a read failure is
   *  treated as "0 prior deaths" (never throws). */
  getPayload: (id: string) => Promise<Record<string, unknown> | null>;
}

const defaultDeps: ImplementWorkerExitDeps = {
  markOrphaned: markDispatchOrphaned,
  mergePayload: mergeIssuePayload,
  getPayload: async (id) => {
    const issue = await getIssue(id);
    return (issue?.payload as Record<string, unknown> | null | undefined) ?? null;
  },
};

export interface ImplementWorkerExitResult {
  /** True when this call marked the ledger row (false = already terminal: the worker resolved). */
  marked: boolean;
  /** True when the attempt stayed charged (a genuine worker failure); false = env-failure rolled back. */
  charged: boolean;
  /** Why it was treated as an env failure, when it was. */
  envReason?: string;
  /** WI-716: set when this was a context-overflow death — the running count of
   *  such deaths for this item (including this one) and whether the escalation
   *  cap tripped (routed to needs-human instead of rolled back). */
  contextOverflow?: { deaths: number; escalated: boolean };
  /** WI-2162: set when this was a worker-TIMEOUT death (the invoke route's own
   *  clock, not a crash) — the running count of such deaths for this item
   *  (including this one) and whether the escalation cap tripped. */
  timeoutEscalation?: { deaths: number; escalated: boolean };
}

/**
 * The back-edge: called by the /invoke route when a dispatched implement worker
 * exits. Marks the open ledger row orphaned at close time (EI-404) and rolls the
 * attempt counter back for an env-failure death (EI-406). Best-effort by contract
 * (the route wraps it) — accounting must never break the route. If the row is
 * already terminal (the worker DID resolve → outcome non-null), this is a no-op.
 */
export async function recordImplementWorkerExit(
  input: ImplementWorkerExitInput,
  deps: ImplementWorkerExitDeps = defaultDeps,
): Promise<ImplementWorkerExitResult> {
  const env = isEnvFailureExit(input);
  const tail = boundedTail(input);

  // WI-716/WI-2162: a context-overflow OR worker-timeout death needs the item's PRIOR
  // death count for ITS class (persisted independently of implementAttempts, since the
  // whole point of rolling attempts back is that they must NOT track this) before we
  // know whether THIS death trips its bounded escalation cap. Best-effort: a read
  // failure is treated as "0 prior deaths" — never blocks the back-edge from recording.
  let overflow: { deaths: number; escalated: boolean } | undefined;
  let timeoutEsc: { deaths: number; escalated: boolean } | undefined;
  if (env.class === 'context-overflow' || env.class === 'timeout') {
    let prior = 0;
    try {
      const payload = await deps.getPayload(input.itemId);
      const key = env.class === 'context-overflow' ? 'contextOverflowDeaths' : 'timeoutDeaths';
      const raw = payload?.[key];
      prior = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0;
    } catch (e) {
      console.warn(`[implement-worker-exit] getPayload failed for ${input.itemId} (treating prior deaths as 0):`, e);
    }
    const deaths = prior + 1;
    if (env.class === 'context-overflow') overflow = { deaths, escalated: deaths >= CONTEXT_OVERFLOW_ESCALATE_CAP };
    else timeoutEsc = { deaths, escalated: deaths >= TIMEOUT_ESCALATE_CAP };
  }

  const detail =
    `worker exit ${input.exitCode} after ${Math.round(input.runtimeMs / 1000)}s` +
    (overflow
      ? overflow.escalated
        ? ` [context-overflow death ${overflow.deaths}/${CONTEXT_OVERFLOW_ESCALATE_CAP} — escalation cap tripped, routed to needs-human, attempt ${input.attempt} not charged]`
        : ` [context-overflow death ${overflow.deaths}/${CONTEXT_OVERFLOW_ESCALATE_CAP}; attempt ${input.attempt} not charged]`
      : timeoutEsc
        ? timeoutEsc.escalated
          ? ` [worker-timeout death ${timeoutEsc.deaths}/${TIMEOUT_ESCALATE_CAP} — escalation cap tripped, routed to needs-human, attempt ${input.attempt} not charged]`
          : ` [worker-timeout death ${timeoutEsc.deaths}/${TIMEOUT_ESCALATE_CAP}; attempt ${input.attempt} not charged]`
        : env.env
          ? ` [env-failure: ${env.reason}; attempt ${input.attempt} not charged]`
          : ' [no resolve recorded; attempt charged]') +
    (tail ? `: ${tail}` : '');

  // Tag an ENV-failure / context-overflow / worker-timeout death distinctly in
  // resolved_by so the orphaned-dispatch watchdog can EXCLUDE it from the "lane is
  // broken" signal (a rate-limit/auth outage, an oversized item overflowing, or a
  // worker that simply ran out of its configured clock is not lane breakage;
  // signaling it files a major EI that itself DOAs/times-out on the SAME condition
  // → a self-amplifying noise loop — the exact WI-2162 backlog this closes).
  const by = overflow
    ? 'worker-exit-backedge-context-overflow'
    : timeoutEsc
      ? 'worker-exit-backedge-timeout'
      : env.env
        ? 'worker-exit-backedge-env'
        : 'worker-exit-backedge';
  const marked = await deps.markOrphaned(input.dispatchId, by, detail);
  if (!marked) {
    // Already terminal — the worker called improvements:resolve. Nothing to undo.
    return { marked: false, charged: true };
  }

  if (overflow) {
    if (overflow.escalated) {
      // WI-716 bounded escalation: repeated overflow on the SAME item means a bare
      // retry won't help (the item needs to be smaller-scoped / decomposed / given a
      // bigger-context worker) — stop the rollback-retry cycle (which would otherwise
      // thrash forever, per the ticket's "naive fix is unsafe" caveat) and route to a
      // human. needsHuman drops it from the auto-eligible pool regardless of attempts
      // (policy.ts), so leaving implementAttempts untouched here is fine.
      await deps.mergePayload(input.itemId, {
        contextOverflowDeaths: overflow.deaths,
        needsHuman: true,
      });
    } else {
      // Below the cap: not a real attempt (the item was never actually reproduced
      // against — the session just ran out of room) — roll the attempt back like a
      // generic env failure, but persist the death count so it keeps accumulating
      // across rollbacks (implementAttempts alone can't detect repeat overflow, since
      // rolling it back is what keeps it from ever exceeding where it started).
      await deps.mergePayload(input.itemId, {
        contextOverflowDeaths: overflow.deaths,
        implementAttempts: Math.max(0, input.attempt - 1),
      });
    }
    return { marked: true, charged: false, envReason: env.reason, contextOverflow: overflow };
  }

  if (timeoutEsc) {
    if (timeoutEsc.escalated) {
      // WI-2162 bounded escalation (mirrors WI-716): repeated timeout on the SAME item
      // means the invoke route's fixed clock genuinely isn't enough for it — a bare
      // retry with the same budget would just thrash — so stop rolling back and route
      // to a human instead. needsHuman drops it from the auto-eligible pool regardless
      // of attempts, so leaving implementAttempts untouched here is fine.
      await deps.mergePayload(input.itemId, {
        timeoutDeaths: timeoutEsc.deaths,
        needsHuman: true,
      });
    } else {
      // Below the cap: not a real attempt (the worker never reached a fix, let alone
      // improvements:resolve — it was still investigating when the clock ran out) —
      // roll the attempt back like a generic env failure, but persist the death count
      // so it keeps accumulating across rollbacks.
      await deps.mergePayload(input.itemId, {
        timeoutDeaths: timeoutEsc.deaths,
        implementAttempts: Math.max(0, input.attempt - 1),
      });
    }
    return { marked: true, charged: false, envReason: env.reason, timeoutEscalation: timeoutEsc };
  }

  if (env.env) {
    // EI-406: an environment failure is not a real attempt — roll the counter back
    // so a credential/infra outage can't drain the auto-eligible pool to human-only.
    await deps.mergePayload(input.itemId, { implementAttempts: Math.max(0, input.attempt - 1) });
    return { marked: true, charged: false, envReason: env.reason };
  }
  return { marked: true, charged: true };
}
