import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertNativeProfilerQualification, bindNativeProfilerKernelRequests, bindNativeLoaderMappedObjects, inspectNativeLoaderActivity, loadIndependentMeasurementInputs, validateIndependentCohort, type PreparedMeasurement } from './measurement-manifest';
import type { WorkerNativeInferenceTrace } from '../../../../../libs/generic/memory/src/local-embedder-worker';
import { independentCohortFixture, measurementManifestFixture } from './fixtures/measurement-manifest';

const roots: string[] = [];
describe('native loader population evidence', () => {
  const window = { runTag: 'pc-embed:123:1:0:1:1', processId: 123, nativeThreadId: 456,
    startMonotonicNs: '100', endMonotonicNs: '200' };
  const marker = (phase: string, overrides = {}) => 'PC_NATIVE_RUN\t'+JSON.stringify({ runTag: window.runTag,
    processId: 123, nativeThreadId: 456, phase, monotonicNs: phase === 'start' ? '100' : '200', ...overrides });
  const startup = ['123: file=libc.so.6 [0];  generating link map',
    '123: calling init: /lib/libc.so.6', '123: transferring control: /runtime/node'];
  const log = (...middle: string[]) => [...startup, marker('start'), ...middle, marker('end')].join('\n');
  it('binds complete markers and keeps no-activity distinct from complete DLL closure', () => {
    expect(inspectNativeLoaderActivity(log('999: file=child.so [0];  generating link map'), [window]))
      .toMatchObject({ noLoaderActivityDuringPopulation: true, completeBeforeInferenceClosureVerified: false });
  });
  it('detects a transient load/unload even when the snapshot population would be unchanged', () => {
    const result = inspectNativeLoaderActivity(log('123: file=/runtime/transient.so [2];  generating link map',
      '123: calling init: /runtime/transient.so', '123: calling fini: /runtime/transient.so [2]',
      '123: file=/runtime/transient.so [2];  destroying link map'), [window]);
    expect(result.noLoaderActivityDuringPopulation).toBe(false);
    expect(result.activity.map(x=>x.operation)).toEqual(['generating-map','init','fini','destroying-map']);
    expect(result.activity[0].namespace).toBe('2');
  });
  it('rejects invalid and overlapping native request populations before inspecting logs', () => {
    expect(()=>inspectNativeLoaderActivity(log(),[])).toThrow('population');
    expect(()=>inspectNativeLoaderActivity(log(),[window,window])).toThrow('population');
    expect(()=>inspectNativeLoaderActivity(log(),[{...window,startMonotonicNs:100 as any}])).toThrow('population');
    expect(()=>inspectNativeLoaderActivity(log(),[window,{...window,runTag:'second',startMonotonicNs:'150',endMonotonicNs:'250'}]))
      .toThrow('overlapping');
  });
  it.each(['missing-start','missing-end','duplicate','tag','thread','clock','process','malformed','startup','format'])
    ('rejects %s evidence', failure => {
      let text = log();
      if (failure === 'missing-start') text = [...startup, marker('end')].join('\n');
      if (failure === 'missing-end') text = [...startup, marker('start')].join('\n');
      if (failure === 'duplicate') text = log(marker('start'));
      if (['tag','thread','clock','process'].includes(failure)) text = [...startup,
        marker('start', failure === 'tag' ? {runTag:'another'} : failure === 'thread' ? {nativeThreadId:1}
          : failure === 'clock' ? {monotonicNs:'99'} : {processId:999}), marker('end')].join('\n');
      if (failure === 'malformed') text = log('PC_NATIVE_RUN\t{');
      if (failure === 'startup') text = [marker('start'),marker('end')].join('\n');
      if (failure === 'format') text = log('123: file=broken; generating link map');
      expect(()=>inspectNativeLoaderActivity(text,[window])).toThrow('native loader');
    });
  it.runIf(process.platform === 'linux')('observes real glibc load/unload of a model-free shared object', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'native-loader-fixture-')); roots.push(root);
    const library = path.join(root,'transient.so');
    const compiler = spawnSync('/usr/bin/cc',['-x','c','-shared','-fPIC','-nostdlib','-o',library,'-'],
      { input:'int pc_loader_fixture(void) { return 7; }',encoding:'utf8',timeout:10000 });
    expect(compiler.status,compiler.stderr).toBe(0);
    const program = `import ctypes,_ctypes,json,os,time
def marker(phase):
 n=str(time.clock_gettime_ns(time.CLOCK_MONOTONIC)); row=dict(runTag='fixture',processId=os.getpid(),nativeThreadId=os.getpid(),phase=phase,monotonicNs=n)
 os.write(2,('PC_NATIVE_RUN\\t'+json.dumps(row)+'\\n').encode()); return n
start=marker('start')
library=ctypes.CDLL(${JSON.stringify(library)})
assert library.pc_loader_fixture()==7
_ctypes.dlclose(library._handle)
end=marker('end')
print(json.dumps(dict(runTag='fixture',processId=os.getpid(),nativeThreadId=os.getpid(),startMonotonicNs=start,endMonotonicNs=end)))`;
    const env: NodeJS.ProcessEnv={...process.env,LD_DEBUG:'files'}; delete env.LD_DEBUG_OUTPUT;
    const child=spawnSync('/usr/bin/python3',['-I','-S','-c',program],{env,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
    expect(child.status,child.stderr).toBe(0);
    const result=inspectNativeLoaderActivity(child.stderr,[JSON.parse(child.stdout)]);
    expect(result.noLoaderActivityDuringPopulation).toBe(false);
    expect(result.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({operation:'generating-map',object:library}),
      expect.objectContaining({operation:'destroying-map',object:library}),
    ]));
  });
});
describe('generated loader object to retained file joins', () => {
  const window = { runTag: 'first', processId: 123, nativeThreadId: 456, startMonotonicNs: '100', endMonotonicNs: '200' };
  const marker = (phase: 'start'|'end') => 'PC_NATIVE_RUN\t'+JSON.stringify({ runTag: window.runTag,
    processId: 123, nativeThreadId: 456, phase, monotonicNs: phase === 'start' ? '100' : '200' });
  const object = (name='libsame.so', namespace='0', dynamic='0x1800', phdr='0x1040', bias='0x1000') =>
    [`123: file=${name} [${namespace}];  generating link map`,
      `123: dynamic: ${dynamic}  base: ${bias}  size: 0x1000`, `123: entry: 0x1000  phdr: ${phdr}  phnum: 9`];
  const log = (...rows: string[]) => [...rows,'123: calling init: /alias/libsame.so',
    '123: transferring control: /runtime/node',marker('start'),marker('end')].join('\n');
  const sample = (): WorkerNativeInferenceTrace => ({ model:'/fixture', device:'cpu', observedAt:'2026-10-02T00:00:00.000Z',
    requestId:1,attempt:1,workerThreadId:1,processId:123,nativeThreadId:456,runTag:'first',runIndex:1,
    phase:'start',clock:'node-hrtime',monotonicNs:'100',runtime:{platform:'linux',clock:'node-hrtime',beforeNs:'80',afterNs:'90',
      gpuMemory:{status:'not-applicable'},libraries:[{path:'/resolved/libsame.so.1',bytes:8192,sha256:'a'.repeat(64),
        mappedDevice:'08:01',mappedInode:'123',mappedRanges:[{startAddress:'1000',endAddress:'2000',fileOffset:'0',permissions:'r--p'}]}]}});
  it('joins actual addresses to resolved fingerprints, preserving load bias zero and scope', () => {
    const result=bindNativeLoaderMappedObjects(log(...object(undefined,undefined,undefined,undefined,'0x0')),[window],sample());
    expect(result.objectMapJoins).toHaveLength(1);
    expect(result.objectMapJoins[0]).toMatchObject({object:'libsame.so',namespace:'0',loadBias:'0x0',
      file:{path:'/resolved/libsame.so.1',mappedInode:'123',sha256:'a'.repeat(64)}});
    expect(result.completeBeforeInferenceClosureVerified).toBe(false);
  });
  it('distinguishes identical basenames and namespaces by addresses, not names', () => {
    const event=sample(), other=structuredClone(event.runtime!.libraries[0]);
    other.path='/other/libsame.so.1';other.mappedInode='456';other.sha256='b'.repeat(64);
    other.mappedRanges=[{startAddress:'3000',endAddress:'4000',fileOffset:'0',permissions:'r--p'}];
    event.runtime!.libraries.push(other);
    const result=bindNativeLoaderMappedObjects(log(...object(),...object('libsame.so','2','0x3800','0x3040','0x3000')),[window],event);
    expect(result.objectMapJoins.map(join=>[join.namespace,join.file.path])).toEqual([
      ['0','/resolved/libsame.so.1'],['2','/other/libsame.so.1']]);
  });
  it('reports retired objects and unjoined executable/interpreter mappings explicitly', () => {
    const event=sample(), other=structuredClone(event.runtime!.libraries[0]);
    other.path='/runtime/node';other.mappedRanges=[{startAddress:'5000',endAddress:'6000',fileOffset:'0',permissions:'r-xp'}];
    event.runtime!.libraries.push(other);
    const result=bindNativeLoaderMappedObjects(log(...object(),...object('transient.so','1','0x3800','0x3040'),
      '123: file=transient.so [1];  destroying link map'),[window],event);
    expect(result.retiredBeforeFirstRun.map(x=>x.object)).toEqual(['transient.so']);
    expect(result.unjoinedMappedFiles.map(x=>x.path)).toEqual(['/runtime/node']);
  });
  it.each(['missing-ranges','bad-range','overlap','dynamic','header','split-file','missing-detail','namespace',
    'repeated-object','unbound-destroy','wrong-sample','late-sample','bad-fingerprint','foreign-detail'])('refuses %s evidence', failure => {
    const event=sample(); let rows=object();
    if(failure==='missing-ranges') delete event.runtime!.libraries[0].mappedRanges;
    if(failure==='bad-range') event.runtime!.libraries[0].mappedRanges![0].endAddress='1000';
    if(failure==='overlap'||failure==='split-file') {
      const other=structuredClone(event.runtime!.libraries[0]); other.path='/different.so';
      if(failure==='split-file') {
        event.runtime!.libraries[0].mappedRanges![0].endAddress='1800';
        other.mappedRanges![0].startAddress='1800';
      }
      event.runtime!.libraries.push(other);
    }
    if(failure==='dynamic') rows=object(undefined,undefined,'0x2800');
    if(failure==='header') rows=object(undefined,undefined,undefined,'0x2040');
    if(failure==='missing-detail') rows.splice(1,1);
    if(failure==='namespace') rows.push(...object('second.so','2'));
    if(failure==='repeated-object') rows.push(...object());
    if(failure==='unbound-destroy') rows.push('123: file=other.so [0];  destroying link map');
    if(failure==='wrong-sample') event.nativeThreadId=999;
    if(failure==='late-sample') event.runtime!.afterNs='101';
    if(failure==='bad-fingerprint') event.runtime!.libraries[0].sha256='bad';
    if(failure==='foreign-detail') rows[1]=rows[1].replace('123:','999:');
    expect(()=>bindNativeLoaderMappedObjects(log(...rows),[window],event)).toThrow('native loader');
  });
  it.runIf(process.platform === 'linux')('joins real glibc object addresses to hashed pre-Run file maps', () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-loader-namespace-'));roots.push(root);
    const library=path.join(root,'same-object.so');
    const compiled=spawnSync('/usr/bin/cc',['-x','c','-shared','-fPIC','-nostdlib','-o',library,'-'],
      {input:'int pc_loader_fixture(void) { return 7; }',encoding:'utf8',timeout:10000});
    expect(compiled.status,compiled.stderr).toBe(0);
    const program = `import os,json,time,hashlib,ctypes
libc=ctypes.CDLL('libc.so.6')
libc.dlmopen.argtypes=[ctypes.c_long,ctypes.c_char_p,ctypes.c_int]; libc.dlmopen.restype=ctypes.c_void_p
handles=[libc.dlmopen(-1,${JSON.stringify(library)}.encode(),2) for _ in range(2)]
assert all(handles) and handles[0]!=handles[1]
rows={}
before=str(time.clock_gettime_ns(time.CLOCK_MONOTONIC))
for line in open('/proc/self/maps'):
 fields=line.split(None,5)
 if len(fields)<6 or not fields[5].startswith('/'): continue
 address,permissions,offset,device,inode,file=fields; file=file.strip()
 row=rows.setdefault(file,dict(path=file,mappedDevice=device,mappedInode=inode,mappedRanges=[],eligible=False))
 row['eligible'] |= 'x' in permissions or '.so' in file
 start,end=address.split('-'); row['mappedRanges'].append(dict(startAddress=start,endAddress=end,fileOffset=offset,permissions=permissions))
libraries=[]
for file,row in rows.items():
 if not row.pop('eligible'): continue
 stat=os.stat(file)
 assert str(stat.st_ino)==row['mappedInode']
 assert (os.major(stat.st_dev),os.minor(stat.st_dev))==tuple(int(x,16) for x in row['mappedDevice'].split(':'))
 row.update(bytes=stat.st_size,sha256=hashlib.file_digest(open(file,'rb'),'sha256').hexdigest()); libraries.append(row)
after=str(time.clock_gettime_ns(time.CLOCK_MONOTONIC))
def marker(phase):
 n=str(time.clock_gettime_ns(time.CLOCK_MONOTONIC)); os.write(2,('PC_NATIVE_RUN\\t'+json.dumps(dict(runTag='real',processId=os.getpid(),nativeThreadId=os.getpid(),phase=phase,monotonicNs=n))+'\\n').encode()); return n
start=marker('start'); end=marker('end')
print(json.dumps(dict(window=dict(runTag='real',processId=os.getpid(),nativeThreadId=os.getpid(),startMonotonicNs=start,endMonotonicNs=end),runtime=dict(platform='linux',clock='node-hrtime',beforeNs=before,afterNs=after,libraries=libraries,gpuMemory=dict(status='not-applicable')))))`;
    const env: NodeJS.ProcessEnv={...process.env,LD_DEBUG:'files'};delete env.LD_DEBUG_OUTPUT;
    const child=spawnSync('/usr/bin/python3',['-I','-S','-c',program],{env,encoding:'utf8',timeout:10000,maxBuffer:2*1024*1024});
    expect(child.status,child.stderr).toBe(0);
    const observed=JSON.parse(child.stdout), event={...sample(),...observed.window,runTag:'real',
      monotonicNs:observed.window.startMonotonicNs,runtime:observed.runtime};
    const result=bindNativeLoaderMappedObjects(child.stderr,[observed.window],event);
    expect(result.objectMapJoins.length).toBeGreaterThan(3);
    expect(result.objectMapJoins.some(join=>join.object==='libc.so.6')).toBe(true);
    const namespaceJoins=result.objectMapJoins.filter(join=>join.file.path===library);
    expect(namespaceJoins).toHaveLength(2);
    expect(new Set(namespaceJoins.map(join=>join.namespace)).size).toBe(2);
    expect(namespaceJoins.every(join=>join.namespace!=='0')).toBe(true);
    expect(result.noLoaderActivityDuringPopulation).toBe(true);
    expect(result.unjoinedMappedFiles.some(file=>file.path.includes('python3'))).toBe(true);
    expect(result.completeBeforeInferenceClosureVerified).toBe(false);
  });
});
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
