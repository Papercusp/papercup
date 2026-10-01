import { describe, expect, it } from 'vitest';
import { candidateProfile, canonicalCandidateBackend, calibratedFloor, validateHeldout, type HeldoutQuery } from './candidate-hybrid-bench';
import { validateEmbedderProfile, validateMemoryStorageCompatibility, MEMORY_VECTOR_STORAGE_PROFILES } from '@papercusp/memory';

const entries = [{ key: 'a', text: 'frozen a', kind: 'fact' }, { key: 'b', text: 'frozen b', kind: 'fact' }];
const queries: HeldoutQuery[] = [
  { id: 'c', class: 'lexical-gap', query: 'question a', expected: ['a'], partition: 'calibration', group: 'a' },
  { id: 't', class: 'exact-identifier', query: 'question b', expected: ['b'], partition: 'test', group: 'b' },
];
describe('candidate hybrid fairness guards', () => {
  it('routes precomputed and lexical retrieval to the actual store seam without requiring an extraction client', async () => {
    const backend = canonicalCandidateBackend({
      search: async (_vector, _k, filters) => [{ id: 'actual-id', payload: { data: 'actual text', user_id: filters!.user_id,
        metadata: { corpus_key: 'a' } }, score: 0.8 }],
      lexicalSearch: async () => [{ id: 'lex-id', payload: { data: 'lex text', user_id: 'bench' }, score: 0.2 }],
    });
    expect(await backend.search('q', { scope: 'bench', vector: [1] })).toMatchObject([{ id: 'actual-id', text: 'actual text', metadata: { corpus_key: 'a' } }]);
    expect(await backend.searchLexical!('q', { scope: 'bench' })).toMatchObject([{ id: 'lex-id' }]);
    expect(await backend.search('q', { scope: 'bench', vector: [1], minScore: 0.9, fusionMode: 'floored-union' })).toEqual([]);
    expect(await backend.available()).toEqual({ ok: true });
    await expect(backend.search('q', { scope: 'bench' })).rejects.toThrow('requires vector');
    await expect(backend.search('q', { scope: 'production', vector: [1] })).rejects.toThrow('isolated');
  });
  it('refuses source-target leakage, missing answers and contradictory negative labels', () => {
    expect(() => validateHeldout(entries, queries)).not.toThrow();
    expect(() => validateHeldout(entries, [queries[0], { ...queries[1], group: 'a' }])).toThrow('leaks');
    expect(() => validateHeldout(entries, [queries[0], { ...queries[1], expected: ['missing'] }])).toThrow('absent');
    expect(() => validateHeldout(entries, [queries[0], { ...queries[1], class: 'hard-negative' }])).toThrow('negative');
  });
  it('calibrates on its training partition without looking at heldout scores', () => {
    const calibration = [
      { partition: 'calibration', expected: ['a'], topScore: 0.6 },
      { partition: 'calibration', expected: [], topScore: 0.3 },
    ];
    expect(calibratedFloor(calibration)).toBe(0.31);
    expect(calibratedFloor([...calibration, { partition: 'test', expected: ['b'], topScore: 0.01 }])).toBe(0.31);
  });
  it('keeps mDenseOn identity distinct from equal-width production Gemma storage', () => {
    const profile = candidateProfile('mdenseon');
    expect(validateEmbedderProfile('candidate', profile)).toEqual([]);
    expect(profile.pooling).toBe('cls');
    expect(validateMemoryStorageCompatibility(profile, MEMORY_VECTOR_STORAGE_PROFILES.gemma)).not.toEqual([]);
    expect(validateMemoryStorageCompatibility(profile, { ...MEMORY_VECTOR_STORAGE_PROFILES.gemma,
      acceptedProfileIds: [profile.profileId] })).toEqual([]);
  });
});
