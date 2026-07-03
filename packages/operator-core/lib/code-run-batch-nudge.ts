/**
 * code-run-batch-nudge.ts — the INLINE "you're firing tool round-trips one at a time; bundle them
 * into one code:run" nudge (code-run-token-frugality, owner directive 2026-06-23; fan-out + felt-cost
 * upgrade, owner directive 2026-06-26).
 *
 * The STRUCTURAL complement to CODE_RUN_NUDGE's prompt prose. The prose tells agents to batch tool
 * calls; this catches them NOT doing it and nudges at the DECISION POINT — the live tool result,
 * read in-context exactly when the wasteful pattern is happening. That beats base-prompt prose for
 * adoption (the prose already existed while code:run adoption was ~0).
 *
 * TWO TRIGGERS (a 2026-06-26 adoption audit showed the original same-tool-only trigger could even
 * FIRE on only ~30% of multi-call SU spawns — it was BLIND to the dominant pattern):
 *  - SAME-TOOL: the same tool ≥ BATCH_NUDGE_THRESHOLD× inside the recent window (a `get` per id, a
 *    check per file) → the list-then-loop skeleton.
 *  - FAN-OUT: ≥ FANOUT_DISTINCT_THRESHOLD DISTINCT tools inside the recent window (the
 *    "many-different-reads-once" pattern the old nudge missed) → a Promise.all skeleton over the exact
 *    tools just seen.
 *
 * WINDOWED, not lifetime: counts are over a sliding NUDGE_WINDOW_MS window of recent calls, so only a
 * BURSTY flurry (the actually-batchable shape) trips it — three calls spread across ten minutes do
 * not. BACKOFF, not one-shot: ignoring a nudge once no longer silences it forever; it re-fires on an
 * exponential call-count cooldown (rarer each time) so a persistent waster keeps getting reminded
 * without spam. FELT COST: the hint leads with the running round-trip count (the token cost an agent
 * never otherwise sees) — making the invisible cost visible in-loop is the lever prose can't pull.
 *
 * Cheap + safe by construction:
 *  - In-process only (no PG, no network): a per-session ring of recent {tool, at} + a small backoff
 *    counter. The hot path is a push + a window trim on the common call.
 *  - SCOPED to callers who actually HOLD code:run (every built-in role as of 2026-06-25, or a
 *    superuser). A role that can't run code:run can't act on the nudge, so it never sees it.
 *  - EXCLUDES the batch tools themselves (code:* / recipes:*) — nudging "use code:run" on a code:run
 *    call is absurd, and they must not count toward the fan-out distinct-tool tally either.
 *  - Bounded memory: a per-session recent-ring cap + an insertion-order session cap evict the oldest.
 *
 * The boundary the nudge text states matches CODE_RUN_NUDGE exactly: bundle INDEPENDENT or
 * mechanically-chained calls (a script threads one result into the next fine); keep separate only a
 * call whose result you must READ AND REASON ABOUT before the next (judgment mid-flow), since a
 * script cannot pause for the model to think.
 *
 * Flag-gated at the call site, PER KIND, so each trigger has its own runtime kill-switch / A/B knob:
 * the same-tool path under FLAGS.CODE_RUN_BATCH_NUDGE, the newer fan-out path under
 * FLAGS.CODE_RUN_FANOUT_NUDGE. The gate is only consulted when a hint actually fires (rare), so the
 * per-call cost stays the ring push.
 */
import { AGENT_ROLES } from '@papercusp/agent-mcp';
import { ROLE_ENVELOPES, matchesAny } from './capability-envelope/policy';

/** Same tool this many times inside the window → the same-tool nudge is a candidate. Lowered 3→2
 *  (code-run-adoption directive 2026-06-29): the 2nd identical round-trip already IS the loop — by
 *  the 3rd the cheap calls are spent. Catch it at the earliest point the pattern is unambiguous. */
export const BATCH_NUDGE_THRESHOLD = 2;

/** This many DISTINCT (non-excluded) tools inside the window → the fan-out nudge is a candidate.
 *  Lowered 4→3 (2026-06-29): three different reads in one burst is already a Promise.all-able fan-out. */
export const FANOUT_DISTINCT_THRESHOLD = 3;

/** Sliding window over which recent calls are counted. Only a bursty flurry (the actually-batchable
 *  shape) trips a trigger; calls spread wider than this are treated as separate, deliberate steps. */
export const NUDGE_WINDOW_MS = 90_000;

/** Per-session cap on the recent-call ring (backstop against a long-lived session growing it). */
const MAX_RECENT_PER_SESSION = 64;

/** How many distinct tools the fan-out skeleton enumerates before it elides the rest. */
const MAX_SKELETON_TOOLS = 6;

/** Insertion-order cap on tracked sessions (backstop against unbounded growth). */
const MAX_TRACKED_SESSIONS = 4000;

/** Roles that hold code:run. As of the owner directive 2026-06-25, code:run is open to EVERY
 *  built-in role (run.ts `agentRoles: [...AGENT_ROLES]`), so the nudge audience is the full role
 *  universe — keep this in lockstep with code:run's gate. A superuser caller also qualifies
 *  (handled at the call site via isSuperuser). */
export const CODE_RUN_CAPABLE_ROLES: ReadonlySet<string> = new Set<string>([...AGENT_ROLES]);

/**
 * Can this caller ACT on a "use code:run" nudge? (code-run-self-state-adoption-2026-07-03 P-004.)
 * The old role-membership check alone was dishonest: overwatch/sentinel are envelope-DENIED
 * capability:bash (code:run's gate), so they were nudged — escalating banners included — toward a
 * tool every attempt at which would be refused. Role must be capable AND the role's envelope must
 * not deny the bash capability code:run requires. Superuser is handled by the caller.
 */
export function canRoleActOnCodeRun(role: string): boolean {
  if (!CODE_RUN_CAPABLE_ROLES.has(role)) return false;
  const deny = ROLE_ENVELOPES[role]?.denyCapabilities;
  return !deny || !matchesAny('capability:bash', deny);
}

/** Normalized names of the batch/reuse tools themselves — never nudge these (you don't tell a
 *  `code:run` call to "use code:run"), and never count them toward the fan-out tally. Normalization
 *  strips `:`/`_`/`-` so both the verb form (`code:run`) and the MCP form (`code_run`) match. */
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

/** One recorded call in the sliding window. */
interface RecentCall {
  tool: string;
  at: number;
}

interface SessionState {
  /** Chronological ring of recent calls, trimmed to NUDGE_WINDOW_MS and capped. */
  recent: RecentCall[];
  /** How many nudges have already fired this session (drives the exponential cooldown). */
  nudgeCount: number;
  /** Calls recorded since the last nudge fired (the cooldown is measured in calls). */
  callsSinceNudge: number;
  /** Whether any nudge has fired this session (the first one has no cooldown). */
  everNudged: boolean;
  /** ms timestamp of the last SUCCESSFUL coord:orient this session (orient-dedup, P-009). */
  lastOrientAt?: number;
  /** subsumed tools already orient-dedup-nudged this session (one-shot guard, P-009). */
  orientDedupNudged: Set<string>;
}

const sessions = new Map<string, SessionState>();

/** Get (or lazily create, with insertion-order eviction) the per-session tracking state. The ONE
 *  shared map both nudges read/write, so orient timing and the recent-call ring live together. */
function getOrCreateSession(sessionKey: string): SessionState {
  let st = sessions.get(sessionKey);
  if (!st) {
    if (sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    st = { recent: [], nudgeCount: 0, callsSinceNudge: 0, everNudged: false, orientDedupNudged: new Set() };
    sessions.set(sessionKey, st);
  }
  return st;
}

function normalize(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** `wake-queue` / `set_status` → `wakeQueue` / `setStatus` (the code:run facade's JS-identifier keys). */
function camelSegment(segment: string): string {
  return segment.replace(/[-_]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());
}

function camelVerb(verb: string): string {
  return camelSegment(verb);
}

/** Render a `tools.…` facade call for `toolName(<argExpr>)`. Prefers the typed `tools.ns.verb(arg)`
 *  form; falls back to the always-valid `tools.call('ns:verb', arg)` escape hatch when the name does
 *  not cleanly split into JS identifiers. `argExpr` is the literal argument source — e.g. the loop
 *  var `a`, or a fill-in placeholder comment for the fan-out skeleton. */
function facadeCall(toolName: string, argExpr: string): string {
  const ci = toolName.indexOf(':');
  if (ci > 0) {
    const ns = toolName.slice(0, ci);
    const verb = camelVerb(toolName.slice(ci + 1));
    const ident = /^[A-Za-z_$][\w$]*$/;
    const camelNs = camelSegment(ns);
    if (ident.test(camelNs) && ident.test(verb)) return `tools.${camelNs}.${verb}(${argExpr})`;
  }
  return `tools.call(${JSON.stringify(toolName)}, ${argExpr})`;
}

/** The same-tool list-then-loop skeleton: loop the ONE repeated call over a caller-supplied list. */
function sameToolSkeleton(toolName: string): string {
  return (
    'code:run { script: `\n' +
    `  const inputs = [/* the args for each ${toolName} call */];\n` +
    '  const out = [];\n' +
    `  for (const a of inputs) out.push(await ${facadeCall(toolName, 'a')});\n` +
    '  return out;\n' +
    '` }'
  );
}

/** The fan-out skeleton: a Promise.all over the EXACT distinct tools just seen, each a fill-in-args
 *  call. Acting on it is filling blanks, not authoring from scratch — the activation-energy win. */
function fanoutSkeleton(distinctTools: string[]): string {
  const shown = distinctTools.slice(0, MAX_SKELETON_TOOLS);
  const binds = shown.map((_t, i) => `r${i}`).join(', ');
  const lines = shown.map((t) => `    ${facadeCall(t, '/* args */')},`).join('\n');
  const elided = distinctTools.length > shown.length ? `    /* …and ${distinctTools.length - shown.length} more */\n` : '';
  return (
    'code:run { script: `\n' +
    `  const [${binds}] = await Promise.all([\n` +
    lines +
    '\n' +
    elided +
    '  ]);\n' +
    `  return { ${binds} };\n` +
    '` }'
  );
}

const TRAILER =
  `Only the script's return re-enters context, so return what you'll need next. Or reuse a recipe ` +
  `(recipes:search { query }). Keep a call separate ONLY when you must read its result and DECIDE ` +
  `before the next (a script can't pause for you to think).`;

/** How many calls must pass before the NEXT nudge may fire, given how many have already fired this
 *  session. Exponential backoff (4 → 8 → 16 → 32 → 64, capped) so ignoring a nudge once does not
 *  silence it forever, but a persistent waster is reminded ever more sparingly rather than spammed. */
function cooldownCalls(nudgesAlreadyFired: number): number {
  const BASE = 4;
  const CAP = 64;
  return Math.min(BASE * 2 ** Math.max(0, nudgesAlreadyFired - 1), CAP);
}

/** Escalation banner prepended to a nudge based on how many have ALREADY fired this session (code-run
 *  -adoption directive 2026-06-29). The cooldown makes repeats rarer; this makes the ones that DO fire
 *  progressively firmer — a caller still firing calls one at a time after several reminders needs a
 *  stronger push, not the same neutral tip. `n` is the post-increment nudgeCount (1 = first fire), so
 *  level 1 stays the original neutral message and only persistent wasters see the louder banners. */
function escalationPrefix(n: number): string {
  if (n <= 1) return '';
  if (n === 2) return '(2nd reminder this session) ';
  if (n === 3)
    return (
      '⚠️ 3rd reminder this session — you keep firing tool calls one at a time. Please bundle the rest ' +
      'of this burst into a single code:run. '
    );
  return (
    `🚨 ${n}× reminded this session — this is a persistent one-at-a-time pattern that is burning tokens. ` +
    'Default to code:run for these calls now; keep one separate ONLY if you must read its result and ' +
    'reason before the next. '
  );
}

export type BatchNudgeKind = 'same-tool' | 'fanout';

export interface BatchNudgeResult {
  /** The hint text to attach to the tool result (no `[batch-hint]` prefix — the call site adds it). */
  text: string;
  /** Which trigger fired — drives which feature flag gates it at the call site. */
  kind: BatchNudgeKind;
}

export interface BatchNudgeInput {
  /** Stable per-session key — the handler's replayOwnerKey (uiClientId ?? spawnId). */
  sessionKey: string;
  /** The tool just called (MCP or verb form). */
  toolName: string;
  /** Whether the caller can actually run code:run (canRoleActOnCodeRun(role) OR superuser). */
  canCodeRun: boolean;
  /**
   * Whether code:run is in the session's LIVE advertised tool surface (P-004). A seeded session
   * whose surface lacks it can still act — via tools:find activation or tools:invoke — but the
   * hint must TEACH that path instead of advising a tool the client can't call directly.
   * Default true (full-catalog sessions).
   */
  codeRunInSurface?: boolean;
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: number;
}

/** The activate-first path appended when code:run is not in the caller's live surface (P-004). */
const ACTIVATE_PATH_NOTE =
  `\nNote: code:run is not in your loaded tool list yet — activate it first with ` +
  `tools:find("code:run") (adds it to your surface), or run the same script without loading via ` +
  `tools:invoke { name: "code:run", args: { script } }.`;

/**
 * Record a tool call in the session's sliding window and, when a same-tool or fan-out burst is
 * detected (and the backoff cooldown has elapsed), return a nudge steering the caller to bundle the
 * calls into one `code:run`. Returns null otherwise. Never throws. Excluded/incapable callers
 * short-circuit to null with no state — they can never produce a useful nudge.
 */
export function maybeBatchNudge(input: BatchNudgeInput): BatchNudgeResult | null {
  const { sessionKey, toolName, canCodeRun } = input;
  if (!canCodeRun || !sessionKey || !toolName) return null;
  if (EXCLUDED_NORMALIZED.has(normalize(toolName))) return null;
  const now = input.now ?? Date.now();

  const st = getOrCreateSession(sessionKey);

  // Record this call, then trim the ring to the window + cap (the only common-path side effects).
  st.recent.push({ tool: toolName, at: now });
  st.callsSinceNudge += 1;
  const cutoff = now - NUDGE_WINDOW_MS;
  let drop = 0;
  while (drop < st.recent.length && st.recent[drop].at < cutoff) drop++;
  if (drop > 0) st.recent.splice(0, drop);
  if (st.recent.length > MAX_RECENT_PER_SESSION) {
    st.recent.splice(0, st.recent.length - MAX_RECENT_PER_SESSION);
  }

  // Window stats: same-tool count, distinct tools (first-seen order), total recent calls.
  let sameToolCount = 0;
  const seen = new Set<string>();
  const distinctOrder: string[] = [];
  for (const c of st.recent) {
    if (c.tool === toolName) sameToolCount++;
    if (!seen.has(c.tool)) {
      seen.add(c.tool);
      distinctOrder.push(c.tool);
    }
  }
  const totalRecent = st.recent.length;

  // Pick a trigger. Same-tool wins ties (its loop skeleton is the more precise fix).
  let kind: BatchNudgeKind | null = null;
  if (sameToolCount >= BATCH_NUDGE_THRESHOLD) kind = 'same-tool';
  else if (seen.size >= FANOUT_DISTINCT_THRESHOLD) kind = 'fanout';
  if (!kind) return null;

  // Backoff gate: the first nudge fires immediately; later ones wait out an exponential cooldown.
  if (st.everNudged && st.callsSinceNudge < cooldownCalls(st.nudgeCount)) return null;

  st.everNudged = true;
  st.nudgeCount += 1;
  st.callsSinceNudge = 0;

  const windowS = Math.round(NUDGE_WINDOW_MS / 1000);
  const banner = escalationPrefix(st.nudgeCount);
  const activate = input.codeRunInSurface === false ? ACTIVATE_PATH_NOTE : '';
  if (kind === 'same-tool') {
    const burst = totalRecent > sameToolCount ? ` (${totalRecent} tool calls total this burst)` : '';
    const text =
      `${banner}you've called "${toolName}" ${sameToolCount}× in the last ~${windowS}s${burst} — that's ` +
      `${sameToolCount} separate round-trips, each re-reading your whole context. If these are ` +
      `independent or mechanically-chained, fold them into ONE code:run loop — ready-to-paste skeleton ` +
      `(fill \`inputs\` with the per-call args):\n${sameToolSkeleton(toolName)}\n${TRAILER}${activate}`;
    return { text, kind };
  }
  // fan-out
  const text =
    `${banner}you've made ${totalRecent} individual tool calls across ${seen.size} different tools in the last ` +
    `~${windowS}s — that's ~${totalRecent} round-trips, each re-reading your whole context. This is an ` +
    `independent fan-out: collapse it into ONE code:run with Promise.all — ready-to-paste skeleton ` +
    `(fill the args):\n${fanoutSkeleton(distinctOrder)}\n${TRAILER}${activate}`;
  return { text, kind };
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
