/**
 * GET /api/admin/plans/git/:op — git history strip + diff for one plan
 * file. The Plans admin tab's GitHistoryStrip consumes this; the same
 * underlying git logic is also exposed as `plans:history` / `plans:diff`
 * tools for agents (Q3 of plans-admin-ui-2026-05-20).
 *
 * This route is a thin envelope over the shared helpers in
 * `lib/agent-tools/plans/git-history.ts` — slug/hash validation, the
 * git argv, and the `--follow` history parse live there.
 */

import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import {
  readPlanHistory,
  readPlanDiff,
  type PlanGitErrorCode,
} from '@/lib/agent-tools/plans/git-history';

const CODE_TO_HTTP: Record<PlanGitErrorCode, number> = {
  invalid_slug: 400,
  invalid_hash: 400,
  git_error: 500,
};

async function handler(req: Request, ctx: RouteContext): Promise<Response> {
  const op = ctx.params.op;
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  const archived = url.searchParams.get('archived') === 'true';

  if (op === 'history') {
    const r = await readPlanHistory(slug, { archived });
    if (!r.ok) {
      return Response.json(
        { error: { code: r.code, message: r.message } },
        { status: CODE_TO_HTTP[r.code] },
      );
    }
    return Response.json({ commits: r.commits });
  }

  if (op === 'diff') {
    const hash = url.searchParams.get('hash') ?? '';
    const r = await readPlanDiff(slug, hash, { archived });
    if (!r.ok) {
      return Response.json(
        { error: { code: r.code, message: r.message } },
        { status: CODE_TO_HTTP[r.code] },
      );
    }
    return Response.json({ diff: r.diff });
  }

  return Response.json(
    { error: { code: 'unknown_op', message: `git op '${op}' not found` } },
    { status: 404 },
  );
}

export default defineTool({
  method: 'GET',
  path: '/admin/plans/git/:op',
  auth: 'public',
  handler,
});
