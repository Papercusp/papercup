import { createFileRoute } from '@tanstack/react-router';
import MarketplaceTemplatesClient from '@/app/marketplace/templates/MarketplaceTemplatesClient';

/**
 * /marketplace/templates — translated from
 * `apps/operator/app/marketplace/templates/page.tsx`. requireFlag gate dropped.
 */
export const Route = createFileRoute('/marketplace/templates')({
  component: MarketplaceTemplatesClient,
});
