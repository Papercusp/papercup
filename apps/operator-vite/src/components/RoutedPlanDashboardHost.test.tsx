// @vitest-environment jsdom
// portal-work-two-pane-2026-09-01 P-003: the `?pdash` app-pane takeover must
// NOT mount on the /plans full-page route, where PlansPane's split layout
// hosts the dashboard itself; everywhere else it mounts exactly as before.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const routerState = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: routerState.pathname } }),
}));
vi.mock('@/app/_components/plans/PlanDashboardHost', () => ({
  default: () => <div data-testid="plan-dashboard-takeover-stub" />,
}));

import RoutedPlanDashboardHost, {
  planDashboardHostMountsOn,
} from './RoutedPlanDashboardHost';

afterEach(cleanup);

describe('RoutedPlanDashboardHost', () => {
  it('mounts the takeover everywhere except the self-hosting /plans route', () => {
    expect(planDashboardHostMountsOn('/')).toBe(true);
    expect(planDashboardHostMountsOn('/adv')).toBe(true);
    expect(planDashboardHostMountsOn('/inbox')).toBe(true);
    expect(planDashboardHostMountsOn('/plans')).toBe(false);
    expect(planDashboardHostMountsOn('/plans/')).toBe(false);
    // A prefix match would be wrong — only the exact route self-hosts.
    expect(planDashboardHostMountsOn('/plans-archive')).toBe(true);
  });

  it('renders PlanDashboardHost on an ordinary route', () => {
    routerState.pathname = '/adv';
    render(<RoutedPlanDashboardHost />);
    expect(screen.getByTestId('plan-dashboard-takeover-stub')).toBeTruthy();
  });

  it('renders nothing on /plans, where the split PlansPane hosts the dashboard', () => {
    routerState.pathname = '/plans';
    const { container } = render(<RoutedPlanDashboardHost />);
    expect(screen.queryByTestId('plan-dashboard-takeover-stub')).toBeNull();
    expect(container.innerHTML).toBe('');
  });
});
