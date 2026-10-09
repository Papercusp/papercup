/** Preregistered comparison over actual compiler/worker answers, with tamper controls. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashCases, hashKeys, preregister, type AnswerKey, type FairCase, type Preregistration } from './fair-comparison';
import { runArm, scoreRuns } from './fair-comparison-run';
import type { FairArm } from './fair-comparison-arms';
import { firstPartyCallersOffthread } from './first-party-callers-offthread';
import { LSP_VENDOR_DIR } from './lsp-adapter';

const source = 'export function frozenTarget() { return 1; }\n' +
  'export const result = frozenTarget();\n' +
  '// absentTarget() is a comment, not a call\n';
const sourceFingerprint = createHash('sha256').update(source).digest('hex');
const cases: FairCase[] = [
  { id: 'native-frozen-positive', intent: 'callers', subject: 'frozenTarget',
    anchorFile: 'src/fixture.ts', language: 'typescript', configuration: 'configured',
    sourceState: 'current', sourceFingerprint, taskRef: 'native-plan-P002-positive-control',
    tags: [], source: 'authored' },
  { id: 'native-frozen-empty', intent: 'callers', subject: 'absentTarget',
    anchorFile: 'src/fixture.ts', language: 'typescript', configuration: 'configured',
    sourceState: 'current', sourceFingerprint, taskRef: 'native-plan-P002-false-empty-control',
    tags: ['absence'], source: 'authored' },
];
const keys: AnswerKey[] = [
  { caseId: cases[0]!.id, sites: ['src/fixture.ts:2'], aliases: {}, rejected: [], neutral: [] },
  { caseId: cases[1]!.id, sites: [], aliases: {}, rejected: [], neutral: [] },
];
let root = '';
let indexCalls = 0;
let queryCalls = 0;
const arm: FairArm = {
  capabilities: { armId: 'native-compiler-fixture', version: 'test-v1', intents: ['callers'], licence: 'first-party' },
  unavailable: null,
  index: async () => {
    indexCalls += 1;
    return { wallMs: 0, peakRssKb: null, ok: true, error: null, loadAvg1: null };
  },
  query: async kase => {
    queryCalls += 1;
    const answer = await firstPartyCallersOffthread({ root, name: kase.subject, vendorDir: LSP_VENDOR_DIR, limit: 10 });
    return { caseId: kase.id, status: answer.error ? 'crashed' : 'answered', sites: answer.sites,
      latencyMs: answer.latencyMs, ...(answer.error ? { detail: answer.error } : {}) };
  },
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'native-frozen-comparison-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/fixture.ts'), source);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'es2022' } }));
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('native frozen comparison through the compiler pipeline', () => {
  it('reconstructs the saved multilingual edition and refuses a changed measurement protocol before work', async () => {
    const saved = JSON.parse(readFileSync(new URL('../../../../docs/evidence/native-code-intelligence-preregistration-2026-10-09.json', import.meta.url), 'utf8')) as {
      cases: FairCase[]; keys: AnswerKey[]; preregistration: Preregistration; observations: unknown[]; verdict: string;
    };
    const registered = saved.preregistration;
    expect(hashCases(saved.cases)).toBe(registered.corpusHash);
    expect(hashKeys(saved.keys)).toBe(registered.keyHash);
    expect(preregister({ cases: saved.cases, keys: saved.keys, arms: registered.arms,
      reps: registered.reps, seed: registered.seed, budgets: registered.budgets, protocol: registered.protocol }).hash).toBe(registered.hash);
    expect(saved.observations).toEqual([]);
    expect(saved.verdict).toBe('not-run');
    const before = { indexCalls, queryCalls };
    const admitted: FairArm = { ...arm, capabilities: registered.arms[0]!, unavailable: 'protocol-only control; no backend measurement' };
    expect((await runArm(admitted, saved.cases, registered)).reps).toEqual([]);
    const changed = { ...registered, protocol: { ...registered.protocol!, measurements:
      registered.protocol!.measurements.map(m => m.metric === 'peak-memory' ? { ...m, method: 'parent-only RSS' } : m) } };
    await expect(runArm(admitted, saved.cases, changed)).rejects.toThrow(/content or budget/);
    expect(() => scoreRuns([], saved.cases, saved.keys, {}, changed)).toThrow(/changed preregistration/);
    expect({ indexCalls, queryCalls }).toEqual(before);
  });

  it('executes the frozen positive and absence controls and reconstructs their scores', async () => {
    const prereg = preregister({ cases, keys, arms: [arm.capabilities], reps: 3, seed: 20261009 });
    const run = await runArm(arm, cases, prereg);
    expect(run.index?.ok).toBe(true);
    expect(run.reps).toHaveLength(3);
    for (const rep of run.reps) {
      const positive = rep.answers.find(answer => answer.caseId === cases[0]!.id)!;
      expect(positive.status).toBe('answered');
      expect(positive.sites.map(site => `${site.path}:${site.line1}`)).toEqual(['src/fixture.ts:2']);
      const absence = rep.answers.find(answer => answer.caseId === cases[1]!.id)!;
      expect(absence.status).toBe('answered');
      expect(absence.sites).toEqual([]);
    }
    const scored = scoreRuns([run], cases, keys, {}, prereg);
    expect(scored.pending).toEqual([]);
    expect(scored.aggregates[0]?.reps).toBe(3);
    expect(scoreRuns([JSON.parse(JSON.stringify(run))], cases, keys, {}, JSON.parse(JSON.stringify(prereg))))
      .toEqual(scored);
    const before = { indexCalls, queryCalls };
    await expect(runArm(arm, [{ ...cases[0]!, subject: 'absentTarget' }, cases[1]!], prereg))
      .rejects.toThrow(/corpus semantics/);
    await expect(runArm(arm, cases, { ...prereg, budgets: { ...prereg.budgets, rssMbMax: 2 } }))
      .rejects.toThrow(/budget differs/);
    expect({ indexCalls, queryCalls }).toEqual(before);
    expect(() => scoreRuns([run], [{ ...cases[0]!, sourceState: 'deleted' }, cases[1]!], keys, {}, prereg))
      .toThrow(/corpus semantics changed/);
    expect(() => scoreRuns([run], cases, keys, {}, { ...prereg, budgets: { ...prereg.budgets, rssMbMax: 2 } }))
      .toThrow(/changed preregistration content or budget/);
    // This fixture measures the freeze/scoring seam, not a final backend verdict:
    // one callers-only arm cannot certify matched graph intent coverage.
    expect(scored.decision.kind).toBe('inconclusive');
  }, 60_000);
});
