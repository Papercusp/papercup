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
 * Body: { owner, prompt, workspace?, harness? } — the hook passes harness/
 * workspace from its launch env so this endpoint does no session-registry
 * resolution on the hot path.
 *
 * CTRL is checked even for a low-signal prompt ("continue") because a mode,
 * loop, carry, or route transition must take effect at the very next boundary.
 * Memory retains its low-signal floor. Fail-soft by contract: any failure returns
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
      const harness = (body.harness ?? '').trim();
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
        if (body.memoryEnabled === false || prompt.length < MIN_PROMPT_CHARS) return '';
        try {
          const [{ buildMemoryContextBlock }, { getSessionUserOrDefault }] = await Promise.all([
            import('../../../memory/injection'),
            import('../../../auth'),
          ]);
          const user = await getSessionUserOrDefault().catch(() => null);
          return (
            (await buildMemoryContextBlock({
              userId: user?.id ?? null,
              workspaceId,
              harnessSlugs: harness ? [harness] : [],
              queryContext: prompt.slice(0, PROMPT_QUERY_CLAMP),
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
