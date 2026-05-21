import { createFileRoute } from '@tanstack/react-router';
import MarketplaceHomeClient from '@/app/marketplace/MarketplaceHomeClient';

/**
 * /marketplace — marketplace home. Translated from
 * `apps/operator/app/marketplace/page.tsx`. `requireFlag(FLAGS.MARKETPLACE)`
 * gate dropped (SPA-flags is the A3 deferral).
 */
export const Route = createFileRoute('/marketplace/')({
  component: MarketplaceHomeClient,
});
