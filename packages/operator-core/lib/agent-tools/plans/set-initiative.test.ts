/**
 * plans:set-initiative — the pure helpers behind the initiative grouping verb
 * (shared-hive-collaboration-2026-06-14 P-015). normalizeInitiative one-lines +
 * trims the label and treats empty as "clear"; currentInitiative reads the
 * existing label. The frontmatter splice itself is setFrontmatterScalar, covered
 * by transfer-owner.test.ts; the handler wiring (withPlanLock + revision +
 * invalidate) mirrors the tested plans:transfer-owner.
 */
import { describe, it, expect } from 'vitest';
import { normalizeInitiative, currentInitiative } from './set-initiative';

describe('normalizeInitiative', () => {
  it('trims and collapses internal whitespace/newlines to a single line', () => {
    expect(normalizeInitiative('  shared   hive  ')).toBe('shared hive');
    expect(normalizeInitiative('a\nb')).toBe('a b');
  });

  it('treats empty / whitespace-only as null (clears the field)', () => {
    expect(normalizeInitiative('')).toBeNull();
    expect(normalizeInitiative('   ')).toBeNull();
  });

  it('passes null through (explicit clear)', () => {
    expect(normalizeInitiative(null)).toBeNull();
  });

  it('keeps an ordinary label intact', () => {
    expect(normalizeInitiative('release-gate')).toBe('release-gate');
  });
});

describe('currentInitiative', () => {
  const fm = (line: string) => `---\ntitle: P\nslug: p\nstatus: ready\n${line}\n---\n\n# body\n`;

  it('reads the existing initiative label', () => {
    expect(currentInitiative(fm('initiative: shared-hive'))).toBe('shared-hive');
  });

  it('returns null when the key is absent or blank', () => {
    expect(currentInitiative('---\ntitle: P\nslug: p\nstatus: ready\n---\n\n# body\n')).toBeNull();
    expect(currentInitiative(fm('initiative:'))).toBeNull();
  });
});
