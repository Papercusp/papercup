/**
 * conflict-markers.ts — the content-lint-side wrapper over
 * scripts/check-conflict-markers.mjs's pure detector (EI-1836 /
 * EI-18217568076594579). The underlying regex's full no-false-positive corpus
 * is already locked in check-conflict-markers-guard.test.ts; this file pins
 * the (file, text) ContentDetector-shaped wrapper this module adds, and that
 * the import bridges to the exact same detector (no drift).
 */
import { describe, it, expect } from 'vitest';
import { findConflictMarker, CONFLICT_MARKER_ERE } from './conflict-markers';

const B = (c: string) => c.repeat(7); // a 7-char bracket run, without a literal marker in this source

describe('findConflictMarker (content-lint wrapper)', () => {
  it('flags a <<< start marker regardless of the file argument (text-only detection)', () => {
    const hit = findConflictMarker('apps/operator/app/globals.css', `a {}\n${B('<')} Updated upstream\nb {}`);
    expect(hit).not.toBeNull();
    expect(hit?.line).toBe(2);
    expect(hit?.marker).toBe(B('<'));
  });

  it('flags a >>> end marker and a ||| diff3 base marker', () => {
    expect(findConflictMarker('f.ts', `${B('>')} Stashed changes`)).toMatchObject({ line: 1 });
    expect(findConflictMarker('f.ts', `a\nb\n${B('|')} base`)).toMatchObject({ line: 3 });
  });

  it('does NOT flag a lone ======= separator (deliberate FP exclusion)', () => {
    expect(findConflictMarker('f.md', `Heading\n${B('=')}\nbody`)).toBeNull();
  });

  it('does NOT flag normal code/markdown', () => {
    expect(findConflictMarker('f.ts', '---\nconst x = a >> b;\n## Heading')).toBeNull();
  });

  it('re-exports the SAME ERE the CI script scans with (one source of truth)', () => {
    expect(CONFLICT_MARKER_ERE).toBe('^(<{7}|>{7}|\\|{7})([ \\t]|$)');
  });
});
