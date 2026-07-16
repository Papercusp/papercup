import { describe, it, expect } from 'vitest';
import { evaluateReleaseProfile, lineageMismatches } from './evaluate';
import type { ComponentCheckResult, ComponentSpec } from './types';

const NOW = Date.parse('2026-07-16T12:00:00.000Z');

function fixedCheck(result: Partial<ComponentCheckResult> = {}): () => Promise<ComponentCheckResult> {
  return async () => ({
    verdict: 'pass',
    reason: 'ok',
    measuredAt: new Date(NOW).toISOString(),
    evidence: [{ ref: 'ev-1' }],
    ...result,
  });
}

function component(overrides: Partial<ComponentSpec> = {}): ComponentSpec {
  return {
    key: overrides.key ?? 'comp',
    title: overrides.title ?? 'A component',
    mandatory: overrides.mandatory ?? true,
    maxAgeMs: overrides.maxAgeMs,
    check: overrides.check ?? fixedCheck(),
  };
}

describe('evaluateReleaseProfile — happy path', () => {
  it('GOes when every mandatory component passes', async () => {
    const verdict = await evaluateReleaseProfile(
      {
        profileRef: 'test-profile',
        components: [component({ key: 'a' }), component({ key: 'b' })],
      },
      { now: NOW },
    );
    expect(verdict.go).toBe(true);
    expect(verdict.reason).toMatch(/all 2 mandatory/);
    expect(verdict.components).toHaveLength(2);
    expect(verdict.components.every((c) => c.verdict === 'pass')).toBe(true);
  });

  it('an advisory (non-mandatory) fail never blocks GO', async () => {
    const verdict = await evaluateReleaseProfile(
      {
        profileRef: 'test-profile',
        components: [
          component({ key: 'mandatory-ok' }),
          component({ key: 'advisory-fail', mandatory: false, check: fixedCheck({ verdict: 'fail', reason: 'meh' }) }),
        ],
      },
      { now: NOW },
    );
    expect(verdict.go).toBe(true);
    expect(verdict.components.find((c) => c.key === 'advisory-fail')?.verdict).toBe('fail');
  });
});

describe('evaluateReleaseProfile — the refuse-GO contract', () => {
  it('refuses GO on a mandatory FAIL', async () => {
    const verdict = await evaluateReleaseProfile(
      {
        profileRef: 'p',
        components: [component({ key: 'broken', check: fixedCheck({ verdict: 'fail', reason: 'red criterion' }) })],
      },
      { now: NOW },
    );
    expect(verdict.go).toBe(false);
    expect(verdict.components[0].verdict).toBe('fail');
    expect(verdict.reason).toMatch(/broken \(fail: red criterion\)/);
  });

  it('refuses GO on a mandatory UNKNOWN', async () => {
    const verdict = await evaluateReleaseProfile(
      {
        profileRef: 'p',
        components: [component({ key: 'unassessed', check: fixedCheck({ verdict: 'unknown', reason: 'no evidence yet' }) })],
      },
      { now: NOW },
    );
    expect(verdict.go).toBe(false);
    expect(verdict.components[0].verdict).toBe('unknown');
  });

  it('refuses GO on a checker that THROWS (never crashes the evaluation)', async () => {
    const verdict = await evaluateReleaseProfile(
      {
        profileRef: 'p',
        components: [
          component({
            key: 'exploding',
            check: async () => {
              throw new Error('store unreachable');
            },
          }),
        ],
      },
      { now: NOW },
    );
    expect(verdict.go).toBe(false);
    expect(verdict.components[0].verdict).toBe('unknown');
    expect(verdict.components[0].reason).toMatch(/checker threw: store unreachable/);
  });

  it('refuses GO on STALE evidence, even though the raw verdict is pass', async () => {
    const measuredAt = new Date(NOW - 3 * 60 * 60_000).toISOString(); // 3h old
    const verdict = await evaluateReleaseProfile(
      {
        profileRef: 'p',
        components: [
          component({
            key: 'stale-rubric',
            maxAgeMs: 60 * 60_000, // 1h freshness window
            check: fixedCheck({ verdict: 'pass', reason: 'was fine 3h ago', measuredAt }),
          }),
        ],
      },
      { now: NOW },
    );
    expect(verdict.go).toBe(false);
    expect(verdict.components[0].verdict).toBe('stale');
    expect(verdict.components[0].reason).toMatch(/180min old, past the 60min/);
  });

  it('a component within its freshness window still passes', async () => {
    const measuredAt = new Date(NOW - 10 * 60_000).toISOString(); // 10min old
    const verdict = await evaluateReleaseProfile(
      {
        profileRef: 'p',
        components: [
          component({
            key: 'fresh-rubric',
            maxAgeMs: 60 * 60_000,
            check: fixedCheck({ measuredAt }),
          }),
        ],
      },
      { now: NOW },
    );
    expect(verdict.go).toBe(true);
  });

  it('refuses GO on a LINEAGE MISMATCH between the evidence and the expected candidate', async () => {
    const verdict = await evaluateReleaseProfile(
      {
        profileRef: 'p',
        expectedLineage: { sha: 'candidate-sha-2' },
        components: [
          component({
            key: 'stale-generation',
            check: fixedCheck({ lineage: { sha: 'candidate-sha-1' } }),
          }),
        ],
      },
      { now: NOW },
    );
    expect(verdict.go).toBe(false);
    expect(verdict.components[0].verdict).toBe('lineage-mismatch');
    expect(verdict.components[0].reason).toMatch(/disagrees with the expected candidate on: sha/);
  });

  it('a component with NO lineage stamp is not judged against expectedLineage', async () => {
    const verdict = await evaluateReleaseProfile(
      {
        profileRef: 'p',
        expectedLineage: { sha: 'candidate-sha-2' },
        components: [component({ key: 'lineage-agnostic', check: fixedCheck({ lineage: null }) })],
      },
      { now: NOW },
    );
    expect(verdict.go).toBe(true);
  });

  it('a matching lineage passes', async () => {
    const verdict = await evaluateReleaseProfile(
      {
        profileRef: 'p',
        expectedLineage: { sha: 'candidate-sha-2', generation: 'gen-9' },
        components: [
          component({ key: 'matches', check: fixedCheck({ lineage: { sha: 'candidate-sha-2', generation: 'gen-9' } }) }),
        ],
      },
      { now: NOW },
    );
    expect(verdict.go).toBe(true);
  });

  it('refuses GO with zero components declared', async () => {
    const verdict = await evaluateReleaseProfile({ profileRef: 'p', components: [] }, { now: NOW });
    expect(verdict.go).toBe(false);
    expect(verdict.reason).toMatch(/zero components/);
  });

  it('refuses GO when every component is advisory (no mandatory gate at all)', async () => {
    const verdict = await evaluateReleaseProfile(
      { profileRef: 'p', components: [component({ mandatory: false })] },
      { now: NOW },
    );
    expect(verdict.go).toBe(false);
    expect(verdict.reason).toMatch(/zero MANDATORY components/);
  });

  it('an unparseable measuredAt is treated as stale when a freshness window is set', async () => {
    const verdict = await evaluateReleaseProfile(
      {
        profileRef: 'p',
        components: [component({ maxAgeMs: 1000, check: fixedCheck({ measuredAt: 'not-a-date' }) })],
      },
      { now: NOW },
    );
    expect(verdict.go).toBe(false);
    expect(verdict.components[0].verdict).toBe('stale');
  });
});

describe('lineageMismatches — pure field-by-field compare', () => {
  it('flags a real mismatch', () => {
    expect(lineageMismatches({ sha: 'a' }, { sha: 'b' })).toEqual(['sha']);
  });
  it('ignores a field missing on the actual side', () => {
    expect(lineageMismatches({}, { sha: 'b' })).toEqual([]);
  });
  it('ignores a field missing on the expected side', () => {
    expect(lineageMismatches({ sha: 'a' }, {})).toEqual([]);
  });
  it('matches on every declared field', () => {
    expect(lineageMismatches({ sha: 'a', generation: 'g1' }, { sha: 'a', generation: 'g1' })).toEqual([]);
  });
});
