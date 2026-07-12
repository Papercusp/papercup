/**
 * POST /api/agent-mcp/turn-start-memory
 *
 * Plan: memory-delivery-unification-2026-07-12 (P-003a, decisions D-002/D-004).
 *
 * The read the UserPromptSubmit hook (userpromptsubmit-memory.sh) fetches on
 * every submitted prompt in a psu session: run the ONE admission pipeline
 * with queryContext = the user's message, under the warm-session epoch
 * dedup (P-002, port 'turn-start') and a SMALL budget — injected lines
 * compound in a warm session, so turn-start is high-precision/low-volume
 * (D-004): the hard floors stay, the budget shrinks, and anything already
 * surfaced this epoch (initialize prelude, orient recall, a claim port) is
 * never re-paid.
 *
 * Body: { owner, prompt, workspace?, harness? } — the hook passes harness/
 * workspace from its launch env so this endpoint does no session-registry
 * resolution on the hot path.
 *
 * Fail-soft by contract: any failure (or a low-signal prompt) returns
 * `{ ok: true, text: '' }` — a hook must never surface an error into a turn.
 * `auth: 'loopback'` — the hook runs on this box.
 */
import { defineTool } from '@papercusp/agent-mcp';

/** Prompts below this length ("continue", "y", "ok") carry no recall signal. */
const MIN_PROMPT_CHARS = (() => {
  const raw = Number(process.env.PAPERCUSP_TURN_START_MIN_PROMPT_CHARS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 40;
})();

/** Query clamp — embed the head of a long prompt, not a pasted document. */
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
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: true, text: '' });
    }
    const owner = (body.owner ?? '').trim();
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!owner) return Response.json({ ok: false, error: 'owner required' }, { status: 400 });
    if (prompt.length < MIN_PROMPT_CHARS) return Response.json({ ok: true, text: '' });

    try {
      const [{ buildMemoryContextBlock }, { activeWorkspaceId }] = await Promise.all([
        import('../../../memory/injection'),
        import('../../../workspace-registry'),
      ]);
      const { getSessionUserOrDefault } = await import('../../../auth');
      const user = await getSessionUserOrDefault().catch(() => null);
      const harness = (body.harness ?? '').trim();
      const workspace = (body.workspace ?? '').trim();
      const text = await buildMemoryContextBlock({
        userId: user?.id ?? null,
        workspaceId: workspace && workspace !== '*' ? workspace : activeWorkspaceId(),
        harnessSlugs: harness ? [harness] : [],
        queryContext: prompt.slice(0, PROMPT_QUERY_CLAMP),
        session: { sessionId: owner, port: 'turn-start' },
        budgetChars: TURN_START_BUDGET_CHARS,
        heading: 'Relevant memory (turn-start delta)',
      });
      return Response.json({ ok: true, text: text ?? '' });
    } catch {
      return Response.json({ ok: true, text: '' });
    }
  },
});

export default [turnStartMemory];
