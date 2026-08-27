// @vitest-environment jsdom
/**
 * ChatActionBar — verifies the registry-driven bar + the params/confirm/run
 * flow through askUserLocal, LocalCardHost-rendered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { z } from 'zod';

import { ChatActionBar, withTimeout, PARAMS_TIMEOUT_MS } from './ChatActionBar';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '@papercusp/sync';
import { LocalCardHost } from './LocalCardHost';
import { _resetAskUserLocalForTests } from '@/lib/chat-cards/ask-user-local';
import { _resetChatActionsForTests, registerChatAction, registerChatModeAction } from '@/lib/chat-actions/registry';
import type { ChatActionContext } from '@/lib/chat-actions/types';

const ctx: ChatActionContext = { sessionOwnerId: 'su-1', ownerLabel: 'su-1' };

// Reset BEFORE each test too, not only after. ChatActionBar now imports the
// chat-actions BARREL (WI-6450 — importing the registry directly is what left
// the bar empty in the real app), so the concrete posture/grade/session actions
// are registered as a side effect of importing the component under test. Every
// case here builds its own registry from scratch, so the first test would
// otherwise inherit those real actions and see a populated bar.
beforeEach(() => {
  _resetChatActionsForTests();
});

afterEach(() => {
  cleanup();
  _resetAskUserLocalForTests();
  _resetChatActionsForTests();
});

describe('ChatActionBar', () => {
  it('renders nothing when no action is available', () => {
    const { container } = render(<ChatActionBar ctx={ctx} />);
    expect(container.firstChild).toBeNull();
  });

  /* The Framed look (owner-approved 2026-08-02, artifact 6379bb65): this band is
     the "Controls" zone — everything in it changes THIS session, which is what
     separates it from the Fleet strip below. The cap must ride INSIDE the band's
     existing row: the popup had just been compacted from five rows to two, so a
     title row per zone would have spent that saving back. Asserting direct
     childhood is what catches a later "tidy-up" that lifts the cap into its own
     wrapper — a change no behavioural test would notice. */
  it('names itself the Controls zone with an inline cap inside the band — no extra row', () => {
    registerChatAction({ id: 'shown', label: 'Shown', available: () => true, run: vi.fn() });
    const { container } = render(<ChatActionBar ctx={ctx} />);
    const band = container.querySelector('.chat-action-bar')!;
    const cap = band.querySelector(':scope > .pc-zone-cap');
    expect(cap).toBeTruthy();
    expect(cap!.textContent).toBe('Controls');
    expect(cap!.parentElement).toBe(band);
  });

  it('stays absent entirely when there is nothing to control — a zone cap alone is not a zone', () => {
    // The cap must not resurrect an empty band: an empty "Controls" strip is a
    // row of chrome naming a region with nothing in it.
    const { container } = render(<ChatActionBar ctx={ctx} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders only available() actions', () => {
    registerChatAction({ id: 'shown', label: 'Shown', available: () => true, run: vi.fn() });
    registerChatAction({ id: 'hidden', label: 'Hidden', available: () => false, run: vi.fn() });
    render(<ChatActionBar ctx={ctx} />);
    expect(screen.getByText('Shown')).toBeTruthy();
    expect(screen.queryByText('Hidden')).toBeNull();
  });

  it('a zero-param action runs immediately on click', async () => {
    const run = vi.fn();
    registerChatAction({ id: 'zero', label: 'Zero param', available: () => true, run });
    render(<ChatActionBar ctx={ctx} />);
    fireEvent.click(screen.getByText('Zero param'));
    await waitFor(() => expect(run).toHaveBeenCalledWith(ctx, undefined));
  });

  it('params() opens a card via LocalCardHost; submitting it calls run with the payload', async () => {
    const run = vi.fn();
    registerChatAction({
      id: 'with-params',
      label: 'With params',
      available: () => true,
      params: async () => ({
        prompt: 'Pick one',
        dataSchema: z.object({ picks: z.tuple([z.enum(['a', 'b'])]) }),
        presentation: {
          kind: 'radio',
          options: [
            { id: 'a', label: 'Option A' },
            { id: 'b', label: 'Option B' },
          ],
        },
      }),
      run,
    });
    render(
      <>
        <ChatActionBar ctx={ctx} />
        <LocalCardHost />
      </>,
    );
    fireEvent.click(screen.getByText('With params'));
    await waitFor(() => expect(screen.getByText('Pick one')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Option A$/i }));
    await waitFor(() => expect(run).toHaveBeenCalledWith(ctx, { picks: ['a'] }));
  });

  // WI-6552: the guard for the hang observed LIVE on 2026-07-27 — Grade's
  // params() fetches rubrics.list through the sync in-flight gate, which
  // queued behind the HUD's other queries and never resolved OR rejected,
  // leaving the button aria-busy + disabled with no card and no error.
  // Tested on `withTimeout` directly rather than by driving the bar: faking
  // timers deadlocks testing-library's findBy* (which needs real ones), and
  // the real 12s ceiling is far too long to wait out in a unit test.
  describe('WI-6552 withTimeout — a never-settling params() must not hang the bar', () => {
    it('rejects with the given message when the promise never settles', async () => {
      await expect(
        withTimeout(new Promise(() => {}), 10, 'Grade could not load its options in time — try again.'),
      ).rejects.toThrow(/could not load its options/i);
    });

    it('passes a value through untouched when it settles in time', async () => {
      await expect(withTimeout(Promise.resolve('ok'), 5_000, 'nope')).resolves.toBe('ok');
    });

    it('propagates the original rejection rather than masking it as a timeout', async () => {
      await expect(
        withTimeout(Promise.reject(new Error('real failure')), 5_000, 'timeout msg'),
      ).rejects.toThrow('real failure');
    });
  });

  it('WI-6552: a successful action reports success, so it is never silent', async () => {
    registerChatAction({
      id: 'quiet',
      label: 'Quiet',
      available: () => true,
      run: vi.fn(async () => {}),
    });
    render(<ChatActionBar ctx={ctx} />);
    fireEvent.click(screen.getByTestId('chat-action-quiet'));
    // [owner 2026-07-27] "I also selected one of the rubrics and nothing
    // happaned." Success used to render nothing at all, so a working action
    // and a dead click looked identical.
    const done = await screen.findByTestId('chat-action-bar-done');
    expect(done.textContent).toMatch(/Quiet/);
  });

  it('declining the params card does NOT call run', async () => {
    const run = vi.fn();
    registerChatAction({
      id: 'declinable',
      label: 'Declinable',
      available: () => true,
      params: async () => ({
        prompt: 'q',
        dataSchema: z.object({ picks: z.tuple([z.enum(['x'])]) }),
        presentation: { kind: 'radio', options: [{ id: 'x', label: 'X' }] },
      }),
      run,
    });
    render(
      <>
        <ChatActionBar ctx={ctx} />
        <LocalCardHost />
      </>,
    );
    fireEvent.click(screen.getByText('Declinable'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Skip this question/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Skip this question/i }));
    await new Promise((r) => setTimeout(r, 0));
    expect(run).not.toHaveBeenCalled();
  });

  it('confirm step: Confirm click runs; run is not called without confirming', async () => {
    const run = vi.fn();
    registerChatAction({
      id: 'confirm-me',
      label: 'Dangerous',
      available: () => true,
      confirm: { message: 'Are you sure?', confirmLabel: 'Yes, do it' },
      run,
    });
    render(
      <>
        <ChatActionBar ctx={ctx} />
        <LocalCardHost />
      </>,
    );
    fireEvent.click(screen.getByText('Dangerous'));
    await waitFor(() => expect(screen.getByText('Are you sure?')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Yes, do it/i }));
    await waitFor(() => expect(run).toHaveBeenCalledWith(ctx, undefined));
  });

  it('skipping the confirm card cancels — run is never called', async () => {
    const run = vi.fn();
    registerChatAction({
      id: 'confirm-skip',
      label: 'Dangerous2',
      available: () => true,
      confirm: { message: 'Sure?' },
      run,
    });
    render(
      <>
        <ChatActionBar ctx={ctx} />
        <LocalCardHost />
      </>,
    );
    fireEvent.click(screen.getByText('Dangerous2'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Skip this question/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Skip this question/i }));
    await new Promise((r) => setTimeout(r, 0));
    expect(run).not.toHaveBeenCalled();
  });

  it('groups render as separate clusters, in first-seen order', () => {
    registerChatAction({ id: 'b1', label: 'B1', group: 'beta', available: () => true, run: vi.fn() });
    registerChatAction({ id: 'a1', label: 'A1', group: 'alpha', available: () => true, run: vi.fn() });
    const { container } = render(<ChatActionBar ctx={ctx} />);
    const groups = container.querySelectorAll('.chat-action-bar-group');
    expect(groups.length).toBe(2);
    expect(groups[0].getAttribute('data-group')).toBe('beta');
    expect(groups[1].getAttribute('data-group')).toBe('alpha');
  });

  /* ── P-005 mode pills (session-chat-popup-direction-d-2026-08-02) ──────────
     The descriptor layer is covered by PostureActions.test.ts; this is the
     RENDER half, which had no coverage at all — and it is the half that carries
     the bug the owner actually reported. P-005 exists because a mode was
     modelled as a ChatAction: it then had to be SHOWN somewhere else as a
     read-only chip while its setter sat here as a button with a different name,
     so one concept wore two costumes and neither said it was the other.

     So the assertions below are about the pill being ONE object that both
     reports and sets. A regression here is not cosmetic: registering a posture
     axis as a plain ChatAction again would still render a working button, still
     pass every other test in this file, and silently restore the duplicate
     pair. ── */
  describe('P-005 mode-actions render as pills that report AND set', () => {
    const axis = (over: Partial<Parameters<typeof registerChatModeAction>[0]> = {}) => ({
      id: 'autonomy',
      cap: 'AUTO',
      available: () => true,
      current: () => ({ value: 'on', on: true, title: 'Acting without asking' }),
      options: () => [
        { id: 'manual', label: 'Manual' },
        { id: 'auto', label: 'Auto' },
      ],
      set: vi.fn(),
      ...over,
    });

    it('renders the cap AND the current value in one control — not a chip plus a differently-named button', () => {
      registerChatModeAction(axis());
      render(<ChatActionBar ctx={ctx} />);

      const pill = screen.getByTestId('chat-mode-autonomy');
      // Both halves live on the SAME element. Reading them off one node is the
      // assertion: two nodes anywhere in the bar is the shape P-005 removed.
      expect(pill.textContent).toContain('AUTO');
      expect(pill.textContent).toContain('on');
      // …and it is the setter too, so there is no second control to find.
      expect(pill.tagName).toBe('BUTTON');
      expect(screen.queryByTestId('chat-action-autonomy')).toBeNull();
    });

    it('carries the state in the FORM, not by colour alone — off is a distinct class + data-on', () => {
      registerChatModeAction(axis({ id: 'ideate', cap: 'IDEATE', current: () => ({ value: 'off', on: false }) }));
      render(<ChatActionBar ctx={ctx} />);

      const pill = screen.getByTestId('chat-mode-ideate');
      expect(pill.getAttribute('data-on')).toBe('false');
      expect(pill.className).toContain('pc-ctl-mode--off');
    });

    it('the on-state is the same control WITHOUT the off modifier (the two states are distinguishable)', () => {
      registerChatModeAction(axis());
      render(<ChatActionBar ctx={ctx} />);

      const pill = screen.getByTestId('chat-mode-autonomy');
      expect(pill.getAttribute('data-on')).toBe('true');
      // Paired with the case above so neither is vacuous: the SAME two probes
      // read differently for on vs off, which is what "legible in greyscale"
      // has to mean mechanically.
      expect(pill.className).not.toContain('pc-ctl-mode--off');
    });

    it('renders a loading mode as a disabled, explicitly labelled placeholder', () => {
      const options = vi.fn(() => [{ id: 'ready', label: 'Ready' }]);
      registerChatModeAction(
        axis({
          id: 'loading-axis',
          cap: 'ACCT',
          current: () => ({
            value: 'not-yet-read',
            on: false,
            loading: true,
            title: 'Waiting for the roster',
          }),
          options,
        }),
      );
      render(<ChatActionBar ctx={ctx} />);

      const pill = screen.getByTestId('chat-mode-loading-axis') as HTMLButtonElement;
      expect(pill.disabled).toBe(true);
      expect(pill.textContent).toContain('Loading…');
      expect(pill.getAttribute('aria-label')).toMatch(/ACCT is loading/i);

      fireEvent.click(pill);
      expect(options).not.toHaveBeenCalled();
    });

    it('the accessible name states the axis, its value AND that it is changeable', () => {
      registerChatModeAction(axis());
      render(<ChatActionBar ctx={ctx} />);

      // The visible pill is two short words by design, so the screen-reader
      // name is the only place the whole sentence exists. A `title` would fail
      // lint:design-primitives AND be unreachable by keyboard.
      const label = screen.getByTestId('chat-mode-autonomy').getAttribute('aria-label') ?? '';
      expect(label).toContain('AUTO');
      expect(label).toContain('on');
      expect(label).toContain('Acting without asking');
      expect(label).toMatch(/change it/i);
    });

    /**
     * Opens a mode pill's dropdown.
     *
     * [owner 2026-08-02] the pill's chooser is a design-system Select, not a
     * card, so these tests drive it the way the ThemeSelector tests drive
     * their Radix menu: with a real pointer event. A bare `.click()` silently
     * no-ops on a Radix trigger — the menu never opens and the assertion that
     * follows fails for a reason that has nothing to do with the behaviour
     * under test.
     */
    const openPill = (testId: string): void => {
      const trigger = screen.getByTestId(testId);
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
      fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    };

    /* ── WI-7471: an axis may resolve its options ASYNCHRONOUSLY.
       [owner 2026-08-03] "I want the rubric picker back, add that to the grade
       on/off toggle" — GRADE's rows are one per active rubric, which has to be
       fetched. The three cases below pin the contract that makes that safe. ── */
    describe('async options() — fetched lazily, on open', () => {
      it('does NOT call options() while merely rendering the pill', () => {
        const options = vi.fn(async () => [{ id: 'off', label: 'Off' }]);
        registerChatModeAction(axis({ id: 'grade', cap: 'GRADE', options }));
        render(<ChatActionBar ctx={ctx} />);
        // This is the whole justification for allowing async at all: a popup
        // where nobody opens GRADE must cost no rubrics.list read. An eager
        // resolve would still render correctly and silently reintroduce the
        // per-screen query WI-6617 is removing.
        expect(options).not.toHaveBeenCalled();
      });

      it('resolves on open, renders the resolved rows, and picking one reaches set()', async () => {
        const set = vi.fn();
        const options = vi.fn(async () => [
          { id: 'off', label: 'Off' },
          { id: 'hive-coordination-health', label: 'Hive coordination health' },
        ]);
        registerChatModeAction(axis({ id: 'grade', cap: 'GRADE', options, set }));
        render(<ChatActionBar ctx={ctx} />);

        openPill('chat-mode-grade');
        const row = await screen.findByRole('option', { name: /hive coordination health/i });
        fireEvent.click(row);
        /* The trailing `undefined` is the P-005 value slot, and pinning it is
           deliberate: an axis with no `params` must reach `set` with NOTHING
           collected. `toHaveBeenCalledWith` compares arity, so leaving it off
           would not be laxer — it would assert the old two-arg shape and fail. */
        await waitFor(() =>
          expect(set).toHaveBeenCalledWith(ctx, 'hive-coordination-health', undefined),
        );
        // The confirmation reads off the RESOLVED cache, so it names the row
        // rather than echoing a raw id back at the user.
        await waitFor(() =>
          expect(screen.getByTestId('chat-action-bar-done').textContent).toMatch(
            /GRADE → Hive coordination health/,
          ),
        );
        // Resolved once and cached — reopening must not re-fetch.
        expect(options).toHaveBeenCalledTimes(1);
      });

      /* A failing options() must surface an ERROR, not leave the menu on its
         loading row — the WI-6552 failure shape (rubrics.list queueing behind a
         page's other queries and never resolving OR rejecting), which reads as
         a feature that simply does not work.

         This drives the bar's CATCH with a rejection rather than a hang: the
         25s bound that converts a hang into that rejection is already covered
         directly, on `withTimeout` itself, earlier in this file. Splitting it
         that way keeps this case free of fake timers, which here fight Radix's
         own open/close timers rather than testing the bar. */
      it('a failing options() surfaces the error instead of a menu stuck on "Loading…"', async () => {
        // The bar warns on this path deliberately, and the suite fails on an
        // unmocked console.warn — so assert the warn rather than silencing it,
        // which keeps the diagnostic itself covered.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const options = vi.fn(async () => {
            throw new Error('GRADE could not load its options in time — try again.');
          });
          registerChatModeAction(axis({ id: 'grade', cap: 'GRADE', options }));
          const { container } = render(<ChatActionBar ctx={ctx} />);
          openPill('chat-mode-grade');
          /* Queried by CLASS, not `getByRole('alert')`, and that is not a
             shortcut: an OPEN Radix Select marks everything outside its portal
             `aria-hidden="true"`, and RTL's role queries skip aria-hidden
             subtrees. So while the menu is still up, a perfectly-rendered
             alert is invisible to getByRole — the query fails while the
             component is correct. The role itself is asserted below, so
             nothing is given up. */
          const alert = await waitFor(() => {
            const el = container.querySelector('.chat-action-bar-error');
            expect(el, 'the failed load should render the bar’s error').toBeTruthy();
            return el!;
          });
          expect(alert.getAttribute('role')).toBe('alert');
          expect(alert.textContent).toMatch(/could not load its options/i);
          expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('options failed'),
            expect.anything(),
          );
        } finally {
          warn.mockRestore();
        }
      });
    });

    it('opening the pill and picking applies the choice through the descriptor’s own set()', async () => {
      const set = vi.fn();
      registerChatModeAction(axis({ set }));
      render(<ChatActionBar ctx={ctx} />);

      openPill('chat-mode-autonomy');
      const manual = await screen.findByRole('option', { name: /manual/i });
      fireEvent.click(manual);
      // The pick reaches set() as the OPTION ID, not the label — the descriptor
      // owns the vocabulary, the bar only carries the choice across.
      await waitFor(() => expect(set).toHaveBeenCalledWith(ctx, 'manual', undefined));
      // And the outcome is acknowledged: a silent success is indistinguishable
      // from a dead click (the WI-6552 lesson, which applies to pills too).
      await waitFor(() => expect(screen.getByTestId('chat-action-bar-done').textContent).toMatch(/AUTO/));
    });

    /* ── P-005: an axis may COLLECT A VALUE for the option just picked ────────
       DRAIN's scope instructions ("all bugs except the ones related to the p2p
       features"). The pick alone is not the whole answer, so the axis returns a
       CardSpec and the bar runs it through the SAME askUserLocal plumbing a
       ChatAction's `params` uses — no second card vocabulary (plan D-001). ── */
    describe('params() — value collection between the pick and the write', () => {
      const textAxis = (over: Record<string, unknown> = {}) =>
        axis({
          id: 'drain',
          cap: 'DRAIN',
          current: () => ({ value: 'off', optionId: 'off', on: false }),
          options: () => [
            { id: 'on-with-scope', label: 'On…' },
            { id: 'off', label: 'Off' },
          ],
          params: (_c: unknown, optionId: string) =>
            optionId === 'on-with-scope'
              ? {
                  prompt: 'What should this drain cover?',
                  dataSchema: z.object({ value: z.string() }),
                  presentation: { kind: 'text' as const, multiline: true },
                  allowDecline: true,
                }
              : null,
          ...over,
        });

      it('submitting the card hands the payload to set()', async () => {
        const set = vi.fn();
        registerChatModeAction(textAxis({ set }));
        render(
          <>
            <ChatActionBar ctx={ctx} />
            <LocalCardHost />
          </>,
        );

        openPill('chat-mode-drain');
        fireEvent.click(await screen.findByRole('option', { name: /on…/i }));

        const input = await screen.findByRole('textbox');
        fireEvent.change(input, { target: { value: 'all bugs except p2p' } });
        fireEvent.click(screen.getByRole('button', { name: /submit|send|ok/i }));

        await waitFor(() =>
          expect(set).toHaveBeenCalledWith(ctx, 'on-with-scope', { value: 'all bugs except p2p' }),
        );
      });

      /* The half that matters most. A half-applied "drain on, scope abandoned"
         is indistinguishable, from the agent's side, from an owner who meant an
         unscoped drain — so declining must cancel the WRITE, not just the card. */
      it('declining the card cancels the write entirely — set() is never called', async () => {
        const set = vi.fn();
        registerChatModeAction(textAxis({ set }));
        render(
          <>
            <ChatActionBar ctx={ctx} />
            <LocalCardHost />
          </>,
        );

        openPill('chat-mode-drain');
        fireEvent.click(await screen.findByRole('option', { name: /on…/i }));
        fireEvent.click(await screen.findByRole('button', { name: /skip|decline|cancel/i }));

        await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
        expect(set).not.toHaveBeenCalled();
      });

      /* Paired with the case above so neither is vacuous: the SAME axis asks on
         one row and stays silent on the other, which is what makes `params`
         per-option rather than per-axis. */
      it('an option that declares no card writes straight through', async () => {
        const set = vi.fn();
        /* Reported as RUNNING on purpose. A Radix Select fires no onChange for
           the row already selected, so an axis whose `current()` points at
           `off` cannot be used to test PICKING `off` — the click is a no-op and
           the failure looks like the code under test.
           (That is the same mechanic the real DRAIN axis dodges by giving its
           ON row an id no display value can equal — see PostureActions.) */
        registerChatModeAction(
          textAxis({ set, current: () => ({ value: 'on', on: true }) }),
        );
        render(
          <>
            <ChatActionBar ctx={ctx} />
            <LocalCardHost />
          </>,
        );

        openPill('chat-mode-drain');
        fireEvent.click(await screen.findByRole('option', { name: /^off$/i }));

        await waitFor(() => expect(set).toHaveBeenCalledWith(ctx, 'off', undefined));
        expect(screen.queryByRole('textbox')).toBeNull();
      });
    });

    it('the dropdown keeps the option HINTS the card used to show — compaction lost chrome, not information', async () => {
      registerChatModeAction(
        axis({
          options: () => [
            { id: 'manual', label: 'Manual', hint: 'Confirm-before-acting posture' },
            { id: 'auto', label: 'Auto', hint: 'Act on your own judgment' },
          ],
        }),
      );
      render(<ChatActionBar ctx={ctx} />);

      openPill('chat-mode-autonomy');
      const manual = await screen.findByRole('option', { name: /manual/i });
      expect(manual.textContent).toMatch(/confirm-before-acting/i);
    });

    /**
     * The reason ChatModeState.optionId exists. This axis's display value is
     * "on" while the option actually in force is `auto` — exactly the real
     * autonomy descriptor's shape. Selecting by display text would find no row
     * at all here (there is no option with id "on"), so the menu would open
     * with NOTHING marked and quietly stop telling you what is set.
     */
    it('marks the option in force via optionId, not by matching the display value', async () => {
      registerChatModeAction(
        axis({ current: () => ({ value: 'on', optionId: 'auto', on: true, title: 'Acting without asking' }) }),
      );
      render(<ChatActionBar ctx={ctx} />);

      openPill('chat-mode-autonomy');
      const auto = await screen.findByRole('option', { name: /auto/i });
      await waitFor(() => expect(auto.getAttribute('aria-selected')).toBe('true'));
    });

    it('a failing set() surfaces the error instead of leaving the pill stuck busy', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      registerChatModeAction(axis({ set: () => { throw new Error('sticky conflict'); } }));
      render(<ChatActionBar ctx={ctx} />);

      openPill('chat-mode-autonomy');
      const manual = await screen.findByRole('option', { name: /manual/i });
      fireEvent.click(manual);
      await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/sticky conflict/));
      // The bar has to come back — a disabled pill with no menu and no error is
      // the worst form of "nothing happened".
      expect((screen.getByTestId('chat-mode-autonomy') as HTMLButtonElement).disabled).toBe(false);
      warn.mockRestore();
    });

    it('modes render BEFORE the verbs, separated — what the agent IS, then what acts on it', () => {
      registerChatModeAction(axis());
      registerChatAction({ id: 'focus', label: 'Focus', available: () => true, run: vi.fn() });
      const { container } = render(<ChatActionBar ctx={ctx} />);

      const order = Array.from(
        container.querySelectorAll<HTMLElement>('[data-testid="chat-mode-autonomy"],[data-testid="chat-action-focus"]'),
      ).map((el) => el.dataset.testid);
      expect(order).toEqual(['chat-mode-autonomy', 'chat-action-focus']);
      // The separator exists only when BOTH populations are present.
      expect(container.querySelector('.pc-ctl-band__sep')).toBeTruthy();
    });

    it('draws no separator when there are modes but no verbs (nothing to separate)', () => {
      registerChatModeAction(axis());
      const { container } = render(<ChatActionBar ctx={ctx} />);
      expect(screen.getByTestId('chat-mode-autonomy')).toBeTruthy();
      expect(container.querySelector('.pc-ctl-band__sep')).toBeNull();
    });

    it('an unavailable axis is not rendered at all', () => {
      registerChatModeAction(axis({ available: () => false }));
      const { container } = render(<ChatActionBar ctx={ctx} />);
      expect(screen.queryByTestId('chat-mode-autonomy')).toBeNull();
      // …and a bar with nothing in it stays absent rather than rendering an
      // empty band.
      expect(container.firstChild).toBeNull();
    });
  });

  it('a run() rejection surfaces an error without crashing the bar', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerChatAction({
      id: 'boom',
      label: 'Boom',
      available: () => true,
      run: () => {
        throw new Error('kaboom');
      },
    });
    render(<ChatActionBar ctx={ctx} />);
    fireEvent.click(screen.getByText('Boom'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/kaboom/));
    warn.mockRestore();
  });

  // P-009 / D-003. This ordering is LOAD-BEARING and was previously expressed
  // only as prose in another package's comment, where nothing could enforce it.
  //
  // The sync layer rejects a request that cannot get a gate slot at
  // DEFAULT_REQUEST_TIMEOUT_MS with a specific, actionable message ('sync query
  // "<name>" timed out after 20000ms waiting for a request slot'). If the bar's
  // own ceiling fired first it would replace that message with a generic
  // timeout, which is exactly the opacity WI-6559 was filed for — the failure
  // would still be visible, but no longer diagnosable.
  describe('P-009 the params ceiling stays above the sync layer ceiling', () => {
    it('is derived from the sync layer ceiling, not a hardcoded number', () => {
      expect(PARAMS_TIMEOUT_MS).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS);
    });

    it('leaves headroom for the layer rejection to propagate and render', () => {
      // Enough slack that a rejection at the layer ceiling reliably surfaces
      // first, without reverting to the old arbitrary 30s (which was justified
      // by a measurement OF WI-6559 — a bug now fixed, so the number outlived
      // its own rationale).
      expect(PARAMS_TIMEOUT_MS - DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(2_000);
      expect(PARAMS_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    });
  });
});
