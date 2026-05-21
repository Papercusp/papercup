import { createFileRoute } from '@tanstack/react-router';
import MarketplaceSnapshotsClient from '@/app/marketplace/snapshots/MarketplaceSnapshotsClient';

/**
 * /marketplace/snapshots — translated from
 * `apps/operator/app/marketplace/snapshots/page.tsx`. requireFlag gate dropped.
 */
export const Route = createFileRoute('/marketplace/snapshots')({
  component: MarketplaceSnapshotsClient,
});
