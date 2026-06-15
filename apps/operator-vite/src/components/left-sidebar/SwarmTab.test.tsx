// @vitest-environment jsdom
/**
 * SwarmTab coverage (left-sidebar-tauri-2026-06-07) — the live agent roster over
 * the fleet dossier. Pins: the roster (empty / error / live rows + ⇄load pill);
 * agent selection (click writes ?lsa, re-click clears, ✕ filter clears); the comms
 * toggle (?lsc swaps the dossier for the selected agent's mail over fleet
 * conversations); the dossier whole-fleet vs agent-filtered ranked task list; and
 * the plan-progress section (fleet-wide vs the selected agent's plans, with the
 * done/total pct). Five sync queries are dispatched by queryName; nuqs is a per-key
 * store the tests seed with spy setters; useLexicon is identity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const nuqsState: Record<string, unknown> = { lsa: null, lsc: false };
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('nuqs', () => ({
  useQueryState: (key: string) => {
    const set = vi.fn(async (v: unknown) => {
      nuqsState[key] = v;
    });
    nuqsSetters[key] = set;
    return [nuqsState[key], set];
  },
  parseAsString: {},
  parseAsBoolean: { withDefault: () => ({}) },
}));

const H = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[]; loading: boolean; fetching: boolean; error: unknown; invalidate: ReturnType<typeof vi.fn> }>,
}));
const blank = () => ({ data: [] as unknown[], loading: false, fetching: false, error: null, invalidate: vi.fn() });
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => H.results[queryName] ?? blank(),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import SwarmTab from './SwarmTab';

function seed(queryName: string, data: unknown[], extra: Partial<ReturnType<typeof blank>> = {}) {
  H.results[queryName] = { ...blank(), data, ...extra };
}

beforeEach(() => {
  nuqsState.lsa = null;
  nuqsState.lsc = false;
  H.results = {};
});
afterEach(() => cleanup());

const PRESENCE = [
  { ownerId: 'bee-1', ownerLabel: 'Bee One', intent: 'refactoring', currentPlanSlug: null, heartbeatAt: 2, stale: false },
  { ownerId: 'bee-2', ownerLabel: 'Bee Two', intent: null, currentPlanSlug: null, heartbeatAt: 1, stale: false },
  { ownerId: 'ghost', ownerLabel: 'Ghost', intent: null, currentPlanSlug: null, heartbeatAt: 0, stale: true },
];

const BEES = [
  {
    agentId: 'bee-1', name: 'Bee One', alive: true, intent: 'refactoring', declaredPlanSlug: 'plan-a',
    claims: [{ planSlug: 'plan-b' }], load: 2,
    queued: [
      { id: 'w1', title: 'fix the thing', status: 'wip', rank: 1 },
      { id: 'w2', title: 'write tests', status: 'queued', rank: 2 },
    ],
  },
  { agentId: 'bee-2', name: 'Bee Two', alive: true, intent: null, load: 1, queued: [{ id: 'w3', title: 'review', status: 'queued', rank: 1 }] },
];

const PLANS = [
  { slug: 'plan-a', archived: false, priority: 5, itemCounts: { todo: 1, done: 3, blocked: 0, failed: 0 } },
  { slug: 'plan-b', archived: false, priority: 1, itemCounts: { todo: 2, done: 0 } },
  { slug: 'plan-archived', archived: true, itemCounts: { todo: 1, done: 1 } },
  { slug: 'plan-empty', archived: false, itemCounts: { todo: 0, done: 0 } },
];

describe('<SwarmTab> roster', () => {
  it('shows the empty state when no live agent is present', () => {
    render(<SwarmTab active={true} />);
    expect(screen.getByText('No agents active right now.')).toBeTruthy();
  });

  it('surfaces a presence error', () => {
    seed('dev.coordPresence', [], { error: 'coord down' });
    render(<SwarmTab active={true} />);
    expect(screen.getByText(/coord down/)).toBeTruthy();
  });

  it('lists live agents (stale excluded) with the ⇄load pill from the bee group', () => {
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    render(<SwarmTab active={true} />);
    expect(screen.getByText('fleet · 2 live')).toBeTruthy();
    expect(screen.getByTestId('swarm-agent-bee-1')).toBeTruthy();
    expect(screen.getByTestId('swarm-agent-bee-2')).toBeTruthy();
    expect(screen.queryByTestId('swarm-agent-ghost')).toBeNull();
    // bee-1 carries a load of 2.
    expect(screen.getByTestId('swarm-agent-bee-1').textContent).toContain('⇄2');
    // bee-2 with no intent falls back to "no declared intent".
    expect(screen.getByTestId('swarm-agent-bee-2').textContent).toContain('no declared intent');
  });
});

describe('<SwarmTab> selection', () => {
  it('clicking an agent row writes ?lsa', () => {
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    render(<SwarmTab active={true} />);
    fireEvent.click(screen.getByTestId('swarm-agent-bee-1'));
    expect(nuqsSetters.lsa).toHaveBeenCalledWith('bee-1');
  });

  it('clicking the already-selected agent clears the filter (toggle off)', () => {
    nuqsState.lsa = 'bee-1';
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    render(<SwarmTab active={true} />);
    fireEvent.click(screen.getByTestId('swarm-agent-bee-1'));
    expect(nuqsSetters.lsa).toHaveBeenCalledWith(null);
    // The ✕ filter chip also clears it.
    fireEvent.click(screen.getByText('✕ filter'));
    expect(nuqsSetters.lsa).toHaveBeenCalledWith(null);
  });
});

describe('<SwarmTab> dossier', () => {
  it('with no agent selected, shows the whole-fleet task list busiest-first', () => {
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    render(<SwarmTab active={true} />);
    const dossier = screen.getByTestId('swarm-dossier');
    expect(dossier.textContent).toContain('fleet task list (3 claimed)'); // 2 + 1
    expect(dossier.textContent).toContain('fix the thing');
    expect(dossier.textContent).toContain('review');
  });

  it('with an agent selected, narrows the dossier to its ranked work-list', () => {
    nuqsState.lsa = 'bee-1';
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    render(<SwarmTab active={true} />);
    const dossier = screen.getByTestId('swarm-dossier');
    expect(dossier.textContent).toContain('task list — Bee One (2 claimed)');
    expect(dossier.textContent).toContain('fix the thing');
    expect(dossier.textContent).not.toContain('review'); // bee-2's task hidden
  });

  it('shows the no-claims empty when the selected agent has an empty queue', () => {
    nuqsState.lsa = 'bee-2';
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', [{ ...BEES[1], queued: [], load: 0 }]);
    render(<SwarmTab active={true} />);
    expect(screen.getByText('(no work-items claimed)')).toBeTruthy();
  });
});

describe('<SwarmTab> plan progress', () => {
  it('fleet-wide plans drop archived + empty and show done/total', () => {
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    seed('plans.list', PLANS);
    render(<SwarmTab active={true} />);
    const plansSec = screen.getByTestId('swarm-plans');
    expect(plansSec.textContent).toContain('plan-a');
    expect(plansSec.textContent).toContain('plan-b');
    expect(plansSec.textContent).not.toContain('plan-archived');
    expect(plansSec.textContent).not.toContain('plan-empty');
    // plan-a is 3/4.
    expect(plansSec.textContent).toContain('3/4');
  });

  it('narrows plan progress to the selected agent’s declared + claim slugs', () => {
    nuqsState.lsa = 'bee-1';
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    seed('plans.list', [...PLANS, { slug: 'plan-other', archived: false, priority: 9, itemCounts: { todo: 1, done: 1 } }]);
    render(<SwarmTab active={true} />);
    const plansSec = screen.getByTestId('swarm-plans');
    // bee-1's plans are plan-a (declared) + plan-b (claim) — not plan-other.
    expect(plansSec.textContent).toContain('plan-a');
    expect(plansSec.textContent).toContain('plan-b');
    expect(plansSec.textContent).not.toContain('plan-other');
  });
});

describe('<SwarmTab> comms toggle', () => {
  it('clicking comms writes ?lsc', () => {
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    render(<SwarmTab active={true} />);
    fireEvent.click(screen.getByTestId('left-sidebar-comms-toggle'));
    expect(nuqsSetters.lsc).toHaveBeenCalledWith(true);
  });

  it('comms ON swaps the dossier for mail + fleet conversations', () => {
    nuqsState.lsc = true;
    nuqsState.lsa = 'bee-1';
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    seed('sidebar.beeMail', [{ owner: 'bee-1', inbox: [{ from: 'queen', kind: 'task', summary: 'do X' }], outbox: [{ to: ['queen'], kind: 'ack', summary: 'done' }] }]);
    seed('sidebar.conversations', [{ id: 'c1', title: 'thread one', state: 'open', kind: 'ask', asker_id: 'bee-2' }]);
    render(<SwarmTab active={true} />);
    // Dossier sections are gone.
    expect(screen.queryByTestId('swarm-dossier')).toBeNull();
    // Mail + conversation copy is present.
    expect(screen.getByText(/do X/)).toBeTruthy();
    expect(screen.getByText(/done/)).toBeTruthy();
    expect(screen.getByText(/fleet conversations \(1\)/)).toBeTruthy();
    expect(screen.getByText(/thread one/)).toBeTruthy();
  });

  it('comms ON with no conversations shows the empty conversations note', () => {
    nuqsState.lsc = true;
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    render(<SwarmTab active={true} />);
    expect(screen.getByText('(no fleet conversations)')).toBeTruthy();
  });
});
