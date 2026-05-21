import { createFileRoute } from '@tanstack/react-router';
import SnapshotsClient from '@/app/snapshots/SnapshotsClient';

/**
 * /snapshots — workspace-snapshots index. Translated from
 * `apps/operator/app/snapshots/page.tsx`.
 *
 * **Deviation:** the original wraps `SnapshotsClient` in
 * `await requireFlag(FLAGS.SNAPSHOTS)`. Same SPA-flags deferral as
 * `/design/$slug` — renders unconditionally for now.
 */
export const Route = createFileRoute('/snapshots/')({
  component: SnapshotsClient,
});
