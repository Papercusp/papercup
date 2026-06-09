// @vitest-environment jsdom
//
// LearningTab render coverage — the /adv "Learning" tab (operator-learning-tab-2026-06-09).
// Mounts the tab against a realistic `learning.improvements` digest snapshot
// (useSyncQuery + nuqs mocked, the pinned sibling pattern — see
// AdvConversationsTab.test.tsx) and asserts the scoreboard rollups, both triage
// lanes in the "all" view, the lane filter tabs, and the empty state. Guards
// against render-time crashes the typecheck can't catch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const nuqsState: Record<string, unknown> = { lane: 'all' };
vi.mock('nuqs', () => ({
  useQueryState: (key: string) => [nuqsState[key], vi.fn()],
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
}));

const digestFixture = {
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

let mockResult: Record<string, unknown> = {
  data: [digestFixture], loading: false, fetching: false, error: null, invalidate: vi.fn(),
};
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => mockResult }));

import LearningTab from './LearningTab';

beforeEach(() => {
  nuqsState.lane = 'all';
  mockResult = { data: [digestFixture], loading: false, fetching: false, error: null, invalidate: vi.fn() };
});
afterEach(() => cleanup());

describe('LearningTab', () => {
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

  it('shows the lane filter tabs', () => {
    render(<LearningTab />);
    expect(screen.getByRole('tab', { name: 'Auto-eligible' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Needs a human' })).toBeTruthy();
  });

  it('renders the empty state when no improvements match the lane', () => {
    mockResult = {
      data: [{ ...digestFixture, total: 0, open: 0, autoEligible: [], humanQueue: [], byState: {} }],
      loading: false, fetching: false, error: null, invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getByText('Nothing in this lane')).toBeTruthy();
  });
});
