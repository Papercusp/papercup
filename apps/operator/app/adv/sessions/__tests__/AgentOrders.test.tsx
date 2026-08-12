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
});
