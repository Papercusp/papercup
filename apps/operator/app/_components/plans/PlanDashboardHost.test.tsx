// @vitest-environment jsdom
//
// PlanDashboardHost (plan-visibility-revamp-2026-08-23 P-003): the ?pdash
// takeover host — closed renders NOTHING (no takeover layer in the DOM),
// a scoped value decodes harness::slug into the dashboard's props, a bare
// value falls back to null harness, and the dashboard's onBack clears the
// param. The dashboard itself is mocked (its own test covers it).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { nuqs, setters } = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  setters: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
function mkSetter(key: string) {
  if (!setters[key]) setters[key] = vi.fn(async (v: unknown) => { nuqs[key] = v; });
  return setters[key];
}

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { _d?: unknown }) => [
    nuqs[key] !== undefined ? nuqs[key] : (parser?._d ?? null),
    mkSetter(key),
  ],
  parseAsString: { withDefault: (d: unknown) => ({ _d: d }) },
}));
vi.mock('./PlanDashboard', () => ({
  default: ({
    planSlug,
    harnessSlug,
    onBack,
  }: {
    planSlug: string;
    harnessSlug: string | null;
    onBack: () => void;
  }) => (
    <div data-testid="dash-mock" data-plan={planSlug} data-harness={harnessSlug ?? ''}>
      <button type="button" data-testid="dash-mock-back" onClick={onBack}>
        back
      </button>
    </div>
  ),
}));

import PlanDashboardHost, { PLAN_DASHBOARD_PARAM } from './PlanDashboardHost';

afterEach(() => {
  cleanup();
  for (const k of Object.keys(nuqs)) delete nuqs[k];
  for (const setter of Object.values(setters)) setter.mockClear();
});

describe('PlanDashboardHost', () => {
  it('renders nothing while ?pdash is unset', () => {
    render(<PlanDashboardHost />);
    expect(screen.queryByTestId('plan-dashboard-takeover')).toBeNull();
  });

  it('decodes a scoped ref into the dashboard props', async () => {
    nuqs[PLAN_DASHBOARD_PARAM] = 'papercusp::my-plan';
    render(<PlanDashboardHost />);
    expect(screen.getByTestId('plan-dashboard-takeover')).toBeTruthy();
    const dash = await waitFor(() => screen.getByTestId('dash-mock'));
    expect(dash.getAttribute('data-plan')).toBe('my-plan');
    expect(dash.getAttribute('data-harness')).toBe('papercusp');
  });

  it('accepts a bare slug (null harness — the row-harness fallback path)', async () => {
    nuqs[PLAN_DASHBOARD_PARAM] = 'my-plan';
    render(<PlanDashboardHost />);
    const dash = await waitFor(() => screen.getByTestId('dash-mock'));
    expect(dash.getAttribute('data-plan')).toBe('my-plan');
    expect(dash.getAttribute('data-harness')).toBe('');
  });

  it('onBack clears the takeover param', async () => {
    nuqs[PLAN_DASHBOARD_PARAM] = 'papercusp::my-plan';
    render(<PlanDashboardHost />);
    fireEvent.click(await waitFor(() => screen.getByTestId('dash-mock-back')));
    expect(setters[PLAN_DASHBOARD_PARAM]).toHaveBeenCalledWith(null);
  });
});
