/**
 * GET /api/desktop/agent-auth-status — per-provider sign-in detection
 * for the Setup Wizard's logins step.
 *
 * Ported from app/api/desktop/agent-auth-status/route.ts. `auth: {}` —
 * any resolved principal (the route's prior `requirePrincipal(headers)`
 * with no requirements); the route-stack runs the gate.
 */
import { claudeSignedIn, ompSignedIn } from '@/lib/agent-auth-detect';
import { defineRoute } from '../../define-route';

export default defineRoute({
  method: 'GET',
  path: '/desktop/agent-auth-status',
  auth: {},
  handler() {
    let claude = false;
    let omp = false;
    try { claude = claudeSignedIn(); } catch { /* fs error → false */ }
    try { omp = ompSignedIn(); } catch { /* fs error → false */ }
    return Response.json({ claude, omp });
  },
});
