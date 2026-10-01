/** Linux-only, bounded diagnostic for THIS WDIO driver's packaged app subtree.
 * schedstat counters are ns, not ticks; the main task is sampled explicitly.
 * https://docs.kernel.org/scheduler/sched-stats.html#proc-pid-schedstat
 * This identifies CPU/runqueue/sleep intervals, never JavaScript call stacks. */
import { fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  linuxPpidFromProcStat, linuxProcessIdentityFromStat, linuxProcStateFromStat,
  readProcessIdentity,
} from '../../../packages/operator-core/lib/process-identity';

interface ProcReader {
  read(file: string): string;
  list(file: string): string[];
  link(file: string): string;
}
const liveProc: ProcReader = {
  read: (file) => readFileSync(file, 'utf8'),
  list: (file) => readdirSync(file),
  link: (file) => readlinkSync(file),
};
export interface NativeProbeOptions {
  driverPid: number;
  driverIdentity: string;
  appPath: string;
}
export function parseSchedstat(value: string) {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 3 || fields.some((field) => !/^\d+$/.test(field))) {
    throw new Error('Invalid schedstat: expected CPU ns, runqueue ns, timeslices');
  }
  // Keep cumulative counters exact beyond Number.MAX_SAFE_INTEGER.
  return { cpuNs: fields[0], runqueueNs: fields[1], timeslices: fields[2] };
}
export function schedstatDelta(before: ReturnType<typeof parseSchedstat>, after: ReturnType<typeof parseSchedstat>) {
  const delta = (key: keyof typeof before) => {
    const value = BigInt(after[key]) - BigInt(before[key]);
    if (value < 0n) throw new Error('schedstat counter reset; process lifetime changed');
    return value;
  };
  return { cpuMs: Number(delta('cpuNs')) / 1e6, runqueueMs: Number(delta('runqueueNs')) / 1e6,
    timeslices: Number(delta('timeslices')) };
}

/** Discover through every task's children: GLib can spawn from a worker thread.
 * No global /proc name match, inherited environment, or PID-only attribution. */
export function collectOwnedWebKitSample(options: NativeProbeOptions, proc: ProcReader = liveProc) {
  const readStartedEpochMs = Date.now();
  const started = performance.now();
  const boot = proc.read('/proc/sys/kernel/random/boot_id').trim();
  const identity = (pid: number) => linuxProcessIdentityFromStat(boot, proc.read(`/proc/${pid}/stat`));
  if (!boot || identity(options.driverPid) !== options.driverIdentity) {
    throw new Error('Native diagnostic driver identity changed');
  }
  type Ancestor = { pid: number; identity: string };
  type Node = { pid: number; identity: string; app: Ancestor | null; ancestry: Ancestor[] };
  const queue: Node[] = [{ pid: options.driverPid, identity: options.driverIdentity, app: null, ancestry: [] }];
  const seen = new Set<number>();
  const processes: Array<{ pid: number; identity: string; kind: 'app' | 'webkit'; ancestry: Ancestor[];
    appPid: number; appIdentity: string; state: string | null; wchan: string | null;
    schedstat: ReturnType<typeof parseSchedstat>; readStartedEpochMs: number; readCompletedEpochMs: number }> = [];
  const unavailable: string[] = [];
  while (queue.length) {
    const node = queue.shift()!;
    if (seen.has(node.pid)) continue;
    seen.add(node.pid);
    if (seen.size > 64) throw new Error('Native diagnostic subtree exceeds 64-process bound');
    try {
      if (identity(node.pid) !== node.identity) throw new Error('process identity changed during discovery');
      const exe = proc.link(`/proc/${node.pid}/exe`);
      const app = exe === options.appPath ? { pid: node.pid, identity: node.identity } : node.app;
      const kind = exe === options.appPath ? 'app' : path.basename(exe) === 'WebKitWebProcess' ? 'webkit' : null;
      if (kind && app) {
        const task = `/proc/${node.pid}/task/${node.pid}`;
        const sampleStarted = Date.now();
        const mainStat = proc.read(`${task}/stat`);
        const schedstat = parseSchedstat(proc.read(`${task}/schedstat`));
        let wchan: string | null = null;
        try { wchan = proc.read(`${task}/wchan`).trim(); } catch { /* explicitly unavailable */ }
        if (linuxProcessIdentityFromStat(boot, mainStat) !== node.identity ||
            identity(node.pid) !== node.identity || identity(app.pid) !== app.identity) {
          throw new Error('process/app identity changed during sampling');
        }
        const chain = [...node.ancestry, { pid: node.pid, identity: node.identity }];
        for (let i = 0; i < chain.length; i++) {
          const stat = proc.read(`/proc/${chain[i].pid}/stat`);
          if (linuxProcessIdentityFromStat(boot, stat) !== chain[i].identity ||
              (i > 0 && linuxPpidFromProcStat(stat) !== chain[i - 1].pid)) {
            throw new Error('owned ancestry changed during sampling');
          }
        }
        processes.push({ pid: node.pid, identity: node.identity, kind, ancestry: node.ancestry,
          appPid: app.pid, appIdentity: app.identity, state: linuxProcStateFromStat(mainStat), wchan, schedstat,
          readStartedEpochMs: sampleStarted, readCompletedEpochMs: Date.now() });
      }
      const tasks = proc.list(`/proc/${node.pid}/task`);
      if (tasks.length > 256) throw new Error('process exceeds 256-task discovery bound');
      for (const tid of tasks) {
        if (!/^\d+$/.test(tid)) continue;
        const children = proc.read(`/proc/${node.pid}/task/${tid}/children`).trim();
        for (const child of children ? children.split(/\s+/) : []) {
          if (!/^[1-9]\d*$/.test(child)) throw new Error('invalid child PID');
          const pid = Number(child);
          const stat = proc.read(`/proc/${pid}/stat`);
          const childIdentity = linuxProcessIdentityFromStat(boot, stat);
          if (linuxPpidFromProcStat(stat) !== node.pid || !childIdentity) continue;
          queue.push({ pid, identity: childIdentity, app,
            ancestry: [...node.ancestry, { pid: node.pid, identity: node.identity }] });
        }
      }
      if (identity(node.pid) !== node.identity) throw new Error('ancestor identity changed during discovery');
    } catch (error) {
      unavailable.push(`${node.pid}: ${String(error).slice(0, 200)}`);
    }
  }
  if (identity(options.driverPid) !== options.driverIdentity) throw new Error('Native diagnostic driver exited/reused');
  let runqueueMeasured = false;
  try { runqueueMeasured = proc.read('/proc/sys/kernel/sched_schedstats').trim() === '1'; } catch { /* unknown */ }
  return { readStartedEpochMs, readCompletedEpochMs: Date.now(), readDurationMs: performance.now() - started,
    clock: 'Date.now' as const, counterUnit: 'ns' as const, task: 'main' as const,
    runqueueMeasured, processes, unavailable };
}

/** A separate Node process continues sampling while WebKit's main task stalls. */
export function startNativeProcessProbe(driverPid: number, appPath: string, file: string): ChildProcess {
  if (process.platform !== 'linux') throw new Error('Native CPU diagnostic requires Linux /proc');
  const driverIdentity = readProcessIdentity(driverPid);
  if (!driverIdentity) throw new Error('Native CPU diagnostic cannot identify its driver');
  const options = { driverPid, driverIdentity, appPath: realpathSync(appPath) };
  // Exclusive create prevents a rerun from overwriting earlier diagnostic evidence.
  writeFileSync(file, `${JSON.stringify({ kind: 'header', schemaVersion: 'native-process-probe-v1',
    options, intervalMs: 100, maxDurationMs: 120_000, maxSamples: 1200 })}\n`, { flag: 'wx', mode: 0o600 });
  return fork(__filename, [JSON.stringify(options), file], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
}
export async function stopNativeProcessProbe(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 2_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    if (child.connected) child.send('stop');
    else child.kill('SIGTERM');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const options = JSON.parse(process.argv[2]) as NativeProbeOptions;
  const file = process.argv[3];
  const started = performance.now();
  let samples = 0;
  let maxReadDurationMs = 0;
  let finished = false;
  let timer: NodeJS.Timeout;
  const finish = (reason: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    appendFileSync(file, `${JSON.stringify({ kind: 'end', reason, samples,
      maxReadDurationMs, elapsedMs: performance.now() - started, epochMs: Date.now() })}\n`);
    process.disconnect?.();
  };
  const tick = () => {
    if (finished) return;
    if (samples >= 1200 || performance.now() - started >= 120_000) return finish('bound');
    try {
      const sample = collectOwnedWebKitSample(options);
      maxReadDurationMs = Math.max(maxReadDurationMs, sample.readDurationMs);
      appendFileSync(file, `${JSON.stringify({ kind: 'sample', ...sample })}\n`);
      samples++;
      timer = setTimeout(tick, 100);
    } catch (error) { finish(`unavailable: ${String(error).slice(0, 300)}`); }
  };
  process.on('message', (message) => { if (message === 'stop') finish('stopped'); });
  process.on('disconnect', () => finish('launcher-disconnected'));
  process.on('SIGTERM', () => finish('terminated'));
  tick();
}
