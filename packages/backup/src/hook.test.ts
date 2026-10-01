/**
 * hook.test.ts — pre-snapshot DB-dump orchestration (the pure dispatch logic).
 *
 * runPreSnapshotHook is fundamentally a side-effect orchestrator (spawns
 * pg_dump|gzip, writes a dump file, logs). The genuinely PURE, branch-y
 * logic worth pinning is the admin-URL → spawn-args derivation: it parses the
 * host's embedded-pg admin URL and feeds host/port/user/password into the
 * pg_dump argv + PGPASSWORD env. This test mocks the entire I/O boundary
 * (child_process, node:fs, node:fs/promises, ./config) so NO process is
 * spawned and NO disk is touched — it asserts the connection params are
 * derived correctly, incl. the port fallback, the postgres user default, and
 * URL-decoding of the password. The empty-dump SKIP branch is also pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  HOST_BACKUP_APPLICATION_NAME,
  WORKSPACE_BACKUP_APPLICATION_NAME,
} from './application-names';

const h = vi.hoisted(() => ({
  guardBin: '/test/kopia-backup-guard.sh',
  adminUrl: { url: 'postgres://postgres:postgres@127.0.0.1:5432/db', source: 'env' },
  spawnCalls: [] as Array<{
    cmd: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    detached?: boolean;
    stdio?: unknown;
  }>,
  // Size returned by the mocked stat() of the temp dump — >=10KiB ⇒ success path.
  dumpSize: 16_384,
  closeCodes: { pg_dump: 0, gzip: 0 } as Record<string, number>,
  stdinWrites: [] as string[],
  writeStreamPaths: [] as string[],
  renameCalls: [] as Array<{ from: string; to: string }>,
  unlinkCalls: [] as string[],
  logLines: [] as string[],
  // When true, the gzip child's stdin emits an EPIPE 'error' before close —
  // the mid-dump broken-pipe crash regression (gz dies while pg_dump streams).
  gzipStdinError: false,
  availableBlocks: 100_000_000,
  // Size of the PREVIOUS dump already on disk, which is what the free-space
  // reserve is now sized from. null ⇒ no previous artifact (fresh workspace),
  // so stat() rejects ENOENT exactly as the real fs would.
  previousDumpSize: null as number | null,
  readdirNames: [] as string[],
  hostCoverageCovered: false,
  hostCoverageReason: 'no host-dump receipt',
  statfsCalls: 0,
  holdGuardOpen: false,
  pendingGuard: null as EventEmitter | null,
  pendingGuardReady: null as EventEmitter | null,
}));

// Fake child: EventEmitter-backed stdout/stderr/stdin (so the real code's
// `dump.stdout.pipe(gz.stdin)` wiring, the stderr 'data' reads, AND the pipe-
// socket 'error' handlers all attach to real emitters), plus kill + the child
// EventEmitter for 'error'/'close'/'exit'. We drive 'close' (and, for the
// regression case, a stdin 'error') to settle the dumpPg promise.
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const mkStream = () => {
    const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
    s.pipe = vi.fn();
    return s;
  };
  child.stdout = mkStream();
  child.stderr = mkStream();
  const guardReady = mkStream();
  child.stdio = [null, child.stdout, child.stderr, guardReady];
  const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdin.write = vi.fn((chunk: string) => { h.stdinWrites.push(String(chunk)); });
  child.stdin = stdin;
  child.kill = vi.fn();
  return child as unknown as import('node:child_process').ChildProcess & EventEmitter;
}

vi.mock('node:child_process', () => ({
  // gzipArgs() probes `gzip --help` once via spawnSync; return rsyncable-capable.
  spawnSync: vi.fn(() => ({ stdout: '  --rsyncable\n', stderr: '' })),
  spawn: vi.fn((
    cmd: string,
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; detached?: boolean; stdio?: unknown },
  ) => {
    const child = fakeChild();
    h.spawnCalls.push({ cmd, args, env: opts?.env, detached: opts?.detached, stdio: opts?.stdio });
    // Settle on next tick: each child closes with the configured code. For the
    // broken-pipe regression, the gzip stdin socket errors first (mid-stream).
    queueMicrotask(() => {
      if (cmd === h.guardBin) {
        const ready = child.stdio[3] as EventEmitter;
        if (h.holdGuardOpen) {
          h.pendingGuard = child;
          h.pendingGuardReady = ready;
          return;
        }
        ready.emit('data', Buffer.from('KOPIA_BACKUP_GUARD_READY\n'));
      }
      if (cmd === 'gzip' && h.gzipStdinError) {
        const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write', errno: -32 });
        (child.stdin as unknown as EventEmitter).emit('error', err);
      }
      // The guard process is the mocked boundary around pg_dump. Preserve the
      // existing outcome controls so the assertions still exercise pg_dump's
      // success/failure branches after adding the real cross-process wrapper.
      const closeCodeKey = cmd === h.guardBin ? 'pg_dump' : cmd;
      child.emit('close', h.closeCodes[closeCodeKey] ?? 0);
    });
    return child;
  }),
}));

vi.mock('node:fs', () => ({
  // out stream: never errors, supports end()/destroyed.
  createWriteStream: vi.fn((path: string) => {
    h.writeStreamPaths.push(String(path));
    return { on: vi.fn(), end: vi.fn(), destroyed: false };
  }),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => {}),
  readdir: vi.fn(async () => h.readdirNames.map((name) => ({ name, isFile: () => true }))),
  // Path-aware: the in-flight `.tmp` (dumpPg's post-dump size check) and the
  // PREVIOUS dump (the reserve-sizing probe) are different files with
  // different sizes, and the reserve test only means something if they can
  // differ here too.
  stat: vi.fn(async (p: string) => {
    if (String(p).endsWith('.tmp')) return { size: h.dumpSize };
    if (h.previousDumpSize === null) {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    }
    return { size: h.previousDumpSize };
  }),
  statfs: vi.fn(async () => {
    h.statfsCalls += 1;
    return { bsize: 4096, bavail: h.availableBlocks, blocks: 200_000_000 };
  }),
  appendFile: vi.fn(async (_p: string, line: string) => {
    h.logLines.push(line);
  }),
  rename: vi.fn(async (from: string, to: string) => {
    h.renameCalls.push({ from, to });
  }),
  unlink: vi.fn(async (path: string) => { h.unlinkCalls.push(path); }),
}));

vi.mock('./host-dump-coverage', () => ({
  hostDumpStatusPath: vi.fn(() => '/host/STATUS.json'),
  readHostDumpStatus: vi.fn(async () => (h.hostCoverageCovered ? { ok: true } : null)),
  probeSystemIdentifier: vi.fn(async () => (h.hostCoverageCovered ? 'cluster-1' : null)),
  evaluateHostDumpCoverage: vi.fn(() => ({
    covered: h.hostCoverageCovered,
    reason: h.hostCoverageReason,
  })),
}));

vi.mock('./config', () => ({
  backupHost: () => ({ getHarnessAdminUrl: () => h.adminUrl }),
}));

import {
  allocateDumpTempPath,
  requiredFreeBytes,
  resolveKopiaBackupGuard,
  runPreSnapshotHook,
  terminateSpawnTree,
  WORKSPACE_BACKUP_GUARD_LABEL,
} from './hook';

const ctx = { workspaceId: 'ws-1', workspaceRoot: '/work/ws-1' };
const originalGuardBin = process.env.KOPIA_BACKUP_GUARD_BIN;
const originalGuardActive = process.env.KOPIA_BACKUP_GUARD_ACTIVE;

beforeEach(() => {
  process.env.KOPIA_BACKUP_GUARD_BIN = h.guardBin;
  delete process.env.KOPIA_BACKUP_GUARD_ACTIVE;
  h.adminUrl = { url: 'postgres://postgres:postgres@127.0.0.1:5432/db', source: 'env' };
  h.spawnCalls = [];
  h.dumpSize = 16_384;
  h.closeCodes = { pg_dump: 0, gzip: 0 };
  h.stdinWrites = [];
  h.writeStreamPaths = [];
  h.renameCalls = [];
  h.unlinkCalls = [];
  h.logLines = [];
  h.gzipStdinError = false;
  h.availableBlocks = 100_000_000;
  h.previousDumpSize = null;
  h.readdirNames = [];
  h.hostCoverageCovered = false;
  h.hostCoverageReason = 'no host-dump receipt';
  h.statfsCalls = 0;
  h.holdGuardOpen = false;
  h.pendingGuard = null;
  h.pendingGuardReady = null;
});
afterEach(() => vi.clearAllMocks());

afterEach(() => {
  if (originalGuardBin === undefined) delete process.env.KOPIA_BACKUP_GUARD_BIN;
  else process.env.KOPIA_BACKUP_GUARD_BIN = originalGuardBin;
  if (originalGuardActive === undefined) delete process.env.KOPIA_BACKUP_GUARD_ACTIVE;
  else process.env.KOPIA_BACKUP_GUARD_ACTIVE = originalGuardActive;
});

const pgDumpCall = () => h.spawnCalls.find((c) => c.cmd === 'pg_dump' || c.args.includes('pg_dump'));

describe('cross-process dump transaction isolation', () => {
  it('allocates a distinct Kopia-ignored temp path for every dump attempt', () => {
    const out = '/work/ws-1/db-dumps/pg-embedded.sql.gz';
    const first = allocateDumpTempPath(out);
    const second = allocateDumpTempPath(out);

    expect(first).not.toBe(second);
    expect(first).toMatch(/pg-embedded\.sql\.gz\.\d+-\d+\.tmp$/);
    expect(second).toMatch(/pg-embedded\.sql\.gz\.\d+-\d+\.tmp$/);
    expect(first).not.toBe(`${out}.tmp`);
    expect(second).not.toBe(`${out}.tmp`);
  });

  it('never reuses the transaction pathname across sequential hook runs', async () => {
    await runPreSnapshotHook(ctx);
    await runPreSnapshotHook(ctx);

    expect(h.writeStreamPaths).toHaveLength(2);
    expect(new Set(h.writeStreamPaths).size).toBe(2);
    expect(h.writeStreamPaths.every((path) => path.endsWith('.tmp'))).toBe(true);
  });

  it('reaps only transaction files whose encoded writer PID is dead', async () => {
    const live = `pg-embedded.sql.gz.${process.pid}-4.tmp`;
    const dead = 'pg-embedded.sql.gz.2147483646-7.tmp';
    h.readdirNames = [live, dead, 'unrelated.tmp'];

    await runPreSnapshotHook(ctx);

    expect(h.unlinkCalls).toContain(`/work/ws-1/db-dumps/${dead}`);
    expect(h.unlinkCalls).not.toContain(`/work/ws-1/db-dumps/${live}`);
    expect(h.unlinkCalls).not.toContain('/work/ws-1/db-dumps/unrelated.tmp');
    expect(h.logLines.join('')).toMatch(/reaped 1 dead-writer transaction/);
  });

  it('reaps a dead-writer transaction before a low-space admission refusal', async () => {
    const dead = 'pg-embedded.sql.gz.2147483646-8.tmp';
    h.readdirNames = [dead];
    h.previousDumpSize = 1_780_687_612;
    h.availableBlocks = Math.floor(2_000_000_000 / 4096);

    await expect(runPreSnapshotHook(ctx)).resolves.toMatchObject({ ok: false });

    expect(h.unlinkCalls).toContain(`/work/ws-1/db-dumps/${dead}`);
    expect(pgDumpCall()).toBeUndefined();
  });
});

describe('runPreSnapshotHook admin-URL → spawn args', () => {
  it('runs pg_dump through the shared wait-mode backup guard', async () => {
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    const pgDumpIndex = c.args.indexOf('pg_dump');

    expect(c.cmd).toBe(h.guardBin);
    expect(c.args.slice(0, pgDumpIndex)).toEqual([
      '--mode', 'wait',
      '--label', WORKSPACE_BACKUP_GUARD_LABEL,
      '--',
    ]);
    expect(pgDumpIndex).toBeGreaterThan(-1);
    expect(c.detached).toBe(process.platform !== 'win32');
    expect(c.env?.KOPIA_BACKUP_GUARD_LOG_STDERR).toBe('1');
    expect(c.env?.KOPIA_BACKUP_GUARD_READY_FD).toBe('3');
    expect(c.env?.KOPIA_BACKUP_GUARD_LOCK_WAIT_TIMEOUT_SEC).toBe('900');
    expect(h.spawnCalls.find((call) => call.cmd === h.guardBin)?.stdio).toEqual([
      'ignore', 'pipe', 'pipe', 'pipe',
    ]);
  });

  it('starts the 900s pg_dump watchdog only after the guard reports lock readiness', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    h.holdGuardOpen = true;
    try {
      const pending = runPreSnapshotHook(ctx);
      for (let i = 0; i < 100 && !h.pendingGuard; i += 1) await Promise.resolve();
      expect(h.pendingGuard).not.toBeNull();

      const delays = () => timeoutSpy.mock.calls.map(([, delay]) => Number(delay));
      expect(delays()).toContain(905_000); // separate guard-readiness backstop
      expect(delays()).not.toContain(900_000); // pg_dump has not acquired the lock

      h.pendingGuardReady!.emit('data', Buffer.from('KOPIA_BACKUP_GUARD_READY\n'));
      expect(delays()).toContain(900_000);
      h.pendingGuard!.emit('close', 0);
      h.pendingGuard = null;
      await expect(pending).resolves.toMatchObject({ ok: true });
    } finally {
      h.pendingGuard?.emit('close', 1);
      h.pendingGuard = null;
      h.holdGuardOpen = false;
      timeoutSpy.mockRestore();
    }
  });

  it('targets the isolated dump process group, not only the guard shell', () => {
    const directKill = vi.fn(() => true);
    const child = { pid: 4242, kill: directKill } as unknown as Pick<
      import('node:child_process').ChildProcess,
      'pid' | 'kill'
    >;
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);

    try {
      terminateSpawnTree(child, true);
      expect(processKill).toHaveBeenCalledWith(-4242, 'SIGKILL');
      expect(directKill).not.toHaveBeenCalled();
    } finally {
      processKill.mockRestore();
    }
  });

  it.each(['linux', 'darwin', 'win32'])('uses the %s guard default and respects an explicit override', async (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    try {
      delete process.env.KOPIA_BACKUP_GUARD_BIN;
      const expected = platform === 'linux'
        ? join(homedir(), '.config', 'kopia', 'kopia-backup-guard.sh')
        : null;
      expect(resolveKopiaBackupGuard()).toBe(expected);
      await expect(runPreSnapshotHook(ctx)).resolves.toMatchObject({ ok: true });
      expect(pgDumpCall()!.cmd).toBe(expected ?? 'pg_dump');

      // A caller-selected guard is honored on every platform, never silently
      // bypassed just because it is not the systemd host's default path.
      h.spawnCalls = [];
      process.env.KOPIA_BACKUP_GUARD_BIN = h.guardBin;
      expect(resolveKopiaBackupGuard()).toBe(h.guardBin);
      await expect(runPreSnapshotHook(ctx)).resolves.toMatchObject({ ok: true });
      expect(pgDumpCall()!.cmd).toBe(h.guardBin);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it('does not re-enter the wait-mode guard when already running inside it', async () => {
    process.env.KOPIA_BACKUP_GUARD_ACTIVE = '1';
    await runPreSnapshotHook(ctx);
    expect(pgDumpCall()!.cmd).toBe('pg_dump');
  });

  it('derives host/port/user from the admin URL into the pg_dump argv', async () => {
    h.adminUrl = { url: 'postgres://alice:pw@db.local:6789/x', source: 'file' };
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    expect(c).toBeDefined();
    expect(c.args).toEqual(expect.arrayContaining(['-h', 'db.local', '-p', '6789', '-U', 'alice', '-w', '-d', 'x', '--no-owner', '--no-privileges', '-n', 'harness_shared']));
    expect(c.args).toContain('--exclude-table-data=harness_shared.route_invocations');
    expect(c.args).toContain('--exclude-table-data=harness_shared.tool_invocations');
    expect(c.args).toContain('--exclude-table-data=harness_shared.benchmark_run_result');
    expect(c.args).toContain('--exclude-table-data=harness_shared.session_turn_chunks');
    expect(c.args).toContain('--exclude-table-data=harness_shared.session_turn_parts');
    expect(c.args).toContain('--exclude-table-data=harness_shared.gateway_payload_blobs');
    expect(c.args).toContain('--exclude-table-data=harness_shared.memory_recall_stats');
    expect(c.args).toContain('--exclude-table-data=harness_shared.memory_recall_query_text');
    expect(c.args).not.toContain('-t');
  });

  it('falls back to port 5432 when the URL omits a port', async () => {
    h.adminUrl = { url: 'postgres://postgres:pw@host/db', source: 'env' };
    await runPreSnapshotHook(ctx);
    expect(pgDumpCall()!.args).toContain('5432');
  });

  it('falls back to the "postgres" user when the URL omits one', async () => {
    h.adminUrl = { url: 'postgres://:pw@host:5432/db', source: 'env' };
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    const uIdx = c.args.indexOf('-U');
    expect(c.args[uIdx + 1]).toBe('postgres');
  });

  it('URL-decodes the password into PGPASSWORD (no plaintext special chars in argv)', async () => {
    // "p@ss/word" encoded → p%40ss%2Fword
    h.adminUrl = { url: 'postgres://u:p%40ss%2Fword@host:5432/db', source: 'env' };
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    expect(c.env?.PGPASSWORD).toBe('p@ss/word');
    // Password is never placed on the argv.
    expect(c.args.join(' ')).not.toContain('p@ss');
  });

  it('URL-decodes the database name and dumps only that database', async () => {
    h.adminUrl = { url: 'postgres://u:pw@host:5432/paper%2Fcusp', source: 'env' };
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    const dIdx = c.args.indexOf('-d');
    expect(dIdx).toBeGreaterThan(-1);
    expect(c.args[dIdx + 1]).toBe('paper/cusp');
    expect(c.cmd).toBe(h.guardBin);
  });

  it('sets a connect timeout in the spawn env', async () => {
    await runPreSnapshotHook(ctx);
    expect(pgDumpCall()!.env?.PGCONNECT_TIMEOUT).toBe('5');
  });

  it('tags the workspace dump backend so migration preflight can avoid its relation locks', async () => {
    await runPreSnapshotHook(ctx);
    expect(pgDumpCall()!.env?.PGAPPNAME).toBe(WORKSPACE_BACKUP_APPLICATION_NAME);
    expect(WORKSPACE_BACKUP_APPLICATION_NAME).not.toBe(HOST_BACKUP_APPLICATION_NAME);
  });

  it('bounds PostgreSQL lock acquisition and statement lifetime below the client watchdog', async () => {
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    expect(c.args).toContain('--lock-wait-timeout=30s');
    expect(c.env?.PGOPTIONS).toContain('-c statement_timeout=600000');
    expect(c.env?.PGOPTIONS).toContain('-c lock_timeout=30000');
  });

  it('includes the vector extension required by harness_shared vector columns', async () => {
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    expect(c.args).toContain('-e');
    expect(c.args).toContain('vector');
  });

  it('also dumps pg_trgm and pgcrypto — EI-13868: a restore drill found these missing, ' +
    'breaking a trigram GIN index (CREATE INDEX validates the operator class at DDL ' +
    'time) and leaving pgcrypto-dependent functions non-functional post-restore', async () => {
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    const eIndexes = c.args.reduce<number[]>((acc, a, i) => {
      if (a === '-e') acc.push(i);
      return acc;
    }, []);
    const eValues = eIndexes.map((i) => c.args[i + 1]);
    expect(eValues).toEqual(expect.arrayContaining(['vector', 'pg_trgm', 'pgcrypto']));
  });

  it('does not prefix a schema preamble because pg_dump -n emits schema DDL', async () => {
    await runPreSnapshotHook(ctx);
    expect(h.stdinWrites.join('')).not.toContain('CREATE SCHEMA IF NOT EXISTS harness_shared;');
  });
});

describe('runPreSnapshotHook outcome logging', () => {
  it('skips before free-space admission when host backup proves the database is covered', async () => {
    h.hostCoverageCovered = true;
    h.hostCoverageReason = 'host PG is covered by db-backup.sh';
    h.availableBlocks = 1;
    h.previousDumpSize = 2_567_922_002;

    await expect(runPreSnapshotHook(ctx)).resolves.toMatchObject({
      ok: true,
      skipped: h.hostCoverageReason,
    });

    expect(h.statfsCalls).toBe(0);
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.logLines.join('')).toMatch(/hook done \(skipped: host-covered\)/);
  });

  it('does not spawn a dump when the workspace filesystem is below its emergency reserve', async () => {
    h.availableBlocks = 1;
    await expect(runPreSnapshotHook(ctx)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/insufficient free space/),
    });
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.logLines.join('')).toMatch(/SKIP: insufficient free space/);
  });

  it('renames the temp dump into place and logs ok on a non-trivial dump', async () => {
    h.dumpSize = 16_384;
    await runPreSnapshotHook(ctx);
    expect(h.renameCalls).toHaveLength(1);
    expect(h.renameCalls[0].to).toContain('pg-embedded.sql.gz');
    expect(h.unlinkCalls).not.toContain('/work/ws-1/db-dumps/pg-embedded.sql.gz');
    expect(h.logLines.join('')).toMatch(/ok \(16384 bytes\)/);
  });

  it('does NOT rename when pg_dump fails even if gzip closes cleanly', async () => {
    h.dumpSize = 16_384;
    h.closeCodes = { pg_dump: 1, gzip: 0 };
    await runPreSnapshotHook(ctx);
    expect(h.renameCalls).toHaveLength(0);
    expect(h.logLines.join('')).toMatch(/FAIL: .*pg_dump exited 1/s);
  });

  it('SKIPs (no rename) and logs empty-dump when the dump is too small to be restorable', async () => {
    h.dumpSize = 215;
    await runPreSnapshotHook(ctx);
    expect(h.renameCalls).toHaveLength(0);
    expect(h.logLines.join('')).toMatch(/SKIP \(empty dump\)/);
  });

  it('logs the admin-URL provenance source', async () => {
    h.adminUrl = { url: 'postgres://postgres:pw@host:5432/db', source: 'PAPERCUSP_PG_PORT' };
    await runPreSnapshotHook(ctx);
    expect(h.logLines.join('')).toMatch(/URL source: PAPERCUSP_PG_PORT/);
  });
});

/**
 * The free-space guard is sized to the DUMP, never to the DISK
 * (EI-20109034777197353).
 *
 * The original rule asked for 10% of total capacity, capped at 100GiB. On this
 * 2TB box that saturated at the cap, so writing a 1.7GB dump demanded 100GiB
 * free — unsatisfiable in normal operation. The guard meant to protect the
 * backup silently DISABLED it, hourly, for 26 hours, while the snapshot ledger
 * kept committing status='ok'.
 *
 * The numbers below are the real measured ones from that incident, so a
 * reserve that drifts back toward a capacity-derived constant fails here.
 */
describe('free-space reserve is sized to the dump, not the disk (EI-20109034777197353)', () => {
  const GIB = 1024n * 1024n * 1024n;
  /** The real dump: ~1.7GB (pg-embedded.sql.gz, 2026-08-09). */
  const REAL_DUMP_BYTES = 1_780_687_612;
  /** Free space at the last skipping tick: ~35GB. */
  const REAL_FREE_BYTES = 35_319_316_480;
  /** What the old rule demanded to write that 1.7GB file. */
  const OLD_RESERVE_BYTES = 107_374_182_400n;
  const blocksFor = (bytes: number) => Math.floor(bytes / 4096);

  it('asks for single-digit GiB to write the real 1.7GB dump — not the 100GiB the old rule demanded', () => {
    const reserve = requiredFreeBytes(BigInt(REAL_DUMP_BYTES));
    expect(reserve).toBeLessThan(10n * GIB);
    expect(reserve).toBeLessThan(OLD_RESERVE_BYTES);
    // Still strictly more than the dump itself: the new .tmp and the previous
    // dump coexist until the closing rename.
    expect(reserve).toBeGreaterThan(BigInt(REAL_DUMP_BYTES) * 2n);
  });

  it('falls back to a fixed floor when no previous dump exists to measure', () => {
    expect(requiredFreeBytes(null)).toBe(3n * GIB);
    expect(requiredFreeBytes(0n)).toBe(3n * GIB);
  });

  it('scales with the dump — a reserve that ignores its input is the original bug', () => {
    const small = requiredFreeBytes(1n * GIB);
    const large = requiredFreeBytes(50n * GIB);
    expect(large).toBeGreaterThan(small);
    // A capacity-derived constant would be equal for both.
    expect(large).not.toBe(small);
  });

  it('THE INCIDENT: 1.7GB dump with 35GB free now PROCEEDS (it skipped hourly for 26h)', async () => {
    h.previousDumpSize = REAL_DUMP_BYTES;
    h.availableBlocks = blocksFor(REAL_FREE_BYTES);
    const result = await runPreSnapshotHook(ctx);
    expect(result.ok).toBe(true);
    expect(pgDumpCall()).toBeDefined();
    expect(h.logLines.join('')).not.toMatch(/insufficient free space/);
  });

  it('still refuses when space is GENUINELY short, naming the dump it sized for', async () => {
    h.previousDumpSize = REAL_DUMP_BYTES;
    h.availableBlocks = blocksFor(2_000_000_000); // 2GB free vs a ~6.4GB need
    await expect(runPreSnapshotHook(ctx)).resolves.toMatchObject({ ok: false });
    expect(h.spawnCalls.filter((c) => c.cmd === 'pg_dump')).toHaveLength(0);
    expect(h.logLines.join('')).toMatch(
      new RegExp(`insufficient free space.*needed for a dump of ${REAL_DUMP_BYTES} bytes`),
    );
  });

  it('reclaims a stale .tmp even on the SKIP path — the orphan outlived 26h of skips', async () => {
    h.previousDumpSize = REAL_DUMP_BYTES;
    h.availableBlocks = blocksFor(2_000_000_000);
    await runPreSnapshotHook(ctx);
    // dumpPg never ran (see the assertion above), so this unlink can ONLY have
    // come from the pre-check — which is the point: under the old ordering the
    // orphaned .tmp was re-captured by every snapshot forever.
    expect(h.unlinkCalls.some((p) => p.endsWith('pg-embedded.sql.gz.tmp'))).toBe(true);
  });
});

describe('runPreSnapshotHook broken-pipe resilience (deploy-crash regression 2026-07-10)', () => {
  // The pg_dump→gzip pipe (`dump.stdout.pipe(gz.stdin)`) is a socket. When gzip
  // dies mid-stream (SIGKILL from the 60s timeout, OOM under load, a crash),
  // gz.stdin becomes a broken pipe and pg_dump's next write throws `write
  // EPIPE`, surfaced as an 'error' EVENT on the gz.stdin Socket — NOT a promise
  // rejection. Without a listener that escaped the resolve-only finalize() +
  // the caller's `.catch()` and crashed the whole DETACHED deploy process at the
  // pre-deploy snapshot step, blocking every green-pin ship. The hook must
  // instead degrade: abandon the dump, resolve, let the snapshot proceed.
  it('does NOT crash (resolves) when the gzip stdin pipe emits EPIPE mid-dump', async () => {
    h.gzipStdinError = true;
    await expect(runPreSnapshotHook(ctx)).resolves.toMatchObject({ ok: false });
  });

  it('degrades to no-rename and logs the pipe failure on a stdin EPIPE', async () => {
    h.gzipStdinError = true;
    await runPreSnapshotHook(ctx);
    expect(h.renameCalls).toHaveLength(0);
    expect(h.unlinkCalls.filter((p) => p.endsWith('.tmp')).length).toBeGreaterThanOrEqual(2);
    expect(h.logLines.join('')).toMatch(/gzip stdin pipe failed: write EPIPE/);
  });
});
