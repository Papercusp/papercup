import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveSpawnerSocketPath,
  ownerPidFromSocketPath,
  SPAWNER_SOCKET_ENV,
} from './spawner-socket-path';

// Mirror of sync/hyperbee/substrate-socket-path.test.ts for the SPAWNER sidecar
// (WI-344 ③, plan spawner-sidecar-offload-2026-06-30 P-001/P-006). Guards the
// exact packaged-deploy regression the substrate sidecar hit: a CWD-relative
// `.papercusp/*.sock` default `mkdir`s against a root-owned install dir → EACCES →
// silent in-process fallback, so the offload never engages off a dev tree.
const ORIG = process.env[SPAWNER_SOCKET_ENV];
afterEach(() => {
  if (ORIG === undefined) delete process.env[SPAWNER_SOCKET_ENV];
  else process.env[SPAWNER_SOCKET_ENV] = ORIG;
});

describe('resolveSpawnerSocketPath (WI-344 ③)', () => {
  it('honours PAPERCUSP_SPAWNER_IPC_SOCKET when set (so spawner + client + child agree)', () => {
    process.env[SPAWNER_SOCKET_ENV] = '/run/papercusp/spawner.sock';
    expect(resolveSpawnerSocketPath()).toBe('/run/papercusp/spawner.sock');
  });

  it('ignores an empty/whitespace env value and falls back to the absolute default', () => {
    process.env[SPAWNER_SOCKET_ENV] = '   ';
    const p = resolveSpawnerSocketPath();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.startsWith(os.tmpdir())).toBe(true);
  });

  it('defaults to an ABSOLUTE tmpdir path keyed by pid — never the CWD-relative .papercusp that EACCES-failed on a packaged root-owned CWD', () => {
    delete process.env[SPAWNER_SOCKET_ENV];
    const p = resolveSpawnerSocketPath();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toBe(path.join(os.tmpdir(), `papercusp-spawner-${process.pid}.sock`));
    // The exact regression: must NOT be a bare/relative `.papercusp/...` path.
    expect(p.startsWith('.papercusp')).toBe(false);
    expect(p).not.toBe(path.join('.papercusp', 'spawner.sock'));
  });

  it('trims a surrounding-whitespace env value to the bare path', () => {
    process.env[SPAWNER_SOCKET_ENV] = '  /tmp/x/spawner.sock  ';
    expect(resolveSpawnerSocketPath()).toBe('/tmp/x/spawner.sock');
  });
});

describe('ownerPidFromSocketPath (P-005 — the orphan watchdog’s only input)', () => {
  it('ROUND-TRIPS with the default path — the writer and the reader cannot drift apart', () => {
    // The load-bearing guard. The pid in the socket name is the ONLY record of
    // which host a sidecar serves, so if the default name format ever changes
    // without this reader changing with it, `ownerPidFromSocketPath` silently
    // returns null, the watchdog silently never arms, and the leak silently comes
    // back — with nothing failing anywhere. This test is what makes that loud.
    delete process.env[SPAWNER_SOCKET_ENV];
    expect(ownerPidFromSocketPath(resolveSpawnerSocketPath())).toBe(process.pid);
  });

  it('reads the owner pid out of a pid-keyed path regardless of directory', () => {
    expect(ownerPidFromSocketPath('/tmp/papercusp-spawner-12345.sock')).toBe(12345);
    expect(ownerPidFromSocketPath('/some/other/dir/papercusp-spawner-1.sock')).toBe(1);
  });

  it('returns null — not a guess — for a path that names no owner', () => {
    // An explicitly-configured PAPERCUSP_SPAWNER_IPC_SOCKET. UNKNOWN must stay
    // unknown: the watchdog refuses to arm rather than risk shutting down a
    // healthy sidecar whose owner it cannot identify.
    for (const p of [
      '/run/papercusp/spawner.sock',
      '/tmp/papercusp-spawner.sock',
      '/tmp/papercusp-spawner-.sock',
      '/tmp/papercusp-spawner-abc.sock',
      '/tmp/papercusp-spawner-12345.socket',
      '/tmp/prefix-papercusp-spawner-12345.sock',
      '',
    ]) {
      expect(ownerPidFromSocketPath(p), p).toBeNull();
    }
  });

  it('rejects a non-positive pid rather than returning 0', () => {
    // 0 is falsy AND is a real kill(2) target meaning "my whole process group" —
    // treating it as an owner pid would be both a logic bug and a dangerous one.
    expect(ownerPidFromSocketPath('/tmp/papercusp-spawner-0.sock')).toBeNull();
  });
});
