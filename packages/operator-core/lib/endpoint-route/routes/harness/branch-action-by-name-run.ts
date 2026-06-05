/**
 * POST /api/harness/:slug/branch/:branch/action/:name/run
 *
 * Path-based variant of action-run (simple, name in URL).
 *
 * Ported from app/api/harness/[slug]/branch/[branch]/action/[name]/run/route.ts.
 * `auth: 'public'`. (Awaits loadHarnessRegistry — original was missing the await;
 * preserving the bug would break the route entirely.)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessRegistry } from '../../../harness-registry';
import { isBranch, runAction } from '../../../branch-actions';
import { defineTool } from '@papercusp/agent-mcp';

function resolvePhasePath(stagingPath: string, branch: 'staging' | 'testing' | 'production'): string {
  if (branch === 'staging') return stagingPath;
  try {
    const cfgPath = join(stagingPath, '.papercusp', 'config.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      const o = cfg?.phases?.[branch]?.path;
      if (typeof o === 'string' && o.length > 0) return o;
    }
  } catch { /* fall through */ }
  return `${stagingPath}--${branch}`;
}

export default defineTool({
  method: 'POST',
  path: '/harness/:slug/branch/:branch/action/:name/run',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const branch = ctx.params.branch as string;
    const name = ctx.params.name as string;
    if (!isBranch(branch)) return Response.json({ error: 'invalid branch' }, { status: 400 });

    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === slug);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });

    const phasePath = resolvePhasePath(project.path, branch);

    let handle;
    try {
      handle = await runAction({
        stagingPath: project.path,
        phasePath,
        harness: slug,
        branch,
        name,
      });
    } catch (e) {
      return Response.json({ error: String((e as Error).message) }, { status: 400 });
    }

    handle.done.catch(() => undefined);

    return Response.json({ ok: true, runId: handle.runId, meta: handle.meta });
  },
});
