// @vitest-environment jsdom
/**
 * Unit coverage for the framework-free find-in-page navigation helpers.
 *
 * The DOM-registry helpers (collectOrderedRanges / setActiveHighlight /
 * scrollRangeIntoView) depend on the CSS Custom Highlight API + layout,
 * which jsdom does not implement — those are covered by the Playwright
 * e2e (apps/operator/e2e/find-in-page.spec.ts) and the manual Tauri-shell
 * pass. Here we test the pure index math, the label formatter, and the
 * document-order range sort (which jsdom's Range DOES support).
 */
import { describe, expect, it } from 'vitest';
import { nextIndex, prevIndex, formatMatchLabel, orderRanges } from './engine';

describe('nextIndex', () => {
  it('advances and wraps to the first match', () => {
    expect(nextIndex(0, 3)).toBe(1);
    expect(nextIndex(1, 3)).toBe(2);
    expect(nextIndex(2, 3)).toBe(0);
  });
  it('moves from "no active match" (-1) to the first', () => {
    expect(nextIndex(-1, 3)).toBe(0);
  });
  it('returns -1 when there are no matches', () => {
    expect(nextIndex(0, 0)).toBe(-1);
    expect(nextIndex(-1, 0)).toBe(-1);
  });
});

describe('prevIndex', () => {
  it('retreats and wraps to the last match', () => {
    expect(prevIndex(2, 3)).toBe(1);
    expect(prevIndex(1, 3)).toBe(0);
    expect(prevIndex(0, 3)).toBe(2);
  });
  it('moves from "no active match" (-1) to the last', () => {
    expect(prevIndex(-1, 3)).toBe(2);
  });
  it('returns -1 when there are no matches', () => {
    expect(prevIndex(0, 0)).toBe(-1);
  });
});

describe('formatMatchLabel', () => {
  it('shows 0/0 when there are no matches', () => {
    expect(formatMatchLabel(-1, 0)).toBe('0/0');
    expect(formatMatchLabel(0, 0)).toBe('0/0');
  });
  it('shows a 1-based active position over the total', () => {
    expect(formatMatchLabel(0, 5)).toBe('1/5');
    expect(formatMatchLabel(4, 5)).toBe('5/5');
  });
  it('shows 0/total before a match is selected', () => {
    expect(formatMatchLabel(-1, 5)).toBe('0/5');
  });
});

describe('orderRanges', () => {
  it('sorts ranges into document order regardless of input order', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span>alpha</span><span>bravo</span><span>charlie</span>';
    document.body.appendChild(root);
    const [a, b, c] = Array.from(root.querySelectorAll('span'));
    const mk = (el: Element) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r;
    };
    const shuffled = [mk(c), mk(a), mk(b)];

    const ordered = orderRanges(shuffled);

    expect(ordered.map((r) => r.startContainer.textContent)).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ]);
    document.body.removeChild(root);
  });

  it('does not mutate the input array', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span>one</span><span>two</span>';
    document.body.appendChild(root);
    const [one, two] = Array.from(root.querySelectorAll('span'));
    const mk = (el: Element) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r;
    };
    const input = [mk(two), mk(one)];
    const snapshot = [...input];

    orderRanges(input);

    expect(input).toEqual(snapshot);
    document.body.removeChild(root);
  });
});
