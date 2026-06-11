/**
 * POST /api/agent-mcp/run-tool — palette server-capability invoke (P-004).
 *
 * Loopback-only. Runs a tooldef tool for the desktop palette user through the
 * full gated/audited dispatch (no gate-bypass) with a server-side §3 re-check
 * (excluded tools refused; destructive/high require `confirmed:true`). See
 * `lib/capabilities/invoke.ts`.
 *
 * Body: { name: string, args?: object, confirmed?: boolean }.
 * `auth: 'public'` follows the sibling agent-mcp routes; the loopback gate +
 * the dispatch stack are the actual boundary.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { isLoopbackRequest } from '../../../superuser-token';
import { invokeServerCapability } from '../../../capabilities/invoke';

interface Body {
  name?: unknown;
  args?: unknown;
  confirmed?: unknown;
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/run-tool',
  auth: 'loopback',
  async handler(req) {
    if (!isLoopbackRequest(req.headers)) {
      return Response.json({ ok: false, error: 'forbidden', detail: 'loopback only' }, { status: 403 });
    }
    // Ensure the tool catalog is registered (idempotent; ESM-cached).
    await import('../../../agent-tools');

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return Response.json({ ok: false, error: 'missing_name' }, { status: 400 });
    }

    const r = await invokeServerCapability({
      name,
      args: body.args,
      confirmed: body.confirmed === true,
    });
    if (!r.ok) {
      return Response.json({ ok: false, error: r.code, message: r.message }, { status: r.status });
    }
    return Response.json({ ok: true, result: r.body }, { status: 200 });
  },
});
