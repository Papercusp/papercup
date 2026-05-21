import { createFileRoute } from '@tanstack/react-router';
import MarketplacePluginsClient from '@/app/marketplace/plugins/MarketplacePluginsClient';

/**
 * /marketplace/plugins — translated from
 * `apps/operator/app/marketplace/plugins/page.tsx`. requireFlag gate dropped.
 */
export const Route = createFileRoute('/marketplace/plugins')({
  component: MarketplacePluginsClient,
});
