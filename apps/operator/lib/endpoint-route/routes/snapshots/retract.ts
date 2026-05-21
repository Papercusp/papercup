/**
 * POST /api/snapshots/:id/retract
 *
 * Proxies a retract (deprecate/withdraw/yank) to the marketplace API.
 *
 * Ported from app/api/snapshots/[id]/retract/route.ts. `auth: 'public'` — flag-gated.
 */
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { findSnapshot } from '@/lib/snapshot-discovery';
import { readFirstServiceToken } from '@/lib/marketplace-token';
import { defineTool } from '@papercusp/agent-mcp';

const MARKETPLACE_URL = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
const VALID_ACTIONS = ['deprecate', 'undeprecate', 'withdraw', 'unwithdraw', 'yank'] as const;
type RetractAction = (typeof VALID_ACTIONS)[number];
const SLUG_RE = /^[A-Za-z0-9._@/-]{1,256}$/;

interface Body {
  marketplaceSlug?: string;
  version?: string;
  action?: RetractAction;
  reason?: string;
}

export default defineTool({
  method: 'POST',
  path: '/snapshots/:id/retract',
  auth: 'public',
  async handler(req, ctx) {
    const blocked = await gateApiRoute(req, FLAGS.SNAPSHOTS);
    if (blocked) return blocked;
    const id = ctx.params.id as string;

    const snap = await findSnapshot(id);
    if (!snap) {
      return Response.json({ ok: false, error: 'snapshot not found locally' }, { status: 404 });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const action: RetractAction = (body.action as RetractAction) ?? 'deprecate';
    if (!VALID_ACTIONS.includes(action)) {
      return Response.json(
        { ok: false, error: `invalid action "${body.action}"; expected one of ${VALID_ACTIONS.join('|')}` },
        { status: 400 },
      );
    }

    const slug = (body.marketplaceSlug ?? '').trim();
    if (!slug || !SLUG_RE.test(slug)) {
      return Response.json(
        { ok: false, error: 'marketplaceSlug required (the slug returned by /publish)' },
        { status: 400 },
      );
    }
    if (action === 'yank') {
      if (!body.version || !SLUG_RE.test(body.version)) {
        return Response.json(
          { ok: false, error: 'version required for action="yank"' },
          { status: 400 },
        );
      }
    }

    const token = await readFirstServiceToken();
    const url =
      action === 'yank'
        ? `${MARKETPLACE_URL}/v1/packages/${encodeURIComponent(slug)}/versions/${encodeURIComponent(body.version!)}/yank`
        : `${MARKETPLACE_URL}/v1/packages/${encodeURIComponent(slug)}/${action}`;

    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 1000) : undefined;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ reason, actor: 'operator-ui' }),
      });
    } catch (e: unknown) {
      return Response.json(
        { ok: false, error: `marketplace unreachable at ${MARKETPLACE_URL}: ${(e as Error).message}` },
        { status: 502 },
      );
    }

    const respBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      return Response.json(
        { ok: false, status: res.status, error: 'marketplace rejected', detail: respBody },
        { status: 502 },
      );
    }

    return Response.json({
      ok: true,
      slug,
      version: body.version,
      action,
      reason,
      response: respBody,
    });
  },
});
