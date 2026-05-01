import type { ReactNode } from 'react';
import { MarketplaceLayout } from '@papercup/marketplace-public-ui';

export default function Layout({ children }: { children: ReactNode }) {
  return <MarketplaceLayout>{children}</MarketplaceLayout>;
}
