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
  /** WI-716: 'context-overflow' when this death matched CONTEXT_OVERFLOW_PATTERNS —
   *  still `env: true` (not charged on a first/second death) but routed through the
   *  bounded escalation path in `recordImplementWorkerExit` instead of the plain
   *  indefinite env-failure rollback. Absent for a generic env failure / DOA. */
  class?: 'context-overflow';
}

/**
 * Whether a worker exit is an ENVIRONMENT failure (don't charge the attempt) vs a
 * genuine worker outcome. A clean exit (0) is never an env failure — it resolved,
 * or it's a real exited-0-without-resolve worker bug. Non-zero: a recognizable
 * context-overflow or env signature in the output, OR a sub-floor near-empty death
 * (DOA). Pure.
 */
export function isEnvFailureExit(info: WorkerExitInfo): EnvFailureVerdict {
  if (info.exitCode === 0) return { env: false };
  const text = `${info.stdout ?? ''}\n${info.stderr ?? ''}`;
  const overflowHit = CONTEXT_OVERFLOW_PATTERNS.find((re) => re.test(text));
  if (overflowHit) return { env: true, reason: `context overflow ${overflowHit}`, class: 'context-overflow' };
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
  /** WI-716: read the item's current payload, to find the PRIOR contextOverflowDeaths
   *  count before deciding whether this death trips the escalation cap. Only called
   *  on the (rare) context-overflow path — every other exit path is unchanged.
   *  Best-effort: a read failure is treated as "0 prior deaths" (never throws). */
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

  // WI-716: a context-overflow death needs the item's PRIOR contextOverflowDeaths
  // count (persisted independently of implementAttempts, since the whole point of
  // rolling attempts back is that they must NOT track this) before we know whether
  // THIS death trips the bounded escalation cap. Best-effort: a read failure is
  // treated as "0 prior deaths" — never blocks the back-edge from recording.
  let overflow: { deaths: number; escalated: boolean } | undefined;
  if (env.class === 'context-overflow') {
    let prior = 0;
    try {
      const payload = await deps.getPayload(input.itemId);
      const raw = payload?.contextOverflowDeaths;
      prior = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0;
    } catch (e) {
      console.warn(`[implement-worker-exit] getPayload failed for ${input.itemId} (treating prior deaths as 0):`, e);
    }
    const deaths = prior + 1;
    overflow = { deaths, escalated: deaths >= CONTEXT_OVERFLOW_ESCALATE_CAP };
  }

  const detail =
    `worker exit ${input.exitCode} after ${Math.round(input.runtimeMs / 1000)}s` +
    (overflow
      ? overflow.escalated
        ? ` [context-overflow death ${overflow.deaths}/${CONTEXT_OVERFLOW_ESCALATE_CAP} — escalation cap tripped, routed to needs-human, attempt ${input.attempt} not charged]`
        : ` [context-overflow death ${overflow.deaths}/${CONTEXT_OVERFLOW_ESCALATE_CAP}; attempt ${input.attempt} not charged]`
      : env.env
        ? ` [env-failure: ${env.reason}; attempt ${input.attempt} not charged]`
        : ' [no resolve recorded; attempt charged]') +
    (tail ? `: ${tail}` : '');

  // Tag an ENV-failure (or context-overflow) death distinctly in resolved_by so the
  // orphaned-dispatch watchdog can EXCLUDE it from the "lane is broken" signal (a
  // rate-limit/auth outage — or a single oversized item overflowing — is not lane
  // breakage; signaling it files a major EI that itself DOAs on the same condition
  // → a self-amplifying noise loop).
  const by = overflow ? 'worker-exit-backedge-context-overflow' : env.env ? 'worker-exit-backedge-env' : 'worker-exit-backedge';
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

  if (env.env) {
    // EI-406: an environment failure is not a real attempt — roll the counter back
    // so a credential/infra outage can't drain the auto-eligible pool to human-only.
    await deps.mergePayload(input.itemId, { implementAttempts: Math.max(0, input.attempt - 1) });
    return { marked: true, charged: false, envReason: env.reason };
  }
  return { marked: true, charged: true };
}
