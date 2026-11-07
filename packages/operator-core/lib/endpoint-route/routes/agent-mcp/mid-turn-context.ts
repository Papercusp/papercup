/**
 * POST /api/agent-mcp/mid-turn-context
 *
 * Plan: context-injection-audit-2026-07-28 (P-015, decision D-026).
 *
 * THE GAP THIS CLOSES. Recall used to be delivered at exactly one boundary —
 * UserPromptSubmit (turn-start-memory.ts, its sibling in this directory). A turn
 * that submits one prompt and then makes fifty tool calls therefore got ONE
 * injection and then nothing: the agent could spend twenty greps re-deriving a
 * fact that was already in memory, because no boundary after the prompt ever
 * asked. This endpoint is that missing boundary — the PostToolBatch hook
 * (posttoolbatch-midturn-context.sh) calls it after a batch of tool calls
 * resolves and injects what comes back as `additionalContext`.
 *
 * ⚠ POST-tool, not PRE-tool, and that is D-027 rather than an accident: firing
 * after the batch makes the tool RESULTS visible, so an empty/failed search — the
 * strongest "this agent is stuck and about to re-derive something" signal there
 * is — can be weighted in rather than guessed at. A PreToolUse variant of this
 * file existed briefly and was deleted; if you find yourself moving it back,
 * read D-027 first.
 *
 * WHY THIS IS A SIBLING AND NOT NEW MACHINERY. D-026 audited the Phase-7
 * matchers and ruled that their SELECTION logic is sound but their DELIVERY leg
 * targets the wrong boundary (the ambient-push rail delivers at WAKE, not per
 * tool call). The one rail that is live and carrying traffic today is the hook
 * `additionalContext` channel. So P-015 bridges onto THAT, reusing the same
 * admission pipeline turn-start already runs. No parallel matcher set, no second
 * dedup, no new transport.
 *
 * THE THREE THINGS THAT MAKE THIS CHEAP:
 *
 *  1. DEDUP IS FREE. `session.port` is free-text (injection.ts) and the epoch
 *     ledger is PORT-AGNOSTIC by D-006, so passing port 'mid-turn' inherits the
 *     existing guarantee: anything already surfaced this epoch by the initialize
 *     prelude, turn-start, an orient recall, or a claim port is never re-paid.
 *     A fifty-call turn cannot restate the same memory fifty times. This is why
 *     P-017 needs no dedup of its own — do NOT build a second one.
 *  2. THE BUDGET IS AN ORDER OF MAGNITUDE SMALLER than turn-start's. See
 *     MID_TURN_BUDGET_CHARS below; the arithmetic is in its comment.
 *  3. THE COST GUARDS below stop a burst of tool calls from each buying an embed,
 *     and the host-wide named-resource admission guard caps all operator workers
 *     together (EI-21270032782365521).
 *
 * Body: { owner, tool, toolInput, workspace?, harness? } — the hook passes
 * harness/workspace from its launch env so this endpoint does no session-registry
 * resolution on the hot path. The QUERY is derived here, server-side, from the
 * tool call: the hook stays a dumb transport (the property that made the
 * turn-start hook 76 lines and lets this logic be fixed without reinstalling a
 * script on every box).
 *
 * Fail-soft by contract, exactly like turn-start: every failure path returns
 * `{ ok: true, text: '' }`. A hook must never surface an error into a turn.
 * `auth: 'loopback'` — the hook runs on this box.
 */
import { defineTool } from '@papercusp/agent-mcp';
// Pure module, zero static imports of its own — see corpus-recall.ts. Imported
// statically (not dynamically like everything else in the handler) precisely
// because it drags nothing behind it, and because clampToBudget must stay a
// pure sync function its tests can call directly.
import { CORPUS_BLOCK_HEADING } from '../../../memory/corpus-recall';
import { recordInjectionCoverage, type InjectionDeliveryOutcome } from '../../../memory/injection-delivery-coverage';
import { takePendingFailureLoopHint, type FailureLoopHint } from '../../../failure-loop-circuit-breaker';
import { turnStartRespondBy } from './turn-start-memory';
import { createMemoryWorkDeadline } from '../../../memory/op-deadline';
import { randomUUID } from 'node:crypto';
import type { PreparedMemoryBlock, MemoryEmissionConfirmation } from '../../../memory/session-epoch-ledger';

/**
 * Query clamp — embed the head of a long command, not a pasted heredoc.
 * Exported so offline replays (memory/bench/jev-live-drop-quality.ts) rebuild
 * the exact query this handler sends, instead of keeping a second copy.
 */
export const QUERY_CLAMP = 1_000;

/**
 * The mid-turn budget (chars). DELIBERATELY an order of magnitude under
 * turn-start's 4000, and the reason is arithmetic rather than taste: this fires
 * per TOOL CALL, so a fifty-call turn at the turn-start budget would inject
 * ~200k chars — precisely the context bloat the owner warned against in the same
 * message that asked for mid-turn delivery. At this budget the same fifty-call
 * turn costs ~17k chars WORST case, and in practice far less because the epoch
 * dedup means most calls return empty.
 *
 * The shape this buys is a TEASER, not a briefing: a line or two plus enough
 * handle for the agent to go get the detail if it wants it. That is the correct
 * shape for an interruption — it must be cheap enough to ignore.
 *
 * ⚠ SCOPE (D-060 / WI-6857): this bounds the MEM0 HALF ONLY. The P-008 corpus
 * pointer section carries its own CORPUS_BUDGET_CHARS (corpus-recall.ts) and is
 * NOT re-clamped here — see clampToBudget for why. So the arithmetic above is
 * no longer the whole cost: a recall that carries a full pointer section costs
 * ~2.2k chars, not ~350. The bound that matters is MAX_PER_MIN below (recalls,
 * not tool calls), which caps this channel at ~26k chars/min worst case — and
 * far less in practice, because the per-epoch surfaced-refs ledger means a
 * pointer is delivered ONCE, not on every batch that would rank it.
 */
const MID_TURN_BUDGET_CHARS = (() => {
  const raw = Number(process.env.PAPERCUSP_MID_TURN_BUDGET_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : 350;
})();

/**
 * Inner cost ceiling: max recalls per session per rolling minute. The epoch ledger
 * dedups what we SHOW but not what we SPEND — every call is still an embed plus
 * a pgvector query. This process-local guard caps one session without ever
 * delaying the FIRST call of a burst, which is the one that matters (the
 * acceptance case is "fires early, on the first grep for the symptom" — a
 * time-based floor would have suppressed exactly that). The outer
 * `withMidTurnMemoryAdmission` semaphore below is what bounds all SO_REUSEPORT
 * workers together; neither guard is a substitute for the other.
 */
const MAX_PER_MIN = (() => {
  const raw = Number(process.env.PAPERCUSP_MID_TURN_MAX_PER_MIN);
  return Number.isFinite(raw) && raw > 0 ? raw : 12;
})();

const RATE_WINDOW_MS = 60_000;

/**
 * In-process only, and that is correct for this INNER per-session limiter.
 * Losing it on restart costs at most a few extra embeds. Cross-process capacity
 * is a different invariant and is enforced by the existing named-resource
 * store immediately around the optional recall build. Keyed by session owner.
 */
const recentCalls = new Map<string, { at: number[]; lastQuery: string }>();

/** Keep the map from growing without bound across a long-lived operator. */
function pruneRateState(now: number): void {
  if (recentCalls.size < 512) return;
  for (const [key, state] of recentCalls) {
    if (state.at.every((t) => now - t > RATE_WINDOW_MS)) recentCalls.delete(key);
  }
}

/**
 * Returns false when this call should be skipped WITHOUT doing any work.
 * Two guards, in order of cheapness:
 *   - identical consecutive query ⇒ nothing can have changed, skip for free.
 *     (`ls` then `ls` then `ls`, or a retry loop on one failing command.)
 *   - more than MAX_PER_MIN recalls in the trailing minute ⇒ over the ceiling.
 */
type MidTurnCallAdmission = 'admitted' | 'duplicate-query' | 'rate-limit';

function admitCall(owner: string, query: string, now: number): MidTurnCallAdmission {
  const state = recentCalls.get(owner);
  if (!state) {
    recentCalls.set(owner, { at: [now], lastQuery: query });
    return 'admitted';
  }
  if (state.lastQuery === query) return 'duplicate-query';
  const fresh = state.at.filter((t) => now - t <= RATE_WINDOW_MS);
  if (fresh.length >= MAX_PER_MIN) {
    state.at = fresh;
    return 'rate-limit';
  }
  fresh.push(now);
  state.at = fresh;
  state.lastQuery = query;
  return 'admitted';
}

function suppressionOutcomeForAdmissionReason(reason: string): InjectionDeliveryOutcome {
  switch (reason) {
    case 'identity_unreadable': return 'suppressed-identity-unreadable';
    case 'admission_unavailable': return 'suppressed-admission-unavailable';
    case 'at_capacity': return 'suppressed-admission-capacity';
    case 'local_in_flight': return 'suppressed-admission-local-in-flight';
    default: return 'suppressed-admission-other';
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Why a derive can miss, and which of the two kinds it was. The distinction is
 * the whole point (plan `codex-context-injection-parity-2026-08-09`, D-005 §3b):
 * a caller that only learns "no query" cannot tell a vocabulary gap from a tool
 * that genuinely carried no signal, and those need opposite responses.
 */
export type DeriveMiss = 'unknown-tool' | 'no-signal';

export interface DerivedQuery {
  /** The recall query. Empty exactly when `miss` is non-null. */
  query: string;
  /** null = a real signal was derived. */
  miss: DeriveMiss | null;
  /**
   * The tool the miss is ABOUT, when that is not the tool that was called.
   * `tools:invoke` and OMP XD-device writes produce this: both dispatch, so an
   * unmapped INNER tool must be reported under the inner name or the drift alarm
   * names a dispatcher that is perfectly well mapped and points nobody at the
   * real gap (WI-37589 / P-014).
   */
  missTool?: string;
}

/** The tool_input as an object, or null — a JSON string is parsed, anything else rejected. */
function asRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
}

type ToolQuerySpec = {
  /** Argument field names, in the order they contribute to the query. */
  readonly fields: readonly string[];
  /**
   * Separator between field values. ⚠ PER-TOOL CONTRACT, NOT STYLE. Claude's
   * `Bash` has always joined command+description with an em-dash and the
   * pattern/path tools with a space; those strings are embedded, so changing a
   * separator changes retrieval. D-003 proved claude equivalence across the
   * seam cut-over — these preserve it exactly.
   */
  readonly join?: string;
  /**
   * `tool_input` is a raw non-JSON string rather than a JSON object. Codex's
   * `apply_patch` / `exec` arrive as `custom_tool_call` with a freeform `input`
   * (a patch body beginning `*** Begin Patch\n*** Update File: <path>`), which
   * is dense recall signal but will never parse as JSON.
   */
  readonly freeform?: boolean;
};

/**
 * THE SHARED TOOL VOCABULARY — ONE registry, every client, no per-client fork.
 *
 * D-001 invariant 6: this endpoint is client-agnostic BY CONTRACT. That is why
 * this is a flat tool→fields map and NOT a switch on `client`: tool names are
 * globally distinct across the three TUIs, so one lookup serves all of them and
 * there is no client branch to drift.
 *
 * ── WHY THIS EXISTS (D-005) ──
 * This map used to be a `switch` over Claude's four PascalCase tool names with
 * `default: return ''`. Because the handler drops an empty derive BEFORE both
 * the recall and the stats write, mid-turn context was not merely degraded for
 * codex and omp — it was STRUCTURALLY IMPOSSIBLE, and not even recorded as a
 * miss. Widening the vocabulary fixes today's clients; `DeriveMiss` (above) is
 * what stops the next vocabulary drift from being silent again.
 *
 * ── PROVENANCE: MEASURED, NOT GUESSED ──
 * Every name below was read off real sessions, never inferred from Claude's
 * shape (the plan's standing rule — P-003 "no speculative event names").
 *   • codex — 4,131 `function_call` / `custom_tool_call` records across 61
 *     rollouts in ~/.codex/sessions: exec_command 3034 (cmd/workdir/
 *     justification), write_stdin 539, apply_patch 336 (freeform), exec 145
 *     (freeform), view_image 47 (path), wait 24, update_plan 3.
 *   • codex GOAL EXTENSION (`get_goal` / `update_goal` / `create_goal`) —
 *     measured 2026-08-09 from the SHIPPED BINARY, not from rollouts, because
 *     rollouts cannot supply them: they postdate the census above and appear
 *     ZERO times in all 61. `get_goal` was nonetheless observed live twice
 *     (context_injection_coverage, client=codex port=mid-turn
 *     outcome='unknown-tool'), which is what surfaced the drift.
 *     Source: codex-cli 0.146.0, `codex-linux-x64/.../bin/codex`, serde
 *     struct/field strings + the tool-parameter descriptions —
 *     `struct UpdateGoalArgs with 1 element` (`status`, and the binary's own
 *     prose is exclusively `update_goal` with status "complete"/"blocked");
 *     `struct CreateGoalRequest with 2 elements` (`objective` — "Required. The
 *     concrete objective to start pursuing" — and `token_budget`); `get_goal`
 *     documented as a pure read ("Get the current goal for this thread...").
 *     ⚠ Read the BINARY, not a rollout, when adding a codex tool: a rollout
 *     shows only what a model happened to call, whereas the binary IS the
 *     schema. Grepping rollouts for these names DOES hit two files, but both
 *     hits are inside `custom_tool_call_output` TEXT (a script that printed
 *     codex's tool list) — not calls. That false positive is what made an
 *     earlier draft of this entry map `update_goal` to a nonexistent free-text
 *     field; see the omissions below.
 *   • omp — tool-call records in ~/.omp: read 1771, grep 443, find 402,
 *     bash 181 (command), edit 168, search 116, write 68, ast_grep 14, glob 4;
 *     field names confirmed against the shipped schemas in
 *     @oh-my-pi/pi-coding-agent/src/{tools,commands}.
 *   • claude — Bash/Grep/Glob/Read were byte-identical across the D-003 seam
 *     cut-over. WIDENED 2026-08-09 (WI-37587) with Edit/Write/ToolSearch/
 *     WebSearch/WebFetch, every field name read off the live tool schemas.
 *     Measured from context_injection_coverage on the day: 957 claude NATIVE
 *     calls/day were deriving nothing — Edit 581, ToolSearch 256, Write 69,
 *     AskUserQuestion 24, WebSearch 9, Artifact 5, WebFetch 3, TaskCreate 3,
 *     Monitor 3, TaskUpdate 2, Skill 1, TaskStop 1.
 *     ⚠ THE LESSON THAT FOUND THIS: the drift detector had only ever been
 *     pointed at codex. Pointed at EVERY client it reported claude — ~100% of
 *     traffic — as the biggest gap by three orders of magnitude (3,381
 *     unknown-tool calls vs codex's 3). An alarm whose output is ~100% noise
 *     is functionally OFF: the real codex signal (n=2) was findable only by
 *     filtering to client='codex'. Query the detector across ALL clients
 *     before concluding a client is fine.
 *
 * ── DELIBERATE OMISSIONS (absence here is a decision, not an oversight) ──
 *   • codex `write_stdin` (539 calls): `chars` is raw stdin typed at an
 *     interactive process — routinely passwords and tokens. The derived query
 *     is EMBEDDED and (flag permitting) persisted to memory_recall_query_text,
 *     so admitting it would copy credentials into a second place for weak
 *     signal. `detectPossibleSecrets` guards the text table but not the embed.
 *   • codex `wait` / `list_mcp_resources`, omp `yield` / `submit_result` /
 *     `report_finding` / `irc`: no investigation signal to carry.
 *   • claude `Edit` / `Write` map `file_path` ONLY. `old_string`, `new_string`
 *     and `content` are FILE BODIES — unbounded, and credential-bearing on the
 *     same argument as `write_stdin` above. `file_path` alone mirrors `Read`.
 *   • claude `AskUserQuestion` / `Artifact` / `Skill` / `Monitor` /
 *     `TaskCreate` / `TaskUpdate` / `TaskStop`: considered and judged to carry
 *     no INVESTIGATION signal — they address the human or manage bookkeeping
 *     rather than interrogating the codebase.
 *   • codex `get_goal`: a pure read that takes NO arguments at all.
 *   • codex `update_goal`: its ONLY argument is `status`, a closed enum whose
 *     admissible values are "complete" and "blocked". Embedding the word
 *     "complete" as a recall query is retrieval NOISE, not signal — it matches
 *     on a token that carries no topic. Mapping it to `status` would be worse
 *     than leaving it here, and mapping it to a free-text field it does not
 *     have would be worse still: a wrong field name derives '' and classifies
 *     'no-signal', which is INDISTINGUISHABLE from this deliberate omission —
 *     i.e. a guessed mapping silently converts a working drift alarm into
 *     permanent quiet. That asymmetry is why an unmeasured tool must be left
 *     unmapped (loudly 'unknown-tool') rather than mapped on a guess.
 * These are known tools with no fields, so they classify as 'no-signal' rather
 * than 'unknown-tool' — the alarm must not read a deliberate omission as drift.
 */
import { TOOL_QUERY_VOCABULARY, PAPERCUSP_TOOL_VOCABULARY, TOOLS_INVOKE, MANGLED_TO_COLON, specFor, colonNameFor, extractRecallSignals, readRecallSignals, combineRecallSignals } from '../../../../../../apps/operator/scripts/hooks/inject/recall-query.mjs';
export { TOOL_QUERY_VOCABULARY, PAPERCUSP_TOOL_VOCABULARY };

/**
 * OMP exposes an MCP dynamic-device call as a native `write` to an `xd://`
 * path. Unlike an ordinary file write, its `content` is a JSON argument
 * envelope and the path names the actual tool. Keeping the outer write shape
 * turns every such call into the generic device path as a recall query (D-012).
 *
 * The Papercusp XD spelling is flattened —
 * `xd://mcp__papercusp_su_tools_invoke`, not the usual
 * `mcp__papercusp-su__tools_invoke` — so it cannot use `specFor`'s standard
 * server separator. Resolve the suffix FORWARD through the existing vocabulary
 * instead of guessing where underscores belong. Unknown suffixes stay loud.
 *
 * `content` is accepted only when it decodes to an object. A truncated or
 * malformed body becomes an empty argument object, never raw query text. That
 * preserves the body/secret boundary: the resolved inner tool's allow-list is
 * still the only thing that can admit fields into the embedder.
 */
const OMP_XD_MCP_PREFIX = 'xd://mcp__';
const OMP_XD_PAPERCUSP_PREFIX = `${OMP_XD_MCP_PREFIX}papercusp_su_`;
const MAX_QUERY_DERIVE_DEPTH = 4;

type NormalizedXdCall = {
  tool: string;
  input: Record<string, unknown>;
};

function normalizeOmpXdCall(tool: string, input: unknown): NormalizedXdCall | null {
  if (tool !== 'write') return null;
  const outer = asRecord(input);
  if (!outer) {
    // The OMP hook clamps the WHOLE outer argument JSON at 400 chars. If that
    // cut lands inside `content`, JSON.parse fails; falling through to the
    // generic known-tool fallback would then embed the raw truncated blob.
    // Recognise only the explicit path field and fail closed.
    return typeof input === 'string' && /"path"\s*:\s*"xd:\/\/mcp__/.test(input)
      ? { tool: TOOLS_INVOKE, input: {} }
      : null;
  }
  const path = str(outer.path);
  if (!path.startsWith(OMP_XD_MCP_PREFIX)) return null;

  const deviceName = path.slice('xd://'.length);
  const mangled = path.startsWith(OMP_XD_PAPERCUSP_PREFIX) ? path.slice(OMP_XD_PAPERCUSP_PREFIX.length) : '';
  return {
    tool: (mangled && MANGLED_TO_COLON.get(mangled)) || deviceName,
    input: asRecord(outer.content) ?? {},
  };
}

/**
 * Derive the recall query from the tool call, and say WHY when there is none.
 *
 * The tools worth reading are the ones that signal INVESTIGATION — a command, a
 * search pattern, a path — because those are the moments where an agent is
 * about to re-derive something it may already know. A tool we have no sensible
 * reading for yields '' and the call is dropped before any embed (see the
 * handler), which is why an unknown tool costs nothing rather than embedding a
 * blob of JSON.
 */
export function deriveQueryDetailed(tool: string, input: unknown): DerivedQuery {
  return deriveQueryAtDepth(tool, input, 0);
}

function deriveQueryAtDepth(tool: string, input: unknown, depth: number): DerivedQuery {
  const xdCall = normalizeOmpXdCall(tool, input);
  if (xdCall) {
    if (depth >= MAX_QUERY_DERIVE_DEPTH) return { query: '', miss: 'no-signal' };
    const inner = deriveQueryAtDepth(xdCall.tool, xdCall.input, depth + 1);
    return inner.miss === 'unknown-tool' && !inner.missTool ? { ...inner, missTool: xdCall.tool } : inner;
  }

  const spec = specFor(tool);
  // Not in the vocabulary at all. Either a client we have not mapped or a new
  // tool on one we have — the case that must stay VISIBLE, because it is the
  // one that silently zeroed codex and omp for the life of this endpoint.
  if (!spec) return { query: '', miss: 'unknown-tool' };

  const done = (text: string): DerivedQuery => (text ? { query: text, miss: null } : { query: '', miss: 'no-signal' });

  // ── `tools:invoke` DISPATCHES: the signal is the INNER call, never its own args ──
  // Measured 2026-08-09 it is the single biggest miss in the whole vocabulary
  // (423 calls/day, 17% of the MCP namespace), and its own two arguments are
  // `name` + `args`. Reading THOSE would embed the literal string
  // "dev:pg_query" plus a JSON blob — so the only correct reading is to ask the
  // inner tool's own entry, which is why this recurses rather than listing
  // fields. An inner tool we do not know stays 'unknown-tool' and is reported
  // UNDER ITS OWN NAME (`missTool`), because "tools:invoke is unmapped" would
  // be both false and un-actionable.
  if (colonNameFor(tool) === TOOLS_INVOKE) {
    const io = asRecord(input);
    if (!io) return { query: '', miss: 'no-signal' };
    const innerName = str(io.name);
    if (!innerName) return { query: '', miss: 'no-signal' };
    // A dispatch through a dispatch is not a shape this system produces; treat
    // it as no-signal rather than recursing, so a malformed or hostile payload
    // cannot drive unbounded recursion on a path that must never cost a turn.
    if (colonNameFor(innerName) === TOOLS_INVOKE) return { query: '', miss: 'no-signal' };
    if (depth >= MAX_QUERY_DERIVE_DEPTH) return { query: '', miss: 'no-signal' };
    const inner = deriveQueryAtDepth(innerName, io.args, depth + 1);
    return inner.miss === 'unknown-tool' ? { ...inner, missTool: innerName } : inner;
  }

  // Native freeform calls have a separate wire contract. Object-based tools
  // must supply a complete object: a truncated envelope is transport debris,
  // never a fallback semantic query. The same parser guards nested dispatch.
  if (spec.freeform) return done(str(input).trim());
  const io = asRecord(input);
  if (!io) return done('');

  const parts: string[] = [];
  for (const field of spec.fields) {
    const value = str(io[field]);
    if (value) parts.push(value);
  }
  return done(parts.join(spec.join ?? ' '));
}

/** String-only view of {@link deriveQueryDetailed}, for callers that only need
 *  the query. '' means "no signal", whatever the reason. */
export function deriveQuery(tool: string, input: unknown): string {
  return deriveQueryDetailed(tool, input).query;
}

/**
 * Enforce the mid-turn budget HERE, at the endpoint. This is not belt-and-braces:
 * `buildMemoryContextBlock` does NOT enforce `budgetChars` for the first row.
 * Its `admit()` reads
 *
 *     if (spent + line.length > budget && lines.length > 0) return false;
 *
 * — the `&& lines.length > 0` deliberately lets the FIRST row through whole,
 * whatever its size, so that a caller with a small budget gets *something* rather
 * than null. Correct for turn-start (4000 chars, one injection per turn). NOT
 * correct here: measured against the P-018 acceptance case, the top-ranked record
 * is ~3,700 chars — over 10x this endpoint's 350 — and this fires per tool BATCH,
 * so the docstring arithmetic above ("~17k worst case for fifty calls") would have
 * been wrong by an order of magnitude in exactly the direction the owner warned
 * about. The epoch dedup bounds the REPEAT of one record, not the size of fifty
 * distinct ones.
 *
 * Fixing it in injection.ts was not an option: that file is the P-041 retrieval
 * baseline and is gated by D-022, and every other caller depends on the
 * always-emit-one-row behavior. So the clamp lives at the one call site whose
 * contract is a TEASER.
 *
 * The clamp keeps the head, which is where the value is: the block opens with the
 * heading, then `- [scope] (id=…) <the memory's first sentence>`. So a clipped
 * teaser still carries the scope, the id (the handle for `memory:search`), and the
 * lede — which is the entire intended shape of an interruption cheap enough to
 * ignore.
 */
export function clampToBudget(block: string, budget: number = MID_TURN_BUDGET_CHARS): string {
  if (!block) return '';
  // WI-6857 CUT 2. The clamp is a REPAIR for an UNENFORCED budget, not a policy
  // — so it must apply to the leg whose budget is unenforced, and only that one.
  // `composeWithCorpus` (injection.ts) appends the P-008 corpus excerpt section
  // AFTER the mem0 block, so a whole-block clamp at 350 deleted that section on
  // EVERY call: measured 21/21 live calls returning 398-403 chars, which is this
  // budget plus the suffix below, never the excerpts. The corpus leg has no
  // first-row exemption (WI-6870 removed it) and enforces CORPUS_BUDGET_CHARS
  // strictly, so it arrives already bounded and a second clamp here would only
  // re-truncate a section that is already the right size — and truncate it
  // mid-line, leaving evidence that reads as a complete claim but is incomplete.
  const at = block.lastIndexOf(`\n\n### ${CORPUS_BLOCK_HEADING}`);
  if (at >= 0) return `${clampSection(block.slice(0, at), budget)}${block.slice(at)}`;
  // Corpus-only block (the mem0 leg had nothing — P-008's motivating case, so it
  // must not be clamped away either): composeWithCorpus renders it at `##`.
  if (block.startsWith(`## ${CORPUS_BLOCK_HEADING}`)) return block;
  return clampSection(block, budget);
}

/**
 * The failure intervention and the worn post-tool rules each have their own
 * bounded budget and must survive every memory-recall early return. Keep
 * composition here, at the shared delivery seam, rather than teaching the
 * memory pipeline about failure-loop state or identity rules.
 */
export function composeMidTurnContextText(memoryBlock: string, failureHint: string, ruleContext: string, codeIntel = ''): string {
  const parts = [failureHint.trim(), ruleContext.trim(), codeIntel.trim(), clampToBudget(memoryBlock).trim()].filter(Boolean);
  return parts.join('\n\n');
}

/** The post-tool rule sink's share of the port's 1.5s hook wall. */
const POST_TOOL_RULE_BUDGET_MS = 1000;

/**
 * The wearer's `post-tool` sync rules due for this batch (portable-identity-
 * packages P-011, D-023): the one context sink whose client hook is this port.
 * Their budget is the sink evaluator's aggregate one, charged to the durable
 * hook turn, so it is not clamped again here. The wall covers the wearer and
 * worn-rule reads as well as the evaluation, because `respond` waits on this and
 * a slow read must not cost the batch its recall too. Never throws.
 */
/**
 * The request's harness: the declared `harness`, else the one detected from the
 * hook's `cwd` (EI-18893248175645463: an operator/superuser-scope session never
 * exports PAPERCUSP_HARNESS_SLUG, so its hook sends harness ''). Resolved once per
 * request and shared by the code-intel push and the recall (WI-6554700010018438).
 * Never throws: an undetectable harness is '' (a bare-session pull, no snapshot).
 */
export async function resolveMidTurnHarness(body: { harness?: unknown; cwd?: unknown }): Promise<string> {
  const declared = typeof body.harness === 'string' ? body.harness.trim() : '';
  if (declared) return declared;
  if (typeof body.cwd !== 'string' || !body.cwd.trim()) return '';
  try {
    const { detectHarnessSlugSync } = await import('../../../memory/detect-harness-slug');
    return detectHarnessSlugSync({ cwd: body.cwd.trim() }).slug ?? '';
  } catch {
    return '';
  }
}

async function postToolRuleContextText(ownerId: string, workspace: Promise<string>, tools: string[]): Promise<string> {
  if (tools.length === 0) return '';
  try {
    const [{ evaluateHookContextSink }, { withBoundedTimeout }, workspaceId] = await Promise.all([
      import('../../../agent-identities/sync-hook-rules'),
      import('../../../bounded-timeout'),
      workspace,
    ]);
    const bounded = await withBoundedTimeout(
      (signal) => evaluateHookContextSink({
        ownerId, workspaceId, sink: 'post-tool', tools, signal, engineeringOnly: true,
      }),
      { fallback: { text: '', result: null }, timeoutMs: POST_TOOL_RULE_BUDGET_MS, label: 'mid-turn:post-tool-rules' },
    );
    return bounded.value.text;
  } catch {
    return '';
  }
}

async function resolveFailureLoopHintText(hint: FailureLoopHint): Promise<string> {
  try {
    // Lazy by design: ordinary PostToolBatch requests never load the insight
    // reader, recipe search, or DB path.
    const { buildFailureLoopHintText } = await import('../../../failure-loop-hints');
    return await buildFailureLoopHintText(hint);
  } catch {
    return '';
  }
}

/** The char clamp itself, applied to ONE section. PURE. */
function clampSection(section: string, budget: number): string {
  if (section.length <= budget) return section;
  const cut = section.slice(0, budget);
  // Prefer a word boundary, but never sacrifice most of the budget to find one.
  const lastSpace = cut.lastIndexOf(' ');
  const head = lastSpace > budget * 0.6 ? cut.slice(0, lastSpace) : cut;
  // Principals calling this shared endpoint can have different tool grants.
  // Keep the stable id, but do not prescribe memory:search to callers that
  // may not be allowed to invoke it.
  return `${head.trimEnd()} … (clipped; id retained)`;
}

/** One tool call as the PostToolBatch hook ships it (clamped, see the script). */
export interface BatchCall {
  tool?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  querySignals?: unknown;
  editedPaths?: string[];
  interfaceEdits?: unknown[];
}

/**
 * Fold a resolved batch into ONE recall query.
 *
 * Two things make a batch a better signal than a single pre-dispatch call, and
 * both come from firing AFTER the tools ran (D-027):
 *   - the RESULTS are visible, so an empty/failed search — the strongest "this
 *     agent is stuck and about to re-derive something" signal there is — can be
 *     weighted in rather than guessed at;
 *   - several calls in one batch describe the agent's actual line of enquiry
 *     better than any one of them alone.
 * Later calls come first: the batch's tail is the freshest intent.
 */
export interface DerivedBatch {
  query: string;
  /** Tool names absent from TOOL_QUERY_VOCABULARY — the drift signal. */
  unknownTools: readonly string[];
  /** Known tools that carried no signal — expected quiet, NOT drift. */
  noSignalTools: readonly string[];
}

export function deriveBatchQueryDetailed(calls: BatchCall[]): DerivedBatch {
  const parts: string[] = [];
  const unknown = new Set<string>();
  const noSignal = new Set<string>();
  for (const call of [...calls].reverse()) {
    const tool = (call.tool ?? '').trim();
    const { query: q, miss, missTool } = deriveQueryDetailed(tool, call.toolInput);
    // `missTool` names the INNER tool of a `tools:invoke` dispatch. Reporting
    // the dispatcher instead would put a mapped tool in the drift list and
    // point nobody at the tool that is actually unmapped (WI-37589).
    if (miss === 'unknown-tool') unknown.add(missTool || tool || '(empty)');
    else if (miss === 'no-signal') noSignal.add(tool);
    if (!q) continue;
    const response = str(call.toolResponse);
    // An empty-looking result is signal, not noise — say so in the query.
    const barren = !response || /no matches|not found|no files found|^\s*$/i.test(response);
    parts.push(barren ? `${q} (no result)` : q);
  }
  return {
    query: parts.join(' · '),
    unknownTools: [...unknown],
    noSignalTools: [...noSignal],
  };
}

/** String-only view, for callers that only need the query. */
export function deriveBatchQuery(calls: BatchCall[]): string {
  return deriveBatchQueryDetailed(calls).query;
}

/** Production query: normalized before transport loss, never reconstructed from a clipped blob. */
export function deriveGroundedBatch(calls: BatchCall[]) {
  const unknown = new Set<string>();
  const quiet = new Set<string>();
  const signals = [...calls].reverse().map(call => {
    const tool = (call.tool ?? '').trim();
    const { miss, missTool } = deriveQueryDetailed(tool, call.toolInput);
    if (miss === 'unknown-tool') unknown.add(missTool || tool || '(empty)');
    const signal = miss === 'unknown-tool' ? extractRecallSignals('', null)
      : call.querySignals === undefined ? extractRecallSignals(tool, call.toolInput, call.toolResponse)
        : readRecallSignals(call.querySignals) ?? extractRecallSignals('', null);
    if (!signal.lexical && miss !== 'unknown-tool') quiet.add(tool);
    return signal;
  });
  return { ...combineRecallSignals(signals), unknownTools: [...unknown], noSignalTools: [...quiet] };
}

/**
 * The SINGLE-call form (a direct caller / probe — the hook sends a batch),
 * lifted into the batch shape so the handler has ONE coverage code path
 * instead of two that can drift apart.
 */
function singleCallDetail(tool: string, input: unknown): DerivedBatch {
  const { query, miss, missTool } = deriveQueryDetailed(tool, input);
  return {
    query,
    // An empty tool name still has to be countable, or the most likely
    // malformed-payload case is the one that stays invisible. `missTool` is the
    // `tools:invoke` inner-name case — see deriveBatchQueryDetailed.
    unknownTools: miss === 'unknown-tool' ? [missTool || tool || '(empty)'] : [],
    noSignalTools: miss === 'no-signal' ? [tool] : [],
  };
}

/**
 * A path-shaped token, for removal from the COSINE query only.
 *
 * Two shapes, and the second condition is what keeps it honest: ≥2 slashes
 * (`apps/operator-vite/src`, `/home/x/y`), OR exactly one slash plus a file
 * extension (`memory/injection.ts`). A single-slash token with no extension is
 * LEFT ALONE, because that is where the false positives live — `and/or`,
 * `input/output`, `24/7` are prose an agent really does type into a Grep
 * pattern or a Bash description, and stripping them would delete meaning from
 * the very query this is protecting.
 *
 * ⚠ THE DELIMITER CLASSES ARE SHELL-SHAPED, NOT WHITESPACE (WI-37403). The
 * boundaries used to be `(?:^|\s)` … `(?=\s|$)`, which is right for prose and
 * wrong for the dominant input on this port: a Bash `tool_input`, where paths
 * sit against punctuation constantly — `$(readlink -f /a/b/c);`, `"/a/b/c"`,
 * `grep -n x pkg/lib/f.ts|head`, `2>/dev/null`. A whitespace-only boundary
 * fails to match every one of those, so the path stayed in the cosine query and
 * pulled the vector exactly as D-041 describes.
 *
 * MEASURED (2026-08-09, replayed against real commands from the session that
 * found this): `B=$(readlink -f /home/linuxbrew/.linuxbrew/bin/codex); echo bin`
 * was NOT stripped, and that call injected two memories whose only relationship
 * to the task was the token `linuxbrew` — one about a Mac VM's bash version, one
 * about dev-launcher PATH exports, while the agent was enumerating codex hook
 * events. Same shape observed for `maxdepth` and `readlink /proc`.
 *
 * Lookbehind/lookahead (not consumption) so the delimiter itself survives the
 * replace; the token shape above is UNCHANGED, so every false-positive guard it
 * encodes still holds — `and/or`, `24/7`, `input/output`, `a b/c thing` are all
 * verified unchanged by this widening.
 */
const COSINE_PATH_TOKEN_RE =
  /(?<=^|[\s"'`(=,;:|&<>])(?:~?\/?(?:[\w.@*[\]-]+\/){2,}[\w.@*[\]-]*|[\w.@*[\]-]+\/[\w.@*[\]-]*\.[A-Za-z][\w]{0,5})(?=[\s"'`),;:|&\]]|$)/g;

/**
 * Split the derived text into the two per-leg queries (P-044 / F-L, motivated by
 * D-041's live measurement).
 *
 * The derived text is the LEXICAL leg's query unchanged — that leg is
 * token-matching and embed-free, and identifiers are precisely what it is for,
 * so this endpoint's lexical input is byte-identical to what it has always sent.
 * What changes is the COSINE query: it loses the path tokens.
 *
 * WHY, measured rather than assumed (D-041): replaying the WI-6512
 * investigation, batch one carried `apps/operator-vite/src` TWICE plus a full
 * component path against four content words, and the record that answered the
 * question was retrievable only by a query naming its literal id. The cosine leg
 * embeds its query as ONE vector, so those tokens were not inert padding — they
 * were pulling the vector toward "files under apps/operator-vite" and away from
 * the problem the agent was actually stuck on.
 *
 * ⚠ THE FALLBACK IS LOAD-BEARING, not defensive garnish. A batch of nothing but
 * `Read` calls strips to the empty string, and `buildMemoryContextBlock` gates
 * on the COSINE text being non-empty — so returning '' there would silently
 * disable mid-turn recall for every path-only batch, a much larger regression
 * than the dilution this fixes. When there is no prose to protect, there is also
 * nothing to dilute, so keeping the full text costs nothing.
 */
export function splitLegQueries(derived: string): { cosine: string; lexical: string } {
  const lexical = derived;
  const stripped = derived.replace(COSINE_PATH_TOKEN_RE, ' ').replace(/\s+/g, ' ').trim();
  // Then sweep the DEBRIS the strip leaves behind, per segment (WI-6857).
  //
  // The strip is per-token, so a call whose whole query was a path collapses to
  // nothing — but `deriveBatchQuery`'s ` · ` separators stay, and so does the
  // `(no result)` marker it appends to a barren call. Measured on the WI-6512
  // replay's batch 63: the emitted cosine query was
  // `session history (no result) · · agents running`, ~28% of it residue. This
  // function ALREADY judged both to be non-prose — `hasWords` discounted them
  // when deciding whether to fall back — and then embedded them anyway.
  //
  // The lexical leg keeps both: `(no result)` is real signal (D-027) and that
  // leg token-matches, so a marker costs it nothing. It is only in the COSINE
  // leg, where the whole query becomes ONE vector, that a bare separator and
  // the generic tokens "no"/"result" are pull without meaning.
  const cosine = stripped
    .split('·')
    .map((seg) =>
      seg
        .replace(/\(no result\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((seg) => /[A-Za-z0-9]/.test(seg))
    .join(' · ');
  return { cosine: cosine || lexical, lexical };
}

const midTurnContext = defineTool({
  method: 'POST',
  path: '/agent-mcp/mid-turn-context',
  auth: 'loopback',
  async handler(req) {
    const arrivedAt = Date.now();
    let body: {
      owner?: string;
      /** Private detector key carried separately from the public injection owner. */
      detectorSessionKey?: string;
      toolCalls?: BatchCall[];
      // Single-call form, kept for a direct caller / probe. The hook sends a batch.
      tool?: string;
      toolInput?: unknown;
      querySignals?: unknown;
      workspace?: string;
      harness?: string;
      cwd?: string;
      /** Which TUI is asking — 'claude' | 'codex' | 'omp'. Recorded only (P-005). */
      client?: string;
      /** Native hook response wall, shared with both retrieval legs. */
      wallMs?: number;
      /** Only a native hook with a writable stdout receipt ledger opts in. */
      memoryReceiptMode?: boolean;
      confirmedMemoryDeliveries?: MemoryEmissionConfirmation[];
      /** Bounded, caller-measured P-018 attribution; never inferred here. */
      incidentAttribution?: import('../../../code-intelligence/push-channel').IncidentAttribution;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      void recordInjectionCoverage([{ port: 'mid-turn', outcome: 'suppressed-invalid-json' }]);
      return Response.json({ ok: true, text: '' });
    }
    const owner = (body.owner ?? '').trim();
    if (!owner) return Response.json({ ok: false, error: 'owner required' }, { status: 400 });
    const { sessionAllowsAmbientContext } = await import('../../../capability-envelope/session-confinement-port');
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const contextWorkspace = body.workspace?.trim();
    const coverageClient = typeof body.client === 'string' ? body.client : '';
    // Resolve once for policy, suppression telemetry, rule context and recall.
    const workspaceIdResolved = (async () => {
      const workspace = (body.workspace ?? '').trim();
      if (workspace && workspace !== '*') return workspace;
      return activeWorkspaceId();
    })();
    workspaceIdResolved.catch(() => undefined);
    const recordSuppression = (outcome: InjectionDeliveryOutcome): void => {
      const record = (workspaceId: string) => void recordInjectionCoverage([{
        port: 'mid-turn', client: coverageClient, workspaceId, outcome,
      }]);
      void workspaceIdResolved.then(
        record,
        () => record(contextWorkspace && contextWorkspace !== '*' ? contextWorkspace : ''),
      );
    };
    if (!await sessionAllowsAmbientContext({ ownerId: owner,
      workspaceId: contextWorkspace && contextWorkspace !== '*' ? contextWorkspace : activeWorkspaceId() })) {
      recordSuppression('suppressed-ambient-policy');
      return Response.json({ ok: true, text: '' });
    }

    // Confirm previous complete writes before every recall/admission branch.
    // Tokens, recipient, captured epoch and exact fragments are server-fenced.
    if (Array.isArray(body.confirmedMemoryDeliveries) && body.confirmedMemoryDeliveries.length <= 16) {
      try {
        const [{ confirmMemoryEmission }, { getOrgPg }] = await Promise.all([
          import('../../../memory/session-epoch-ledger'), import('@papercusp/db-org'),
        ]);
        for (const proof of body.confirmedMemoryDeliveries) await confirmMemoryEmission(getOrgPg().sql, owner, proof);
      } catch { /* A missed ACK costs a replay, never a false suppression. */ }
    }

    // Drain before any query/admission branch. A repeated-failure advisory is
    // orthogonal to memory recall, so it must still be delivered when this
    // batch has no recall signal, is a duplicate, or the recall lane is full.
    // EI-22762647123007262: signed/client-less MCP calls may attribute the
    // detector to a private session key while the hook still uses the public
    // owner for memory recall. Keep the two identities as separate request
    // fields; the owner fallback preserves legacy callers that predate the
    // detector-session transport field.
    const detectorSessionKey = (body.detectorSessionKey ?? owner).trim();
    const pendingFailureHint = takePendingFailureLoopHint(detectorSessionKey);
    const failureHintText = pendingFailureHint ? resolveFailureLoopHintText(pendingFailureHint) : Promise.resolve('');
    // P-011: the worn post-tool rules start here too, for the same reason — no
    // recall early return below may drop them.
    const batchTools = (Array.isArray(body.toolCalls) && body.toolCalls.length
      ? body.toolCalls.map((call) => call?.tool)
      : [body.tool])
      .map((tool) => (typeof tool === 'string' ? tool.trim() : ''))
      .filter(Boolean);
    const ruleContextText = postToolRuleContextText(owner, workspaceIdResolved, batchTools);
    // WI-6554700010018438: resolve the harness ONCE, before the code-intel push.
    // The push used to read raw body.harness, which an operator/superuser-scope
    // hook sends empty, so its snapshot resolved to null on every leg; only the
    // recall below recovered harness from cwd, after the push had already run.
    const harnessResolved = resolveMidTurnHarness(body);
    const respond = async (prepared: PreparedMemoryBlock | null = null): Promise<Response> => {
      const [failureHint, ruleContext] = await Promise.all([failureHintText, ruleContextText]);
      const { codeIntelPushText } = await import('../../../code-intelligence/push-channel');
      const codeIntel = await codeIntelPushText({ owner, workspace: await workspaceIdResolved,
        harness: (await harnessResolved) || undefined, client: body.client,
        incidentAttribution: body.incidentAttribution,
        calls: Array.isArray(body.toolCalls) && body.toolCalls.length ? body.toolCalls : [{ tool: body.tool, toolInput: body.toolInput }],
      }).catch(() => ''); // Its own reserved budget: the memory block never shrinks it (P-005).
      const text = composeMidTurnContextText(prepared?.text ?? '', failureHint, ruleContext, codeIntel);
      const respondBy = turnStartRespondBy(arrivedAt, body.wallMs);
      const fragments = prepared?.fragments.filter(row => (`\n${text}\n`).includes(`\n${row.rendered}\n`)) ?? [];
      let delivery: object = {};
      if (body.memoryReceiptMode === true && ['codex', 'claude', 'omp'].includes(body.client ?? '') &&
          fragments.length && !req.signal.aborted && (respondBy === null || Date.now() < respondBy)) {
        try {
          const [{ stageMemoryEmission }, { getOrgPg }] = await Promise.all([
            import('../../../memory/session-epoch-ledger'), import('@papercusp/db-org'),
          ]);
          const deliveryToken = randomUUID();
          await stageMemoryEmission(getOrgPg().sql, owner, deliveryToken, fragments);
          delivery = { deliveryToken, memoryFragmentOffers: fragments };
        } catch { /* Without a staged candidate the response cannot suppress recall. */ }
      }
      return Response.json({
        ok: true,
        text, ...delivery,
      });
    };

    try {
      // P-005 / D-005 §3b — derive DETAILED so a miss can leave a TRACE.
      // This used to compute a bare string and `return` on empty, recording
      // nothing, which is precisely why "the hook fired but the server derived
      // no query" was indistinguishable from "the hook never fired" and let
      // codex/omp sit structurally zeroed on this port without a fault.
      const grounded = deriveGroundedBatch(Array.isArray(body.toolCalls) && body.toolCalls.length
        ? body.toolCalls : [{ tool: body.tool, toolInput: body.toolInput, querySignals: body.querySignals }]);
      const detail = grounded;
      const derived = grounded.lexical;

      // Resolved BEFORE the first coverage write, not at the recall site, so a
      // miss row and a recall row for the same session key on the same
      // workspace. Split keys would make per-workspace coverage unreadable.
      const workspaceId = await workspaceIdResolved;

      const coverage = {
        port: 'mid-turn' as const,
        client: coverageClient,
        workspaceId,
      };
      // Recorded even when OTHER calls in the batch DID carry signal: a tool we
      // cannot read is vocabulary drift whether or not this particular batch
      // happened to succeed around it. Never awaited — telemetry must not cost
      // the turn.
      if (detail.unknownTools.length || detail.noSignalTools.length) {
        void recordInjectionCoverage([
          ...detail.unknownTools.map((tool) => ({
            ...coverage,
            outcome: 'unknown-tool' as const,
            tool,
          })),
          ...detail.noSignalTools.map((tool) => ({
            ...coverage,
            outcome: 'no-signal' as const,
            tool,
          })),
        ]);
      }

      // No signal in this tool call — drop before spending anything. The
      // difference from before is that the drop is now RECORDED above.
      if (!derived) return respond();
      // P-044: one derived signal, two per-leg queries. See splitLegQueries().
      const query = grounded.semantic;
      const lexicalQuery = grounded.lexical;
      // The cost guards key on the FULL derived text, not the stripped cosine
      // half — two batches that differ only in which files were read are
      // genuinely different questions for the lexical leg, and collapsing them
      // here would suppress the second one's recall entirely.
      const callAdmission = admitCall(owner, grounded.fingerprint, Date.now());
      if (callAdmission !== 'admitted') {
        recordSuppression(callAdmission === 'duplicate-query'
          ? 'suppressed-duplicate-query'
          : 'suppressed-rate-limit');
        return respond();
      }
      pruneRateState(Date.now());

      // Resolved once above (resolveMidTurnHarness), shared with the code-intel push.
      const harness = await harnessResolved;
      // EI-18893248175645463, mid-turn half (P-038). PAPERCUSP_HARNESS_SLUG is
      // only exported for harness-scoped spawns, so an operator/superuser-scope
      // session never sends `harness` — and BOTH the harness AND hive pools
      // (hive resolution fans out FROM harnessSlugs) went empty for that
      // session's whole lifetime. Measured over 7d before this fix: 44.8% of
      // mid-turn recalls queried the harness pool with ZERO scopes, and in
      // exactly those the user pool alone filled all 12 slots — which is what
      // made this surface read as 100% "saturated" and look like a fusion-ceiling
      // failure (F-B) when the ceiling was working fine and the other two pools
      // were simply never asked. Same fallback the turn-start sibling uses, on
      // the CLIENT's cwd (loopback hook, so its cwd is the session's).

      const [{ withIdentityBoundedMemoryAdmission }, { readAppliedIdentityRecall }] = await Promise.all([
        import('../../../memory/mid-turn-admission'),
        import('../../../agent-identities/identity-recall'),
      ]);
      // P-012 (R-19): mid-turn recall runs under the same identity-declared
      // bounds as turn start; an unreadable applied identity sheds it.
      const admitted = await withIdentityBoundedMemoryAdmission(
        () => readAppliedIdentityRecall(owner, workspaceId), async (identityRecall) => {
        const [{ prepareMemoryContextBlock }, { getSessionUserOrDefault }, { resolveClaimedWorkItemIdForOwner }] =
          await Promise.all([
            import('../../../memory/injection'),
            import('../../../auth'),
            import('../../../memory/agent-signals'),
          ]);
        const [user, currentWorkItemId] = await Promise.all([
          getSessionUserOrDefault().catch(() => null),
          resolveClaimedWorkItemIdForOwner({ ownerId: owner, workspaceId }).catch(() => undefined),
        ]);
        // ⚠ P-006 / D-046's human-turn tail is DELIBERATELY NOT WIRED HERE either —
        // this is the mirror of the turn-start call site, and it is held back for the
        // same measured reason (plan decision D-047). If it is ever wired, compose it
        // AFTER admitCall: the cost guards above key on the tool-derived query alone,
        // and a tail that shifts as ingest lands would perturb the
        // "identical consecutive query ⇒ skip" guard.
        // A ready corpus must not wait past the native hook's wall for an
        // unrelated memory availability probe. Reuse turn-start's response
        // margin and the builder's existing shared, cancellable deadline.
        const respondBy = turnStartRespondBy(arrivedAt, body.wallMs);
        const deadline = respondBy === null ? undefined
          : createMemoryWorkDeadline(Math.max(1, respondBy - Date.now()), req.signal);
        try { return (
          (await prepareMemoryContextBlock({
            ...(deadline ? { deadline, respondByMs: respondBy! } : {}),
            userId: user?.id ?? null,
            workspaceId,
            harnessSlugs: harness ? [harness] : [],
            // P-044: `userText` is the de-diluted prose the cosine leg embeds;
            // `lexicalText` is the full derived signal, identifiers and all, for
            // the leg that actually wins on them. When the strip finds no prose to
            // protect the two are the same string and nothing changes.
            queryContext: { userText: query, lexicalText: lexicalQuery, fingerprint: grounded.fingerprint },
            // Free-text port; the epoch ledger is port-agnostic (D-006), so this
            // inherits turn-start's dedup instead of needing one of its own.
            // P-005 / migration 770: recorded on memory_recall_stats, never
            // branched on — this endpoint stays client-agnostic (D-001 inv. 6).
            // No client sent ⇒ NULL ⇒ unattributed, which is the honest reading.
            session: {
              sessionId: owner,
              port: 'mid-turn',
              currentWorkItemId,
              ...(typeof body.client === 'string' && body.client ? { client: body.client } : {}),
            },
            budgetChars: MID_TURN_BUDGET_CHARS,
            heading: 'Possibly relevant (mid-turn)',
            identityRecall,
          }))
        ); } finally { deadline?.close(); }
      });
      if (!admitted.admitted) {
        recordSuppression(suppressionOutcomeForAdmissionReason(admitted.reason));
        return respond();
      }
      const block = admitted.value;

      // The recall RAN. Separate "returned context" from "found nothing
      // relevant": the second is healthy quiet, and an alarm that cannot tell
      // it from a dead hook is the false alarm D-005 §3 exists to prevent.
      void recordInjectionCoverage([{ ...coverage, outcome: block ? 'recalled' : 'no-recall' }]);

      // The budget is advisory inside buildMemoryContextBlock; see clampToBudget.
      return respond(block);
    } catch {
      recordSuppression('suppressed-handler-error');
      return respond();
    }
  },
});

export default [midTurnContext];
