import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasEnumeratedVerificationCoverage } from '../coord-lifecycle/records';

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

  it('keeps browser and native provider fixtures separate from real lifecycle acceptance', () => {
    const browser = evidence.observations.find((row: { id: string }) => row.id === 'current-cloud-chromium');
    const native = evidence.observations.find((row: { id: string }) => row.id === 'current-native-aws-ui');
    expect(browser).toMatchObject({ plane: 'fixture', testRunId: 20962319, result: 'passed', provesRealProviderLifecycle: false });
    expect(native).toMatchObject({ plane: 'native-ui', syntheticCloudResponses: true, provesRealProviderLifecycle: false });
    expect(native.binarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(native.sourceSha).toMatch(/^[a-f0-9]{40}$/);
    expect(native.receiptPath).toContain(`${native.childRun}/phases/native/result.json`);
  });

  it('records the measured task-dispatch falsifier rather than treating session launch as task completion', () => {
    const mutation = evidence.observations.find((row: { id: string }) => row.id === 'restored-task-dispatch-falsifier');
    expect(mutation).toMatchObject({ plane: 'fixture', testRunId: 20962300, specBindingId: 33272, result: 'mutant-caught' });
    expect(mutation.mutation).toContain('sendToSessionOwner(ownerId, request.prompt)');
    expect(mutation.observation).toContain('prompt is empty');
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
