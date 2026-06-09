import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/deploy-accounts/page';

/**
 * /settings/deploy-accounts — the pool of Claude accounts used as per-machine /
 * remote-frame deploy credentials. Moved here from the /admin tabs; the
 * /settings layout supplies the surrounding chrome. Client page; re-exported
 * via the page-import pattern (B-4).
 */
export const Route = createFileRoute('/settings/deploy-accounts')({
  component: Page,
});
