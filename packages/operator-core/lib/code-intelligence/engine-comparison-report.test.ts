import { describe, expect, it } from 'vitest';
import type { ArmReport, CaseMeasurement, EngineRunMeta, PhaseCost, UpdateFixtureResult } from './engine-comparison';
import { ARM_ORDER, orderReports, parseCliArgs, preregHash, renderEvidence } from './engine-comparison-report';

const COST: PhaseCost = { wallMs: 60_000, peakRssKb: 2_048_000, ok: true, error: null, loadAvg1: 12 };
const META: EngineRunMeta = { runId: 'run-1', seed: 0, createdAt: '2026-10-01T00:00:00.000Z', preregHash: 'abc' };

const kase = (caseId: string, correct: boolean, error: string | null = null): CaseMeasurement => ({
  caseId,
  intent: 'callers',
  coldQueryMs: 120,
  warmQueryMs: 80,
  warmSamplesMs: [80],
  responseBytes: 400,
  estTokens: 100,
  correct,
  recall: correct ? 1 : 0,
  grade: { correct, missing: correct ? [] : ['a.ts:1'], extra: [], reason: correct ? 'ok' : 'missing a.ts:1' },
  returnedSites: [],
  error,
});

const fixture = (name: UpdateFixtureResult['name'], pass: boolean): UpdateFixtureResult => ({
  name,
  pass,
  detail: `${name} detail | with pipe`,
  refreshCost: COST,
  recoveryCost: COST,
  faultSurfaced: name === 'refresh-failure' ? true : null,
});

const report = (armId: string, fingerprint: string | null, ok: boolean): ArmReport => ({
  armId,
  version: '1.0.0',
  unavailable: null,
  treeFingerprint: fingerprint,
  coldIndex: COST,
  indexBytes: 10 * 1024 * 1024,
  cases: [kase('c1', ok), kase('c2', true)],
  fixtures: [fixture('edit', true), fixture('delete', ok), fixture('refresh-failure', true)],
  error: null,
});

describe('parseCliArgs', () => {
  it('defaults to every arm in canonical order, run mode, 3 warm samples', () => {
    expect(parseCliArgs([])).toEqual({ mode: 'run', arms: [...ARM_ORDER], warmSamples: 3, outDir: null });
  });
  it('accepts a comma list, warm count, out dir and aggregate', () => {
    const o = parseCliArgs(['--arm', 'gitnexus-installed,codebase-memory', '--warm', '5', '--out', '/tmp/e', '--aggregate']);
    expect(o).toEqual({ mode: 'aggregate', arms: ['gitnexus-installed', 'codebase-memory'], warmSamples: 5, outDir: '/tmp/e' });
  });
  it('THROWS on every malformed input instead of silently defaulting', () => {
    expect(() => parseCliArgs(['--arm', 'nope'])).toThrow(/unknown arm/);
    expect(() => parseCliArgs(['--arm'])).toThrow(/needs a value/);
    expect(() => parseCliArgs(['--arm', '--warm'])).toThrow(/needs a value/);
    expect(() => parseCliArgs(['--warm', '0'])).toThrow(/1\.\.20/);
    expect(() => parseCliArgs(['--warm', '2.5'])).toThrow(/1\.\.20/);
    expect(() => parseCliArgs(['--warm', '21'])).toThrow(/1\.\.20/);
    expect(() => parseCliArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});

describe('preregHash', () => {
  it('is deterministic and changes with the case set or sample count', () => {
    expect(preregHash(['a', 'b'], 3)).toBe(preregHash(['a', 'b'], 3));
    expect(preregHash(['a', 'b'], 3)).not.toBe(preregHash(['a', 'c'], 3));
    expect(preregHash(['a', 'b'], 3)).not.toBe(preregHash(['a', 'b'], 4));
    expect(preregHash(['a', 'b'], 3)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('orderReports', () => {
  it('sorts by canonical arm order and keeps an unknown arm last, never dropped', () => {
    const out = orderReports([report('codebase-memory', 'f', true), report('zzz-extra', 'f', true), report('baseline-lsp-rg', 'f', true)]);
    expect(out.map((r) => r.armId)).toEqual(['baseline-lsp-rg', 'codebase-memory', 'zzz-extra']);
  });
});

describe('renderEvidence', () => {
  const all = ARM_ORDER.map((id) => report(id, 'tree-1', true));

  it('renders every section, the verdict and the disclosures', () => {
    const b = renderEvidence(all, META, ['note one']);
    for (const h of ['# Engine comparison — run run-1', '## Summary', '## Per-case measurements', '## Update fixtures', '## Source parity', '## Disposition', '## Disclosures']) {
      expect(b.markdown).toContain(h);
    }
    expect(b.markdown).toContain('- note one');
    expect(b.markdown).toMatch(/decision: \*\*(keep|upgrade|replace|inconclusive)\*\*/);
    expect(b.markdown).toContain('identical tree fingerprint across arms: **YES**');
    expect(JSON.parse(b.verdictJson).sourceParity.same).toBe(true);
    expect(Array.isArray(JSON.parse(b.taskRowsJson))).toBe(true);
    expect(JSON.parse(b.fairnessJson)).toBeTypeOf('object');
  });

  it('escapes pipes inside table cells so a detail string cannot break the row', () => {
    const b = renderEvidence(all, META, []);
    expect(b.markdown).toContain('edit detail \\| with pipe');
  });

  it('is deterministic for fixed input regardless of input order', () => {
    const a = renderEvidence(all, META, ['n']);
    const b = renderEvidence([...all].reverse(), META, ['n']);
    expect(b.markdown).toBe(a.markdown);
    expect(b.verdictJson).toBe(a.verdictJson);
  });

  it('flags a tree fingerprint mismatch and an unavailable arm as nonpassing residue', () => {
    const missing: ArmReport = { ...report('codebase-memory', null, true), unavailable: 'no report-codebase-memory.json — arm was not run', treeFingerprint: null, coldIndex: null, cases: [], fixtures: [] };
    const drift = [report('baseline-lsp-rg', 'tree-1', true), report('gitnexus-installed', 'tree-1+dirty', true), report('gitnexus-candidate', 'tree-1', true), missing];
    const b = renderEvidence(drift, META, []);
    expect(b.markdown).toContain('identical tree fingerprint across arms: **NO**');
    expect(b.markdown).toContain('UNAVAILABLE: no report-codebase-memory.json');
    const verdict = JSON.parse(b.verdictJson) as { decision: string; residue: string[] };
    expect(verdict.decision).toBe('inconclusive');
    expect(verdict.residue.join(' ')).toContain('codebase-memory');
  });

  it('marks a failed case NO and carries its error text', () => {
    const b = renderEvidence([report('baseline-lsp-rg', 'f', false)], META, []);
    expect(b.markdown).toMatch(/\| baseline-lsp-rg \| c1 \| callers \| NO \| 0\.00 \|/);
  });
});
