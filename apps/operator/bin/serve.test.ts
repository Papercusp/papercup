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

describe('isOrphanedFromParent (EI-8894)', () => {
  it('is false when the ppid is unchanged', () => {
    expect(serve.isOrphanedFromParent(100, 100)).toBe(false);
  });
  it('is true when the ppid changed (reparented — original parent gone)', () => {
    expect(serve.isOrphanedFromParent(100, 1)).toBe(true);
    expect(serve.isOrphanedFromParent(100, 42)).toBe(true);
  });
  it('is false when there was no original parent to compare against (0)', () => {
    expect(serve.isOrphanedFromParent(0, 1)).toBe(false);
  });
});

describe('startParentDeathWatch (EI-8894)', () => {
  const origDesktop = process.env.PAPERCUSP_DESKTOP;
  afterEach(() => {
    if (origDesktop === undefined) delete process.env.PAPERCUSP_DESKTOP;
    else process.env.PAPERCUSP_DESKTOP = origDesktop;
  });

  it('is a no-op outside desktop mode (PAPERCUSP_DESKTOP unset) — never fires the callback', () => {
    delete process.env.PAPERCUSP_DESKTOP;
    let fired = false;
    // No timer is armed at all in this mode; calling it must not throw and
    // must not schedule anything that could later fire.
    expect(() => serve.startParentDeathWatch(() => {
      fired = true;
    })).not.toThrow();
    expect(fired).toBe(false);
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

// WI-3287 recurrence guard: found live on the first real packaged-Linux
// env-switcher verify (2026-07-07) — a bundled env-sidecar sibling
// (env-operator-launcher.ts's `prod`/`staging`) re-execs this SAME serve.mjs
// under the SAME $HOME as the primary. Before PAPERCUSP_ENV_OPERATOR_ID
// scoping, its acquireColdStartLock() call collided with the primary's
// `operator.lock` — which the primary holds for its ENTIRE lifetime (only
// released on shutdown) — so every env-sidecar boot permanently failed with
// "another `serve` holds the cold-start lock" the instant the primary was up.
describe('cold-start lock scoping for env-operator siblings (PAPERCUSP_ENV_OPERATOR_ID)', () => {
  const stagingLock = () => join(pcDir(), serve.lockFileNameForEnvId('staging'));
  const prodLock = () => join(pcDir(), serve.lockFileNameForEnvId('prod'));

  afterEach(() => {
    rmSync(lockFile(), { force: true });
    rmSync(stagingLock(), { force: true });
    rmSync(prodLock(), { force: true });
  });

  it('the primary (no id) and every env-sidecar id resolve to distinct, well-formed lock filenames', () => {
    expect(serve.lockFileNameForEnvId(null)).toBe('operator.lock');
    expect(serve.lockFileNameForEnvId('staging')).toBe('operator.lock.env-staging');
    expect(serve.lockFileNameForEnvId('prod')).toBe('operator.lock.env-prod');
    // No two distinct ids (including the primary's null) ever collide.
    const names = [null, 'prod', 'staging', 'dev', 'local'].map((id) =>
      serve.lockFileNameForEnvId(id),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it('a sibling lock file can be acquired while the primary (unscoped) lock is held', () => {
    // Primary holds its own lock for its entire lifetime (released only on
    // shutdown) — the bug (found live 2026-07-07) was every sibling boot
    // colliding with THIS still-held lock via the same fixed path.
    expect(serve.acquireColdStartLock()).toBe(true);
    try {
      // Simulate a sibling's own acquire against its SCOPED path directly —
      // writeFileSync mirrors acquireColdStartLock's own `wx` (O_EXCL) create.
      expect(() => writeFileSync(stagingLock(), '12345', { flag: 'wx' })).not.toThrow();
      expect(statSync(stagingLock()).isFile()).toBe(true);
      // A second, different sibling id is likewise unaffected by both.
      expect(() => writeFileSync(prodLock(), '12346', { flag: 'wx' })).not.toThrow();
    } finally {
      serve.releaseColdStartLock();
    }
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

  it('NEVER kills a live process that is not our postgres (only touches the lockfile)', async () => {
    mkdirSync(dataDir(), { recursive: true });
    // Our own (vitest) pid: alive, but cmdline is node/vitest — not postgres.
    // The recorded port (line 4) is a live listener, so a real server may hold
    // the dir → leave the file intact AND never signal the process (we must
    // still be alive afterwards, trivially true if the test completes).
    const { createServer } = await import('node:net');
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as import('node:net').AddressInfo).port;
    try {
      writeFileSync(pidFile(), `${process.pid}\n${dataDir()}\n0\n${port}\n`);
      await serve.sweepOrphanPostgres(dataDir(), logFn);
      expect(statSync(pidFile(), { throwIfNoEntry: false })).toBeDefined();
      expect(logs.join('\n')).toMatch(/is accepting.*leaving it alone/s);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('clears a stale lockfile whose pid was reused by a non-postgres process (WI-3360)', async () => {
    mkdirSync(dataDir(), { recursive: true });
    // Alive pid, cmdline not postgres, and the recorded port has NO listener —
    // i.e. the postgres that wrote this file is dead and its (low, WSL-recycled)
    // pid now belongs to something else. Leaving the file would FATAL the next
    // pg.start() with "lock file already exists" and crash-loop the operator, so
    // the stale lockfile must be cleared (the process itself is never touched).
    const { createServer } = await import('node:net');
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const deadPort = (probe.address() as import('node:net').AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r())); // free it → nothing accepts
    writeFileSync(pidFile(), `${process.pid}\n${dataDir()}\n0\n${deadPort}\n`);
    await serve.sweepOrphanPostgres(dataDir(), logFn);
    expect(statSync(pidFile(), { throwIfNoEntry: false })).toBeUndefined();
    expect(logs.join('\n')).toMatch(/not accepting.*unlinking/s);
  });
});

describe('isPortAccepting', () => {
  it('is true for a live listener and false for a free port', async () => {
    const { createServer } = await import('node:net');
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as import('node:net').AddressInfo).port;
    expect(await serve.isPortAccepting(port)).toBe(true);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await serve.isPortAccepting(port)).toBe(false);
  });

  it('is false for an invalid port', async () => {
    expect(await serve.isPortAccepting(0)).toBe(false);
    expect(await serve.isPortAccepting(-1)).toBe(false);
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

// WI-3385 recurrence guard: the launcher spawns serve with PORT /
// PAPERCUSP_HONO_PORT / PAPERCUSP_OPERATOR_BASE all naming its cold-start
// port HINT; when resolveStickyPort re-binds the remembered port instead
// (every desktop boot after the first), any consumer reading those envs —
// worst: the endpoint-IPC sys:http upstream base, i.e. ALL bridged sync
// SSE + REST — dialed the dead hint port forever (the permanent "Operator
// connection lost" banner). The resolved port must overwrite ALL of them
// before the host modules load.
describe('exportResolvedPortEnv (stale launcher-hint env class fix, WI-3385)', () => {
  it('overwrites every port-naming env var with the RESOLVED port', () => {
    const env: NodeJS.ProcessEnv = {
      PORT: '17183', // the launcher's hint — nothing listens here after re-bind
      PAPERCUSP_HONO_PORT: '17183',
      PAPERCUSP_OPERATOR_BASE: 'http://localhost:17183',
    };
    serve.exportResolvedPortEnv(17366, env);
    expect(env.PORT).toBe('17366');
    expect(env.PAPERCUSP_HONO_PORT).toBe('17366');
    expect(env.PAPERCUSP_OPERATOR_BASE).toBe('http://127.0.0.1:17366');
  });

  it('seeds the vars even when the launcher never set them (first boot / bare env)', () => {
    const env: NodeJS.ProcessEnv = {};
    serve.exportResolvedPortEnv(3070, env);
    expect(env.PORT).toBe('3070');
    expect(env.PAPERCUSP_HONO_PORT).toBe('3070');
    expect(env.PAPERCUSP_OPERATOR_BASE).toBe('http://127.0.0.1:3070');
  });

  it('is a loopback-IP base (127.0.0.1, never localhost — no resolver/IPv6 ambiguity)', () => {
    const env: NodeJS.ProcessEnv = {};
    serve.exportResolvedPortEnv(17366, env);
    expect(env.PAPERCUSP_OPERATOR_BASE).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
