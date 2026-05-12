import { FLAGS } from '@papercusp/flags';

import { requireFlag } from '@/lib/require-flag';

import MarketplaceSnapshotsClient from './MarketplaceSnapshotsClient';

export default async function MarketplaceSnapshotsPage() {
  await requireFlag(FLAGS.MARKETPLACE);
  return <MarketplaceSnapshotsClient />;
}
