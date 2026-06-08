// Server-side lexicon twin: the the-hive flag drives the cached brand pack,
// and the ambient `term()` resolver reflects it (the-hive-lexicon P-003).

import { afterEach, describe, expect, it } from 'vitest';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { term } from '@papercusp/lexicon';

import { activeServerPackId, refreshLexiconPack } from './configure';

afterEach(() => setFlagOverridesForTest(null));

describe('server lexicon twin', () => {
  it('selects classic when the-hive is off (default)', async () => {
    setFlagOverridesForTest({ 'papercusp-the-hive': false });
    expect(await refreshLexiconPack()).toBe('classic');
    expect(activeServerPackId()).toBe('classic');
    expect(term('pot')).toBe('Pot');
    expect(term('cupboard')).toBe('Cupboard');
  });

  it('selects the-hive and resolves bee labels when the flag is on', async () => {
    setFlagOverridesForTest({ 'papercusp-the-hive': true });
    expect(await refreshLexiconPack()).toBe('the-hive');
    expect(activeServerPackId()).toBe('the-hive');
    expect(term('pot')).toBe('Hive');
    expect(term('cupboard')).toBe('Comb');
    expect(term('fleet', { plural: true })).toBe('Colonies');
  });

  it('flips back to classic when the flag is turned off', async () => {
    setFlagOverridesForTest({ 'papercusp-the-hive': true });
    await refreshLexiconPack();
    expect(term('pot')).toBe('Hive');
    setFlagOverridesForTest({ 'papercusp-the-hive': false });
    await refreshLexiconPack();
    expect(term('pot')).toBe('Pot');
  });
});
