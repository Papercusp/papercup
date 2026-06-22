/**
 * GET /api/desktop/agent-auth-status — per-provider sign-in detection
 * for the Setup Wizard's logins step.
 *
 * Ported from app/api/desktop/agent-auth-status/route.ts. `auth: {}` —
 * any resolved principal (the route's prior `requirePrincipal(headers)`
 * with no requirements); the route-stack runs the gate.
 */
import { claudeSignedIn, codexSignedIn, ompSignedIn, githubSignedIn } from '../../../agent-auth-detect';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/desktop/agent-auth-status',
  auth: {},
  handler() {
    let claude = false;
    let codex = false;
    let omp = false;
    let github = false;
    try { claude = claudeSignedIn(); } catch { /* fs error → false */ }
    try { codex = codexSignedIn(); } catch { /* fs error → false */ }
    try { omp = ompSignedIn(); } catch { /* fs error → false */ }
    try { github = githubSignedIn(); } catch { /* fs error → false */ }
    return Response.json({ claude, codex, omp, github });
  },
});
