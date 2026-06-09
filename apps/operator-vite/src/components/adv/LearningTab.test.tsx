// @vitest-environment jsdom
//
// LearningTab render coverage — the /adv "Learning" tab (operator-learning-tab-2026-06-09).
// Mounts the tab against realistic `learning.improvements` / `learning.gym` /
// `learning.apiary` snapshots (useSyncQuery + nuqs mocked, the pinned sibling pattern —
// see AdvConversationsTab.test.tsx). useSyncQuery dispatches on queryName so each
// sub-view gets its own shape. Asserts the Improvements scoreboard + lanes (default
// view), the Gym sub-view, the Benchmark trend, and the Knowledge cross-link — plus
// the how-this-works strip — guarding against render-time crashes the typecheck can't catch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const nuqsState: Record<string, unknown> = { lview: 'improvements', lane: 'all', how: true, tab: null };
vi.mock('nuqs', () => ({
  useQueryState: (key: string) => [nuqsState[key], vi.fn()],
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  parseAsBoolean: { withDefault: () => ({}) },
  parseAsString: { withDefault: () => ({}) },
}));

const improvementsDigest = {
  generatedAt: new Date(0).toISOString(),
  total: 135,
  open: 117,
  byKind: { bug: 107, change: 28 },
  bySeverity: { major: 87, minor: 40, critical: 5, nit: 3 },
  byState: { open: 117, resolved: 15, closed: 3 },
  autoEligible: [
    {
      id: 'EI-75', kind: 'bug', title: 'fleet:spawn children are coordination-MUTE', scope: 'operator',
      severity: 'critical', state: 'open', assignee: null, assignedAt: null, attempts: 0,
      tier: 'auto', score: 46, ageDays: 2.6, tierReason: 'no protected path → AUTO', ideaType: 'process',
    },
  ],
  humanQueue: [
    {
      id: 'EI-85', kind: 'bug', title: 'Peer restarts massacre in-flight spawns', scope: 'operator',
      severity: 'critical', state: 'open', assignee: null, assignedAt: null, attempts: 0,
      tier: 'human', score: 42, ageDays: 2.5, tierReason: 'protected keyword deploy → human', ideaType: 'process',
    },
  ],
  likelyDuplicates: [],
  recurringSignatures: [],
  headline: 'papercusp-improvement digest: 135 captured (117 open)',
};

const gymSnapshot = {
  proposals: [
    { id: 'v1__worker', harnessSlug: 'papercup-gym', cycle: 3, role: 'worker', rationale: 'tighten the worker acceptance check', devAnchorDelta: 0.042, costDelta: -0.01, status: 'accepted', createdAt: 1, decidedAt: 2 },
    { id: 'v2__architect', harnessSlug: 'papercup-gym', cycle: 3, role: 'architect', rationale: 'more explicit chunk sizing', devAnchorDelta: -0.018, costDelta: 0.02, status: 'rejected', createdAt: 1, decidedAt: 2 },
  ],
  autoloops: [
    { harnessSlug: 'papercup-gym', enabled: true, status: 'running', budgetUsd: 20, spentUsd: 4.5, lastCycle: 3 },
  ],
};

const apiarySnapshot = {
  instances: [
    { instanceId: 'gen0-bbb2222-ws', codeSha: 'bbb2222', createdAt: new Date(2_000_000).toISOString(), totalRuns: 20, successfulRuns: 16, successRate: 0.8, meanComposite: 0.74, meanTimeToGreenSecs: 95, meanTokens: 12000, escalationRate: 0.1, firstAttemptRate: 0.6 },
    { instanceId: 'gen0-aaa1111-ws', codeSha: 'aaa1111', createdAt: new Date(1_000_000).toISOString(), totalRuns: 20, successfulRuns: 14, successRate: 0.7, meanComposite: 0.70, meanTimeToGreenSecs: 110, meanTokens: 13500, escalationRate: 0.15, firstAttemptRate: 0.5 },
  ],
};

let improvementsResult: Record<string, unknown> = { data: [improvementsDigest], loading: false, fetching: false, error: null, invalidate: vi.fn() };
let gymResult: Record<string, unknown> = { data: [gymSnapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
let apiaryResult: Record<string, unknown> = { data: [apiarySnapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string }) =>
    opts.queryName === 'learning.gym' ? gymResult : opts.queryName === 'learning.apiary' ? apiaryResult : improvementsResult,
}));

import LearningTab from './LearningTab';

beforeEach(() => {
  nuqsState.lview = 'improvements';
  nuqsState.lane = 'all';
  nuqsState.how = true;
  nuqsState.tab = null;
  improvementsResult = { data: [improvementsDigest], loading: false, fetching: false, error: null, invalidate: vi.fn() };
  gymResult = { data: [gymSnapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
  apiaryResult = { data: [apiarySnapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
});
afterEach(() => cleanup());

describe('LearningTab — Improvements view (default)', () => {
  it('renders the scoreboard from the digest rollups', () => {
    render(<LearningTab />);
    expect(screen.getByText('Learning')).toBeTruthy();
    expect(screen.getByText('135')).toBeTruthy(); // captured total
    expect(screen.getByText('117')).toBeTruthy(); // open
    expect(screen.getByText('15')).toBeTruthy(); // resolved (byState)
  });

  it('lists both lanes in the all view', () => {
    render(<LearningTab />);
    expect(screen.getByText('fleet:spawn children are coordination-MUTE')).toBeTruthy();
    expect(screen.getByText('Peer restarts massacre in-flight spawns')).toBeTruthy();
    expect(screen.getByText('EI-75')).toBeTruthy();
  });

  it('shows the lane filter tabs and the sub-view tabs', () => {
    render(<LearningTab />);
    expect(screen.getByRole('tab', { name: 'Auto-fixable' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Needs review' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Improvements/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Gym/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Benchmark/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Knowledge/ })).toBeTruthy();
  });

  it('renders the how-this-works strip for the improvements pipeline, hidden when toggled off', () => {
    render(<LearningTab />);
    expect(screen.getByText('Notice')).toBeTruthy();
    expect(screen.getByText('Triage')).toBeTruthy();
    expect(screen.getByText('Resolve')).toBeTruthy();
    cleanup();
    nuqsState.how = false;
    render(<LearningTab />);
    expect(screen.queryByText('Notice')).toBeNull();
  });

  it('renders the empty state when no improvements match the lane', () => {
    improvementsResult = {
      data: [{ ...improvementsDigest, total: 0, open: 0, autoEligible: [], humanQueue: [], byState: {} }],
      loading: false, fetching: false, error: null, invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getByText('Nothing in this lane')).toBeTruthy();
  });
});

describe('LearningTab — Gym view', () => {
  beforeEach(() => {
    nuqsState.lview = 'gym';
  });

  it('renders the gym scoreboard and recent proposals', () => {
    render(<LearningTab />);
    expect(screen.getByText('Prompt experiments')).toBeTruthy();
    expect(screen.getByText('tighten the worker acceptance check')).toBeTruthy();
    expect(screen.getByText('more explicit chunk sizing')).toBeTruthy();
    // the champion (accepted) proposal's role
    expect(screen.getByText('worker')).toBeTruthy();
  });

  it('renders the gym how-this-works strip (experiment → score → promote)', () => {
    render(<LearningTab />);
    expect(screen.getByText('Experiment')).toBeTruthy();
    expect(screen.getByText('Score')).toBeTruthy();
    expect(screen.getByText('Promote')).toBeTruthy();
  });

  it('renders the gym empty state when no proposals exist', () => {
    gymResult = { data: [{ proposals: [], autoloops: [] }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<LearningTab />);
    expect(screen.getByText('No gym experiments yet')).toBeTruthy();
  });
});

describe('LearningTab — Benchmark view', () => {
  beforeEach(() => {
    nuqsState.lview = 'benchmark';
  });

  it('renders the benchmark scoreboard and the generation trend', () => {
    render(<LearningTab />);
    expect(screen.getByText('Benchmark generations')).toBeTruthy();
    expect(screen.getByText('80%')).toBeTruthy(); // latest success rate (scoreboard)
    expect(screen.getByText('bbb2222')).toBeTruthy(); // latest generation sha (trend row)
    expect(screen.getByText('0.700')).toBeTruthy(); // older generation composite (trend row only)
    expect(screen.getAllByText('0.740').length).toBeGreaterThanOrEqual(1); // latest composite (scoreboard + trend)
  });

  it('renders the benchmark empty state when there are no generations', () => {
    apiaryResult = { data: [{ instances: [] }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<LearningTab />);
    expect(screen.getByText('No benchmark runs yet')).toBeTruthy();
  });
});

describe('LearningTab — Knowledge view', () => {
  beforeEach(() => {
    nuqsState.lview = 'knowledge';
  });

  it('renders the agent-insights cross-link to the Insights tab', () => {
    render(<LearningTab />);
    expect(screen.getByText(/Agent insights/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open the Insights library/ })).toBeTruthy();
  });
});
