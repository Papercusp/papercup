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
  /** ms timestamp of the last SUCCESSFUL coord:orient this session (orient-dedup, P-009). */
  lastOrientAt?: number;
  /** subsumed tools already orient-dedup-nudged this session (one-shot guard, P-009). */
  orientDedupNudged: Set<string>;
}

const sessions = new Map<string, SessionState>();

/** Get (or lazily create, with insertion-order eviction) the per-session tracking state. The ONE
 *  shared map both nudges read/write, so orient timing and per-tool counts live together. */
function getOrCreateSession(sessionKey: string): SessionState {
  let st = sessions.get(sessionKey);
  if (!st) {
    if (sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    st = { counts: new Map(), nudged: new Set(), orientDedupNudged: new Set() };
    sessions.set(sessionKey, st);
  }
  return st;
}

function normalize(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** `wake-queue` / `set_status` → `wakeQueue` / `setStatus` (the code:run facade's JS-identifier keys). */
function camelVerb(verb: string): string {
  return verb.replace(/[-_]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());
}

/** Render the `tools.…` facade call for `toolName(a)` used in the ready-to-paste skeleton. Prefers the
 *  typed `tools.ns.verb(a)` form; falls back to the always-valid `tools.call('ns:verb', a)` escape
 *  hatch when the name doesn't cleanly split into JS identifiers. */
function facadeCall(toolName: string): string {
  const ci = toolName.indexOf(':');
  if (ci > 0) {
    const ns = toolName.slice(0, ci);
    const verb = camelVerb(toolName.slice(ci + 1));
    const ident = /^[A-Za-z_$][\w$]*$/;
    if (ident.test(ns) && ident.test(verb)) return `tools.${ns}.${verb}(a)`;
  }
  return `tools.call(${JSON.stringify(toolName)}, a)`;
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

  const st = getOrCreateSession(sessionKey);

  const n = (st.counts.get(toolName) ?? 0) + 1;
  st.counts.set(toolName, n);

  if (n >= BATCH_NUDGE_THRESHOLD && !st.nudged.has(toolName)) {
    st.nudged.add(toolName);
    // P-006 (agent-tooling-token-efficiency): the hint carries a READY-TO-PASTE code:run skeleton
    // targeting the EXACT repeated tool, so acting on it is a fill-in-the-blank, not a from-scratch
    // authoring task. The skeleton loops the repeated call over a caller-supplied `inputs` list.
    const skeleton =
      'code:run { script: `\n' +
      `  const inputs = [/* the args for each ${toolName} call */];\n` +
      '  const out = [];\n' +
      `  for (const a of inputs) out.push(await ${facadeCall(toolName)});\n` +
      '  return out;\n' +
      '` }';
    return (
      `you've called "${toolName}" ${n}× this session. If these are independent or ` +
      `mechanically-chained calls, fold them into ONE code:run — ready-to-paste skeleton ` +
      `(fill \`inputs\` with the per-call args):\n${skeleton}\n` +
      `Only the script's return re-enters context, so return what you'll need next. Or reuse a recipe ` +
      `(recipes:search { query }). Keep a call separate ONLY when you must read its result and DECIDE ` +
      `before the next (a script can't pause for you to think).`
    );
  }
  return null;
}

/** A subsumed re-fetch within this window after a successful coord:orient → the soft dedup nudge.
 *  Conservative (2 min) so a genuine LATER re-check in a long spawn is never nudged. */
export const ORIENT_DEDUP_WINDOW_MS = 120_000;

/** Normalized name → the human label for the slice of orient's payload this tool re-fetches. orient
 *  returns plan-events + inbox + a mem0 recall (for `intent`) AND declares intent in one round-trip,
 *  so calling any of these RIGHT AFTER a successful orient is a duplicate of what it already handed
 *  back. Keyed by `normalize()` so both the verb form and the MCP form match. */
const ORIENT_SUBSUMED_NORMALIZED: ReadonlyMap<string, string> = new Map<string, string>([
  ['coordplanevents', 'the recent plan-events delta'],
  ['coordinbox', 'your unread inbox summary'],
  ['memorysearch', 'a mem0 recall for your intent'],
  ['coorddeclareintent', 'your declared intent'],
]);

const ORIENT_NORMALIZED = 'coordorient';

export interface OrientDedupInput {
  /** Stable per-session key — the handler's replayOwnerKey (uiClientId ?? spawnId). */
  sessionKey: string;
  /** The tool just SUCCESSFULLY called (MCP or verb form). */
  toolName: string;
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: number;
}

/**
 * P-009 (agent-tooling-token-efficiency): a SOFT, one-shot nudge — never a block — when an agent
 * calls coord:plan-events / coord:inbox / memory:search / coord:declare-intent SHORTLY AFTER a
 * successful coord:orient in the same spawn, since orient's single round-trip already returned (and,
 * for intent, already declared) exactly that. Points the agent back at orient's payload. Conservative
 * by construction: recorded only on a successful orient, fires once per (session, subsumed-tool), and
 * only inside ORIENT_DEDUP_WINDOW_MS of the orient — a genuine later re-check is left alone. Shares
 * the SAME per-session map as the batch nudge. Role-agnostic (every agent role uses orient). Never
 * throws. Returns null when there's nothing to say.
 */
export function maybeOrientDedupNudge(input: OrientDedupInput): string | null {
  const { sessionKey, toolName } = input;
  if (!sessionKey || !toolName) return null;
  const now = input.now ?? Date.now();
  const norm = normalize(toolName);

  // Record the orient itself (and never nudge it). This is the only side effect on the common path.
  if (norm === ORIENT_NORMALIZED) {
    getOrCreateSession(sessionKey).lastOrientAt = now;
    return null;
  }

  const label = ORIENT_SUBSUMED_NORMALIZED.get(norm);
  if (!label) return null; // not a tool orient subsumes — nothing to dedup

  const st = sessions.get(sessionKey);
  if (!st || st.lastOrientAt === undefined) return null; // no orient this session ⇒ a fresh fetch
  if (now - st.lastOrientAt > ORIENT_DEDUP_WINDOW_MS) return null; // too late ⇒ a deliberate re-check
  if (st.orientDedupNudged.has(norm)) return null; // one-shot per (session, tool)
  st.orientDedupNudged.add(norm);

  return (
    `coord:orient already returned ${label} this turn — reuse orient's result instead of re-fetching. ` +
    `Call "${toolName}" again only for a detail orient deliberately bounds (e.g. full bodies, or a ` +
    `different query/scope).`
  );
}

/** Test-only: clear the in-process session tracking between cases. */
export function _resetBatchNudgeState(): void {
  sessions.clear();
}
