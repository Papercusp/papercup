/** Read-only reconciliation for legacy headless attempts lost before task enrolment. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { papercuspPathForWorkspace } from './papercusp-root';
import { linuxStartTicksFromProcStat } from './process-identity';
import { findLiveHostAsync } from './events/await/psu-pty-discovery';
import { mapWithConcurrency } from './gym/concurrency';

export interface OrphanedGradingAuditLaunchProof {
  ownerId: string;
  startedAt: number;
  hostPid: number;
  logPath: string;
  proofKey: string;
  checkedProcesses: number;
}

interface ProbeIo {
  read: (path: string) => Promise<string>;
  list: (path: string) => Promise<string[]>;
  stat: (path: string) => Promise<{ uid: number; size: number; mtimeMs: number; isFile(): boolean }>;
  clockTicks: () => Promise<number>;
  findHost: (owner: string) => Promise<unknown>;
  logDirectory: (workspace: string) => string;
  uid: number;
  selfPid: number;
  now: () => number;
}

const emptyRecord = (value: unknown) => value != null && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).length === 0;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT' ||
  (error as NodeJS.ErrnoException)?.code === 'ESRCH';

/**
 * Never edits the old election or converts its unknown spawn into a negative.
 * Requires an exact empty log from a dead writer, no live native host, and a
 * complete scan of processes that could have been created by this attempt.
 * Old unreadable processes cannot be its children; unreadable new ones refuse.
 */
export async function proveOrphanedGradingAuditLaunch(
  input: { workspaceId: string; label: string; launch: Record<string, unknown> },
  overrides: Partial<ProbeIo> = {},
): Promise<OrphanedGradingAuditLaunchProof | null> {
  if (process.platform !== 'linux') return null;
  const signal = AbortSignal.timeout(5_000);
  const io: ProbeIo = {
    read: path => readFile(path, { encoding: 'utf8', signal }),
    list: path => readdir(path), stat: path => lstat(path),
    clockTicks: async () => Number((await promisify(execFile)('getconf', ['CLK_TCK'], { timeout: 2_000 })).stdout.trim()),
    findHost: findLiveHostAsync,
    logDirectory: workspace => join(papercuspPathForWorkspace(workspace), 'fleet-logs'),
    uid: process.getuid!(), selfPid: process.pid, now: Date.now,
    ...overrides,
  };
  try {
    const old = input.launch;
    const owners = old.ownerIds;
    if (old.requestKind !== 'capability:launch-agent' || old.launchState !== 'spawning' || old.mode !== 'fresh' ||
        old.expectedCount !== 1 || !Array.isArray(owners) || owners.length !== 1 ||
        typeof owners[0] !== 'string' || !/^su-[A-Za-z0-9-]+$/.test(owners[0]) ||
        !emptyRecord(old.processHandles) || (old.tasks != null && (!Array.isArray(old.tasks) || old.tasks.length)) ||
        typeof old.startedAt !== 'number' || !Number.isSafeInteger(old.startedAt) ||
        old.startedAt <= 0 || io.now() - old.startedAt < 15 * 60_000) return null;
    const ownerId = owners[0];
    const startedAt = old.startedAt;
    const member = Array.isArray(old.targetMembers) && old.targetMembers.length === 1 ? old.targetMembers[0] : null;
    const observations = old.memberResults as Record<string, Record<string, unknown>> | undefined;
    if (!member || member.ownerId !== ownerId || member.label !== input.label || member.headless !== true ||
        !observations || Object.keys(observations).length !== 1 || !observations['0'] ||
        observations['0'].ownerId !== ownerId || observations['0'].label !== input.label ||
        observations['0'].status !== 'starting' || observations['0'].outcome !== 'unknown' ||
        ['pid', 'terminalPid', 'taskId', 'logPath', 'normalizedLogPath'].some(key => observations['0'][key] != null)) return null;
    if (await io.findHost(ownerId) !== null) return null;
    const safe = input.label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    const directory = io.logDirectory(input.workspaceId);
    const candidates = (await io.list(directory)).flatMap(name => {
      if (!name.startsWith(`${safe}-`)) return [];
      const match = /^(\d+)-(\d+)\.log$/.exec(name.slice(safe.length + 1));
      if (!match) return [];
      const stamp = Number(match[2]);
      return stamp >= startedAt && stamp <= startedAt + 5 * 60_000
        ? [{ path: join(directory, name), pid: Number(match[1]), stamp }] : [];
    });
    if (candidates.length !== 1) return null;
    const log = candidates[0];
    const logStat = await io.stat(log.path);
    if (!logStat.isFile() || logStat.uid !== io.uid || logStat.size !== 0 ||
        Math.abs(logStat.mtimeMs - log.stamp) > 2_000 || !Number.isSafeInteger(log.pid) || log.pid <= 0) return null;
    const hostGone = async () => {
      try { await io.read(`/proc/${log.pid}/stat`); return false; }
      catch (error) { return missing(error); }
    };
    if (!(await hostGone())) return null;
    const ticksPerSecond = await io.clockTicks();
    const boot = /^btime (\d+)$/m.exec(await io.read('/proc/stat'));
    if (!boot || !Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) return null;
    const birth = (stat: string) => {
      const ticks = linuxStartTicksFromProcStat(stat);
      if (ticks == null) throw new Error('Unmeasured process birth');
      return Number(boot[1]) * 1000 + Number(ticks) * 1000 / ticksPerSecond;
    };
    // Positive control: this host must be visible through the same proc reader.
    birth(await io.read(`/proc/${io.selfPid}/stat`));
    if (!(await io.read(`/proc/${io.selfPid}/environ`)).includes('\0')) return null;
    const pids = (await io.list('/proc')).filter(name => /^\d+$/.test(name));
    if (!pids.length || pids.length > 30_000 || !pids.includes(String(io.selfPid))) return null;
    const observationsByPid = await mapWithConcurrency(pids, 16, async pid => {
      signal.throwIfAborted();
      try {
        if ((await io.stat(`/proc/${pid}`)).uid !== io.uid) return 0;
        const stat = await io.read(`/proc/${pid}/stat`);
        if (birth(stat) < startedAt - 2_000) return 0;
        if (stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0] === 'Z') return 0;
        const [env, command] = await Promise.all([io.read(`/proc/${pid}/environ`), io.read(`/proc/${pid}/cmdline`)]);
        return env.includes(ownerId) || command.includes(ownerId) ? -1 : 1;
      } catch (error) {
        if (missing(error)) return 0;
        // /proc/environ can become unreadable as a process exits after stat.
        // Resolve that race from a fresh kernel read; a live or unreadable
        // process still refuses the entire absence proof.
        try {
          const current = await io.read(`/proc/${pid}/stat`);
          if (current.slice(current.lastIndexOf(')') + 1).trim().split(/\s+/)[0] === 'Z') return 0;
        } catch (currentError) { if (missing(currentError)) return 0; }
        return -1;
      }
    });
    if (observationsByPid.includes(-1)) return null;
    const checkedProcesses = observationsByPid.reduce<number>((sum, value) => sum + value, 0);
    if (!(await hostGone()) || await io.findHost(ownerId) !== null) return null;
    return { ownerId, startedAt, hostPid: log.pid, logPath: log.path, checkedProcesses,
      proofKey: createHash('sha256').update(`${ownerId}\0${startedAt}\0${log.path}`).digest('hex') };
  } catch { return null; }
}
