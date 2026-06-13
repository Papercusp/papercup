// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */

const mutateMock = vi.fn(async () => ({ ok: true }));
let syncResult: { data: unknown[]; loading: boolean; error: Error | null };

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ ...syncResult, fetching: false, invalidate: vi.fn() }),
  useSyncMutate: () => mutateMock,
}));

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

// Self-contained nuqs stand-in (no NuqsAdapter needed): useState-backed.
vi.mock('nuqs', async () => {
  const React = await import('react');
  const builder = (def: unknown) => ({ __default: def, withDefault: (d: unknown) => ({ __default: d }) });
  return {
    parseAsString: builder(null),
    parseAsStringEnum: () => ({ withDefault: (d: unknown) => ({ __default: d }) }),
    useQueryState: (_key: string, parser?: { __default?: unknown }) => {
      const [v, setV] = React.useState<unknown>(parser?.__default ?? null);
      return [v, (next: unknown) => { setV(next); return Promise.resolve(true); }];
    },
  };
});

import AutonomySettingsPage from './page';

function row(over: Record<string, unknown>) {
  return {
    category: 'inbox-triage',
    ceiling: 'never-auto',
    locked: false,
    graduatedLevel: 'never-auto',
    effectiveCeiling: 'never-auto',
    ownerOverride: null,
    label: 'Inbox triage',
    protected: false,
    suggestedPosture: 'early-autonomy',
    covers: 'tier / downgrade / dismiss inbox items',
    ...over,
  };
}

const ROWS = [
  row({}),
  row({
    category: 'implementation',
    label: 'Implementation',
    ceiling: 'low',
    graduatedLevel: 'never-auto',
    effectiveCeiling: 'never-auto',
    suggestedPosture: 'risk-graded',
    covers: 'approve / dispatch auto-implement code changes',
  }),
  row({
    category: 'release-deploy',
    label: 'Release & deploy',
    locked: true,
    protected: true,
    suggestedPosture: 'protected',
    covers: 'approve deploys / releases',
  }),
];

beforeEach(() => {
  mutateMock.mockClear();
  syncResult = { data: ROWS, loading: false, error: null };
});
afterEach(cleanup);

describe('AutonomySettingsPage', () => {
  it('renders a row per category with the Protected badge on protected ones', () => {
    render(<AutonomySettingsPage />);
    expect(screen.getByText('Inbox triage')).toBeTruthy();
    expect(screen.getByText('Implementation')).toBeTruthy();
    expect(screen.getByText('Release & deploy')).toBeTruthy();
    expect(screen.getByText('Protected')).toBeTruthy();
  });

  it('explains why effective is None even when a ceiling is set (the D-005 case)', () => {
    render(<AutonomySettingsPage />);
    // Expand the Implementation row (ceiling=low, graduated=never-auto).
    fireEvent.click(screen.getByRole('button', { name: /Implementation/ }));
    expect(
      screen.getByText(/nothing auto-runs until this category earns a graduated level/i),
    ).toBeTruthy();
  });

  it('writes a ceiling change through the mutate hook with a reason', async () => {
    render(<AutonomySettingsPage />);
    const slider = screen.getByRole('radiogroup', { name: /Inbox triage risk ceiling/i });
    fireEvent.click(within(slider).getByRole('radio', { name: 'Low' }));
    expect(mutateMock).toHaveBeenCalledTimes(1);
    const arg = mutateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toMatchObject({ category: 'inbox-triage', ceiling: 'low' });
    expect(typeof arg.reason).toBe('string');
    expect((arg.reason as string).length).toBeGreaterThanOrEqual(8);
  });

  it('locks a configurable category directly via the toggle', () => {
    render(<AutonomySettingsPage />);
    fireEvent.click(screen.getByLabelText('Lock Inbox triage (never auto)'));
    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'inbox-triage', locked: true }),
    );
  });

  it('does NOT immediately unlock a protected category (guards behind confirm)', () => {
    render(<AutonomySettingsPage />);
    fireEvent.click(screen.getByLabelText('Lock Release & deploy (never auto)'));
    // The toggle is checked (locked) → unchecking routes through a confirm toast,
    // so no mutate fires synchronously.
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('filters to protected categories only', () => {
    render(<AutonomySettingsPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'protected' }));
    expect(screen.queryByText('Inbox triage')).toBeNull();
    expect(screen.getByText('Release & deploy')).toBeTruthy();
  });

  it('shows the deferred B-16 placeholders (P-031 feed, P-032 graduation)', () => {
    render(<AutonomySettingsPage />);
    expect(screen.getByText(/recent auto-decisions with one-click undo/i)).toBeTruthy();
    expect(screen.getByText(/Graduation-eligible prompts/i)).toBeTruthy();
  });
});
