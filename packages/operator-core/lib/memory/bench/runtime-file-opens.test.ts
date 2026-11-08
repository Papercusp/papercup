import { describe, expect, it, onTestFailed } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import { createHash } from 'node:crypto';
import { bindRuntimeJitDump, bindRuntimeJitMemory, bindRuntimeModelOpens, bindRuntimeProcessTree,
  observeRuntimeExecutableMemory, observeRuntimeProcessIdentity, observeRuntimePageSize, runtimeFileTraceArguments } from './runtime-file-opens.mjs';

describe('retained Linux perf JIT code bytes', () => {
  const witness = {processId:10, taskIds:[10,11], elfMachine:62,
    startedMonotonicNs:'90', finishedMonotonicNs:'200',
    exitCode:0, signal:null, eof:true, captureStartedBeforeExec:true};
  const sha = (bytes:Buffer) => createHash('sha256').update(bytes).digest('hex');
  function dump(little=true, move=false, close=true) {
    const header=Buffer.alloc(40), load=Buffer.alloc(61), movement=Buffer.alloc(64), end=Buffer.alloc(16);
    const u32=(bytes:Buffer, offset:number, value:number) => little ? bytes.writeUInt32LE(value,offset) : bytes.writeUInt32BE(value,offset);
    const u64=(bytes:Buffer, offset:number, value:bigint) => little ? bytes.writeBigUInt64LE(value,offset) : bytes.writeBigUInt64BE(value,offset);
    u32(header,0,0x4a695444);u32(header,4,1);u32(header,8,40);u32(header,12,62);u32(header,20,10);u64(header,24,100n);
    u32(load,0,0);u32(load,4,load.length);u64(load,8,110n);u32(load,16,10);u32(load,20,11);
    u64(load,24,0x1000n);u64(load,32,0x1000n);u64(load,40,3n);u64(load,48,1n);
    load.write('f\0',56);Buffer.from([0x90,0x90,0xc3]).copy(load,58);
    u32(movement,0,1);u32(movement,4,64);u64(movement,8,115n);u32(movement,16,10);u32(movement,20,11);
    u64(movement,24,0x2000n);u64(movement,32,0x1000n);u64(movement,40,0x2000n);u64(movement,48,3n);u64(movement,56,1n);
    u32(end,0,3);u32(end,4,16);u64(end,8,120n);
    return Buffer.concat([header,load,...(move?[movement]:[]),...(close?[end]:[])]);
  }
  const identity = {processId:10,parentProcessId:9,startTimeTicks:'42',executable:'/usr/bin/node'};
  function memorySample() {
    const tasks=[{taskId:10,state:'T',startTimeTicks:'42'},{taskId:11,state:'T',startTimeTicks:'43'}];
    const maps='00001000-00003000 r-xp 00000000 00:00 0\n';
    return {schema:'runtime-selected-executable-memory/v1' as const,process:{...identity},observerProcessId:9,
      startedMonotonicNs:'116',finishedMonotonicNs:'118',tasksBefore:tasks,tasksAfter:structuredClone(tasks),
      mapsBefore:maps,mapsAfter:maps,samples:[{codeIndex:'1',address:'0x1000',bytes:Buffer.from([0x90,0x90,0xc3])}]};
  }
  it('binds selected stopped executable memory bytes without granting population/origin/custody', () => {
    const proof=bindRuntimeJitMemory(dump(),witness,memorySample(),identity);
    expect(proof.bindings).toEqual([expect.objectContaining({codeIndex:'1',address:'0x1000',bytes:3,
      sha256:sha(Buffer.from([0x90,0x90,0xc3])),mapping:expect.objectContaining({permissions:'r-xp'})})]);
    expect(proof).toMatchObject({selectedExecutableBytesVerified:true,emittedLoadsNotSampled:0,
      mappingPopulationComplete:false,executableBytesQualified:false,completeRuntimeClosureVerified:false,
      jitByteOriginQualification:'required',runtimeCaptureCustody:'required',creatorFence:'required',
      writableAliasQualification:'required'});
  });
  it('retains direct writable executable mappings as candidates without excluding other aliases', () => {
    const sample=memorySample();
    sample.mapsBefore=sample.mapsAfter=sample.mapsBefore.replace('r-xp','rwxp');
    const proof=bindRuntimeJitMemory(dump(),witness,sample,identity);
    expect(proof.bindings[0]!.writableMappingCandidates).toEqual([{
      kind:'selected-mapping-writable',
      mapping:{start:'0x1000',end:'0x3000',permissions:'rwxp',offset:'0x00000000',
        device:'00:00',inode:'0',path:null},
      overlap:{selectedAddress:'0x1000',candidateAddress:'0x1000',bytes:3},
      sharedPhysicalBytesVerified:false,
    }]);
    expect(proof).toMatchObject({writableAliasQualification:'required',runtimeCaptureCustody:'required',
      jitByteOriginQualification:'required',completeRuntimeClosureVerified:false});
  });
  it('accounts for unsampled executable mappings from the same stopped snapshot', () => {
    const sample=memorySample();
    sample.mapsBefore=sample.mapsAfter=[
      '00001000-00003000 r-xp 00000000 00:00 0',
      '00003000-00004000 rw-p 00000000 00:00 0',
      '00004000-00005000 r-xs 00002000 00:01 42 /runtime.so',
      'ffffffffff600000-ffffffffff601000 --xp 00000000 00:00 0 [vsyscall]',
    ].join('\n')+'\n';
    const proof=bindRuntimeJitMemory(dump(),witness,sample,identity);
    expect(proof.executableMappingCoverage).toEqual({
      mappings:[
        {mapping:expect.objectContaining({start:'0x1000',end:'0x3000',permissions:'r-xp'}),
          selectedRanges:[{codeIndex:'1',address:'0x1000',bytes:3}],observedBytes:'3',unobservedBytes:'8189'},
        {mapping:expect.objectContaining({start:'0x4000',path:'/runtime.so'}),
          selectedRanges:[],observedBytes:'0',unobservedBytes:'4096'},
        {mapping:expect.objectContaining({start:'0xffffffffff600000',path:'[vsyscall]'}),
          selectedRanges:[],observedBytes:'0',unobservedBytes:'4096'},
      ],totalBytes:'16384',observedBytes:'3',unobservedBytes:'16381',
      scope:'selected byte coverage of executable mappings in the retained stopped snapshot only',
    });
    expect(proof).toMatchObject({mappingPopulationComplete:false,executableBytesQualified:false,
      completeRuntimeClosureVerified:false,runtimeCaptureCustody:'required',writableAliasQualification:'required'});
  });
  it('accounts for disjoint selected ranges once and orders them by address', () => {
    const sample=memorySample(), bytes=dump(), load=Buffer.from(bytes.subarray(40,101));
    load.writeBigUInt64LE(2n,48);load.writeBigUInt64LE(0x1008n,32);
    sample.samples.unshift({codeIndex:'2',address:'0x1008',bytes:Buffer.from([0x90,0x90,0xc3])});
    const proof=bindRuntimeJitMemory(Buffer.concat([bytes.subarray(0,101),load,bytes.subarray(101)]),
      witness,sample,identity);
    expect(proof.executableMappingCoverage).toMatchObject({totalBytes:'8192',observedBytes:'6',unobservedBytes:'8186',
      mappings:[{selectedRanges:[{codeIndex:'1',address:'0x1000',bytes:3},
        {codeIndex:'2',address:'0x1008',bytes:3}],observedBytes:'6',unobservedBytes:'8186'}]});
  });
  it('keeps executable mapping byte totals exact beyond Number precision', () => {
    const sample=memorySample();
    sample.mapsBefore=sample.mapsAfter+='00004000-0020000000004001 --xp 00000000 00:00 0 [kernel]\n';
    const coverage=bindRuntimeJitMemory(dump(),witness,sample,identity).executableMappingCoverage;
    expect(coverage).toMatchObject({totalBytes:'9007199254749185',observedBytes:'3',
      unobservedBytes:'9007199254749182'});
    expect(coverage.mappings[1]).toMatchObject({observedBytes:'0',unobservedBytes:'9007199254740993'});
  });
  it('does not promote full selected byte coverage into runtime closure', () => {
    const sample=memorySample();
    sample.mapsBefore=sample.mapsAfter='00001000-00001003 r-xp 00000000 00:00 0\n';
    const proof=bindRuntimeJitMemory(dump(),witness,sample,identity);
    expect(proof.executableMappingCoverage).toMatchObject({totalBytes:'3',observedBytes:'3',unobservedBytes:'0'});
    expect(proof).toMatchObject({mappingPopulationComplete:false,executableBytesQualified:false,
      completeRuntimeClosureVerified:false,jitByteOriginQualification:'required',runtimeCaptureCustody:'required',
      creatorFence:'required',writableAliasQualification:'required'});
  });
  it('refuses an oversized executable mapping coverage census instead of truncating it', () => {
    const sample=memorySample();
    sample.mapsBefore=sample.mapsAfter+=Array.from({length:4096},(_,i)=>
      `${(0x4000+i*0x1000).toString(16)}-${(0x5000+i*0x1000).toString(16)} r-xp 00000000 00:00 0`).join('\n')+'\n';
    expect(()=>bindRuntimeJitMemory(dump(),witness,sample,identity)).toThrow('executable mapping coverage limit');
  });
  it.each(['r-xp','r-xs'])('retains matching writable file offsets for a %s selected mapping', permissions => {
    const sample=memorySample();sample.samples[0]!.address='0x1001';
    const bytes=dump();bytes.writeBigUInt64LE(0x1001n,72);
    sample.mapsBefore=sample.mapsAfter=[
      `00001000-00003000 ${permissions} 00001000 00:01 42 /memfd:selected (deleted)`,
      '00004000-00005000 rw-s 00001002 00:01 42 /different/name',
    ].join('\n')+'\n';
    const proof=bindRuntimeJitMemory(bytes,witness,sample,identity);
    expect(proof.bindings[0]!.writableMappingCandidates).toEqual([{
      kind:'matching-file-offset',
      mapping:{start:'0x4000',end:'0x5000',permissions:'rw-s',offset:'0x00001002',
        device:'00:01',inode:'42',path:'/different/name'},
      overlap:{selectedAddress:'0x1002',candidateAddress:'0x4000',bytes:2},
      sharedPhysicalBytesVerified:false,
    }]);
    expect(proof.writableAliasQualification).toBe('required');
  });
  it.each(['device','inode','offset','read-only','anonymous'])(
    'does not invent a writable file candidate from %s similarity', variant => {
      const sample=memorySample();
      let selected='00001000-00003000 r-xp 00001000 00:01 42 /same/name';
      let candidate='00004000-00005000 rw-s 00001000 00:01 42 /same/name';
      if(variant==='device')candidate=candidate.replace('00:01','00:02');
      if(variant==='inode')candidate=candidate.replace('42','43');
      if(variant==='offset')candidate=candidate.replace('00001000','00001003');
      if(variant==='read-only')candidate=candidate.replace('rw-s','r--s');
      if(variant==='anonymous'){
        selected=selected.replace('42','0');candidate=candidate.replace('42','0');
      }
      sample.mapsBefore=sample.mapsAfter=selected+'\n'+candidate+'\n';
      const proof=bindRuntimeJitMemory(dump(),witness,sample,identity);
      expect(proof.bindings[0]!.writableMappingCandidates).toEqual([]);
      expect(proof.writableAliasQualification).toBe('required');
      expect(proof.completeRuntimeClosureVerified).toBe(false);
    });
  it('compares large file offsets and inode identities without Number rounding', () => {
    const sample=memorySample();
    sample.mapsBefore=sample.mapsAfter=[
      '00001000-00003000 r-xp 0020000000000000 00:01 9007199254740992 /memfd:code',
      '00004000-00005000 rw-s 0020000000000001 00:01 9007199254740992 /memfd:code',
      '00005000-00006000 rw-s 0020000000000003 00:01 9007199254740992 /memfd:code',
      '00006000-00007000 rw-s 0020000000000000 00:01 9007199254740993 /memfd:code',
    ].join('\n')+'\n';
    const candidates=bindRuntimeJitMemory(dump(),witness,sample,identity).bindings[0]!.writableMappingCandidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({kind:'matching-file-offset',
      overlap:{selectedAddress:'0x1001',candidateAddress:'0x4000',bytes:2}});
  });
  it('refuses an oversized writable candidate population instead of silently truncating it', () => {
    const sample=memorySample();
    sample.mapsBefore=sample.mapsAfter='00001000-00003000 r-xp 00000000 00:01 42 /memfd:code\n'
      +Array.from({length:4097},(_,i)=>`${(0x4000+i*0x1000).toString(16)}-${(0x5000+i*0x1000).toString(16)} rw-s 00000000 00:01 42 /memfd:code`).join('\n')+'\n';
    expect(()=>bindRuntimeJitMemory(dump(),witness,sample,identity)).toThrow('writable mapping candidate limit');
  });
  it('binds a moved code payload only at the observed destination', () => {
    const sample=memorySample();sample.samples[0].address='0x2000';
    expect(bindRuntimeJitMemory(dump(true,true),witness,sample,identity).bindings[0].address).toBe('0x2000');
    sample.samples[0].address='0x1000';
    expect(()=>bindRuntimeJitMemory(dump(true,true),witness,sample,identity)).toThrow('bytes/address differ');
  });
  const tracerIdentity={processId:12,parentProcessId:9,startTimeTicks:'50',executable:'/usr/bin/strace'};
  function tracedMemorySample(): ReturnType<typeof observeRuntimeExecutableMemory> {
    const sample: ReturnType<typeof observeRuntimeExecutableMemory>=memorySample();
    sample.tasksBefore=sample.tasksBefore.map(task=>({...task,state:'t',tracerProcessId:12}));
    sample.tasksAfter=structuredClone(sample.tasksBefore);
    sample.tracer={process:{...tracerIdentity},tasksBefore:[{taskId:12,state:'T',startTimeTicks:'50'}],
      tasksAfter:[{taskId:12,state:'T',startTimeTicks:'50'}]};
    return sample;
  }
  it('binds selected ptrace memory only with an independently pinned stopped tracer', () => {
    const proof=bindRuntimeJitMemory(dump(),witness,tracedMemorySample(),identity,tracerIdentity);
    expect(proof.selectedExecutableBytesVerified).toBe(true);
    expect(proof.completeRuntimeClosureVerified).toBe(false);
    expect(proof.runtimeCaptureCustody).toBe('required');
  });
  it.each(['no-pin','no-witness','wrong-tracer','reused-tracer','target-tracer','observer-tracer',
    'running-tracer','tracer-task-change','tracer-main-missing','tracer-task-duplicate',
    'tracer-task-identity','wrong-target-tracer','mixed-stop','unqualified-ptrace'])(
    'refuses selected ptrace memory %s', variant=>{
      const sample=tracedMemorySample();let expected: typeof tracerIdentity|undefined={...tracerIdentity};
      if(variant==='no-pin')expected=undefined;
      if(variant==='no-witness')delete sample.tracer;
      if(variant==='wrong-tracer')expected!.executable='/other/strace';
      if(variant==='reused-tracer')expected!.startTimeTicks='51';
      if(variant==='target-tracer')sample.tracer!.process.processId=expected!.processId=10;
      if(variant==='observer-tracer')sample.tracer!.process.processId=expected!.processId=9;
      if(variant==='running-tracer')sample.tracer!.tasksBefore[0].state='S';
      if(variant==='tracer-main-missing')sample.tracer!.tasksBefore[0].taskId=13;
      if(variant==='tracer-task-duplicate')sample.tracer!.tasksBefore.push(sample.tracer!.tasksBefore[0]);
      if(variant==='tracer-task-identity')sample.tracer!.tasksBefore[0].startTimeTicks='51';
      if(sample.tracer&&variant!=='tracer-task-change')sample.tracer.tasksAfter=structuredClone(sample.tracer.tasksBefore);
      if(variant==='tracer-task-change')sample.tracer!.tasksAfter=[];
      if(variant==='wrong-target-tracer')sample.tasksBefore[1].tracerProcessId=13;
      if(variant==='mixed-stop')sample.tasksBefore[1].state='T';
      sample.tasksAfter=structuredClone(sample.tasksBefore);
      if(variant==='unqualified-ptrace'){delete sample.tracer;expected=undefined;}
      expect(()=>bindRuntimeJitMemory(dump(),witness,sample,identity,expected)).toThrow('runtime executable memory:');
    });
  it.each([109n,110n])('refuses an inverted or equal selected memory MOVE clock %s', timestamp => {
    const bytes=dump(true,true);bytes.writeBigUInt64LE(timestamp,109);
    expect(()=>bindRuntimeJitMemory(bytes,witness,memorySample(),identity)).toThrow('ambiguous per-code event clock');
  });
  it.each(['identity','pid','observer','start-ticks','before-load','outside','reversed','maps-change',
    'not-executable','short-mapping','invalid-maps','running-task','foreign-task','duplicate-task',
    'missing-main','task-change','wrong-code','wrong-address','wrong-bytes','empty','duplicate',
    'partial-bytes','move-during','overlap','oversized'])('refuses selected memory %s evidence', variant => {
    const sample=memorySample();let bytes=dump();
    if(variant==='identity')sample.process.executable='/different/node';
    if(variant==='pid')sample.process.processId=99;
    if(variant==='observer')sample.observerProcessId=10;
    if(variant==='start-ticks')sample.tasksBefore[0].startTimeTicks='41';
    if(variant==='before-load')sample.startedMonotonicNs='109';
    if(variant==='outside')sample.finishedMonotonicNs='201';
    if(variant==='reversed')sample.finishedMonotonicNs='115';
    if(variant==='maps-change')sample.mapsAfter+='changed';
    if(variant==='not-executable')sample.mapsBefore=sample.mapsAfter=sample.mapsBefore.replace('r-xp','rw-p');
    if(variant==='short-mapping')sample.mapsBefore=sample.mapsAfter=sample.mapsBefore.replace('00003000','00001002');
    if(variant==='invalid-maps')sample.mapsBefore=sample.mapsAfter='unparsed maps';
    if(variant==='running-task')sample.tasksBefore[1].state='R';
    if(variant==='foreign-task')sample.tasksBefore[1].taskId=99;
    if(variant==='duplicate-task')sample.tasksBefore.push(sample.tasksBefore[0]);
    if(variant==='missing-main')sample.tasksBefore.shift();
    if(variant!=='task-change')sample.tasksAfter=structuredClone(sample.tasksBefore);
    if(variant==='task-change')sample.tasksAfter.pop();
    if(variant==='wrong-code')sample.samples[0].codeIndex='2';
    if(variant==='wrong-address')sample.samples[0].address='0x1001';
    if(variant==='wrong-bytes')sample.samples[0].bytes[0]=0;
    if(variant==='empty')sample.samples=[];
    if(variant==='duplicate')sample.samples.push(sample.samples[0]);
    if(variant==='partial-bytes')sample.samples[0].bytes=sample.samples[0].bytes.subarray(0,2);
    if(variant==='oversized')sample.samples[0].bytes=Buffer.alloc(1024*1024+1);
    if(variant==='move-during'){bytes=dump(true,true);sample.startedMonotonicNs='114';sample.finishedMonotonicNs='116';}
    if(variant==='overlap'){
      const load=Buffer.from(bytes.subarray(40,101));load.writeBigUInt64LE(2n,48);
      bytes=Buffer.concat([bytes.subarray(0,101),load,bytes.subarray(101)]);
    }
    expect(()=>bindRuntimeJitMemory(bytes,witness,sample,identity)).toThrow('runtime executable memory:');
  });
  it.runIf(process.platform==='linux')('reads actual stopped V8 executable memory from its parent and catches changed bytes', async () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-jit-memory-'));
    const before=process.hrtime.bigint(), beforeEpochMs=Date.now();
    const child=spawn(process.execPath,['--perf-prof','--perf-prof-path='+root,'--allow-natives-syntax','-e',
      'function wi4858MemoryTarget(x){return x*3+1};%PrepareFunctionForOptimization(wi4858MemoryTarget);'+
      'for(let i=0;i<10000;i++)wi4858MemoryTarget(i);%OptimizeFunctionOnNextCall(wi4858MemoryTarget);'+
      'if(wi4858MemoryTarget(4)!==13)process.exit(2);process.stdout.write("ready\\n",()=>process.kill(process.pid,"SIGSTOP"));'],
      {env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
    const closed=new Promise<{code:number|null,signal:string|null}>((resolve,reject)=>{
      child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));
    });
    try {
      const launched=observeRuntimeProcessIdentity(child.pid!);
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('private JIT child readiness timeout: '+stderr)),10000);
        child.stdout.once('data',()=>{clearTimeout(timer);resolve();});
        child.once('error',error=>{clearTimeout(timer);reject(error);});
      });
      const deadline=Date.now()+5000;
      while(!fs.readdirSync('/proc/'+child.pid+'/task').every(id=>
        fs.readFileSync('/proc/'+child.pid+'/task/'+id+'/stat','utf8').split(') ')[1].startsWith('T '))){
        if(Date.now()>deadline)throw new Error('private JIT child did not stop');
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      const dumpPath=path.join(root,'jit-'+child.pid+'.dump'), prefix=fs.readFileSync(dumpPath);
      // Selection only; terminal binding below reparses the complete dump. Never
      // pass a fabricated EOF to the existing terminal-only dump qualifier.
      const loads:{codeIndex:string,address:string,size:number,name:string}[]=[];
      for(let offset=40;offset+16<=prefix.length;){
        const size=prefix.readUInt32LE(offset+4);if(size<16||offset+size>prefix.length)break;
        if(prefix.readUInt32LE(offset)===0){const nameEnd=prefix.indexOf(0,offset+56);
          loads.push({codeIndex:prefix.readBigUInt64LE(offset+48).toString(),
            address:'0x'+prefix.readBigUInt64LE(offset+32).toString(16),
            size:Number(prefix.readBigUInt64LE(offset+40)),name:prefix.subarray(offset+56,nameEnd).toString()});}
        offset+=size;
      }
      const target=loads.filter(load=>load.name.includes('wi4858MemoryTarget')).at(-1);
      expect(target,stderr).toBeDefined();
      expect(()=>observeRuntimeExecutableMemory({...launched,startTimeTicks:'1'},[target!])).toThrow('launch identity changed');
      expect(()=>observeRuntimeExecutableMemory({...launched,parentProcessId:1},[target!])).toThrow('not the observer direct child');
      const sample=observeRuntimeExecutableMemory(launched,[target!]);
      child.kill('SIGCONT');
      const terminal=await closed;
      expect(terminal,stderr).toEqual({code:0,signal:null});
      const complete=fs.readFileSync(dumpPath), elf=fs.readFileSync(process.execPath).subarray(0,20);
      const proofWitness={processId:child.pid!,taskIds:sample.tasksBefore.map(task=>task.taskId),
        elfMachine:elf[5]===1?elf.readUInt16LE(18):elf.readUInt16BE(18),
        startedMonotonicNs:before.toString(),finishedMonotonicNs:process.hrtime.bigint().toString(),
        startedEpochMs:beforeEpochMs,finishedEpochMs:Date.now(),headerClock:'v8-realtime-microseconds' as const,
        exitCode:terminal.code!,signal:terminal.signal,eof:true,captureStartedBeforeExec:true};
      if(process.env.PAPERCUSP_TEST_ARTIFACT_DIR){
        fs.writeFileSync(path.join(process.env.PAPERCUSP_TEST_ARTIFACT_DIR,'memory-jit.dump'),complete);
        fs.writeFileSync(path.join(process.env.PAPERCUSP_TEST_ARTIFACT_DIR,'memory-observation.json'),JSON.stringify(sample));
        fs.writeFileSync(path.join(process.env.PAPERCUSP_TEST_ARTIFACT_DIR,'memory-witness.json'),JSON.stringify({proofWitness,launched}));
      }
      const proof=bindRuntimeJitMemory(complete,proofWitness,sample,launched);
      expect(proof.bindings).toHaveLength(1);expect(proof.completeRuntimeClosureVerified).toBe(false);
      expect(proof.bindings[0].mapping.permissions[2]).toBe('x');
      sample.samples[0].bytes[0]^=1;
      expect(()=>bindRuntimeJitMemory(complete,proofWitness,sample,launched)).toThrow('bytes/address differ');
    } finally {
      if(child.exitCode===null){child.kill('SIGCONT');child.kill('SIGKILL');}
      await closed;fs.rmSync(root,{recursive:true,force:true});
    }
  },25000);
  it.each([true,false])('binds exact code payloads in the declared byte order: little=%s', little => {
    const bytes=dump(little), proof=bindRuntimeJitDump(bytes,witness);
    expect(proof.loads).toEqual([expect.objectContaining({taskId:11, codeIndex:'1', address:'0x1000',
      bytes:3, byteOffset:98, sha256:sha(Buffer.from([0x90,0x90,0xc3]))})]);
    expect(proof.sha256).toBe(sha(bytes));
    expect(proof.jitByteOriginQualification).toBe('required');
    expect(proof.runtimeCaptureCustody).toBe('required');
    expect(proof.creatorFence).toBe('required');
    expect(proof.completeRuntimeClosureVerified).toBe(false);
  });
  it('links moves without claiming destination byte observation and permits terminal EOF instead of CLOSE', () => {
    const proof=bindRuntimeJitDump(dump(true,true,false),witness);
    expect(proof.moves).toEqual([expect.objectContaining({codeIndex:'1',from:'0x1000',to:'0x2000',destinationBytesObserved:false})]);
    expect(proof.closeRecordObserved).toBe(false);
    expect(proof.loads).toHaveLength(1);
  });
  it.each([0,1,0xdeadbeef,0xffffffff])('treats reserved header word %s as opaque', reserved => {
    const bytes=dump();bytes.writeUInt32LE(reserved,16);
    expect(bindRuntimeJitDump(bytes,witness).loads).toHaveLength(1);
  });
  it('requires explicit independent realtime bounds for the V8 header dialect', () => {
    const bytes=dump();bytes.writeBigUInt64LE(1700500n,24);
    const realtime={...witness,headerClock:'v8-realtime-microseconds' as const,startedEpochMs:1700,finishedEpochMs:1701};
    expect(()=>bindRuntimeJitDump(bytes,witness)).toThrow('header outside observed lifetime');
    expect(bindRuntimeJitDump(bytes,realtime)).toMatchObject({headerTimestamp:'1700500',
      headerClock:'v8-realtime-microseconds',recordClock:'monotonic-nanoseconds'});
    for(const change of [{startedEpochMs:1702},{finishedEpochMs:1699},{startedEpochMs:undefined},
      {finishedEpochMs:Number.NaN},{startedEpochMs:1699,finishedEpochMs:1699}])
      expect(()=>bindRuntimeJitDump(bytes,{...realtime,...change})).toThrow('runtime jitdump:');
    bytes.writeBigUInt64LE(89n,48);
    expect(()=>bindRuntimeJitDump(bytes,realtime)).toThrow('record outside observed lifetime');
    bytes.writeBigUInt64LE(201n,48);
    expect(()=>bindRuntimeJitDump(bytes,realtime)).toThrow('record outside observed lifetime');
  });
  it.each(['magic','version','header-size','pid','architecture','clock','short-header','truncated-record',
    'extent','timestamp','unknown-kind','name','code-size','address-wrap','duplicate-index','no-loads','after-close','foreign-pid','foreign-tid'])(
    'refuses malformed or foreign %s evidence', variant => {
      let bytes=dump();
      if(variant==='magic')bytes.writeUInt32LE(0,0);
      if(variant==='version')bytes.writeUInt32LE(2,4);
      if(variant==='header-size')bytes.writeUInt32LE(44,8);
      if(variant==='pid')bytes.writeUInt32LE(99,20);
      if(variant==='architecture')bytes.writeUInt32LE(183,12);
      if(variant==='clock')bytes.writeBigUInt64LE(1n,32);
      if(variant==='short-header')bytes=bytes.subarray(0,39);
      if(variant==='truncated-record')bytes=bytes.subarray(0,-1);
      if(variant==='extent')bytes.writeUInt32LE(0xffffffff,44);
      if(variant==='timestamp')bytes.writeBigUInt64LE(99n,48);
      if(variant==='unknown-kind')bytes.writeUInt32LE(99,40);
      if(variant==='name')bytes.fill(255,96,101);
      if(variant==='code-size')bytes.writeBigUInt64LE(4n,80);
      if(variant==='address-wrap')bytes.writeBigUInt64LE((1n<<64n)-1n,72);
      if(variant==='duplicate-index')bytes=Buffer.concat([bytes.subarray(0,101),bytes.subarray(40)]);
      if(variant==='no-loads')bytes=Buffer.concat([bytes.subarray(0,40),bytes.subarray(101)]);
      if(variant==='after-close')bytes=Buffer.concat([bytes,Buffer.alloc(1)]);
      if(variant==='foreign-pid')bytes.writeUInt32LE(99,56);
      if(variant==='foreign-tid')bytes.writeUInt32LE(99,60);
      expect(()=>bindRuntimeJitDump(bytes,witness)).toThrow('runtime jitdump:');
    });
  it.each(['unknown-index','old-address','size','destination-wrap','extent'])(
    'refuses a move with %s', variant => {
      let bytes=dump(true,true);
      if(variant==='unknown-index')bytes.writeBigUInt64LE(2n,157);
      if(variant==='old-address')bytes.writeBigUInt64LE(0x3000n,133);
      if(variant==='size')bytes.writeBigUInt64LE(4n,149);
      if(variant==='destination-wrap')bytes.writeBigUInt64LE((1n<<64n)-1n,141);
      if(variant==='extent')bytes.writeUInt32LE(63,105);
      expect(()=>bindRuntimeJitDump(bytes,witness)).toThrow('runtime jitdump:');
    });
  it.each([{exitCode:1},{signal:'SIGKILL'},{eof:false},{captureStartedBeforeExec:false},
    {taskIds:[11]},{startedMonotonicNs:'101'},{finishedMonotonicNs:'109'},{startedMonotonicNs:'201'},
    {startedMonotonicNs:'unknown'}])('refuses incomplete or incompatible independent witness %j', change => {
      expect(()=>bindRuntimeJitDump(dump(),{...witness,...change})).toThrow('runtime jitdump:');
    });
  it.runIf(process.platform==='linux')('captures real V8 generated bytes with independently traced tasks and host clocks', () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-jit-bytes-'));
    try {
      const env={PATH:'/usr/bin:/bin'}, trace=path.join(root,'trace.log'), elf=Buffer.alloc(20);
      const fd=fs.openSync(process.execPath,'r');
      try {expect(fs.readSync(fd,elf,0,20,0)).toBe(20);}finally{fs.closeSync(fd);}
      expect(elf.subarray(0,4).toString('hex')).toBe('7f454c46');
      const elfMachine=elf[5]===1?elf.readUInt16LE(18):elf.readUInt16BE(18);
      const pageSizeBytes=observeRuntimePageSize(), beforeEpochMs=Date.now(), before=process.hrtime.bigint();
      const child=spawnSync('/usr/bin/strace',runtimeFileTraceArguments(trace,[process.execPath,
        '--perf-prof','--perf-prof-path='+root,'-e',
        'function retainedJitFixture(x){return x+1}; let sum=0; for(let i=0;i<50000;i++)sum+=retainedJitFixture(i); if(sum!==1250025000)process.exit(2);process.stdout.write(String(process.pid));']),
        {env,encoding:'utf8',timeout:20_000,maxBuffer:1024*1024});
      const after=process.hrtime.bigint(), afterEpochMs=Date.now();
      expect(child.error).toBeUndefined();expect(child.status,child.stderr).toBe(0);
      const processId=Number(child.stdout), dumpPath=path.join(root,'jit-'+processId+'.dump');
      const bytes=fs.readFileSync(dumpPath), tree=bindRuntimeProcessTree(fs.readFileSync(trace,'utf8'),{
        processId,exitCode:child.status!,signal:child.signal,eof:true,captureStartedBeforeExec:true,pageSizeBytes});
      onTestFailed(()=>{
        const retained=process.env.PAPERCUSP_TEST_ARTIFACT_DIR
          ? path.join(process.env.PAPERCUSP_TEST_ARTIFACT_DIR,'jitdump-failed-'+processId+'.dump') : null;
        if(retained)fs.writeFileSync(retained,bytes,{flag:'wx',mode:0o600});
        console.error('JIT_DUMP_CAPTURE_DIAGNOSTICS '+JSON.stringify({processId,elfMachine,retained,
          startedMonotonicNs:before.toString(),finishedMonotonicNs:after.toString(),beforeEpochMs,afterEpochMs,
          bytes:bytes.length,sha256:sha(bytes),headerHex:bytes.subarray(0,40).toString('hex'),
          taskIds:tree.tasks.map(task=>task.taskId)}));
      });
      const proof=bindRuntimeJitDump(bytes,{processId,elfMachine,taskIds:tree.tasks.map(task=>task.taskId),
        startedMonotonicNs:before.toString(),finishedMonotonicNs:after.toString(),
        headerClock:'v8-realtime-microseconds',startedEpochMs:beforeEpochMs,finishedEpochMs:afterEpochMs,
        exitCode:child.status!,signal:child.signal,eof:true,captureStartedBeforeExec:true});
      expect(proof.loads.length).toBeGreaterThan(0);
      for(const load of proof.loads)expect(load.sha256).toBe(sha(bytes.subarray(load.byteOffset,load.byteOffset+load.bytes)));
      expect(proof.completeRuntimeClosureVerified).toBe(false);
      expect(tree.mappingOrigins.pageSizeBytes).toBe(pageSizeBytes);
      expect(tree.mappingOrigins.executableBytesQualified).toBe(false);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
});

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
  // Synthetic timings are explicit fixture inputs; production captures must
  // obtain their durations from strace's independent -T observation.
  const mappingTrace = (calls: string[], timed = true) => [lines[0], ...calls, lines.at(-1)]
    .map(row => timed && row!.includes(' = ') && !/ <\d+\.\d+>$/.test(row!)
      ? row + ' <0.000001>' : row).join('\n') + '\n';
  const mappingTerminal = {...terminal, pageSizeBytes:4096};
  const anonymousMap = '10 1.100000 mmap(NULL, 8192, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0x1000';
  it('requests independent syscall duration measurements from the tracer', () => {
    expect(runtimeFileTraceArguments('/tmp/trace', ['/usr/bin/true'])).toContain('-T');
  });
  it('does not infer mapping origins without measured syscall durations', () => {
    const receipt = bindRuntimeProcessTree(mappingTrace([anonymousMap,
      '10 1.200000 mprotect(0x1000, 4096, PROT_EXEC) = 0'], false), mappingTerminal);
    expect(receipt.memoryTransitions).toHaveLength(2);
    expect(receipt.mappingOrigins.executableRanges).toEqual([]);
    expect(receipt.mappingOrigins.gaps.map(g => g.reason)).toContain('syscall-duration-required');
  });
  it.each(['complete', 'resumed'])('stops mapping replay at overlapping measured %s syscall windows', variant => {
    const permission = variant === 'complete'
      ? ['10 1.200000 mprotect(0x1000, 4096, PROT_EXEC) = 0 <0.200000>']
      : ['10 1.200000 mprotect(0x1000, 4096, PROT_EXEC <unfinished ...>',
        '10 1.220000 <... mprotect resumed>) = 0 <0.200000>'];
    const receipt = bindRuntimeProcessTree(mappingTrace([
      '10 1.050000 clone(child_stack=NULL, flags=CLONE_VM|CLONE_THREAD) = 11',
      anonymousMap, ...permission, '11 1.300000 munmap(0x1000, 8192) = 0',
      '11 1.900000 +++ exited with 0 +++',
    ]), mappingTerminal);
    expect(receipt.memoryTransitions).toHaveLength(3);
    expect(receipt.memoryTransitions[1]).toMatchObject({durationNs:'200000000'});
    expect(receipt.memoryTransitions[1]!.completedAtMs).toBeGreaterThanOrEqual(1400);
    expect(receipt.mappingOrigins.executableRanges).toEqual([]);
    expect(receipt.mappingOrigins.gaps.at(-1)?.reason).toBe('overlapping-address-space-events-replay-stopped');
  });
  it.each(['complete', 'resumed'])('replays commuting anonymous allocations with overlapping %s windows', variant => {
    const first = variant === 'complete'
      ? ['10 1.200000 mmap(NULL, 4096, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0x5000 <0.200000>']
      : ['10 1.200000 mmap(NULL, 4096, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0 <unfinished ...>',
        '10 1.400000 <... mmap resumed>) = 0x5000 <0.200000>'];
    const receipt = bindRuntimeProcessTree(mappingTrace([
      '10 1.050000 clone(child_stack=NULL, flags=CLONE_VM|CLONE_THREAD) = 11',
      ...first,
      '11 1.300000 mmap(0x9000, 4096, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0x9000 <0.200000>',
      '10 1.600000 mprotect(0x5000, 4096, PROT_EXEC) = 0',
      '11 1.700000 mprotect(0x9000, 4096, PROT_EXEC) = 0',
      '11 1.900000 +++ exited with 0 +++',
    ]), mappingTerminal);
    expect(receipt.mappingOrigins.executableRanges.map(row => [row.start, row.origin.kind]))
      .toEqual([['0x5000','anonymous'], ['0x9000','anonymous']]);
    expect(receipt.mappingOrigins.gaps.map(row => row.reason))
      .toEqual(['exec-kernel-installed-mappings-unobserved']);
    expect(receipt.mappingOrigins).toMatchObject({mappingPopulationComplete:false, executableBytesQualified:false});
    expect(receipt).toMatchObject({completeRuntimeClosureVerified:false, creatorFence:'required'});
  });
  it('replays commuting page-rounded unmaps while preserving untouched origins', () => {
    const receipt = bindRuntimeProcessTree(mappingTrace([
      '10 1.050000 clone(child_stack=NULL, flags=CLONE_VM|CLONE_THREAD) = 11', anonymousMap,
      '10 1.150000 mmap(NULL, 8192, PROT_READ, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0x5000',
      '10 1.200000 munmap(0x1000, 1) = 0 <0.200000>',
      '11 1.300000 munmap(0x5000, 4096) = 0 <0.200000>',
      '10 1.600000 mprotect(0x2000, 4096, PROT_EXEC) = 0',
      '11 1.700000 mprotect(0x6000, 4096, PROT_EXEC) = 0',
      '11 1.900000 +++ exited with 0 +++',
    ]), mappingTerminal);
    expect(receipt.mappingOrigins.changes.filter(row => row.operation === 'munmap-removed')).toHaveLength(2);
    expect(receipt.mappingOrigins.executableRanges.filter(row => row.operation === 'mprotect')
      .map(row => [row.start,row.origin.kind])).toEqual([['0x2000','anonymous'],['0x6000','anonymous']]);
    expect(receipt.mappingOrigins.gaps.map(row => row.reason))
      .toEqual(['exec-kernel-installed-mappings-unobserved']);
  });
  it.each([
    ['nonadjacent range conflict',
      '11 1.300000 mmap(NULL, 4096, PROT_READ, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0x9000 <0.200000>',
      '11 1.510000 munmap(0x6000, 4096) = 0 <0.010000>'],
    ['permission barrier', '11 1.300000 mprotect(0x9000, 4096, PROT_EXEC) = 0 <0.200000>'],
    ['clone barrier', '10 1.300000 fork() = 12 <0.200000>', '12 1.800000 +++ exited with 0 +++'],
    ['unsupported flags',
      '11 1.300000 mmap(NULL, 4096, PROT_READ, MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB, -1, 0) = 0x9000 <0.200000>'],
    ['page-rounded conflict', '11 1.300000 munmap(0x6000, 1) = 0 <0.200000>'],
  ])('validates the entire overlapping component before replay: %s', (_label, ...other) => {
    const receipt = bindRuntimeProcessTree(mappingTrace([
      '10 1.050000 clone(child_stack=NULL, flags=CLONE_VM|CLONE_THREAD) = 11', anonymousMap,
      '10 1.200000 mmap(NULL, 8192, PROT_READ, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0x5000 <0.400000>',
      ...other, '11 1.900000 +++ exited with 0 +++',
    ]), mappingTerminal);
    expect(receipt.mappingOrigins.changes.filter(row => row.operation === 'mmap')).toHaveLength(1);
    expect(receipt.mappingOrigins.executableRanges).toEqual([]);
    expect(receipt.mappingOrigins.gaps.at(-1)?.reason).toBe('overlapping-address-space-events-replay-stopped');
  });
  it('replays resumed mapping arguments without treating formatting spaces as unknown semantics', () => {
    const receipt = bindRuntimeProcessTree(mappingTrace([
      '10 1.100000 mmap(NULL, 8192, PROT_READ, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0 <unfinished ...>',
      '10 1.120000 <... mmap resumed>) = 0x1000 <0.020000>',
      '10 1.300000 mprotect(0x1000, 4096, PROT_EXEC) = 0',
    ]), mappingTerminal);
    expect(receipt.mappingOrigins.executableRanges).toEqual([expect.objectContaining({
      operation:'mprotect', start:'0x1000', end:'0x2000', origin:{kind:'anonymous',path:null,offsetBytes:null},
    })]);
    expect(receipt.mappingOrigins.gaps.map(row => row.reason))
      .toEqual(['exec-kernel-installed-mappings-unobserved']);
  });
  it('replays disjoint measured syscall windows without qualifying their executable bytes', () => {
    const receipt = bindRuntimeProcessTree(mappingTrace([anonymousMap,
      '10 1.200000 mprotect(0x1000, 4096, PROT_EXEC) = 0 <0.001000>',
      '10 1.300000 munmap(0x1000, 8192) = 0']), mappingTerminal);
    expect(receipt.memoryTransitions[1]).toMatchObject({durationNs:'1000000'});
    expect(receipt.mappingOrigins.executableRanges.filter(row => row.operation === 'mprotect')).toEqual([expect.objectContaining({
      start:'0x1000', end:'0x2000', origin:{kind:'anonymous',path:null,offsetBytes:null},
      executableBytesQualified:false,
    })]);
    expect(receipt.mappingOrigins.gaps.map(g => g.reason)).toEqual(['exec-kernel-installed-mappings-unobserved']);
  });
  it('compares nanosecond syscall bounds exactly at epoch-sized timestamps', () => {
    const trace = mappingTrace([
      '10 1.050000 clone(child_stack=NULL, flags=CLONE_VM|CLONE_THREAD) = 11', anonymousMap,
      '10 1.200000000 mprotect(0x1000, 4096, PROT_EXEC) = 0 <0.000000001>',
      '11 1.200000004 munmap(0x1000, 8192) = 0 <0.000000001>',
      '11 1.900000 +++ exited with 0 +++',
    ]).replace(/ (\d+)\.(\d+) /g, (_all, seconds, fraction) =>
      ' ' + (1_794_150_000n + BigInt(seconds)) + '.' + fraction + ' ');
    const receipt = bindRuntimeProcessTree(trace, mappingTerminal);
    expect(receipt.mappingOrigins.executableRanges).toContainEqual(expect.objectContaining({
      operation:'mprotect', origin:{kind:'anonymous',path:null,offsetBytes:null},
    }));
    expect(receipt.mappingOrigins.gaps.map(g => g.reason)).toEqual(['exec-kernel-installed-mappings-unobserved']);
  });
  it('retains transient anonymous executable ranges after permissions are removed and memory is unmapped', () => {
    const receipt = bindRuntimeProcessTree(mappingTrace([anonymousMap,
      '10 1.200000 mprotect(0x1000, 1, PROT_READ|PROT_EXEC) = 0',
      '10 1.300000 pkey_mprotect(0x1000, 4096, PROT_READ|PROT_WRITE, 0) = 0',
      '10 1.400000 munmap(0x1000, 8192) = 0']), mappingTerminal);
    expect(receipt.mappingOrigins.executableRanges).toEqual([expect.objectContaining({
      operation:'mprotect', start:'0x1000', end:'0x2000',
      origin:{kind:'anonymous', path:null, offsetBytes:null}, executableBytesQualified:false,
      byteOriginQualification:'required',
    })]);
    expect(receipt.mappingOrigins).toMatchObject({mappingPopulationComplete:false,
      executableBytesQualified:false, jitByteOriginQualification:'required'});
    expect(receipt.mappingOrigins.gaps.map(g => g.reason)).toEqual(['exec-kernel-installed-mappings-unobserved']);
    expect(receipt.completeRuntimeClosureVerified).toBe(false);
    expect(receipt.creatorFence).toBe('required');
  });
  it.each([4096, 16384, 65536])('rounds mapping and permission tails using the witnessed %i byte page size', page => {
    const receipt = bindRuntimeProcessTree(mappingTrace([
      `10 1.100000 mmap(NULL, ${page + 1}, PROT_READ, MAP_PRIVATE, 4</lib/fixture.so>, ${page * 2}) = 0x10000`,
      `10 1.200000 mprotect(0x${(0x10000 + page).toString(16)}, 1, PROT_READ|PROT_EXEC) = 0`,
    ]), {...terminal, pageSizeBytes:page});
    expect(receipt.mappingOrigins.executableRanges[0]).toMatchObject({
      start:'0x'+(0x10000+page).toString(16), end:'0x'+(0x10000+page*2).toString(16),
      origin:{kind:'file-mapping',path:'/lib/fixture.so',offsetBytes:String(page*3)},
    });
  });
  it.each([undefined, 0, 4095, -4096, Number.NaN])('does not guess a page size from %s', pageSizeBytes => {
    const receipt = bindRuntimeProcessTree(mappingTrace([anonymousMap,
      '10 1.200000 mprotect(0x1000, 4096, PROT_EXEC) = 0']), {...terminal,pageSizeBytes});
    expect(receipt.memoryTransitions).toHaveLength(2);
    expect(receipt.mappingOrigins.executableRanges).toEqual([]);
    expect(receipt.mappingOrigins.gaps).toContainEqual(expect.objectContaining({reason:'independent-host-page-size-required'}));
  });
  it('shares VM metadata even between separate thread groups, and copies it for fork', () => {
    const receipt = bindRuntimeProcessTree(mappingTrace([anonymousMap,
      '10 1.200000 clone(child_stack=NULL, flags=CLONE_VM|SIGCHLD) = 12',
      '12 1.300000 mprotect(0x1000, 4096, PROT_READ|PROT_EXEC) = 0',
      '10 1.400000 fork() = 13',
      '10 1.500000 munmap(0x1000, 8192) = 0',
      '13 1.600000 mprotect(0x1000, 4096, PROT_READ|PROT_EXEC) = 0',
      '12 1.700000 mprotect(0x1000, 4096, PROT_READ|PROT_EXEC) = 0',
      '13 1.800000 +++ exited with 0 +++', '12 1.900000 +++ exited with 0 +++',
    ]), mappingTerminal);
    const ranges = receipt.mappingOrigins.executableRanges;
    expect(ranges.find(r => r.taskId === 12 && r.operation === 'mprotect')?.origin.kind).toBe('anonymous');
    expect(ranges.find(r => r.taskId === 13 && r.operation === 'mprotect')?.origin.kind).toBe('anonymous');
    expect(ranges.filter(r => r.taskId === 12 && r.operation === 'mprotect').at(-1)?.origin.kind).toBe('unresolved');
    const sharing = receipt.mappingOrigins.changes.find(c => c.operation === 'share-vm')!;
    expect(sharing.addressSpaceId).toBe(receipt.mappingOrigins.changes.find(c => c.operation === 'mmap')!.addressSpaceId);
    expect(receipt.mappingOrigins.changes.find(c => c.operation === 'copy-vm')!.addressSpaceId).not.toBe(sharing.addressSpaceId);
  });
  it('drops the old mapping identity on exec without clearing a peer sharing the old VM', () => {
    const receipt = bindRuntimeProcessTree(mappingTrace([anonymousMap,
      '10 1.200000 clone(child_stack=NULL, flags=CLONE_VM|SIGCHLD) = 12',
      '12 1.300000 execve("/usr/bin/true", ["true"], 0x1) = 0',
      '12 1.400000 mprotect(0x1000, 4096, PROT_EXEC) = 0',
      '10 1.500000 mprotect(0x1000, 4096, PROT_EXEC) = 0',
      '12 1.600000 +++ exited with 0 +++',
    ]), mappingTerminal);
    expect(receipt.mappingOrigins.executableRanges.find(r => r.taskId === 12)?.origin.kind).toBe('unresolved');
    expect(receipt.mappingOrigins.executableRanges.find(r => r.taskId === 10)?.origin.kind).toBe('anonymous');
  });
  it('inherits permissions and file offsets through supported remap and fixed replacement', () => {
    const receipt = bindRuntimeProcessTree(mappingTrace([
      '10 1.100000 mmap(NULL, 4096, PROT_READ|PROT_EXEC, MAP_PRIVATE, 4</lib/fixture.so>, 8192) = 0x1000',
      '10 1.200000 mmap(NULL, 8192, PROT_READ, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0x5000',
      '10 1.300000 mremap(0x1000, 4096, 8192, MREMAP_MAYMOVE|MREMAP_FIXED, 0x5000) = 0x5000',
      '10 1.400000 mprotect(0x6000, 4096, PROT_EXEC) = 0',
    ]), mappingTerminal);
    expect(receipt.mappingOrigins.executableRanges.find(r => r.operation === 'mremap')).toMatchObject({
      start:'0x5000',end:'0x7000',origin:{kind:'file-mapping',path:'/lib/fixture.so',offsetBytes:'8192'}});
    expect(receipt.mappingOrigins.executableRanges.at(-1)?.origin.offsetBytes).toBe('12288');
  });
  it('does not apply failed transitions or lose file offsets on partial unmap and fixed mmap', () => {
    const receipt = bindRuntimeProcessTree(mappingTrace([
      '10 1.100000 mmap(NULL, 12288, PROT_READ, MAP_PRIVATE, 4</lib/fixture.so>, 0) = 0x1000',
      '10 1.200000 munmap(0x2000, 1) = 0',
      '10 1.300000 mmap(0x2000, 4096, PROT_READ, MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED, -1, 0) = 0x2000',
      '10 1.400000 munmap(0x3000, 4096) = -1 EINVAL (Invalid argument)',
      '10 1.500000 mprotect(0x1000, 12288, PROT_EXEC) = 0',
    ]), mappingTerminal);
    expect(receipt.mappingOrigins.executableRanges.map(r => [r.start,r.origin.kind,r.origin.offsetBytes]))
      .toEqual([['0x1000','file-mapping','0'],['0x2000','anonymous',null],['0x3000','file-mapping','8192']]);
  });
  it.each([
    '10 1.200000 mremap(0x1000, 8192, 8192, MREMAP_MAYMOVE|MREMAP_DONTUNMAP) = 0x5000',
    '10 1.200000 mremap(0x1000, 0, 8192, MREMAP_MAYMOVE) = 0x5000',
    '10 1.200000 mmap(NULL, 8192, PROT_EXEC, MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB, -1, 0) = 0x5000',
    '10 1.200000 shmat(3, NULL, SHM_EXEC) = 0x5000',
    '10 1.200000 remap_file_pages(0x1000, 8192, 0, 0, 0) = 0',
    '10 1.200000 mmap(NULL, 8192, PROT_EXEC, MAP_PRIVATE, 4</lib/fixture.so>, 1) = 0x5000',
  ])('invalidates mapping replay for unsupported semantics: %s', call => {
    const receipt = bindRuntimeProcessTree(mappingTrace([anonymousMap, call,
      '10 1.300000 mprotect(0x1000, 4096, PROT_EXEC) = 0']), mappingTerminal);
    expect(receipt.mappingOrigins.executableRanges).toEqual([]);
    expect(receipt.mappingOrigins.gaps.at(-1)?.reason).toBe('prior-address-space-transition-unresolved');
    expect(receipt.memoryTransitions).toHaveLength(3);
  });
  it.each(['unfinished', 'equal-timestamp'])('does not assign origins through %s ordering ambiguity', variant => {
    const calls = variant === 'unfinished' ? [
      '10 1.200000 mprotect(0x1000, 4096, PROT_EXEC <unfinished ...>',
      '11 1.210000 munmap(0x1000, 8192) = 0',
      '10 1.220000 <... mprotect resumed>) = 0',
    ] : ['10 1.200000 mprotect(0x1000, 4096, PROT_EXEC) = 0',
      '11 1.200000 munmap(0x1000, 8192) = 0'];
    const receipt = bindRuntimeProcessTree(mappingTrace([
      '10 1.050000 clone(child_stack=NULL, flags=CLONE_VM|CLONE_THREAD) = 11',
      anonymousMap, ...calls, '11 1.900000 +++ exited with 0 +++',
    ]), mappingTerminal);
    expect(receipt.mappingOrigins.gaps.at(-1)?.reason).toBe('overlapping-address-space-events-replay-stopped');
    // A range from the first call may be retained when timestamps tie, but it
    // cannot carry an origin inferred by executing that ambiguous first call.
    expect(receipt.mappingOrigins.executableRanges).toEqual([]);
    expect(receipt.memoryTransitions).toHaveLength(3);
  });
  it.each(['mprotect(0x1000, 8192, PROT_EXEC)', 'pkey_mprotect(0x1000, 8192, PROT_EXEC, 0)'])(
    'does not assume an unchanged VM after a possibly partial failed %s', call => {
      const receipt = bindRuntimeProcessTree(mappingTrace([anonymousMap,
        `10 1.200000 ${call} = -1 ENOMEM (Cannot allocate memory)`,
        '10 1.300000 mremap(0x1000, 8192, 8192, MREMAP_MAYMOVE) = 0x5000',
      ]), mappingTerminal);
      expect(receipt.mappingOrigins.executableRanges).toEqual([]);
      expect(receipt.mappingOrigins.gaps.map(g => g.reason)).toContain('failed-permission-change-may-be-partial');
      expect(receipt.mappingOrigins.gaps.at(-1)?.reason).toBe('prior-address-space-transition-unresolved');
      expect(receipt.mappingOrigins.effectivePermissionsQualification).toBe('required');
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
        pageSizeBytes:Number(spawnSync('/usr/bin/getconf', ['PAGESIZE'], {encoding:'utf8',timeout:5000}).stdout.trim()),
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
      expect(receipt.mappingOrigins.executableRanges).toContainEqual(expect.objectContaining({
        operation:'mprotect', start:address, origin:{kind:'anonymous',path:null,offsetBytes:null},
        executableBytesQualified:false, byteOriginQualification:'required',
      }));
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
