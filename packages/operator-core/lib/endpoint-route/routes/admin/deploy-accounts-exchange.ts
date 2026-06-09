/**
 * POST /api/admin/deploy-accounts/exchange — finish the "add deploy account" flow.
 *
 * Body: { accountId, label?, rawCode, codeVerifier, state? }
 *   rawCode      — the string the owner pasted from the callback page (`<code>#<state>` or bare code).
 *   codeVerifier — the PKCE verifier from /start (the trusted UI round-tripped it).
 *
 * Exchanges the code for tokens, writes a `.credentials.json` bundle under ~/.papercusp/deploy-
 * credentials/, and registers it in the account-pool as `credentialRef: file:<path>`. The deploy
 * frame-installer mounts that on remote frames; this never touches this machine's ~/.claude login.
 */
import { exchangeClaudeCode, writeCredentialBundle } from '../../../deployment/claude-account-oauth';
import { registerAccount } from '../../../deployment/account-pool';
import { updateAccountPool, accountStatus } from '../../../deployment/account-pool-store';
import { papercuspPath } from '../../../papercusp-root';
import { defineTool } from '@papercusp/agent-mcp';

const ID_RE = /^[A-Za-z0-9._-]+$/;

export default defineTool({
  method: 'POST',
  path: '/admin/deploy-accounts/exchange',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    let body: { accountId?: string; label?: string; rawCode?: string; codeVerifier?: string; state?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    const { accountId, label, rawCode, codeVerifier, state } = body ?? {};
    if (!accountId || !ID_RE.test(accountId)) {
      return Response.json({ ok: false, error: "accountId required (allowed: A-Za-z0-9 . _ -)" }, { status: 400 });
    }
    if (!rawCode || !codeVerifier) {
      return Response.json({ ok: false, error: 'rawCode + codeVerifier required' }, { status: 400 });
    }
    try {
      const bundle = await exchangeClaudeCode({ rawCode, codeVerifier, expectedState: state });
      const credPath = papercuspPath('deploy-credentials', `${accountId}.credentials.json`);
      await writeCredentialBundle(credPath, bundle);
      await updateAccountPool((p) =>
        registerAccount(p, { id: accountId, credentialRef: `file:${credPath}`, label: label || undefined }, Date.now()),
      );
      const account = (await accountStatus()).find((a) => a.id === accountId) ?? null;
      return Response.json({ ok: true, account, subscriptionType: bundle.claudeAiOauth.subscriptionType });
    } catch (err) {
      // Never persist a partial credential on failure.
      return Response.json({ ok: false, error: (err as Error).message }, { status: 400 });
    }
  },
});
