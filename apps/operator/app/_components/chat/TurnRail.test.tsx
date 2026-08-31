// @vitest-environment jsdom
/**
 * TurnRail (chat-popup-turn-rail-2026-08-31 P-006).
 *
 * What these tests are actually defending — the owner's ask was ONE sentence
 * and every case below is a way of failing it while still rendering:
 *
 *   [owner 2026-08-31] "a turn sidebar on the left, that shows a preview of the
 *   users questions, and then you click and it scrolls to the answer(past all
 *   the tool calls etc)."
 *
 *  1. THE CLICK CONTRACT — "scrolls to the answer, past all the tool calls" is
 *     the feature, not an implementation detail. A rail that renders perfectly
 *     and calls back with the QUESTION index dumps the reader at the top of the
 *     tool chips they asked to skip: the exact scrolling they opened the rail to
 *     avoid, now with extra steps. So the assertion is on the ARGUMENT, and the
 *     fixture deliberately puts several tool-call messages between question and
 *     answer so question-index and answer-index cannot coincide.
 *  2. THE FALLBACK IS NOT THE CONTRACT — an unanswered turn must still jump
 *     (to its question) and must SAY it has no answer. A row that silently
 *     jumps nowhere reads as a dead rail.
 *  3. WHERE YOU ARE — `aria-current` on exactly one row, and none at all for
 *     liveTurn -1. -1 is a real answer (the reader is above the first
 *     question); marking row 0 instead would put the "you are here" marker
 *     somewhere the reader is not.
 *  4. THE SPINE STILL WORKS — the degraded density (D-003) is the one that
 *     ships on a narrow window, and it is the easy one to leave half-wired: its
 *     click contract is asserted separately, and its tick heights are asserted
 *     to SCALE, because a spine whose ticks are all one height is a decoration,
 *     not a minimap.
 *  5. DISPLAY:BLOCK ON THE BUTTONS — a source assertion, because jsdom applies
 *     no CSS. WebKitGTK (the only shipping webview) IGNORES `display:flex` on a
 *     <button> and falls back to block, stacking children vertically
 *     (EI-18135716653974462). Both rail shapes are button-backed, so this trap
 *     is armed for them and nothing else would catch it — the component tests
 *     below pass either way, and the desktop is where it would be seen.
 *
 * The model is built BY HAND rather than through `deriveSessionTurns`, so a
 * derivation bug cannot make a rendering test pass; the derivation has its own
 * suite in session-turn-index.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import TurnRail from './TurnRail';
import type { SessionTurn } from './session-turn-index';

afterEach(cleanup);

/**
 * A turn whose answer is FOUR messages after its question, with the gap
 * standing in for the tool chips the owner wants skipped. Indices are supplied
 * explicitly so every assertion below reads as the contract it is checking
 * rather than as arithmetic.
 */
function turn(over: Partial<SessionTurn> = {}): SessionTurn {
  const questionIndex = over.questionIndex ?? 0;
  const answerIndex = over.answerIndex === undefined ? questionIndex + 4 : over.answerIndex;
  return {
    turn: 1,
    questionIndex,
    answerIndex,
    jumpIndex: answerIndex ?? questionIndex,
    question: 'why is the gate red',
    askedAt: '2026-08-31T12:00:00.000Z',
    answeredAt: '2026-08-31T12:02:10.000Z',
    durationMs: 130_000,
    toolCount: 3,
    firstIndex: questionIndex,
    lastIndex: answerIndex ?? questionIndex,
    ...over,
  };
}

/** Three turns of DIFFERENT spans — the spine's tick scaling needs a spread to
 *  be falsifiable, and the rail's ordering needs more than two rows. */
function threeTurns(): SessionTurn[] {
  return [
    turn({ turn: 1, questionIndex: 0, answerIndex: 2, question: 'why is the gate red' }),
    turn({ turn: 2, questionIndex: 3, answerIndex: 7, question: 'which tests are failing' }),
    turn({ turn: 3, questionIndex: 8, answerIndex: 20, question: 'ship it' }),
  ];
}

const noop = () => {};

describe('rail density — the readable one', () => {
  it('renders one row per turn, in order, previewing the QUESTION', () => {
    render(<TurnRail turns={threeTurns()} liveTurn={-1} onJump={noop} onClose={noop} />);

    const rows = screen.getAllByTestId('turn-rail-row');
    expect(rows).toHaveLength(3);
    // Order is the reader's order (oldest first), asserted on the row content
    // rather than on the array we passed in.
    expect(rows.map((r) => r.getAttribute('data-turn'))).toEqual(['1', '2', '3']);
    expect(rows[0].textContent).toContain('why is the gate red');
    expect(rows[2].textContent).toContain('ship it');
    // The preview is the whole point of the rail: a row that renders only "T1"
    // is a scrollbar, not an index.
    expect(screen.getByText('which tests are failing')).toBeTruthy();
  });

  it('CLICK LANDS ON THE ANSWER, not the question — the owner’s "past all the tool calls"', () => {
    const onJump = vi.fn();
    render(<TurnRail turns={threeTurns()} liveTurn={-1} onJump={onJump} onClose={noop} />);

    fireEvent.click(screen.getAllByTestId('turn-rail-row')[1]);

    // jumpIndex 7 (the answer), NOT questionIndex 3 — landing on 3 would drop
    // the reader above the tool chips they clicked to skip.
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(7, 1);
  });

  it('an UNANSWERED turn still jumps — to its question — and says it has no answer', () => {
    const onJump = vi.fn();
    const turns = [
      turn({ turn: 1, questionIndex: 0, answerIndex: 2 }),
      turn({
        turn: 2,
        questionIndex: 5,
        answerIndex: null,
        question: 'still thinking',
        answeredAt: null,
        durationMs: null,
        lastIndex: 6,
      }),
    ];
    render(<TurnRail turns={turns} liveTurn={-1} onJump={onJump} onClose={noop} />);

    const rows = screen.getAllByTestId('turn-rail-row');
    expect(rows[1].textContent).toContain('no answer yet');
    // The first row is answered, so the pending word must NOT be a fixture of
    // every row — otherwise the case above proves nothing.
    expect(rows[0].textContent).not.toContain('no answer yet');

    fireEvent.click(rows[1]);
    // The question index, because there is nothing else to land on — and a
    // click that did nothing would read as a broken rail.
    expect(onJump).toHaveBeenCalledWith(5, 1);
  });

  it('marks exactly one row as where-you-are, and marks NONE at liveTurn -1', () => {
    const { rerender } = render(
      <TurnRail turns={threeTurns()} liveTurn={1} onJump={noop} onClose={noop} />,
    );

    let rows = screen.getAllByTestId('turn-rail-row');
    expect(rows.map((r) => r.getAttribute('aria-current'))).toEqual([null, 'true', null]);
    // Marked for sighted readers too, and via an attribute the stylesheet keys
    // off — aria alone would leave the rail visually unmarked.
    expect(rows[1].getAttribute('data-live')).toBe('true');

    // -1 is "the reader is above the first question". Guessing row 0 here is
    // the failure this case exists for.
    rerender(<TurnRail turns={threeTurns()} liveTurn={-1} onJump={noop} onClose={noop} />);
    rows = screen.getAllByTestId('turn-rail-row');
    expect(rows.some((r) => r.getAttribute('aria-current') === 'true')).toBe(false);
  });

  it('names the destination in the accessible label, since the visible row is a question', () => {
    render(<TurnRail turns={threeTurns()} liveTurn={-1} onJump={noop} onClose={noop} />);

    const label = screen.getAllByTestId('turn-rail-row')[0].getAttribute('aria-label') ?? '';
    // Nothing about the word "why is the gate red" tells a screen-reader user
    // that pressing it scrolls somewhere, let alone where.
    expect(label).toContain('why is the gate red');
    expect(label).toContain('jumps to the answer');
    expect(label).toContain('3 tool calls');
  });

  it('an empty transcript SAYS it is empty rather than rendering a blank column', () => {
    render(<TurnRail turns={[]} liveTurn={-1} onJump={noop} onClose={noop} />);
    // A session genuinely can have no questions (a loop-fired agent talks
    // without being asked); a blank rail would read as a load failure.
    expect(screen.getByTestId('turn-rail-empty')).toBeTruthy();
    expect(screen.queryAllByTestId('turn-rail-row')).toHaveLength(0);
  });

  it('the close control reports the dismissal instead of hiding the rail itself', () => {
    const onClose = vi.fn();
    render(<TurnRail turns={threeTurns()} liveTurn={0} onJump={noop} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Hide the turn rail'));
    // The host owns the nuqs toggle — a rail that hid itself would lose the
    // state on the next render and be un-restorable from the URL.
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('spine density — the degraded one that ships on a narrow window', () => {
  it('renders ticks instead of rows, and keeps the same click contract', () => {
    const onJump = vi.fn();
    render(
      <TurnRail turns={threeTurns()} liveTurn={-1} density="spine" onJump={onJump} onClose={noop} />,
    );

    expect(screen.queryAllByTestId('turn-rail-row')).toHaveLength(0);
    const ticks = screen.getAllByTestId('turn-rail-tick');
    expect(ticks).toHaveLength(3);

    fireEvent.click(ticks[1]);
    // Identical to the rail density's contract — a spine that jumped to the
    // question would be a different feature wearing the same name.
    expect(onJump).toHaveBeenCalledWith(7, 1);
  });

  it('tick heights SCALE with how much transcript each turn occupies', () => {
    render(
      <TurnRail turns={threeTurns()} liveTurn={-1} density="spine" onJump={noop} onClose={noop} />,
    );

    const heights = screen
      .getAllByTestId('turn-rail-tick')
      .map((t) => Number.parseFloat((t.querySelector('span') as HTMLElement).style.height));

    // Spans are 3, 5 and 13 messages: the tick is a minimap of the scroll, so
    // the biggest turn must be the tallest mark. All-equal heights would be a
    // decoration that looks like information.
    expect(heights[0]).toBeLessThan(heights[1]);
    expect(heights[1]).toBeLessThan(heights[2]);
    // Floor is a hit target, not an aesthetic — below ~12px a tick stops being
    // clickable, which is what the mockup review flagged for a long session.
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(12);
    expect(Math.max(...heights)).toBeLessThanOrEqual(44);
  });

  it('still says which turn is live, and still carries the question in its label', () => {
    render(
      <TurnRail turns={threeTurns()} liveTurn={2} density="spine" onJump={noop} onClose={noop} />,
    );

    const ticks = screen.getAllByTestId('turn-rail-tick');
    expect(ticks.map((t) => t.getAttribute('aria-current'))).toEqual([null, null, 'true']);
    // The whole premise of the degrade (D-003) is that the question is one
    // hover or one focus away rather than gone.
    expect(ticks[2].getAttribute('aria-label')).toContain('ship it');
  });

  it('does not render the empty SENTENCE at spine width — there is no room for one', () => {
    render(<TurnRail turns={[]} liveTurn={-1} density="spine" onJump={noop} onClose={noop} />);
    expect(screen.queryByTestId('turn-rail-empty')).toBeNull();
    // The column itself still exists and still names itself, so the reader is
    // not left wondering what the empty gutter is.
    expect(screen.getByTestId('turn-rail').getAttribute('aria-label')).toBe(
      'Turns in this conversation',
    );
  });
});

describe('the WebKitGTK trap: a button-backed shape must lay out via inner spans', () => {
  /* Overridable so falsifiability can be PROVEN against a mutated COPY outside
     the tree (scripts/mutation-probe.sh tier 2). Mutating the real stylesheet
     in place to test this guard would hand git-sync a window in which to commit
     the mutant — a sweep race no trap can close. */
  const cssPath = process.env.TURN_RAIL_CSS ?? join(__dirname, 'chat-controls.css');
  const css = readFileSync(cssPath, 'utf8');
  /** Comments stripped: this file's own headers quote the declarations these
   *  guards are about, so scanning raw text matches the EXPLANATION of the rule
   *  rather than a violation of it (the same correction chat-controls.vocabulary
   *  needed). */
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

  function ruleBody(sel: string): string | null {
    for (const [, selector, body] of cssCode.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (selector.split(',').some((s) => s.trim() === sel)) return body;
    }
    return null;
  }

  it.each(['.pc-turn', '.pc-turn-tick'])(
    '%s declares display:block — WebKitGTK ignores flex on a <button>',
    (sel) => {
      const body = ruleBody(sel);
      expect(body, `${sel} has no rule of its own in chat-controls.css`).toBeTruthy();
      // Not a style preference: the only shipping webview silently drops flex
      // here, so a flex row would stack vertically on the desktop while every
      // test above — and every browser preview — stayed green
      // (EI-18135716653974462).
      expect(body!, `${sel} must be display:block, not flex`).toMatch(/display:\s*block/);
      expect(body!).not.toMatch(/display:\s*flex/);
    },
  );

  it('the inner spans that do the laying out actually exist', () => {
    // The positive control for the case above: `display:block` alone is also
    // what an unstyled button would have, so the guard only means something if
    // the layout really did move to children.
    for (const inner of ['.pc-turn__top', '.pc-turn__meta', '.pc-turn-tick__bar']) {
      expect(ruleBody(inner), `${inner} has no rule`).toBeTruthy();
    }
  });
});
