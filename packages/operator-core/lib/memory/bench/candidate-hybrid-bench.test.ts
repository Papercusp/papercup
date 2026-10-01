import { describe, expect, it } from 'vitest';
import { candidateProfile, calibratedFloor, validateHeldout, type HeldoutQuery } from './candidate-hybrid-bench';
import { validateEmbedderProfile, validateMemoryStorageCompatibility, MEMORY_VECTOR_STORAGE_PROFILES } from '@papercusp/memory';

const entries = [{ key: 'a', text: 'frozen a', kind: 'fact' }, { key: 'b', text: 'frozen b', kind: 'fact' }];
const queries: HeldoutQuery[] = [
  { id: 'c', class: 'lexical-gap', query: 'question a', expected: ['a'], partition: 'calibration', group: 'a' },
  { id: 't', class: 'exact-identifier', query: 'question b', expected: ['b'], partition: 'test', group: 'b' },
];
describe('candidate hybrid fairness guards', () => {
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
