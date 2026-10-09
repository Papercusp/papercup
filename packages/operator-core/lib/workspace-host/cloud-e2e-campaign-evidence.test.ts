import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasEnumeratedVerificationCoverage, RootCauseVerificationSchema } from '../coord-lifecycle/records';
import { findIdentityLeakError } from '../content-lint/identity-leak';
import {
  evaluateCloudCampaignEvidence,
  type CloudCampaignEvidenceContext,
  type CloudCampaignExecution,
  type CloudCampaignManifest,
} from './cloud-e2e-campaign-evidence';
import { workspaceHostCensusProfile } from './census-profiles';

const root = resolve(__dirname, '../../../..');
const evidence = JSON.parse(readFileSync(resolve(root, 'docs/evidence/cloud-e2e-campaign-2026-10-08.json'), 'utf8'));

function sourcePopulation(): string[] {
  const source = readFileSync(resolve(root, evidence.populationSource.report), 'utf8');
  const section = source.split('## Acceptance population\n')[1]?.split('\n## ')[0];
  expect(section).toBeDefined();
  return section!.split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Scenario') && !line.startsWith('| ---'))
    .map((line) => line.split('|')[1]!.trim());
}

describe('cloud E2E campaign acceptance population and evidence boundaries', () => {
  it('pins the complete source-backed population without silently dropping an unavailable journey', () => {
    const names = sourcePopulation();
    expect(evidence.population).toEqual(names);
    expect(new Set(names).size).toBe(names.length);
    expect(createHash('sha256').update(names.join('\n')).digest('hex')).toBe(evidence.populationSource.namesSha256);
    expect(evidence.populationSource.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    for (const path of evidence.populationSource.sourcePaths) expect(existsSync(resolve(root, path)), path).toBe(true);
  });

  it('accounts for inventory entries using the canonical exact-partition validator', () => {
    const coverage = { population: evidence.population, ...evidence.inventory };
    expect(hasEnumeratedVerificationCoverage(coverage)).toBe(true);
    // Falsifiers: an omitted entry, duplicate entry, or unknown label cannot hide
    // behind a population count or an owned gap.
    expect(hasEnumeratedVerificationCoverage({ ...coverage, checked: coverage.checked.slice(1) })).toBe(false);
    expect(hasEnumeratedVerificationCoverage({ ...coverage, notChecked: [coverage.checked[0]] })).toBe(false);
    expect(hasEnumeratedVerificationCoverage({ ...coverage, checked: [...coverage.checked, 'invented journey'] })).toBe(false);
  });

  it('preserves supported providers and the planned Azure refusal obligation', () => {
    expect(evidence.scope.supportedProviders).toEqual(['gcp', 'aws']);
    expect(evidence.scope.plannedProviders).toEqual(['azure']);
    expect(evidence.population).toContain('Unsupported Azure');
    expect(evidence.scope.requiredPlanes).toEqual(['fixture', 'native-ui', 'real-runtime', 'deployed']);
    expect(evidence.scope.destruction).toBe('campaign-created-resources-only');
  });

  it('maps every pinned scenario to an exact recorded detector without promoting lookup targets to acceptance', () => {
    const matrix = evidence.detectorMatrix;
    expect(matrix.map((row: { scenario: string }) => row.scenario)).toEqual(sourcePopulation());
    for (const row of matrix) {
      expect(existsSync(resolve(root, row.testFile)), row.testFile).toBe(true);
      expect(row.caseName).toBeTruthy();
      expect(row.recordedTestRunId).toBeGreaterThan(0);
      expect(row.recordedSourceSha).toMatch(/^[a-f0-9]{40}$/);
      expect(row.recordedResult).toBe('pass');
      expect(row.proofScope).toMatch(/simulated|injected/);
      expect(row.affectedSelection).toBe('unverified');
      expect(row.currentSourceBinding).toBe('unverified');
      expect(row.negativeControl).toBe('unverified');
      expect(row.acceptance).toBe('unknown');
    }
    expect(evidence.detectorMatrixBoundary).toContain('cannot satisfy R-2/R-3');
    expect(evidence.acceptanceEvidence.detectors).toEqual([]);
    const cancellation = evidence.requiredFailurePaths.find((row: { boundary: string }) => row.boundary.startsWith('long-running cancellation'));
    expect(cancellation).toMatchObject({ testRunId: null, caseName: null, acceptance: 'unknown', ownerWorkItem: 'WI-10007610' });
  });

  it('keeps browser and native provider fixtures separate from real lifecycle acceptance', () => {
    const browser = evidence.observations.find((row: { id: string }) => row.id === 'current-cloud-chromium');
    const native = evidence.observations.find((row: { id: string }) => row.id === 'current-native-aws-ui');
    expect(browser).toMatchObject({ plane: 'fixture', testRunId: 20962319, result: 'passed', provesRealProviderLifecycle: false });
    expect(native).toMatchObject({ plane: 'native-ui', syntheticCloudResponses: true, provesRealProviderLifecycle: false });
    expect(native.binarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(native.sourceSha).toMatch(/^[a-f0-9]{40}$/);
    expect(native.receiptPath).toContain(`${native.childRun}/phases/native/result.json`);
  });

  it('retains canonical defect records and accountable residue without inventing triggering journey proof', () => {
    const records = evidence.defectPopulationRecords;
    expect(new Set(records.map((row: { id: string }) => row.id)).size).toBe(records.length);
    expect(records.map((row: { id: string }) => row.id)).toContain('EI-25540445801754635');
    for (const row of records) {
      expect(row.sourceRef).toBe(`work-item:${row.id}`);
      if (row.state !== 'done') expect(row.assignee).toBeTruthy();
      if (row.rootCauseVerification) expect(RootCauseVerificationSchema.safeParse(row.rootCauseVerification).success, row.id).toBe(true);
    }
    for (const row of evidence.outOfScopeResidue) expect(row.assignee).toBeTruthy();
    expect(evidence.defectLedgerBoundary).toContain('shipment stay unproven');
    expect(evidence.acceptanceEvidence.defects).toEqual([]);
  });

  it('records the measured task-dispatch falsifier rather than treating session launch as task completion', () => {
    const mutation = evidence.observations.find((row: { id: string }) => row.id === 'restored-task-dispatch-falsifier');
    expect(mutation).toMatchObject({ plane: 'fixture', testRunId: 20962300, specBindingId: 33272, result: 'mutant-caught' });
    expect(mutation.mutation).toContain('sendToSessionOwner(ownerId, request.prompt)');
    expect(mutation.observation).toContain('prompt is empty');
  });

  it('passes the commit identity detector while retaining the native receipt run and digest', async () => {
    const path = 'docs/evidence/cloud-e2e-campaign-2026-10-08.json';
    expect(await findIdentityLeakError(path, JSON.stringify(evidence), root)).toBeNull();
    const native = evidence.observations.find((row: { id: string }) => row.id === 'current-native-aws-ui');
    expect(native.receiptPath).toBe(`~/.local/state/verification-harness/cloud-workspaces-aws/${native.childRun}/phases/native/result.json`);
    const leaking = structuredClone(evidence);
    const leakingNative = leaking.observations.find((row: { id: string }) => row.id === 'current-native-aws-ui');
    leakingNative.receiptPath = ['', 'home', 'campaignwriter', native.receiptPath.slice(2)].join('/');
    // The exact old class must fail the actual commit guard; malformed JSON is
    // a different hypothesis and cannot explain this valid JSON counterexample.
    const leakyJson = JSON.stringify(leaking);
    expect(() => JSON.parse(leakyJson)).not.toThrow();
    expect(await findIdentityLeakError(path, leakyJson, root)).toBeTruthy();
    leakingNative.receiptPath = native.receiptPath;
    expect(leaking).toEqual(evidence);
  });

  it('does not turn absent real-runtime or shipment evidence into a universal pass', () => {
    expect(evidence.status).toBe('incomplete');
    expect(evidence.realRuntimeReceipts).toEqual([]);
    expect(evidence.shipmentReceipts).toEqual([]);
    expect(evidence.unverified.realRuntime).toContain('provider-side teardown and billing closure');
    expect(evidence.unverified.deployed).toContain('exact authenticated shipped cloud and desktop artifact acceptance');
    expect(evidence.unverified.ownerWorkItem).toBe('WI-10007610');
    expect(evidence.unverified.authorRepair).toHaveLength(4);
  });
});

// Every receipt below is synthetic validator input. It proves the checks work,
// never that this campaign ran these hypothetical journeys or shipped anything.
const fixtureSource = 'a'.repeat(40);
const fixtureDigest = 'b'.repeat(64);
const fixtureAt = '2026-10-09T21:00:00.000Z';
const measured = { sourceSha: fixtureSource, evidenceSha256: fixtureDigest, evidenceRef: 'fixture://record', observedAt: fixtureAt };
function completeFixture(): { data: CloudCampaignManifest; context: CloudCampaignEvidenceContext } {
  const population = ['Provisioning', 'Concurrent/replayed operations'];
  const detectors = (['happy', 'adversarial'] as const).map((kind, index) => ({
    ...measured, id: `detector-${kind}`, scenario: population[index]!, class: kind,
    testFile: 'maintained.test.ts', caseName: `measured ${kind} case`, testFileSha256: fixtureDigest,
    testRunId: index + 1, result: 'passed' as const, selectedByAffected: true,
    negativeControl: 'caught' as const,
  }));
  const receipts: CloudCampaignExecution[] = (['operator-api', 'hosted', 'desktop-native', 'gcp', 'aws'] as const).map((runtime) => ({
    ...measured, id: `execution-${runtime}`, runtime, artifactSha256: fixtureDigest,
    authenticated: true, syntheticCloudResponses: false, tenantId: 'isolated-tenant', workspaceId: 'isolated-workspace',
    accountId: `account-${runtime}`, runId: `run-${runtime}`, resourceLabel: `cloud-campaign-${runtime}`, hostId: `host-${runtime}`,
    actions: population.map((scenario) => ({ scenario, result: 'passed' as const, evidenceRef: `fixture://action/${scenario}` })),
    ...((runtime === 'gcp' || runtime === 'aws') ? {
      census: {
        controllerIndependent: true, inventoryComplete: true, clean: true, evaluatedAt: fixtureAt,
        inventoryEvidence: workspaceHostCensusProfile(runtime).kinds.map((kind) => ({ kind, strategy: 'managed-labels' as const, providerEvidenceRef: `fixture://${runtime}/${kind}` })),
        managed: [], untracked: [], missing: [], labelMismatches: [], reaperPlan: [],
      },
      billingClosure: { result: 'passed' as const, observedAt: fixtureAt, evidenceRef: 'fixture://provider-billing' },
    } : {}),
  }));
  const data: CloudCampaignManifest = {
    population, inventory: { checked: population, notChecked: [], notApplicable: [], residue: [] },
    acceptanceEvidence: {
      detectors, realRuntimeReceipts: receipts,
      defects: [{
        id: 'EI-fixture-defect', assignee: 'fixture-owner', state: 'done', completionAuthority: 'committed',
        originatingFixRef: 'fixture://originating-layer', regressionDetectorId: detectors[0]!.id,
        triggeringJourneyReceiptId: receipts[3]!.id,
        rootCauseVerification: {
          hypothesis: 'The provider-created host was not persisted', alternativeHypothesis: 'The persisted host was not displayed',
          distinguishingTest: 'Read provider host and persistence before rendering', testResult: 'Provider host exists and store is empty',
          testProcedure: 'Crash after provider create, read store and provider inventory, then replay same operation',
          predictedObservations: { hypothesis: 'Provider has one host but store has none', alternativeHypothesis: 'Provider and store both contain the same host' },
          actualObservation: 'Provider has one host but store has none', evidenceRefs: ['fixture://root-cause'],
        },
      }],
      shipmentReceipts: receipts.map((entry) => ({
        ...measured, runtime: entry.runtime, artifactSha256: fixtureDigest, authenticated: true,
        promotedSourceSha: fixtureSource, promotedArtifactSha256: fixtureDigest,
        promotionRef: 'fixture://green-promotion', deploymentRef: 'fixture://deployment', finalExecutionId: entry.id,
        auditRef: 'fixture://completion-audit', gradingRef: 'fixture://independent-grade', reportReadbackRef: 'fixture://report-readback',
      })),
    },
  };
  const context: CloudCampaignEvidenceContext = {
    population, detectorObligations: detectors.map(({ scenario, class: kind, testFile, caseName, sourceSha, testFileSha256 }) => ({ scenario, class: kind, testFile, caseName, sourceSha, testFileSha256 })),
    discoveredDefectIds: ['EI-fixture-defect'],
    testRuns: detectors.map((row) => ({
      id: row.testRunId, filePath: row.testFile, status: 'pass', commitSha: fixtureSource, finishedAt: fixtureAt,
      executionDetails: {
        schemaVersion: 1, passed: 1, failed: 0, skipped: 0, collectionFailed: false,
        passedCaseTitles: [row.caseName], filePath: row.testFile, commitSha: fixtureSource,
        root: '/fixture/source', runGroupId: 'fixture-group', workspaceId: 'fixture-workspace', harnessSlug: 'fixture-harness',
        testNamePattern: null, mutationPhase: null, worktreeDirty: false,
      },
    })),
    runtimeObligations: receipts.map(({ runtime, sourceSha, artifactSha256, tenantId, workspaceId, accountId, runId, resourceLabel }) => ({ runtime, sourceSha, artifactSha256, tenantId, workspaceId, accountId, runId, resourceLabel, scenarios: population })),
    notBefore: '2026-10-09T20:00:00.000Z', now: '2026-10-09T22:00:00.000Z',
  };
  return { data, context };
}

describe('cloud campaign measured evidence contradictions', () => {
  it('accepts complete correlated synthetic validator input only', () => {
    const { data, context } = completeFixture();
    expect(evaluateCloudCampaignEvidence(data, context)).toEqual({ passed: true, problems: { 'R-1': [], 'R-2': [], 'R-3': [], 'R-4': [], 'R-5': [], 'R-6': [] } });
  });

  it('keeps the actual campaign incomplete even if its authored status claims shipped', () => {
    const { context } = completeFixture();
    const result = evaluateCloudCampaignEvidence({ ...evidence, status: 'shipped' }, { ...context, population: sourcePopulation() });
    expect(result.passed).toBe(false);
    for (const bar of ['R-2', 'R-3', 'R-4', 'R-5', 'R-6'] as const) expect(result.problems[bar].length).toBeGreaterThan(0);
  });

  it.each(['result', 'selectedByAffected', 'testFileSha256', 'caseName', 'sourceSha'] as const)('refuses happy coverage when measured detector %s disagrees', (field) => {
    const { data, context } = completeFixture();
    const row = data.acceptanceEvidence.detectors[0]!;
    Object.assign(row, { [field]: field === 'result' ? 'skipped' : field === 'selectedByAffected' ? false : field === 'testFileSha256' ? 'c'.repeat(64) : field === 'sourceSha' ? 'c'.repeat(40) : 'different case' });
    expect(evaluateCloudCampaignEvidence(data, context).problems['R-2']).toContain('unproven-detector:Provisioning');
  });

  it('independently rejects an uncaught adversarial control', () => {
    const { data, context } = completeFixture();
    data.acceptanceEvidence.detectors[1]!.negativeControl = 'missed';
    const result = evaluateCloudCampaignEvidence(data, context);
    expect(result.problems['R-2']).toEqual([]);
    expect(result.problems['R-3']).toContain('unproven-detector:Concurrent/replayed operations');
  });

  it.each(['missing', 'wrong-title', 'failed', 'wrong-source', 'collection-failed'] as const)('joins detector proof to the measured ledger: %s', (mutation) => {
    const { data, context } = completeFixture();
    const rows = context.testRuns as { id: number; filePath: string; status: string; commitSha: string; finishedAt: string; executionDetails: Record<string, unknown> }[];
    if (mutation === 'missing') rows.shift();
    if (mutation === 'wrong-title') rows[0]!.executionDetails.passedCaseTitles = ['unrelated passing case'];
    if (mutation === 'failed') rows[0]!.status = 'fail';
    if (mutation === 'wrong-source') rows[0]!.commitSha = 'c'.repeat(40);
    if (mutation === 'collection-failed') rows[0]!.executionDetails.collectionFailed = true;
    expect(evaluateCloudCampaignEvidence(data, context).problems['R-2']).toContain('unproven-detector:Provisioning');
  });

  it.each(['missing-defect', 'unowned', 'open', 'same-predictions', 'no-trigger', 'proposed'] as const)('rejects defect disposition: %s', (mutation) => {
    const { data, context } = completeFixture();
    const defect = data.acceptanceEvidence.defects[0]!;
    if (mutation === 'missing-defect') data.acceptanceEvidence.defects = [];
    if (mutation === 'unowned') Object.assign(defect, { state: 'deferred', assignee: null });
    if (mutation === 'open') Object.assign(defect, { state: 'open', assignee: 'repair-owner', completionAuthority: 'unknown', rootCauseVerification: undefined, originatingFixRef: undefined });
    if (mutation === 'same-predictions') defect.rootCauseVerification!.predictedObservations!.alternativeHypothesis = defect.rootCauseVerification!.predictedObservations!.hypothesis;
    if (mutation === 'no-trigger') defect.triggeringJourneyReceiptId = 'unmeasured';
    if (mutation === 'proposed') defect.completionAuthority = 'proposed';
    expect(evaluateCloudCampaignEvidence(data, context).problems['R-4'].length).toBeGreaterThan(0);
  });

  it('accounts for owned deferred residue while refusing final shipment', () => {
    const { data, context } = completeFixture();
    Object.assign(data.acceptanceEvidence.defects[0]!, { state: 'deferred', assignee: 'residue-owner', completionAuthority: 'unknown', rootCauseVerification: undefined, originatingFixRef: undefined });
    const result = evaluateCloudCampaignEvidence(data, context);
    expect(result.problems['R-4']).toEqual([]);
    expect(result.problems['R-6']).toContain('unresolved-residue-or-runtime-population');
  });

  it.each(['syntheticCloudResponses', 'authenticated', 'sourceSha', 'artifactSha256', 'tenantId', 'workspaceId', 'accountId', 'runId', 'resourceLabel', 'observedAt'] as const)('refuses real GCP proof when %s differs', (field) => {
    const { data, context } = completeFixture();
    const row = data.acceptanceEvidence.realRuntimeReceipts.find((entry) => entry.runtime === 'gcp')!;
    Object.assign(row, { [field]: field === 'syntheticCloudResponses' ? true : field === 'authenticated' ? false : field === 'sourceSha' ? 'c'.repeat(40) : field === 'artifactSha256' ? 'c'.repeat(64) : field === 'observedAt' ? '2026-10-09T19:00:00.000Z' : 'foreign-identity' });
    const result = evaluateCloudCampaignEvidence(data, context);
    expect(result.problems['R-2']).toEqual([]);
    expect(result.problems['R-5']).toContain('unproven-runtime:gcp');
  });

  it.each(['gcp', 'aws'] as const)('requires every provider kind and separate billing closure for %s', (provider) => {
    const { data, context } = completeFixture();
    const row = data.acceptanceEvidence.realRuntimeReceipts.find((entry) => entry.runtime === provider)!;
    row.census!.inventoryEvidence = row.census!.inventoryEvidence.slice(0, -1);
    expect(evaluateCloudCampaignEvidence(data, context).problems['R-5']).toContain(`unproven-runtime:${provider}`);
    row.census!.inventoryEvidence = workspaceHostCensusProfile(provider).kinds.map((kind) => ({ kind, strategy: 'managed-labels', providerEvidenceRef: 'fixture://census' }));
    row.billingClosure!.result = 'unknown';
    expect(evaluateCloudCampaignEvidence(data, context).problems['R-5']).toContain(`unproven-runtime:${provider}`);
  });

  it('refuses missing runtime obligations, duplicated receipts, partial actions and malformed census', () => {
    for (const mutation of ['obligation', 'duplicate', 'partial', 'census']) {
      const { data, context } = completeFixture();
      const row = data.acceptanceEvidence.realRuntimeReceipts.find((entry) => entry.runtime === 'gcp')!;
      if (mutation === 'obligation') context.runtimeObligations = context.runtimeObligations.filter((entry) => entry.runtime !== 'aws');
      if (mutation === 'duplicate') data.acceptanceEvidence.realRuntimeReceipts.push(row);
      if (mutation === 'partial') row.actions.pop();
      if (mutation === 'census') Object.assign(row, { census: {} });
      expect(evaluateCloudCampaignEvidence(data, context).problems['R-5'].length).toBeGreaterThan(0);
    }
  });

  it.each(['clean', 'controllerIndependent', 'inventoryComplete'] as const)('refuses truthy census strings instead of measured %s booleans', (field) => {
    const { data, context } = completeFixture();
    const row = data.acceptanceEvidence.realRuntimeReceipts.find((entry) => entry.runtime === 'gcp')!;
    Object.assign(row.census!, { [field]: 'true' });
    expect(evaluateCloudCampaignEvidence(data, context).problems['R-5']).toContain('unproven-runtime:gcp');
  });

  it.each(['artifact', 'source', 'unauthenticated', 'earlier-final', 'missing-grade'] as const)('independently rejects final shipment %s', (mutation) => {
    const { data, context } = completeFixture();
    const row = data.acceptanceEvidence.shipmentReceipts[0]!;
    if (mutation === 'artifact') row.promotedArtifactSha256 = 'c'.repeat(64);
    if (mutation === 'source') row.promotedSourceSha = 'c'.repeat(40);
    if (mutation === 'unauthenticated') row.authenticated = false;
    if (mutation === 'earlier-final') row.observedAt = '2026-10-09T21:30:00.000Z';
    if (mutation === 'missing-grade') row.gradingRef = '';
    const result = evaluateCloudCampaignEvidence(data, context);
    expect(result.passed).toBe(false);
    expect(result.problems['R-6'].length).toBeGreaterThan(0);
    if (mutation !== 'missing-grade') expect(result.problems['R-5']).toEqual([]);
  });
});
