import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../lib/require-flag';
import MarketplaceTemplatesClient from '@/app/marketplace/templates/MarketplaceTemplatesClient';

/**
 * /marketplace/templates — translated from
 * `apps/operator/app/marketplace/templates/page.tsx`. requireFlag gate ported to a `beforeLoad` check (lib/require-flag.ts).
 */
export const Route = createFileRoute('/marketplace/templates')({
  beforeLoad: () => requireFlag(FLAGS.MARKETPLACE),
  component: MarketplaceTemplatesClient,
});
