/**
 * GET /api/health — operator liveness probe.
 *
 * A zero-dependency 200. The OMP coordination extension hits this at
 * session start to decide attached vs detached mode (plan
 * agent-coordination-architecture-v2 §10 / Q-5). No DB, no auth — a
 * liveness probe must answer even when the workspace is half-init, and
 * the prober (the bundled extension) may hold no token yet.
 *
 * Resolves Q-5: the plan's earlier draft probed `/api/health`, which
 * did not exist. It exists now.
 */
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/health',
  auth: 'public',
  handler() {
    return Response.json({
      ok: true,
      service: 'papercusp-operator',
      ts: new Date().toISOString(),
    });
  },
});
