import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveSubstrateSocketPath, SUBSTRATE_SOCKET_ENV } from './substrate-socket-path';

const ORIG = process.env[SUBSTRATE_SOCKET_ENV];
afterEach(() => {
  if (ORIG === undefined) delete process.env[SUBSTRATE_SOCKET_ENV];
  else process.env[SUBSTRATE_SOCKET_ENV] = ORIG;
});

describe('resolveSubstrateSocketPath (P-006)', () => {
  it('honours PAPERCUSP_SUBSTRATE_IPC_SOCKET when set (so spawner + client + child agree)', () => {
    process.env[SUBSTRATE_SOCKET_ENV] = '/run/papercusp/substrate.sock';
    expect(resolveSubstrateSocketPath()).toBe('/run/papercusp/substrate.sock');
  });

  it('ignores an empty/whitespace env value and falls back to the absolute default', () => {
    process.env[SUBSTRATE_SOCKET_ENV] = '   ';
    const p = resolveSubstrateSocketPath();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.startsWith(os.tmpdir())).toBe(true);
  });

  it('defaults to an ABSOLUTE tmpdir path keyed by pid — never the CWD-relative .papercusp that EACCES-failed on a packaged root-owned CWD', () => {
    delete process.env[SUBSTRATE_SOCKET_ENV];
    const p = resolveSubstrateSocketPath();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toBe(path.join(os.tmpdir(), `papercusp-substrate-${process.pid}.sock`));
    // The exact regression: must NOT be a bare/relative `.papercusp/...` path.
    expect(p.startsWith('.papercusp')).toBe(false);
    expect(p).not.toBe(path.join('.papercusp', 'substrate.sock'));
  });
});
