import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertNativeProfilerQualification, loadIndependentMeasurementInputs, validateIndependentCohort, type PreparedMeasurement } from './measurement-manifest';
import { independentCohortFixture, measurementManifestFixture } from './fixtures/measurement-manifest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function prepared(): PreparedMeasurement {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'independent-eval-test-')); roots.push(dir);
  const manifest = measurementManifestFixture(dir), { entries, queries, proof } = independentCohortFixture();
  const write = (name: string, value: unknown) => {
    const file = path.join(dir, `${name}.json`), bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(file, bytes);
    return { path: file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  };
  manifest.inputs.snapshot = write('snapshot', { suites: { memory: { entries } } });
  manifest.inputs.labels = write('labels', { memory: queries });
  manifest.inputs.judgments = write('judgments', { memory: { ...proof,
    snapshotSha256: manifest.inputs.snapshot.sha256, labelsSha256: manifest.inputs.labels.sha256 } });
  const cell = manifest.cells.find((c) => c.bar === 'relevance')!;
  return { manifest, cell, arm: manifest.arms[0], manifestSha256: 'a'.repeat(64), rawOutput: path.join(dir, 'out.json'), claimPath: path.join(dir, 'out.running') };
}
describe('independent relevance evaluator inputs', () => {
  it('retains abstention diagnostics only for ambiguous excluded queries', () => {
    const { entries, queries, proof } = independentCohortFixture();
    const diagnostic = { queryId: 'excluded-query', pass: 1, documentIndices: [184] };
    const receipt = { ...proof, ambiguous: ['excluded-query'], excluded: ['excluded-query'], formatAbstentions: [diagnostic] };
    const validate = (value: unknown) => validateIndependentCohort(entries, queries, value,
      proof.snapshotSha256, proof.labelsSha256, proof.frozenAt);
    expect(() => validate(receipt)).not.toThrow();
    expect(() => validate({ ...receipt, excluded: [] })).toThrow('must be excluded');
    expect(() => validate({ ...receipt, formatAbstentions: [{ ...diagnostic, queryId: queries[0].id }] }))
      .toThrow('must be excluded');
  });
  it('loads actual corpus and blind labels, retaining partition metadata and hash-bound versions', () => {
    const p = prepared(), actual = loadIndependentMeasurementInputs(p, 'memory');
    expect(actual.entries.map((e) => e.text)).toEqual(['original source A', 'original source B']);
    expect(actual.queries.filter((q) => q.partition === 'test')).toHaveLength(4);
    expect(actual.queries.filter((q) => q.partition === 'calibration')).toHaveLength(4);
    expect(actual.corpusVersion).toContain(p.manifest.inputs.snapshot.sha256);
    expect(actual.goldVersion).toContain(p.manifest.inputs.labels.sha256);
  });
  it('rejects substituted inputs between preparation and scoring', () => {
    const p = prepared(); fs.appendFileSync(p.manifest.inputs.labels.path, ' ');
    expect(() => loadIndependentMeasurementInputs(p, 'memory')).toThrow('changed after preparation');
  });
  it('rejects a different corpus/cell and altered order instead of falling back to legacy fixtures', () => {
    const p = prepared();
    expect(() => loadIndependentMeasurementInputs(p, 'prose')).toThrow('corpus/cell');
    p.manifest.datasets[0].queryIds.reverse();
    expect(() => loadIndependentMeasurementInputs(p, 'memory')).toThrow('order');
  });
});

describe('native CUDA profiler qualification', () => {
  const decodedCuda = { databaseIntegrity: 'ok', cudaApiRecords: 12, cudaKernelRecords: 36 };

  it('accepts a clean importer and decoded CUDA activity without treating API names as errors', () => {
    expect(() => assertNativeProfilerQualification({ exitCode: 0, output: '0 errors; cudaGetLastError\nSaved report file' }, decodedCuda))
      .not.toThrow();
  });

  it('rejects a saved report from the observed failing CUDA event importer', () => {
    const output = 'Error {\n Type: RuntimeError\n Type: ProcessEventsError\n'
      + 'Unknown driver API function index: 752\nCannot find string for an exterior index\nSaved report file';
    expect(() => assertNativeProfilerQualification({ exitCode: 3, output }, decodedCuda)).toThrow('profiler import failed');
  });

  it.each([
    'Error {\n Type: RuntimeError',
    'Type: ProcessEventsError',
    'Unknown driver API function index: 752',
    'Cannot find string for an exterior index',
    '**** Errors occurred while processing the raw events. ****',
  ])('rejects partial decoding even when the importer exit code is zero: %s', (output) => {
    expect(() => assertNativeProfilerQualification({ exitCode: 0, output }, decodedCuda)).toThrow('profiler import failed');
  });

  it('rejects the previous no-CUDA preflight despite SQLite integrity passing', () => {
    expect(() => assertNativeProfilerQualification({ exitCode: 0, output: 'Saved report file' },
      { databaseIntegrity: 'ok', cudaApiRecords: 0, cudaKernelRecords: 0 })).toThrow('decoded CUDA activity');
  });

  it('rejects a damaged exported database', () => {
    expect(() => assertNativeProfilerQualification({ exitCode: 0, output: '' },
      { ...decodedCuda, databaseIntegrity: 'malformed database' })).toThrow('decoded CUDA activity');
  });

  it.each([0, -1, 0.5, NaN, Infinity])('requires measured positive integer API and kernel counts: %s', (count) => {
    for (const field of ['cudaApiRecords', 'cudaKernelRecords'] as const) {
      expect(() => assertNativeProfilerQualification({ exitCode: 0, output: '' },
        { ...decodedCuda, [field]: count })).toThrow('decoded CUDA activity');
    }
  });
});
