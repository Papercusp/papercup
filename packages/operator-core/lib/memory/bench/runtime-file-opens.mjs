import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Read the tracer parent's actual host page size before launching the child.
 * This is a local observation, not a value supplied by the traced program.
 * Call only when parent and tracee use the same Linux kernel/page-size ABI.
 */
export function observeRuntimePageSize() {
  const output = execFileSync('/usr/bin/getconf', ['PAGESIZE'], {
    encoding:'utf8', timeout:5000, maxBuffer:1024,
    env:{PATH:'/usr/bin:/bin', LC_ALL:'C'},
  }).trim();
  const page = /^\d+$/.test(output) ? Number(output) : NaN;
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
export function runtimeFileTraceArguments(output, command) {
  // -q suppresses attach chatter. -qq also suppresses the terminal records
  // that bindRuntimeModelOpens requires and therefore cannot qualify a run.
  return ['-f', '-q', '-ttt', '-yy', '-s', '4096', '-e',
    'trace=openat,openat2,mmap,mprotect,pkey_mprotect,munmap,mremap,shmat,shmdt,remap_file_pages,execve,execveat,clone,clone3,fork,vfork,exit,exit_group',
    '-o', output, ...command];
}

function parseRuntimeFileTrace(text) {
  const pending = new Map(), lines = [], edges = [];
  for (const line of text.split('\n').filter(Boolean)) {
    const match = /^(\d+)\s+(\d+\.\d+)\s+(.*)$/.exec(line);
    if (!match) throw new Error('unsupported strace record');
    const tid = Number(match[1]);
    let atMs = Number(match[2]) * 1000;
    const completedAtMs = atMs;
    let call = match[3];
    if (call.endsWith('<unfinished ...>')) {
      if (pending.has(tid)) throw new Error('duplicate unfinished strace record');
      pending.set(tid, { call: call.slice(0, -16), atMs }); continue;
    }
    if (call.startsWith('<... ')) {
      const resumed = /^<\.\.\. (\w+) resumed>(.*)$/.exec(call), start = pending.get(tid);
      if (!resumed || !start || !start.call.startsWith(resumed[1] + '('))
        throw new Error('unmatched resumed strace record');
      pending.delete(tid); call = start.call + resumed[2]; atMs = start.atMs;
    }
    const clone = /^(?:clone|clone3|fork|vfork)\(.*\)\s+=\s+(\d+)\b/.exec(call);
    if (clone) edges.push([tid, Number(clone[1])]);
    lines.push({ tid, atMs, completedAtMs, call });
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
function replayRuntimeMappings(lines, processId, pageSizeBytes) {
  const gaps = [], executableRanges = [], changes = [], spaces = [], tasks = new Map();
  let recordedRanges = 0, budgetExceeded = false;
  const page = Number.isSafeInteger(pageSizeBytes) && pageSizeBytes >= 1024
    && Number.isInteger(Math.log2(pageSizeBytes)) ? BigInt(pageSizeBytes) : null;
  const hex = value => '0x' + value.toString(16);
  const gap = (row, reason) => gaps.push({taskId:row.tid, atMs:row.atMs, reason});
  const events = lines.filter(row => /^(?:mmap|mprotect|pkey_mprotect|munmap|mremap|shmat|shmdt|remap_file_pages)\(/.test(row.call)
    || /^(?:execve|execveat|clone|clone3|fork|vfork)\(/.test(row.call)
      && !/\)\s+=\s+-1\b/.test(row.call)).sort((a, b) => a.atMs - b.atMs);
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
  // strace timestamps bound syscalls, not their linearization points. Even two
  // individually successful calls cannot be ordered through overlapping windows.
  // Stop replay globally at the first overlap (conservative even for disjoint
  // VMs); the raw syscall census below still retains every later observation.
  for (let index = 0; index < events.length; index++) {
    if (budgetExceeded) break;
    const row = events[index], next = events[index + 1];
    // Look ahead BEFORE applying either member of an ambiguous pair. Keeping
    // the first member's range would already assert an unsupported ordering.
    if (next && next.atMs <= row.completedAtMs) {
      gap(row, 'overlapping-address-space-events-replay-stopped'); break;
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
      gap(row, 'exec-kernel-installed-mappings-unobserved');
      record(row, space, 'exec-reset', []); continue;
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
    const fields = args.split(', ');
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
        atMs: row.atMs, completedAtMs: row.completedAtMs });
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
    memoryTransitions, mappingOrigins:replayRuntimeMappings(lines, processId, terminal.pageSizeBytes),
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
