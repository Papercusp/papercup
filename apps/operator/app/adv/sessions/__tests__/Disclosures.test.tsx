/**
 * @vitest-environment jsdom
 *
 * Disclosures — the popup's render of what an agent's own orient left OUT
 * (popup-agent-state-coverage-2026-08-18 P-005).
 *
 * The tests are organised around the ONE property that makes this feature worth
 * having, because it is also the one a later "tidy-up" will break:
 *
 *   **no recording (null) and recorded-nothing ({}) both render as NOTHING,
 *   and neither may ever render as a reassurance.**
 *
 * A component that prints "no facts were withheld" on a null recording is
 * strictly worse than the bug it replaced: it converts a silent gap into a
 * confident false statement, on the exact surface a human uses to decide whether
 * an agent is flying blind.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  Disclosures,
  disclosureLine,
  disclosureLines,
  FACTS_DISCLOSURE_KEYS,
  READ_DISCLOSURE_KEYS,
  type RecordedOrientDisclosures,
} from '../Disclosures';

const AT = '2026-08-18T20:57:00.000Z';

const NARROWED: RecordedOrientDisclosures = {
  at: AT,
  disclosures: {
    factsNarrowed: {
      fold: 'never-drop',
      prefixes: ['dead-end:', 'wall:'],
      reason: "mode:'monitor' tick",
    },
  },
};

const ALL_SIX: RecordedOrientDisclosures = {
  at: AT,
  disclosures: {
    factsWithheld: { count: 3, reason: 'queen-loop steering' },
    factsNarrowed: { fold: 'never-drop', prefixes: ['dead-end:'], reason: 'monitor' },
    factEvictionDisclosures: [
      {
        scope: 'workspace',
        scopeRef: null,
        recentEvictedCount: 39,
        latestEvictedAt: AT,
        meaning: 'evicted, not never-asserted',
      },
    ],
    claimableTruncated: { shown: 4, truncatedByLimit: true, limit: 20, more: 'work_items:claimable' },
    announcedGatesTruncated: { shown: 8, total: 14, more: 'events:catalog' },
    recipesTruncated: { shown: 3, truncatedByLimit: true, limit: 3, more: 'recipes:search' },
  },
};

describe('Disclosures — absent is not clean (the load-bearing property)', () => {
  it('renders NOTHING for a null recording — never a reassurance', () => {
    const { container } = render(
      <Disclosures recorded={null} keys={FACTS_DISCLOSURE_KEYS} testId="d" />,
    );
    expect(container.innerHTML).toBe('');
    // And specifically: no text a reader could take as a guarantee.
    expect(container.textContent ?? '').not.toMatch(/nothing|none|no facts|clean|all/i);
  });

  it('renders NOTHING for an undefined recording', () => {
    const { container } = render(
      <Disclosures recorded={undefined} keys={FACTS_DISCLOSURE_KEYS} testId="d" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders NOTHING for a recording whose orient genuinely cut nothing', () => {
    const { container } = render(
      <Disclosures recorded={{ at: AT, disclosures: {} }} keys={FACTS_DISCLOSURE_KEYS} testId="d" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('CALIBRATION: it does render when there IS something to disclose', () => {
    // Without this, every assertion above would also pass for a component that
    // returned null unconditionally.
    render(<Disclosures recorded={NARROWED} keys={FACTS_DISCLOSURE_KEYS} testId="d" />);
    expect(screen.getByTestId('d')).toBeTruthy();
  });
});

describe('Disclosures — the narrowed-fold line says what cannot be concluded', () => {
  it('states that the list is not a census and its gaps are not evidence', () => {
    render(<Disclosures recorded={NARROWED} keys={FACTS_DISCLOSURE_KEYS} testId="d" />);
    const text = screen.getByTestId('d').textContent ?? '';
    // The reader's mistake to prevent is reading an empty facts list as
    // "no facts stand". The line must speak to THAT, not merely report a mode.
    expect(text).toMatch(/not a census/i);
    expect(text).toMatch(/not evidence/i);
  });

  it('names the slots that DID fold, so the reader knows what they are seeing', () => {
    render(<Disclosures recorded={NARROWED} keys={FACTS_DISCLOSURE_KEYS} testId="d" />);
    expect(screen.getByTestId('d').textContent ?? '').toContain('dead-end:');
  });
});

describe('Disclosures — key scoping keeps one component serving two sections', () => {
  it('a facts-scoped instance shows only the three facts markers', () => {
    render(<Disclosures recorded={ALL_SIX} keys={FACTS_DISCLOSURE_KEYS} testId="facts" />);
    const markers = Array.from(
      screen.getByTestId('facts').querySelectorAll('[data-marker]'),
    ).map((n) => n.getAttribute('data-marker'));
    expect(markers.sort()).toEqual([...FACTS_DISCLOSURE_KEYS].sort());
  });

  it('a reads-scoped instance shows only the three bounded-read markers', () => {
    render(<Disclosures recorded={ALL_SIX} keys={READ_DISCLOSURE_KEYS} testId="reads" />);
    const markers = Array.from(
      screen.getByTestId('reads').querySelectorAll('[data-marker]'),
    ).map((n) => n.getAttribute('data-marker'));
    expect(markers.sort()).toEqual([...READ_DISCLOSURE_KEYS].sort());
  });

  it('renders the verb that returns the rest — a marker without one is half a disclosure', () => {
    render(<Disclosures recorded={ALL_SIX} keys={READ_DISCLOSURE_KEYS} testId="reads" />);
    const text = screen.getByTestId('reads').textContent ?? '';
    expect(text).toContain('events:catalog');
    expect(text).toContain('work_items:claimable');
  });
});

describe('disclosureLine — pure shaping', () => {
  it('returns null for every marker the payload did not carry', () => {
    for (const key of [...FACTS_DISCLOSURE_KEYS, ...READ_DISCLOSURE_KEYS]) {
      expect(disclosureLine(key, {}), `${key} must yield no line when absent`).toBeNull();
      expect(disclosureLine(key, undefined)).toBeNull();
    }
  });

  it('gates: says the agent was never told the rest exist, not just that a list was cut', () => {
    // Load-bearing rather than cosmetic — an undisclosed gate drop means the
    // agent parks on the wrong event, or on none.
    const line = disclosureLine('announcedGatesTruncated', {
      announcedGatesTruncated: { shown: 8, total: 14, more: 'events:catalog' },
    });
    expect(line?.text).toMatch(/never told/i);
    expect(line?.text).toContain('8');
    expect(line?.text).toContain('14');
  });

  it('claimable: admits an unknown population rather than fabricating a total', () => {
    const line = disclosureLine('claimableTruncated', {
      claimableTruncated: { shown: 20, truncatedByLimit: true, limit: 20, more: 'work_items:claimable' },
    });
    expect(line?.text).toMatch(/unknown/i);
    // A fabricated total is worse than an admitted bound — so no invented number.
    expect(line?.text).not.toMatch(/of \d+ /);
  });

  it('claimable: uses the authoritative total when the producer measured one', () => {
    const line = disclosureLine('claimableTruncated', {
      claimableTruncated: { shown: 4, total: 52, totalScope: 'open in papercusp', more: 'x' },
    });
    expect(line?.text).toContain('4');
    expect(line?.text).toContain('52');
    expect(line?.text).toContain('open in papercusp');
  });

  it('evictions: sums the rows rather than reporting only the first scope', () => {
    const line = disclosureLine('factEvictionDisclosures', {
      factEvictionDisclosures: [
        { scope: 'workspace', scopeRef: null, recentEvictedCount: 39, latestEvictedAt: AT, meaning: '' },
        { scope: 'owner', scopeRef: 'su-1', recentEvictedCount: 3, latestEvictedAt: AT, meaning: '' },
      ],
    });
    expect(line?.text).toContain('42');
    expect(line?.text).toContain('workspace');
    expect(line?.text).toContain('owner');
  });

  it('singularises counts', () => {
    const one = disclosureLine('factsWithheld', { factsWithheld: { count: 1, reason: 'r' } });
    expect(one?.text).toMatch(/1 steering fact /);
    const many = disclosureLine('factsWithheld', { factsWithheld: { count: 2, reason: 'r' } });
    expect(many?.text).toMatch(/2 steering facts /);
  });

  it('survives a payload that predates a field (the wire-contract rule)', () => {
    // The SPA rebuilds on the vite hot path while the sidecar reloads only on
    // restart, so a bundle routinely sees payloads missing fields it knows.
    const line = disclosureLine('claimableTruncated', { claimableTruncated: {} as never });
    expect(line).not.toBeNull();
    expect(() => String(line?.text)).not.toThrow();
  });
});

describe('disclosureLines', () => {
  it('preserves the caller key order, so two sections read consistently', () => {
    const lines = disclosureLines(ALL_SIX, FACTS_DISCLOSURE_KEYS);
    expect(lines.map((l) => l.key)).toEqual([...FACTS_DISCLOSURE_KEYS]);
  });

  it('yields [] for a null recording', () => {
    expect(disclosureLines(null, FACTS_DISCLOSURE_KEYS)).toEqual([]);
  });
});
