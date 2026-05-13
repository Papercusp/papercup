import { FLAGS } from '@papercusp/flags';

import { requireFlag } from '@/lib/require-flag';

import InstalledSnapshotsClient from './InstalledSnapshotsClient';

export default async function InstalledSnapshotsPage() {
  await requireFlag(FLAGS.SNAPSHOTS);
  return <InstalledSnapshotsClient />;
}
