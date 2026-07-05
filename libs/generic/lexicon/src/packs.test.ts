import { describe, expect, it } from 'vitest';
import { BRAND_PACKS, BRAND_PACK_IDS, DEFAULT_PACK_ID } from './packs';
import type { BuiltInTermKey } from './types';

// The full set of canonical term keys — kept in sync with TermKey by the
// exhaustiveness check below. If a key is added to TermKey, add it here and
// every pack must cover it (or this test fails to compile / fails at runtime).
const ALL_TERM_KEYS: BuiltInTermKey[] = [
  'pot',
  'fleet',
  'operator',
  'brain',
  'overwatch',
  'scout',
  'contributor',
  'human',
  'chunk',
  'cupboard',
  'node',
  'substrate',
  'blueprint',
  'harness',
  'signal',
];

describe('brand packs', () => {
  it('default pack is classic (no-rebrand baseline)', () => {
    expect(DEFAULT_PACK_ID).toBe('classic');
  });

  it('every pack covers every term key with non-empty forms', () => {
    for (const id of BRAND_PACK_IDS) {
      const pack = BRAND_PACKS[id];
      for (const key of ALL_TERM_KEYS) {
        const forms = pack.terms[key];
        expect(forms, `${id}.${key}`).toBeDefined();
        expect(forms.one.length, `${id}.${key}.one`).toBeGreaterThan(0);
        expect(forms.other.length, `${id}.${key}.other`).toBeGreaterThan(0);
      }
    }
  });

  it('exhaustively covers TermKey (no stray / missing keys)', () => {
    for (const id of BRAND_PACK_IDS) {
      const keys = Object.keys(BRAND_PACKS[id].terms).sort();
      expect(keys).toEqual([...ALL_TERM_KEYS].sort());
    }
  });

  it('each pack id matches its key in the registry', () => {
    for (const id of BRAND_PACK_IDS) {
      expect(BRAND_PACKS[id].id).toBe(id);
    }
  });
});
