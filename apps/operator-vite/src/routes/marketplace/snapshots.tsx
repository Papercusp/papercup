import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../lib/require-flag';
import MarketplaceSnapshotsClient from '@/app/marketplace/snapshots/MarketplaceSnapshotsClient';

/**
 * /marketplace/snapshots — translated from
 * `apps/operator/app/marketplace/snapshots/page.tsx`. requireFlag gate ported to a `beforeLoad` check (lib/require-flag.ts).
 */
export const Route = createFileRoute('/marketplace/snapshots')({
  beforeLoad: () => requireFlag(FLAGS.MARKETPLACE),
  component: MarketplaceSnapshotsClient,
});
