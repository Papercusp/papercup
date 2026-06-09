/**
 * POST /api/admin/deploy-accounts/start — begin an "add deploy account" OAuth flow.
 *
 * Returns the Claude authorize URL (the owner opens it in their real browser — claude.ai is behind
 * Cloudflare, so headless automation is impossible) + the PKCE `codeVerifier` and `state`. Public-
 * client PKCE: the trusted admin UI holds the verifier in memory and sends it back to `/exchange`.
 */
import { buildClaudeAuthorize } from '../../../deployment/claude-account-oauth';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/admin/deploy-accounts/start',
  auth: { trust: ['verified', 'trusted'] },
  async handler() {
    const { authorizeUrl, codeVerifier, state } = buildClaudeAuthorize();
    return Response.json({ ok: true, authorizeUrl, codeVerifier, state });
  },
});
