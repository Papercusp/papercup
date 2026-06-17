// @vitest-environment jsdom
/**
 * QueenTab.tree.test — the NESTED hive→plan steering picker
 * (steering-nested-hive-plan-tree-2026-06-17, P-002 / P-003 / P-004).
 *
 * Flag ON (the default): the two flat lists are replaced by one tree. Pins:
 *   - the tree renders hives with their plans nested
 *   - the CONTRADICTION is unrepresentable — a plan under an UNCHECKED hive is
 *     disabled (you cannot make it eligible)
 *   - toggling a hive / narrowing a plan writes the derived (eligibleHives,
 *     eligiblePlans) pair through hive:set-steering
 *   - a legacy illegal state surfaces the warning chip (P-004)
 *   - an unassigned (no-hive) plan is surfaced, non-checkable
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const H = vi.hoisted(() => ({
  steeringResult: { data: [] as unknown[], loading: false, error: null as unknown, invalidate: vi.fn() },
  projectsResult: { data: [] as unknown[], loading: false, error: null as unknown, invalidate: vi.fn() },
  modelTiersResult: { data: [] as unknown[], loading: false, error: null as unknown, invalidate: vi.fn() },
  plansResult: { data: { plans: [] as unknown[] }, loading: false, error: null as unknown },
  fetchMock: vi.fn(),
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string }) => {
    if (opts.queryName === 'harnessProjects.lite') return H.projectsResult;
    if (opts.queryName === 'agentConfig.modelTiersBaseline') return H.modelTiersResult;
    return H.steeringResult;
  },
}));
vi.mock('@/app/admin/plans/plans-api', () => ({ usePlanList: () => H.plansResult }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../adv/ScheduledRoutinesPane', () => ({ default: () => <div data-testid="sched-routines-pane" /> }));
vi.mock('../adv/AdvShell', () => ({
  buildHarnessSelectOptions: (projects: Array<{ slug: string }>) => [
    { value: '__all__', label: 'All' },
    { kind: 'group', label: 'workspace', options: projects.map((p) => ({ value: p.slug, label: p.slug })) },
  ],
}));
vi.mock('../adv/adv-harness-selection', () => ({ ALL_HARNESSES_OPTION: '__all__' }));
// Flag ON — the nested picker is the default.
vi.mock('@papercusp/flags/client', () => ({ useFlag: () => true }));

import QueenTab from './QueenTab';

const PROJECTS = [
  { slug: 'papercup-hive', harness_kind: 'hive' },
  { slug: 'pot-a', harness_kind: null },
  { slug: 'pot-b', harness_kind: null },
];

const PLANS = [
  { slug: 'plan-a', title: 'Plan A', status: 'active', startStatus: 'started', archived: false, updated: '2026-06-15', harness: 'pot-a' },
  { slug: 'plan-a2', title: 'Plan A2', status: 'ready', startStatus: null, archived: false, updated: '2026-06-14', harness: 'pot-a' },
  { slug: 'plan-b', title: 'Plan B', status: 'ready', startStatus: null, archived: false, updated: '2026-06-13', harness: 'papercup-hive' },
  { slug: 'plan-orphan', title: 'Orphan', status: 'draft', startStatus: null, archived: false, updated: '2026-06-12', harness: 'all' },
  { slug: 'plan-shipped', title: 'Shipped', status: 'shipped', startStatus: null, archived: false, updated: '2026-06-11', harness: 'pot-a' },
];

function steering(over: Record<string, unknown> = {}) {
  return { slug: 'papercup-hive', directive: null, eligiblePlans: [], eligibleHives: [], pauseNewWork: false, pausedUntil: null, ...over };
}
function setSteeringBody(): { name: string; args: Record<string, unknown> } {
  const call = H.fetchMock.mock.calls.find((c) => String((c as unknown[])[0]).includes('run-tool'));
  return JSON.parse(((call as unknown[])[1] as { body: string }).body);
}
const wroteRunTool = () => H.fetchMock.mock.calls.some((c) => String((c as unknown[])[0]).includes('run-tool'));

beforeEach(() => {
  H.steeringResult = { data: [steering()], loading: false, error: null, invalidate: vi.fn() };
  H.projectsResult = { data: PROJECTS, loading: false, error: null, invalidate: vi.fn() };
  H.modelTiersResult = { data: [{ name: 'fast', spec: 'haiku' }, { name: 'std', spec: 'sonnet' }], loading: false, error: null, invalidate: vi.fn() };
  H.plansResult = { data: { plans: PLANS }, loading: false, error: null };
  H.fetchMock = vi.fn(async (url: string) => {
    return { ok: true, json: async () => ({ ok: true, result: { content: [{ text: '{"ok":true}' }] } }) };
  });
  vi.stubGlobal('fetch', H.fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('QueenTab nested steering tree', () => {
  it('renders the Steering scope tree with hive nodes (no flat Eligible-hives/plans sections)', async () => {
    render(<QueenTab active={true} />);
    expect(screen.getByText('Steering scope')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Toggle hive pot-a' })).toBeTruthy());
    expect(screen.getByRole('checkbox', { name: 'Toggle hive papercup-hive' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Toggle hive pot-b' })).toBeNull();
    expect(H.fetchMock.mock.calls.some((c) => String((c as unknown[])[0]).includes('/projects/lite'))).toBe(false);
    // The legacy flat section titles are gone.
    expect(screen.queryByText('Eligible hives')).toBeNull();
    expect(screen.queryByText('Eligible plans')).toBeNull();
  });

  it('select-all scopes only hives that currently have plans', async () => {
    render(<QueenTab active={true} />);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Toggle hive pot-a' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Select every hive' }));

    await waitFor(() => expect(wroteRunTool()).toBe(true));
    const { args } = setSteeringBody();
    expect(args.eligibleHives).toEqual(['papercup-hive', 'pot-a']);
    expect(args.eligibleHives).not.toContain('pot-b');
    expect(args.eligiblePlans).toEqual([]);
  });

  it('toggling a hive writes eligibleHives + targets the home hive', async () => {
    render(<QueenTab active={true} />);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Toggle hive pot-a' })).toBeTruthy());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Toggle hive pot-a' }));
    await waitFor(() => expect(wroteRunTool()).toBe(true));
    const { name, args } = setSteeringBody();
    expect(name).toBe('hive:set-steering');
    expect(args.hive).toBe('papercup-hive');
    expect(args.eligibleHives).toEqual(['pot-a']);
    expect(args.eligiblePlans).toEqual([]); // "all of pot-a" — no narrowing
  });

  it('a plan under an UNCHECKED hive is disabled — the contradiction is unrepresentable', async () => {
    render(<QueenTab active={true} />);
    // pot-a is unchecked; expand it to reveal its plans.
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Expand hive' }).length).toBeGreaterThan(0));
    const carets = screen.getAllByRole('button', { name: 'Expand hive' });
    // order: papercup-hive(0), pot-a(1); hives with no plans are hidden.
    fireEvent.click(carets[1]);
    const planA = await screen.findByRole('checkbox', { name: 'Plan A' });
    expect((planA as HTMLInputElement).disabled).toBe(true);
  });

  it('keeps a manually expanded hive open across parent rerenders', async () => {
    const { rerender } = render(<QueenTab active={true} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Expand hive' }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand hive' })[1]);
    expect(await screen.findByRole('checkbox', { name: 'Plan A' })).toBeTruthy();

    rerender(<QueenTab active={true} />);

    expect(screen.getByRole('button', { name: 'Collapse hive' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('checkbox', { name: 'Plan A' })).toBeTruthy();
  });

  it('keeps an expanded hive open when its scope checkbox is toggled', async () => {
    render(<QueenTab active={true} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Expand hive' }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand hive' })[1]);
    expect(await screen.findByRole('checkbox', { name: 'Plan A' })).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Toggle hive pot-a' }));

    await waitFor(() => expect(wroteRunTool()).toBe(true));
    expect(screen.getByRole('button', { name: 'Collapse hive' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('checkbox', { name: 'Plan A' })).toBeTruthy();
  });

  it('narrowing a plan under a checked hive writes the explicit eligiblePlans', async () => {
    H.steeringResult = { data: [steering({ eligibleHives: ['pot-a'], eligiblePlans: [] })], loading: false, error: null, invalidate: vi.fn() };
    render(<QueenTab active={true} />);
    // pot-a is checked → auto-expanded, both plans checked (planMode all).
    const planA = await screen.findByRole('checkbox', { name: 'Plan A' });
    expect(planA.getAttribute('aria-checked')).toBe('true');
    expect((planA as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(planA); // uncheck Plan A → narrow to the rest
    await waitFor(() => expect(wroteRunTool()).toBe(true));
    const { args } = setSteeringBody();
    expect(args.eligibleHives).toEqual(['pot-a']);
    expect(args.eligiblePlans).toEqual(['plan-a2']); // all of pot-a minus plan-a
  });

  it('surfaces a legacy illegal state (eligible plan under an excluded hive)', async () => {
    // pot-a checked, but plan-b (papercup-hive, excluded) is eligible → dead.
    H.steeringResult = { data: [steering({ eligibleHives: ['pot-a'], eligiblePlans: ['plan-a', 'plan-b'] })], loading: false, error: null, invalidate: vi.fn() };
    render(<QueenTab active={true} />);
    expect(await screen.findByText(/eligible plan.*excluded hive/i)).toBeTruthy();
  });

  it('surfaces an unassigned (no-hive) plan, non-checkable', async () => {
    render(<QueenTab active={true} />);
    expect(await screen.findByText('No hive — not steerable')).toBeTruthy();
    const unassigned = screen.getByText('No hive — not steerable').closest('.pc-queen__tree-unassigned') as HTMLElement;
    expect(within(unassigned).getByText('Orphan')).toBeTruthy();
    expect(within(unassigned).queryByRole('checkbox')).toBeNull();
  });
});
