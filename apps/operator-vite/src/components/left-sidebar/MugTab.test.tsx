// @vitest-environment jsdom
/**
 * MugTab.test — the Colony-sidebar Queen steering panel
 * (queen-steering-panel-2026-06-15 B-04 / P-004; owner-review rounds 1–2).
 *
 * Asserts the round-2 shape: NO hive dropdown (the tab steers the HOME Queen);
 * Eligible HIVES + Eligible PLANS are both checkbox multi-selects; Pause is the
 * topmost section with a minutes input. Toggling a hive / a plan / pausing all
 * write `pot:set-steering` through /api/agent-mcp/run-tool, targeting the home
 * hive, with the right field.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

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
// MugTab's "Scheduled routines" pane (P-026) deep-links to the Calendar via the
// TSR navigate hook; the panel renders outside a RouterProvider in this unit test.
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
// The Scheduled-routines pane has its own suite; stub it here so MugTab's test
// stays focused on steering (and isn't fed the blanket sync mock's steering rows).
vi.mock('../adv/ScheduledRoutinesPane', () => ({ default: () => <div data-testid="sched-routines-pane" /> }));
vi.mock('../adv/AdvShell', () => ({
  buildHarnessSelectOptions: (projects: Array<{ slug: string }>) => [
    { value: '__all__', label: 'All' },
    { kind: 'group', label: 'workspace', options: projects.map((p) => ({ value: p.slug, label: p.slug })) },
  ],
}));
vi.mock('../adv/adv-harness-selection', () => ({ ALL_HARNESSES_OPTION: '__all__' }));
// This suite pins the LEGACY FLAT fallback (the STEERING_POT_TREE flag-OFF path).
// The nested hive→plan picker (flag ON, the default) has its own suite,
// MugTab.tree.test.tsx.
vi.mock('@papercusp/flags/client', () => ({ useFlag: () => false }));
// Lexicon resolver mocked to ECHO its key (t('brain') → 'brain', t('pot') → 'pot')
// — isolates from the THE_HIVE flag hook; classic pack renders 'Brain'/'Pot(s)' at
// runtime (restore-pot-lexicon P-005).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import MugTab from './MugTab';

// MugTab's new Throttle + Autonomy sections use nuqs (collapse state); the
// adapter supplies the URL-state context the hooks need under test.
const Wrap = ({ children }: { children: ReactNode }) => <NuqsTestingAdapter hasMemory>{children}</NuqsTestingAdapter>;

async function openLane(label: 'Now' | 'Work' | 'Capacity' | 'Schedule') {
  const tab = screen.getByRole('tab', { name: new RegExp(`^${label}`, 'i') });
  fireEvent.click(tab);
  await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
}

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
  return { slug: 'papercup-hive', directive: null, eligiblePlans: [], eligibleHives: [], includeUnplannedWork: true, pauseNewWork: false, pausedUntil: null, ...over };
}

function setSteeringBody(): { name: string; args: Record<string, unknown> } {
  const call = H.fetchMock.mock.calls.find((c) => String((c as unknown[])[0]).includes('run-tool'));
  const opts = (call as unknown[])[1] as { body: string };
  return JSON.parse(opts.body);
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

describe('MugTab (Colony sidebar, round 2)', () => {
  it('groups the Mug controls into state-led lanes and only mounts the selected lane', async () => {
    render(<MugTab active={true} />, { wrapper: Wrap });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'NowFlowing',
      'WorkAll work',
      'CapacityDefaults',
      'ScheduleRoutines',
    ]);
    expect(screen.getByText('New work')).toBeTruthy();
    expect(screen.getByText('Priority')).toBeTruthy();
    expect(screen.getByLabelText('Pause duration in minutes')).toBeTruthy();
    expect(screen.queryByText('Eligible pot')).toBeNull();

    await openLane('Work');
    expect(screen.queryByText('New work')).toBeNull();
    expect(screen.getByText('pot')).toBeTruthy();
    expect(screen.getByText('Plans')).toBeTruthy();
    expect(screen.getByText('Plan A')).toBeTruthy();
    expect(screen.queryByText('Shipped')).toBeNull();
    // The old per-hive selector is gone (steers the home Queen).
    expect(screen.queryByLabelText('Select hive to steer')).toBeNull();
  });

  it('surfaces live flow, work focus, and capacity overrides directly in the lane navigation', () => {
    H.steeringResult = {
      data: [steering({ directive: 'Prioritize benchmarks.', eligibleHives: ['pot-a'], eligiblePlans: ['plan-a'], modelTiers: ['opus'] })],
      loading: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<MugTab active={true} />, { wrapper: Wrap });
    expect(screen.getByRole('tab', { name: /NowFlowing · brief set/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Work1 pot · 1 plan/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Capacity1 custom/i })).toBeTruthy();
  });

  it('names the reset for the active customized pane', async () => {
    H.steeringResult = {
      data: [steering({
        directive: 'Prioritize benchmarks.',
        eligibleHives: ['pot-a'],
        maxBees: 2,
      })],
      loading: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<MugTab active={true} />, { wrapper: Wrap });
    expect(screen.getByRole('button', { name: 'Reset Now controls' }).textContent).toContain('Reset Now');

    await openLane('Work');
    expect(screen.getByRole('button', { name: 'Reset Work controls' }).textContent).toContain('Reset Work');
  });

  it('hides reset on the read-only Schedule pane', async () => {
    H.steeringResult = {
      data: [steering({ directive: 'Prioritize benchmarks.', maxBees: 2 })],
      loading: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<MugTab active={true} />, { wrapper: Wrap });
    await openLane('Schedule');
    expect(screen.queryByRole('button', { name: /Reset .* controls/ })).toBeNull();
  });

  it('resets Now without clearing Work or Capacity settings', async () => {
    H.steeringResult = {
      data: [steering({ directive: 'Prioritize benchmarks.', pauseNewWork: true, eligibleHives: ['pot-a'], maxBees: 2 })],
      loading: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<MugTab active={true} />, { wrapper: Wrap });
    fireEvent.change(screen.getByPlaceholderText('What should Mug prioritize?'), { target: { value: 'Unsaved edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Now controls' }));
    await waitFor(() => expect(wroteRunTool()).toBe(true));
    expect(setSteeringBody().args).toEqual({
      hive: 'papercup-hive',
      directive: null,
      pauseNewWork: false,
      pausedUntil: null,
    });
    expect((screen.getByPlaceholderText('What should Mug prioritize?') as HTMLTextAreaElement).value).toBe('');
  });

  it('resets Work without clearing Now or Capacity settings', async () => {
    H.steeringResult = {
      data: [steering({ directive: 'Keep this.', eligibleHives: ['pot-a'], eligiblePlans: ['plan-a'], includeUnplannedWork: false, maxBees: 2 })],
      loading: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<MugTab active={true} />, { wrapper: Wrap });
    await openLane('Work');
    fireEvent.click(screen.getByRole('button', { name: 'Reset Work controls' }));
    await waitFor(() => expect(wroteRunTool()).toBe(true));
    expect(setSteeringBody().args).toEqual({
      hive: 'papercup-hive',
      eligiblePlans: [],
      eligibleHives: [],
      includeUnplannedWork: true,
    });
  });

  it('resets Capacity without clearing Now or Work settings', async () => {
    H.steeringResult = {
      data: [steering({
        directive: 'Keep this.',
        eligibleHives: ['pot-a'],
        modelTiers: [{ name: 'std', spec: 'opus' }],
        tierCeilings: { bee: 'std' },
        cadenceFloorSec: 120,
        maxBees: 2,
        idleActivities: { scout: false },
        autoScaleOut: false,
        decomposition: 'serial',
      })],
      loading: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<MugTab active={true} />, { wrapper: Wrap });
    await openLane('Capacity');
    fireEvent.click(screen.getByRole('button', { name: 'Expand models' }));
    fireEvent.change(screen.getByLabelText('std model spec'), { target: { value: 'unsaved:model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Capacity controls' }));
    await waitFor(() => expect(wroteRunTool()).toBe(true));
    expect(setSteeringBody().args).toEqual({
      hive: 'papercup-hive',
      modelTiers: null,
      tierCeilings: null,
      cadenceFloorSec: null,
      maxBees: null,
      idleActivities: null,
      autoScaleOut: null,
      decomposition: null,
    });
    expect((screen.getByLabelText('std model spec') as HTMLInputElement).value).toBe('sonnet');
  });

  it('renders the eligible-hives checkboxes from harnessProjects.lite sync data', async () => {
    render(<MugTab active={true} />, { wrapper: Wrap });
    await openLane('Work');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'pot-a' })).toBeTruthy());
    expect(screen.getByRole('checkbox', { name: 'papercup-hive' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'pot-b' })).toBeTruthy();
    expect(H.fetchMock.mock.calls.some((c) => String((c as unknown[])[0]).includes('/projects/lite'))).toBe(false);
  });

  it('toggling a hive writes eligibleHives + the home hive', async () => {
    render(<MugTab active={true} />, { wrapper: Wrap });
    await openLane('Work');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'pot-a' })).toBeTruthy());
    fireEvent.click(screen.getByRole('checkbox', { name: 'pot-a' }));
    await waitFor(() => expect(wroteRunTool()).toBe(true));
    const { name, args } = setSteeringBody();
    expect(name).toBe('pot:set-steering');
    expect(args.hive).toBe('papercup-hive');
    expect(args.eligibleHives).toEqual(['pot-a']);
  });

  it('toggling a plan writes eligiblePlans + the home hive', async () => {
    render(<MugTab active={true} />, { wrapper: Wrap });
    await openLane('Work');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Plan A' }));
    await waitFor(() => expect(wroteRunTool()).toBe(true));
    const { args } = setSteeringBody();
    expect(args.hive).toBe('papercup-hive');
    expect(args.eligiblePlans).toEqual(['plan-a']);
  });

  it('toggling Non-plan work items writes includeUnplannedWork + the home hive', async () => {
    render(<MugTab active={true} />, { wrapper: Wrap });
    await openLane('Work');
    // Default view is "included" (checked) → clicking turns loose work OFF.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Work non-plan work items' }));
    await waitFor(() => expect(wroteRunTool()).toBe(true));
    const { name, args } = setSteeringBody();
    expect(name).toBe('pot:set-steering');
    expect(args.hive).toBe('papercup-hive');
    expect(args.includeUnplannedWork).toBe(false);
  });

  it('writes pauseNewWork:true on Pause until resumed', async () => {
    render(<MugTab active={true} />, { wrapper: Wrap });
    fireEvent.click(screen.getByRole('button', { name: /Pause until resumed/i }));
    await waitFor(() => expect(wroteRunTool()).toBe(true));
    expect(setSteeringBody().args.pauseNewWork).toBe(true);
  });

  it('resumes a timed pause from the same primary control', async () => {
    H.steeringResult = {
      data: [steering({ pauseNewWork: false, pausedUntil: Date.now() + 30 * 60_000 })],
      loading: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<MugTab active={true} />, { wrapper: Wrap });
    expect(screen.getAllByText(/Paused · .* min left/)).toHaveLength(2);
    expect(screen.queryByLabelText('Pause duration in minutes')).toBeNull();
    expect(screen.queryByRole('button', { name: '15 min' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(wroteRunTool()).toBe(true));
    expect(setSteeringBody().args).toMatchObject({ pauseNewWork: false, pausedUntil: null });
  });

  it('accumulates fast back-to-back checkbox clicks without clobbering (owner bug 2026-06-16)', async () => {
    render(<MugTab active={true} />, { wrapper: Wrap });
    await openLane('Work');
    // two clicks before any server refetch — the old read-modify-write on the
    // stale server array dropped the first selection; optimistic state accumulates.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Plan A' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Plan B' }));
    const runTool = () => H.fetchMock.mock.calls.filter((c) => String((c as unknown[])[0]).includes('run-tool'));
    await waitFor(() => expect(runTool().length).toBeGreaterThanOrEqual(2));
    // the LAST write carries BOTH selections (no clobber)
    const last = JSON.parse((runTool().slice(-1)[0][1] as { body: string }).body);
    expect(last.args.eligiblePlans).toEqual(['plan-a', 'plan-b']);
  });

  it('keeps the model-tier editor responsive while the steering save is in flight', async () => {
    H.fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal('fetch', H.fetchMock);
    render(<MugTab active={true} />, { wrapper: Wrap });
    await openLane('Capacity');
    fireEvent.click(screen.getByRole('button', { name: 'Expand models' }));

    const std = await screen.findByLabelText('std model spec') as HTMLInputElement;
    fireEvent.change(std, { target: { value: 'opus:xhigh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply model change for std' }));

    await waitFor(() => expect(wroteRunTool()).toBe(true));
    const { args } = setSteeringBody();
    expect(args.modelTiers).toEqual([
      { name: 'fast', spec: 'haiku' },
      { name: 'std', spec: 'opus:xhigh' },
    ]);
    expect((screen.getByLabelText('std model spec') as HTMLInputElement).disabled).toBe(false);
    expect(screen.getAllByText('1 custom')).toHaveLength(2);
  });
});
