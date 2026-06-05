import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { humanizeCapabilityId, shorten } from './format';

/**
 * Property-based invariants for the presentation helpers. Examples undercount
 * here: `humanizeCapabilityId` is a small rewrite over arbitrary id strings,
 * and `shorten` is a clamp+collapse — both have invariants that should hold for
 * every input, not just the hand-picked rows in format.test.ts.
 */

// "Already-clean" ids: lowercase ASCII words joined by ':' / '_' / '-'.
// Once humanized they are title-cased + group-qualified; re-running humanize on
// the *output* must be a no-op (idempotence), because the output contains no
// further '_'/'-' to expand and (after the first ':') no second ':' to re-split.
const cleanWord = fc
  .stringMatching(/^[a-z][a-z0-9_-]*$/)
  .filter((w) => w.length > 0 && /[a-z]/.test(w));

describe('humanizeCapabilityId (property)', () => {
  it('is idempotent: humanize(humanize(id)) === humanize(id)', () => {
    fc.assert(
      fc.property(cleanWord, cleanWord, (group, verb) => {
        const once = humanizeCapabilityId(`${group}:${verb}`);
        expect(humanizeCapabilityId(once)).toBe(once);
      }),
    );
  });

  it('is idempotent on dot-separated ids too', () => {
    fc.assert(
      fc.property(cleanWord, cleanWord, (group, verb) => {
        const once = humanizeCapabilityId(`${group}.${verb}`);
        expect(humanizeCapabilityId(once)).toBe(once);
      }),
    );
  });

  it('is idempotent on separator-less ids', () => {
    fc.assert(
      fc.property(cleanWord, (id) => {
        const once = humanizeCapabilityId(id);
        expect(humanizeCapabilityId(once)).toBe(once);
      }),
    );
  });

  it('never emits a stray - or _ (every segment is fully expanded)', () => {
    fc.assert(
      fc.property(cleanWord, cleanWord, (group, verb) => {
        const out = humanizeCapabilityId(`${group}:${verb}`);
        expect(out).not.toMatch(/[-_]/);
      }),
    );
  });
});

describe('shorten (property)', () => {
  it('output length never exceeds max (for max >= 1)', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 200 }), (text, max) => {
        expect(shorten(text, max).length).toBeLessThanOrEqual(max);
      }),
    );
  });

  it('output is single-lined: never contains a run of 2+ spaces, a tab, or a newline', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 200 }), (text, max) => {
        const out = shorten(text, max);
        expect(out).not.toMatch(/\s\s/); // collapsed runs
        expect(out).not.toMatch(/[\t\n\r]/); // no raw whitespace chars survive
      }),
    );
  });

  it('appends the ellipsis exactly when the collapsed text is longer than max', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 200 }), (text, max) => {
        const collapsed = text.replace(/\s+/g, ' ').trim();
        const out = shorten(text, max);
        if (collapsed.length > max) {
          expect(out.endsWith('…')).toBe(true);
        } else {
          expect(out).toBe(collapsed);
        }
      }),
    );
  });
});
