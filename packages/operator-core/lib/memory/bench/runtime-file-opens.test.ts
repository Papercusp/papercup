import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import { bindRuntimeModelOpens, bindRuntimeProcessTree, runtimeFileTraceArguments } from './runtime-file-opens.mjs';

const options = { processId: 10, assets: [{path:'/model/config.json'}, {path:'/model/model.onnx'}], beforeEpochMs: 2000 };
const lines = [
  '10 1.000000 execve("/usr/bin/node", ["node"], 0x1 /* 1 var */) = 0',
  '10 1.100000 clone(child_stack=NULL, flags=CLONE_VM|CLONE_THREAD) = 11',
  '11 1.200000 openat(AT_FDCWD, "/model/config.json", O_RDONLY|O_CLOEXEC) = 4</model/config.json>',
  '11 1.300000 openat(AT_FDCWD, "/model/model.onnx", O_RDONLY|O_CLOEXEC) = 5</model/model.onnx>',
  '11 2.200000 +++ exited with 0 +++', '10 2.300000 +++ exited with 0 +++',
];
describe('model opens from the actual traced runtime', () => {
  it.runIf(process.platform==='linux')('retains real exec, successful opens and terminal records with the launcher arguments', () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-model-open-'));
    try {
      const file=path.join(root,'model-fixture.json'), trace=path.join(root,'trace.log');
      fs.writeFileSync(file,'{}');
      const env={...process.env}; delete env.NODE_OPTIONS;
      const child=spawnSync('/usr/bin/strace',runtimeFileTraceArguments(trace,[process.execPath,'-e',
        'require("node:fs").readFileSync('+JSON.stringify(file)+');process.stdout.write(String(process.pid));']),
        {env,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
      expect(child.status,child.stderr).toBe(0);
      expect(bindRuntimeModelOpens(fs.readFileSync(trace,'utf8'),
        {processId:Number(child.stdout),assets:[{path:file}],beforeEpochMs:Date.now()+1}).modelFilesOpenedBeforeInference).toBe(true);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });

  it('joins the target task lineage and resolved successful opens before inference', () => {
    expect(bindRuntimeModelOpens(lines.join('\n'), options)).toMatchObject({
      tasks:[10,11], modelFilesOpenedBeforeInference:true, modelBytesReadVerified:false,
      opens:[{path:'/model/config.json',taskId:11},{path:'/model/model.onnx',taskId:11}],
    });
  });
  it('keeps annotated character-device descriptors outside the declared model population', () => {
    const captured=[...lines];
    captured.splice(3,0,'11 1.250000 openat(AT_FDCWD, "/dev/null", O_RDONLY|O_CLOEXEC) = 6</dev/null<char 1:3>>');
    expect(bindRuntimeModelOpens(captured.join('\n'),options).opens).toHaveLength(2);
  });
  it('reassembles interleaved unfinished/resumed syscalls', () => {
    const split = [...lines]; split.splice(3, 1,
      '11 1.300000 openat(AT_FDCWD, "/model/model.onnx", O_RDONLY|O_CLOEXEC <unfinished ...>',
      '10 1.350000 openat(AT_FDCWD, "/other", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '11 1.400000 <... openat resumed>) = 5</model/model.onnx>');
    expect(bindRuntimeModelOpens(split.join('\n'), options).opens).toHaveLength(2);
  });
  it.each(['missing','failed','foreign','late','unresolved','truncated','no-exec','no-exit'])('refuses %s evidence', variant => {
    const altered = [...lines];
    if (variant === 'missing') altered.splice(3,1);
    if (variant === 'failed') altered[3] = '11 1.300000 openat(AT_FDCWD, "/model/model.onnx", O_RDONLY) = -1 ENOENT (No such file or directory)';
    if (variant === 'foreign') altered[3] = altered[3].replace(/^11/, '99');
    if (variant === 'late') altered[3] = altered[3].replace('1.300000', '2.100000');
    if (variant === 'unresolved') altered[3] = altered[3].replace('5</model/model.onnx>', '5');
    if (variant === 'truncated') altered[3] = '11 1.300000 openat(AT_FDCWD, "/model/model.onnx", O_RDONLY <unfinished ...>';
    if (variant === 'no-exec') altered.shift();
    if (variant === 'no-exit') altered.pop();
    expect(() => bindRuntimeModelOpens(altered.join('\n'), options)).toThrow();
  });
});

describe('exec-to-EOF process and thread population', () => {
  const terminal = { processId: 10, exitCode: 0, signal: null, eof: true, captureStartedBeforeExec: true };
  const trace = () => lines.join('\n') + '\n';
  it('keeps threads distinct from process roots and excludes argv secrets', () => {
    const receipt = bindRuntimeProcessTree(trace().replace('["node"]', '["node", "secret-value"]'), terminal);
    expect(receipt.tasks).toMatchObject([
      { taskId: 10, threadGroupId: 10, parentTaskId: null, execs: [{executable:'/usr/bin/node'}] },
      { taskId: 11, threadGroupId: 10, parentTaskId: 10, execs: [] },
    ]);
    expect(receipt.completeRuntimeClosureVerified).toBe(false);
    expect(receipt.sourceQualification).toBe('required');
    expect(JSON.stringify(receipt)).not.toContain('secret-value');
  });
  it.each(['fork()', 'vfork()', 'clone(child_stack=NULL, flags=SIGCHLD)',
    'clone3({flags=CLONE_VM|CLONE_VFORK, exit_signal=SIGCHLD}, 88)'])('follows short-lived %s process births', call => {
    const input = [...lines];
    input.splice(4, 0, `10 1.400000 ${call} = 12`,
      '12 1.500000 execveat(AT_FDCWD, "/usr/bin/true", ["true"], 0x1, 0) = 0',
      '12 1.600000 +++ exited with 0 +++');
    const receipt = bindRuntimeProcessTree(input.join('\n') + '\n', terminal);
    expect(receipt.tasks[2]).toMatchObject({taskId:12,threadGroupId:12,parentTaskId:10,
      execs:[{executable:'/usr/bin/true'}],terminalAtMs:1600});
  });
  it('reconciles resumed births even when child output arrives first', () => {
    const input = [...lines];
    input.splice(1, 1, '10 1.100000 clone(child_stack=NULL, flags=CLONE_VM|CLONE_THREAD <unfinished ...>',
      '11 1.150000 openat(AT_FDCWD, "/other", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '10 1.160000 <... clone resumed>) = 11');
    expect(bindRuntimeProcessTree(input.join('\n') + '\n', terminal).tasks).toHaveLength(2);
  });
  it('retains transient executable permissions, remaps, unmaps and unsuccessful attempts', () => {
    const input = [...lines];
    input.splice(4, 0,
      '11 1.400000 mmap(NULL, 4096, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0x1000',
      '11 1.500000 mprotect(0x1000, 4096, PROT_READ|PROT_EXEC <unfinished ...>',
      '10 1.510000 openat(AT_FDCWD, "/other", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '11 1.520000 <... mprotect resumed>) = 0',
      '11 1.600000 pkey_mprotect(0x1000, 4096, PROT_READ, 0) = 0',
      '11 1.700000 mremap(0x1000, 4096, 8192, MREMAP_MAYMOVE) = 0x3000',
      '11 1.800000 munmap(0x3000, 8192) = 0',
      '11 1.900000 mprotect(0x1000, 4096, PROT_EXEC) = -1 ENOMEM (Cannot allocate memory)',
      '10 2.000000 shmat(3, NULL, SHM_EXEC) = 0x5000',
      '10 2.010000 remap_file_pages(0x5000, 4096, 0, 0, 0) = 0',
      '10 2.020000 shmdt(0x5000) = 0');
    const receipt = bindRuntimeProcessTree(input.join('\n') + '\n', terminal);
    expect(receipt.memoryTransitions).toHaveLength(9);
    expect(receipt.memoryTransitions[1]).toMatchObject({taskId:11, operation:'mprotect',
      succeeded:true, executablePermissionRequested:true, atMs:1500, completedAtMs:1520});
    expect(receipt.memoryTransitions[2]).toMatchObject({operation:'pkey_mprotect', executablePermissionRequested:false});
    expect(receipt.memoryTransitions[3]).toMatchObject({operation:'mremap', executablePermissionRequested:null});
    expect(receipt.memoryTransitions[5]).toMatchObject({operation:'mprotect', succeeded:false});
    expect(receipt.memoryTransitions[6]).toMatchObject({operation:'shmat', executablePermissionRequested:null});
    expect(receipt.executableMemoryQualification).toBe('required');
    expect(receipt.completeRuntimeClosureVerified).toBe(false);
    const mask = runtimeFileTraceArguments('/trace', ['/program']).join(' ');
    for (const {operation} of receipt.memoryTransitions) expect(mask).toContain(operation);
  });
  it.each(['?', '0x1000...', '1', '-1 UNKNOWN...', '0 (INJECTED)'])(
    'refuses an unresolved successful memory outcome %s', result => {
      const input = [...lines];
      input.splice(4, 0, '11 1.400000 mprotect(0x1000, 4096, PROT_EXEC) = ' + result);
      expect(() => bindRuntimeProcessTree(input.join('\n') + '\n', terminal))
        .toThrow('memory transition outcome unresolved');
    });
  it.runIf(process.platform === 'linux')('retains a real anonymous executable mapping removed before exit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-executable-memory-'));
    try {
      const source = path.join(root, 'mapping.c'), binary = path.join(root, 'mapping'), output = path.join(root, 'trace.log');
      fs.writeFileSync(source, `#define _GNU_SOURCE
#include <sys/mman.h>
#include <unistd.h>
#include <stdio.h>
int main(void) {
  long page = sysconf(_SC_PAGESIZE);
  if (page <= 0) return 1;
  void *p = mmap(NULL, page, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);
  if (p == MAP_FAILED || mprotect(p, page, PROT_READ|PROT_EXEC) != 0) return 2;
  if (mprotect(p, page, PROT_READ|PROT_WRITE) != 0) return 3;
  p = mremap(p, page, page * 2, MREMAP_MAYMOVE);
  if (p == MAP_FAILED || munmap(p, page * 2) != 0) return 4;
  printf("%d", getpid());
  return 0;
}
`);
      const env = {...process.env}; delete env.NODE_OPTIONS;
      const compile = spawnSync('/usr/bin/cc', [source, '-o', binary], {env, encoding:'utf8', timeout:10_000});
      expect(compile.error).toBeUndefined();
      expect(compile.status, compile.stderr).toBe(0);
      const child = spawnSync('/usr/bin/strace', runtimeFileTraceArguments(output, [binary]),
        {env, encoding:'utf8', timeout:10_000, maxBuffer:1024*1024});
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const receipt = bindRuntimeProcessTree(fs.readFileSync(output, 'utf8'), {
        ...terminal, processId:Number(child.stdout), exitCode:child.status!, signal:child.signal,
      });
      const executable = receipt.memoryTransitions.find(row => row.operation === 'mprotect'
        && row.succeeded && row.executablePermissionRequested);
      expect(executable).toBeDefined();
      const address = executable!.arguments.split(',')[0]!;
      expect(receipt.memoryTransitions.some(row => row.operation === 'mremap'
        && row.succeeded && row.arguments.startsWith(address + ','))).toBe(true);
      const remap = receipt.memoryTransitions.find(row => row.operation === 'mremap')!;
      expect(receipt.memoryTransitions.some(row => row.operation === 'munmap'
        && row.succeeded && row.arguments.startsWith(remap.result + ','))).toBe(true);
      expect(receipt.executableMemoryQualification).toBe('required');
      expect(receipt.completeRuntimeClosureVerified).toBe(false);
    } finally { fs.rmSync(root, {recursive:true, force:true}); }
  });
  it.each(['root-exit', 'thread-exit', 'orphan', 'signal', 'failed-child', 'duplicate-birth',
    'unknown-flags', 'unresolved-exec', 'truncated', 'after-exit', 'no-exec', 'unknown-birth'])(
    'refuses %s instead of certifying a partial task population', variant => {
      const input = [...lines];
      if (variant === 'root-exit') input.pop();
      if (variant === 'thread-exit') input.splice(4,1);
      if (variant === 'orphan') input.splice(3,0,'99 1.200000 exit_group(0) = ?');
      if (variant === 'signal') input[4] = '11 2.200000 +++ killed by SIGKILL +++';
      if (variant === 'failed-child') input[4] = '11 2.200000 +++ exited with 1 +++';
      if (variant === 'duplicate-birth') input.splice(2,0,input[1]);
      if (variant === 'unknown-flags') input[1] = '10 1.100000 clone3({...}, 88) = 11';
      if (variant === 'unresolved-exec') input[0] = '10 1.000000 execve("/usr/bin/node"..., [], 0x1) = 0';
      if (variant === 'truncated') input[3] += ' <unfinished ...>';
      if (variant === 'after-exit') input.push('11 2.400000 openat(AT_FDCWD, "/other", O_RDONLY) = -1 ENOENT');
      if (variant === 'no-exec') input.shift();
      if (variant === 'unknown-birth') input[1] = '10 1.100000 clone(child_stack=NULL, flags=CLONE_THREAD) = ?';
      expect(() => bindRuntimeProcessTree(input.join('\n') + '\n', terminal)).toThrow();
    });
  it.each([{eof:false},{exitCode:1},{signal:'SIGTERM'},{captureStartedBeforeExec:false},{processId:99}])(
    'requires the independent launcher terminal witness %j', delta => {
      expect(() => bindRuntimeProcessTree(trace(), {...terminal,...delta})).toThrow();
    });
  it.runIf(process.platform === 'linux')('observes a real short-lived subprocess and a worker with cleared flags', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-process-tree-'));
    try {
      const output = path.join(root, 'trace.log'), env = {...process.env}; delete env.NODE_OPTIONS;
      const child = spawnSync('/usr/bin/strace', runtimeFileTraceArguments(output, [process.execPath, '-e', `
        const {spawnSync}=require('node:child_process'), {Worker}=require('node:worker_threads');
        const result=spawnSync('/usr/bin/true'); if(result.status!==0) process.exit(1);
        const worker=new Worker('require("node:worker_threads").parentPort.postMessage("done")',{eval:true,execArgv:[]});
        worker.on('error',()=>{process.exitCode=1;});
        process.stdout.write(String(process.pid));
      `]), {env,encoding:'utf8',timeout:15_000,maxBuffer:1024*1024});
      expect(child.status, child.stderr).toBe(0);
      const receipt = bindRuntimeProcessTree(fs.readFileSync(output,'utf8'), {
        ...terminal, processId:Number(child.stdout), exitCode:child.status!, signal:child.signal,
      });
      expect(receipt.tasks.some(task => task.threadGroupId !== receipt.processId &&
        task.execs.some(exec => exec.executable === '/usr/bin/true'))).toBe(true);
      expect(receipt.tasks.some(task => task.taskId !== task.threadGroupId)).toBe(true);
      expect(receipt.tasks.every(task => task.terminalAtMs !== null)).toBe(true);
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
  });
});
