import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../lib/require-flag';
import MarketplaceHomeClient from '@/app/marketplace/MarketplaceHomeClient';

/**
 * /marketplace — marketplace home. Translated from
 * `apps/operator/app/marketplace/page.tsx`. The `requireFlag(FLAGS.MARKETPLACE)`
 * gate is ported to a `beforeLoad` check — see `lib/require-flag.ts`.
 */
export const Route = createFileRoute('/marketplace/')({
  beforeLoad: () => requireFlag(FLAGS.MARKETPLACE),
  component: MarketplaceHomeClient,
});
