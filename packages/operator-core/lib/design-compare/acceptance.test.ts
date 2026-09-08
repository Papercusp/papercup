import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DESIGN_FRESHNESS_DIMENSIONS, designAcceptanceContractSchema,
  measureDesignAcceptance, readDesignAcceptance,
  type DesignAcceptanceContract, type DesignAcceptanceEvidence,
} from './acceptance';
import { designEvidenceCompletionGate, planDesignEvidenceGate } from '../agent-tools/work_items/design-evidence-gate';
import { evaluateFeatureDesignGate, type FeatureDesignGateResult } from './feature-gate';
import { createInMemoryReferenceStore } from './reference-store';
import { ratifyReferenceVerb } from './verbs';
import { readPngDimensions } from './png-header';
import type { WorkItem } from '../work-items';
import type { DesignApprovalScope } from './ratification';

const repo = resolve(import.meta.dirname, '../../../..');
const matrix = JSON.parse(readFileSync(join(repo, 'docs/evidence/desktop-render-matrix-p003-2026-09-08/reviewed-matrix.json'), 'utf8'));
const journey = JSON.parse(readFileSync(join(repo, 'docs/evidence/desktop-design-journey-p002-2026-09-08.json'), 'utf8'));
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
let root: string;
let contract: DesignAcceptanceContract;
let evidence: DesignAcceptanceEvidence;
let approval: DesignApprovalScope;
const reference = matrix.contract.reference;
const testFile = journey.sourceTest;
const readRun = vi.fn(async (id: number) => ({ status: id === journey.positive.testRunId ? 'pass' : 'fail', framework: 'playwright', filePath: testFile }));
const writeEvidence = () => writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence));
const read = () => readDesignAcceptance({ root, ...reference, approval, readRun });
const reasons = async () => (await read()).failures.map(row => row.reason);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'design-acceptance-'));
  for (const observation of matrix.observations) {
    const destination = join(root, observation.capture.path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repo, observation.capture.path), destination);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(async () => {
  vi.clearAllMocks();
  for (const key of DESIGN_FRESHNESS_DIMENSIONS) writeFileSync(join(root, `${key}.txt`), `controlled ${key} identity`);
  writeFileSync(join(root, 'build.json'), JSON.stringify({ portal: journey.positive.build.buildId, fixture: matrix.contract.cases[0].target.implementationRevision }));
  contract = designAcceptanceContractSchema.parse({
    schemaVersion: 1, reference, targetRoute: '/?app=desktops',
    measurement: Object.fromEntries(DESIGN_FRESHNESS_DIMENSIONS.map(key => [key, key === 'served-build' ? ['served-build.txt', 'build.json'] : [`${key}.txt`]])),
    builds: [
      { id: 'portal', manifestPath: 'build.json', revisionPath: ['portal'] },
      { id: 'fixture', manifestPath: 'build.json', revisionPath: ['fixture'] },
    ],
    journey: { buildId: 'portal', testFile, scenarios: journey.positive.scenarioIds.map((id: string) => id.split('.').at(-1)) },
    renderCases: matrix.contract.cases.map((row: Record<string, any>) => ({ ...row, buildId: 'fixture', target: { targetId: row.target.targetId, targetKind: row.target.targetKind } })),
  });
  const contractBytes = JSON.stringify(contract);
  writeFileSync(join(root, 'contract.json'), contractBytes);
  approval = { schemaVersion: 1, approvalRef: 'test:reviewed-contract', planSlug: reference.featureId, planItemIds: ['P-003'], targetRoute: contract.targetRoute,
    acceptance: { schemaVersion: 1, contractPath: 'contract.json', contractSha256: sha(contractBytes), evidencePath: 'evidence.json' } };
  evidence = {
    schemaVersion: 1, reference: { ...reference }, fingerprints: (await measureDesignAcceptance(root, contract)).fingerprints,
    journeys: contract.journey.scenarios.map(scenario => ({ scenario, targetRoute: contract.targetRoute,
      implementationRevision: journey.positive.build.buildId, runner: 'browser', shellReached: true, destinationReached: true, status: 'pass', testRunRef: `test-run:${journey.positive.testRunId}` })),
    observations: structuredClone(matrix.observations),
  };
  writeEvidence();
});

/** The browser runs/images are saved canary evidence. Only ledger I/O and the
 * current-build file tree are controlled here; this does not run a cloud desktop. */
describe('current design acceptance over the desktop canary', () => {
  it('[desktop.gate.repaired] accepts the complete repaired journeys and reviewed state matrix', async () => {
    expect(await read()).toEqual({ satisfied: true, failures: [] });
    expect(readRun).toHaveBeenCalledWith(journey.positive.testRunId);
  });
  it('rejects the original loaded shell with the empty desktop destination', async () => {
    for (const row of evidence.journeys) {
      const original = journey.original.cases.find((item: { scenarioId: string }) => item.scenarioId.endsWith(`.${row.scenario}`));
      row.shellReached = original.shellReady;
      row.destinationReached = original.desktopWorkspacePresent;
      row.status = 'fail'; row.testRunRef = `test-run:${journey.original.testRunId}`;
      row.implementationRevision = journey.original.build.buildId;
    }
    writeEvidence();
    expect(await reasons()).toEqual(expect.arrayContaining(['journey-failed', 'stale-build', 'browser-run-unproven']));
  });
  it('[desktop.gate.missing-proof] refuses a missing responsive case beside all other passing cases', async () => {
    evidence.observations = evidence.observations.filter(row => row.caseId !== 'ready-narrow-dark');
    writeEvidence(); expect(await reasons()).toContain('missing-case-evidence');
  });
  it('[desktop.gate.wrong-target] a correct component matrix cannot cover navigation to another destination', async () => {
    evidence.journeys[0]!.targetRoute = '/?app=cloud';
    writeEvidence(); expect(await reasons()).toContain('wrong-target');
  });
  for (const key of DESIGN_FRESHNESS_DIMENSIONS) {
    it(`[desktop.gate.stale-${key}] independently measures ${key} bytes again`, async () => {
      writeFileSync(join(root, `${key}.txt`), 'changed after acceptance');
      expect(await reasons()).toContain(`stale-${key}`);
    });
  }
  it('[desktop.gate.stale-build] checks the actual current build revision independently of source', async () => {
    writeFileSync(join(root, 'build.json'), JSON.stringify({ portal: 'new-build', fixture: 'new-fixture' }));
    expect(await reasons()).toContain('stale-build');
  });
  it('refuses evidence from a replaced reference even when the image looks identical', async () => {
    evidence.reference.revision += 1; writeEvidence(); expect(await reasons()).toContain('stale-reference');
  });
  it('refuses silent edits to the approved contract', async () => {
    writeFileSync(join(root, 'contract.json'), JSON.stringify({ ...contract, renderCases: contract.renderCases.slice(0, 1) }));
    expect(await reasons()).toEqual(['stale-contract']);
  });
  it('distinguishes missing from invalid proof', async () => {
    rmSync(join(root, 'evidence.json')); expect(await reasons()).toEqual(['missing-proof']);
    writeFileSync(join(root, 'evidence.json'), '{}'); expect(await reasons()).toEqual(['invalid-proof']);
  });
  it('rejects capture hash tampering', async () => {
    evidence.observations[0]!.capture.sha256 = '0'.repeat(64); writeEvidence();
    expect(await reasons()).toContain('invalid-capture');
  });
  it('rejects fixture connectivity and a placeholder labeled ready', async () => {
    const row = evidence.observations.find(row => row.environment.state === 'ready')!;
    row.placeholderVisible = true; row.connectivity = 'connected'; writeEvidence();
    expect(await reasons()).toEqual(expect.arrayContaining(['placeholder-is-not-ready', 'fixture-connectivity-claim']));
  });
  it('refuses a component/unit run presented as browser proof', async () => {
    readRun.mockResolvedValueOnce({ status: 'pass', framework: 'vitest', filePath: testFile });
    expect(await reasons()).toContain('browser-run-unproven');
  });
  it('requires every actual entry variant', async () => {
    evidence.journeys = evidence.journeys.filter(row => row.scenario !== 'persisted'); writeEvidence();
    expect(await reasons()).toContain('missing-journey-proof');
  });
});

async function feature(): Promise<FeatureDesignGateResult> {
  const store = createInMemoryReferenceStore();
  const imagePath = join(repo, matrix.referencePath);
  const imageBytes = readFileSync(imagePath);
  const env = matrix.contract.cases[0].environment;
  const verbDeps = {
    harnessSlug: 'fixture', store, now: () => Date.now(), clock: () => new Date().toISOString(),
    materializeReferenceImage: async () => ({ path: imagePath, contentSha256: sha(imageBytes) }),
    comparison: { provider: { engine: { engine: 'unused', engineVersion: '1' }, compare: async () => { throw new Error('illustrative reference cannot use a pixel comparison'); } } },
  };
  const caller = { actorId: 'test-reviewer', role: 'reviewer' };
  const ratified = await ratifyReferenceVerb({
    ...reference, referenceClass: 'raster-mockup',
    image: { locator: imagePath, mediaType: 'image/png', byteLength: imageBytes.length, ...readPngDimensions(imageBytes) },
    referenceEnvironment: env,
    requiredCases: [{ caseId: 'approved-route', environment: env, target: { targetKind: 'page-route', targetId: approval.targetRoute }, rationale: 'approved desktop destination' }],
    provenance: { source: 'upload', sourceRef: matrix.referencePath }, approval,
  }, caller, verbDeps);
  expect(ratified.ok).toBe(true);
  return evaluateFeatureDesignGate({ harnessSlug: 'fixture', featureId: reference.featureId }, {
    store, verbDeps, caller, acceptanceRoot: root, readAcceptanceRun: readRun,
  });
}
const flags = { isEnabled: async () => true, isEnforcing: async () => false };
const evaluate = (id: string) => id === reference.featureId ? feature() : Promise.resolve({ applicable: false as const, references: [] });
const completion = (requiredReferences: unknown = [reference]) => designEvidenceCompletionGate([reference.featureId], {
  evaluate, ...flags, requiredReferences, workScope: { planSlug: reference.featureId, planItemIds: ['P-003'] },
});
describe('the same obligations govern completion and shipment', () => {
  it('[desktop.gate.missing-registration] does not turn a missing binding into not-applicable', async () => {
    expect(await completion([])).toMatchObject({ status: 'unsatisfied', enforced: true });
  });
  it('[desktop.gate.failed-late-obligation] an early passing candidate cannot hide a later failing reference', async () => {
    evidence.journeys.at(-1)!.status = 'fail'; writeEvidence();
    const outcome = await designEvidenceCompletionGate(['passing-plan', reference.featureId], {
      ...flags, requiredReferences: [reference], workScope: { planSlug: reference.featureId, planItemIds: ['P-003'] },
      evaluate: id => id === 'passing-plan' ? Promise.resolve({ applicable: true, satisfied: true, references: [], blocking: [], enforceableBlocking: [], doesNotEstablish: [] }) : evaluate(id),
    });
    expect(outcome).toMatchObject({ status: 'unsatisfied', enforced: true });
  });
  it('rechecks closed items at shipment and fails when their source changed', async () => {
    const deps = { ...flags, evaluate, listItems: async () => [{ id: 'WI-canary', sourcePlanItemIds: ['P-003'], payload: { designReferences: [reference] }, state: 'done' } as unknown as WorkItem] };
    expect(await completion()).toMatchObject({ status: 'satisfied' });
    expect(await planDesignEvidenceGate(reference.featureId, 'fixture', deps)).toEqual([expect.objectContaining({ status: 'satisfied' })]);
    writeFileSync(join(root, 'source.txt'), 'changed after work item completed');
    expect(await planDesignEvidenceGate(reference.featureId, 'fixture', deps)).toEqual([expect.objectContaining({ status: 'unsatisfied', enforced: true })]);
  });
  it('does not omit an approved plan item that has no registered implementation', async () => {
    const outcomes = await planDesignEvidenceGate(reference.featureId, 'fixture', {
      ...flags, evaluate, listItems: async () => [{ id: 'WI-unrelated', sourcePlanItemIds: ['P-999'], payload: {} } as WorkItem],
    });
    expect(outcomes).toContainEqual(expect.objectContaining({ status: 'unsatisfied', enforced: true, report: expect.stringContaining('missing implementing work-item registration') }));
  });
});
