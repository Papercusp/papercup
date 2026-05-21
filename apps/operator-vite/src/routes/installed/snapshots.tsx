import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../lib/require-flag';
import InstalledSnapshotsClient from '@/app/installed/snapshots/InstalledSnapshotsClient';

/**
 * /installed/snapshots — translated from
 * `apps/operator/app/installed/snapshots/page.tsx`. requireFlag gate ported to a `beforeLoad` check (lib/require-flag.ts).
 */
export const Route = createFileRoute('/installed/snapshots')({
  beforeLoad: () => requireFlag(FLAGS.SNAPSHOTS),
  component: InstalledSnapshotsClient,
});
