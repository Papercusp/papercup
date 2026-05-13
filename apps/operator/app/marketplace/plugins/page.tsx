import { FLAGS } from '@papercusp/flags';

import { requireFlag } from '@/lib/require-flag';

import MarketplacePluginsClient from './MarketplacePluginsClient';

export default async function MarketplacePluginsPage() {
  await requireFlag(FLAGS.MARKETPLACE);
  return <MarketplacePluginsClient />;
}
