/**
 * POST /api/admin/deploy-accounts/register — register a Claude deploy credential from a PASTED value.
 *
 * Body: { accountId, label?, value }
 *   value = either a `claude setup-token` long-lived token (`sk-ant-oat…`) → written raw and
 *           registered as `credentialRef: token:<path>`, OR a `.credentials.json` bundle (JSON with
 *           a `claudeAiOauth` block) → written as-is and registered as `credentialRef: file:<path>`.
 *
 * This is the PROVEN flow: claude.ai's authorize endpoint rejects a hand-built OAuth URL (it needs
 * claude-code's own client handshake), so the owner runs `claude setup-token` (which does that
 * handshake in their real browser) and pastes the result here. Never touches this box's ~/.claude.
 * The deploy frame-installer already consumes both `token:` and `file:` credentialRefs.
 */
import { writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { registerAccount } from '../../../deployment/account-pool';
import { updateAccountPool, accountStatus } from '../../../deployment/account-pool-store';
import { notifySyncInvalidate } from '../../../sync-sse';
import { papercuspPath } from '../../../papercusp-root';
import { requireAllowedOriginOr403 } from '../../cors';
import { defineTool } from '@papercusp/agent-mcp';

const ID_RE = /^[A-Za-z0-9._-]+$/;

export default defineTool({
  method: 'POST',
  path: '/admin/deploy-accounts/register',
  // unverified-loopback: cookie-less desktop webview (EI-338) — see credentials/index.ts.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    let body: { accountId?: string; label?: string; value?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    const accountId = body?.accountId?.trim();
    const value = body?.value?.trim();
    if (!accountId || !ID_RE.test(accountId)) {
      return Response.json({ ok: false, error: 'accountId required (allowed: A-Za-z0-9 . _ -)' }, { status: 400 });
    }
    if (!value) return Response.json({ ok: false, error: 'value required (a sk-ant-oat… token or a .credentials.json bundle)' }, { status: 400 });

    // Discriminate: a setup-token (token:) vs a pasted .credentials.json bundle (file:).
    const isBundle = value.startsWith('{');
    if (isBundle) {
      try {
        const parsed = JSON.parse(value);
        if (!parsed?.claudeAiOauth?.accessToken) {
          return Response.json({ ok: false, error: 'bundle has no claudeAiOauth.accessToken' }, { status: 400 });
        }
      } catch {
        return Response.json({ ok: false, error: 'value looked like JSON but failed to parse' }, { status: 400 });
      }
    } else if (!value.startsWith('sk-ant-oat')) {
      return Response.json(
        { ok: false, error: "value must be a setup-token (sk-ant-oat…) or a .credentials.json bundle ({…})" },
        { status: 400 },
      );
    }

    try {
      const fileName = isBundle ? `${accountId}.credentials.json` : accountId;
      const credPath = papercuspPath('deploy-credentials', fileName);
      await mkdir(dirname(credPath), { recursive: true });
      await writeFile(credPath, value, { mode: 0o600 });
      await chmod(credPath, 0o600);
      const credentialRef = `${isBundle ? 'file' : 'token'}:${credPath}`;
      await updateAccountPool((p) =>
        registerAccount(p, { id: accountId, credentialRef, label: body.label?.trim() || undefined }, Date.now()),
      );
      const account = (await accountStatus()).find((a) => a.id === accountId) ?? null;
      // Live UI reflection — the Accounts tab reads the accounts.pool sync query.
      void notifySyncInvalidate('accounts.pool', {}).catch(() => {});
      return Response.json({ ok: true, account });
    } catch (err) {
      return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
    }
  },
});
