import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../lib/require-flag';
import MarketplacePluginsClient from '@/app/marketplace/plugins/MarketplacePluginsClient';

/**
 * /marketplace/plugins — translated from
 * `apps/operator/app/marketplace/plugins/page.tsx`. requireFlag gate ported to a `beforeLoad` check (lib/require-flag.ts).
 */
export const Route = createFileRoute('/marketplace/plugins')({
  beforeLoad: () => requireFlag(FLAGS.MARKETPLACE),
  component: MarketplacePluginsClient,
});
