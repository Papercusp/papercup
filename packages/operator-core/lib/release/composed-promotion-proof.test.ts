/**
 * P-018 (green-main-ratchet-convergence-2026-10-17): the composed promotion proof.
 *   R-15 falsifiers: (1) a green selective step triggers a full gate re-run while every radius
 *   is computable; (2) a result outside every radius is re-run instead of carried; (3) a lint
 *   leg re-runs though it passed and its inputs did not change; (4) an uncomputable radius
 *   does not fall back to the full gate.
 *   R-16 falsifiers: (1) a type-annotation-only lint fix selects a runtime test; (2) a
 *   runtime-changing lint fix does not re-run its dependents; (3) a file whose emit cannot be
 *   computed is treated as type-only.
 * R-16 cases run the real TypeScript compiler (`emitIdentity`), not a stub.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { PROOF_CONTEXT_COMPONENTS, captureConfigurationSnapshot, createProofContextIdentity,
  type ProofContextIdentity, type ProofContextReach } from '@papercusp/test-config/configuration-snapshot';
import { releaseStageInputHash } from '../../../../scripts/lib/release-task-journal.mjs';
import { probeByocPublication, publicationProbeInputFromJournal } from '../agent-tools/release/byoc-readiness';
import { confirmMergeAdvance, decideMergeGate } from '../harness/git-sync/decide-merge-gate';
import type { TaskReleaseJournal } from '../task-manager/store';
import {
  composeVerdict,
  emitIdentity,
  planComposedProof,
  type ChangedFile,
  type ComposedProofInput,
  type ComposedProofPlan,
} from './composed-promotion-proof';

const SRC = 'packages/ui/src/sum.ts';
const SRC_TEST = 'packages/ui/src/sum.test.ts';
const OTHER_TEST = 'packages/ui/src/menu.test.ts';
const FAR_TEST = 'packages/db/src/far.test.ts';

const BEFORE = 'export function sum(a, b) {\n  return a + b;\n}\n';
const TYPE_ONLY_AFTER =
  "import type { Num } from './num';\nexport function sum(a: Num, b: number): number {\n  return a + b;\n}\n";
const RUNTIME_AFTER = 'export function sum(a: number, b: number): number {\n  return a + b + 0.0001;\n}\n';

const tsLeg = { id: 'lint:tsc', passed: false, covers: (p: string) => p.endsWith('.ts') };
const eslintLeg = { id: 'lint:eslint', passed: true, covers: (p: string) => p.startsWith('packages/ui/') };
const mdLeg = { id: 'lint:docs', passed: true, covers: (p: string) => p.endsWith('.md') };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const context = () => createProofContextIdentity(Object.fromEntries(PROOF_CONTEXT_COMPONENTS.map(key => [key, hash(key)])) as
  ProofContextIdentity['components'])!;

const base = (changedFiles: ChangedFile[], over: Partial<ComposedProofInput> = {}): ComposedProofInput => ({
  proofContext: { before: context(), after: context() },
  round1Tests: { [SRC_TEST]: 'pass', [OTHER_TEST]: 'pass', [FAR_TEST]: 'fail' },
  lintLegs: [tsLeg, eslintLeg, mdLeg],
  admissions: [{ id: 'adm-1', changedFiles }],
  dependentTestsOf: (p) => (p === SRC ? [SRC_TEST, OTHER_TEST] : []),
  ...over,
});
const composed = (p: ComposedProofPlan) => {
  if (p.mode !== 'composed') throw new Error(`expected a composed plan, got ${p.mode}: ${p.reason}`);
  return p;
};

describe('emitIdentity (real TypeScript transpile)', () => {
  it('reports a type-annotation and import-type change as identical emit', () => {
    expect(emitIdentity(SRC, BEFORE, TYPE_ONLY_AFTER)).toBe('identical');
  });
  it('reports a runtime change as changed', () => {
    expect(emitIdentity(SRC, BEFORE, RUNTIME_AFTER)).toBe('changed');
  });
  it('reports an unparseable file as uncomputable, never identical (R-16 f3)', () => {
    expect(emitIdentity(SRC, BEFORE, 'export function sum(a, b) { return a + ; }')).toBe('uncomputable');
  });
  it('reports a non-script file as uncomputable', () => {
    expect(emitIdentity('packages/ui/package.json', '{"a":1}', '{"a":2}')).toBe('uncomputable');
  });
  it('reports an added or deleted file as changed', () => {
    expect(emitIdentity(SRC, null, BEFORE)).toBe('changed');
    expect(emitIdentity(SRC, BEFORE, null)).toBe('changed');
  });
});

describe('planComposedProof', () => {
  it('requires a fresh verdict for an opaque or changed delivery artifact', async () => {
    const bundleSha256 = hash('original bundle bytes');
    const manifestSha256 = hash('original publication manifest');
    const repackedSha = hash('repacked bytes from the same source');
    const sourceSha = '9'.repeat(40);
    const finalize = {
      sequence: 0, operationId: 'publish-1', requestIdentity: 'finalize-1', stage: 'publish.finalize',
      state: 'committed' as const, inputHash: releaseStageInputHash({ bundleSha256, manifestSha256 }),
      evidenceRefs: ['provider:finalization:' + manifestSha256], recordedAt: '2026-11-19T12:00:00Z',
    };
    const journal: TaskReleaseJournal = {
      schemaVersion: 1, operationId: finalize.operationId, cursor: 1, currentStage: finalize.stage,
      currentState: finalize.state, spentOperationIds: [finalize.requestIdentity], receipts: [finalize],
      source: { sha: sourceSha }, artifactIdentity: { version: '1.0', bundleSha256 },
    };
    const probeInput = publicationProbeInputFromJournal(journal);
    expect(probeInput).toMatchObject({
      bundleSha256, manifestSha256, expectedArtifactIdentity: { sourceSha, version: '1.0' },
    });
    if (!probeInput) throw new Error('Missing publication input from the committed stage');
    const missing = await probeByocPublication(probeInput, async () => new Response(null, { status: 404 }));
    expect(missing.verdict).toBe('unknown');
    expect(missing.missing).toContain('public-manifest');
    const changed = await probeByocPublication(probeInput, async () => new Response('{}'));
    expect(changed.verdict).toBe('fail');
    expect(changed.failed).toContain('manifest-archive-digest:mismatch');
    expect(publicationProbeInputFromJournal({ ...journal, artifactIdentity: { sourceSha, version: '1.0' } })).toBeNull();
    const repacked = { ...journal, artifactIdentity: { version: '1.0', bundleSha256: repackedSha } };
    expect(publicationProbeInputFromJournal(repacked)).toBeNull();
    const reissued = { ...finalize, requestIdentity: 'finalize-2',
      inputHash: releaseStageInputHash({ bundleSha256: repackedSha, manifestSha256 }) };
    expect(publicationProbeInputFromJournal({ ...repacked, spentOperationIds: [reissued.requestIdentity],
      receipts: [reissued] })).toMatchObject({ bundleSha256: repackedSha, manifestSha256 });

    const before = context();
    for (const generatedAssets of [null, repackedSha]) {
      const after = createProofContextIdentity({ ...before.components, generatedAssets });
      expect(planComposedProof(base([], { proofContext: { before, after } })).mode).toBe('full-gate');
    }
  });

  it('requires current candidate evidence when target tip, fixture or runtime changes', () => {
    const prHeadSha = 'a'.repeat(40), targetTipSha = 'b'.repeat(40), mergeSha = 'c'.repeat(40);
    const lastTest = { prHeadSha, targetTipSha, mergeSha, result: 'pass' as const };
    const original = { prHeadSha, promotedSha: prHeadSha, targetTipSha, lastTest };
    const decision = decideMergeGate(original);
    expect(decision).toMatchObject({ action: 'merge', advanceTargetTo: mergeSha });
    if (decision.action !== 'merge') throw new Error('Expected the tested merge candidate');
    expect(confirmMergeAdvance(decision, targetTipSha)).toEqual({ ok: true });
    const advancedTip = 'd'.repeat(40), rebasedHead = 'e'.repeat(40);
    expect(confirmMergeAdvance(decision, advancedTip)).toMatchObject({ ok: false, reason: 'target-moved' });
    expect(decideMergeGate({ ...original, targetTipSha: advancedTip }))
      .toMatchObject({ action: 'build-and-test', reason: 'target-moved' });
    expect(decideMergeGate({ ...original, prHeadSha: rebasedHead, promotedSha: rebasedHead }))
      .toMatchObject({ action: 'build-and-test', reason: 'pr-head-moved' });

    const before = context();
    for (const component of ['fixtures', 'runtimeCapabilities'] as const) {
      const after = createProofContextIdentity({ ...before.components, [component]: hash('new ' + component) })!;
      expect(planComposedProof(base([], { proofContext: { before, after } })).mode).toBe('full-gate');
      const reach: ProofContextReach = { schemaVersion: 'reach-v1', component,
        before: before.components[component]!, after: after.components[component]!,
        provenance: { version: 'selected-consumers-v1', before: hash('before graph'), after: hash('after graph'), complete: true },
        tests: [SRC_TEST], legs: [] };
      const selected = composed(planComposedProof(base([], { proofContext: { before, after, reach: [reach] } })));
      expect(selected.rerunTests).toEqual([SRC_TEST]);
      expect(selected.carriedTests).toEqual([FAR_TEST, OTHER_TEST]);
      const verdict = composeVerdict(selected, { [OTHER_TEST]: 'pass' }, { [SRC_TEST]: 'pass', 'lint:tsc': 'pass' });
      expect(verdict).toEqual({ failing: [FAR_TEST], unmeasured: [FAR_TEST] });
    }
  });

  it('requires complete context even with zero source changes and a computable radius', () => {
    for (const proofContext of [undefined, null, { before: context(), after: null },
      { before: context(), after: createProofContextIdentity({ ...context().components, fixtures: null }) }]) {
      expect(planComposedProof(base([], { proofContext }))).toMatchObject({ mode: 'full-gate' });
    }
  });

  it.each(PROOF_CONTEXT_COMPONENTS)('requalifies only complete measured reach for changed %s at fixed source', component => {
    const before = context(), after = createProofContextIdentity({ ...before.components, [component]: hash('changed input') })!;
    const row: ProofContextReach = { schemaVersion: 'reach-v1', component,
      before: before.components[component]!, after: after.components[component]!,
      provenance: { version: 'selected-consumers-v1', before: hash('old graph'), after: hash('new graph'), complete: true },
      tests: [SRC_TEST], legs: ['lint:eslint'] };
    const plan = composed(planComposedProof(base([], { proofContext: { before, after, reach: [row] } })));
    expect(plan.rerunTests).toEqual([SRC_TEST]);
    expect(plan.carriedTests).toEqual([FAR_TEST, OTHER_TEST]);
    expect(plan.rerunLegs).toEqual(['lint:eslint', 'lint:tsc']);
    expect(plan.carriedLegs).toEqual(['lint:docs']);
    for (const reach of [undefined, [], [{ ...row, provenance: { ...row.provenance, complete: false } }]]) {
      expect(planComposedProof(base([], { proofContext: { before, after, reach } }))).toMatchObject({ mode: 'full-gate' });
    }
  });

  it('observes actual configuration snapshots changing at a fixed source and preserves equivalent captures', () => {
    const config = (value: string) => captureConfigurationSnapshot({ PAPERCUSP_FLAG_CONTEXT_TEST: value });
    const before = createProofContextIdentity({ ...context().components, testConfiguration: hash(config('1').fingerprint) })!;
    const equivalent = createProofContextIdentity({ ...context().components, testConfiguration: hash(config('1').fingerprint) })!;
    expect(composed(planComposedProof(base([], { proofContext: { before, after: equivalent } }))).rerunTests).toEqual([]);
    const changed = createProofContextIdentity({ ...context().components, testConfiguration: hash(config('0').fingerprint) })!;
    expect(planComposedProof(base([], { proofContext: { before, after: changed } }))).toMatchObject({ mode: 'full-gate' });
  });

  it('automatically carries already-green originals with captured equivalent inputs and no new results', () => {
    const capture = () => createProofContextIdentity({ ...context().components,
      testConfiguration: hash(captureConfigurationSnapshot({ PAPERCUSP_FLAG_CONTEXT_TEST: '1' }).fingerprint) })!;
    const originals = { [SRC_TEST]: 'pass', [OTHER_TEST]: 'pass', [FAR_TEST]: 'pass' } as const;
    const input = base([], { round1Tests: originals,
      lintLegs: [{ ...tsLeg, passed: true }, eslintLeg, mdLeg],
      proofContext: { before: capture(), after: capture() } });
    const result = planComposedProof(input);
    expect(result.mode).toBe('composed');
    const plan = composed(result);
    expect(plan.rerunTests).toEqual([]);
    expect(plan.rerunLegs).toEqual([]);
    expect(plan.carriedTests).toEqual(Object.keys(originals).sort());
    expect(plan.carriedLegs).toEqual(['lint:docs', 'lint:eslint', 'lint:tsc']);
    expect(composeVerdict(plan, originals, {})).toEqual({ failing: [], unmeasured: [] });
  });

  it('R-16 f1: a type-only lint fix selects zero runtime tests', () => {
    const plan = composed(planComposedProof(base([{ path: SRC, before: BEFORE, after: TYPE_ONLY_AFTER }])));
    expect(plan.rerunTests).toEqual([]);
    expect(plan.typeOnlyFiles).toEqual([SRC]);
    expect(plan.carriedTests).toEqual([FAR_TEST, OTHER_TEST, SRC_TEST]);
  });

  it('R-16 f2: a runtime-changing lint fix re-runs its dependent tests', () => {
    const plan = composed(planComposedProof(base([{ path: SRC, before: BEFORE, after: RUNTIME_AFTER }])));
    expect(plan.rerunTests).toEqual([OTHER_TEST, SRC_TEST]);
    expect(plan.runtimeFiles).toEqual([SRC]);
  });

  it('R-16 f3: an uncomputable emit is treated as a runtime change, not type-only', () => {
    const plan = composed(
      planComposedProof(base([{ path: SRC, before: BEFORE, after: 'export function sum(a, b) { return a + ; }' }])),
    );
    expect(plan.typeOnlyFiles).toEqual([]);
    expect(plan.rerunTests).toEqual([OTHER_TEST, SRC_TEST]);
  });

  it('R-15 f1: a green selective step with computable radii composes instead of a full re-run', () => {
    expect(planComposedProof(base([{ path: SRC, before: BEFORE, after: RUNTIME_AFTER }])).mode).toBe('composed');
  });

  it('R-15 f2: a result outside every admission radius is carried, not re-run', () => {
    const plan = composed(planComposedProof(base([{ path: SRC, before: BEFORE, after: RUNTIME_AFTER }])));
    expect(plan.carriedTests).toEqual([FAR_TEST]);
    expect(plan.rerunTests).not.toContain(FAR_TEST);
  });

  it('R-15 f3: a lint leg re-runs only if it failed or its inputs changed', () => {
    const plan = composed(planComposedProof(base([{ path: SRC, before: BEFORE, after: TYPE_ONLY_AFTER }])));
    // lint:tsc failed in round 1 → re-run; lint:eslint covers the changed file → re-run;
    // lint:docs passed and covers nothing that changed → carried.
    expect(plan.rerunLegs).toEqual(['lint:eslint', 'lint:tsc']);
    expect(plan.carriedLegs).toEqual(['lint:docs']);
  });

  it('R-15 f4: an uncomputable radius for a runtime change falls back to the full gate', () => {
    const plan = planComposedProof(
      base([{ path: SRC, before: BEFORE, after: RUNTIME_AFTER }], { dependentTestsOf: () => null }),
    );
    expect(plan.mode).toBe('full-gate');
    if (plan.mode === 'full-gate') expect(plan.uncomputableRadius).toEqual([SRC]);
  });

  it('a type-only file needs no radius, so an uncomputable radius there does not force the full gate', () => {
    const plan = planComposedProof(
      base([{ path: SRC, before: BEFORE, after: TYPE_ONLY_AFTER }], { dependentTestsOf: () => null }),
    );
    expect(plan.mode).toBe('composed');
  });

  it('unions radii across several admissions', () => {
    const plan = composed(
      planComposedProof(
        base([], {
          admissions: [
            { id: 'a', changedFiles: [{ path: SRC, before: BEFORE, after: RUNTIME_AFTER }] },
            { id: 'b', changedFiles: [{ path: 'packages/db/src/far.ts', before: 'export const x = 1;', after: 'export const x = 2;' }] },
          ],
          dependentTestsOf: (p) => (p === SRC ? [SRC_TEST] : [FAR_TEST]),
        }),
      ),
    );
    expect(plan.rerunTests).toEqual([FAR_TEST, SRC_TEST]);
    expect(plan.carriedTests).toEqual([OTHER_TEST]);
  });
});

describe('composeVerdict', () => {
  const plan = () => composed(planComposedProof(base([{ path: SRC, before: BEFORE, after: RUNTIME_AFTER }])));
  const round1 = { [SRC_TEST]: 'pass', [OTHER_TEST]: 'pass', [FAR_TEST]: 'fail' } as const;

  it('carries round-1 failures outside the radius and adds re-run failures', () => {
    const v = composeVerdict(plan(), round1, {
      [SRC_TEST]: 'fail', [OTHER_TEST]: 'pass', 'lint:tsc': 'pass', 'lint:eslint': 'pass',
    });
    expect(v.failing).toEqual([FAR_TEST, SRC_TEST]);
    expect(v.unmeasured).toEqual([]);
  });

  it('counts a re-run with no result as failing (fail closed)', () => {
    const v = composeVerdict(plan(), round1, { [SRC_TEST]: 'pass', 'lint:tsc': 'pass', 'lint:eslint': 'pass' });
    expect(v.unmeasured).toEqual([OTHER_TEST]);
    expect(v.failing).toContain(OTHER_TEST);
  });
});
