// @vitest-environment jsdom
/**
 * SwarmTab coverage — the Fleet pane: the roster GROUPED BY FLEET and colored by
 * the fleet's accent (WI-4463), each row expanding inline to its tasks +
 * plan-progress + comms. Pins: roster (empty/error/live + load pill + intent
 * fallback + stale excluded unless loop-armed), the fleet grouping + coloring +
 * ordering ("No fleet" last), kind glyphs, selection (?lsa write + toggle), the
 * inline expansion, and — the regression this pane was rebuilt around — that
 * EVERY message row deep-links into the feed at that message, including
 * agent-authored ones (WI-4462, ?fsys=all).
 *
 * nuqs is a per-key store seeded with spy setters; sync queries are dispatched by
 * queryName.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const nuqsState: Record<string, unknown> = { lsa: null };
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
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
// The lexicon resolver is mocked to ECHO its key (so t('fleet') → 'fleet') —
// isolates this test from the flag hook; classic pack renders 'Fleet' at runtime.
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

/** advRoster.list rows — fleet-stamped (fleetSlug + fleetColor) by the server. */
const ROSTER = [
  { ownerId: 'su-1', label: 'SU One', agentPaneKind: 'su', role: 'su', intent: 'driving', currentPlanSlug: null, liveness: 'live', fleetSlug: null, fleetColor: null },
  { ownerId: 'bee-1', label: 'Bee One', agentPaneKind: 'cup', role: 'cup', intent: 'refactoring', currentPlanSlug: null, liveness: 'live', fleetSlug: 'alpha', fleetColor: '#e11d48' },
  { ownerId: 'bee-2', label: 'Bee Two', agentPaneKind: 'cup', role: 'cup', intent: '', currentPlanSlug: null, liveness: 'idle', fleetSlug: 'alpha', fleetColor: '#e11d48' },
  { ownerId: 'mug-1', label: 'Mug', agentPaneKind: 'mug', role: 'mug', intent: 'steering', currentPlanSlug: null, liveness: 'live', fleetSlug: 'zeta', fleetColor: '#22d3ee' },
  // Heartbeat-stale AND not loop-armed → excluded (isRunningAgent).
  { ownerId: 'ghost', label: 'Ghost', agentPaneKind: 'cup', role: 'cup', intent: '', currentPlanSlug: null, liveness: 'stale', fleetSlug: 'alpha', fleetColor: '#e11d48' },
  // Stale BUT loop-armed → still running (it wakes on a cadence).
  { ownerId: 'looper', label: 'Looper', agentPaneKind: 'su', role: 'su', intent: 'looping', currentPlanSlug: null, liveness: 'stale', loopArmed: true, fleetSlug: null, fleetColor: null },
];
const roster = (active: unknown[] = ROSTER) => [{ active }];

const CUPS = [
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

  it('surfaces a roster error', () => {
    seed('advRoster.list', [], { error: 'coord down' });
    render(<SwarmTab active={true} />);
    expect(screen.getByText(/coord down/)).toBeTruthy();
  });

  it('excludes the stale agent, keeps a stale-but-loop-armed one, shows load pill + intent fallback', () => {
    seed('advRoster.list', roster());
    seed('sidebar.fleetCups', CUPS);
    render(<SwarmTab active={true} />);
    expect(screen.getByText('fleet · 5 live')).toBeTruthy();
    expect(screen.queryByTestId('swarm-agent-ghost')).toBeNull();
    expect(screen.getByTestId('swarm-agent-looper')).toBeTruthy();
    expect(screen.getByTestId('swarm-agent-bee-1').textContent).toContain('⇄2');
    // bee-2 has no intent on either the roster or its cup row → the fallback.
    expect(screen.getByTestId('swarm-agent-bee-2').textContent).toContain('no declared intent');
  });
});

describe('<SwarmTab> fleet grouping (WI-4463)', () => {
  it('groups agents by fleet, ordered alpha with "No fleet" last', () => {
    seed('advRoster.list', roster());
    render(<SwarmTab active={true} />);
    const heads = [...document.querySelectorAll('.pclsb-fleet__head')].map((el) => el.textContent ?? '');
    expect(heads).toHaveLength(3);
    expect(heads[0]).toContain('alpha');
    expect(heads[1]).toContain('zeta');
    expect(heads[2]).toContain('No fleet'); // always last
    // …and each group is counted.
    expect(heads[0]).toContain('(2)'); // bee-1 + bee-2 (ghost is stale)
    expect(heads[2]).toContain('(2)'); // su-1 + looper
  });

  it('inherits the fleet color — group head + a per-row accent — from the roster stamp', () => {
    // jsdom's CSSOM serializes a hex color to its rgb() form, so assert on that
    // (the component passes the server's hex straight through, untouched).
    const ALPHA = 'rgb(225, 29, 72)'; // #e11d48
    const ZETA = 'rgb(34, 211, 238)'; // #22d3ee
    seed('advRoster.list', roster());
    render(<SwarmTab active={true} />);
    const alpha = screen.getByTestId('swarm-fleet-alpha');
    expect(alpha.querySelector('.pclsb-fleet__head')?.getAttribute('style')).toContain(ALPHA);
    expect(alpha.querySelector('.pclsb-fleet__dot')?.getAttribute('style')).toContain(ALPHA);
    // The row itself carries the fleet accent, so an agent is identifiable as
    // fleet-alpha's without reading the header.
    expect(screen.getByTestId('swarm-agent-bee-1').getAttribute('style')).toContain(ALPHA);
    expect(screen.getByTestId('swarm-agent-mug-1').getAttribute('style')).toContain(ZETA);
    // The unfleeted group has no color to inherit — and must not invent one.
    expect(screen.getByTestId('swarm-agent-su-1').getAttribute('style') ?? '').not.toContain('rgb');
  });

  it('renders each agent with its cup-cast kind glyph (not a binary SU/Cup icon)', () => {
    seed('advRoster.list', roster());
    render(<SwarmTab active={true} />);
    expect(screen.getByTestId('swarm-agent-mug-1').textContent).toContain('☕'); // mug
    expect(screen.getByTestId('swarm-agent-bee-1').textContent).toContain('🍵'); // worker cup
    expect(screen.getByTestId('swarm-agent-su-1').textContent).toContain('🛠'); // su
  });
});

describe('<SwarmTab> selection + expansion', () => {
  it('clicking an agent row writes ?lsa', () => {
    seed('advRoster.list', roster());
    seed('sidebar.fleetCups', CUPS);
    render(<SwarmTab active={true} />);
    fireEvent.click(screen.getByTestId('swarm-agent-bee-1'));
    expect(nuqsSetters.lsa).toHaveBeenCalledWith('bee-1');
  });

  it('re-clicking the selected agent clears it (toggle off)', () => {
    nuqsState.lsa = 'bee-1';
    seed('advRoster.list', roster());
    seed('sidebar.fleetCups', CUPS);
    render(<SwarmTab active={true} />);
    fireEvent.click(screen.getByTestId('swarm-agent-bee-1'));
    expect(nuqsSetters.lsa).toHaveBeenCalledWith(null);
  });

  it('the selected agent expands inline with its tasks + plan progress', () => {
    nuqsState.lsa = 'bee-1';
    seed('advRoster.list', roster());
    seed('sidebar.fleetCups', CUPS);
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
    seed('advRoster.list', roster());
    seed('sidebar.fleetCups', CUPS);
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
    seed('advRoster.list', roster());
    seed('sidebar.fleetCups', CUPS);
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
});

describe('<SwarmTab> message deep-links (WI-4462)', () => {
  const MAIL = [
    {
      owner: 'bee-1',
      inbox: [
        { msg_id: 'm-sys', from: 'system-watchdog', kind: 'message', summary: 'routine overdue' },
        { msg_id: 'm-in', from: 'su-9', kind: 'task', summary: 'do X' },
      ],
      outbox: [{ msg_id: 'm-out', to: ['mug'], kind: 'ack', summary: 'done Y' }],
    },
  ];

  it('folds the selected agent’s recent comms into the expansion', () => {
    nuqsState.lsa = 'bee-1';
    seed('advRoster.list', roster());
    seed('sidebar.fleetCups', CUPS);
    seed('sidebar.cupMail', MAIL);
    render(<SwarmTab active={true} />);
    const exp = screen.getByTestId('swarm-expand-bee-1');
    expect(exp.textContent).toContain('do X');
    expect(exp.textContent).toContain('done Y');
  });

  it('EVERY message deep-links to the feed at that message — agent-authored ones carry fsys=all so the row can actually resolve', () => {
    // The bug: the feed hardcoded system_only, so only a system-* sender's message
    // existed as a feed row. An agent-authored message (from: su-9) deep-linked to a
    // row the server had filtered out — the tab opened at the newest head with
    // nothing expanded, while the system-watchdog row right above it worked. Every
    // row must now widen the feed's sender scope, so ALL of them behave the same.
    nuqsState.lsa = 'bee-1';
    seed('advRoster.list', roster());
    seed('sidebar.fleetCups', CUPS);
    seed('sidebar.cupMail', MAIL);
    render(<SwarmTab active={true} />);

    const links = [
      screen.getByRole('link', { name: /open inbound message from system-watchdog/i }),
      screen.getByRole('link', { name: /open inbound message from su-9/i }),
      screen.getByRole('link', { name: /open outbound message to mug/i }),
    ];
    const expected = ['m-sys', 'm-in', 'm-out'];
    links.forEach((link, i) => {
      const params = new URLSearchParams((link.getAttribute('href') ?? '').split('?')[1] ?? '');
      expect(params.get('tab')).toBe('conversations');
      expect(params.get('conv')).toBe('feed');
      expect(params.get('fagent')).toBe('bee-1');
      expect(params.get('fmsg')).toBe(expected[i]);
      // …the fix: without this the agent-authored rows land on nothing.
      expect(params.get('fsys')).toBe('all');
    });
  });

  it('a message with no msg_id renders as plain text, never as a link that lands nowhere', () => {
    nuqsState.lsa = 'bee-1';
    seed('advRoster.list', roster());
    seed('sidebar.fleetCups', CUPS);
    seed('sidebar.cupMail', [{ owner: 'bee-1', inbox: [{ from: 'su-9', kind: 'task', summary: 'unaddressable' }], outbox: [] }]);
    render(<SwarmTab active={true} />);
    expect(screen.getByTestId('swarm-expand-bee-1').textContent).toContain('unaddressable');
    expect(screen.queryByRole('link', { name: /open inbound message/i })).toBeNull();
  });
});
