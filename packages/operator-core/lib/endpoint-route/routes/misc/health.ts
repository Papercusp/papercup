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
import { getBuildInfo } from '../../../build-info';

export default defineTool({
  method: 'GET',
  path: '/health',
  auth: 'public',
  handler() {
    // WI-265: expose the running checkout's sha + version so launcher↔server
    // deploy-skew is DIAGNOSABLE (the psu-launcher runs the staging tree but
    // calls :3070 = the green-release checkout). Cached after the first resolve,
    // so the zero-dependency liveness contract holds; sha is null if unresolved.
    const { sha, version } = getBuildInfo();
    return Response.json({
      ok: true,
      service: 'papercusp-operator',
      sha,
      version,
      ts: new Date().toISOString(),
    });
  },
});
