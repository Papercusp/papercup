import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { MarketplaceLayout } from '@papercup/marketplace-public-ui';

/**
 * /marketplace layout — translated from `apps/operator/app/marketplace/layout.tsx`.
 * Wraps every /marketplace/* route in the shared `MarketplaceLayout` chrome.
 */
export const Route = createFileRoute('/marketplace')({
  component: MarketplaceLayoutRoute,
});

function MarketplaceLayoutRoute() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <MarketplaceLayout pathname={pathname}>
      <Outlet />
    </MarketplaceLayout>
  );
}
