import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertNativeProfilerQualification, bindNativeProfilerKernelRequests, loadIndependentMeasurementInputs, validateIndependentCohort, type PreparedMeasurement } from './measurement-manifest';
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
    'Import Failed: Qdstrm file does not have valid time conversion factors.',
    'Fatal error: invalid_command_line_syntax',
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

describe('native profiler monotonic-clock launch attribution', () => {
  const origin = '9007199254740993000';
  const window = (runTag: string, start: bigint, end: bigint, nativeThreadId = 8) => ({
    runTag, processId: 7, nativeThreadId, startMonotonicNs: (BigInt(origin)+start).toString(), endMonotonicNs: (BigInt(origin)+end).toString() });
  const windows = [window('request-zero', 10n, 20n), window('request-one', 30n, 40n)];
  const launches = [{ processId: 7, nativeThreadId: 8, correlationId: 1, startNs: '11', endNs: '19' },
    { processId: 7, nativeThreadId: 8, correlationId: 2, startNs: '31', endNs: '39' }];
  const kernels = [{ kernelId: 'kernel-one', processId: 7, correlationId: 1 },
    { kernelId: 'kernel-two', processId: 7, correlationId: 2 }];
  it('joins launch APIs exactly above Number precision, independently of kernel completion order', () => {
    expect(bindNativeProfilerKernelRequests(origin, windows, launches, [...kernels].reverse())).toEqual([
      { kernelId: 'kernel-two', runTag: 'request-one' }, { kernelId: 'kernel-one', runTag: 'request-zero' }]);
  });
  it('allows several kernels per API and simultaneous requests on distinct OS threads', () => {
    const parallel = [windows[0], { ...windows[0], runTag: 'other-thread', nativeThreadId: 9 }];
    expect(bindNativeProfilerKernelRequests(origin, parallel, [launches[0], { ...launches[0], nativeThreadId: 9, correlationId: 3 }],
      [kernels[0], { ...kernels[0], kernelId: 'another-kernel' }, { ...kernels[0], kernelId: 'parallel-kernel', correlationId: 3 }])).toHaveLength(3);
  });
  it('rejects a wrong clock origin, API straddling a boundary and a different launching thread', () => {
    expect(() => bindNativeProfilerKernelRequests((BigInt(origin)+100n).toString(), windows, launches, kernels)).toThrow('unique monotonic');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, [{ ...launches[0], endNs: '21' }, launches[1]], kernels)).toThrow('unique monotonic');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, launches.map(x => ({ ...x, nativeThreadId: 9 })), kernels)).toThrow('unique monotonic');
  });
  it('rejects substituting the observed independent RAW clock for the profiler monotonic origin', () => {
    const rawClockOffset = 13559209703n;
    const rawWindows = windows.map(w => ({ ...w, startMonotonicNs: (BigInt(w.startMonotonicNs)-rawClockOffset).toString(),
      endMonotonicNs: (BigInt(w.endMonotonicNs)-rawClockOffset).toString() }));
    expect(() => bindNativeProfilerKernelRequests(origin, rawWindows, launches, kernels)).toThrow('unique monotonic');
  });
  it('rejects overlapping request windows and duplicate tags', () => {
    expect(() => bindNativeProfilerKernelRequests(origin, [windows[0], window('overlap', 15n, 30n)], launches, kernels)).toThrow('overlapping');
    expect(() => bindNativeProfilerKernelRequests(origin, [windows[0], windows[0]], launches, kernels)).toThrow('request window');
  });
  it('rejects cross-process, missing and duplicate API correlations', () => {
    expect(() => bindNativeProfilerKernelRequests(origin, windows, launches, [{ ...kernels[0], processId: 9 }])).toThrow('lacks launch');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, launches.slice(1), kernels)).toThrow('lacks launch');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, [...launches, launches[0]], kernels)).toThrow('ambiguous');
  });
  it('rejects empty populations, unobserved request windows and duplicate kernel rows', () => {
    expect(() => bindNativeProfilerKernelRequests(origin, windows, launches, [])).toThrow('population');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, launches, kernels.slice(0,1))).toThrow('lacks compute');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, launches, [...kernels, kernels[0]])).toThrow('kernel identity');
  });
  it.each(['1.2', '-1', ' 1', '01', 'Infinity', ''])('rejects noncanonical nanoseconds: %s', (value) => {
    expect(() => bindNativeProfilerKernelRequests(value, windows, launches, kernels)).toThrow('nanoseconds');
    expect(() => bindNativeProfilerKernelRequests(origin, [{ ...windows[0], startMonotonicNs: value }], launches, kernels)).toThrow('nanoseconds');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, [{ ...launches[0], startNs: value }], kernels)).toThrow('nanoseconds');
  });
  it('rejects invalid process/correlation IDs and reversed intervals', () => {
    expect(() => bindNativeProfilerKernelRequests(origin, [{ ...windows[0], processId: 0 }], launches, kernels)).toThrow('request window');
    expect(() => bindNativeProfilerKernelRequests(origin, [window('reverse',20n,10n)], launches, kernels)).toThrow('request window');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, [{ ...launches[0], correlationId: 0 }], kernels)).toThrow('API correlation');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, [{ ...launches[0], endNs: '10' }], kernels)).toThrow('API correlation');
  });
});
