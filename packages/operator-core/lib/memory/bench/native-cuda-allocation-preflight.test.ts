import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { inspectNativeCudaAllocationFailure } from './measurement-manifest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = fileURLToPath(new URL('./fixtures/native-cuda-clock-preflight.py', import.meta.url));

describe('retained native CUDA allocation cause', () => {
  const report = (api: string) => `========= Program hit cudaErrorMemoryAllocation (error 2) due to "out of memory" on CUDA API call to ${api}.
=========         Host Frame: [0x1ee77a] in libonnxruntime_providers_cuda.so
=========         Host Frame: InferenceSessionWrap::Run(Napi::CallbackInfo const&) [0x1ad40] in onnxruntime_binding.node
`;
  const log = report('cudaMalloc') + report('cudaGetLastError') + '========= ERROR SUMMARY: 2 errors\n';
  it('distinguishes the failed allocation from propagation without asserting pressure or allocation sizes', () => {
    expect(inspectNativeCudaAllocationFailure(log)).toEqual({ underlyingApi: 'cudaMalloc', returnCode: 2,
      allocationErrors: 1, propagatedErrors: 1, cudaProviderOffsets: ['0x1ee77a', '0x1ee77a'] });
  });
  it.each([
    ['generic arena error', 'BFCArena::AllocateRawInternal Failed to allocate memory for requested buffer of size 3221225472'],
    ['propagation only', report('cudaGetLastError') + '========= ERROR SUMMARY: 1 error\n'],
    ['another error code', log.replaceAll('error 2', 'error 3')],
    ['another provider', log.replaceAll('libonnxruntime_providers_cuda.so', 'libunrelated.so')],
    ['unbound native call', log.replaceAll('InferenceSessionWrap::Run', 'UnrelatedWorker::Run')],
    ['partial census', log.replace('SUMMARY: 2', 'SUMMARY: 1')],
    ['missing terminal summary', log.replace('========= ERROR SUMMARY: 2 errors\n', '')],
  ])('refuses %s as allocation-cause evidence', (_name, value) => {
    expect(() => inspectNativeCudaAllocationFailure(value)).toThrow('CUDA allocation diagnostic');
  });
});

function control(failureCode: number, successfulFailure = false, capacity = 4096) {
  const root = mkdtempSync(join(tmpdir(), 'cuda-allocation-control-')); roots.push(root);
  const output = join(root, 'receipt.json');
  // Execute the actual maintained fixture with a deterministic CUDA ABI stub.
  // The live GPU/tool qualification remains a separate measured receipt.
  const program = `
import ctypes as c,sys,json
allocations=[]; frees=[]
class Function:
 def __init__(self, fn): self.fn=fn
 def __call__(self,*args): return self.fn(*args)
def allocate(pointer,size):
 allocations.append(size)
 if size==32 or ${successfulFailure ? 'True' : 'False'}: pointer._obj.value=len(allocations); return 0
 return ${failureCode}
def memory(free,total): free._obj.value=${capacity}; total._obj.value=${capacity}; return 0
class CUDA:
 cudaSetDevice=Function(lambda n:0)
 cudaMalloc=Function(allocate)
 cudaMemcpy=Function(lambda *a:0)
 cudaFree=Function(lambda p:frees.append(p.value) or 0)
 cudaMemGetInfo=Function(memory)
 cudaGetErrorString=Function(lambda n:b'out of memory')
c.CDLL=lambda p:CUDA()
sys.argv=[${JSON.stringify(fixture)},${JSON.stringify(output)},'allocator-api-control']
source=open(sys.argv[0]).read()
try: exec(compile(source,sys.argv[0],'exec'),{'__file__':sys.argv[0]})
finally: print('ABI_CALLS '+json.dumps({'allocations':allocations,'frees':frees}))
`;
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', program], { encoding: 'utf8', timeout: 10000 });
  return { result, output };
}

describe('model-free CUDA allocator diagnostic control', () => {
  it('requires an actual allocation error beyond total capacity, retains call clocks, and frees the small control', () => {
    const { result, output } = control(2);
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(output, 'utf8'));
    expect(receipt).toMatchObject({ returnCode: 2, requestedBytes: 8192, totalBytes: 4096,
      smallAllocationBytes: 32, modelInferencePerformed: false });
    expect(BigInt(receipt.beforeClock.monotonicAfterNs)).toBeLessThanOrEqual(BigInt(receipt.afterClock.monotonicBeforeNs));
    expect(result.stdout).toContain('PC_CUDA_ALLOCATION_CONTROL\tstart');
    expect(result.stdout).toContain('PC_CUDA_ALLOCATION_CONTROL\tend');
    expect(result.stdout).toContain('ABI_CALLS {"allocations": [32, 8192], "frees": [1]}');
  });

  it.each([0, 1, 3, 999])('refuses another CUDA return code %s and still frees the successful control', code => {
    const { result } = control(code);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('did not return cudaErrorMemoryAllocation');
    expect(result.stdout).toContain('"frees": [1]');
  });

  it('refuses unexpected success and frees both allocations', () => {
    const { result } = control(0, true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('did not return cudaErrorMemoryAllocation');
    expect(result.stdout).toContain('"frees": [2, 1]');
  });

  it('refuses an unmeasured total capacity before allocating', () => {
    const { result } = control(2, false, 0);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid CUDA allocation control capacity');
    expect(result.stdout).toContain('ABI_CALLS {"allocations": [], "frees": []}');
  });
});

describe('native allocator INFO logging preload', () => {
  const preload = fileURLToPath(new URL('./fixtures/native-ort-allocator-logging.mjs', import.meta.url));
  const program = () => {
    const root = mkdtempSync(join(tmpdir(), 'allocator-logging-worker-')); roots.push(root);
    const file = join(root, 'worker.mjs'); writeFileSync(file, 'export {};\n');
    return `(async()=>{
const imported=await import(${JSON.stringify(preload)});
const restore=imported.installNativeAllocatorLogging(${JSON.stringify(file)});
const {Worker}=require('node:worker_threads');
const worker=new Worker(${JSON.stringify(file)},{workerData:{device:'cuda'},execArgv:[]});
worker.on('error',error=>{console.error(error);process.exitCode=1});
worker.on('exit',()=>restore());
})().catch(error=>{console.error(error);process.exitCode=1});`;
  };
  it('uses the supported logging hook without constructing a model or changing provider options', () => {
    const result = spawnSync(process.execPath, ['-e', program()], {
      env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)) },
      encoding: 'utf8', timeout: 10000,
    });
    expect(result.status, result.stderr).toBe(0);
    const line = result.stderr.split('\n').find(line => line.startsWith('PC_ORT_ALLOCATOR_LOGGING\t'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.split('\t')[1])).toMatchObject({ onnxLogLevel: 'info', transformersLogLevel: 20,
      modelInferencePerformed: false, providerOptionsChanged: false });
    expect(JSON.parse(line!.split('\t')[1]).workerThreadId).toBeGreaterThan(0);
  });

  it('refuses an absent runtime configuration before importing native dependencies', () => {
    const env = { ...process.env }; delete env.TSX_TSCONFIG_PATH;
    const result = spawnSync(process.execPath, ['-e', program()], { env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('allocator logging requires the bound runtime configuration path');
    expect(result.stderr).not.toContain('PC_ORT_ALLOCATOR_LOGGING\t');
  });

  it('leaves the parent and loader contexts silent without importing native dependencies', () => {
    const env = { ...process.env }; delete env.TSX_TSCONFIG_PATH;
    const result = spawnSync(process.execPath, ['--import', preload, '-e', ''], { env, encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('PC_ORT_ALLOCATOR_LOGGING\t');
  });
});

describe('small native ORT teardown control', () => {
  const controlFixture = fileURLToPath(new URL('./fixtures/native-ort-teardown-control.mjs', import.meta.url));
  const fromTransformers = createRequire(createRequire(import.meta.url).resolve('@huggingface/transformers'));
  const ortEntry = fromTransformers.resolve('onnxruntime-node');

  it('binds native abort evidence to the inferior process rather than the debugger exit', async () => {
    // GDB is an opt-in diagnostic dependency. Exercise the actual evidence
    // reader without making ordinary CI depend on a system debugger or CUDA.
    const { inspectHostDebuggerCapture } = await import('./fixtures/native-ort-teardown-control.mjs');
    const record = (row: object) => 'PC_NATIVE_DEBUGGER\t' + JSON.stringify(row) + '\n';
    const start = record({ event: 'start', processId: 123 });
    const signal = record({ event: 'signal', processId: 123, signal: 'SIGABRT' });
    const backtrace = 'PC_NATIVE_BACKTRACE_BEGIN\n#0 abort\nPC_NATIVE_BACKTRACE_END\n';
    const exit = record({ event: 'exit', processId: 123, exitCode: null, signal: 'SIGABRT', signalDelivered: true });
    const terminal = { eof: true, exitCode: 0, signal: null };
    expect(inspectHostDebuggerCapture(start + signal + backtrace + exit, terminal)).toMatchObject({
      processId: 123, source: 'gdb-events', exitCode: null, signal: 'SIGABRT', hostBacktraceCaptured: true,
    });
    for (const stdout of [start, start + exit, start + signal + exit,
      start + signal + backtrace + exit.replace('123', '124'),
      start + signal + backtrace + exit.replace('true', 'false'),
      start + signal + backtrace + exit + exit,
      start + signal + backtrace + exit + record({ event: 'error', message: 'lost inferior' })]) {
      expect(() => inspectHostDebuggerCapture(stdout, terminal)).toThrow(/native debugger/);
    }
    expect(() => inspectHostDebuggerCapture(start + signal + backtrace + exit, { ...terminal, eof: false })).toThrow();
    expect(() => inspectHostDebuggerCapture(start + signal + backtrace + exit, { ...terminal, exitCode: 1 })).toThrow();
    expect(inspectHostDebuggerCapture(start + record({ event: 'exit', processId: 123, exitCode: 1,
      signal: null, signalDelivered: true }), terminal)).toMatchObject({ exitCode: 1, signal: null, hostBacktraceCaptured: false });
  });

  it.each(['success', 'shape-error'] as const)('captures exact FILE-worker %s and process EOF after explicit release', outcome => {
    const root = mkdtempSync(join(tmpdir(), 'native-ort-teardown-')); roots.push(root);
    const child = spawnSync(process.execPath, [controlFixture, 'capture', root,
      JSON.stringify({ ortEntry, device: 'cpu', outcome, release: 'dispose' })], { encoding: 'utf8', timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
    const terminal = JSON.parse(readFileSync(join(root, 'target-terminal.json'), 'utf8'));
    const receipt = JSON.parse(readFileSync(join(root, 'target.stdout.log'), 'utf8'));
    expect(terminal).toMatchObject({ eof: true, exitCode: 0, signal: null, captureStartedBeforeExec: true });
    expect(receipt).toMatchObject({ processId: terminal.processId, outcome, device: 'cpu', disposed: true,
      embeddingModelInferencePerformed: false, graph: { bytes: 130,
        sha256: '71f431c4e9321ec6fbeb158d02ed240459a7dcc98673fa79a4f439ce42efaf10' } });
    expect(receipt.observation.serializedAdmissionContext).toBe(process.env.PAPERCUSP_ADMISSION_CONTEXT ?? null);
    if (outcome === 'success') expect(receipt.output).toEqual([1, 2, 3, 4, 5, 6]);
    else expect(receipt.expectedError).toContain('Got invalid dimensions for input');
  });

  it('retains actual allocator settings and loaded libc separately from admission evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-ort-allocator-environment-')); roots.push(root);
    const env: NodeJS.ProcessEnv = { ...process.env, GLIBC_TUNABLES: 'glibc.malloc.tcache_count=0:glibc.malloc.perturb=165',
      MALLOC_PERTURB_: '165' };
    const child = spawnSync(process.execPath, [controlFixture, 'capture', root,
      JSON.stringify({ ortEntry, device: 'cpu', outcome: 'success', release: 'dispose' })],
    { env, encoding: 'utf8', timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(join(root, 'target.stdout.log'), 'utf8'));
    expect(receipt.observation).toMatchObject({
      serializedAdmissionContext: env.PAPERCUSP_ADMISSION_CONTEXT ?? null,
      allocator: { GLIBC_TUNABLES: env.GLIBC_TUNABLES, MALLOC_PERTURB_: '165',
        MALLOC_CHECK_: env.MALLOC_CHECK_ ?? null, LD_PRELOAD: env.LD_PRELOAD ?? null },
    });
    if (process.platform === 'linux') {
      expect(receipt.observation.libraries.some((row: { path: string }) => row.path.endsWith('/libc.so.6'))).toBe(true);
      for (const row of receipt.observation.libraries) {
        expect(row.bytes).toBeGreaterThan(0);
        expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    }
    expect(receipt.embeddingModelInferencePerformed).toBe(false);
  });

  it('captures environment finalization separately from explicit session release', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-ort-teardown-')); roots.push(root);
    const child = spawnSync(process.execPath, [controlFixture, 'capture', root,
      JSON.stringify({ ortEntry, device: 'cpu', outcome: 'success', release: 'environment' })], { encoding: 'utf8', timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'target.stdout.log'), 'utf8'))).toMatchObject({ disposed: false, release: 'environment' });
    expect(JSON.parse(readFileSync(join(root, 'target-terminal.json'), 'utf8'))).toMatchObject({ eof: true, exitCode: 0, signal: null });
  });

  it.each(['uncaught', 'exit-code'] as const)('retains a model error with %s as exit1 after FILE-worker cleanup', terminal => {
    const root = mkdtempSync(join(tmpdir(), 'native-ort-teardown-')); roots.push(root);
    const child = spawnSync(process.execPath, [controlFixture, 'capture', root, JSON.stringify({
      ortEntry, device: 'cpu', outcome: 'shape-error', release: 'environment', terminal,
    })], { encoding: 'utf8', timeout: 15000 });
    expect(child.status).toBe(1);
    expect(JSON.parse(readFileSync(join(root, 'target-terminal.json'), 'utf8'))).toMatchObject({ eof: true, exitCode: 1, signal: null });
    expect(JSON.parse(readFileSync(join(root, 'target.stdout.log'), 'utf8')).expectedError).toContain('Got invalid dimensions');
    expect(readFileSync(join(root, 'target.stderr.log'), 'utf8')).toContain('Got invalid dimensions');
  });

  it.each(['warning', 'info'] as const)('measures the process-global first %s initializer despite later FILE-worker INFO', parentLogLevel => {
    const root = mkdtempSync(join(tmpdir(), 'native-ort-teardown-')); roots.push(root);
    const child = spawnSync(process.execPath, [controlFixture, 'capture', root, JSON.stringify({
      ortEntry, device: 'cpu', outcome: 'success', release: 'dispose', parentLogLevel,
    })], { encoding: 'utf8', timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
    const stderr = readFileSync(join(root, 'target.stderr.log'), 'utf8');
    expect(stderr.includes('Creating BFCArena for Cpu')).toBe(parentLogLevel === 'info');
    expect(JSON.parse(readFileSync(join(root, 'target.stdout.log'), 'utf8'))).toMatchObject({ disposed: true, output: [1, 2, 3, 4, 5, 6] });
  });

  it('refuses an unsupported device before native session construction', () => {
    const child = spawnSync(process.execPath, [controlFixture, 'target', JSON.stringify({
      ortEntry, device: 'automatic', outcome: 'success', release: 'dispose',
    })], { encoding: 'utf8', timeout: 15000 });
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('invalid native teardown control configuration');
    expect(child.stdout).toBe('');
  });
});
