import { createFileRoute } from '@tanstack/react-router';
import InstalledSnapshotsClient from '@/app/installed/snapshots/InstalledSnapshotsClient';

/**
 * /installed/snapshots — translated from
 * `apps/operator/app/installed/snapshots/page.tsx`. requireFlag gate dropped.
 */
export const Route = createFileRoute('/installed/snapshots')({
  component: InstalledSnapshotsClient,
});
