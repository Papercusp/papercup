/**
 * Unit tests for the headless `serve` helpers (SP1 C6 —
 * operator-core-headless-serve-2026-06-04).
 *
 * These exercise the pure/FS helpers WITHOUT booting a server: the module is
 * imported after `HOME` is pointed at a temp dir, so its homedir()-derived
 * path constants resolve under the temp dir (and never touch the real
 * ~/.papercusp). The entry guard in serve.ts keeps `main()` from running on
 * import. A full-boot integration test requires embedded-pg on an isolated
 * DB + alternate ports and runs under the desktop/CI (see the plan's Testing
 * section) — it is intentionally NOT here, because runBootstrap() starts
 * background tickers that must never touch the shared/native DB.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpHome: string;
let origHome: string | undefined;
let serve: typeof import('./serve');

const pcDir = () => join(tmpHome, '.papercusp');
const operatorJson = () => join(pcDir(), 'operator.json');
const tokenFile = () => join(pcDir(), 'superuser-token');
const lockFile = () => join(pcDir(), 'operator.lock');

beforeAll(async () => {
  origHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'serve-test-'));
  // os.homedir() honours $HOME on POSIX, so the module's path constants bind
  // to tmpHome at import. Restore the real HOME afterwards — the constants are
  // already captured, so the rest of the process is unaffected.
  process.env.HOME = tmpHome;
  serve = await import('./serve');
  process.env.HOME = origHome;
});

afterAll(() => {
  process.env.HOME = origHome;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('pidAlive', () => {
  it('is true for the current process', () => {
    expect(serve.pidAlive(process.pid)).toBe(true);
  });
  it('is false for a nonexistent pid', () => {
    expect(serve.pidAlive(2 ** 30)).toBe(false);
  });
  it('is false for 0 / negative', () => {
    expect(serve.pidAlive(0)).toBe(false);
    expect(serve.pidAlive(-1)).toBe(false);
  });
});

describe('writeJsonAtomic + readOperatorDiscovery', () => {
  afterEach(() => {
    rmSync(operatorJson(), { force: true });
  });

  it('round-trips discovery and writes owner-only perms (0600 file / 0700 dir)', async () => {
    const disc = {
      httpUrl: 'http://127.0.0.1:3070',
      port: 3070,
      token: 'super-secret-token',
      pid: process.pid,
      startedAt: Date.now(),
      version: 'test',
    };
    await serve.writeJsonAtomic(operatorJson(), disc);

    const read = serve.readOperatorDiscovery();
    expect(read).toMatchObject({
      httpUrl: disc.httpUrl,
      port: 3070,
      token: 'super-secret-token',
      pid: process.pid,
    });

    // Credential files must not be world/group readable.
    expect(statSync(operatorJson()).mode & 0o777).toBe(0o600);
    expect(statSync(pcDir()).mode & 0o777).toBe(0o700);
  });

  it('returns null when the file is missing', () => {
    expect(serve.readOperatorDiscovery()).toBeNull();
  });

  it('returns null when the file is corrupt', () => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(operatorJson(), 'not-json{');
    expect(serve.readOperatorDiscovery()).toBeNull();
  });
});

describe('readToken', () => {
  afterEach(() => {
    rmSync(tokenFile(), { force: true });
  });

  it('reads and trims the superuser token', () => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(tokenFile(), '  tok-123\n');
    expect(serve.readToken()).toBe('tok-123');
  });

  it('returns null when the token file is absent', () => {
    expect(serve.readToken()).toBeNull();
  });
});

describe('cold-start lock (singleton guard)', () => {
  afterEach(() => {
    rmSync(lockFile(), { force: true });
  });

  it('acquires, blocks a re-acquire while a live owner holds it, then frees on release', () => {
    expect(serve.acquireColdStartLock()).toBe(true); // we now own it
    expect(serve.acquireColdStartLock()).toBe(false); // held by a live pid (us)
    serve.releaseColdStartLock(); // owner === our pid → removed
    expect(serve.acquireColdStartLock()).toBe(true); // free again
    serve.releaseColdStartLock();
  });

  it('reclaims a stale lock whose owner is dead', () => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(lockFile(), String(2 ** 30)); // a dead pid
    expect(serve.acquireColdStartLock()).toBe(true); // reclaimed
    serve.releaseColdStartLock();
  });

  it('creates ~/.papercusp if it does not exist yet (fresh machine)', () => {
    rmSync(pcDir(), { recursive: true, force: true });
    expect(serve.acquireColdStartLock()).toBe(true);
    serve.releaseColdStartLock();
  });
});

describe('sweepOrphanPostgres', () => {
  const dataDir = () => join(tmpHome, 'pg-data');
  const pidFile = () => join(dataDir(), 'postmaster.pid');
  const logs: string[] = [];
  const logFn = (m: string) => logs.push(m);

  afterEach(() => {
    logs.length = 0;
    rmSync(dataDir(), { recursive: true, force: true });
  });

  it('is a no-op when there is no postmaster.pid', async () => {
    mkdirSync(dataDir(), { recursive: true });
    await serve.sweepOrphanPostgres(dataDir(), logFn);
    expect(logs).toEqual([]);
  });

  it('unlinks a stale postmaster.pid whose owner is dead', async () => {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(pidFile(), `${2 ** 30}\n/some/data/dir\n`);
    await serve.sweepOrphanPostgres(dataDir(), logFn);
    expect(statSync(pidFile(), { throwIfNoEntry: false })).toBeUndefined();
    expect(logs.join('\n')).toMatch(/stale postmaster\.pid/);
  });

  it('leaves a malformed pid file alone (logs, does not unlink)', async () => {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(pidFile(), 'not-a-pid\n');
    await serve.sweepOrphanPostgres(dataDir(), logFn);
    expect(statSync(pidFile(), { throwIfNoEntry: false })).toBeDefined();
    expect(logs.join('\n')).toMatch(/malformed pid/);
  });

  it('does NOT kill a live process that is not our postgres', async () => {
    mkdirSync(dataDir(), { recursive: true });
    // Our own (vitest) pid: alive, but cmdline is node/vitest — not postgres
    // pointed at dataDir. Must be left alone, file intact, and we must still
    // be alive afterwards (trivially true if the test completes).
    writeFileSync(pidFile(), `${process.pid}\n`);
    await serve.sweepOrphanPostgres(dataDir(), logFn);
    expect(statSync(pidFile(), { throwIfNoEntry: false })).toBeDefined();
    expect(logs.join('\n')).toMatch(/leaving it alone/);
  });
});

describe('sticky operator port (stale-port-pin class fix, 2026-07-07)', () => {
  const portMemory = () => join(pcDir(), 'operator-port.json');
  afterEach(() => {
    rmSync(portMemory(), { force: true });
  });

  it('readRememberedPort round-trips a persisted port and rejects missing/corrupt/invalid', () => {
    expect(serve.readRememberedPort()).toBeNull();
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(portMemory(), JSON.stringify({ port: 17333 }));
    expect(serve.readRememberedPort()).toBe(17333);
    writeFileSync(portMemory(), 'not-json{');
    expect(serve.readRememberedPort()).toBeNull();
    writeFileSync(portMemory(), JSON.stringify({ port: 0 }));
    expect(serve.readRememberedPort()).toBeNull();
    writeFileSync(portMemory(), JSON.stringify({ port: 99999 }));
    expect(serve.readRememberedPort()).toBeNull();
  });

  it('portAvailable is true for a free port and false for a held one', async () => {
    const { createServer } = await import('node:net');
    const holder = createServer();
    const held = await new Promise<number>((resolve) => {
      holder.listen(0, '127.0.0.1', () => {
        resolve((holder.address() as { port: number }).port);
      });
    });
    try {
      expect(await serve.portAvailable(held, '127.0.0.1')).toBe(false);
    } finally {
      await new Promise((r) => holder.close(r));
    }
    expect(await serve.portAvailable(held, '127.0.0.1')).toBe(true);
  });

  it('resolveStickyPort prefers the remembered port on the desktop when free — a restart keeps pinned client URLs valid', async () => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(portMemory(), JSON.stringify({ port: 18742 }));
    const port = await serve.resolveStickyPort(19999, '127.0.0.1', { PAPERCUSP_DESKTOP: '1' });
    expect(port).toBe(18742);
  });

  it('resolveStickyPort falls back to the launcher hint when the remembered port is taken', async () => {
    const { createServer } = await import('node:net');
    const holder = createServer();
    const held = await new Promise<number>((resolve) => {
      holder.listen(0, '127.0.0.1', () => {
        resolve((holder.address() as { port: number }).port);
      });
    });
    try {
      mkdirSync(pcDir(), { recursive: true });
      writeFileSync(portMemory(), JSON.stringify({ port: held }));
      const port = await serve.resolveStickyPort(19999, '127.0.0.1', { PAPERCUSP_DESKTOP: '1' });
      expect(port).toBe(19999);
    } finally {
      await new Promise((r) => holder.close(r));
    }
  });

  it('resolveStickyPort NEVER second-guesses a non-desktop boot (dev box / tests pin their port deliberately)', async () => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(portMemory(), JSON.stringify({ port: 18742 }));
    expect(await serve.resolveStickyPort(3070, '127.0.0.1', {})).toBe(3070);
    expect(await serve.resolveStickyPort(3070, '127.0.0.1', { PAPERCUSP_DESKTOP: '0' })).toBe(3070);
  });

  it('resolveStickyPort with no memory returns the hint (first desktop boot seeds it later)', async () => {
    expect(await serve.resolveStickyPort(19999, '127.0.0.1', { PAPERCUSP_DESKTOP: '1' })).toBe(19999);
  });
});
