import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { endianness } from 'node:os';

const memoryRequire = (condition, message) => {
  if (!condition) throw new Error('runtime executable memory: '+message);
};
const memoryHash = bytes => createHash('sha256').update(bytes).digest('hex');
function procStatIdentity(root, processId) {
  const stat = fs.readFileSync(root+'/stat','utf8');
  const end = stat.lastIndexOf(')');
  const fields = stat.slice(end+2).trim().split(/\s+/);
  memoryRequire(stat.startsWith(String(processId)+' (') && end > 0
    && /^[1-9]\d*$/.test(fields[19]), 'invalid proc identity');
  return {processId, parentProcessId:Number(fields[1]), startTimeTicks:fields[19], state:fields[0]};
}
function procIdentity(root, processId) {
  const {state, ...identity} = procStatIdentity(root,processId);
  return {...identity, executable:fs.readlinkSync(root+'/exe')};
}
function sameProcess(actual, expected) {
  return actual && expected && ['processId','parentProcessId','startTimeTicks','executable']
    .every(key => actual[key] === expected[key]);
}
/** Observe the launcher's direct child identity; callers retain this BEFORE
 * asking the child to stop. No signal, attach, or live-host operation is done. */
export function observeRuntimeProcessIdentity(processId) {
  memoryRequire(Number.isSafeInteger(processId) && processId > 0, 'invalid process id');
  const identity = procIdentity('/proc/'+processId,processId);
  memoryRequire(identity.parentProcessId === process.pid, 'not the observer direct child');
  return identity;
}
/** Poll a previously pinned process, including an independently daemonized
 * tracer. This is liveness only; it does not grant direct-child observation. */
export function isRuntimeProcessAlive(identity) {
  memoryRequire(identity && Number.isSafeInteger(identity.processId) && identity.processId > 0
    && Number.isSafeInteger(identity.parentProcessId) && identity.parentProcessId >= 0
    && /^[1-9]\d*$/.test(identity.startTimeTicks)
    && typeof identity.executable === 'string' && identity.executable.startsWith('/'),
  'invalid pinned process identity');
  const root = '/proc/'+identity.processId;
  try {
    const before = procStatIdentity(root,identity.processId);
    if (before.state === 'Z' || before.state === 'X') return false;
    const executable = fs.readlinkSync(root+'/exe');
    const after = procStatIdentity(root,identity.processId);
    return after.state !== 'Z' && after.state !== 'X'
      && sameProcess({...before,executable},identity) && sameProcess({...after,executable},identity);
  } catch (error) {
    if (['ENOENT','ESRCH'].includes(error.code)) return false;
    throw error;
  }
}
/** Pin the kernel-reported tracer before stopping it. The target cannot supply
 * this identity; the parent also selects the expected tracer executable. */
export function observeRuntimeTracerIdentity(identity, expectedExecutable) {
  const root = '/proc/'+identity?.processId;
  memoryRequire(identity?.parentProcessId === process.pid
    && sameProcess(procIdentity(root,identity.processId),identity), 'launch identity changed');
  const status = fs.readFileSync(root+'/status','utf8');
  const tracerId = Number(/^TracerPid:\s+(\d+)$/m.exec(status)?.[1]);
  memoryRequire(Number.isSafeInteger(tracerId) && tracerId > 0
    && tracerId !== process.pid && tracerId !== identity.processId, 'missing independent tracer');
  const tracer = procIdentity('/proc/'+tracerId,tracerId);
  memoryRequire(typeof expectedExecutable === 'string' && expectedExecutable.startsWith('/')
    && tracer.executable === fs.realpathSync(expectedExecutable), 'unexpected tracer executable');
  return tracer;
}
function stoppedTasks(root, tracer) {
  const ids = fs.readdirSync(root+'/task').map(Number).sort((a,b)=>a-b);
  memoryRequire(ids.length > 0 && ids.length <= 10000
    && ids.every(id => Number.isSafeInteger(id) && id > 0), 'invalid task population');
  return ids.map(taskId => {
    const stat = fs.readFileSync(root+'/task/'+taskId+'/stat','utf8');
    const fields = stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
    memoryRequire(/^[1-9]\d*$/.test(fields[19]), 'invalid task identity');
    if (tracer) {
      const status = fs.readFileSync(root+'/task/'+taskId+'/status','utf8');
      const tracerProcessId = Number(/^TracerPid:\s+(\d+)$/m.exec(status)?.[1]);
      memoryRequire(fields[0] === 't' && tracerProcessId === tracer.processId,
        'task is not stopped by the pinned tracer');
      return {taskId,state:'t',startTimeTicks:fields[19],tracerProcessId};
    }
    memoryRequire(fields[0] === 'T', 'task is not group-stopped');
    return {taskId,state:'T',startTimeTicks:fields[19]};
  });
}
function stoppedTracer(identity, target) {
  memoryRequire(identity && identity.processId !== target.processId && identity.processId !== process.pid,
    'missing independent tracer');
  const root = '/proc/'+identity.processId;
  memoryRequire(sameProcess(procIdentity(root,identity.processId),identity), 'tracer identity changed');
  return stoppedTasks(root);
}
function executableMaps(text) {
  memoryRequire(typeof text === 'string' && text.length > 0 && text.length <= 16*1024*1024,
    'invalid maps extent');
  const lines = text.trimEnd().split('\n'), maps = [];
  memoryRequire(lines.length <= 100000, 'maps limit');
  let previousEnd = 0n;
  for (const line of lines) {
    const match = /^([a-f0-9]+)-([a-f0-9]+) ([r-][w-][x-][ps]) ([a-f0-9]+) ([a-f0-9]+:[a-f0-9]+) (\d+)(?:\s+(.*))?$/.exec(line);
    memoryRequire(match, 'unsupported kernel maps record');
    const start = BigInt('0x'+match[1]), end = BigInt('0x'+match[2]);
    memoryRequire(start < end && start >= previousEnd && end <= 1n<<64n, 'invalid kernel mapping range');
    maps.push({start,end,permissions:match[3],offset:'0x'+match[4],
      device:match[5],inode:match[6],path:match[7] ?? null});
    previousEnd = end;
  }
  return maps;
}
function execEntryAuxv(bytes) {
  memoryRequire(Buffer.isBuffer(bytes) && bytes.length >= 32 && bytes.length <= 65536
    && bytes.length % 16 === 0, 'invalid exec auxv extent');
  const values = new Map();
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const key = bytes.readBigUInt64LE(offset), value = bytes.readBigUInt64LE(offset+8);
    if (key === 0n) {
      memoryRequire(value === 0n && offset+16 === bytes.length && values.has(7n)
        && values.get(9n) > 0n, 'incomplete exec auxv');
      return {base:values.get(7n), entry:values.get(9n)};
    }
    memoryRequire(!values.has(key), 'duplicate exec auxv key');
    values.set(key,value);
  }
  throw new Error('runtime executable memory: unterminated exec auxv');
}
function execEntryHeaderAddress(auxv, maps, identity) {
  if (auxv.base > 0n) return auxv.base;
  const headers = maps.filter(map => map.path === identity.executable && BigInt(map.offset) === 0n
    && BigInt(map.inode) > 0n);
  memoryRequire(headers.length === 1, 'ambiguous static exec header');
  return headers[0].start;
}
/** Read an x86-64 Linux exec stop owned by the existing independent tracer.
 * The caller pins both identities, group-stops the tracer, and owns cleanup.
 * Reading a later stopped process cannot qualify as this initial snapshot. */
export function observeRuntimeExecEntry(identity, tracerIdentity) {
  memoryRequire(process.platform === 'linux' && process.arch === 'x64', 'unsupported exec entry ABI');
  memoryRequire(identity?.parentProcessId === process.pid, 'not the observer direct child');
  const root = '/proc/'+identity.processId, startedMonotonicNs = process.hrtime.bigint().toString();
  const startedEpochMs = Date.now();
  memoryRequire(sameProcess(procIdentity(root,identity.processId),identity), 'launch identity changed');
  const tracerTasksBefore = stoppedTracer(tracerIdentity,identity), tasksBefore = stoppedTasks(root,tracerIdentity);
  const syscallBefore = fs.readFileSync(root+'/syscall','utf8'), auxvBefore = fs.readFileSync(root+'/auxv');
  const mapsBefore = fs.readFileSync(root+'/maps','utf8');
  const address = execEntryHeaderAddress(execEntryAuxv(auxvBefore),executableMaps(mapsBefore),identity);
  memoryRequire(address <= BigInt(Number.MAX_SAFE_INTEGER)-64n, 'unsupported exec header address');
  const fd = fs.openSync(root+'/mem','r'), elfHeader = Buffer.alloc(64);
  try {memoryRequire(fs.readSync(fd,elfHeader,0,64,Number(address)) === 64, 'short exec header read');}
  finally {fs.closeSync(fd);}
  const mapsAfter = fs.readFileSync(root+'/maps','utf8'), auxvAfter = fs.readFileSync(root+'/auxv');
  const syscallAfter = fs.readFileSync(root+'/syscall','utf8'), tasksAfter = stoppedTasks(root,tracerIdentity);
  const tracerTasksAfter = stoppedTracer(tracerIdentity,identity);
  memoryRequire(sameProcess(procIdentity(root,identity.processId),identity), 'launch identity changed');
  const observation = {schema:'runtime-exec-entry-observation/v1',process:{...identity},observerProcessId:process.pid,
    startedMonotonicNs,startedEpochMs,finishedEpochMs:Date.now(),finishedMonotonicNs:process.hrtime.bigint().toString(),
    tracer:{process:{...tracerIdentity},tasksBefore:tracerTasksBefore,tasksAfter:tracerTasksAfter},
    tasksBefore,tasksAfter,syscallBefore,syscallAfter,auxvBefore,auxvAfter,mapsBefore,mapsAfter,
    elfHeader:{address:'0x'+address.toString(16),bytes:elfHeader}};
  bindRuntimeExecEntry(observation,identity,tracerIdentity);
  return observation;
}
/** Validate retained parent-read entry evidence. This covers one exec boundary,
 * not the process lifetime, executable byte origin or writable aliases. */
export function bindRuntimeExecEntry(observation, identity, tracerIdentity) {
  const o = observation;
  memoryRequire(o?.schema === 'runtime-exec-entry-observation/v1' && sameProcess(o.process,identity)
    && Number.isSafeInteger(identity.processId) && identity.processId > 0
    && identity.parentProcessId === o.observerProcessId && o.observerProcessId !== identity.processId,
  'exec observer identity differs');
  memoryRequire(sameProcess(o.tracer?.process,tracerIdentity) && tracerIdentity.processId !== identity.processId
    && tracerIdentity.processId !== o.observerProcessId, 'exec tracer identity differs');
  memoryRequire(/^\d+$/.test(o.startedMonotonicNs) && /^\d+$/.test(o.finishedMonotonicNs)
    && BigInt(o.startedMonotonicNs) < BigInt(o.finishedMonotonicNs), 'invalid exec observation clock');
  // Old retained entry samples remain readable, but cannot be joined to an
  // epoch-timestamped trace. Refuse clock steps rather than guessing an offset.
  let epochWindow = null;
  if (o.startedEpochMs !== undefined || o.finishedEpochMs !== undefined) {
    memoryRequire(Number.isSafeInteger(o.startedEpochMs) && o.startedEpochMs > 0
      && Number.isSafeInteger(o.finishedEpochMs) && o.finishedEpochMs >= o.startedEpochMs,
    'invalid exec epoch clock');
    const elapsedMs = Number(BigInt(o.finishedMonotonicNs)-BigInt(o.startedMonotonicNs))/1e6;
    memoryRequire(Math.abs(o.finishedEpochMs-o.startedEpochMs-elapsedMs) <= 2,
      'exec epoch/monotonic clocks diverged');
    epochWindow = {startedEpochMs:o.startedEpochMs,finishedEpochMs:o.finishedEpochMs};
  }
  const stable = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  memoryRequire(Array.isArray(o.tasksBefore) && o.tasksBefore.length === 1
    && o.tasksBefore[0].taskId === identity.processId && o.tasksBefore[0].state === 't'
    && o.tasksBefore[0].startTimeTicks === identity.startTimeTicks
    && o.tasksBefore[0].tracerProcessId === tracerIdentity.processId && stable(o.tasksBefore,o.tasksAfter),
  'exec target task changed or not singly ptrace-stopped');
  const tracerTasks = o.tracer.tasksBefore;
  memoryRequire(Array.isArray(tracerTasks) && tracerTasks.length > 0 && tracerTasks.length <= 10000
    && new Set(tracerTasks.map(t => t.taskId)).size === tracerTasks.length
    && tracerTasks.every(t => Number.isSafeInteger(t.taskId) && t.taskId > 0 && t.state === 'T'
      && /^[1-9]\d*$/.test(t.startTimeTicks))
    && tracerTasks.some(t => t.taskId === tracerIdentity.processId && t.startTimeTicks === tracerIdentity.startTimeTicks)
    && stable(tracerTasks,o.tracer.tasksAfter), 'exec tracer tasks changed or not stopped');
  memoryRequire(o.syscallBefore === o.syscallAfter && o.mapsBefore === o.mapsAfter
    && Buffer.isBuffer(o.auxvBefore) && Buffer.isBuffer(o.auxvAfter) && o.auxvBefore.equals(o.auxvAfter),
  'exec syscall/maps/auxv changed');
  const syscall = o.syscallBefore.trim().split(/\s+/);
  memoryRequire(syscall.length === 9 && ['59','322'].includes(syscall[0])
    && syscall.slice(1).every(word => /^0x[0-9a-f]+$/.test(word)), 'not an x86-64 exec syscall stop');
  const pc = BigInt(syscall[8]), auxv = execEntryAuxv(o.auxvBefore), maps = executableMaps(o.mapsBefore);
  const address = execEntryHeaderAddress(auxv,maps,identity), header = o.elfHeader?.bytes;
  memoryRequire(o.elfHeader?.address === '0x'+address.toString(16) && Buffer.isBuffer(header)
    && header.length === 64 && header.subarray(0,7).equals(Buffer.from([0x7f,69,76,70,2,1,1]))
    && header.readUInt16LE(18) === 62 && header.readUInt32LE(20) === 1
    && header.readUInt16LE(52) === 64, 'invalid x86-64 exec ELF header');
  const type = header.readUInt16LE(16), entry = header.readBigUInt64LE(24);
  memoryRequire((auxv.base > 0n ? type === 3 : [2,3].includes(type)) && entry > 0n,
    'unsupported exec ELF type or entry');
  const expectedPc = entry + (type === 3 ? address : 0n);
  memoryRequire(expectedPc < 1n<<64n && pc === expectedPc, 'instruction pointer is not the kernel ELF entry');
  const headerMap = maps.find(m => m.start <= address && m.end >= address+64n && m.permissions[0] === 'r'
    && BigInt(m.offset)+address-m.start === 0n && BigInt(m.inode) > 0n);
  const entryMap = maps.find(m => m.start <= pc && m.end > pc && m.permissions[2] === 'x');
  memoryRequire(headerMap && entryMap && entryMap.device === headerMap.device && entryMap.inode === headerMap.inode,
    'exec entry is not in the mapped ELF');
  memoryRequire(maps.some(m => m.start <= auxv.entry && m.end > auxv.entry
    && m.permissions[2] === 'x' && m.path === identity.executable && BigInt(m.inode) > 0n),
  'auxv program entry is not mapped to the expected executable');
  return {schema:'runtime-exec-entry-binding/v1',process:{...identity},
    instructionPointer:'0x'+pc.toString(16),programEntry:'0x'+auxv.entry.toString(16),
    interpreterBase:'0x'+auxv.base.toString(16),epochWindow,mapsSha256:memoryHash(o.mapsBefore),
    auxvSha256:memoryHash(o.auxvBefore),elfHeaderSha256:memoryHash(header),
    mappings:maps.map(memoryMapDescriptor),kernelEntryObserved:true,
    mappingPopulationComplete:false,executableBytesQualified:false,completeRuntimeClosureVerified:false,
    scope:'one independently stopped x86-64 exec entry snapshot; byte origin, aliases and lifetime custody unqualified'};
}
function selectedMemoryRanges(ranges) {
  memoryRequire(Array.isArray(ranges) && ranges.length > 0 && ranges.length <= 256, 'invalid selected ranges');
  const seen = new Set();
  let bytes = 0;
  return ranges.map(range => {
    memoryRequire(range && /^[1-9]\d*$/.test(range.codeIndex) && !seen.has(range.codeIndex)
      && /^0x[1-9a-f][a-f0-9]*$/.test(range.address)
      && Number.isSafeInteger(range.size) && range.size > 0 && range.size <= 1024*1024
      && (bytes += range.size) <= 16*1024*1024, 'invalid selected range');
    seen.add(range.codeIndex);
    const address = BigInt(range.address);
    // Node's positioned fs.readSync uses a JS number on this path.
    memoryRequire(address+BigInt(range.size) <= BigInt(Number.MAX_SAFE_INTEGER), 'unsupported memory address');
    return {...range,addressValue:address};
  });
}
const memoryMapDescriptor = map => ({start:'0x'+map.start.toString(16),end:'0x'+map.end.toString(16),
  permissions:map.permissions,offset:map.offset,device:map.device,inode:map.inode,path:map.path});
// These are candidates from ONE process's stopped maps, not physical-page
// identity or an alias-exclusion proof. Private/COW mappings can still appear
// here; anonymous aliases, other processes and external writers remain unknown.
function writableMappingCandidates(writableMaps, selected, start, end, budget) {
  const candidates = [], selectedOffset = BigInt(selected.offset) + start - selected.start;
  for (const map of writableMaps) {
    let selectedAddress = start, candidateAddress = start, bytes = end - start;
    if (map !== selected) {
      if (BigInt(selected.inode) === 0n || selected.device !== map.device || selected.inode !== map.inode) continue;
      const offset = BigInt(map.offset), offsetEnd = offset + map.end - map.start;
      const overlapStart = selectedOffset > offset ? selectedOffset : offset;
      const selectedEnd = selectedOffset + end - start;
      const overlapEnd = selectedEnd < offsetEnd ? selectedEnd : offsetEnd;
      if (overlapStart >= overlapEnd) continue;
      selectedAddress = start + overlapStart - selectedOffset;
      candidateAddress = map.start + overlapStart - offset;
      bytes = overlapEnd - overlapStart;
    }
    memoryRequire(budget.remaining-- > 0, 'writable mapping candidate limit');
    candidates.push({kind:map === selected ? 'selected-mapping-writable' : 'matching-file-offset',
      mapping:memoryMapDescriptor(map),overlap:{selectedAddress:'0x'+selectedAddress.toString(16),
        candidateAddress:'0x'+candidateAddress.toString(16),bytes:Number(bytes)},sharedPhysicalBytesVerified:false});
  }
  return candidates;
}
// Coverage is restricted to these stopped maps. Even zero unobserved bytes
// cannot establish earlier mappings, source origin or continuous custody.
function executableMappingCoverage(maps, bindings) {
  const executable = maps.filter(map => map.permissions[2] === 'x');
  memoryRequire(executable.length <= 4096, 'executable mapping coverage limit');
  const selectedByMap = new Map();
  for (const binding of bindings) {
    const key = binding.mapping.start;
    if (!selectedByMap.has(key)) selectedByMap.set(key, []);
    selectedByMap.get(key).push({codeIndex:binding.codeIndex,address:binding.address,bytes:binding.bytes});
  }
  let total = 0n, observed = 0n;
  const mappings = executable.map(map => {
    const mapping = memoryMapDescriptor(map), selectedRanges = selectedByMap.get(mapping.start) ?? [];
    selectedRanges.sort((a,b) => BigInt(a.address) < BigInt(b.address) ? -1 : 1);
    const bytes = map.end - map.start;
    const selectedBytes = selectedRanges.reduce((sum,range) => sum + BigInt(range.bytes), 0n);
    total += bytes; observed += selectedBytes;
    return {mapping,selectedRanges,observedBytes:selectedBytes.toString(),
      unobservedBytes:(bytes-selectedBytes).toString()};
  });
  return {mappings,totalBytes:total.toString(),observedBytes:observed.toString(),
    unobservedBytes:(total-observed).toString(),
    scope:'selected byte coverage of executable mappings in the retained stopped snapshot only'};
}
/** Retain parent-read raw maps/tasks/bytes from a stopped direct child. The
 * default requires group-stops; the explicit ptrace path additionally requires
 * an independently pinned, group-stopped tracer. The caller owns stop/cleanup. Endpoint
 * observations do not prove continuous custody or rule out writable aliases. */
export function observeRuntimeExecutableMemory(identity, ranges, tracerIdentity) {
  const selected = selectedMemoryRanges(ranges);
  memoryRequire(identity?.parentProcessId === process.pid, 'not the observer direct child');
  const root = '/proc/'+identity.processId;
  const startedMonotonicNs = process.hrtime.bigint().toString();
  memoryRequire(sameProcess(procIdentity(root,identity.processId),identity), 'launch identity changed');
  const tracerTasksBefore = tracerIdentity ? stoppedTracer(tracerIdentity,identity) : undefined;
  const tasksBefore = stoppedTasks(root,tracerIdentity), mapsBefore = fs.readFileSync(root+'/maps','utf8');
  const maps = executableMaps(mapsBefore);
  const fd = fs.openSync(root+'/mem','r');
  let samples;
  try {
    samples = selected.map(range => {
      memoryRequire(maps.some(map => map.start <= range.addressValue
        && map.end >= range.addressValue+BigInt(range.size) && map.permissions[2] === 'x'),
      'selected range lacks kernel executable mapping');
      const bytes = Buffer.alloc(range.size);
      memoryRequire(fs.readSync(fd,bytes,0,bytes.length,Number(range.addressValue)) === bytes.length,
        'short memory read');
      return {codeIndex:range.codeIndex,address:range.address,bytes};
    });
  } finally {fs.closeSync(fd);}
  const mapsAfter = fs.readFileSync(root+'/maps','utf8'), tasksAfter = stoppedTasks(root,tracerIdentity);
  const tracerTasksAfter = tracerIdentity ? stoppedTracer(tracerIdentity,identity) : undefined;
  memoryRequire(mapsBefore === mapsAfter && JSON.stringify(tasksBefore) === JSON.stringify(tasksAfter)
    && JSON.stringify(tracerTasksBefore) === JSON.stringify(tracerTasksAfter)
    && sameProcess(procIdentity(root,identity.processId),identity), 'process/maps/tasks changed during observation');
  return {schema:'runtime-selected-executable-memory/v1', process:{...identity}, observerProcessId:process.pid,
    startedMonotonicNs,finishedMonotonicNs:process.hrtime.bigint().toString(),
    tasksBefore,tasksAfter,mapsBefore,mapsAfter,samples,
    ...(tracerIdentity ? {tracer:{process:{...tracerIdentity},tasksBefore:tracerTasksBefore,tasksAfter:tracerTasksAfter}} : {})};
}

/** Reparse retained dump AND independent raw memory evidence after terminal EOF.
 * Only selected code indices at the observation time are qualified. An emitted
 * name, matching URL, or matching bytes does not establish original JS origin. */
export function bindRuntimeJitMemory(bytes, witness, observation, expectedIdentity, expectedTracer) {
  const dump = bindRuntimeJitDump(bytes,witness), sample = observation;
  memoryRequire(sample?.schema === 'runtime-selected-executable-memory/v1'
    && sameProcess(sample.process,expectedIdentity)
    && sample.process.processId === witness.processId
    && Number.isSafeInteger(sample.observerProcessId) && sample.observerProcessId > 0
    && sample.observerProcessId !== witness.processId
    && sample.process.parentProcessId === sample.observerProcessId
    && /^[1-9]\d*$/.test(sample.process.startTimeTicks)
    && typeof sample.process.executable === 'string' && sample.process.executable.startsWith('/'),
  'independent launch/observer identity differs');
  memoryRequire(/^[1-9]\d*$/.test(sample.startedMonotonicNs)
    && /^[1-9]\d*$/.test(sample.finishedMonotonicNs), 'invalid observation clock');
  const before = BigInt(sample.startedMonotonicNs), after = BigInt(sample.finishedMonotonicNs);
  memoryRequire(before <= after && before >= BigInt(witness.startedMonotonicNs)
    && after <= BigInt(witness.finishedMonotonicNs), 'observation outside witnessed lifetime');
  const tracer = sample.tracer;
  memoryRequire(Boolean(tracer) === Boolean(expectedTracer), 'missing independent tracer identity');
  if (tracer) {
    const tasks = tracer.tasksBefore;
    memoryRequire(sameProcess(tracer.process,expectedTracer)
      && Number.isSafeInteger(tracer.process.processId) && tracer.process.processId > 0
      && tracer.process.processId !== sample.observerProcessId && tracer.process.processId !== witness.processId
      && /^[1-9]\d*$/.test(tracer.process.startTimeTicks)
      && typeof tracer.process.executable === 'string' && tracer.process.executable.startsWith('/')
      && Number.isSafeInteger(tracer.process.parentProcessId) && tracer.process.parentProcessId > 0
      && Array.isArray(tasks) && tasks.length > 0 && tasks.length <= 10000
      && JSON.stringify(tasks) === JSON.stringify(tracer.tasksAfter)
      && new Set(tasks.map(task=>task.taskId)).size === tasks.length
      && tasks.every(task=>Number.isSafeInteger(task.taskId) && task.taskId > 0
        && task.state === 'T' && /^[1-9]\d*$/.test(task.startTimeTicks))
      && tasks.find(task=>task.taskId === tracer.process.processId)?.startTimeTicks === tracer.process.startTimeTicks,
    'independent stopped tracer differs');
  }
  memoryRequire(Array.isArray(sample.tasksBefore) && sample.tasksBefore.length > 0
    && sample.tasksBefore.length <= 10000
    && JSON.stringify(sample.tasksBefore) === JSON.stringify(sample.tasksAfter)
    && new Set(sample.tasksBefore.map(task=>task.taskId)).size === sample.tasksBefore.length
    && sample.tasksBefore.some(task=>task.taskId === witness.processId)
    && sample.tasksBefore.every(task=>witness.taskIds.includes(task.taskId)
      && (tracer ? task.state === 't' && task.tracerProcessId === tracer.process.processId : task.state === 'T')
      && /^[1-9]\d*$/.test(task.startTimeTicks))
    && sample.tasksBefore.find(task=>task.taskId === witness.processId).startTimeTicks === expectedIdentity.startTimeTicks,
  'stopped task population differs');
  memoryRequire(sample.mapsBefore === sample.mapsAfter, 'kernel maps changed');
  const maps = executableMaps(sample.mapsBefore);
  const writableMaps = maps.filter(map => map.permissions[1] === 'w');
  const candidateBudget = {remaining:4096};
  memoryRequire(Array.isArray(sample.samples), 'missing memory samples');
  const selected = selectedMemoryRanges(sample.samples.map(row=>({...row,size:row.bytes?.length})));
  // The raw dump orders MOVE against an existing load, but a clock inversion
  // would let time-sorting resurrect an old address. Refuse that ambiguity.
  const codeClocks = new Map(dump.loads.map(load=>[load.codeIndex,BigInt(load.timestampNs)]));
  for (const move of dump.moves) {
    memoryRequire(BigInt(move.timestampNs) > codeClocks.get(move.codeIndex), 'ambiguous per-code event clock');
    codeClocks.set(move.codeIndex,BigInt(move.timestampNs));
  }
  const events = [...dump.loads.map(load=>({...load,kind:'load'})),
    ...dump.moves.map(move=>({...move,kind:'move'}))]
    .sort((a,b)=>BigInt(a.timestampNs) < BigInt(b.timestampNs) ? -1 : BigInt(a.timestampNs) > BigInt(b.timestampNs) ? 1 : 0);
  const active = new Map();
  for (const event of events) {
    if (BigInt(event.timestampNs) >= before) continue;
    if (event.kind === 'load') active.set(event.codeIndex,{...event});
    else if (active.has(event.codeIndex)) active.get(event.codeIndex).address = event.to;
  }
  const bindings = selected.map(row => {
    const load = active.get(row.codeIndex), start = row.addressValue, end = start+BigInt(row.size);
    memoryRequire(load && load.address === row.address && load.bytes === row.size
      && Buffer.isBuffer(row.bytes) && memoryHash(row.bytes) === load.sha256, 'selected JIT bytes/address differ');
    const overlaps = (address,size)=>BigInt(address) < end && BigInt(address)+BigInt(size) > start;
    memoryRequire(![...active.values()].some(other=>other.codeIndex !== row.codeIndex
      && overlaps(other.address,other.bytes)), 'ambiguous overlapping emitted code');
    memoryRequire(!events.some(event=>BigInt(event.timestampNs) >= before && BigInt(event.timestampNs) <= after
      && (event.codeIndex === row.codeIndex || overlaps(event.address ?? event.from,event.bytes)
        || event.to && overlaps(event.to,event.bytes))), 'code changed during memory observation');
    const map = maps.find(map=>map.start <= start && map.end >= end && map.permissions[2] === 'x');
    memoryRequire(map, 'selected range lacks kernel executable mapping');
    return {codeIndex:row.codeIndex,address:row.address,bytes:row.size,sha256:load.sha256,
      mapping:memoryMapDescriptor(map),
      writableMappingCandidates:writableMappingCandidates(writableMaps,map,start,end,candidateBudget)};
  });
  return {schema:'runtime-jit-selected-memory-binding/v1',processId:witness.processId,
    dumpSha256:dump.sha256,mapsSha256:memoryHash(sample.mapsBefore),
    startedMonotonicNs:sample.startedMonotonicNs,finishedMonotonicNs:sample.finishedMonotonicNs,bindings,
    executableMappingCoverage:executableMappingCoverage(maps,bindings),
    selectedExecutableBytesVerified:true, emittedLoadsNotSampled:dump.loads.length-bindings.length,
    mappingPopulationComplete:false,executableBytesQualified:false,completeRuntimeClosureVerified:false,
    jitByteOriginQualification:'required',runtimeCaptureCustody:'required',creatorFence:'required',
    writableAliasQualification:'required',scope:'selected stopped-process memory ranges at the retained observation interval only'};
}

/** Read the tracer parent's actual host page size before launching the child.
 * This is a local observation, not a value supplied by the traced program.
 * Call only when parent and tracee use the same Linux kernel/page-size ABI.
 */
export function observeRuntimePageSize() {
  // Linux AT_PAGESZ (include/uapi/linux/auxvec.h) is the kernel's own
  // observation for this process. Read it directly rather than starting getconf.
  const wordBytes = ['ia32','arm'].includes(process.arch) ? 4
    : ['x64','arm64','ppc64','s390x','riscv64','loong64'].includes(process.arch) ? 8 : 0;
  memoryRequire(process.platform === 'linux' && wordBytes > 0, 'unsupported page size ABI');
  const bytes = fs.readFileSync('/proc/self/auxv'), stride = wordBytes*2;
  memoryRequire(bytes.length >= stride && bytes.length % stride === 0, 'invalid page size auxv extent');
  const read = offset => wordBytes === 8
    ? (endianness() === 'LE' ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset))
    : BigInt(endianness() === 'LE' ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset));
  let page = NaN, terminated = false;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    const key = read(offset), value = read(offset+wordBytes);
    if (key === 0n) {
      memoryRequire(value === 0n && offset+stride === bytes.length, 'invalid page size auxv terminator');
      terminated = true;
    } else if (key === 6n) {
      memoryRequire(Number.isNaN(page) && value <= BigInt(Number.MAX_SAFE_INTEGER), 'invalid page size auxv value');
      page = Number(value);
    }
  }
  memoryRequire(terminated, 'unterminated page size auxv');
  if (!Number.isSafeInteger(page) || page < 1024 || !Number.isInteger(Math.log2(page)))
    throw new Error('invalid independently observed runtime page size');
  return page;
}

/** Bind the byte payloads actually retained in a Linux perf jitdump. Format:
 * tools/perf/Documentation/jitdump-specification.txt in the Linux source tree.
 * A runtime's CODE_LOAD is a report of emitted bytes, not an independent read
 * of executable memory, a parsed-source join, or an exhaustive code census.
 * MOVE records contain no bytes and cannot certify the destination contents.
 * The caller must independently retain the terminal task/clock/ELF witness.
 * @param {Buffer} bytes
 * @param {{processId:number, taskIds:number[], elfMachine:number,
 *   startedMonotonicNs:string, finishedMonotonicNs:string,
 *   headerClock?:'monotonic-nanoseconds'|'v8-realtime-microseconds',
 *   startedEpochMs?:number, finishedEpochMs?:number,
 *   exitCode:number, signal:string|null, eof:boolean, captureStartedBeforeExec:boolean}} witness
 */
export function bindRuntimeJitDump(bytes, witness) {
  const require = (condition, message) => { if (!condition) throw new Error('runtime jitdump: '+message); };
  const hash = value => createHash('sha256').update(value).digest('hex');
  require(Buffer.isBuffer(bytes) && bytes.length >= 40 && bytes.length <= 64*1024*1024, 'invalid byte extent');
  require(witness.exitCode === 0 && witness.signal === null && witness.eof === true
    && witness.captureStartedBeforeExec === true, 'incomplete terminal capture');
  require(Number.isSafeInteger(witness.processId) && witness.processId > 0
    && Number.isSafeInteger(witness.elfMachine) && witness.elfMachine > 0
    && Array.isArray(witness.taskIds) && witness.taskIds.includes(witness.processId)
    && witness.taskIds.every(id => Number.isSafeInteger(id) && id > 0)
    && new Set(witness.taskIds).size === witness.taskIds.length, 'invalid independent process/ELF witness');
  require(/^\d+$/.test(witness.startedMonotonicNs) && /^\d+$/.test(witness.finishedMonotonicNs), 'invalid clock witness');
  const before = BigInt(witness.startedMonotonicNs), after = BigInt(witness.finishedMonotonicNs);
  require(before <= after, 'reversed clock witness');
  const little = bytes.readUInt32LE(0) === 0x4a695444;
  require(little || bytes.readUInt32BE(0) === 0x4a695444, 'magic differs');
  const u32 = offset => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const u64 = offset => little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset);
  const hex = value => '0x'+value.toString(16), addressLimit = 1n << 64n;
  // The reserved word is opaque, not a zero assertion. V8 writes DEADBEEF.
  require(u32(4) === 1 && u32(8) === 40, 'unsupported header');
  require(u32(12) === witness.elfMachine && u32(20) === witness.processId, 'header process/architecture differs');
  require(u64(32) === 0n, 'unsupported timestamp clock/flags');
  const created = u64(24);
  const headerClock = witness.headerClock ?? 'monotonic-nanoseconds';
  require(headerClock === 'monotonic-nanoseconds' || headerClock === 'v8-realtime-microseconds', 'unsupported header clock');
  if (headerClock === 'v8-realtime-microseconds') {
    // V8 perf-jit.cc writes realtime microseconds in the header, but uses
    // TimeTicks nanoseconds for records. Never infer that dialect from an
    // out-of-range timestamp: require an explicit independent wall witness.
    require(Number.isSafeInteger(witness.startedEpochMs) && witness.startedEpochMs > 0
      && Number.isSafeInteger(witness.finishedEpochMs) && witness.finishedEpochMs >= witness.startedEpochMs,
    'invalid realtime header witness');
    require(created >= BigInt(witness.startedEpochMs)*1000n
      && created < (BigInt(witness.finishedEpochMs)+1n)*1000n, 'header outside observed realtime lifetime');
  } else require(created >= before && created <= after, 'header outside observed lifetime');
  const recordStart = headerClock === 'monotonic-nanoseconds' ? created : before;
  const loads = [], moves = [], metadata = [], current = new Map();
  let offset = 40, recordCount = 0, closed = false;
  while (offset < bytes.length) {
    require(!closed && bytes.length-offset >= 16 && ++recordCount <= 100000, 'trailing/incomplete record or record limit');
    const id = u32(offset), size = u32(offset+4), timestamp = u64(offset+8);
    require(size >= 16 && size <= bytes.length-offset, 'record extent differs');
    require(timestamp >= recordStart && timestamp <= after, 'record outside observed lifetime');
    const end = offset+size, body = offset+16;
    if (id === 0 || id === 1) {
      require(size >= (id === 0 ? 57 : 64), 'short code record');
      const pid = u32(body), tid = u32(body+4), vma = u64(body+8), address = u64(body+16);
      require(pid === witness.processId && witness.taskIds.includes(tid), 'code process/task differs');
      const codeSize = u64(body+(id === 0 ? 24 : 32)), index = u64(body+(id === 0 ? 32 : 40)).toString();
      require(codeSize > 0n && vma > 0n && address > 0n && vma+codeSize <= addressLimit
        && address+codeSize <= addressLimit, 'invalid code range');
      if (id === 0) {
        const nameEnd = bytes.indexOf(0, body+40);
        require(nameEnd >= body+40 && nameEnd < end && BigInt(end-nameEnd-1) === codeSize, 'name/code payload extent differs');
        require(!current.has(index), 'duplicate code index');
        const code = {taskId:tid, codeIndex:index, address:hex(address), virtualAddress:hex(vma),
          bytes:Number(codeSize), sha256:hash(bytes.subarray(nameEnd+1,end)),
          nameSha256:hash(bytes.subarray(body+40,nameEnd)), timestampNs:timestamp.toString(),
          byteOffset:nameEnd+1};
        loads.push(code); current.set(index,{address,codeSize});
      } else {
        require(size === 64, 'move extent differs');
        const destination = u64(body+24), prior = current.get(index);
        require(prior && prior.address === address && prior.codeSize === codeSize
          && destination > 0n && destination+codeSize <= addressLimit, 'move lacks matching prior load/address/size');
        moves.push({taskId:tid, codeIndex:index, from:hex(address), to:hex(destination),
          virtualAddress:hex(vma), bytes:Number(codeSize), timestampNs:timestamp.toString(),
          destinationBytesObserved:false});
        current.set(index,{address:destination,codeSize});
      }
    } else if (id === 2 || id === 4) {
      // Keep debug/unwind records opaque. Neither names nor debug paths grant
      // source provenance; the dump digest retains their exact byte identity.
      require(size >= (id === 2 ? 32 : 40), 'short metadata record');
      metadata.push({kind:id, bytes:size, sha256:hash(bytes.subarray(offset,end))});
    } else if (id === 3) {
      require(size === 16, 'close extent differs'); closed = true;
    } else require(false, 'unsupported record kind');
    offset = end;
  }
  require(loads.length > 0, 'no emitted code bytes');
  return {schema:'runtime-jitdump-code-bytes/v1', processId:witness.processId, elfMachine:witness.elfMachine,
    endianness:little ? 'little' : 'big', bytes:bytes.length, sha256:hash(bytes),
    headerTimestamp:created.toString(), headerClock,
    recordClock:'monotonic-nanoseconds', recordCount, closeRecordObserved:closed, loads, moves, metadata,
    byteEvidence:'runtime-reported-code-load-payloads', jitByteOriginQualification:'required',
    executableMemoryQualification:'required', runtimeCaptureCustody:'required', creatorFence:'required',
    completeRuntimeClosureVerified:false};
}

/** Inspect retained strace -f -ttt -yy output. Successful opens are evidence of
 * access, not proof of which bytes were read. Join with stable pre/post hashes.
 * Fail closed on unfinished or unsupported open records, never infer from a
 * filename appearing in an argv, a failed open, or another process's output. */
export function runtimeFileTraceArguments(output, command, options) {
  // -q suppresses attach chatter. -qq also suppresses the terminal records
  // that bindRuntimeModelOpens requires and therefore cannot qualify a run.
  const args = ['-f', '-q', '-ttt', '-T', '-yy', '-s', '4096', '-e',
    'trace=openat,openat2,mmap,mprotect,pkey_mprotect,munmap,mremap,shmat,shmdt,remap_file_pages,execve,execveat,clone,clone3,fork,vfork,exit,exit_group',
    '-o', output];
  if (options !== undefined) {
    memoryRequire(Number.isSafeInteger(options.execEntryDelayMs) && options.execEntryDelayMs >= 1000
      && options.execEntryDelayMs <= 30000 && Array.isArray(command) && command.length > 0
      && command.every(arg => typeof arg === 'string' && !arg.includes('\0')) && command[0].startsWith('/'),
    'invalid exec entry trace options');
    // strace's own initial exec does not provide this delay. A positional shell
    // exec supplies the subsequent boundary without interpreting target args.
    args.unshift('-D');
    args.push('-e','inject=execve,execveat:delay_exit='+options.execEntryDelayMs+'ms',
      '/bin/sh','-c','exec "$@"','runtime-exec-entry');
  }
  return [...args, ...command];
}

function parseRuntimeFileTrace(text) {
  const pending = new Map(), lines = [], edges = [];
  const nanoseconds = value => {
    const [seconds, fraction] = value.split('.');
    return {value:BigInt(seconds) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0')),
      precision:10n ** BigInt(9 - fraction.length)};
  };
  for (const line of text.split('\n').filter(Boolean)) {
    const match = /^(\d+)\s+(\d+\.\d{1,9})\s+(.*)$/.exec(line);
    if (!match) throw new Error('unsupported strace record');
    const tid = Number(match[1]);
    const printedTime = nanoseconds(match[2]);
    let startedAtNs = printedTime.value, startPrecision = printedTime.precision;
    let completedAtNs = printedTime.value;
    let call = match[3];
    const elapsed = / <(\d+\.\d{1,9})>$/.exec(call);
    const duration = elapsed ? nanoseconds(elapsed[1]) : null;
    if (elapsed) call = call.slice(0, elapsed.index);
    // Delay injection is confined to exec exit in the entry collector. Keep
    // accepting the measured successful exec; other injected outcomes remain
    // unsupported by their existing strict readers.
    if (/^(?:execve|execveat)\(.*\)\s+=\s+0 \(DELAYED\)$/.test(call))
      call = call.slice(0,-10);
    if (call.endsWith('<unfinished ...>')) {
      if (pending.has(tid)) throw new Error('duplicate unfinished strace record');
      pending.set(tid, {call:call.slice(0, -16), startedAtNs, startPrecision}); continue;
    }
    if (call.startsWith('<... ')) {
      const resumed = /^<\.\.\. (\w+) resumed>(.*)$/.exec(call), start = pending.get(tid);
      if (!resumed || !start || !start.call.startsWith(resumed[1] + '('))
        throw new Error('unmatched resumed strace record');
      pending.delete(tid); call = start.call + resumed[2];
      startedAtNs = start.startedAtNs; startPrecision = start.startPrecision;
    }
    if (duration) {
      // The printed timestamp is syscall entry, including when strace emits a
      // complete line. Never treat it as a zero-duration completion. Keep an
      // upper bound for BOTH printed precisions, and compare exact integers at
      // epoch-sized timestamps (Number milliseconds can round these apart).
      const upper = startedAtNs + startPrecision + duration.value + duration.precision;
      completedAtNs += printedTime.precision;
      if (upper > completedAtNs) completedAtNs = upper;
    }
    const clone = /^(?:clone|clone3|fork|vfork)\(.*\)\s+=\s+(\d+)\b/.exec(call);
    if (clone) edges.push([tid, Number(clone[1])]);
    lines.push({tid, atMs:Number(startedAtNs) / 1e6, completedAtMs:Number(completedAtNs) / 1e6,
      startedAtNs, completedAtNs, durationNs:duration ? String(duration.value) : null, call});
  }
  if (pending.size) throw new Error('incomplete strace capture');
  return { lines, edges };
}

/** Replay only mapping metadata whose syscall semantics and ordering are known.
 * This deliberately never qualifies executable bytes: writable aliases, JIT
 * stores, kernel-installed exec mappings and file mutation need other witnesses.
 * pageSizeBytes must be supplied by the independent launcher's host witness;
 * guessing 4096 silently loses the tail of mappings on other Linux page sizes.
 */
function replayRuntimeMappings(lines, processId, pageSizeBytes, execEntries = []) {
  const gaps = [], executableRanges = [], changes = [], spaces = [], tasks = new Map();
  let recordedRanges = 0, budgetExceeded = false;
  const page = Number.isSafeInteger(pageSizeBytes) && pageSizeBytes >= 1024
    && Number.isInteger(Math.log2(pageSizeBytes)) ? BigInt(pageSizeBytes) : null;
  const hex = value => '0x' + value.toString(16);
  const gap = (row, reason) => gaps.push({taskId:row.tid, atMs:row.atMs, reason});
  const events = lines.filter(row => /^(?:mmap|mprotect|pkey_mprotect|munmap|mremap|shmat|shmdt|remap_file_pages)\(/.test(row.call)
    || /^(?:execve|execveat|clone|clone3|fork|vfork)\(/.test(row.call)
      && !/\)\s+=\s+-1\b/.test(row.call))
    .sort((a, b) => a.startedAtNs < b.startedAtNs ? -1 : a.startedAtNs > b.startedAtNs ? 1 : 0);
  memoryRequire(Array.isArray(execEntries) && execEntries.length <= 256, 'invalid exec entry population');
  const initialMaps = new Map();
  const nextTaskEvent = new Map(), currentTime = new Map(), nextTime = new Map();
  if (execEntries.length) for (const row of [...lines].sort((a,b) =>
    a.startedAtNs > b.startedAtNs ? -1 : a.startedAtNs < b.startedAtNs ? 1 : 0)) {
    if (currentTime.get(row.tid) !== row.startedAtNs) {
      nextTime.set(row.tid,currentTime.get(row.tid));currentTime.set(row.tid,row.startedAtNs);
    }
    nextTaskEvent.set(row,nextTime.get(row.tid));
  }
  for (const entry of execEntries) {
    const binding = bindRuntimeExecEntry(entry?.observation,entry?.identity,entry?.tracerIdentity);
    memoryRequire(binding.process.processId === processId && binding.epochWindow && page,
      'exec entry lacks root identity, epoch window or page size');
    const {startedEpochMs,finishedEpochMs} = binding.epochWindow;
    // strace -T EXCLUDES an injected exit delay. The independently validated
    // kernel-entry stop must follow the exec's measured completion and precede
    // the next recorded event on that task. Never stretch the syscall duration
    // to the delay setting or use a later mapping snapshot as an initial one.
    // Date.now floors: enclose its entire millisecond uncertainty as well.
    const start = BigInt(startedEpochMs)*1_000_000n, end = BigInt(finishedEpochMs+1)*1_000_000n;
    const matches = events.filter(row => row.tid === processId && /^execve(?:at)?\(/.test(row.call)
      && /\)\s+=\s+0$/.test(row.call) && row.durationNs !== null && row.completedAtNs <= start
      && nextTaskEvent.has(row) && nextTaskEvent.get(row) >= end);
    memoryRequire(matches.length === 1 && !initialMaps.has(matches[0]), 'exec entry trace occurrence is not unique');
    const row = matches[0];
    const path = /^execve\(("(?:\\.|[^"\\])*"),/.exec(row.call)
      ?? /^execveat\([^,]+, ("(?:\\.|[^"\\])*"),/.exec(row.call);
    let executable;
    try {executable = path && JSON.parse(path[1]);} catch { /* refused below */ }
    memoryRequire(executable === binding.process.executable, 'exec entry trace executable differs');
    const maps = executableMaps(entry.observation.mapsBefore);
    memoryRequire(maps.length <= 8192 && maps.every(m => m.start % page === 0n && m.end % page === 0n
      && BigInt(m.offset) % page === 0n), 'exec entry mapping alignment or population differs');
    initialMaps.set(row,{binding,maps});
  }
  const consumedEntries = new Set();
  const makeSpace = maps => {
    const space = {id:spaces.length + 1, maps:[...maps], uncertain:false};
    spaces.push(space); return space;
  };
  tasks.set(processId, makeSpace([]));
  if (!page) gap({tid:processId, atMs:events[0]?.atMs ?? null}, 'independent-host-page-size-required');
  const number = value => /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value) ? BigInt(value) : null;
  const rounded = value => {
    const n = number(value);
    return n !== null && n > 0n ? ((n + page - 1n) / page) * page : null;
  };
  const range = (start, length) => {
    const a = number(start), size = rounded(length);
    return a !== null && a % page === 0n && size !== null && a + size <= (1n << 64n)
      ? {start:a, end:a + size} : null;
  };
  const permissions = value => {
    const flags = value.split('|');
    return flags.length && flags.every(flag => ['PROT_NONE','PROT_READ','PROT_WRITE','PROT_EXEC'].includes(flag))
      && (!flags.includes('PROT_NONE') || flags.length === 1) ? value : null;
  };
  const cut = (map, start, end) => ({...map, start, end,
    origin:{...map.origin, offsetBytes:map.origin.offsetBytes === null ? null
      : map.origin.offsetBytes + start - map.start}});
  const serial = map => ({start:hex(map.start), end:hex(map.end), permissions:map.permissions,
    origin:{...map.origin, offsetBytes:map.origin.offsetBytes === null ? null : String(map.origin.offsetBytes)},
    executableBytesQualified:false});
  const remove = (space, bounds) => {
    space.maps = space.maps.flatMap(map => map.end <= bounds.start || map.start >= bounds.end ? [map]
      : [map.start < bounds.start ? cut(map, map.start, bounds.start) : null,
        map.end > bounds.end ? cut(map, bounds.end, map.end) : null].filter(Boolean));
  };
  const invalidate = (row, space, reason) => {
    gap(row, reason); space.maps = []; space.uncertain = true;
  };
  const record = (row, space, operation, maps) => {
    recordedRanges += maps.length;
    if (recordedRanges > 100_000) {
      gap(row, 'mapping-replay-population-limit'); budgetExceeded = true; return;
    }
    changes.push({taskId:row.tid, addressSpaceId:space.id, atMs:row.atMs,
      completedAtMs:row.completedAtMs, operation, ranges:maps.map(serial)});
    for (const map of maps) if (map.permissions.split('|').includes('PROT_EXEC'))
      executableRanges.push({taskId:row.tid, addressSpaceId:space.id, atMs:row.atMs,
        completedAtMs:row.completedAtMs, operation, ...serial(map), byteOriginQualification:'required'});
  };
  // These narrow operations commute only on disjoint, page-rounded extents.
  // Returned allocation addresses are observations; hints are not reservations.
  // Keep file mappings, fixed replacement, failed or unsupported permission
  // changes, remaps and task lifecycle changes as barriers.
  const independentRange = row => {
    if (!page || !tasks.has(row.tid)) return null;
    const call = /^(mmap|munmap|mprotect)\((.*)\)\s+=\s+(0x[0-9a-f]+|0)$/i.exec(row.call);
    if (!call) return null;
    const [, operation, args, result] = call, fields = args.split(', ').map(field => field.trim());
    if (operation === 'munmap')
      return fields.length === 2 && result === '0' ? range(fields[0], fields[1]) : null;
    if (operation === 'mprotect')
      return fields.length === 3 && result === '0' && permissions(fields[2])
        ? range(fields[0], fields[1]) : null;
    const flags = (fields[3] ?? '').split('|');
    return fields.length === 6 && /^0x[0-9a-f]+$/i.test(result)
      && (fields[0] === 'NULL' || number(fields[0]) !== null)
      && permissions(fields[2]) && fields[4] === '-1' && fields[5] === '0'
      && flags.includes('MAP_PRIVATE') && flags.includes('MAP_ANONYMOUS')
      && flags.every(flag => ['MAP_PRIVATE','MAP_ANONYMOUS','MAP_NORESERVE','MAP_STACK'].includes(flag))
      ? range(result, fields[1]) : null;
  };
  // strace bounds syscall windows, not linearization points. Validate an ENTIRE
  // connected overlapping component before retaining any member's effect. For
  // commuting operations, start-time order is merely a representation of their
  // metadata; it is not evidence of the order in which the kernel applied them.
  let independentThrough = -1;
  for (let index = 0; index < events.length; index++) {
    if (budgetExceeded) break;
    const row = events[index];
    // Old captures retain their raw census value, but an absent measurement
    // cannot authorize inferred mapping origins or a claim of disjoint calls.
    if (row.durationNs === null) { gap(row, 'syscall-duration-required'); break; }
    if (index > independentThrough) {
      let last = index, finished = row.completedAtNs;
      while (last + 1 < events.length && events[last + 1].startedAtNs <= finished) {
        last++;
        if (events[last].completedAtNs > finished) finished = events[last].completedAtNs;
      }
      if (last > index) {
        const component = events.slice(index, last + 1);
        const missing = component.find(event => event.durationNs === null);
        if (missing) { gap(missing, 'syscall-duration-required'); break; }
        const bounds = component.map(independentRange);
        const sorted = bounds.filter(Boolean).sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
        if (sorted.length !== component.length || sorted.some((bounds, i) => i && bounds.start < sorted[i - 1].end)) {
          gap(row, 'overlapping-address-space-events-replay-stopped'); break;
        }
      }
      independentThrough = last;
    }
    let space = tasks.get(row.tid);
    if (!space) { gap(row, 'task-address-space-unresolved'); break; }
    if (/^(?:clone3?|fork|vfork)\(/.test(row.call)) {
      const child = Number(/\)\s+=\s+(\d+)$/.exec(row.call)?.[1]);
      const flags = /\bflags=([A-Z0-9_|]+)(?=\s*[,})])/.exec(row.call)?.[1]?.split('|') ?? [];
      if (row.call.startsWith('clone') && flags.some(flag => !['CLONE_VM','CLONE_FS','CLONE_FILES',
        'CLONE_SIGHAND','CLONE_PIDFD','CLONE_PTRACE','CLONE_VFORK','CLONE_PARENT','CLONE_THREAD',
        'CLONE_NEWNS','CLONE_SYSVSEM','CLONE_SETTLS','CLONE_PARENT_SETTID','CLONE_CHILD_CLEARTID',
        'CLONE_DETACHED','CLONE_UNTRACED','CLONE_CHILD_SETTID','CLONE_NEWCGROUP','CLONE_NEWUTS',
        'CLONE_NEWIPC','CLONE_NEWUSER','CLONE_NEWPID','CLONE_NEWNET','CLONE_IO','CLONE_CLEAR_SIGHAND',
        'CLONE_INTO_CGROUP','SIGCHLD'].includes(flag))) {
        gap(row, 'clone-address-space-flags-unresolved'); break;
      }
      const shared = flags.includes('CLONE_VM') || row.call.startsWith('vfork(');
      const inherited = shared ? space : makeSpace(space.maps);
      if (!shared) inherited.uncertain = space.uncertain;
      tasks.set(child, inherited);
      record(row, inherited, shared ? 'share-vm' : 'copy-vm', inherited.maps);
      continue;
    }
    if (/^execve(?:at)?\(/.test(row.call)) {
      space = makeSpace([]); tasks.set(row.tid, space);
      const entry = initialMaps.get(row);
      if (entry) {
        space.maps = entry.maps.map(map => ({start:map.start,end:map.end,
          permissions:[map.permissions[0] === 'r' ? 'PROT_READ' : null,
            map.permissions[1] === 'w' ? 'PROT_WRITE' : null,
            map.permissions[2] === 'x' ? 'PROT_EXEC' : null].filter(Boolean).join('|') || 'PROT_NONE',
          origin:{kind:'kernel-exec-mapping',path:map.path,offsetBytes:BigInt(map.offset),
            device:map.device,inode:map.inode,execEntryMapsSha256:entry.binding.mapsSha256}}));
        consumedEntries.add(row);
        record(row,space,'exec-entry-snapshot',space.maps);
      } else {
        gap(row, 'exec-kernel-installed-mappings-unobserved');
        record(row, space, 'exec-reset', []);
      }
      continue;
    }
    if (!page) continue;
    if (space.uncertain) { gap(row, 'prior-address-space-transition-unresolved'); continue; }
    const memory = /^(\w+)\((.*)\)\s+=\s+(.*)$/.exec(row.call);
    const [, operation, args, result] = memory;
    if (result.startsWith('-1 ')) {
      // Linux mprotect may have changed earlier VMAs before returning an
      // error on a later one. Failure is not proof of an unchanged range.
      if (['mprotect','pkey_mprotect'].includes(operation))
        invalidate(row, space, 'failed-permission-change-may-be-partial');
      continue;
    }
    const fields = args.split(', ').map(field => field.trim());
    if (operation === 'mmap') {
      const bounds = fields.length === 6 && range(result, fields[1]), prot = permissions(fields[2] ?? '');
      const flags = (fields[3] ?? '').split('|');
      const supported = flags.every(flag => ['MAP_PRIVATE','MAP_SHARED','MAP_ANONYMOUS','MAP_FIXED',
        'MAP_FIXED_NOREPLACE','MAP_DENYWRITE','MAP_EXECUTABLE','MAP_NORESERVE','MAP_STACK',
        'MAP_POPULATE','MAP_NONBLOCK','MAP_32BIT'].includes(flag))
        && flags.filter(flag => ['MAP_PRIVATE','MAP_SHARED'].includes(flag)).length === 1;
      const offset = number(fields[5]);
      if (!bounds || !prot || !supported || offset === null || offset % page !== 0n
        || (flags.includes('MAP_FIXED') || flags.includes('MAP_FIXED_NOREPLACE')) && number(fields[0]) !== bounds.start) {
        invalidate(row, space, 'mmap-semantics-unresolved'); continue;
      }
      const anonymous = flags.includes('MAP_ANONYMOUS');
      const path = /^\d+<([^<>]+)>$/.exec(fields[4])?.[1] ?? null;
      const origin = {kind:anonymous ? 'anonymous' : path ? 'file-mapping' : 'unresolved',
        path:anonymous ? null : path, offsetBytes:anonymous ? null : offset};
      if (origin.kind === 'unresolved') gap(row, 'mmap-descriptor-path-unresolved');
      if (space.maps.some(map => map.end > bounds.start && map.start < bounds.end)
        && !flags.includes('MAP_FIXED')) {
        invalidate(row, space, 'mmap-unexpected-overlap'); continue;
      }
      remove(space, bounds);
      const map = {...bounds, permissions:prot, origin}; space.maps.push(map);
      record(row, space, operation, [map]);
    } else if (['mprotect','pkey_mprotect','munmap'].includes(operation)) {
      const bounds = range(fields[0], fields[1]);
      const prot = operation === 'munmap' ? null : permissions(fields[2] ?? '');
      if (!bounds || fields.length !== (operation === 'munmap' ? 2 : operation === 'mprotect' ? 3 : 4)
        || operation !== 'munmap' && !prot) {
        invalidate(row, space, 'mapping-permission-or-unmap-semantics-unresolved'); continue;
      }
      const covered = space.maps.filter(map => map.end > bounds.start && map.start < bounds.end)
        .map(map => cut(map, map.start > bounds.start ? map.start : bounds.start,
          map.end < bounds.end ? map.end : bounds.end)).sort((a,b) => a.start < b.start ? -1 : 1);
      remove(space, bounds);
      if (operation === 'munmap') { record(row, space, 'munmap-removed', covered); continue; }
      const maps = [], unknown = (start, end) => ({start, end, permissions:prot,
        origin:{kind:'unresolved', path:null, offsetBytes:null}});
      let cursor = bounds.start;
      for (const map of covered) {
        if (map.start > cursor) maps.push(unknown(cursor, map.start));
        maps.push({...map, permissions:prot}); cursor = map.end;
      }
      if (cursor < bounds.end) maps.push(unknown(cursor, bounds.end));
      if (maps.some(map => map.origin.kind === 'unresolved')) gap(row, 'permission-range-mapping-origin-unresolved');
      space.maps.push(...maps); record(row, space, operation, maps);
    } else if (operation === 'mremap') {
      const old = range(fields[0], fields[1]), size = rounded(fields[2] ?? ''), flags = (fields[3] ?? '').split('|');
      const destination = size && range(result, String(size));
      const supported = flags.every(flag => ['0','MREMAP_MAYMOVE','MREMAP_FIXED'].includes(flag))
        && (!flags.includes('MREMAP_FIXED') || flags.includes('MREMAP_MAYMOVE'))
        && fields.length === (flags.includes('MREMAP_FIXED') ? 5 : 4)
        && (!flags.includes('MREMAP_FIXED') || number(fields[4]) === number(result));
      const source = old && space.maps.find(map => map.start === old.start && map.end === old.end);
      if (!old || !destination || !supported || !source) {
        invalidate(row, space, 'mremap-origin-or-semantics-unresolved'); continue;
      }
      const overlap = old.start < destination.end && old.end > destination.start;
      if (overlap && old.start !== destination.start || destination.start !== old.start
        && !flags.includes('MREMAP_MAYMOVE')) {
        invalidate(row, space, 'mremap-overlap-or-movement-unresolved'); continue;
      }
      remove(space, old);
      if (!flags.includes('MREMAP_FIXED') && space.maps.some(map => map.end > destination.start && map.start < destination.end)) {
        invalidate(row, space, 'mremap-destination-overlap-unresolved'); continue;
      }
      remove(space, destination);
      const moved = {...source, ...destination}; space.maps.push(moved);
      record(row, space, operation, [moved]);
    } else invalidate(row, space, operation + '-semantics-unresolved');
    if (space.maps.length > 8192 || executableRanges.length > 100_000) {
      gap(row, 'mapping-replay-population-limit'); break;
    }
  }
  memoryRequire(consumedEntries.size === initialMaps.size, 'exec entry not reached by supported replay');
  return {schema:'runtime-mapping-origins/v1', pageSizeBytes:page ? Number(page) : null,
    changes, executableRanges, gaps, mappingPopulationComplete:false,
    executableBytesQualified:false, jitByteOriginQualification:'required',
    effectivePermissionsQualification:'required',
    scope:'ordered supported syscall origins and requested protections; kernel permissions and executable bytes require separate witnesses'};
}

/** A host-local exec-to-EOF task census, including short-lived children and
 * native threads. The terminal witness must come from the launcher's actual
 * close/EOF events, not the target's own receipt. This accounts only for the
 * traced lifetime: source bytes, open-file bytes, pre-existing processes and
 * creator exclusion still require their separate maintained producers.
 */
export function bindRuntimeProcessTree(text, terminal) {
  const processId = terminal?.processId;
  if (!Number.isSafeInteger(processId) || processId <= 0 || terminal.exitCode !== 0
    || terminal.signal !== null || terminal.eof !== true || terminal.captureStartedBeforeExec !== true)
    throw new Error('process census lacks independent successful close/EOF evidence');
  if (typeof text !== 'string' || !text.endsWith('\n') || text.length > 16 * 1024 * 1024)
    throw new Error('process census capture incomplete or oversized');
  const { lines } = parseRuntimeFileTrace(text);
  if (!lines.length || lines.length > 100_000) throw new Error('process census population incomplete');
  const validId = id => Number.isSafeInteger(id) && id > 0;
  const tasks = new Map([[processId, { taskId: processId, parentTaskId: null,
    threadGroupId: processId, birthAtMs: null, execs: [], terminalAtMs: null }]]);
  const births = [], observed = new Set(), memoryTransitions = [];
  for (const row of lines) {
    if (!validId(row.tid) || !Number.isFinite(row.atMs)) throw new Error('process census identity invalid');
    observed.add(row.tid);
    if (/^(?:clone|clone3|fork|vfork)\(/.test(row.call)) {
      if (/\)\s+=\s+-1\b/.test(row.call)) continue;
      const birth = /^(clone3?|fork|vfork)\(.*\)\s+=\s+([1-9][0-9]*)$/.exec(row.call);
      if (!birth || !validId(Number(birth[2]))) throw new Error('process census birth unresolved');
      // Unknown/truncated flags cannot distinguish a process from a thread.
      const flags = birth[1].startsWith('clone') ? /\bflags=([A-Z0-9_|]+)(?=\s*[,})])/.exec(row.call) : null;
      if (birth[1].startsWith('clone') && !flags) throw new Error('process census clone flags unresolved');
      births.push({ parent: row.tid, child: Number(birth[2]), atMs: row.atMs,
        thread: flags?.[1].split('|').includes('CLONE_THREAD') === true });
    }
  }
  // Output can interleave a child before its parent's resumed clone return.
  for (let remaining = births; remaining.length;) {
    const next = [];
    for (const birth of remaining) {
      const parent = tasks.get(birth.parent);
      if (!parent) { next.push(birth); continue; }
      if (tasks.has(birth.child) || tasks.size >= 4096) throw new Error('process census duplicate or oversized population');
      tasks.set(birth.child, { taskId: birth.child, parentTaskId: birth.parent,
        threadGroupId: birth.thread ? parent.threadGroupId : birth.child,
        birthAtMs: birth.atMs, execs: [], terminalAtMs: null });
    }
    if (next.length === remaining.length) throw new Error('process census has unrooted task births');
    remaining = next;
  }
  if ([...observed].some(id => !tasks.has(id))) throw new Error('process census has unrooted observed tasks');
  for (const row of lines) {
    const task = tasks.get(row.tid);
    if (task.birthAtMs !== null && row.atMs < task.birthAtMs || task.terminalAtMs !== null)
      throw new Error('process census task lifetime changed');
    if (/^(?:mmap|mprotect|pkey_mprotect|munmap|mremap|shmat|shmdt|remap_file_pages)\(/.test(row.call)) {
      const memory = /^(\w+)\((.*)\)\s+=\s+(.*)$/.exec(row.call);
      if (!memory || row.completedAtMs < row.atMs)
        throw new Error('process census memory transition unresolved');
      const [, operation, args, result] = memory;
      const failed = /^-1 [A-Z][A-Z0-9]+(?: \([^\n]*\))?$/.test(result);
      const returnsAddress = ['mmap', 'mremap', 'shmat'].includes(operation);
      if (!failed && !(returnsAddress ? /^0x[0-9a-f]+$/i.test(result) : result === '0'))
        throw new Error('process census memory transition outcome unresolved');
      // Retain transitions even when no executable map survives until a sample.
      // Replay is a separate, deliberately partial mapping-metadata witness.
      // Neither these observations nor mapping origins qualify executable bytes.
      const permission = /\bPROT_(?:NONE|READ|WRITE|EXEC)\b/.test(args)
        ? /\bPROT_EXEC\b/.test(args) : null;
      memoryTransitions.push({ taskId: row.tid, operation, arguments: args, result,
        succeeded: !failed, executablePermissionRequested: permission,
        atMs: row.atMs, completedAtMs: row.completedAtMs, durationNs:row.durationNs });
    }
    if (/^execve(?:at)?\(/.test(row.call)) {
      if (/\)\s+=\s+-1\b/.test(row.call)) continue;
      if (!/\)\s+=\s+0$/.test(row.call) || task.threadGroupId !== task.taskId)
        throw new Error('process census exec identity unresolved');
      // Keep the executable, never argv or environment contents. Refuse
      // strace truncation/unsupported path escapes rather than invent a path.
      const path = /^execve\(("(?:\\.|[^"\\])*"),/.exec(row.call)
        ?? /^execveat\([^,]+, ("(?:\\.|[^"\\])*"),/.exec(row.call);
      let executable;
      try { executable = path && JSON.parse(path[1]); } catch { /* refused below */ }
      if (typeof executable !== 'string' || !executable || executable.includes('\0'))
        throw new Error('process census executable unresolved');
      task.execs.push({ executable, atMs: row.atMs });
    } else if (row.call.startsWith('+++')) {
      if (row.call !== '+++ exited with 0 +++') throw new Error('process census task termination unsuccessful or unresolved');
      task.terminalAtMs = row.atMs;
    }
  }
  const root = tasks.get(processId);
  if (!root.execs.length || root.terminalAtMs === null || [...tasks.values()].some(task =>
    task.terminalAtMs === null || task.birthAtMs !== null && task.birthAtMs < root.execs[0].atMs))
    throw new Error('process census lacks complete exec-to-exit population');
  return { schema: 'runtime-traced-process-tree/v1', processId,
    tasks: [...tasks.values()].sort((a, b) => a.taskId - b.taskId),
    memoryTransitions, mappingOrigins:replayRuntimeMappings(lines, processId, terminal.pageSizeBytes, terminal.execEntries),
    executableMemoryQualification: 'required',
    tracedTaskPopulationComplete: true, completeRuntimeClosureVerified: false,
    sourceQualification: 'required', creatorFence: 'required',
    scope: 'all recorded process/thread births through successful termination under the maintained file trace' };
}

export function bindRuntimeModelOpens(text, { processId, assets, beforeEpochMs }) {
  if (!Number.isSafeInteger(processId) || processId <= 0 || !assets.length
    || !Number.isFinite(beforeEpochMs)) throw new Error('model-open population missing');
  const { lines, edges } = parseRuntimeFileTrace(text);
  const descendants = new Set([processId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [parent, child] of edges) if (descendants.has(parent) && !descendants.has(child)) {
      descendants.add(child); changed = true;
    }
  }
  const rootExec = lines.some(row => row.tid === processId && /^execve\(/.test(row.call) && /\)\s+=\s+0$/.test(row.call));
  const terminal = lines.some(row => row.tid === processId && row.call === '+++ exited with 0 +++');
  if (!rootExec || !terminal) throw new Error('model-open capture lacks target exec-to-exit evidence');
  const observed = [];
  for (const row of lines) {
    if (!descendants.has(row.tid) || row.atMs >= beforeEpochMs || !/^openat2?\(/.test(row.call)) continue;
    const result = /\)\s+=\s+(\d+)<([^<>]+)>$/.exec(row.call);
    if (!result) {
      if (/\)\s+=\s+-1\b/.test(row.call)) continue;
      // strace -yy annotates devices with nested brackets, e.g.
      // /dev/null<char 1:3>. They are outside this declared model population.
      if (assets.some(asset => row.call.includes(JSON.stringify(asset.path))))
        throw new Error('successful model-open record lacks resolved descriptor path');
      continue;
    }
    if (assets.some(asset => asset.path === result[2])) observed.push({ taskId: row.tid, atMs: row.atMs, path: result[2], fd: Number(result[1]) });
  }
  const missing = assets.filter(asset => !observed.some(row => row.path === asset.path));
  if (missing.length) throw new Error('model files lack successful opens before native inference: ' + missing.map(asset => asset.path).join(', '));
  return { processId, tasks: [...descendants], opens: observed,
    modelFilesOpenedBeforeInference: true, modelBytesReadVerified: false,
    scope: 'successful resolved descriptor opens of the declared model assets before first selected native Run' };
}
