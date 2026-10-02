/**
 * POST /api/agent-mcp/restricted-egress-check — the server half of the
 * PreToolUse egress guard for client-native tools (Claude Code's own Bash and
 * WebFetch), which never pass through capability:bash. Plan
 * personal-data-reader-set-labels-2026-10-01, P-007, BAR R-11.
 *
 * Body: { owner: string, tool: string, texts: string[] }.
 * Reply: { ok: true, verdict: 'allow' | 'refuse', code, reason, targets }.
 *
 * The decision is binding-enforcement.ts `checkRestrictedEgress`: allow when
 * no provider target is named or the session holds no disclosure; refuse when
 * it holds one, or when its ledger cannot be read. An unexpected failure here
 * replies `ok:false` and the hook refuses — the hook only calls this after its
 * own prefilter matched a provider-shaped token.
 */
import { defineTool } from '@papercusp/agent-mcp';

const MAX_TEXTS = 8;
const MAX_TEXT_CHARS = 64_000;

const restrictedEgressCheck = defineTool({
  method: 'POST',
  path: '/agent-mcp/restricted-egress-check',
  auth: 'loopback',
  async handler(req) {
    let body: { owner?: unknown; tool?: unknown; texts?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: false, error: 'JSON body required' }, { status: 400 });
    }
    const owner = typeof body.owner === 'string' ? body.owner.trim() : '';
    const tool = typeof body.tool === 'string' && body.tool.trim() ? body.tool.trim() : 'native-tool';
    const texts = Array.isArray(body.texts)
      ? body.texts
          .filter((text): text is string => typeof text === 'string')
          .slice(0, MAX_TEXTS)
          .map((text) => text.slice(0, MAX_TEXT_CHARS))
      : [];
    try {
      const { checkRestrictedEgress } = await import('../../../personal-vault/binding-enforcement');
      const verdict = await checkRestrictedEgress({ ownerId: owner || null, tool, texts });
      return Response.json({
        ok: true,
        verdict: verdict.verdict,
        code: verdict.code,
        reason: verdict.reason,
        targets: verdict.targets.map((target) => target.rule),
      });
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
});

export default [restrictedEgressCheck];
