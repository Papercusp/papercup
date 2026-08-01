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
 * Derive the recall query from the tool call. The tools worth reading are the
 * ones that signal INVESTIGATION — a command, a search pattern, a path — because
 * those are the moments where an agent is about to re-derive something it may
 * already know. A tool we have no sensible reading for yields '' and the call is
 * dropped before any embed (see the handler), which is why an unknown tool costs
 * nothing rather than embedding a blob of JSON.
 */
export function deriveQuery(tool: string, input: unknown): string {
  // The hook clamps tool_input to a string before sending, so accept either the
  // structured object (unit tests, future callers) or that clamped JSON text.
  let io: Record<string, unknown>;
  if (typeof input === 'string') {
    try {
      io = JSON.parse(input) as Record<string, unknown>;
    } catch {
      // A clamped/truncated blob is still usable as raw query text.
      return tool === 'Bash' || tool === 'Grep' || tool === 'Glob' || tool === 'Read' ? input.trim() : '';
    }
  } else {
    io = (input ?? {}) as Record<string, unknown>;
  }
  switch (tool) {
    case 'Bash':
      // The description is the agent's own words for what it is doing — often a
      // better recall signal than the command's flags.
      return [str(io.command), str(io.description)].filter(Boolean).join(' — ');
    case 'Grep':
      return [str(io.pattern), str(io.path), str(io.glob)].filter(Boolean).join(' ');
    case 'Glob':
      return [str(io.pattern), str(io.path)].filter(Boolean).join(' ');
    case 'Read':
      return str(io.file_path);
    default:
      return '';
  }
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
  if (!block || block.length <= budget) return block ?? '';
  const cut = block.slice(0, budget);
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
export function deriveBatchQuery(calls: BatchCall[]): string {
  const parts: string[] = [];
  for (const call of [...calls].reverse()) {
    const q = deriveQuery((call.tool ?? '').trim(), call.toolInput);
    if (!q) continue;
    const response = str(call.toolResponse);
    // An empty-looking result is signal, not noise — say so in the query.
    const barren = !response || /no matches|not found|no files found|^\s*$/i.test(response);
    parts.push(barren ? `${q} (no result)` : q);
  }
  return parts.join(' · ');
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
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: true, text: '' });
    }
    const owner = (body.owner ?? '').trim();
    if (!owner) return Response.json({ ok: false, error: 'owner required' }, { status: 400 });

    try {
      const query = (
        Array.isArray(body.toolCalls) && body.toolCalls.length
          ? deriveBatchQuery(body.toolCalls)
          : deriveQuery((body.tool ?? '').trim(), body.toolInput)
      ).slice(0, QUERY_CLAMP);
      // No signal in this tool call — drop before spending anything.
      if (!query) return Response.json({ ok: true, text: '' });
      if (!admitCall(owner, query, Date.now())) return Response.json({ ok: true, text: '' });
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
      const workspace = (body.workspace ?? '').trim();
      const { activeWorkspaceId } = await import('../../../workspace-registry');
      const workspaceId = workspace && workspace !== '*' ? workspace : activeWorkspaceId();

      const [{ buildMemoryContextBlock }, { getSessionUserOrDefault }] = await Promise.all([
        import('../../../memory/injection'),
        import('../../../auth'),
      ]);
      const user = await getSessionUserOrDefault().catch(() => null);
      const block =
        (await buildMemoryContextBlock({
          userId: user?.id ?? null,
          workspaceId,
          harnessSlugs: harness ? [harness] : [],
          queryContext: query,
          // Free-text port; the epoch ledger is port-agnostic (D-006), so this
          // inherits turn-start's dedup instead of needing one of its own.
          session: { sessionId: owner, port: 'mid-turn' },
          budgetChars: MID_TURN_BUDGET_CHARS,
          heading: 'Possibly relevant (mid-turn)',
        })) ?? '';

      // The budget is advisory inside buildMemoryContextBlock; see clampToBudget.
      return Response.json({ ok: true, text: clampToBudget(block) });
    } catch {
      return Response.json({ ok: true, text: '' });
    }
  },
});

export default [midTurnContext];
