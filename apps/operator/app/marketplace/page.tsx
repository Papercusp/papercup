import { FLAGS } from '@papercusp/flags';

import { requireFlag } from '@/lib/require-flag';

import MarketplaceHomeClient from './MarketplaceHomeClient';

export default async function MarketplaceHomePage() {
  await requireFlag(FLAGS.MARKETPLACE);
  return <MarketplaceHomeClient />;
}
