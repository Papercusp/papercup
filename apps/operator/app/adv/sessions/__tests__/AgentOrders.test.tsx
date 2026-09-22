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
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AgentOrders from '../AgentOrders';
import { carryStaleness, formatAgeShort, type AgentOrders as AgentOrdersDTO } from '../use-agent-orders';

/* The rail's section collapse is nuqs-backed (rail-sections.tsx) — user-
   meaningful state belongs in the URL, so this suite needs a nuqs stub. Backed
   by a REAL useState rather than a frozen value, for the same reason
   AgentDossier.test.tsx gives: a stub that cannot change state would let a
   "clicking the cap collapses it" assertion pass against a dead toggle. The
   parser exports come from the shared mock so this suite can never red on a
   parser IT does not use (EI-8821). */
vi.mock('nuqs', async () => {
  const React = await import('react');
  const { nuqsParsers } = await import('@papercusp/test-config/nuqs-mock');
  return {
    ...nuqsParsers,
    useQueryState: (_key: string, parser?: { defaultValue?: unknown }) =>
      React.useState<string | null>((parser?.defaultValue as string | undefined) ?? null),
  };
});

const syncState = vi.hoisted(() => ({
  orders: null as AgentOrdersDTO | null,
}));
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
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
    it('does not invent a mission for an owner absent from roster and session history', () => {
      setOrders(BASE);
      const { getByTestId, queryByText } = render(
        <AgentOrders ownerId="su-never-existed" ownerKnown={false} />,
      );
      expect(getByTestId('orders-owner-unknown').textContent).toContain(
        'No agent with this id was found in the current roster or session history.',
      );
      expect(queryByText('execute-owner-directed-scope')).toBeNull();
    });

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
      const { container } = render(<AgentOrders ownerId="su-1" />);
      // Scoped to the Modes section on purpose: the Mission section's `route`
      // is also the literal string "self", so an unscoped getByText matches two
      // unrelated elements and passes for the wrong reason.
      const modes = within(container.querySelector('#pc-orders-modes') as HTMLElement);
      // Different authority — an agent that put ITSELF in a mode is a
      // different fact from one the owner directed.
      expect(modes.getByText('owner')).toBeTruthy();
      expect(modes.getByText('self')).toBeTruthy();
    });

    it('warns that a MANUAL-wake agent stages messages, because the composer above reports "Sent" either way', () => {
      setOrders({ wakeMode: { effective: 'manual', overridden: true, defaultMode: 'auto' } });
      const { getByTestId } = render(<AgentOrders ownerId="su-1" />);
      expect(getByTestId('orders-wake-mode').textContent).toContain('staged for you to release');
    });
  });

  describe('empty sections still name what they would hold (owner ask)', () => {
    it('renders every section with an empty-but-named state rather than omitting them', () => {
      // `carry: null` explicitly — BASE ships a populated carry object, so
      // without this the carry section is legitimately a CARD and asserting it
      // quiet would be asserting against the fixture rather than the branch.
      setOrders({ modes: [], directives: [], facts: [], walls: [], carry: null });
      const { container, getByText, getByTestId } = render(<AgentOrders ownerId="su-1" />);

      // Sections that always carry content stay as cards.
      for (const id of ['pc-orders-mission', 'pc-orders-modes']) {
        expect(container.querySelector(`#${id}`)).toBeTruthy();
      }
      expect(getByText('No modes registered — default posture.')).toBeTruthy();

      /* The owner's principle is that an empty signal is NAMED, not omitted —
         "an empty section that NAMES what it would hold is how a reader learns
         the signal exists". P-005 changed the SHAPE that principle takes for a
         settled section (a card became one quiet line, Treatment C3) without
         changing the principle, so this asserts the name + the "none" wording
         are still on screen rather than asserting a <section> exists. That
         distinction is the whole point: pinning the principle to the card is
         what would have made a correct design change look like a regression. */
      for (const [testId, label, none] of [
        ['rail-quiet-directives', 'Owner directives', 'none open'],
        ['rail-quiet-facts', 'Standing facts', 'none in scope'],
        ['rail-quiet-walls', 'Walls', 'nothing blocked on you'],
        ['rail-quiet-carry', 'Carry', 'no carry state'],
      ] as const) {
        const quiet = getByTestId(testId);
        expect(quiet.textContent).toContain(label);
        expect(quiet.textContent).toContain(none);
        // …and it is genuinely NOT a framed card any more, which is the saving.
        expect(quiet.closest('.pc-orders__sec')).toBeNull();
      }
    });

    /* ── the quiet-empty rule (P-005 / Treatment C3) ──────────────────────────
       The rule is only safe because of what it REFUSES to quiet. The frame is
       what encodes "there is something here", so a section that could not be
       READ, or whose emptiness is itself the finding, has to keep its card —
       plan D-003's three-state rule. These are the guards; without them the
       branch silently files "I don't know" under "calm". */
    it('keeps the CARD when a section could not be read — never quieter than "none"', () => {
      setOrders({ carry: null, unavailable: ['carry'] });
      const { container, queryByTestId, getByTestId } = render(<AgentOrders ownerId="su-1" />);
      expect(queryByTestId('rail-quiet-carry')).toBeNull();
      expect(container.querySelector('#pc-orders-carry')).toBeTruthy();
      expect(getByTestId('orders-unavailable')).toBeTruthy();
    });

    it('keeps the CARD when a section wants the reader — data-attn is the opposite of quiet', () => {
      setOrders({
        // A COMPLETE AgentOrdersDirective, for the same reason as the carry
        // fixture below: `setOrders` takes a shallow Partial, so every field of a
        // supplied member is required. `id` is a NUMBER (the directive row's pk),
        // not a string handle — vitest never checks types, so both defects sat
        // here green until the tsc baseline caught up.
        directives: [
          {
            id: 1,
            verbatimText: 'do the thing',
            recordedBy: 'owner',
            createdAtMs: Date.now(),
            sourceTurnRef: null,
            dispositionStatus: null,
          },
        ],
        directivesTotalOpen: 1,
        walls: [{ claim: 'owner must settle' }],
      });
      const { container, queryByTestId } = render(<AgentOrders ownerId="su-1" />);
      for (const [quietId, sectionId] of [
        ['rail-quiet-directives', 'pc-orders-directives'],
        ['rail-quiet-walls', 'pc-orders-walls'],
      ] as const) {
        expect(queryByTestId(quietId)).toBeNull();
        const section = container.querySelector(`#${sectionId}`);
        expect(section).toBeTruthy();
        expect(section!.getAttribute('data-attn')).toBe('true');
      }
    });

    it('keeps the CARD for a carry-note that was NEVER written — an emptiness that is the news', () => {
      // An agent looping with no carry-note loses its thread at the next cold
      // wake. That is a finding shaped like emptiness, and quieting it would
      // hide the one state this section exists to catch.
      // `setOrders` takes a SHALLOW Partial, so a supplied `carry` must be a
      // COMPLETE AgentOrdersCarry — the omitted fields were not defaults, they
      // were a type error vitest cannot see. Spelled out rather than spread from
      // BASE because the nulls are the fixture's whole point: never-written means
      // there is no note and no note timestamp.
      setOrders({
        carry: {
          mode: 'cold',
          generation: null,
          loopActive: true,
          loopIntervalSec: 60,
          note: null,
          noteUpdatedAtMs: null,
          neverWritten: true,
        },
      });
      const { container, queryByTestId, getByTestId } = render(<AgentOrders ownerId="su-1" />);
      expect(queryByTestId('rail-quiet-carry')).toBeNull();
      expect(container.querySelector('#pc-orders-carry')).toBeTruthy();
      expect(getByTestId('orders-carry-never').textContent).toContain('cold wake would start blank');
    });

    it('groups the sections under the two cluster labels (Treatment C3)', () => {
      setOrders({});
      const { getByText } = render(<AgentOrders ownerId="su-1" />);
      expect(getByText('What they were told')).toBeTruthy();
      expect(getByText('What they’re carrying')).toBeTruthy();
    });

    it('skips the fetch entirely while collapsed — the reason orders is a separate query', () => {
      const { queryByTestId } = render(<AgentOrders ownerId="su-1" enabled={false} />);
      // enabled:false ⇒ the sync mock returns no data ⇒ no sections render.
      expect(queryByTestId('orders-suppressed')).toBeNull();
      expect(queryByTestId('orders-wake-mode')).toBeNull();
    });
  });

  /* ── Sections that get big ──────────────────────────────────────────────────
     [owner 2026-08-02] "make sure the sections that get big have a good way to
     collapse and expand them", against the complaint the whole redesign started
     from [owner 2026-08-01]: "the coord section and others take up huge vertical
     space if its a long list, thats bad".

     TWO mechanisms, and BOTH are asserted, because each covers a reader the
     other misses: the cap-as-toggle serves someone who folds a section they
     never read, and the height bound serves someone who never clicks anything —
     which is the reader who complained. Shipping only the toggle would look like
     a fix and leave the original complaint intact for the default view. */
  describe('sections that get big can be collapsed (owner ask 2026-08-02)', () => {
    it('folds a section away when its cap is clicked, and brings it back on the next click', () => {
      setOrders({});
      const { getByTestId, container } = render(<AgentOrders ownerId="su-1" />);
      const section = container.querySelector('#pc-orders-modes')!;

      // Open by default: a rail that starts folded hides the signal it exists to
      // surface, and the reader has to learn what is behind six closed doors.
      expect(section.getAttribute('data-collapsed')).toBe('false');
      const toggle = getByTestId('rail-section-toggle-o-modes');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');

      fireEvent.click(toggle);
      expect(section.getAttribute('data-collapsed')).toBe('true');
      expect(getByTestId('rail-section-toggle-o-modes').getAttribute('aria-expanded')).toBe('false');

      fireEvent.click(getByTestId('rail-section-toggle-o-modes'));
      expect(container.querySelector('#pc-orders-modes')!.getAttribute('data-collapsed')).toBe('false');
    });

    it('keeps the COUNT visible while collapsed — folding Walls away must not hide that there are walls', () => {
      // The failure this guards is subtle and bad: a reader folds a section to
      // save space and thereby stops being told that something is blocked on
      // them. The count lives INSIDE the cap for exactly this reason.
      setOrders({
        walls: [
          { claim: 'P-006 — owner must settle', sinceMs: Date.now() - 30 * MIN },
          { claim: 'needs a credential only you hold' },
        ],
      });
      const { getByTestId } = render(<AgentOrders ownerId="su-1" />);
      fireEvent.click(getByTestId('rail-section-toggle-o-walls'));

      const cap = getByTestId('rail-section-toggle-o-walls');
      expect(cap.textContent).toContain('Walls');
      expect(cap.textContent).toContain('2');
      // …and the wall TEXT is what folded away, not the count.
      expect(cap.textContent).not.toContain('owner must settle');
    });

    it('toggles are real buttons with an accessible name that says what the click DOES', () => {
      // A chevron cannot be seen by a screen reader, and `aria-expanded` alone
      // does not say which section it belongs to.
      //
      // Asserted on a section that HAS content: since P-005 a settled section
      // renders as a quiet line with no toggle at all, and deliberately so —
      // there is no body to expand, and giving it the cap's affordance would
      // promise one. Facts are populated here for that reason, not incidentally.
      setOrders({ facts: [{ key: 'k', body: 'a standing fact' }] });
      const { getByTestId } = render(<AgentOrders ownerId="su-1" />);
      const toggle = getByTestId('rail-section-toggle-o-facts');
      expect(toggle.tagName).toBe('BUTTON');
      expect(toggle.getAttribute('aria-label')).toBe('Standing facts — collapse this section');
      fireEvent.click(toggle);
      expect(getByTestId('rail-section-toggle-o-facts').getAttribute('aria-label')).toBe(
        'Standing facts — expand this section',
      );
    });

    it('a SETTLED section offers no toggle — there is no body to expand', () => {
      setOrders({ facts: [] });
      const { queryByTestId, getByTestId } = render(<AgentOrders ownerId="su-1" />);
      expect(queryByTestId('rail-section-toggle-o-facts')).toBeNull();
      expect(getByTestId('rail-quiet-facts').tagName).toBe('P');
    });

    /**
     * popup-agent-state-coverage-2026-08-18 P-010 — where a verbatim owner
     * directive CAME FROM.
     *
     * `recordedBy` and `sourceTurnRef` were both on the DTO from the start and
     * neither reached the screen, so every quote rendered with exactly the
     * authority of every other one. `orders:record` sets `sourceTurnRef` only
     * when the verbatim text matched an owner-verified turn in the RECORDING
     * agent's own transcript; `recordedBy` is that agent, never the author. An
     * unanchored quote is therefore one an agent attributed to the owner with
     * nothing behind it — the shape WI-3532 traced from a note-to-self to "the
     * owner said" across seven compactions.
     */
    const directive = (over: Record<string, unknown> = {}) => ({
      id: 1,
      verbatimText: 'do the thing',
      recordedBy: 'su-feb2f556',
      createdAtMs: Date.now() - 5 * 60_000,
      sourceTurnRef: null as string | null,
      dispositionStatus: null as string | null,
      ...over,
    });

    it('P-010: names the recorder and the owner turn a directive is anchored to', () => {
      setOrders({
        directives: [directive({ sourceTurnRef: 'claude-9115cf8d@2026-08-19T02:23:49.760Z' })],
        directivesTotalOpen: 1,
      });
      const { getByTestId } = render(<AgentOrders ownerId="su-1" />);
      const prov = getByTestId('orders-directive-provenance');
      expect(prov.getAttribute('data-verified')).toBe('true');
      expect(prov.textContent).toContain('recorded by su-feb2f556');
      // The turn ref itself, not just a tick: it is what a reader takes to
      // sessions:search to read the actual words.
      expect(prov.textContent).toContain('claude-9115cf8d@2026-08-19T02:23:49.760Z');
    });

    it('P-010: says LOUDLY when a directive has no source turn — the absent case IS the finding', () => {
      // The one place this surface deliberately departs from D-010 §1 ("an
      // uncomputable value renders as nothing"). A missing duration is a
      // measurement nobody took; a missing anchor is a PROPERTY of the record.
      // Rendering nothing would leave an unanchored quote looking identical to a
      // verified one — which is exactly the status quo being replaced.
      setOrders({ directives: [directive({ sourceTurnRef: null })], directivesTotalOpen: 1 });
      const { getByTestId } = render(<AgentOrders ownerId="su-1" />);
      const prov = getByTestId('orders-directive-provenance');
      expect(prov.getAttribute('data-verified')).toBe('false');
      expect(prov.textContent).toContain('no source turn on record');
      // A provenance report, never an accusation: many rows legitimately predate
      // the stamp, and calling them false would be its own fabrication.
      expect(prov.textContent).not.toMatch(/fake|false|fabricat|invalid/i);
      expect(prov.getAttribute('title')).toContain('It may still be genuine');
    });

    /**
     * P-011 — the CONTESTED marker, BESIDE "source drifted" rather than instead
     * of it. The two answer different questions and a fact can carry both.
     */
    it('P-011: marks a contested fact without suppressing the fact itself', () => {
      setOrders({
        facts: [
          {
            key: 'k',
            body: 'a standing fact',
            contested: { settledUndecidable: false, settledBy: null, priorAuthors: ['su-a', 'su-b'], priorVersions: 3, note: 'two agents already wrote to this key' },
          },
        ],
      });
      const { getByTestId, getByText } = render(<AgentOrders ownerId="su-1" />);
      // MARK, NEVER SUPPRESS — a contested fact is not a false fact, and only
      // the reader can tell whether re-asserting over it is right.
      expect(getByText('a standing fact')).toBeTruthy();
      const badge = getByTestId('orders-fact-contested');
      expect(badge.textContent).toContain('contested');
      expect(badge.textContent).toContain('2 prior authors');
      expect(badge.getAttribute('title')).toContain('two agents already wrote to this key');
      expect(badge.getAttribute('data-undecidable')).toBeNull();
    });

    it('P-011: gives settled-undecidable its own word — it sends the reader somewhere else', () => {
      // An agent reading "contested" may go argue. One reading "settled
      // undecidable" knows someone already worked the question and concluded it
      // could not be settled — so the move is to go find the settledBy evidence.
      setOrders({
        facts: [
          {
            key: 'k',
            body: 'a standing fact',
            contested: { settledUndecidable: true, settledBy: 'a gate run on the real candidate', priorAuthors: [], priorVersions: 2, note: 'settled undecidable' },
          },
        ],
      });
      const { getByTestId } = render(<AgentOrders ownerId="su-1" />);
      const badge = getByTestId('orders-fact-contested');
      expect(badge.textContent).toContain('settled undecidable');
      expect(badge.getAttribute('data-undecidable')).toBe('true');
      // No prior authors ⇒ no author count invented. It reached the badge on the
      // undecidable leg, which needs no author threshold.
      expect(badge.textContent).not.toContain('prior author');
    });

    it('P-011: renders BOTH badges when a fact is drifted AND contested', () => {
      // Collapsing them into one "suspect" badge would tell the reader something
      // is wrong while hiding which of the two things to go do about it.
      setOrders({
        facts: [
          {
            key: 'k',
            body: 'a standing fact',
            possiblyStale: true,
            contested: { settledUndecidable: false, settledBy: null, priorAuthors: ['su-a', 'su-b'], priorVersions: 2, note: 'n' },
          },
        ],
      });
      const { getByText, getByTestId } = render(<AgentOrders ownerId="su-1" />);
      expect(getByText('source drifted')).toBeTruthy();
      expect(getByTestId('orders-fact-contested')).toBeTruthy();
    });

    it('P-011: an UNCONTESTED fact grows no badge at all — there is no "uncontested" claim to make', () => {
      // The fold reads only superseded rows, so its silence means "no dispute in
      // the version chain", not "verified agreed". A reassuring badge would
      // assert the second off evidence for the first.
      setOrders({ facts: [{ key: 'k', body: 'a standing fact' }] });
      const { queryByTestId, getByText } = render(<AgentOrders ownerId="su-1" />);
      expect(getByText('a standing fact')).toBeTruthy();
      expect(queryByTestId('orders-fact-contested')).toBeNull();
    });

    it('bounds an OPEN section too — the half of the fix that needs no click', () => {
      // jsdom applies no CSS, so this is a source assertion (the same reason the
      // vocabulary suite reads chat-controls.css directly). Without a ceiling,
      // one 40-row section still pushes every other section off the screen, and
      // the original complaint survives the toggle.
      const css = readFileSync(join(__dirname, '..', 'AgentOrders.css'), 'utf8');
      /* Match the rule whose SELECTOR LIST contains exactly this selector, not
         the first chunk that happens to contain the string.
         `.includes('.pc-orders__h {')` is satisfied by
         `.pc-orders__sec--mission > .pc-orders__h {` — which appears EARLIER in
         the file, so `find` returned the mission override and the assertions
         then ran against a rule that legitimately has no `position: sticky`.
         The test failed while the thing it guards was perfectly intact.
         (Same defect class as the descendant-selector bug in §⑦'s control-height
         check, which measured a Combobox's invisible inner input and reported a
         0.0 spread it had never actually looked at. A loose selector does not
         fail loudly; it silently answers about something else.) */
      const ruleFor = (selector: string) =>
        css
          .split('}')
          .find((b) =>
            (b.split('{')[0] ?? '').split(',').some((s) => s.trim().split('\n').pop()?.trim() === selector),
          );
      const rule = ruleFor('.pc-orders__sec');
      expect(rule).toMatch(/max-height:\s*\d/);
      expect(rule).toMatch(/overflow-y:\s*auto/);
      // `flex: none` is PART OF the bound, not a tidy-up: the rail is a flex
      // column, so a card left shrinkable gets squeezed when the rail overflows
      // — and squeezed + `overflow-y: auto` means CLIPPED, with no scrollbar to
      // admit it. Measured in the live webview: Mission rendered 83px against
      // 173px of content, silently losing a row. Dropping this line restores
      // that bug in a form no render test can see.
      expect(rule).toMatch(/flex:\s*none/);
      // The cap stays put while the body scrolls under it — a section you have
      // scrolled into is otherwise a list with no title.
      const cap = ruleFor('.pc-orders__h');
      expect(cap).toMatch(/position:\s*sticky/);
      /* The cap's hairline (P-005): once the card took C3's lighter fill, the
         plate's separation from it fell 1.99:1 -> 1.62:1. It is repaid by a
         border rather than by brightening the plate, because "less bright" is
         an owner ask (P-007/D-003) — so dropping this line would silently push
         the repair back onto luminance, which is the one place it may not go. */
      expect(cap).toMatch(/border-bottom:\s*1px solid var\(--pc-orders-edge\)/);
    });
  });

  describe('an agent is a "they", not an "it" (WI-7110)', () => {
    it('subtitles the panel "what they were told"', () => {
      setOrders({});
      const { getByTestId } = render(<AgentOrders ownerId="su-1" />);
      const header = getByTestId('agent-orders').querySelector('.pc-orders__tag');
      expect(header?.textContent).toContain('what they were told');
    });

    it('never refers to the agent as "it"', () => {
      // [owner 2026-08-02] asked for exactly this one word. Asserting the
      // ABSENCE of the old copy as well as the presence of the new is what
      // makes it a guard: a rewrite that reintroduces "what it was told"
      // alongside the new string would still pass the assertion above.
      setOrders({});
      const { getByTestId } = render(<AgentOrders ownerId="su-1" />);
      const header = getByTestId('agent-orders').querySelector('.pc-orders__tag');
      expect(header?.textContent).not.toContain('what it was told');
    });
  });

  /* ── P-005: the disclosure family reaches the panel ──────────────────────
     Disclosures.test.tsx owns the component's own behaviour. These four assert
     the WIRING, and specifically the case the wiring is easy to get wrong: the
     markers must survive the branch where their section rendered EMPTY. That is
     where they matter most, and it is the branch a later refactor will drop
     them from, because the natural place to put them is inside the populated
     card. */
  describe('disclosures (P-005)', () => {
    const NARROWED = {
      at: '2026-08-18T20:57:00.000Z',
      disclosures: {
        factsNarrowed: {
          fold: 'never-drop',
          prefixes: ['dead-end:', 'wall:'],
          reason: "mode:'monitor' tick",
        },
      },
    };

    it('qualifies an EMPTY facts section — "none in scope" is a lie on a narrowed fold', () => {
      // The whole point. RailQuiet says "none in scope"; the agent was never
      // shown its facts, so that absence is not evidence that none stand.
      setOrders({ facts: [], disclosures: NARROWED });
      const { getByTestId } = render(<AgentOrders ownerId="su-1" />);
      expect(getByTestId('rail-quiet-facts')).toBeTruthy();
      expect(getByTestId('disclosures-facts').textContent).toMatch(/not a census/i);
    });

    it('qualifies a POPULATED facts section too', () => {
      setOrders({
        facts: [{ key: 'k', body: 'a standing fact' }],
        disclosures: NARROWED,
      });
      const { getByTestId } = render(<AgentOrders ownerId="su-1" />);
      expect(getByTestId('disclosures-facts')).toBeTruthy();
    });

    it('renders NOTHING when the agent has no recording — never a false clean', () => {
      // `disclosures: null` = this session has not oriented since the recording
      // existed. A line here saying "nothing was withheld" would be a confident
      // FALSE statement on the surface a human uses to judge an agent's blindness.
      setOrders({ facts: [], disclosures: null });
      const { queryByTestId, getByTestId } = render(<AgentOrders ownerId="su-1" />);
      expect(queryByTestId('disclosures-facts')).toBeNull();
      expect(queryByTestId('disclosures-reads')).toBeNull();
      // Positive control: the section itself still rendered, so the absence
      // above is the disclosure's, not the whole panel failing to mount.
      expect(getByTestId('rail-quiet-facts')).toBeTruthy();
    });

    it('renders NOTHING when the last orient genuinely cut nothing', () => {
      setOrders({ facts: [], disclosures: { at: '2026-08-18T20:57:00.000Z', disclosures: {} } });
      const { queryByTestId } = render(<AgentOrders ownerId="su-1" />);
      expect(queryByTestId('disclosures-facts')).toBeNull();
    });

    it('shows the bounded-read markers that have no section of their own', () => {
      setOrders({
        disclosures: {
          at: '2026-08-18T20:57:00.000Z',
          disclosures: {
            announcedGatesTruncated: { shown: 8, total: 14, more: 'events:catalog' },
          },
        },
      });
      const { getByTestId } = render(<AgentOrders ownerId="su-1" />);
      const text = getByTestId('disclosures-reads').textContent ?? '';
      expect(text).toMatch(/never told/i);
      expect(text).toContain('events:catalog');
    });
  });

  /**
   * P-018 — the SHARED obligation + delta projection reaching the screen.
   *
   * The server half routes this rail and `buildTurnStartOrientationBlock`
   * through ONE projection; that equality is asserted at the source, in
   * packages/operator-core/lib/turn-start-orientation-shared-projection.test.ts
   * ("same fixture => same rows in both"). What CANNOT be asserted there is the
   * half that made the projection worth sharing: that the rows survive the trip
   * to the panel verbatim, in the projection's own order, and that the three
   * states stay three — which is this file's thesis (D-003) applied to a field
   * whose null is especially easy to misrender as reassurance.
   */
  describe('turn-start obligations — the shared projection (P-018)', () => {
    const ROWS = [
      {
        classId: 'ownerDirectives',
        order: 10,
        text: '1 open owner directive — resolve it before your own agenda.',
      },
      {
        classId: 'unansweredDirected',
        order: 20,
        text: 'su-peer asked you a question 4m ago and is blocked on the answer.',
      },
      {
        classId: 'neverDropFacts',
        order: 30,
        text: 'wall: the owner holds the only credential for the publish step.',
      },
    ];

    it('renders every row verbatim, in the projection’s order, tagged with its emitting class', () => {
      setOrders({ obligationRows: ROWS });
      const { getAllByTestId, getByTestId, queryByTestId } = render(<AgentOrders ownerId="su-1" />);

      const rendered = getAllByTestId('orders-obligation-row');
      expect(rendered).toHaveLength(3);

      // VERBATIM and IN ORDER. A projection whose whole value is "one answer to
      // what was this agent told" is defeated by a panel that reorders,
      // re-words, or summarises it — each of which still renders plausibly.
      expect(rendered.map((n) => n.textContent)).toEqual(ROWS.map((r) => r.text));

      // The emitting class rides along so a reader cross-checking a line
      // against the section that decomposes it knows where to look.
      expect(rendered.map((n) => n.getAttribute('data-class-id'))).toEqual([
        'ownerDirectives',
        'unansweredDirected',
        'neverDropFacts',
      ]);

      // The populated card replaces the quiet line rather than sitting beside
      // it, and the section still NAMES itself (the named-empty rule above).
      expect(queryByTestId('rail-quiet-obligations')).toBeNull();
      expect(within(getByTestId('agent-orders')).getByText('Turn-start obligations')).toBeTruthy();
    });

    it('keeps THREE states apart: not recorded, genuinely none, and a failed read', () => {
      // 1. NOT RECORDED — the field never arrived (an operator predating it).
      //    The one misrender that matters: this must not read as "they were
      //    told nothing", which is a claim we have no evidence for.
      setOrders({});
      const absent = render(<AgentOrders ownerId="su-1" />);
      expect(absent.getByTestId('rail-quiet-obligations').textContent).toContain('not recorded');
      expect(absent.queryByTestId('orders-obligation-row')).toBeNull();
      cleanup();

      // 2. GENUINELY NONE — we asked, the projection was empty. Different
      //    conclusion, different words.
      setOrders({ obligationRows: [] });
      const none = render(<AgentOrders ownerId="su-1" />);
      expect(none.getByTestId('rail-quiet-obligations').textContent).toContain('nothing standing');
      expect(none.getByTestId('rail-quiet-obligations').textContent).not.toContain('not recorded');
      cleanup();

      // 3. FAILED READ — we could not ask at all.
      setOrders({ unavailable: ['obligationRows'] });
      const broken = render(<AgentOrders ownerId="su-1" />);
      expect(broken.getByTestId('orders-unavailable').textContent).toContain('not “none”');
      // …and the quiet line must NOT also render, or the failure is dressed up
      // as an answer sitting right beside it.
      expect(broken.queryByTestId('rail-quiet-obligations')).toBeNull();
    });

    it('renders a row from a class this bundle has never heard of', () => {
      /* The SPA rebuilds on the vite hot path while the sidecar reloads only on
         restart, so a NEWER operator routinely serves classes this bundle
         predates — P-013..P-016 are adding four right now. Dropping such a row
         would silently hide a real obligation, which is the single failure this
         panel exists to prevent, so `classId` is deliberately `string` rather
         than a client-side union of today's classes. */
      setOrders({
        obligationRows: [
          { classId: 'aClassInventedAfterThisBundleShipped', order: 5, text: 'a newer obligation' },
        ],
      });
      const { getAllByTestId } = render(<AgentOrders ownerId="su-1" />);
      const rendered = getAllByTestId('orders-obligation-row');
      expect(rendered).toHaveLength(1);
      expect(rendered[0]!.textContent).toBe('a newer obligation');
    });
  });
});
