/**
 * POST /api/agent-mcp/turn-start-memory
 *
 * Plan: memory-delivery-unification-2026-07-12 (P-003a, decisions D-002/D-004).
 *
 * The UserPromptSubmit hook (userpromptsubmit-memory.sh) fetches on every
 * submitted prompt in a psu session. It first consumes the compact pending
 * CTRL transition (P-014), then runs the ONE memory admission pipeline
 * with queryContext = the user's message, under the warm-session epoch
 * dedup (P-002, port 'turn-start') and a SMALL budget — injected lines
 * compound in a warm session, so turn-start is high-precision/low-volume
 * (D-004): the hard floors stay, the budget shrinks, and anything already
 * surfaced this epoch (initialize prelude, orient recall, a claim port) is
 * never re-paid.
 *
 * Body: { owner, prompt, workspace?, harness?, cwd? } — the hook passes
 * harness/workspace from its launch env so this endpoint does no
 * session-registry resolution on the hot path. `cwd` (EI-18893248175645463)
 * is a fallback ONLY: when `harness` is empty (an operator/superuser-scope
 * session, which legitimately has no single PAPERCUSP_HARNESS_SLUG), the
 * client's cwd lets detectHarnessSlugSync's env→marker-file→meta-repo chain
 * still resolve one — the same detection the MCP 'initialize' prelude uses —
 * instead of unconditionally starving the harness+hive pools for that
 * session's entire lifetime.
 *
 * CTRL is checked even for a low-signal prompt ("continue") because a mode,
 * loop, carry, or route transition must take effect at the very next boundary.
 * Memory no longer has a low-signal floor of its own (P-035 / F-E deleted the
 * 40-char gate — see the note below): relevance is decided by the relevance
 * floor, not by prompt length. Fail-soft by contract: any failure returns
 * `{ ok: true, text: '' }` — a hook must never surface an error into a turn.
 * `auth: 'loopback'` — the hook runs on this box.
 */
import { defineTool } from '@papercusp/agent-mcp';

/*
 * NO LENGTH FLOOR HERE — deliberately (context-injection-audit-2026-07-28 P-035
 * / F-E). A `MIN_PROMPT_CHARS = 40` gate used to skip recall for any prompt
 * shorter than 40 characters, on the theory that "continue" / "y" / "ok" carry
 * no recall signal. It was DELETED with no replacement heuristic, and it should
 * not be reintroduced in any form:
 *
 *  - It was a PROXY for relevance, and it was measurably wrong. Prompt LENGTH
 *    does not predict recall signal: this exact gate is what produced the
 *    audit's founding symptom, silently dropping the owner's 23-char question —
 *    a specific, answerable, entirely on-topic prompt — while a 40-char
 *    pleasantry sailed through.
 *  - What it was standing in for now exists for real. F-B (P-032, D-010) made
 *    the push path `cosine-gated`, so the limit is a genuine CEILING and a
 *    signal-free prompt returns ZERO hits on its own merits. Relevance is
 *    judged by the relevance floor, not by a character count.
 *  - The ORDERING mattered and is the whole reason this could not be deleted
 *    when first found: before F-B the push path could not return zero, so
 *    removing the length gate would have handed every short prompt a SATURATED
 *    block of noise — strictly worse than dropping it. That constraint is gone.
 *
 * The degenerate empty-prompt case needs no guard here either: buildMemoryContextBlock
 * returns null on a blank queryContext (injection.ts), one layer down.
 */

/** Query clamp — embed the head of a long prompt, not a pasted document.
 *
 * ⚠ Applied to the CHROME-STRIPPED prompt (P-048), never the raw one. Against
 * the raw prompt this clamp was the defect rather than the guard: measured over
 * a live 7-day window (D-033), 70.0% of ALL turn-start queries were truncated
 * exactly here, 251 of those 254 rows machine-injected — so the clamp was
 * reliably keeping a wake's opening boilerplate and discarding the task content
 * behind it. Post-strip a typical wake is ~240 chars and never reaches it. */
const PROMPT_QUERY_CLAMP = 1_000;

/** D-004 small budget for the mid-epoch delta (chars). */
const TURN_START_BUDGET_CHARS = (() => {
  const raw = Number(process.env.PAPERCUSP_TURN_START_BUDGET_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : 4_000;
})();

const turnStartMemory = defineTool({
  method: 'POST',
  path: '/agent-mcp/turn-start-memory',
  auth: 'loopback',
  async handler(req) {
    let body: {
      owner?: string;
      prompt?: string;
      workspace?: string;
      harness?: string;
      cwd?: string;
      memoryEnabled?: boolean;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: true, text: '' });
    }
    const owner = (body.owner ?? '').trim();
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!owner) return Response.json({ ok: false, error: 'owner required' }, { status: 400 });
    try {
      let harness = (body.harness ?? '').trim();
      // EI-18893248175645463: PAPERCUSP_HARNESS_SLUG is only exported for
      // harness-scoped spawns, so an operator/superuser-scope session (which
      // legitimately spans multiple harnesses, or is simply launched bare)
      // never sends `harness` — and BOTH the harness AND hive pools (hive
      // resolution below fans out FROM harnessSlugs) went unconditionally
      // empty for that session's entire lifetime, not just an occasional
      // miss (measured: a clean per-session split, zero intra-session mix).
      // Fall back to the SAME env → marker-file → meta-repo detection chain
      // the MCP 'initialize' prelude already offers (detect-harness-slug.ts)
      // — using the CLIENT's cwd (the hook runs on this box, loopback-only,
      // so its cwd is the actual session's working directory), never the
      // operator's own process cwd, which would misattribute a session
      // working in a sibling harness (e.g. papercusp-public-site).
      if (!harness && typeof body.cwd === 'string' && body.cwd.trim()) {
        try {
          const { detectHarnessSlugSync } = await import('../../../memory/detect-harness-slug');
          harness = detectHarnessSlugSync({ cwd: body.cwd.trim() }).slug ?? '';
        } catch {
          /* detection is best-effort — an empty harness just stays a bare-session pull */
        }
      }
      const workspace = (body.workspace ?? '').trim();
      const { activeWorkspaceId } = await import('../../../workspace-registry');
      const workspaceId = workspace && workspace !== '*' ? workspace : activeWorkspaceId();

      const controlPromise = (async (): Promise<string> => {
        try {
          const { consumePendingControlTransition, renderControlTransitionContext } = await import(
            '../../../agent-tools/coordination/control-anchor'
          );
          const transition = await consumePendingControlTransition(owner, workspaceId);
          return transition ? renderControlTransitionContext(transition) : '';
        } catch {
          return ''; // migration/operator skew must never block the prompt
        }
      })();

      const memoryPromise = (async (): Promise<string> => {
        if (body.memoryEnabled === false) return '';
        try {
          const [{ buildMemoryContextBlock }, { getSessionUserOrDefault }, { stripInjectedChrome }] =
            await Promise.all([
              import('../../../memory/injection'),
              import('../../../auth'),
              import('../../../turn-provenance/turn-provenance'),
            ]);
          const user = await getSessionUserOrDefault().catch(() => null);
          // Retrieve on what the turn is ABOUT, not on the scaffolding it
          // arrived in — see PROMPT_QUERY_CLAMP above and D-033. Never empty
          // for a non-empty prompt, so this cannot silently disable recall.
          const queryText = stripInjectedChrome(prompt);
          // ⚠ P-006 / D-046 (the human-turn tail) is DELIBERATELY NOT WIRED HERE.
          // `memory/human-turn-tail.ts` implements the owner's chosen shape and is
          // fully tested, but its LIVE-corpus acceptance measured a REGRESSION and
          // D-046's own re-open clause governs: a topical prompt whose human tail is
          // procedural ("continue where you left off" — the single most common human
          // turn in this corpus) loses its on-topic hits entirely. See plan decision
          // D-047. Do not wire this without re-running that measurement.
          return (
            (await buildMemoryContextBlock({
              userId: user?.id ?? null,
              workspaceId,
              harnessSlugs: harness ? [harness] : [],
              queryContext: queryText.slice(0, PROMPT_QUERY_CLAMP),
              session: { sessionId: owner, port: 'turn-start' },
              budgetChars: TURN_START_BUDGET_CHARS,
              heading: 'Relevant memory (turn-start delta)',
            })) ?? ''
          );
        } catch {
          return '';
        }
      })();

      const [control, memory] = await Promise.all([controlPromise, memoryPromise]);
      return Response.json({ ok: true, text: [control, memory].filter(Boolean).join('\n\n') });
    } catch {
      return Response.json({ ok: true, text: '' });
    }
  },
});

export default [turnStartMemory];
