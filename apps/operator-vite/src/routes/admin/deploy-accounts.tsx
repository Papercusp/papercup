import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';
import DeployAccountsClient from '../../components/admin/DeployAccountsClient';

/**
 * /admin/deploy-accounts — manage the pool of Claude accounts used as per-machine / remote-frame
 * deploy credentials. Add an account by completing the OAuth login in your own browser (claude.ai
 * is behind Cloudflare → no headless automation); the server exchanges the pasted code into an
 * account-pool credential. Never touches this box's own ~/.claude login.
 */
export const Route = createFileRoute('/admin/deploy-accounts')({
  component: DeployAccountsPage,
});

function DeployAccountsPage() {
  return (
    <AdminShell title="Deploy Accounts">
      <DeployAccountsClient />
    </AdminShell>
  );
}
