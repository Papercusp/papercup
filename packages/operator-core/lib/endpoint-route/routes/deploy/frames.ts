/**
 * GET /api/deploy/frames → { frames: [{ slug, frame, desktop, region?, host? }] }
 *
 * The deployed-frame roster the Swarm live view (Frames tab) enumerates before
 * opening a per-slug `/api/deploy/:slug/frame-view` SSE stream
 * (`hive-frame-desktops-live-view-2026-06-06` P-006). Registry-backed: a frame
 * appears here exactly while its handle is persisted (deploy → teardown).
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getSessionUser } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';

export default defineTool({
  method: 'GET',
  path: '/deploy/frames',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) {
      return new Response('unauthorized', { status: 401 });
    }
    const { loadHarnessRegistry } = await import('../../../harness-registry');
    const reg = await loadHarnessRegistry(activeWorkspaceId());
    const frames = reg.projects
      .filter((p) => p.deploymentFrame)
      .map((p) => ({
        slug: p.slug,
        frame: {
          id: p.deploymentFrame!.id,
          host: p.deploymentFrame!.host,
          region: p.deploymentFrame!.region,
          kind: p.deploymentFrame!.kind,
          target: p.deploymentFrame!.target,
        },
        desktop: p.deployment?.desktop ?? false,
      }));
    return Response.json({ frames });
  },
});
