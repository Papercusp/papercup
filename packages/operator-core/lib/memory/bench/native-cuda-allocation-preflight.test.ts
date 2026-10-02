import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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
