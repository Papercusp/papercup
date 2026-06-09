import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../lib/require-flag';
import SnapshotsClient from '@/app/snapshots/SnapshotsClient';

/**
 * /snapshots — workspace-snapshots index. Translated from
 * `apps/operator/app/snapshots/page.tsx`.
 *
 * The original wrapped `SnapshotsClient` in a server-only
 * `await requireFlag(FLAGS.SNAPSHOTS)`. Ported to a TSR `beforeLoad` check
 * — see `lib/require-flag.ts`.
 */
export const Route = createFileRoute('/snapshots/')({
  beforeLoad: () => requireFlag(FLAGS.SNAPSHOTS),
  component: SnapshotsClient,
});
