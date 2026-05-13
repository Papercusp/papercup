import { FLAGS } from '@papercusp/flags';

import { requireFlag } from '@/lib/require-flag';

import SnapshotsClient from './SnapshotsClient';

export default async function SnapshotsPage() {
  await requireFlag(FLAGS.SNAPSHOTS);
  return <SnapshotsClient />;
}
