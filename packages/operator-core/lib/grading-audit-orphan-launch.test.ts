import { describe, expect, it } from 'vitest';
import { proveOrphanedGradingAuditLaunch } from './grading-audit-orphan-launch';

describe('legacy grading audit host-loss proof', () => {
  const startedAt = 1_000_000;
  const owner = 'su-lost-reviewer';
  const label = 'grading-audit:EI-exact';
  const file = '/logs/grading-audit-EI-exact-42-1000100.log';
  const absent = () => Object.assign(new Error('gone'), { code: 'ENOENT' });
  const stat = (ticks: number, state = 'S') => `77 (process with ) name) ${state} ${Array(18).fill('0').join(' ')} ${ticks}`;
  const input = () => ({ workspaceId: 'ws', label, launch: {
    requestKind: 'capability:launch-agent', launchState: 'spawning', mode: 'fresh', startedAt, expectedCount: 1,
    ownerIds: [owner], targetMembers: [{ ownerId: owner, label, headless: true }],
    processHandles: {}, memberResults: { '0': { ownerId: owner, label, status: 'starting', outcome: 'unknown' } },
    spawnAttempted: true, nativeSpawnAttempted: [0],
  } });
  function fixture(control = 'safe') {
    const data = input();
    let candidateStatReads = 0;
    return { data, io: {
      uid: 1000, selfPid: 77, now: () => startedAt + 20 * 60_000,
      logDirectory: () => '/logs', clockTicks: async () => 100,
      findHost: async () => control === 'live-native' ? {} : null,
      list: async (path: string) => path === '/logs'
        ? [file.split('/').at(-1)!, ...(control === 'duplicate-log' ? ['grading-audit-EI-exact-43-1000101.log'] : [])]
        : control === 'empty-scan' ? [] : ['77', '88', '99'],
      stat: async (path: string) => ({ uid: control === 'foreign-log' && path === file ? 999 : 1000,
        size: control === 'nonempty-log' && path === file ? 1 : 0,
        mtimeMs: control === 'changed-log' ? 1009100 : 1000100, isFile: () => control !== 'symlink-log' }),
      read: async (path: string) => {
        if (path === '/proc/42/stat') {
          if (control === 'live-writer') return stat(100000);
          if (control === 'unreadable-writer') throw new Error('EACCES');
          throw absent();
        }
        if (path === '/proc/stat') return 'btime 0\n';
        if (path === '/proc/77/stat') return control === 'bad-stat' ? 'bad' : stat(110000);
        if (path === '/proc/88/stat') return stat(control === 'unreadable-new' ? 110000 : 100);
        if (path === '/proc/99/stat') {
          candidateStatReads++;
          if (control === 'vanished' || (control === 'vanished-during-read' && candidateStatReads > 1)) throw absent();
          return stat(110000, control === 'zombie' ||
            (control === 'zombie-during-read' && candidateStatReads > 1) ? 'Z' : 'S');
        }
        if (path.startsWith('/proc/88/')) throw new Error('old process cannot be read');
        if (path === '/proc/77/environ') return control === 'no-positive-control' ? '' : 'SELF=visible\0';
        if (path === '/proc/99/environ') {
          if (control.endsWith('-during-read')) throw Object.assign(new Error('process exiting'), { code: 'EACCES' });
          return control === 'live-owner-env' ? `SID=${owner}\0` : 'OTHER=true\0';
        }
        if (path === '/proc/99/cmdline') return control === 'live-owner-command' ? `psu\0--owner=${owner}` : 'other\0';
        return 'other\0';
      },
    } };
  }
  it('proves a dead writer with complete negative process evidence without changing its receipt', async () => {
    const { data, io } = fixture();
    const before = JSON.stringify(data);
    const proof = await proveOrphanedGradingAuditLaunch(data, io);
    expect(proof).toMatchObject({ ownerId: owner, hostPid: 42, logPath: file, checkedProcesses: 2 });
    expect(proof?.proofKey).toBe((await proveOrphanedGradingAuditLaunch(data, io))?.proofKey);
    expect(JSON.stringify(data)).toBe(before);
  });
  it.each(['live-native', 'live-writer', 'unreadable-writer', 'duplicate-log', 'empty-scan', 'foreign-log',
    'nonempty-log', 'changed-log', 'symlink-log', 'bad-stat', 'unreadable-new', 'no-positive-control',
    'live-owner-env', 'live-owner-command'])('refuses incomplete or positive %s evidence', async control => {
    const { data, io } = fixture(control);
    expect(await proveOrphanedGradingAuditLaunch(data, io)).toBeNull();
  });
  it.each(['vanished', 'zombie', 'vanished-during-read', 'zombie-during-read'])(
    'does not treat a conclusively %s process as live', async control => {
    const { data, io } = fixture(control);
    expect(await proveOrphanedGradingAuditLaunch(data, io)).not.toBeNull();
  });
  it('refuses a recent attempt and receipts with any process handle', async () => {
    const { data, io } = fixture();
    expect(await proveOrphanedGradingAuditLaunch(data, { ...io, now: () => startedAt + 10 })).toBeNull();
    data.launch.processHandles = { '0': { pid: 123 } };
    expect(await proveOrphanedGradingAuditLaunch(data, io)).toBeNull();
  });

  it('uses the existing bounded worker pool for independent process reads', async () => {
    const { data, io } = fixture();
    let active = 0;
    let peak = 0;
    const proof = await proveOrphanedGradingAuditLaunch(data, {
      ...io,
      list: async path => path === '/proc' ? ['77', ...Array.from({ length: 80 }, (_, i) => String(100 + i))] : io.list(path),
      stat: async path => {
        if (/^\/proc\/\d+$/.test(path)) {
          active++; peak = Math.max(peak, active);
          await new Promise<void>(resolve => setImmediate(resolve));
          active--;
        }
        return io.stat(path);
      },
      read: async path => /^\/proc\/1\d\d\/stat$/.test(path) ? stat(110000) : io.read(path),
    });
    expect(proof?.checkedProcesses).toBe(81);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
  });
});
