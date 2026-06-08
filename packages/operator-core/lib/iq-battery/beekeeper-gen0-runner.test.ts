/**
 * beekeeper-gen0-runner.test.ts — the runner's pure pieces (Apiary gen-0 P-004 / P-005).
 *
 * Covers the arg parser + the hard spend cap. The battery itself is live (real bees + judge), so it
 * isn't exercised here; the ESM main-guard in the runner means importing this module never spawns or
 * spends. (The orchestration is covered by beekeeper-gen0.integration.test.ts with mocked effects.)
 */
import { describe, it, expect } from 'vitest';
import { parseGen0Args, makeSpend, SpendCapError, buildRubric, buildManifest } from './beekeeper-gen0-runner';

describe('parseGen0Args', () => {
  it('defaults: live, $50 cap, 1 case/variant, 1 repeat, 10-min timeout', () => {
    const a = parseGen0Args([]);
    expect(a.dryRun).toBe(false);
    expect(a.capUsd).toBe(50);
    expect(a.casesPerVariant).toBe(1);
    expect(a.repeats).toBe(1);
    expect(a.timeoutMs).toBe(600_000);
    expect(a.workspaceId).toBeNull();
    expect(a.harness).toBeNull();
  });

  it('parses flags', () => {
    const a = parseGen0Args(['--dry-run', '--cap=25', '--cases=3', '--repeats=2', '--harness=brood-box-alpha', '--workspace=w1']);
    expect(a.dryRun).toBe(true);
    expect(a.capUsd).toBe(25);
    expect(a.casesPerVariant).toBe(3);
    expect(a.repeats).toBe(2);
    expect(a.harness).toBe('brood-box-alpha');
    expect(a.workspaceId).toBe('w1');
  });

  it('clamps cases/repeats to ≥1 and ignores non-numeric cap', () => {
    const a = parseGen0Args(['--cases=0', '--repeats=-4', '--cap=abc']);
    expect(a.casesPerVariant).toBe(1);
    expect(a.repeats).toBe(1);
    expect(a.capUsd).toBe(50); // fell back to default
  });

  it('parses --variants into a CSV subset (null when absent)', () => {
    expect(parseGen0Args([]).variants).toBeNull();
    expect(parseGen0Args(['--variants=fix-injected-bug']).variants).toEqual(['fix-injected-bug']);
    expect(parseGen0Args(['--variants=fix-injected-bug, build-spec']).variants).toEqual(['fix-injected-bug', 'build-spec']);
    expect(parseGen0Args(['--variants=']).variants).toBeNull();
  });
});

describe('makeSpend — hard cap', () => {
  it('accumulates charges under the cap', () => {
    const s = makeSpend(10);
    s.charge(3, 'a');
    s.charge(4, 'b');
    expect(s.usd).toBe(7);
  });

  it('throws SpendCapError the instant a charge would exceed the cap (and does NOT record it)', () => {
    const s = makeSpend(10);
    s.charge(8, 'a');
    expect(() => s.charge(3, 'b')).toThrow(SpendCapError);
    expect(s.usd).toBe(8); // the over-cap charge was rejected, not partially applied
  });

  it('ignores negative charges', () => {
    const s = makeSpend(10);
    s.charge(-5, 'refund');
    expect(s.usd).toBe(0);
  });

  it('allows a charge that lands exactly on the cap', () => {
    const s = makeSpend(10);
    s.charge(10, 'exact');
    expect(s.usd).toBe(10);
    expect(() => s.charge(0.01, 'over')).toThrow(SpendCapError);
  });
});

describe('buildRubric / buildManifest', () => {
  it('rubric pins opus-4-8, temp 0, d1/d2/d3 weights summing to 1', () => {
    const r = buildRubric() as unknown as { model: string; temperature: number; weights: Record<string, number> };
    expect(r.model).toBe('claude-opus-4-8');
    expect(r.temperature).toBe(0);
    expect(r.weights.d1 + r.weights.d2 + r.weights.d3).toBeCloseTo(1);
  });

  it('manifest fingerprints the solver (workspace in the id, an instanceUrl, a createdAt)', () => {
    const m = buildManifest('ws-x');
    expect(m.manifest.instanceId).toContain('ws-x');
    expect(m.manifest.workspaceId).toBe('ws-x');
    expect(m.instanceUrl).toContain('opus-4-8-xhigh');
    expect(m.manifest.createdAt).toBeInstanceOf(Date);
  });
});
