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

const h = vi.hoisted(() => ({
  adminUrl: { url: 'postgres://postgres:postgres@127.0.0.1:5432/db', source: 'env' },
  spawnCalls: [] as Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }>,
  // Size returned by the mocked stat() of the temp dump — >100 ⇒ success path.
  dumpSize: 5000,
  closeCodes: { pg_dump: 0, gzip: 0 } as Record<string, number>,
  stdinWrites: [] as string[],
  renameCalls: [] as Array<{ from: string; to: string }>,
  logLines: [] as string[],
}));

// Fake child: a piped stdout/stderr + stdin, kill, and EventEmitter for
// 'error'/'close'/'exit'. We drive 'close' to settle the dumpPg promise.
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const mkStream = () => ({ pipe: vi.fn(), on: vi.fn() });
  child.stdout = mkStream();
  child.stderr = mkStream();
  child.stdin = { write: vi.fn((chunk: string) => { h.stdinWrites.push(String(chunk)); }) };
  child.kill = vi.fn();
  return child as unknown as import('node:child_process').ChildProcess & EventEmitter;
}

vi.mock('node:child_process', () => ({
  // gzipArgs() probes `gzip --help` once via spawnSync; return rsyncable-capable.
  spawnSync: vi.fn(() => ({ stdout: '  --rsyncable\n', stderr: '' })),
  spawn: vi.fn((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const child = fakeChild();
    h.spawnCalls.push({ cmd, args, env: opts?.env });
    // Settle on next tick: each child closes with the configured code.
    queueMicrotask(() => child.emit('close', h.closeCodes[cmd] ?? 0));
    return child;
  }),
}));

vi.mock('node:fs', () => ({
  // out stream: never errors, supports end()/destroyed.
  createWriteStream: vi.fn(() => ({ on: vi.fn(), end: vi.fn(), destroyed: false })),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ size: h.dumpSize })),
  appendFile: vi.fn(async (_p: string, line: string) => {
    h.logLines.push(line);
  }),
  rename: vi.fn(async (from: string, to: string) => {
    h.renameCalls.push({ from, to });
  }),
  unlink: vi.fn(async () => {}),
}));

vi.mock('./config', () => ({
  backupHost: () => ({ getHarnessAdminUrl: () => h.adminUrl }),
}));

import { runPreSnapshotHook } from './hook.ts';

const ctx = { workspaceId: 'ws-1', workspaceRoot: '/work/ws-1' };

beforeEach(() => {
  h.adminUrl = { url: 'postgres://postgres:postgres@127.0.0.1:5432/db', source: 'env' };
  h.spawnCalls = [];
  h.dumpSize = 5000;
  h.closeCodes = { pg_dump: 0, gzip: 0 };
  h.stdinWrites = [];
  h.renameCalls = [];
  h.logLines = [];
});
afterEach(() => vi.clearAllMocks());

const pgDumpCall = () => h.spawnCalls.find((c) => c.cmd === 'pg_dump');

describe('runPreSnapshotHook admin-URL → spawn args', () => {
  it('derives host/port/user from the admin URL into the pg_dump argv', async () => {
    h.adminUrl = { url: 'postgres://alice:pw@db.local:6789/x', source: 'file' };
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    expect(c).toBeDefined();
    expect(c.args).toEqual(expect.arrayContaining(['-h', 'db.local', '-p', '6789', '-U', 'alice', '-w', '-d', 'x', '--no-owner', '--no-privileges', '-n', 'harness_shared']));
    expect(c.args).toContain('--exclude-table-data=harness_shared.route_invocations');
    expect(c.args).toContain('--exclude-table-data=harness_shared.tool_invocations');
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
    expect(c.cmd).toBe('pg_dump');
  });

  it('sets a connect timeout in the spawn env', async () => {
    await runPreSnapshotHook(ctx);
    expect(pgDumpCall()!.env?.PGCONNECT_TIMEOUT).toBe('5');
  });

  it('prefixes a schema preamble so selected-table dumps restore into a clean DB', async () => {
    await runPreSnapshotHook(ctx);
    expect(h.stdinWrites.join('')).toContain('CREATE SCHEMA IF NOT EXISTS harness_shared;');
  });
});

describe('runPreSnapshotHook outcome logging', () => {
  it('renames the temp dump into place and logs ok on a non-trivial dump (>100 bytes)', async () => {
    h.dumpSize = 4096;
    await runPreSnapshotHook(ctx);
    expect(h.renameCalls).toHaveLength(1);
    expect(h.renameCalls[0].to).toContain('pg-embedded.sql.gz');
    expect(h.logLines.join('')).toMatch(/ok \(4096 bytes\)/);
  });

  it('does NOT rename when pg_dump fails even if gzip closes cleanly', async () => {
    h.dumpSize = 4096;
    h.closeCodes = { pg_dump: 1, gzip: 0 };
    await runPreSnapshotHook(ctx);
    expect(h.renameCalls).toHaveLength(0);
    expect(h.logLines.join('')).toMatch(/FAIL: .*pg_dump exited 1/s);
  });

  it('SKIPs (no rename) and logs empty-dump when the dump is ≤100 bytes', async () => {
    h.dumpSize = 12;
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
