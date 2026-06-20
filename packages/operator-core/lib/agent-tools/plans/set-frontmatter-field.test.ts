/**
 * plans:set-frontmatter-field — the pure helpers behind the generic arbitrary-
 * frontmatter-key setter (plan-templates-and-rubric-v2-2026-06-20 P-002).
 * normalizeFieldValue one-lines + trims (empty → clear); currentFrontmatterField
 * reads an arbitrary key; validateFrontmatterKey is the novel guard (well-formed +
 * reserved). The frontmatter splice itself is setFrontmatterScalar (covered by
 * transfer-owner.test.ts); the handler wiring (withPlanLock + revision +
 * invalidate) mirrors the tested plans:set-initiative / plans:transfer-owner.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeFieldValue,
  currentFrontmatterField,
  validateFrontmatterKey,
  RESERVED_FRONTMATTER_KEYS,
} from './set-frontmatter-field';

describe('normalizeFieldValue', () => {
  it('trims + collapses internal whitespace/newlines to a single line', () => {
    expect(normalizeFieldValue('  rubric   v2  ')).toBe('rubric v2');
    expect(normalizeFieldValue('a\nb')).toBe('a b');
  });
  it('treats empty / whitespace-only as null (clears the field)', () => {
    expect(normalizeFieldValue('')).toBeNull();
    expect(normalizeFieldValue('   ')).toBeNull();
  });
  it('passes null through (explicit clear)', () => {
    expect(normalizeFieldValue(null)).toBeNull();
  });
  it('keeps an ordinary value intact', () => {
    expect(normalizeFieldValue('rubric')).toBe('rubric');
  });
});

describe('currentFrontmatterField', () => {
  const fm = (line: string) => `---\ntitle: P\nslug: p\nstatus: ready\n${line}\n---\n\n# body\n`;
  it('reads an arbitrary key value', () => {
    expect(currentFrontmatterField(fm('template: rubric'), 'template')).toBe('rubric');
  });
  it('returns null when the key is absent or blank', () => {
    expect(currentFrontmatterField(fm('template:'), 'template')).toBeNull();
    expect(currentFrontmatterField('---\ntitle: P\nslug: p\n---\n\n# body\n', 'template')).toBeNull();
  });
});

describe('validateFrontmatterKey', () => {
  it('accepts a well-formed custom key (trimmed)', () => {
    expect(validateFrontmatterKey('template')).toEqual({ ok: true, key: 'template' });
    expect(validateFrontmatterKey('  template_version ')).toEqual({ ok: true, key: 'template_version' });
  });

  it('rejects a malformed key (empty / space / colon / leading-digit / dash / newline)', () => {
    for (const bad of ['', 'has space', 'has:colon', '1leading', 'has-dash', 'a\nb']) {
      expect(validateFrontmatterKey(bad)).toEqual({ ok: false, code: 'invalid_key' });
    }
  });

  it('rejects every reserved key with a pointer to its dedicated setter', () => {
    const reserved = Object.keys(RESERVED_FRONTMATTER_KEYS);
    expect(reserved).toContain('status');
    expect(reserved).toContain('owner');
    expect(reserved).toContain('initiative');
    for (const key of reserved) {
      const r = validateFrontmatterKey(key);
      expect(r).toEqual({ ok: false, code: 'reserved_key', use: RESERVED_FRONTMATTER_KEYS[key] });
    }
  });
});
