// @vitest-environment jsdom
/**
 * HoverDetail.test.tsx — the three behaviours that make "doesn't disappear
 * easily" true rather than merely slower.
 *
 * The SELECTION HOLD is the one worth having a test for: it is the reason this
 * component exists instead of `harness/Tooltip` [owner 2026-08-09], it is
 * invisible in a screenshot, and it degrades silently — a regression leaves a
 * panel that still opens, still hovers through, and still pins, so every other
 * check passes while the actual complaint is back.
 *
 * WHAT THIS SUITE CANNOT TELL YOU. jsdom does not paint and has no real
 * Selection: `window.getSelection` is stubbed here, so these assertions cover
 * the component's OWN logic (does a live selection re-arm the close timer?) and
 * nothing about whether a real pointer can reach the panel or a real drag
 * selects its text. That half is only provable in the Tauri shell — see
 * /internal/docs/testing/agent-e2e and the memory on asserting REACHABILITY
 * with elementFromPoint rather than "it opened".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { HoverDetail, hasSelectionInside } from './HoverDetail';

const OPEN_DELAY_MS = 180;
const CLOSE_GRACE_MS = 500;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
});

/**
 * React does NOT listen for `pointerenter`/`pointerleave` — those events do not
 * bubble, so its EnterLeaveEventPlugin SYNTHESISES `onPointerEnter`/
 * `onPointerLeave` from `pointerover`/`pointerout`. `fireEvent.pointerEnter`
 * therefore dispatches a real DOM event that reaches NO React handler, and the
 * test fails against a component that works perfectly in a browser. Drive the
 * events React actually subscribes to.
 */
function hoverIn(el: Element) {
  fireEvent.pointerOver(el, { relatedTarget: null, pointerType: 'mouse' });
}
function hoverOut(el: Element) {
  fireEvent.pointerOut(el, { relatedTarget: document.body, pointerType: 'mouse' });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Stub a live, non-collapsed selection whose range sits inside `container`. */
function stubSelectionInside(container: () => Node | null) {
  vi.spyOn(window, 'getSelection').mockImplementation(
    () =>
      ({
        isCollapsed: false,
        rangeCount: 1,
        getRangeAt: () => ({ collapsed: false, commonAncestorContainer: container() }),
      }) as unknown as Selection,
  );
}

function renderSubject(detail = 'the full selectable body') {
  const utils = render(
    <HoverDetail ariaLabel="Detail for WI-1" testId="hd" header="WI-1 · mid-turn" detail={detail}>
      <span>a readable title</span>
    </HoverDetail>,
  );
  return { ...utils, anchor: screen.getByTestId('hd') };
}

describe('HoverDetail', () => {
  it('opens on hover only after the dwell, so sweeping a list does not strobe panels', () => {
    const { anchor } = renderSubject();
    expect(screen.queryByRole('dialog')).toBeNull();

    hoverIn(anchor);
    advance(OPEN_DELAY_MS - 20);
    // Still closed: a pointer merely PASSING over a row must not open anything.
    expect(screen.queryByRole('dialog')).toBeNull();

    advance(40);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('the full selectable body')).toBeTruthy();
  });

  it('does not open from a touch pointer, which has no hover to leave', () => {
    const { anchor } = renderSubject();
    fireEvent.pointerOver(anchor, { relatedTarget: null, pointerType: 'touch' });
    advance(OPEN_DELAY_MS * 3);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on a GRACE timer, not immediately, so the pointer can travel to it', () => {
    const { anchor } = renderSubject();
    hoverIn(anchor);
    advance(OPEN_DELAY_MS);
    expect(screen.getByRole('dialog')).toBeTruthy();

    hoverOut(anchor);
    advance(CLOSE_GRACE_MS - 100);
    // The whole point of the grace: mid-flight to the panel, still open.
    expect(screen.queryByRole('dialog')).toBeTruthy();

    advance(200);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancels the pending close when the pointer lands INSIDE the panel', () => {
    const { anchor } = renderSubject();
    hoverIn(anchor);
    advance(OPEN_DELAY_MS);
    hoverOut(anchor);

    hoverIn(screen.getByTestId('hd-panel'));
    advance(CLOSE_GRACE_MS * 3);
    expect(screen.queryByRole('dialog')).toBeTruthy();
  });

  it('HOLDS OPEN while text is selected inside it, then closes once the selection goes', () => {
    const { anchor } = renderSubject();
    hoverIn(anchor);
    advance(OPEN_DELAY_MS);
    const panel = screen.getByTestId('hd-panel');

    // The user drags a selection across the body and the pointer exits — the
    // exact sequence that used to destroy the selection they just made.
    stubSelectionInside(() => panel.firstChild ?? panel);
    hoverOut(anchor);
    advance(CLOSE_GRACE_MS * 6);
    expect(screen.queryByRole('dialog')).toBeTruthy();

    // Selection collapses (they clicked away / hit copy) → the re-armed timer
    // is allowed to fire. It must not need another pointer event to do so.
    vi.spyOn(window, 'getSelection').mockImplementation(
      () => ({ isCollapsed: true, rangeCount: 0, getRangeAt: () => null }) as unknown as Selection,
    );
    advance(CLOSE_GRACE_MS + 50);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores a selection that is NOT inside the panel', () => {
    // Otherwise any stray selection anywhere on the page would pin every hover
    // panel open — the hold has to be scoped to this panel's own subtree.
    const { anchor } = renderSubject();
    hoverIn(anchor);
    advance(OPEN_DELAY_MS);

    stubSelectionInside(() => document.body);
    hoverOut(anchor);
    advance(CLOSE_GRACE_MS + 50);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('pins on click: hover-out stops mattering until it is dismissed', () => {
    const { anchor } = renderSubject();
    fireEvent.click(anchor);
    // Pinning opens IMMEDIATELY — a deliberate click should not wait a dwell.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(anchor.getAttribute('data-hover-detail-pinned')).toBe('true');

    hoverOut(anchor);
    advance(CLOSE_GRACE_MS * 10);
    expect(screen.queryByRole('dialog')).toBeTruthy();

    fireEvent.click(screen.getByTestId('hd-close'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(anchor.getAttribute('data-hover-detail-pinned')).toBe('false');
  });

  it('un-pins on a second click of the anchor', () => {
    const { anchor } = renderSubject();
    fireEvent.click(anchor);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(anchor);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('drops the pin when Radix reports a dismissal, so hover works again after', () => {
    // A panel that "closed" but stayed pinned would refuse to reopen on hover —
    // the failure mode is a row that silently stops responding.
    const { anchor } = renderSubject();
    fireEvent.click(anchor);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(anchor.getAttribute('data-hover-detail-pinned')).toBe('false');

    hoverIn(anchor);
    advance(OPEN_DELAY_MS);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows the "click to pin" affordance only while unpinned', () => {
    const { anchor } = renderSubject();
    hoverIn(anchor);
    advance(OPEN_DELAY_MS);
    expect(screen.getByText('click to pin')).toBeTruthy();
    fireEvent.click(anchor);
    expect(screen.queryByText('click to pin')).toBeNull();
  });
});

describe('hasSelectionInside', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is false with no element, no selection, or a collapsed one', () => {
    expect(hasSelectionInside(null)).toBe(false);
    vi.spyOn(window, 'getSelection').mockReturnValue(null);
    expect(hasSelectionInside(document.createElement('div'))).toBe(false);
    vi.spyOn(window, 'getSelection').mockImplementation(
      () => ({ isCollapsed: true, rangeCount: 1, getRangeAt: () => null }) as unknown as Selection,
    );
    expect(hasSelectionInside(document.createElement('div'))).toBe(false);
  });

  it('finds a selection anchored on a TEXT node inside the element', () => {
    // The common case — selecting within one paragraph makes
    // `commonAncestorContainer` a text node, not the element. A check written
    // against elements only would answer false for every real selection.
    const el = document.createElement('div');
    const text = document.createTextNode('selectable');
    el.appendChild(text);
    vi.spyOn(window, 'getSelection').mockImplementation(
      () =>
        ({
          isCollapsed: false,
          rangeCount: 1,
          getRangeAt: () => ({ collapsed: false, commonAncestorContainer: text }),
        }) as unknown as Selection,
    );
    expect(hasSelectionInside(el)).toBe(true);
  });
});
