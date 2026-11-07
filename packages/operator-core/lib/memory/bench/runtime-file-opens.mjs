/** Inspect retained strace -f -ttt -yy output. Successful opens are evidence of
 * access, not proof of which bytes were read. Join with stable pre/post hashes.
 * Fail closed on unfinished or unsupported open records, never infer from a
 * filename appearing in an argv, a failed open, or another process's output. */
export function runtimeFileTraceArguments(output, command) {
  // -q suppresses attach chatter. -qq also suppresses the terminal records
  // that bindRuntimeModelOpens requires and therefore cannot qualify a run.
  return ['-f', '-q', '-ttt', '-yy', '-s', '4096', '-e',
    'trace=openat,openat2,mmap,execve,execveat,clone,clone3,fork,vfork,exit,exit_group', '-o', output, ...command];
}

function parseRuntimeFileTrace(text) {
  const pending = new Map(), lines = [], edges = [];
  for (const line of text.split('\n').filter(Boolean)) {
    const match = /^(\d+)\s+(\d+\.\d+)\s+(.*)$/.exec(line);
    if (!match) throw new Error('unsupported strace record');
    const tid = Number(match[1]);
    let atMs = Number(match[2]) * 1000;
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
    lines.push({ tid, atMs, call });
  }
  if (pending.size) throw new Error('incomplete strace capture');
  return { lines, edges };
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
  const births = [], observed = new Set();
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
