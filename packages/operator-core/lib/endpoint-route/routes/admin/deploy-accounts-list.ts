/**
 * GET /api/admin/deploy-accounts — list the deploy-account pool with each account's rate headroom.
 * The "Deploy Accounts" admin UI reads this to render the table. (account-pool / cloud-deployment-layer.)
 */
import { accountStatus } from '../../../deployment/account-pool-store';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/admin/deploy-accounts',
  auth: { trust: ['verified', 'trusted'] },
  async handler() {
    try {
      return Response.json({ ok: true, accounts: await accountStatus() });
    } catch (err) {
      return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
    }
  },
});
