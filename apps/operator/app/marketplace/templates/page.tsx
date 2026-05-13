import { FLAGS } from '@papercusp/flags';

import { requireFlag } from '@/lib/require-flag';

import MarketplaceTemplatesClient from './MarketplaceTemplatesClient';

export default async function MarketplaceTemplatesPage() {
  await requireFlag(FLAGS.MARKETPLACE);
  return <MarketplaceTemplatesClient />;
}
