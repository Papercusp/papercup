// @vitest-environment jsdom
/**
 * SwarmTab coverage — the colony roster split into SU agents (🛠) and Bees (☕),
 * each row expanding inline to its tasks + plan-progress + comms. Pins: roster
 * (empty/error/live + load pill + intent fallback + stale excluded), the SU/Bee
 * split (by presence `source`), selection (?lsa write + toggle), and the inline
 * expansion (tasks + plans, plus mail when present). nuqs is a per-key store
 * seeded with spy setters; sync queries are dispatched by queryName.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const nuqsState: Record<string, unknown> = { lsa: null };
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
}));

const H = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[]; loading: boolean; fetching: boolean; error: unknown; invalidate: ReturnType<typeof vi.fn> }>,
  // The base search the Link mock resolves the `(prev) => …` merge updater
  // against — `{}` by default (fresh URL), set to a populated object to assert
  // the rail's own params (lsb/lst/lsa) survive a row click.
  linkBase: {} as Record<string, unknown>,
}));
const blank = () => ({ data: [] as unknown[], loading: false, fetching: false, error: null, invalidate: vi.fn() });
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => H.results[queryName] ?? blank(),
}));
// The lexicon resolver is mocked to ECHO its key (so t('fleet') → 'fleet',
// t('contributor') → 'contributor') — isolates this test from the flag hook;
// classic pack renders 'Fleet'/'Cups' at runtime (restore-pot-lexicon P-005).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

// Rows now navigate via TanStack `<Link to search>` (client-side, no full reload)
// instead of plain `<a href>`. Mock Link to a real `<a>` whose href reflects the
// resolved `to` + `search` so the destination assertions below stay meaningful
// without standing up a full RouterProvider. `search` is the `(prev) => …` merge
// updater the component builds; resolve it against an empty base.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, children, ...rest }: { to: string; search?: unknown; children?: unknown }) => {
    const resolved = (typeof search === 'function' ? search(H.linkBase) : (search ?? {})) as Record<string, unknown>;
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(resolved)) {
      if (value != null && value !== '') qs.set(key, String(value));
    }
    const q = qs.toString();
    return (
      <a href={q ? `${to}?${q}` : to} {...rest}>
        {children as never}
      </a>
    );
  },
}));

import SwarmTab from './SwarmTab';

function seed(queryName: string, data: unknown[], extra: Partial<ReturnType<typeof blank>> = {}) {
  H.results[queryName] = { ...blank(), data, ...extra };
}

beforeEach(() => {
  nuqsState.lsa = null;
  H.results = {};
  H.linkBase = {};
});
afterEach(() => cleanup());

const PRESENCE = [
  { ownerId: 'su-1', ownerLabel: 'SU One', source: 'omp-hook-session', intent: 'driving', currentPlanSlug: null, heartbeatAt: 3, stale: false },
  { ownerId: 'bee-1', ownerLabel: 'Bee One', source: 'fleet-spawn', intent: 'refactoring', currentPlanSlug: null, heartbeatAt: 2, stale: false },
  { ownerId: 'bee-2', ownerLabel: 'Bee Two', source: 'fleet-spawn', intent: null, currentPlanSlug: null, heartbeatAt: 1, stale: false },
  { ownerId: 'ghost', ownerLabel: 'Ghost', source: 'fleet-spawn', intent: null, currentPlanSlug: null, heartbeatAt: 0, stale: true },
];

const BEES = [
  {
    agentId: 'bee-1', name: 'Bee One', alive: true, intent: 'refactoring', declaredPlanSlug: 'plan-a',
    claims: [
      { type: 'work-item', id: 'WI-1', harnessSlug: 'pot-a', planSlug: 'plan-a' },
      { type: 'work-item', id: 'WI-2', harnessSlug: 'pot-a', planSlug: 'plan-b' },
    ], load: 2,
    queued: [
      { id: 'WI-1', title: 'fix the thing', status: 'wip', rank: 1 },
      { id: 'WI-2', title: 'write tests', status: 'queued', rank: 2 },
    ],
  },
  { agentId: 'bee-2', name: 'Bee Two', alive: true, intent: null, load: 1, queued: [{ id: 'WI-3', title: 'review', status: 'queued', rank: 1 }] },
];

const PLANS = [
  { slug: 'plan-a', harness: 'pot-a', archived: false, priority: 5, itemCounts: { todo: 1, done: 3, blocked: 0, failed: 0 } },
  { slug: 'plan-b', harness: 'pot-a', archived: false, priority: 1, itemCounts: { todo: 2, done: 0 } },
  { slug: 'plan-archived', archived: true, itemCounts: { todo: 1, done: 1 } },
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

  it('splits SU agents from bees, excludes stale, shows load pill + intent fallback', () => {
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    render(<SwarmTab active={true} />);
    expect(screen.getByText('fleet · 3 live')).toBeTruthy();
    expect(screen.getByTestId('swarm-su').textContent).toContain('SU One');
    const beeSec = screen.getByTestId('swarm-bees');
    expect(beeSec.textContent).toContain('Bee One');
    expect(beeSec.textContent).toContain('Bee Two');
    expect(screen.queryByTestId('swarm-agent-ghost')).toBeNull();
    expect(screen.getByTestId('swarm-agent-bee-1').textContent).toContain('⇄2');
    expect(screen.getByTestId('swarm-agent-bee-2').textContent).toContain('no declared intent');
  });
});

describe('<SwarmTab> selection + expansion', () => {
  it('clicking an agent row writes ?lsa', () => {
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    render(<SwarmTab active={true} />);
    fireEvent.click(screen.getByTestId('swarm-agent-bee-1'));
    expect(nuqsSetters.lsa).toHaveBeenCalledWith('bee-1');
  });

  it('re-clicking the selected agent clears it (toggle off)', () => {
    nuqsState.lsa = 'bee-1';
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    render(<SwarmTab active={true} />);
    fireEvent.click(screen.getByTestId('swarm-agent-bee-1'));
    expect(nuqsSetters.lsa).toHaveBeenCalledWith(null);
  });

  it('the selected agent expands inline with its tasks + plan progress', () => {
    nuqsState.lsa = 'bee-1';
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    seed('plans.list', PLANS);
    render(<SwarmTab active={true} />);
    const exp = screen.getByTestId('swarm-expand-bee-1');
    expect(exp.textContent).toContain('fix the thing');
    expect(exp.textContent).toContain('plan-a');
    expect(exp.textContent).toContain('3/4'); // plan-a done/total
    expect(exp.textContent).not.toContain('plan-archived');
    // a non-selected agent has no expansion.
    expect(screen.queryByTestId('swarm-expand-bee-2')).toBeNull();
  });

  it('links tasks and plans to their full detail surfaces', () => {
    nuqsState.lsa = 'bee-1';
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    seed('plans.list', PLANS);
    render(<SwarmTab active={true} />);

    expect(screen.getByRole('link', { name: /open task WI-1/i }).getAttribute('href')).toBe(
      '/adv?tab=harnesses&slug=pot-a&scope=self&sel=WI-1',
    );
    expect(screen.getByRole('link', { name: /open plan plan-a/i }).getAttribute('href')).toBe(
      '/admin/plans?view=plans&plan=plan-a&h=pot-a',
    );
  });

  it('row links MERGE over the live URL — the rail’s own state (lsb/lst/lsa) survives the click, no full reload', () => {
    // Reproduces the owner bug: clicking a row used to be a plain <a href> that
    // (a) hard-reloaded and (b) dropped the sidebar state. The Link now merges
    // content params over the current search, so the rail stays open/expanded
    // while only the right-pane params change.
    H.linkBase = { lsb: 'true', lst: 'swarm', lsa: 'bee-1', tab: 'overview' };
    nuqsState.lsa = 'bee-1';
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    seed('plans.list', PLANS);
    render(<SwarmTab active={true} />);

    const taskHref = screen.getByRole('link', { name: /open task WI-1/i }).getAttribute('href') ?? '';
    const params = new URLSearchParams(taskHref.split('?')[1] ?? '');
    // rail state preserved…
    expect(params.get('lsb')).toBe('true');
    expect(params.get('lst')).toBe('swarm');
    expect(params.get('lsa')).toBe('bee-1');
    // …content params applied / overridden (was tab=overview)…
    expect(taskHref.startsWith('/adv?')).toBe(true);
    expect(params.get('tab')).toBe('harnesses');
    expect(params.get('slug')).toBe('pot-a');
    expect(params.get('sel')).toBe('WI-1');
  });

  it('folds the selected agent’s recent comms into the expansion', () => {
    nuqsState.lsa = 'bee-1';
    seed('dev.coordPresence', PRESENCE);
    seed('sidebar.fleetBees', BEES);
    seed('sidebar.beeMail', [
      { owner: 'bee-1', inbox: [{ msg_id: 'm-in', from: 'mug', kind: 'task', summary: 'do X' }], outbox: [{ msg_id: 'm-out', to: ['mug'], kind: 'ack', summary: 'done Y' }] },
    ]);
    render(<SwarmTab active={true} />);
    const exp = screen.getByTestId('swarm-expand-bee-1');
    expect(exp.textContent).toContain('do X');
    expect(exp.textContent).toContain('done Y');
    expect(screen.getByRole('link', { name: /open inbound message from mug/i }).getAttribute('href')).toBe(
      '/adv?tab=conversations&conv=feed&fagent=bee-1&fmsg=m-in',
    );
    expect(screen.getByRole('link', { name: /open outbound message to mug/i }).getAttribute('href')).toBe(
      '/adv?tab=conversations&conv=feed&fagent=bee-1&fmsg=m-out',
    );
  });
});
