/**
 * @vitest-environment jsdom
 *
 * AgentOrders (session-chat-popup-direction-d-2026-08-02 P-014) — the LEFT
 * "what the agent was told" panel.
 *
 * These tests deliberately assert the panel's THESIS rather than its markup,
 * because the panel exists to prevent three specific misreadings and each is a
 * silent failure if it regresses:
 *
 *   1. THREE STATES, NEVER TWO (plan D-003). "the read failed", "genuinely
 *      none", and "the agent never wrote one" are three different conclusions
 *      about an agent's health. A regression that collapses any pair renders
 *      something perfectly plausible, so only an assertion that they differ
 *      catches it.
 *   2. STALENESS IS GRADED BY CARRY MODE. For a COLD agent the checkpoint IS
 *      its memory across wakes, so the same age is a nuisance warm and a
 *      correctness problem cold.
 *   3. AN EMPTY SECTION STILL NAMES WHAT IT WOULD HOLD ([owner 2026-08-02,
 *      verbatim] "So make a spot for all these things") — an absent section
 *      teaches a reader nothing; a named empty one teaches that the signal
 *      exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import AgentOrders from '../AgentOrders';
import { carryStaleness, formatAgeShort, type AgentOrders as AgentOrdersDTO } from '../use-agent-orders';

const syncState = vi.hoisted(() => ({
  orders: null as AgentOrdersDTO | null,
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { enabled?: boolean }) => ({
    data: opts.enabled === false || !syncState.orders ? null : [syncState.orders],
    loading: false,
    error: null,
    fetching: false,
    refetch: () => {},
  }),
  notifySyncInvalidate: () => {},
}));

const MIN = 60_000;

const BASE: AgentOrdersDTO = {
  ownerId: 'su-1',
  mission: {
    constraint: 'execute-owner-directed-scope',
    source: 'route:self',
    explanation: 'Advance the current owner-directed task.',
    authority: 'confirm-before-execution',
    authoritySource: 'generic-playbook',
    route: 'self',
  },
  modes: [{ mode: 'auto', reason: 'owner said so', setBy: 'owner', ownerDirected: true, setAt: null }],
  wakeMode: { effective: 'auto', overridden: false, defaultMode: 'auto' },
  walls: [],
  directives: [],
  facts: [],
  carry: {
    mode: 'warm',
    generation: 3,
    loopActive: true,
    loopIntervalSec: 60,
    note: 'did the thing; left the other thing',
    noteUpdatedAtMs: Date.now() - 2 * MIN,
    neverWritten: false,
  },
  unavailable: [],
};

const setOrders = (patch: Partial<AgentOrdersDTO>) => {
  syncState.orders = { ...BASE, ...patch };
};

describe('AgentOrders', () => {
  beforeEach(() => {
    syncState.orders = BASE;
  });
  afterEach(() => cleanup());

  describe('three states, never two (D-003)', () => {
    it('distinguishes a FAILED read from a genuinely-empty one — the two must never render alike', () => {
      // Genuinely empty: we asked, the answer was "none".
      setOrders({ mission: null, unavailable: [] });
      const empty = render(<AgentOrders ownerId="su-1" />);
      expect(empty.getByText('No resolved mission on record.')).toBeTruthy();
      expect(empty.queryByTestId('orders-unavailable')).toBeNull();
      cleanup();

      // Failed read: we could not ask. Opposite conclusion about the agent.
      setOrders({ mission: null, unavailable: ['mission'] });
      const broken = render(<AgentOrders ownerId="su-1" />);
      expect(broken.getByTestId('orders-unavailable').textContent).toContain('not “none”');
      expect(broken.queryByText('No resolved mission on record.')).toBeNull();
    });

    it('distinguishes "never wrote a carry-note" from both — a finding about the AGENT, not our data', () => {
      setOrders({
        carry: { ...BASE.carry!, note: null, noteUpdatedAtMs: null, neverWritten: true },
      });
      const { getByTestId, queryByTestId } = render(<AgentOrders ownerId="su-1" />);
      const never = getByTestId('orders-carry-never');
      expect(never.textContent).toContain('No carry-note ever written');
      // …and because the loop IS armed, it names the consequence rather than
      // leaving the reader to infer it.
      expect(never.textContent).toContain('cold wake would start blank');
      expect(queryByTestId('orders-unavailable')).toBeNull();
    });

    it('does not warn about a blank cold wake when no loop is armed — the consequence is conditional', () => {
      setOrders({
        carry: { ...BASE.carry!, note: null, noteUpdatedAtMs: null, neverWritten: true, loopActive: false },
      });
      const { getByTestId } = render(<AgentOrders ownerId="su-1" />);
      expect(getByTestId('orders-carry-never').textContent).not.toContain('cold wake');
    });
  });

  describe('staleness graded against carry mode', () => {
    it('grades the SAME age harder for a cold agent, because cold carry makes the note its only memory', () => {
      const age = 10 * MIN;
      // Warm: 10m is nothing — the live context survives the wake.
      expect(carryStaleness(age, 'warm')).toBe('fresh');
      // Cold: the same 10m already erodes the agent's entire memory.
      expect(carryStaleness(age, 'cold')).toBe('aging');
      // And far enough out, cold is outright stale while warm is merely aging.
      expect(carryStaleness(30 * MIN, 'cold')).toBe('stale');
      expect(carryStaleness(30 * MIN, 'warm')).toBe('aging');
    });

    it('returns unknown for an unusable age rather than inventing a verdict', () => {
      // A negative age means clock skew; guessing "fresh" there would be a lie
      // in the reassuring direction, which is the dangerous one.
      expect(carryStaleness(null, 'warm')).toBe('unknown');
      expect(carryStaleness(-1, 'warm')).toBe('unknown');
      expect(carryStaleness(Number.NaN, 'cold')).toBe('unknown');
    });

    it('renders the note age as a verdict-bearing chip, not a bare number', () => {
      setOrders({
        carry: { ...BASE.carry!, mode: 'cold', noteUpdatedAtMs: Date.now() - 45 * MIN },
      });
      const { container } = render(<AgentOrders ownerId="su-1" />);
      const chip = container.querySelector('.pc-orders__age')!;
      // 45m on a COLD agent is stale — the chip carries the judgement so a
      // glance cannot miss it.
      expect(chip.getAttribute('data-verdict')).toBe('stale');
      expect(chip.textContent).toBe('45m');
    });

    it('formatAgeShort stays readable across scales and refuses an impossible age', () => {
      expect(formatAgeShort(30_000)).toBe('just now');
      expect(formatAgeShort(5 * MIN)).toBe('5m');
      expect(formatAgeShort(3 * 60 * MIN + 12 * MIN)).toBe('3h 12m');
      expect(formatAgeShort(2 * 24 * 60 * MIN)).toBe('2d');
      expect(formatAgeShort(-5)).toBeNull();
      expect(formatAgeShort(null)).toBeNull();
    });
  });

  describe('the sections that answer a question nothing else can', () => {
    it('shows a SUPPRESSED playbook rule — otherwise a suppressed rule is indistinguishable from a disobeyed one', () => {
      setOrders({
        mission: {
          ...BASE.mission!,
          suppressed: [
            { key: 'mission', value: 'generic-backlog-selection', source: 'generic-playbook', reason: 'owner scope wins' },
          ],
        },
      });
      const { getByTestId } = render(<AgentOrders ownerId="su-1" />);
      expect(getByTestId('orders-suppressed').textContent).toContain('generic-backlog-selection');
    });

    it('flags cited refs that have since gone terminal — the #1 stale-conclusion tell', () => {
      setOrders({
        carry: { ...BASE.carry!, citedRefs: ['WI-1', 'WI-2'], citedRefsTerminal: ['WI-2'] },
      });
      const { getByTestId } = render(<AgentOrders ownerId="su-1" />);
      const drift = getByTestId('orders-cited-drift');
      expect(drift.textContent).toContain('WI-2');
      // Only the ones that actually moved — naming every cited ref would make
      // the warning noise and train the reader to ignore it.
      expect(drift.textContent).not.toContain('WI-1');
    });

    it('warns that the note PREDATES messages that arrived after it', () => {
      setOrders({
        carry: { ...BASE.carry!, postNoteInbox: { count: 3, lines: [] } },
      });
      const { getByText } = render(<AgentOrders ownerId="su-1" />);
      expect(getByText(/3 directed messages — the note predates them/)).toBeTruthy();
    });

    it('marks an UNVERIFIED carried check as predicted rather than letting it read as established', () => {
      setOrders({
        carry: {
          ...BASE.carry!,
          checks: [
            { claim: 'gate is green', recheck: 'read the verdict' },
            { claim: 'tests pass', recheck: 'npm test', verified: 'ran 30/30 at 15:14Z' },
          ],
        },
      });
      const { container } = render(<AgentOrders ownerId="su-1" />);
      const glyphs = Array.from(container.querySelectorAll('.pc-orders__glyph'))
        .map((n) => n.textContent)
        .filter((t) => t === '?' || t === '✓');
      // A predicted claim and a verified one must not look the same — the
      // whole value of a carried check is knowing which it is.
      expect(glyphs).toContain('?');
      expect(glyphs).toContain('✓');
    });

    it('distinguishes an owner-directed mode from one the agent set on itself', () => {
      setOrders({
        modes: [
          { mode: 'auto', reason: null, setBy: 'owner', ownerDirected: true, setAt: null },
          { mode: 'ideate', reason: null, setBy: 'su-1', ownerDirected: false, setAt: null },
        ],
      });
      const { getByText } = render(<AgentOrders ownerId="su-1" />);
      // Different authority — an agent that put ITSELF in a mode is a
      // different fact from one the owner directed.
      expect(getByText('owner')).toBeTruthy();
      expect(getByText('self')).toBeTruthy();
    });

    it('warns that a MANUAL-wake agent stages messages, because the composer above reports "Sent" either way', () => {
      setOrders({ wakeMode: { effective: 'manual', overridden: true, defaultMode: 'auto' } });
      const { getByTestId } = render(<AgentOrders ownerId="su-1" />);
      expect(getByTestId('orders-wake-mode').textContent).toContain('staged for you to release');
    });
  });

  describe('empty sections still name what they would hold (owner ask)', () => {
    it('renders every section with an empty-but-named state rather than omitting them', () => {
      setOrders({ modes: [], directives: [], facts: [], walls: [] });
      const { container, getByText } = render(<AgentOrders ownerId="su-1" />);
      for (const id of ['pc-orders-mission', 'pc-orders-modes', 'pc-orders-directives', 'pc-orders-facts', 'pc-orders-carry']) {
        expect(container.querySelector(`#${id}`)).toBeTruthy();
      }
      // An absent section teaches nothing; a named empty one teaches that the
      // signal exists and is currently clear.
      expect(getByText('No open owner directives.')).toBeTruthy();
      expect(getByText('No modes registered — default posture.')).toBeTruthy();
    });

    it('skips the fetch entirely while collapsed — the reason orders is a separate query', () => {
      const { queryByTestId } = render(<AgentOrders ownerId="su-1" enabled={false} />);
      // enabled:false ⇒ the sync mock returns no data ⇒ no sections render.
      expect(queryByTestId('orders-suppressed')).toBeNull();
      expect(queryByTestId('orders-wake-mode')).toBeNull();
    });
  });
});
