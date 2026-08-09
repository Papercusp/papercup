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
 *  3. THE COST GUARDS below stop a burst of tool calls from each buying an embed.
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
import { recordInjectionCoverage } from '../../../memory/injection-delivery-coverage';

/** Query clamp — embed the head of a long command, not a pasted heredoc. */
const QUERY_CLAMP = 1_000;

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
 * Cost ceiling: max recalls per session per rolling minute. The epoch ledger
 * dedups what we SHOW but not what we SPEND — every call is still an embed plus
 * a pgvector query, and this hook is fleet-wide across every psu session. This
 * caps the spend without ever delaying the FIRST call of a burst, which is the
 * one that matters (the acceptance case is "fires early, on the first grep for
 * the symptom" — a time-based floor would have suppressed exactly that).
 */
const MAX_PER_MIN = (() => {
  const raw = Number(process.env.PAPERCUSP_MID_TURN_MAX_PER_MIN);
  return Number.isFinite(raw) && raw > 0 ? raw : 12;
})();

const RATE_WINDOW_MS = 60_000;

/**
 * In-process only, and that is correct rather than a storage-policy violation:
 * this is a rate limiter, not durable state. Losing it on an operator restart
 * costs at most a few extra embeds, so it has no business in Postgres — the same
 * class as a cache timer. Keyed by session owner.
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
function admitCall(owner: string, query: string, now: number): boolean {
  const state = recentCalls.get(owner);
  if (!state) {
    recentCalls.set(owner, { at: [now], lastQuery: query });
    return true;
  }
  if (state.lastQuery === query) return false;
  const fresh = state.at.filter((t) => now - t <= RATE_WINDOW_MS);
  if (fresh.length >= MAX_PER_MIN) {
    state.at = fresh;
    return false;
  }
  fresh.push(now);
  state.at = fresh;
  state.lastQuery = query;
  return true;
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
 *   • omp — tool-call records in ~/.omp: read 1771, grep 443, find 402,
 *     bash 181 (command), edit 168, search 116, write 68, ast_grep 14, glob 4;
 *     field names confirmed against the shipped schemas in
 *     @oh-my-pi/pi-coding-agent/src/{tools,commands}.
 *   • claude — unchanged, and deliberately byte-identical in behaviour.
 *
 * ── DELIBERATE OMISSIONS (absence here is a decision, not an oversight) ──
 *   • codex `write_stdin` (539 calls): `chars` is raw stdin typed at an
 *     interactive process — routinely passwords and tokens. The derived query
 *     is EMBEDDED and (flag permitting) persisted to memory_recall_query_text,
 *     so admitting it would copy credentials into a second place for weak
 *     signal. `detectPossibleSecrets` guards the text table but not the embed.
 *   • codex `wait` / `list_mcp_resources`, omp `yield` / `submit_result` /
 *     `report_finding` / `irc`: no investigation signal to carry.
 * These are known tools with no fields, so they classify as 'no-signal' rather
 * than 'unknown-tool' — the alarm must not read a deliberate omission as drift.
 */
export const TOOL_QUERY_VOCABULARY: Readonly<Record<string, ToolQuerySpec>> = {
  // ── claude (PascalCase) — behaviour frozen by D-003's equivalence proof ──
  // The description is the agent's own words for what it is doing — often a
  // better recall signal than the command's flags.
  Bash: { fields: ['command', 'description'], join: ' — ' },
  Grep: { fields: ['pattern', 'path', 'glob'] },
  Glob: { fields: ['pattern', 'path'] },
  Read: { fields: ['file_path'] },

  // ── codex (snake_case) ──
  exec_command: { fields: ['cmd', 'workdir', 'justification'], join: ' — ' },
  apply_patch: { fields: [], freeform: true },
  exec: { fields: [], freeform: true },
  view_image: { fields: ['path'] },
  update_plan: { fields: ['plan'] },
  wait: { fields: [] },
  list_mcp_resources: { fields: [] },
  write_stdin: { fields: [] }, // credential-shaped; see DELIBERATE OMISSIONS

  // ── omp (lowercase) — `read`/`edit`/`write` key on `path`, not claude's
  //    `file_path`, so both spellings are accepted rather than assumed ──
  bash: { fields: ['command', 'description'], join: ' — ' },
  read: { fields: ['path', 'file_path'] },
  grep: { fields: ['pattern', 'path', 'glob'] },
  glob: { fields: ['pattern', 'path'] },
  find: { fields: ['pattern', 'path', 'glob'] },
  search: { fields: ['pattern', 'path', 'query'] },
  edit: { fields: ['path', 'file_path'] },
  write: { fields: ['path', 'file_path'] },
  ast_grep: { fields: ['pattern', 'path'] },
  ast_edit: { fields: ['pattern', 'path'] },
  yield: { fields: [] },
  submit_result: { fields: [] },
  report_finding: { fields: [] },
};

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
  const spec = TOOL_QUERY_VOCABULARY[tool];
  // Not in the vocabulary at all. Either a client we have not mapped or a new
  // tool on one we have — the case that must stay VISIBLE, because it is the
  // one that silently zeroed codex and omp for the life of this endpoint.
  if (!spec) return { query: '', miss: 'unknown-tool' };

  const done = (text: string): DerivedQuery =>
    text ? { query: text, miss: null } : { query: '', miss: 'no-signal' };

  // The hook clamps tool_input to a string before sending, so accept either the
  // structured object (unit tests, future callers) or that clamped JSON text.
  let io: Record<string, unknown>;
  if (typeof input === 'string') {
    // A freeform tool never carries JSON; the raw body IS the signal.
    if (spec.freeform) return done(input.trim());
    try {
      io = JSON.parse(input) as Record<string, unknown>;
    } catch {
      // A clamped/truncated blob is still usable as raw query text — but only
      // for a tool we recognise, so an unmapped tool cannot smuggle a JSON blob
      // into the embedder.
      return done(input.trim());
    }
  } else {
    if (spec.freeform) return done(str(input));
    io = (input ?? {}) as Record<string, unknown>;
  }

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
  // `composeWithCorpus` (injection.ts) appends the P-008 corpus pointer section
  // AFTER the mem0 block, so a whole-block clamp at 350 deleted that section on
  // EVERY call: measured 21/21 live calls returning 398-403 chars, which is this
  // budget plus the suffix below, never the pointers. The corpus leg has no
  // first-row exemption (WI-6870 removed it) and enforces CORPUS_BUDGET_CHARS
  // strictly, so it arrives already bounded and a second clamp here would only
  // re-truncate a section that is already the right size — and truncate it
  // mid-line, leaving a `work_items:get { id: 'WI-65` that resolves to nothing.
  const at = block.lastIndexOf(`\n\n### ${CORPUS_BLOCK_HEADING}`);
  if (at >= 0) return `${clampSection(block.slice(0, at), budget)}${block.slice(at)}`;
  // Corpus-only block (the mem0 leg had nothing — P-008's motivating case, so it
  // must not be clamped away either): composeWithCorpus renders it at `##`.
  if (block.startsWith(`## ${CORPUS_BLOCK_HEADING}`)) return block;
  return clampSection(block, budget);
}

/** The char clamp itself, applied to ONE section. PURE. */
function clampSection(section: string, budget: number): string {
  if (section.length <= budget) return section;
  const cut = section.slice(0, budget);
  // Prefer a word boundary, but never sacrifice most of the budget to find one.
  const lastSpace = cut.lastIndexOf(' ');
  const head = lastSpace > budget * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()} … (clipped — memory:search the id above for the rest)`;
}

/** One tool call as the PostToolBatch hook ships it (clamped, see the script). */
export interface BatchCall {
  tool?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
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
    const { query: q, miss } = deriveQueryDetailed(tool, call.toolInput);
    if (miss === 'unknown-tool') unknown.add(tool || '(empty)');
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

/**
 * The SINGLE-call form (a direct caller / probe — the hook sends a batch),
 * lifted into the batch shape so the handler has ONE coverage code path
 * instead of two that can drift apart.
 */
function singleCallDetail(tool: string, input: unknown): DerivedBatch {
  const { query, miss } = deriveQueryDetailed(tool, input);
  return {
    query,
    // An empty tool name still has to be countable, or the most likely
    // malformed-payload case is the one that stays invisible.
    unknownTools: miss === 'unknown-tool' ? [tool || '(empty)'] : [],
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
    .map((seg) => seg.replace(/\(no result\)/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((seg) => /[A-Za-z0-9]/.test(seg))
    .join(' · ');
  return { cosine: cosine || lexical, lexical };
}

const midTurnContext = defineTool({
  method: 'POST',
  path: '/agent-mcp/mid-turn-context',
  auth: 'loopback',
  async handler(req) {
    let body: {
      owner?: string;
      toolCalls?: BatchCall[];
      // Single-call form, kept for a direct caller / probe. The hook sends a batch.
      tool?: string;
      toolInput?: unknown;
      workspace?: string;
      harness?: string;
      cwd?: string;
      /** Which TUI is asking — 'claude' | 'codex' | 'omp'. Recorded only (P-005). */
      client?: string;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: true, text: '' });
    }
    const owner = (body.owner ?? '').trim();
    if (!owner) return Response.json({ ok: false, error: 'owner required' }, { status: 400 });

    try {
      // P-005 / D-005 §3b — derive DETAILED so a miss can leave a TRACE.
      // This used to compute a bare string and `return` on empty, recording
      // nothing, which is precisely why "the hook fired but the server derived
      // no query" was indistinguishable from "the hook never fired" and let
      // codex/omp sit structurally zeroed on this port without a fault.
      const detail =
        Array.isArray(body.toolCalls) && body.toolCalls.length
          ? deriveBatchQueryDetailed(body.toolCalls)
          : singleCallDetail((body.tool ?? '').trim(), body.toolInput);
      const derived = detail.query.slice(0, QUERY_CLAMP);

      // Resolved BEFORE the first coverage write, not at the recall site, so a
      // miss row and a recall row for the same session key on the same
      // workspace. Split keys would make per-workspace coverage unreadable.
      const workspace = (body.workspace ?? '').trim();
      const { activeWorkspaceId } = await import('../../../workspace-registry');
      const workspaceId = workspace && workspace !== '*' ? workspace : activeWorkspaceId();

      const coverage = {
        port: 'mid-turn' as const,
        client: typeof body.client === 'string' ? body.client : '',
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
      if (!derived) return Response.json({ ok: true, text: '' });
      // P-044: one derived signal, two per-leg queries. See splitLegQueries().
      const { cosine: query, lexical: lexicalQuery } = splitLegQueries(derived);
      // The cost guards key on the FULL derived text, not the stripped cosine
      // half — two batches that differ only in which files were read are
      // genuinely different questions for the lexical leg, and collapsing them
      // here would suppress the second one's recall entirely.
      if (!admitCall(owner, derived, Date.now())) return Response.json({ ok: true, text: '' });
      pruneRateState(Date.now());

      let harness = (body.harness ?? '').trim();
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
      if (!harness && typeof body.cwd === 'string' && body.cwd.trim()) {
        try {
          const { detectHarnessSlugSync } = await import('../../../memory/detect-harness-slug');
          harness = detectHarnessSlugSync({ cwd: body.cwd.trim() }).slug ?? '';
        } catch {
          /* best-effort — an empty harness just stays a bare-session pull */
        }
      }

      const [{ buildMemoryContextBlock }, { getSessionUserOrDefault }] = await Promise.all([
        import('../../../memory/injection'),
        import('../../../auth'),
      ]);
      const user = await getSessionUserOrDefault().catch(() => null);
      // ⚠ P-006 / D-046's human-turn tail is DELIBERATELY NOT WIRED HERE either —
      // this is the mirror of the turn-start call site, and it is held back for the
      // same measured reason (plan decision D-047). If it is ever wired, compose it
      // AFTER admitCall: the cost guards above key on the tool-derived query alone,
      // and a tail that shifts as ingest lands would perturb the
      // "identical consecutive query ⇒ skip" guard.
      const block =
        (await buildMemoryContextBlock({
          userId: user?.id ?? null,
          workspaceId,
          harnessSlugs: harness ? [harness] : [],
          // P-044: `userText` is the de-diluted prose the cosine leg embeds;
          // `lexicalText` is the full derived signal, identifiers and all, for
          // the leg that actually wins on them. When the strip finds no prose to
          // protect the two are the same string and nothing changes.
          queryContext: { userText: query, lexicalText: lexicalQuery },
          // Free-text port; the epoch ledger is port-agnostic (D-006), so this
          // inherits turn-start's dedup instead of needing one of its own.
          // P-005 / migration 770: recorded on memory_recall_stats, never
          // branched on — this endpoint stays client-agnostic (D-001 inv. 6).
          // No client sent ⇒ NULL ⇒ unattributed, which is the honest reading.
          session: {
            sessionId: owner,
            port: 'mid-turn',
            ...(typeof body.client === 'string' && body.client ? { client: body.client } : {}),
          },
          budgetChars: MID_TURN_BUDGET_CHARS,
          heading: 'Possibly relevant (mid-turn)',
        })) ?? '';

      // The recall RAN. Separate "returned context" from "found nothing
      // relevant": the second is healthy quiet, and an alarm that cannot tell
      // it from a dead hook is the false alarm D-005 §3 exists to prevent.
      void recordInjectionCoverage([{ ...coverage, outcome: block ? 'recalled' : 'no-recall' }]);

      // The budget is advisory inside buildMemoryContextBlock; see clampToBudget.
      return Response.json({ ok: true, text: clampToBudget(block) });
    } catch {
      return Response.json({ ok: true, text: '' });
    }
  },
});

export default [midTurnContext];
