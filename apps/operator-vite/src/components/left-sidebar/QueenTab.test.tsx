// @vitest-environment jsdom
/**
 * QueenTab.test — the Colony-sidebar Queen steering panel
 * (queen-steering-panel-2026-06-15 B-04 / P-004; owner-review relocation).
 *
 * Asserts: the panel renders directive (top) + eligibility candidates + the
 * minutes pause input; the hive dropdown is populated from /api/harness/projects/
 * lite (the same source as the main selector — owner-review fix); toggling a plan
 * + the pause controls write `hive:set-steering` through /api/agent-mcp/run-tool
 * with the right args + selected hive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const H = vi.hoisted(() => ({
  steeringResult: { data: [] as unknown[], loading: false, error: null as unknown, invalidate: vi.fn() },
  plansResult: { data: { plans: [] as unknown[] }, loading: false, error: null as unknown },
  nuqsState: { qhive: null } as Record<string, unknown>,
  nuqsSetters: {} as Record<string, ReturnType<typeof vi.fn>>,
  fetchMock: vi.fn(),
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
// Keep the test off the heavy AdvShell module — buildHarnessSelectOptions is pure.
vi.mock('../adv/AdvShell', () => ({
  buildHarnessSelectOptions: (projects: Array<{ slug: string }>) => [
    { value: '__all__', label: 'All' },
    ...projects.map((p) => ({ value: p.slug, label: p.slug })),
  ],
}));
vi.mock('../adv/adv-harness-selection', () => ({ ALL_HARNESSES_OPTION: '__all__' }));

import QueenTab from './QueenTab';

const PROJECTS = [
  { slug: 'papercup-hive', harness_kind: 'hive' },
  { slug: 'pot-a', harness_kind: null },
  { slug: 'pot-b', harness_kind: null },
];

const PLANS = [
  { slug: 'plan-a', title: 'Plan A', status: 'active', startStatus: 'started', archived: false, updated: '2026-06-15' },
  { slug: 'plan-b', title: 'Plan B', status: 'ready', startStatus: null, archived: false, updated: '2026-06-14' },
  { slug: 'plan-shipped', title: 'Shipped', status: 'shipped', startStatus: null, archived: false, updated: '2026-06-13' },
];

function steering(over: Record<string, unknown> = {}) {
  return { slug: 'papercup-hive', directive: null, eligiblePlans: [], pauseNewWork: false, pausedUntil: null, ...over };
}

/** The body of the run-tool (hive:set-steering) fetch call. */
function setSteeringBody(): { name: string; args: Record<string, unknown> } {
  const call = H.fetchMock.mock.calls.find((c) => String((c as unknown[])[0]).includes('run-tool'));
  const opts = (call as unknown[])[1] as { body: string };
  return JSON.parse(opts.body);
}

beforeEach(() => {
  H.steeringResult = { data: [steering()], loading: false, error: null, invalidate: vi.fn() };
  H.plansResult = { data: { plans: PLANS }, loading: false, error: null };
  H.nuqsState = { qhive: null };
  H.nuqsSetters = {};
  H.fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/projects/lite')) return { ok: true, json: async () => ({ projects: PROJECTS }) };
    return { ok: true, json: async () => ({ ok: true, result: { content: [{ text: '{"ok":true}' }] } }) };
  });
  vi.stubGlobal('fetch', H.fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('QueenTab (Colony sidebar)', () => {
  it('renders directive, eligibility candidates (shipped excluded), and the minutes pause input', () => {
    render(<QueenTab active={true} />);
    expect(screen.getByText('Focus directive')).toBeTruthy();
    expect(screen.getByText('Plan A')).toBeTruthy();
    expect(screen.getByText('Plan B')).toBeTruthy();
    expect(screen.queryByText('Shipped')).toBeNull();
    expect(screen.getByLabelText('Pause duration in minutes')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pause indefinitely/i })).toBeTruthy();
  });

  it('populates the hive dropdown from /api/harness/projects/lite (not a filtered 2)', async () => {
    render(<QueenTab active={true} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'pot-a' })).toBeTruthy());
    expect(screen.getByRole('option', { name: 'papercup-hive' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'pot-b' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'All' })).toBeNull(); // the non-steering "All" row is filtered out
  });

  it('writes hive:set-steering with the toggled plan + the selected hive', async () => {
    render(<QueenTab active={true} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Plan A' }));
    await waitFor(() => expect(H.fetchMock.mock.calls.some((c) => String((c as unknown[])[0]).includes('run-tool'))).toBe(true));
    const { name, args } = setSteeringBody();
    expect(name).toBe('hive:set-steering');
    expect(args.hive).toBe('papercup-hive');
    expect(args.eligiblePlans).toEqual(['plan-a']);
  });

  it('writes pauseNewWork:true on Pause indefinitely', async () => {
    render(<QueenTab active={true} />);
    fireEvent.click(screen.getByRole('button', { name: /Pause indefinitely/i }));
    await waitFor(() => expect(H.fetchMock.mock.calls.some((c) => String((c as unknown[])[0]).includes('run-tool'))).toBe(true));
    expect(setSteeringBody().args.pauseNewWork).toBe(true);
  });

  it('writes a future pausedUntil when minutes are applied', async () => {
    render(<QueenTab active={true} />);
    fireEvent.change(screen.getByLabelText('Pause duration in minutes'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'apply' }));
    await waitFor(() => expect(H.fetchMock.mock.calls.some((c) => String((c as unknown[])[0]).includes('run-tool'))).toBe(true));
    const until = setSteeringBody().args.pausedUntil;
    expect(typeof until).toBe('number');
    expect(until as number).toBeGreaterThan(Date.now());
  });
});
