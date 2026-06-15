// @vitest-environment jsdom
/**
 * AdvQueenTab.test — B-04 / P-004 (queen-steering-panel-2026-06-15).
 *
 * Renders the 👑 Queen steering panel off a mocked `hive.steering` sync query +
 * `usePlanList`, and asserts: the eligibility candidates render with checkboxes,
 * the empty-selection "no restriction" banner shows (D-002), toggling a plan
 * writes `hive:set-steering` through /api/agent-mcp/run-tool with the right
 * eligiblePlans + hive, the pause toggle writes pauseNewWork, and a non-empty
 * eligible set renders as a restriction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const H = vi.hoisted(() => ({
  steeringResult: { data: [] as unknown[], loading: false, error: null as unknown, invalidate: vi.fn() },
  plansResult: { data: { plans: [] as unknown[] }, loading: false, error: null as unknown },
  nuqsState: { qhive: null } as Record<string, unknown>,
  nuqsSetters: {} as Record<string, ReturnType<typeof vi.fn>>,
  fetchMock: vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { content: [{ text: '{"ok":true}' }] } }) })),
}));

vi.mock('nuqs', () => ({
  useQueryState: (key: string) => {
    const setter = (H.nuqsSetters[key] ??= vi.fn((v: unknown) => {
      H.nuqsState[key] = v;
    }));
    return [H.nuqsState[key], setter];
  },
  parseAsString: {},
}));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => H.steeringResult }));
vi.mock('@/app/admin/plans/plans-api', () => ({ usePlanList: () => H.plansResult }));
vi.mock('@/app/harness/Select', () => ({
  Select: ({ value, onChange, options, ariaLabel }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>; ariaLabel?: string }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import AdvQueenTab from './AdvQueenTab';

const PLANS = [
  { slug: 'plan-a', title: 'Plan A', status: 'active', startStatus: 'started', archived: false, updated: '2026-06-15' },
  { slug: 'plan-b', title: 'Plan B', status: 'ready', startStatus: null, archived: false, updated: '2026-06-14' },
  { slug: 'plan-shipped', title: 'Shipped', status: 'shipped', startStatus: null, archived: false, updated: '2026-06-13' },
];

function steering(over: Record<string, unknown> = {}) {
  return { slug: 'papercup-hive', directive: null, eligiblePlans: [], pauseNewWork: false, pausedUntil: null, ...over };
}

/** Parse the JSON body of the Nth fetch call. */
function fetchBody(call = 0): { name: string; args: Record<string, unknown> } {
  const opts = (H.fetchMock.mock.calls[call] as unknown[])[1] as { body: string };
  return JSON.parse(opts.body);
}

beforeEach(() => {
  H.steeringResult = { data: [steering()], loading: false, error: null, invalidate: vi.fn() };
  H.plansResult = { data: { plans: PLANS }, loading: false, error: null };
  H.nuqsState = { qhive: null };
  H.nuqsSetters = {};
  H.fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { content: [{ text: '{"ok":true}' }] } }) }));
  vi.stubGlobal('fetch', H.fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdvQueenTab', () => {
  it('renders candidates (shipped excluded) + the no-restriction banner when nothing is selected', () => {
    render(<AdvQueenTab />);
    expect(screen.getByText('Queen steering')).toBeTruthy();
    expect(screen.getByText('Plan A')).toBeTruthy();
    expect(screen.getByText('Plan B')).toBeTruthy();
    expect(screen.queryByText('Shipped')).toBeNull(); // shipped is not a candidate
    expect(screen.getByText(/may pick up ANY plan/i)).toBeTruthy();
    expect(screen.getByText('no restriction')).toBeTruthy();
  });

  it('writes hive:set-steering with the toggled plan when a checkbox is clicked', async () => {
    render(<AdvQueenTab />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Plan A' }));
    await waitFor(() => expect(H.fetchMock).toHaveBeenCalled());
    const { name, args } = fetchBody();
    expect(name).toBe('hive:set-steering');
    expect(args.hive).toBe('papercup-hive');
    expect(args.eligiblePlans).toEqual(['plan-a']);
  });

  it('writes pauseNewWork:true when Pause new work is clicked', async () => {
    render(<AdvQueenTab />);
    fireEvent.click(screen.getByRole('button', { name: /Pause new work/i }));
    await waitFor(() => expect(H.fetchMock).toHaveBeenCalled());
    expect(fetchBody().args.pauseNewWork).toBe(true);
  });

  it('renders the restricted state + a checked box when a plan is already eligible', () => {
    H.steeringResult = { data: [steering({ eligiblePlans: ['plan-a'] })], loading: false, error: null, invalidate: vi.fn() };
    render(<AdvQueenTab />);
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(screen.getByText(/ONLY the checked plans/i)).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Plan A' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Plan B' }) as HTMLInputElement).checked).toBe(false);
  });

  it('renders the empty state when no hive is steerable', () => {
    H.steeringResult = { data: [], loading: false, error: null, invalidate: vi.fn() };
    render(<AdvQueenTab />);
    expect(screen.getByText(/No hive to steer/i)).toBeTruthy();
  });
});
