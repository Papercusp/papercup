/**
 * dns-truth-divergence.test.ts — EI-12952 regression guard.
 *
 * Locks the comparator's core distinction: a fully disjoint answer set (the
 * observed hijack signature) diverges; a partial-overlap or empty-side
 * comparison does not (benign CDN rotation / a plain lookup failure).
 */
import { describe, it, expect } from 'vitest';
import { evaluateDnsTruthDivergence } from './dns-truth-divergence';

describe('evaluateDnsTruthDivergence (EI-12952)', () => {
  it('the live incident signature: fully disjoint answer sets diverge', () => {
    const local = { addresses: ['18.204.152.241', '18.204.152.241'] }; // duplicated, as observed live
    const truth = { addresses: ['172.67.145.145', '104.21.73.140'] };
    const v = evaluateDnsTruthDivergence(local, truth);
    expect(v.diverges).toBe(true);
    if (v.diverges) {
      expect(v.localOnly).toEqual(['18.204.152.241']); // de-duplicated
      expect(v.truthOnly.sort()).toEqual(['104.21.73.140', '172.67.145.145']);
      expect(v.reason).toMatch(/EI-12952/);
    }
  });

  it('identical answer sets do not diverge', () => {
    const set = { addresses: ['172.67.145.145', '104.21.73.140'] };
    const v = evaluateDnsTruthDivergence(set, { addresses: [...set.addresses] });
    expect(v.diverges).toBe(false);
  });

  it('partial overlap (CDN edge rotation) does NOT diverge', () => {
    const local = { addresses: ['104.20.23.154'] };
    const truth = { addresses: ['172.66.147.243', '104.20.23.154'] };
    const v = evaluateDnsTruthDivergence(local, truth);
    expect(v.diverges).toBe(false);
    expect(v.reason).toMatch(/overlap/);
  });

  it('order does not matter — sets are compared, not sequences', () => {
    const local = { addresses: ['b', 'a'] };
    const truth = { addresses: ['a', 'b'] };
    expect(evaluateDnsTruthDivergence(local, truth).diverges).toBe(false);
  });

  it('an empty local side (lookup failure) is reported as non-divergent, not a hijack', () => {
    const v = evaluateDnsTruthDivergence({ addresses: [] }, { addresses: ['172.67.145.145'] });
    expect(v.diverges).toBe(false);
    expect(v.reason).toMatch(/lookup failure/);
  });

  it('an empty truth side is reported as non-divergent, not a hijack', () => {
    const v = evaluateDnsTruthDivergence({ addresses: ['18.204.152.241'] }, { addresses: [] });
    expect(v.diverges).toBe(false);
    expect(v.reason).toMatch(/lookup failure/);
  });

  it('both sides empty is reported as non-evaluable, not a hijack', () => {
    const v = evaluateDnsTruthDivergence({ addresses: [] }, { addresses: [] });
    expect(v.diverges).toBe(false);
    expect(v.reason).toMatch(/no answer/);
  });

  it('blank/falsy entries in the address arrays are ignored', () => {
    const v = evaluateDnsTruthDivergence({ addresses: ['', '172.67.145.145'] }, { addresses: ['172.67.145.145', ''] });
    expect(v.diverges).toBe(false);
  });

  it('a genuinely down domain (truth also empty) never trips the hijack path', () => {
    // A real outage means the EXTERNAL check also fails — must not be
    // conflated with the "local lies, truth is fine" hijack signature.
    const v = evaluateDnsTruthDivergence({ addresses: [] }, { addresses: [] });
    expect(v.diverges).toBe(false);
  });
});
