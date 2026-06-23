/**
 * code-run-batch-nudge.ts — the INLINE "you're calling the same tool repeatedly; bundle it into one
 * code:run" nudge (code-run-token-frugality, owner directive 2026-06-23).
 *
 * The STRUCTURAL complement to CODE_RUN_NUDGE's prompt prose. The prose tells agents to batch tool
 * calls; this catches them NOT doing it and nudges at the DECISION POINT — the moment a caller fires
 * the SAME tool an Nth time in a session. That beats base-prompt prose for adoption (the prose
 * already existed while recipe/code:run adoption was ~0): a nudge attached to the live tool result
 * is read in-context, exactly when the wasteful pattern is happening.
 *
 * Cheap + safe by construction:
 *  - In-process only (no PG, no network): a per-session Map of tool→count + a one-shot "already
 *    nudged" set, so the hot path is a single Map increment on the common call.
 *  - ONE-SHOT per (session, tool): fires once when the count crosses the threshold, never again for
 *    that tool in that session — no per-call spam.
 *  - SCOPED to callers who actually HOLD code:run (SU_ROLES + bee, or superuser). A role that can't
 *    run code:run can't act on the nudge, so it never sees it.
 *  - EXCLUDES the batch tools themselves (code:* / recipes:*) — nudging "use code:run" on a code:run
 *    call is absurd.
 *  - Bounded memory: an insertion-order cap evicts the oldest session when the map is full.
 *
 * The boundary the nudge text states matches CODE_RUN_NUDGE exactly: bundle INDEPENDENT or
 * mechanically-chained calls (a script threads one result into the next fine); keep separate only a
 * call whose result you must READ AND REASON ABOUT before the next (judgment mid-flow), since a
 * script cannot pause for the model to think.
 *
 * Flag-gated at the call site (FLAGS.CODE_RUN_BATCH_NUDGE) so it has a runtime kill-switch; the
 * gate is only consulted when a hint actually fires (rare), so the per-call cost stays the Map bump.
 */
import { SU_ROLES } from '@papercusp/agent-mcp';

/** Same tool this many times in a session → the one-shot nudge fires. */
export const BATCH_NUDGE_THRESHOLD = 3;

/** Insertion-order cap on tracked sessions (backstop against unbounded growth). */
const MAX_TRACKED_SESSIONS = 4000;

/** Roles that hold code:run (SU_ROLES + bee); a superuser caller also qualifies (handled at the
 *  call site via isSuperuser). A role outside this set can't run code:run, so it is never nudged. */
export const CODE_RUN_CAPABLE_ROLES: ReadonlySet<string> = new Set<string>([...SU_ROLES, 'bee']);

/** Normalized names of the batch/reuse tools themselves — never nudge these (you don't tell a
 *  `code:run` call to "use code:run"). Normalization strips `:`/`_`/`-` so both the verb form
 *  (`code:run`) and the MCP form (`code_run`) match. */
const EXCLUDED_NORMALIZED: ReadonlySet<string> = new Set<string>([
  'coderun',
  'codetools',
  'recipesrun',
  'recipessearch',
  'recipeslist',
  'recipesget',
  'recipesmerge',
  'recipessweep',
  'recipescandidates',
]);

interface SessionState {
  /** tool name (as called) → call count this session */
  counts: Map<string, number>;
  /** tools already nudged this session (one-shot guard) */
  nudged: Set<string>;
}

const sessions = new Map<string, SessionState>();

function normalize(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface BatchNudgeInput {
  /** Stable per-session key — the handler's replayOwnerKey (uiClientId ?? spawnId). */
  sessionKey: string;
  /** The tool just called (MCP or verb form). */
  toolName: string;
  /** Whether the caller can actually run code:run (role ∈ CODE_RUN_CAPABLE_ROLES OR superuser). */
  canCodeRun: boolean;
}

/**
 * Record a tool call and, the FIRST time a (session, tool) crosses BATCH_NUDGE_THRESHOLD, return a
 * one-shot nudge string steering the caller to bundle the repeated calls into one `code:run`.
 * Returns null otherwise. Never throws. Counting still happens for excluded/incapable callers? No —
 * those short-circuit to null with no state, since they can never produce a useful nudge.
 */
export function maybeBatchNudge(input: BatchNudgeInput): string | null {
  const { sessionKey, toolName, canCodeRun } = input;
  if (!canCodeRun || !sessionKey || !toolName) return null;
  if (EXCLUDED_NORMALIZED.has(normalize(toolName))) return null;

  let st = sessions.get(sessionKey);
  if (!st) {
    if (sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    st = { counts: new Map(), nudged: new Set() };
    sessions.set(sessionKey, st);
  }

  const n = (st.counts.get(toolName) ?? 0) + 1;
  st.counts.set(toolName, n);

  if (n >= BATCH_NUDGE_THRESHOLD && !st.nudged.has(toolName)) {
    st.nudged.add(toolName);
    return (
      `you've called "${toolName}" ${n}× this session. If these are independent or ` +
      `mechanically-chained calls, fold them into ONE code:run (a script threads one call's result ` +
      `into the next, and bulk args like ids:[…] batch a homogeneous set) — or reuse a recipe ` +
      `(recipes:search { query }) — to skip the per-call round-trips. Keep a call separate ONLY when ` +
      `you must read its result and DECIDE before the next (a script can't pause for you to think).`
    );
  }
  return null;
}

/** Test-only: clear the in-process session tracking between cases. */
export function _resetBatchNudgeState(): void {
  sessions.clear();
}
