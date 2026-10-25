/** Authentication targets stay in the live correlator, never session history. */
import { defineTool, readPrivateCardLink } from '@papercusp/agent-mcp';
import { getSessionUserOrLocalDefaultAuthority } from '../../session-or-local';

export default defineTool({
  method: 'GET', path: '/ui/cards/:id/link', auth: 'loopback',
  async handler(req, ctx) {
    const responder = await getSessionUserOrLocalDefaultAuthority(req);
    if (!responder) return new Response(null, { status: 401 });
    const target = readPrivateCardLink(ctx.params.id as string, responder.user.workspace_id);
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
    if (!target) return new Response(null, { status: 404, headers });
    return new Response(null, { status: 303, headers: { ...headers, Location: target } });
  },
});
