/**
 * remember-coerce.test.ts — WI-1982 write-path invariant (task #36, memory
 * public-release hardening). remember-coerce.ts had NO test of its own.
 *
 * The contract it guards is a data-integrity one on the WRITE path: memory:remember
 * ran a z.preprocess(coerceMemoryKind, …) so that a mis-used `kind` (a legacy kind,
 * a free-form label, or a missing one) is COERCED to the closest valid enum member
 * BEFORE enum validation — a durable fact must never be rejected-and-LOST purely on
 * the taxonomy. The twin invariant is just as important: `content` is NEVER
 * fabricated, so a genuinely-contentless call must still fail (the double-encoded-args
 * class is a separate dispatch-layer bug, deliberately not papered over here).
 *
 * This file pins both halves — the pure functions AND the real z.preprocess wiring
 * that remember.ts:127-143 depends on.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/memory/remember-coerce.test.ts
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { normalizeMemoryKind, coerceMemoryKind } from './remember-coerce';

const VALID = ['user', 'feedback', 'project', 'reference'] as const;

describe('normalizeMemoryKind — the four valid kinds pass through unchanged', () => {
  it.each(VALID)('%s → %s (identity)', (k) => {
    expect(normalizeMemoryKind(k)).toBe(k);
  });

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(normalizeMemoryKind('USER')).toBe('user');
    expect(normalizeMemoryKind('  Feedback  ')).toBe('feedback');
    expect(normalizeMemoryKind('Project')).toBe('project');
    expect(normalizeMemoryKind('\treference\n')).toBe('reference');
  });
});

describe('normalizeMemoryKind — legacy + free-form aliases map to the unified taxonomy', () => {
  it.each([
    // user = who they are
    ['identity', 'user'], ['who', 'user'], ['profile', 'user'], ['person', 'user'],
    // feedback = how to work
    ['preference', 'feedback'], ['correction', 'feedback'], ['howto', 'feedback'],
    ['how-to', 'feedback'], ['approach', 'feedback'], ['convention', 'feedback'], ['lesson', 'feedback'],
    // project = ongoing work context
    ['work', 'project'], ['context', 'project'], ['task', 'project'], ['progress', 'project'], ['status', 'project'],
    // reference = pointers + hard-won technical facts
    ['fact', 'reference'], ['note', 'reference'], ['notes', 'reference'], ['technical', 'reference'],
    ['tech', 'reference'], ['insight', 'reference'], ['pointer', 'reference'], ['ref', 'reference'],
    ['doc', 'reference'], ['docs', 'reference'], ['gotcha', 'reference'],
  ] as const)('%s → %s', (input, expected) => {
    expect(normalizeMemoryKind(input)).toBe(expected);
  });

  it('maps aliases case-insensitively too (Identity → user, CORRECTION → feedback)', () => {
    expect(normalizeMemoryKind('Identity')).toBe('user');
    expect(normalizeMemoryKind('CORRECTION')).toBe('feedback');
    expect(normalizeMemoryKind(' Preference ')).toBe('feedback');
  });
});

describe('normalizeMemoryKind — anything unrecognised defaults to reference (never throws, never drops)', () => {
  it.each(['banana', '', '   ', 'user2', 'feedbackk', 'references'])('unknown label %j → reference', (k) => {
    expect(normalizeMemoryKind(k)).toBe('reference');
  });

  it.each([undefined, null, 42, {}, [], true])('non-string %j → reference', (k) => {
    expect(normalizeMemoryKind(k as unknown)).toBe('reference');
  });
});

describe('coerceMemoryKind — non-objects pass straight through (identity, no wrapping)', () => {
  it.each(['a string', 42, null, undefined, true])('%j returned as-is', (v) => {
    expect(coerceMemoryKind(v as unknown)).toBe(v);
  });

  it('an ARRAY is not treated as a record — returned as the same reference', () => {
    const arr = ['x'];
    expect(coerceMemoryKind(arr)).toBe(arr);
  });
});

describe('coerceMemoryKind — a valid exactly-cased kind is left byte-identical (no needless clone)', () => {
  it.each(VALID)('kind=%s returns the SAME object reference', (k) => {
    const raw = { content: 'x', kind: k };
    expect(coerceMemoryKind(raw)).toBe(raw);
  });
});

describe('coerceMemoryKind — a mis-cased / alias / missing kind is normalised on a CLONE, siblings preserved', () => {
  it('an uppercase valid kind is normalised — cloned, original never mutated', () => {
    const raw = { content: 'x', kind: 'USER' };
    const out = coerceMemoryKind(raw) as Record<string, unknown>;
    expect(out).not.toBe(raw);        // cloned, not returned by reference
    expect(raw.kind).toBe('USER');    // input object left untouched
    expect(out.kind).toBe('user');
    expect(out.content).toBe('x');
  });

  it('a legacy kind is bucketed and ALL sibling fields carry through the clone', () => {
    const raw = { content: 'the user prefers small PRs', kind: 'preference', harness_slug: 'papercup', force: true };
    const out = coerceMemoryKind(raw) as Record<string, unknown>;
    expect(out.kind).toBe('feedback');
    expect(out.content).toBe('the user prefers small PRs');
    expect(out.harness_slug).toBe('papercup');
    expect(out.force).toBe(true);
  });

  it('a MISSING kind defaults to reference (content untouched)', () => {
    const out = coerceMemoryKind({ content: 'x' }) as Record<string, unknown>;
    expect(out.kind).toBe('reference');
    expect(out.content).toBe('x');
  });

  it('a non-string kind defaults to reference', () => {
    expect((coerceMemoryKind({ content: 'x', kind: 123 }) as Record<string, unknown>).kind).toBe('reference');
    expect((coerceMemoryKind({ content: 'x', kind: null }) as Record<string, unknown>).kind).toBe('reference');
  });
});

describe('coerceMemoryKind — NEVER fabricates content (coerce the kind, do NOT invent a fact)', () => {
  it('an object with no content gets a kind but NO content key is invented', () => {
    const out = coerceMemoryKind({ kind: 'identity' }) as Record<string, unknown>;
    expect(out.kind).toBe('user');
    expect('content' in out).toBe(false);
  });

  it('an empty object gets kind=reference and still no content', () => {
    const out = coerceMemoryKind({}) as Record<string, unknown>;
    expect(out.kind).toBe('reference');
    expect('content' in out).toBe(false);
  });
});

describe('coerceMemoryKind ∘ z.preprocess — the real wiring (remember.ts:127-143): coerce THEN enum-validate, content still required', () => {
  // Mirrors the exact schema shape memory:remember builds: coercion is the
  // preprocess step feeding a z.object whose `kind` is the strict enum.
  const schema = z.preprocess(
    coerceMemoryKind,
    z.object({ content: z.string().min(1), kind: z.enum(['user', 'feedback', 'project', 'reference']) }),
  );

  it('a legacy-kind fact is SAVED, not rejected — kind coerced to a valid enum member', () => {
    expect(schema.parse({ content: 'we chose X over Y', kind: 'correction' }))
      .toEqual({ content: 'we chose X over Y', kind: 'feedback' });
  });

  it('a free-form label still parses (coerced to reference)', () => {
    expect(schema.parse({ content: 'db resets nightly', kind: 'gotcha' }))
      .toEqual({ content: 'db resets nightly', kind: 'reference' });
  });

  it('a MISSING kind no longer fails the enum — defaults to reference', () => {
    expect(schema.parse({ content: 'a bare fact' }))
      .toEqual({ content: 'a bare fact', kind: 'reference' });
  });

  it('a valid, exactly-cased kind passes through untouched', () => {
    expect(schema.parse({ content: 'x', kind: 'project' }))
      .toEqual({ content: 'x', kind: 'project' });
  });

  it('a genuinely-missing content STILL fails validation (coercion never invents a fact)', () => {
    expect(() => schema.parse({ kind: 'user' })).toThrow();
    expect(() => schema.parse({})).toThrow();
    expect(() => schema.parse({ content: '', kind: 'fact' })).toThrow(); // empty content is not a fact
  });
});
