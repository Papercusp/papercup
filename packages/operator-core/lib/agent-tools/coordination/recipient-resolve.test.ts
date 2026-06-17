import { describe, expect, it } from 'vitest';
import {
  isSelectorOrWildcard,
  resolveBestEffort,
  resolveRecipientsAgainst,
} from './recipient-resolve';

// Two `su-` agents (distinct uuids) + a `pus-` agent — the prefix `su-df00939e`
// uniquely picks the first; the prefix `su-` is ambiguous across both.
const KNOWN = [
  'su-df00939e-1f16-410d-ac0d-ef1aebd41d96',
  'su-fc2fd592-e760-42bd-8057-beb4d06eef52',
  'pus-abcdef01-2345',
];

describe('resolveRecipientsAgainst', () => {
  it('resolves a unique short prefix to the full ownerId (the wake-key bug)', () => {
    const r = resolveRecipientsAgainst(['su-df00939e'], KNOWN);
    expect(r.resolved).toEqual(['su-df00939e-1f16-410d-ac0d-ef1aebd41d96']);
    expect(r.unknown).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it('keeps an exact ownerId match unchanged', () => {
    const id = 'su-fc2fd592-e760-42bd-8057-beb4d06eef52';
    expect(resolveRecipientsAgainst([id], KNOWN).resolved).toEqual([id]);
  });

  it('flags a concrete id that matches no known agent as unknown — nothing resolved', () => {
    const r = resolveRecipientsAgainst(['su-zzz99999'], KNOWN);
    expect(r.unknown).toEqual(['su-zzz99999']);
    expect(r.resolved).toEqual([]);
  });

  it('flags an ambiguous prefix that matches >1 known agent', () => {
    const r = resolveRecipientsAgainst(['su-'], KNOWN);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].id).toBe('su-');
    expect(r.ambiguous[0].matches).toHaveLength(2);
    expect(r.resolved).toEqual([]);
  });

  it('passes wildcards + audience selectors straight through (no roster check)', () => {
    const to = ['*', 'human', '@plan:my-plan', '@role:bee', ''];
    const r = resolveRecipientsAgainst(to, KNOWN);
    expect(r.resolved).toEqual(to);
    expect(r.unknown).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it('mixes resolved + unknown across a multi-recipient send', () => {
    const r = resolveRecipientsAgainst(['su-df00939e', 'su-zzz99999', '*'], KNOWN);
    expect(r.resolved).toContain('su-df00939e-1f16-410d-ac0d-ef1aebd41d96');
    expect(r.resolved).toContain('*');
    expect(r.unknown).toEqual(['su-zzz99999']);
  });
});

describe('isSelectorOrWildcard', () => {
  it('recognizes wildcards + audience selectors', () => {
    for (const s of ['*', 'human', '', '@plan:x', '@role:bee', '@wave:2', '@user:gh:1']) {
      expect(isSelectorOrWildcard(s)).toBe(true);
    }
  });
  it('treats a concrete ownerId as not-a-selector', () => {
    expect(isSelectorOrWildcard('su-df00939e')).toBe(false);
    expect(isSelectorOrWildcard('pus-abcdef01-2345')).toBe(false);
  });
});

describe('resolveBestEffort (the silent shared-layer twin)', () => {
  it('rewrites a unique prefix to the full ownerId', () => {
    expect(resolveBestEffort(['su-df00939e'], KNOWN)).toEqual([
      'su-df00939e-1f16-410d-ac0d-ef1aebd41d96',
    ]);
  });
  it('leaves an UNKNOWN id unchanged (best-effort never rejects)', () => {
    expect(resolveBestEffort(['su-zzz99999'], KNOWN)).toEqual(['su-zzz99999']);
  });
  it('leaves an AMBIGUOUS prefix unchanged', () => {
    expect(resolveBestEffort(['su-'], KNOWN)).toEqual(['su-']);
  });
  it('passes selectors/wildcards + exact ids through untouched', () => {
    const to = ['*', 'human', '@plan:x', 'su-fc2fd592-e760-42bd-8057-beb4d06eef52'];
    expect(resolveBestEffort(to, KNOWN)).toEqual(to);
  });
});
