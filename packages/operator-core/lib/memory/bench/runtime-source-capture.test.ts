import { afterEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import inspector from 'node:inspector';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bindRuntimeSourcePopulation, startRuntimeSourceCapture, validateRuntimeSourceCapture } from './runtime-source-capture.mjs';
import { bindRuntimeExecEntry, observeRuntimeExecEntry, bindRuntimeProcessTree, observeRuntimeExecutableMemory, observeRuntimeProcessIdentity, isRuntimeProcessAlive,
  observeRuntimeTracerIdentity, observeRuntimePageSize, runtimeFileTraceArguments } from './runtime-file-opens.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const preload = fileURLToPath(new URL('./runtime-source-capture.mjs', import.meta.url));
function run(program: string, extraArgs: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-source-capture-')); roots.push(root);
  const output = path.join(root, 'sources.jsonl');
  const fixture = path.join(root, 'actual-input.cjs');
  const source = 'module.exports = "runtime-input-identity";\n';
  fs.writeFileSync(fixture, source);
  const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_RUNTIME_SOURCE_CAPTURE: output };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, ['--import', preload, ...extraArgs, '-e', program.replaceAll('FIXTURE', JSON.stringify(fixture))],
    { env, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
  const rows = fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  // Preserve the failure discriminator before afterEach removes the receipt.
  onTestFailed(() => console.error('RUNTIME_SOURCE_CAPTURE_DIAGNOSTICS ' + JSON.stringify({
    error: result.error?.message, exitCode: result.status, signal: result.signal,
    lifecycle: rows.filter(row => row.kind !== 'source'),
  })));
  expect(result.error, result.stderr).toBeUndefined();
  return { result, rows, fixture, source, output };
}
describe('worker detach protocol evidence', () => {
  it.each(['Debugger.getScriptSource', 'Debugger.resume'])(
    'drains %s at natural worker exit before releasing the inspector context', pendingMethod => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-source-drain-')); roots.push(root);
      const output = path.join(root, 'sources.jsonl');
      let notify!: (message: {method: string; params: Record<string, unknown>}) => void;
      let finish!: (code: number) => void;
      let outstanding!: {id: number; method: string};
      const methods: string[] = [];
      let disconnectNotificationEnabled = false, detached = false;
      const notification = (method: string, params: Record<string, unknown> = {}) => notify({method, params});
      const workerMessage = (message: Record<string, unknown>) => notification('NodeWorker.receivedMessageFromWorker', {
        sessionId: 'worker-session', message: JSON.stringify(message),
      });
      const session = {
        connect() {}, disconnect() {},
        on(_event: string, listener: typeof notify) { notify = listener; },
        post(method: string, params: Record<string, unknown>, callback: (error: null, result: object) => void) {
          if (method === 'NodeWorker.detach') {
            detached = true;
            notification('NodeWorker.detachedFromWorker', {sessionId: 'worker-session'});
          }
          callback(null, method === 'Debugger.getScriptSource' ? {scriptSource: 'main source'} : {});
          if (method !== 'NodeWorker.sendMessageToWorker') return;
          const request = JSON.parse(String(params.message)); methods.push(request.method);
          if (request.method === 'NodeRuntime.notifyWhenWaitingForDisconnect')
            disconnectNotificationEnabled = request.params.enabled === true;
          if (request.method === pendingMethod) { outstanding = request; return; }
          workerMessage({id: request.id,
            result: request.method === 'Debugger.getScriptSource' ? {scriptSource: 'worker source'} : {}});
        },
      };
      const originalOnce = process.once.bind(process);
      const constructor = vi.spyOn(inspector, 'Session').mockImplementation(function () { return session; } as unknown as typeof inspector.Session);
      const once = vi.spyOn(process, 'once').mockImplementation(((event: string, listener: (...args: any[]) => void) => {
        if (event === 'exit') { finish = listener; return process; }
        return originalOnce(event, listener);
      }) as typeof process.once);
      try { startRuntimeSourceCapture(output); }
      finally { constructor.mockRestore(); once.mockRestore(); }
      try {
        notification('Debugger.scriptParsed', {scriptId: 'main-script', url: 'file:///main.js'});
        notification('NodeWorker.attachedToWorker', {sessionId: 'worker-session', waitingForDebugger: true,
          workerInfo: {workerId: 'worker', url: 'file:///worker.js'}});
        workerMessage({method: 'Debugger.scriptParsed', params: {scriptId: 'worker-script', url: 'file:///worker.js'}});
        workerMessage({method: 'Debugger.paused', params: {}});
        // Node retains the context at natural exit only when this notification
        // was enabled before execution. Otherwise outstanding calls are lost.
        if (disconnectNotificationEnabled) workerMessage({method: 'NodeRuntime.waitingForDisconnect', params: {}});
        else notification('NodeWorker.detachedFromWorker', {sessionId: 'worker-session'});
        expect(detached).toBe(false);
        expect(disconnectNotificationEnabled).toBe(true);
        expect(methods.indexOf('NodeRuntime.notifyWhenWaitingForDisconnect'))
          .toBeLessThan(methods.indexOf('Runtime.runIfWaitingForDebugger'));
        workerMessage({id: outstanding.id,
          result: pendingMethod === 'Debugger.getScriptSource' ? {scriptSource: 'worker source'} : {}});
        expect(detached).toBe(true);
      } finally { finish(0); }
      const rows = fs.readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows.at(-1)).toMatchObject({errors: 0, pending: 0, liveWorkers: 0});
      expect(validateRuntimeSourceCapture(rows, ['worker']).workerIds).toEqual(['worker']);
    });

  it.each(['Debugger.resume', 'Debugger.getScriptSource'])(
    'retains the outstanding %s method and source count without accepting incomplete evidence', pendingMethod => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-source-protocol-')); roots.push(root);
      const output = path.join(root, 'sources.jsonl');
      let notify!: (message: {method: string; params: Record<string, unknown>}) => void;
      let finish!: (code: number) => void;
      const notification = (method: string, params: Record<string, unknown>) => notify({method, params});
      const workerMessage = (message: Record<string, unknown>) => notification('NodeWorker.receivedMessageFromWorker', {
        sessionId: 'worker-session', message: JSON.stringify(message),
      });
      const session = {
        connect() {}, disconnect() {},
        on(_event: string, listener: typeof notify) { notify = listener; },
        post(method: string, params: Record<string, unknown>, callback: (error: null, result: object) => void) {
          callback(null, method === 'Debugger.getScriptSource' ? {scriptSource: 'main source'} : {});
          if (method !== 'NodeWorker.sendMessageToWorker') return;
          const request = JSON.parse(String(params.message));
          if (request.method !== pendingMethod) workerMessage({id: request.id,
            result: request.method === 'Debugger.getScriptSource' ? {scriptSource: 'worker source'} : {}});
        },
      };
      // Drive the recorder's actual protocol handler, not a manufactured receipt.
      // Capture only its own exit hook; never emit process.exit in the test runner.
      const originalOnce = process.once.bind(process);
      const constructor = vi.spyOn(inspector, 'Session').mockImplementation(function () { return session; } as unknown as typeof inspector.Session);
      const once = vi.spyOn(process, 'once').mockImplementation(((event: string, listener: (...args: any[]) => void) => {
        if (event === 'exit') { finish = listener; return process; }
        return originalOnce(event, listener);
      }) as typeof process.once);
      try { startRuntimeSourceCapture(output); }
      finally { constructor.mockRestore(); once.mockRestore(); }
      try {
        notification('Debugger.scriptParsed', {scriptId: 'main-script', url: 'file:///main.js'});
        notification('NodeWorker.attachedToWorker', {sessionId: 'worker-session', waitingForDebugger: true,
          workerInfo: {workerId: 'worker', url: 'file:///worker.js'}});
        workerMessage({method: 'Debugger.scriptParsed', params: {scriptId: 'worker-script', url: 'file:///worker.js'}});
        workerMessage({method: 'Debugger.paused', params: {}});
        notification('NodeWorker.detachedFromWorker', {sessionId: 'worker-session'});
      } finally { finish(0); }
      const rows = fs.readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const sourcePending = pendingMethod === 'Debugger.getScriptSource' ? 1 : 0;
      expect(rows.filter(row => row.kind === 'error')).toEqual([{kind: 'error', target: 'worker',
        message: 'worker detached with pending source/protocol requests: ' +
          JSON.stringify({methods: [pendingMethod], sources: sourcePending})}]);
      expect(rows.at(-1)).toMatchObject({errors: 1, pending: 1 + sourcePending, liveWorkers: 0});
      expect(() => validateRuntimeSourceCapture(rows)).toThrow('incomplete or failed');
    });
});

describe('actual runtime parsed-source capture', () => {
  it('captures a file worker with inherited preloads without reopening the parent receipt', () => {
    const { result, rows, fixture, source, output } = run(`
      (async () => {
        const fs = require('node:fs');
        const {Worker} = require('node:worker_threads');
        require(FIXTURE);
        const workerFile = FIXTURE + '.worker.cjs';
        fs.writeFileSync(workerFile, 'require(' + JSON.stringify(FIXTURE) + ');\\n');
        process.execArgv = ${JSON.stringify(['--import', preload, '--import', 'tsx'])};
        const worker = new Worker(workerFile);
        const exitCode = await new Promise((resolve, reject) => {
          worker.once('error', reject);
          worker.once('exit', resolve);
        });
        if (exitCode !== 0) process.exitCode = 1;
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `, ['--import', 'tsx']);
    expect(result.status, result.stderr).toBe(0);
    expect(rows.filter(row=>row.kind==='error')).toEqual([]);
    expect(rows.at(-1)).toMatchObject({exitCode:0,errors:0,pending:0});
    const processTerminal = {processId: rows[0].processId, exitCode: result.status!, signal: result.signal, eof: true as const};
    const receipt = validateRuntimeSourceCapture(rows, [], processTerminal);
    expect(rows.filter(row => row.kind === 'start')).toHaveLength(1);
    expect(receipt.workerIds.length).toBeGreaterThanOrEqual(1);
    const expectedHash = crypto.createHash('sha256').update(source).digest('hex');
    const loaded = rows.filter(row => row.kind === 'source' && row.url.endsWith(fixture));
    expect(loaded.map(row => row.target)).toContain('main');
    expect(loaded.some(row => row.target !== 'main')).toBe(true);
    expect(loaded.every(row => row.sha256 === expectedHash && row.bytes === Buffer.byteLength(source))).toBe(true);
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
  });

  it('binds source bytes in main and a real worker that clears inherited flags', () => {
    const { result, rows, fixture, source, output } = run(`
      require(FIXTURE);
      const {Worker} = require('node:worker_threads');
      const worker = new Worker('require(' + JSON.stringify(FIXTURE) + ')', {eval:true,execArgv:[]});
      worker.on('error', error => { throw error; });
    `);
    expect(result.status, result.stderr).toBe(0);
    const receipt = validateRuntimeSourceCapture(rows);
    expect(receipt.workerIds).toHaveLength(1);
    expect(receipt.completeRuntimeClosureVerified).toBe(false);
    const expectedHash = crypto.createHash('sha256').update(source).digest('hex');
    const loaded = rows.filter(row => row.kind === 'source' && row.url.endsWith(fixture));
    expect(loaded.map(row => row.target).sort()).toEqual(['main', receipt.workerIds[0]].sort());
    expect(loaded.every(row => row.sha256 === expectedHash && row.bytes === Buffer.byteLength(source))).toBe(true);
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    expect(() => validateRuntimeSourceCapture(rows, ['unobserved-worker'])).toThrow('expected worker');
    expect(() => validateRuntimeSourceCapture(rows.slice(0, -1))).toThrow('terminal');
    const omitted = rows.filter(row => row !== loaded[0]);
    expect(() => validateRuntimeSourceCapture(omitted)).toThrow('census');
  });

  it('retains forced exit as incomplete evidence when a worker has not terminated', () => {
    const { result, rows } = run(`
      const {Worker} = require('node:worker_threads');
      const worker = new Worker('require("node:worker_threads").parentPort.postMessage("ready");setInterval(()=>{},1000)',
        {eval:true,execArgv:[]});
      worker.on('message', () => process.exit(0));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(rows.at(-1).liveWorkers).toBeGreaterThan(0);
    expect(() => validateRuntimeSourceCapture(rows)).toThrow('worker census');
    expect(() => validateRuntimeSourceCapture(rows, [], {processId:rows[0].processId,exitCode:0,signal:null,eof:true})).toThrow('worker census');
  });

  it('closes the real Node ESM loader only with independent successful process termination', () => {
    const {result,rows} = run('require(FIXTURE)', ['--import','tsx']);
    expect(result.status,result.stderr).toBe(0);
    expect(rows.some(row=>row.kind==='worker-attached' && row.url==='node:internal/modules/esm/worker')).toBe(true);
    expect(() => validateRuntimeSourceCapture(rows)).toThrow('worker census');
    const proof={processId:rows[0].processId,exitCode:result.status!,signal:result.signal,eof:true as const};
    expect(validateRuntimeSourceCapture(rows,[],proof).workersClosedByProcessExit).toHaveLength(1);
    for (const bad of [{...proof,eof:false},{...proof,exitCode:1},{...proof,processId:1},{...proof,signal:'SIGTERM'}])
      expect(()=>validateRuntimeSourceCapture(rows,[],bad)).toThrow('worker census');
  });

  it('preserves target failures and refuses an existing receipt destination', () => {
    const { result, rows, output } = run('require(FIXTURE);throw new Error("retained target failure")');
    expect(result.status).not.toBe(0);
    expect(() => validateRuntimeSourceCapture(rows)).toThrow('failed');
    const before = fs.readFileSync(output);
    const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_RUNTIME_SOURCE_CAPTURE: output }; delete env.NODE_OPTIONS;
    const replay = spawnSync(process.execPath, ['--import', preload, '-e', ''], {env, encoding:'utf8', timeout:5000});
    expect(replay.status).not.toBe(0);
    expect(replay.stderr).toContain('EEXIST');
    expect(fs.readFileSync(output)).toEqual(before);
  });
});

describe('parsed sources joined to independent process lifetimes', () => {
  const terminal = {processId:10,exitCode:0,signal:null,eof:true,captureStartedBeforeExec:true};
  const trace = [
    '10 1.000000 execve("/usr/bin/node", ["node"], 0x1) = 0',
    '10 1.200000 fork() = 20',
    '20 1.300000 execve("/usr/bin/node", ["node"], 0x1) = 0',
    '20 1.800000 +++ exited with 0 +++',
    '10 2.000000 +++ exited with 0 +++',
  ].join('\n')+'\n';
  const capture = (processId: number, start: number, end: number) => [
    {kind:'start',schemaVersion:1,processId,executable:'/usr/bin/node',startedAt:new Date(start).toISOString()},
    {kind:'source',target:'main',scriptId:'1',url:'file:///input.js',sha256:'a'.repeat(64),bytes:10},
    {kind:'terminal',processId,exitCode:0,errors:0,pending:0,sources:1,workers:0,liveWorkers:0,
      finishedAt:new Date(end).toISOString()},
  ];
  const captures = () => [capture(10,1100,1900),capture(20,1400,1700)];
  function jitCapture(processId:number) {
    const header=Buffer.alloc(40), load=Buffer.alloc(59);
    header.writeUInt32LE(0x4a695444,0);header.writeUInt32LE(1,4);header.writeUInt32LE(40,8);
    header.writeUInt32LE(62,12);header.writeUInt32LE(processId,20);header.writeBigUInt64LE(100n,24);
    load.writeUInt32LE(59,4);load.writeBigUInt64LE(150n,8);
    load.writeUInt32LE(processId,16);load.writeUInt32LE(processId,20);
    load.writeBigUInt64LE(0x1000n,24);load.writeBigUInt64LE(0x1000n,32);
    load.writeBigUInt64LE(1n,40);load.writeBigUInt64LE(1n,48);load.write('f\0',56);load[58]=0xc3;
    return {bytes:Buffer.concat([header,load]),witness:{processId,taskIds:[processId],elfMachine:62,
      startedMonotonicNs:'90',finishedMonotonicNs:'200',startedEpochMs:900,finishedEpochMs:2100,
      exitCode:0,signal:null,eof:true,captureStartedBeforeExec:true}};
  }
  it.each(['positive','absent','empty','missing-process','duplicate','foreign','foreign-thread','missing-thread',
    'missing-clock','source-before','source-after','source-reversed','late-witness','early-witness',
    'architecture','altered-bytes','unretained-bytes'] as const)('joins retained JIT process bytes: %s', variant => {
    const rows: Record<string, any>[][]=captures();
    for(const capture of rows) {capture[0].monotonicNs='130';capture.at(-1)!.monotonicNs='190';}
    const jit=[jitCapture(20),jitCapture(10)];
    if(variant==='empty')jit.length=0;
    if(variant==='missing-process')jit.pop();
    if(variant==='duplicate')jit[1]=jit[0];
    if(variant==='foreign')jit[0]=jitCapture(30);
    if(variant==='foreign-thread')jit[0].witness.taskIds.push(10);
    if(variant==='missing-thread')jit[0].witness.taskIds=[];
    if(variant==='missing-clock')delete rows[0][0].monotonicNs;
    if(variant==='source-before')rows[0][0].monotonicNs='89';
    if(variant==='source-after')rows[0].at(-1)!.monotonicNs='201';
    if(variant==='source-reversed')rows[0][0].monotonicNs='191';
    if(variant==='late-witness')jit[0].witness.startedEpochMs=1301;
    if(variant==='early-witness')jit[0].witness.finishedEpochMs=1799;
    if(variant==='architecture')jit[0].witness.elfMachine=183;
    if(variant==='altered-bytes')jit[0].bytes[0]=0;
    if(variant==='unretained-bytes')jit[0].bytes=JSON.parse(JSON.stringify(jit[0].bytes));
    const bind=()=>bindRuntimeSourcePopulation(trace,terminal,rows,undefined,variant==='absent'?undefined:jit);
    if(variant!=='positive' && variant!=='absent') {expect(bind).toThrow();return;}
    const proof=bind();
    expect(proof.jitByteCapture).toBe(variant==='absent'?'not-observed':'runtime-reported-code-loads-for-traced-processes');
    expect(proof.jitBindings?.map(row=>row.processId)).toEqual(variant==='absent'?undefined:[20,10]);
    if(variant==='positive')for(const binding of proof.jitBindings!) {
      expect(binding.sourceCaptureSha256).toBe(crypto.createHash('sha256').update(JSON.stringify(
        rows.find(rows=>rows[0].processId===binding.processId))).digest('hex'));
      expect(binding.tracedTaskIds).toEqual([binding.processId]);
      expect(binding).toMatchObject({jitByteOriginQualification:'required',runtimeCaptureCustody:'required',
        executableMemoryQualification:'required',creatorFence:'required',completeRuntimeClosureVerified:false});
    }
    expect(proof.completeRuntimeClosureVerified).toBe(false);
    expect(proof.mappingOrigins.executableBytesQualified).toBe(false);
  });
  it.each(['positive','absent','null','missing-identity','foreign-process','foreign-parent','wrong-executable',
    'wrong-observer','before-source','after-source','changed-bytes','serialized-bytes','foreign-task',
    'unproven-summary'] as const)('joins retained selected JIT memory: %s', variant => {
    const rows: Record<string, any>[][]=captures();
    for(const capture of rows) {capture[0].monotonicNs='130';capture.at(-1)!.monotonicNs='190';}
    const jit: NonNullable<Parameters<typeof bindRuntimeSourcePopulation>[4]>=[jitCapture(20),jitCapture(10)];
    const launchIdentity={processId:20,parentProcessId:10,startTimeTicks:'42',executable:'/usr/bin/node'};
    const tasks=[{taskId:20,state:'T',startTimeTicks:'42'}];
    const maps='00001000-00002000 r-xp 00000000 00:00 0\n';
    jit[0].memory={launchIdentity,observation:{schema:'runtime-selected-executable-memory/v1',
      process:{...launchIdentity},observerProcessId:10,startedMonotonicNs:'160',finishedMonotonicNs:'170',
      tasksBefore:tasks,tasksAfter:structuredClone(tasks),mapsBefore:maps,mapsAfter:maps,
      samples:[{codeIndex:'1',address:'0x1000',bytes:Buffer.from([0xc3])}]}};
    const memory=jit[0].memory, observation=memory.observation;
    if(variant==='absent')delete jit[0].memory;
    if(variant==='null')jit[0].memory=null as any;
    if(variant==='missing-identity')delete (memory as any).launchIdentity;
    if(variant==='foreign-process')launchIdentity.processId=10;
    if(variant==='foreign-parent')launchIdentity.parentProcessId=30;
    if(variant==='wrong-executable')launchIdentity.executable='/other/node';
    if(variant==='wrong-observer')observation.observerProcessId=30;
    if(variant==='before-source')observation.startedMonotonicNs='129';
    if(variant==='after-source')observation.finishedMonotonicNs='191';
    if(variant==='changed-bytes')observation.samples[0].bytes[0]=0;
    if(variant==='serialized-bytes')observation.samples[0].bytes=JSON.parse(JSON.stringify(observation.samples[0].bytes));
    if(variant==='foreign-task')observation.tasksBefore[0].taskId=10;
    if(variant==='unproven-summary')jit[0].memory={selectedExecutableBytesVerified:true} as any;
    const bind=()=>bindRuntimeSourcePopulation(trace,terminal,rows,undefined,jit);
    if(variant!=='positive' && variant!=='absent'){expect(bind).toThrow();return;}
    const proof=bind();
    expect(proof.jitBindings![1].selectedMemory).toBeUndefined();
    expect(proof.completeRuntimeClosureVerified).toBe(false);
    if(variant==='absent'){expect(proof.jitBindings![0].selectedMemory).toBeUndefined();return;}
    expect(proof.jitBindings![0].selectedMemory).toMatchObject({processId:20,selectedExecutableBytesVerified:true,
      mappingPopulationComplete:false,executableBytesQualified:false,completeRuntimeClosureVerified:false,
      jitByteOriginQualification:'required',runtimeCaptureCustody:'required',creatorFence:'required',
      writableAliasQualification:'required',bindings:[{codeIndex:'1',address:'0x1000',bytes:1}]});
  });
  it('requires a separate source receipt for each observed process', () => {
    const result = bindRuntimeSourcePopulation(trace,terminal,captures());
    expect(result.processes.map(row=>row.processId)).toEqual([10,20]);
    expect(result.parsedSourceProcessPopulationComplete).toBe(true);
    expect(result.completeRuntimeClosureVerified).toBe(false);
    expect(result.dependencyQualification).toBe('required');
  });
  it('carries transient executable-memory evidence without qualifying its byte origin', () => {
    const observed = trace.replace('20 1.800000',
      '20 1.600000 mprotect(0x1000, 4096, PROT_READ|PROT_EXEC) = 0\n'
      + '20 1.700000 munmap(0x1000, 4096) = 0\n20 1.800000');
    const result = bindRuntimeSourcePopulation(observed, terminal, captures());
    expect(result.memoryTransitions).toMatchObject([
      {taskId:20, operation:'mprotect', executablePermissionRequested:true, succeeded:true},
      {taskId:20, operation:'munmap', succeeded:true},
    ]);
    expect(result.executableMemoryQualification).toBe('required');
    expect(result.mappingOrigins).toMatchObject({mappingPopulationComplete:false,
      executableBytesQualified:false, jitByteOriginQualification:'required'});
    expect(result.mappingOrigins.gaps).toContainEqual(expect.objectContaining({reason:'independent-host-page-size-required'}));
    expect(result.completeRuntimeClosureVerified).toBe(false);
    expect(result.creatorFence).toBe('required');
  });
  it('joins original file census bytes while keeping generated and runtime scripts explicit', () => {
    const rows=captures();
    rows[0].splice(2,0,{kind:'source',target:'main',scriptId:'2',url:'[eval]',sha256:'b'.repeat(64),bytes:7});
    rows[0].at(-1)!.sources=2;
    const files={root:'/',files:[{path:'input.js',kind:'file' as const,sha256:'a'.repeat(64)}]};
    const proof=bindRuntimeSourcePopulation(trace,terminal,rows,files);
    expect(proof.fileInputs?.bindings.map(row=>row.processId)).toEqual([10,20]);
    expect(proof.fileInputs?.unboundSources).toEqual([
      {processId:10,target:'main',scriptId:'2',url:'[eval]',sha256:'b'.repeat(64)},
    ]);
    expect(proof.fileInputs?.originalSourceQualification).toBe('required');
    expect(proof.completeRuntimeClosureVerified).toBe(false);
  });
  it.each(['changed-bytes','missing-child-input','duplicate','symlink','escape','relative-root','query','fragment','host','no-file'])(
    'refuses %s file evidence rather than treating a parsed URL as original-source authority', variant=>{
      const rows=captures();
      const files={root:'/',files:[{path:'input.js',kind:'file' as 'file'|'symlink',sha256:'a'.repeat(64)}]};
      if(variant==='changed-bytes') rows[1][1].sha256='b'.repeat(64);
      if(variant==='missing-child-input') rows[1][1].url='file:///unrecorded.js';
      if(variant==='duplicate') files.files.push({...files.files[0]});
      if(variant==='symlink') files.files[0].kind='symlink';
      if(variant==='escape') files.files[0].path='../input.js';
      if(variant==='relative-root') files.root='relative';
      if(variant==='query') rows[1][1].url+='?loader=1';
      if(variant==='fragment') rows[1][1].url+='#loaded';
      if(variant==='host') rows[1][1].url='file://localhost/input.js';
      if(variant==='no-file') for(const capture of rows) capture[1].url='[eval]';
      expect(()=>bindRuntimeSourcePopulation(trace,terminal,rows,files)).toThrow();
    });
  it.each(['missing-child','extra-child','duplicate','wrong-executable','reexec','fork-only',
    'early-start','late-terminal','invalid-time','failed-capture','incomplete-worker','missing-source'])(
    'refuses %s instead of extending parent evidence to unobserved code', variant => {
      const rows = captures(); let input = trace;
      if (variant === 'missing-child') rows.pop();
      if (variant === 'extra-child') rows.push(capture(30,1400,1700));
      if (variant === 'duplicate') rows[1]=rows[0];
      if (variant === 'wrong-executable') rows[1][0].executable='/other/node';
      if (variant === 'reexec') input=input.replace('20 1.800000',
        '20 1.600000 execve("/usr/bin/node", ["node"], 0x1) = 0\n20 1.800000');
      if (variant === 'fork-only') input=input.replace('20 1.300000 execve("/usr/bin/node", ["node"], 0x1) = 0\n','');
      if (variant === 'early-start') rows[1][0].startedAt=new Date(1000).toISOString();
      if (variant === 'late-terminal') rows[1][2].finishedAt=new Date(1900).toISOString();
      if (variant === 'invalid-time') rows[1][0].startedAt='unknown';
      if (variant === 'failed-capture') rows[1][2].errors=1;
      if (variant === 'incomplete-worker') rows[1][2].liveWorkers=1;
      if (variant === 'missing-source') rows[1].splice(1,1);
      expect(()=>bindRuntimeSourcePopulation(input,terminal,rows)).toThrow();
    });
  it.runIf(process.platform==='linux'&&process.arch==='x64')(
    'consumes actual source exec-entry evidence without excusing the earlier shell image', async () => {
      const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-source-entry-')); roots.push(root);
      const tracePath=path.join(root,'trace.log'), sourcePath=path.join(root,'sources.jsonl');
      const child=spawn('/usr/bin/strace',runtimeFileTraceArguments(tracePath,[process.execPath,
        '--import',preload,'-e','process.stdin.resume();process.stdout.write("ready\\n");'+
        'process.stdin.once("data",()=>process.stdin.pause());'],{execEntryDelayMs:5000}),
      {env:{PATH:'/usr/bin:/bin',PAPERCUSP_RUNTIME_SOURCE_CAPTURE:sourcePath},stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='';
      child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
      const closed=new Promise<{code:number|null,signal:NodeJS.Signals|null}>((resolve,reject)=>{
        child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
      });
      void closed.catch(()=>{});
      const deadline=Date.now()+15000;
      const until=async(check:()=>boolean,label:string)=>{
        while(!check()){
          if(Date.now()>deadline)throw Error(label+' timeout: '+stderr);
          await new Promise(resolve=>setTimeout(resolve,5));
        }
      };
      let identity:ReturnType<typeof observeRuntimeProcessIdentity>|undefined;
      let tracer:ReturnType<typeof observeRuntimeTracerIdentity>|undefined;
      const tracerAlive=()=>{
        if(!tracer)return false;
        return isRuntimeProcessAlive(tracer);
      };
      try{
        await until(()=>{
          try{
            const candidate=observeRuntimeProcessIdentity(child.pid!);
            if(candidate.executable!==process.execPath)return false;
            tracer=observeRuntimeTracerIdentity(candidate,'/usr/bin/strace');identity=candidate;return true;
          }catch{return false;}
        },'source exec entry');
        process.kill(tracer!.processId,'SIGSTOP');
        await until(()=>fs.readFileSync('/proc/'+tracer!.processId+'/stat','utf8').split(') ')[1].startsWith('T '),
          'source entry tracer stop');
        expect(tracer!.parentProcessId).not.toBe(process.pid);
        expect(tracerAlive()).toBe(true);
        const observation=observeRuntimeExecEntry(identity!,tracer!);
        const entry=bindRuntimeExecEntry(observation,identity!,tracer!);
        expect(stdout).toBe('');expect(fs.existsSync(sourcePath)).toBe(false);
        process.kill(tracer!.processId,'SIGCONT');
        await until(()=>stdout.includes('ready\n'),'source entry program readiness');
        child.stdin.end('finish\n');
        const outcome=await closed;expect(outcome,stderr).toEqual({code:0,signal:null});
        if(outcome.code!==0||outcome.signal!==null)throw Error('source entry process failed');
        await until(()=>!tracerAlive(),'source entry tracer termination');
        const trace=fs.readFileSync(tracePath,'utf8');
        const rows=fs.readFileSync(sourcePath,'utf8').trim().split('\n').map(line=>JSON.parse(line));
        const terminal={processId:identity!.processId,exitCode:outcome.code,signal:outcome.signal,
          eof:true,captureStartedBeforeExec:true,pageSizeBytes:observeRuntimePageSize(),
          execEntries:[{observation,identity:identity!,tracerIdentity:tracer!}]};
        const tree=bindRuntimeProcessTree(trace,terminal);
        const task=tree.tasks.find(task=>task.taskId===identity!.processId)!;
        expect(task.execs.map(exec=>exec.executable)).toEqual(['/bin/sh',process.execPath]);
        const seeded=tree.mappingOrigins.changes.filter(change=>change.operation==='exec-entry-snapshot');
        expect(seeded).toHaveLength(1);expect(seeded[0].atMs).toBe(task.execs[1].atMs);
        expect(seeded[0].ranges.every(range=>range.origin.execEntryMapsSha256===entry.mapsSha256)).toBe(true);
        expect(tree.mappingOrigins.gaps).toContainEqual({taskId:task.taskId,atMs:task.execs[0].atMs,
          reason:'exec-kernel-installed-mappings-unobserved'});
        expect(tree.mappingOrigins.gaps).not.toContainEqual({taskId:task.taskId,atMs:task.execs[1].atMs,
          reason:'exec-kernel-installed-mappings-unobserved'});
        expect(validateRuntimeSourceCapture(rows,[],terminal).parsedSourcePopulationComplete).toBe(true);
        // A valid final-image V8 receipt does not cover the preceding shell.
        expect(()=>bindRuntimeSourcePopulation(trace,terminal,[rows])).toThrow('process image missing, replaced or mismatched');
        expect(tree.mappingOrigins).toMatchObject({mappingPopulationComplete:false,executableBytesQualified:false});
        expect(tree.completeRuntimeClosureVerified).toBe(false);
        const changed={...observation,mapsAfter:observation.mapsAfter+'\n'};
        expect(()=>bindRuntimeProcessTree(trace,{...terminal,execEntries:[{...terminal.execEntries[0],observation:changed}]})).toThrow();
        const out=process.env.PAPERCUSP_TEST_ARTIFACT_DIR;
        if(out){
          fs.writeFileSync(path.join(out,'source-entry-observation.json'),JSON.stringify({observation,identity,tracerIdentity:tracer}));
          fs.writeFileSync(path.join(out,'source-entry-trace.log'),trace);
          fs.writeFileSync(path.join(out,'source-entry-sources.jsonl'),fs.readFileSync(sourcePath));
          fs.writeFileSync(path.join(out,'source-entry-binding.json'),JSON.stringify({entry,tree}));
        }
      }finally{
        if(tracerAlive())process.kill(tracer!.processId,'SIGCONT');
        child.kill('SIGCONT');child.kill('SIGKILL');await closed.catch(()=>{});
        if(tracerAlive())process.kill(tracer!.processId,'SIGKILL');
      }
    },20000);
  async function captureTracedSourceMemory(qualified: boolean) {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-source-memory-')); roots.push(root);
    const tracePath=path.join(root,'trace.log'), sourcePath=path.join(root,'sources.jsonl');
    const startedEpochMs=Date.now(), startedMonotonicNs=process.hrtime.bigint().toString();
    const child=spawn('/usr/bin/strace',['-D',...runtimeFileTraceArguments(tracePath,[process.execPath,
      '--perf-prof','--perf-prof-path='+root,'--allow-natives-syntax','--import',preload,'-e',
      'function sourceMemoryTarget(x){return x*3+1};%PrepareFunctionForOptimization(sourceMemoryTarget);'+
      'for(let i=0;i<10000;i++)sourceMemoryTarget(i);%OptimizeFunctionOnNextCall(sourceMemoryTarget);'+
      'if(sourceMemoryTarget(4)!==13)process.exit(2);process.stdin.resume();process.stdout.write("ready\\n");'+
      'process.stdin.once("data",()=>process.stdin.pause());'])],
      {env:{PATH:'/usr/bin:/bin',PAPERCUSP_RUNTIME_SOURCE_CAPTURE:sourcePath},stdio:['pipe','pipe','pipe']});
    let stderr='', states:{taskId:number,state:string,tracerPid:number}[]=[];
    let tracerIdentity: ReturnType<typeof observeRuntimeTracerIdentity>|undefined, tracerStopped=false;
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    const closed=new Promise<{code:number|null,signal:string|null}>((resolve,reject)=>{
      child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
    });
    onTestFailed(()=>{
      const diagnostic={processId:child.pid,states,stderr};
      console.error('RUNTIME_SOURCE_MEMORY_DIAGNOSTICS '+JSON.stringify(diagnostic));
      const out=process.env.PAPERCUSP_TEST_ARTIFACT_DIR;
      if(out){
        fs.writeFileSync(path.join(out,'source-memory-diagnostics.json'),JSON.stringify(diagnostic));
        for(const file of ['trace.log','sources.jsonl'])if(fs.existsSync(path.join(root,file)))
          fs.copyFileSync(path.join(root,file),path.join(out,'source-memory-'+file));
      }
    });
    try {
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('source-memory ready timeout: '+stderr)),10000);
        child.stdout.once('data',()=>{clearTimeout(timer);resolve();});
        child.once('error',error=>{clearTimeout(timer);reject(error);});
      });
      const launchIdentity=observeRuntimeProcessIdentity(child.pid!);
      if(qualified){
        expect(()=>observeRuntimeTracerIdentity(launchIdentity,process.execPath)).toThrow('unexpected tracer executable');
        tracerIdentity=observeRuntimeTracerIdentity(launchIdentity,'/usr/bin/strace');
      }
      expect(child.kill('SIGSTOP')).toBe(true);
      const deadline=Date.now()+5000;
      do {
        states=fs.readdirSync('/proc/'+child.pid+'/task').map(id=>{
          const status=fs.readFileSync('/proc/'+child.pid+'/task/'+id+'/status','utf8');
          return {taskId:Number(id),state:/^State:\s+(\w)/m.exec(status)![1],
            tracerPid:Number(/^TracerPid:\s+(\d+)/m.exec(status)![1])};
        });
        if(states.length&&states.every(task=>task.state==='t'&&task.tracerPid>0))break;
        if(Date.now()>deadline)throw new Error('source-memory direct child did not ptrace-stop: '+JSON.stringify(states));
        await new Promise(resolve=>setTimeout(resolve,10));
      } while(true);
      const dumpPath=path.join(root,'jit-'+child.pid+'.dump'), prefix=fs.readFileSync(dumpPath);
      const loads:{codeIndex:string,address:string,size:number,name:string}[]=[];
      for(let offset=40;offset+16<=prefix.length;){
        const size=prefix.readUInt32LE(offset+4);if(size<16||offset+size>prefix.length)break;
        if(prefix.readUInt32LE(offset)===0){const end=prefix.indexOf(0,offset+56);
          loads.push({codeIndex:prefix.readBigUInt64LE(offset+48).toString(),
            address:'0x'+prefix.readBigUInt64LE(offset+32).toString(16),
            size:Number(prefix.readBigUInt64LE(offset+40)),name:prefix.subarray(offset+56,end).toString()});}
        offset+=size;
      }
      const target=loads.filter(load=>load.name.includes('sourceMemoryTarget')).at(-1);expect(target).toBeDefined();
      expect(new Set(states.map(task=>task.tracerPid)).size).toBe(1);
      // A ptrace stop is not the independent group-stop contract. Require an
      // explicit tracer witness before that observation can ever qualify.
      expect(()=>observeRuntimeExecutableMemory(launchIdentity,[target!])).toThrow('task is not group-stopped');
      let observation: ReturnType<typeof observeRuntimeExecutableMemory>|undefined;
      if(tracerIdentity){
        expect(()=>observeRuntimeExecutableMemory(launchIdentity,[target!],tracerIdentity)).toThrow('task is not group-stopped');
        process.kill(tracerIdentity.processId,'SIGSTOP');tracerStopped=true;
        const tracerDeadline=Date.now()+5000;
        while(!fs.readdirSync('/proc/'+tracerIdentity.processId+'/task').every(id=>
          fs.readFileSync('/proc/'+tracerIdentity!.processId+'/task/'+id+'/stat','utf8').split(') ')[1].startsWith('T '))){
          if(Date.now()>tracerDeadline)throw new Error('independent tracer did not group-stop');
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        expect(()=>observeRuntimeExecutableMemory(launchIdentity,[target!],{...tracerIdentity!,startTimeTicks:'1'}))
          .toThrow('tracer identity changed');
        observation=observeRuntimeExecutableMemory(launchIdentity,[target!],tracerIdentity);
        expect(observation.tracer!.process).toEqual(tracerIdentity);
        expect(observation.tasksBefore.every(task=>task.state==='t'&&task.tracerProcessId===tracerIdentity!.processId)).toBe(true);
        process.kill(tracerIdentity.processId,'SIGCONT');tracerStopped=false;
      }
      child.kill('SIGCONT');child.stdin.end('finish\n');
      const terminal=await closed;expect(terminal,stderr).toEqual({code:0,signal:null});
      const trace=fs.readFileSync(tracePath,'utf8'), sources=fs.readFileSync(sourcePath,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      const processTerminal={processId:child.pid!,exitCode:terminal.code!,signal:terminal.signal,
        eof:true,captureStartedBeforeExec:true,pageSizeBytes:observeRuntimePageSize()};
      const tree=bindRuntimeProcessTree(trace,processTerminal), elf=fs.readFileSync(process.execPath).subarray(0,20);
      const capture={bytes:fs.readFileSync(dumpPath),witness:{...processTerminal,
        taskIds:tree.tasks.map(task=>task.taskId),elfMachine:elf[5]===1?elf.readUInt16LE(18):elf.readUInt16BE(18),
        startedEpochMs,startedMonotonicNs,finishedEpochMs:Date.now(),finishedMonotonicNs:process.hrtime.bigint().toString(),
        headerClock:'v8-realtime-microseconds' as const},
        ...(observation?{memory:{observation,launchIdentity,tracerIdentity}}:{})};
      const proof=bindRuntimeSourcePopulation(trace,processTerminal,[sources],undefined,[capture]);
      if(qualified){
        expect(proof.jitBindings![0].selectedMemory).toMatchObject({selectedExecutableBytesVerified:true,
          completeRuntimeClosureVerified:false,runtimeCaptureCustody:'required',jitByteOriginQualification:'required'});
        const changed={...capture,memory:{...capture.memory!,tracerIdentity:{...tracerIdentity!,startTimeTicks:'1'}}};
        expect(()=>bindRuntimeSourcePopulation(trace,processTerminal,[sources],undefined,[changed]))
          .toThrow('independent stopped tracer differs');
      }else expect(proof.jitBindings![0].selectedMemory).toBeUndefined();
      expect(proof.completeRuntimeClosureVerified).toBe(false);
      if(process.env.PAPERCUSP_TEST_ARTIFACT_DIR){const out=process.env.PAPERCUSP_TEST_ARTIFACT_DIR;
        fs.writeFileSync(path.join(out,'source-memory-trace.log'),trace);
        fs.writeFileSync(path.join(out,'source-memory-sources.jsonl'),fs.readFileSync(sourcePath));
        fs.writeFileSync(path.join(out,'source-memory-jit.dump'),capture.bytes);
        if(observation)fs.writeFileSync(path.join(out,'source-memory-observation.json'),JSON.stringify(observation));
        fs.writeFileSync(path.join(out,'source-memory-traced-stop.json'),JSON.stringify({states,launchIdentity,witness:capture.witness}));}
    } finally {
      if(tracerStopped&&tracerIdentity){
        // Only resume the exact pinned tracer; never signal a reused PID.
        try{
          const current=observeRuntimeTracerIdentity(observeRuntimeProcessIdentity(child.pid!),'/usr/bin/strace');
          if(JSON.stringify(current)===JSON.stringify(tracerIdentity))process.kill(tracerIdentity.processId,'SIGCONT');
        }catch{}
      }
      if(child.exitCode===null){child.kill('SIGCONT');child.kill('SIGKILL');}
      await closed;
    }
  }
  it.runIf(process.platform==='linux')('refuses ptrace stops as group-stopped executable memory while retaining traced sources',
    ()=>captureTracedSourceMemory(false),30000);
  it.runIf(process.platform==='linux')('joins actual traced source executable memory with an independent stopped tracer',
    ()=>captureTracedSourceMemory(true),30000);
  it.runIf(process.platform==='linux')('captures a real Node subprocess and refuses a child that removes instrumentation', () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-source-process-')); roots.push(root);
    const fixture=path.join(root,'input.cjs'); fs.writeFileSync(fixture,'module.exports=42;\n');
    const env:NodeJS.ProcessEnv={...process.env,PAPERCUSP_RUNTIME_SOURCE_CAPTURE:path.join(root,'source-%p.jsonl')};
    delete env.NODE_OPTIONS;
    const pageSizeBytes = observeRuntimePageSize();
    const elf=Buffer.alloc(20), fd=fs.openSync(process.execPath,'r');
    try {expect(fs.readSync(fd,elf,0,20,0)).toBe(20);}finally{fs.closeSync(fd);}
    const elfMachine=elf[5]===1?elf.readUInt16LE(18):elf.readUInt16BE(18);
    const jitArgs=['--perf-prof','--perf-prof-path='+root];
    const runChild=(instrumented:boolean)=> {
      const tracePath=path.join(root,instrumented?'traced.log':'uncaptured.log');
      const startedEpochMs=Date.now(), startedMonotonicNs=process.hrtime.bigint().toString();
      const child=spawnSync('/usr/bin/strace',runtimeFileTraceArguments(tracePath,[process.execPath,...jitArgs,'--import',preload,'-e',`
        require(${JSON.stringify(fixture)});
        const {spawnSync}=require('node:child_process');
        const child=spawnSync(process.execPath,${JSON.stringify(instrumented?[...jitArgs,'--import',preload]:[])}.concat(
          ['-e',${JSON.stringify('require('+JSON.stringify(fixture)+')')}]),{stdio:'inherit'});
        if(child.status!==0)process.exit(1);process.stdout.write(String(process.pid));
      `]),{env,encoding:'utf8',timeout:20_000,maxBuffer:1024*1024});
      const finishedMonotonicNs=process.hrtime.bigint().toString(), finishedEpochMs=Date.now();
      expect(child.status,child.stderr).toBe(0);
      const rows=fs.readdirSync(root).filter(file=>/^source-\d+\.jsonl$/.test(file)).map(file=>
        fs.readFileSync(path.join(root,file),'utf8').trim().split('\n').map(line=>JSON.parse(line)));
      const text=fs.readFileSync(tracePath,'utf8'), proof={...terminal,pageSizeBytes,processId:Number(child.stdout)};
      const tree=bindRuntimeProcessTree(text,proof);
      const jitCaptures=instrumented?rows.map(rows=>({bytes:fs.readFileSync(path.join(root,'jit-'+rows[0].processId+'.dump')),
        witness:{...proof,processId:rows[0].processId,elfMachine,
          taskIds:tree.tasks.filter(task=>task.threadGroupId===rows[0].processId).map(task=>task.taskId),
          startedEpochMs,finishedEpochMs,startedMonotonicNs,finishedMonotonicNs,
          headerClock:'v8-realtime-microseconds' as const}})):undefined;
      return {text,proof,rows,jitCaptures};
    };
    const observed=runChild(true);
    const result=bindRuntimeSourcePopulation(observed.text,observed.proof,observed.rows,undefined,observed.jitCaptures);
    expect(result.processes).toHaveLength(2);
    expect(result.jitBindings).toHaveLength(2);
    expect(result.jitBindings!.every(binding=>binding.loads.length>0 && binding.runtimeCaptureCustody==='required')).toBe(true);
    expect(result.mappingOrigins.pageSizeBytes).toBe(pageSizeBytes);
    expect(result.mappingOrigins.gaps.some(gap => gap.reason === 'independent-host-page-size-required')).toBe(false);
    const originalFiles=[preload,fileURLToPath(new URL('./runtime-file-opens.mjs',import.meta.url)),fixture];
    const fileInputs={root:'/',files:originalFiles.map(file=>({path:file.slice(1),kind:'file' as const,
      sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}))};
    const bound=bindRuntimeSourcePopulation(observed.text,observed.proof,observed.rows,fileInputs);
    expect(bound.fileInputs?.bindings.filter(row=>row.path===fixture.slice(1))).toHaveLength(2);
    expect(bound.fileInputs?.unboundSources.some(row=>row.url==='[eval]')).toBe(true);
    fileInputs.files.find(row=>row.path===fixture.slice(1))!.sha256='0'.repeat(64);
    expect(()=>bindRuntimeSourcePopulation(observed.text,observed.proof,observed.rows,fileInputs)).toThrow('original file census');
    for(const rows of observed.rows) {
      expect(rows.some(row=>row.kind==='source' && row.url.endsWith(fixture))).toBe(true);
      const output=path.join(root,'source-'+rows[0].processId+'.jsonl');
      expect(fs.statSync(output).mode&0o777).toBe(0o600); fs.unlinkSync(output);
    }
    const missing=runChild(false);
    expect(missing.rows).toHaveLength(1);
    expect(()=>bindRuntimeSourcePopulation(missing.text,missing.proof,missing.rows)).toThrow('population');
  });
});
