/**
 * psu-pty-discovery.test.ts — the operator's read side of the psu-hosted
 * managed-pty control socket (turn-lifecycle-control Phase 3, P-014).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import {
  findLiveHost,
  hostSupports,
  injectIntoHost,
  interruptViaPty,
  recolorViaPty,
  pidIsPsuHost,
  pruneDeadDiscoveryFiles,
  sanitizeKey,
  PSU_PTY_DIR,
  type PsuPtyHost,
} from './psu-pty-discovery';

// WI-2339 defect #2: findLiveHost/listLiveHosts now cross-check that the recorded pid is
// actually a psu session host (pidIsPsuHost). Tests below write `process.pid` (the vitest
// runner — cmdline has no psu marker) as a live-host STAND-IN, so they inject a trivial
// verifyIdentity to isolate the socket/pid-alive behavior from the identity gate (which
// has its own focused tests). ID_OK == "treat the stand-in pid as a valid host".
const ID_OK = { verifyIdentity: () => true } as const;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'psu-pty-disc-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A live unix-socket server in `dir` for `ownerId`; resolves the bytes it
 *  receives. Returns the socket path. */
function startSocket(dir: string, ownerId: string): { sock: string; received: Promise<string> } {
  const sock = join(dir, `${sanitizeKey(ownerId)}.sock`);
  let resolveRecv!: (s: string) => void;
  const received = new Promise<string>((r) => (resolveRecv = r));
  const server = net.createServer((conn) => {
    const chunks: Buffer[] = [];
    conn.on('data', (d) => chunks.push(d));
    conn.on('end', () => resolveRecv(Buffer.concat(chunks).toString('utf8')));
  });
  server.listen(sock);
  cleanups.push(() => server.close());
  return { sock, received };
}

function writeMeta(dir: string, ownerId: string, meta: Record<string, unknown>): void {
  writeFileSync(join(dir, `${sanitizeKey(ownerId)}.json`), JSON.stringify({ ownerId, ...meta }));
}

describe('findLiveHost', () => {
  it('returns null when no discovery file exists', () => {
    expect(findLiveHost('su-nope', tmpDir())).toBeNull();
  });

  it('returns null for a dead host pid (file lingered after a crash)', () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-dead');
    // pid 2^31-1 is ~never a live process.
    writeMeta(dir, 'su-dead', { pid: 2147483646, ptyPid: 2147483645, sock, command: 'x', startedAt: 1 });
    expect(findLiveHost('su-dead', dir)).toBeNull();
  });

  it('returns null when the host pid is alive but the socket file is gone', () => {
    const dir = tmpDir();
    writeMeta(dir, 'su-nosock', {
      pid: process.pid,
      ptyPid: process.pid,
      sock: join(dir, 'su-nosock.sock'), // never created
      command: 'x',
      startedAt: 1,
    });
    expect(findLiveHost('su-nosock', dir)).toBeNull();
  });

  it('returns the host when pid is alive AND the socket exists AND identity verifies', () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-live');
    writeMeta(dir, 'su-live', { pid: process.pid, ptyPid: process.pid, sock, command: 'claude-su', startedAt: 1 });
    const h = findLiveHost('su-live', dir, ID_OK);
    expect(h).not.toBeNull();
    expect(h!.sock).toBe(sock);
    expect(h!.ownerId).toBe('su-live');
  });

  it('WI-2339 defect #2: rejects a pid-alive + socket-live host whose pid is NOT a psu process (recycled-pid false positive)', () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-reused');
    // A genuinely alive pid + bound socket + matching ownerId — ONLY the identity
    // gate can reject it. verifyIdentity:()=>false simulates "pid's cmdline has no
    // psu-launcher/psu-pty-host marker" (an unrelated process on a recycled pid).
    writeMeta(dir, 'su-reused', { pid: process.pid, ptyPid: process.pid, sock, command: 'claude-su', startedAt: 1 });
    expect(findLiveHost('su-reused', dir, { verifyIdentity: () => false })).toBeNull();
    // and with the DEFAULT verifier on Linux, the vitest process.pid (cmdline = node/vitest,
    // no psu marker) is likewise rejected — proving the real default gate is wired, not just the seam.
    if (existsSync('/proc')) expect(findLiveHost('su-reused', dir)).toBeNull();
  });

  it('EI-151: returns null when the recorded ownerId differs from the requested key (cross-owner misroute)', () => {
    // A live, otherwise-valid host file sitting at agent A's discovery path, but
    // RECORDED as agent B (a sanitizeKey collision or a stale-reuse during a
    // /loop re-host). Resolving it would inject A's wake / turn:interrupt into
    // B's live session — the EI-151 cross-agent misroute. Must be rejected.
    const dir = tmpDir();
    // Write the file at owner A's filename, but with content ownerId = B, and a
    // genuinely live pid + bound socket so ONLY the identity check can reject it.
    const sock = join(dir, `${sanitizeKey('su-A')}.sock`);
    const server = net.createServer();
    server.listen(sock);
    cleanups.push(() => server.close());
    writeFileSync(
      join(dir, `${sanitizeKey('su-A')}.json`),
      JSON.stringify({ ownerId: 'su-B', pid: process.pid, ptyPid: process.pid, sock, command: 'claude-su', startedAt: 1 }),
    );
    expect(findLiveHost('su-A', dir)).toBeNull();
  });
});

describe('pidIsPsuHost (WI-2339 defect #2 — process-identity gate)', () => {
  // The DEFAULT reads /proc; these inject readCmdline to test the marker logic
  // deterministically. Marker strings mirror the REAL launcher cmdline verified
  // against ~15 live hosts on 2026-07-04 (post 50341).
  it('ACCEPTS the real psu-launcher.mjs cmdline (the empirical recorded-pid process)', () => {
    const cmd = 'node /home/x/papercupai-workspace/papercusp/apps/operator/scripts/psu-launcher.mjs --no-picker --agent=claude --role=sentinel';
    expect(pidIsPsuHost(1234, () => cmd)).toBe(true);
  });
  it('ACCEPTS a direct psu-pty-host.mjs cmdline too (marker covers both)', () => {
    expect(pidIsPsuHost(1234, () => 'node /x/apps/operator/scripts/psu-pty-host.mjs')).toBe(true);
  });
  it('REJECTS an unrelated process that inherited a recycled pid', () => {
    expect(pidIsPsuHost(1234, () => 'node /x/some-unrelated-server.mjs')).toBe(false);
    expect(pidIsPsuHost(1234, () => '/usr/bin/bash -c sleep 999')).toBe(false);
  });
  it('REJECTS an empty cmdline (zombie/defunct) on every platform — not a verifiable live host', () => {
    expect(pidIsPsuHost(1234, () => '')).toBe(false);
  });
  it('fail-open semantics for an unreadable cmdline: rejects on Linux (/proc present), trusts off-Linux', () => {
    // null = readFileSync threw (pid vanished, or no /proc at all). On the ship target
    // (Linux, /proc present) that's a reject; a non-Linux dev box cannot verify → trust.
    expect(pidIsPsuHost(1234, () => null)).toBe(!existsSync('/proc'));
  });
  it('rejects a falsy pid', () => {
    expect(pidIsPsuHost(0, () => 'node psu-launcher.mjs')).toBe(false);
  });
});

describe('pruneDeadDiscoveryFiles (WI-2510 — standing janitor hygiene sweep)', () => {
  it('returns 0 and does not throw when the discovery dir does not exist yet', () => {
    expect(pruneDeadDiscoveryFiles(join(tmpdir(), `psu-pty-disc-absent-${process.pid}-${Math.floor(performance.now())}`))).toBe(0);
  });

  it('removes a dead host (pid gone) file + its (now-orphaned) socket path, leaves a live one alone', () => {
    const dir = tmpDir();
    const { sock: liveSock } = startSocket(dir, 'su-live-keep');
    writeMeta(dir, 'su-live-keep', { pid: process.pid, ptyPid: process.pid, sock: liveSock, command: 'x', startedAt: 1 });
    const deadSock = join(dir, `${sanitizeKey('su-dead-gc')}.sock`);
    writeFileSync(deadSock, ''); // a leftover socket FILE (not listening) — pruned alongside its meta
    writeMeta(dir, 'su-dead-gc', { pid: 2147483646, ptyPid: 2147483645, sock: deadSock, command: 'x', startedAt: 1 });

    const pruned = pruneDeadDiscoveryFiles(dir, ID_OK);

    expect(pruned).toBe(1);
    expect(existsSync(join(dir, `${sanitizeKey('su-dead-gc')}.json`))).toBe(false);
    expect(existsSync(deadSock)).toBe(false);
    expect(existsSync(join(dir, `${sanitizeKey('su-live-keep')}.json`))).toBe(true);
  });

  it('removes a corrupt/unreadable discovery file (can never resolve to a live host)', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, `${sanitizeKey('su-corrupt')}.json`), '{ not: valid json');
    expect(pruneDeadDiscoveryFiles(dir)).toBe(1);
    expect(existsSync(join(dir, `${sanitizeKey('su-corrupt')}.json`))).toBe(false);
  });

  it('WI-2339 parity: a pid-alive + socket-live file still gets pruned when identity verification fails (recycled pid)', () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-recycled');
    writeMeta(dir, 'su-recycled', { pid: process.pid, ptyPid: process.pid, sock, command: 'x', startedAt: 1 });
    expect(pruneDeadDiscoveryFiles(dir, { verifyIdentity: () => false })).toBe(1);
    expect(existsSync(join(dir, `${sanitizeKey('su-recycled')}.json`))).toBe(false);
  });

  it('never removes anything a live findLiveHost lookup would still return (consistency)', () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-consistent');
    writeMeta(dir, 'su-consistent', { pid: process.pid, ptyPid: process.pid, sock, command: 'x', startedAt: 1 });
    expect(pruneDeadDiscoveryFiles(dir, ID_OK)).toBe(0);
    expect(findLiveHost('su-consistent', dir, ID_OK)).not.toBeNull();
  });
});

describe('injectIntoHost', () => {
  it('writes a v1 turn envelope the host receives', async () => {
    const dir = tmpDir();
    const { sock, received } = startSocket(dir, 'su-inj');
    const ok = await injectIntoHost(sock, { mode: 'turn', data: 'wake-text' });
    expect(ok).toBe(true);
    expect(JSON.parse(await received)).toEqual({ v: 1, mode: 'turn', data: 'wake-text' });
  });

  it('writes a v1 raw envelope (force interrupt = Ctrl-C, immediate)', async () => {
    const dir = tmpDir();
    const { sock, received } = startSocket(dir, 'su-force');
    const ok = await injectIntoHost(sock, { mode: 'raw', data: '' });
    expect(ok).toBe(true);
    expect(JSON.parse(await received)).toEqual({ v: 1, mode: 'raw', data: '' });
  });

  it('writes a v1 osc envelope (recolor bytes for the terminal display)', async () => {
    const dir = tmpDir();
    const { sock, received } = startSocket(dir, 'su-osc');
    const osc = '\x1b]11;#581c87\x07';
    const ok = await injectIntoHost(sock, { mode: 'osc', data: osc });
    expect(ok).toBe(true);
    expect(JSON.parse(await received)).toEqual({ v: 1, mode: 'osc', data: osc });
  });

  it('resolves false when the socket does not exist', async () => {
    const ok = await injectIntoHost(join(tmpDir(), 'absent.sock'), { mode: 'turn', data: 'x' }, 500);
    expect(ok).toBe(false);
  });
});

describe('recolorViaPty (fleet-color-schemes live recolor)', () => {
  // recolorViaPty reads the REAL PSU_PTY_DIR (no dir param), so set up a live host
  // there under a unique throwaway ownerId, then clean it up — mirrors interruptViaPty.
  it('injects an osc envelope into a live host; false when no host or empty osc', async () => {
    mkdirSync(PSU_PTY_DIR, { recursive: true, mode: 0o700 });
    const ownerId = `su-recolor-test-${process.pid}-${Math.floor(performance.now())}`;
    const sock = join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.sock`);
    const meta = join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.json`);
    const recv: string[] = [];
    const server = net.createServer((conn) => {
      const chunks: Buffer[] = [];
      conn.on('data', (d) => chunks.push(d));
      conn.on('end', () => recv.push(Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((r) => server.listen(sock, r));
    writeFileSync(
      meta,
      JSON.stringify({ ownerId, advSessionId: null, pid: process.pid, ptyPid: process.pid, sock, command: 'claude-su', startedAt: 1 }),
    );
    cleanups.push(() => {
      server.close();
      for (const p of [sock, meta]) if (existsSync(p)) unlinkSync(p);
    });

    const osc = '\x1b]10;#f5e8ff\x07\x1b]11;#581c87\x07\x1b]12;#d8b4fe\x07';
    // no live host → false (recolor doesn't land; the bound scheme applies next window)
    expect(await recolorViaPty('su-no-such-owner-recolor', osc, ID_OK)).toBe(false);
    // empty osc → false (nothing to write) even with a live host
    expect(await recolorViaPty(ownerId, '', ID_OK)).toBe(false);
    // live host → injects the osc envelope (ID_OK: process.pid stands in for a real host)
    expect(await recolorViaPty(ownerId, osc, ID_OK)).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    expect(recv.length).toBe(1);
    expect(JSON.parse(recv[0])).toEqual({ v: 1, mode: 'osc', data: osc });
  });
});

describe('interruptViaPty (Phase 4 pty-force leg)', () => {
  // interruptViaPty reads the REAL PSU_PTY_DIR (no dir param), so set up a live
  // host there under a unique throwaway ownerId, then clean it up.
  it('injects a raw Ctrl-C / Esc into a live host; false when no host', async () => {
    mkdirSync(PSU_PTY_DIR, { recursive: true, mode: 0o700 });
    const ownerId = `su-force-test-${process.pid}-${Math.floor(performance.now())}`;
    const sock = join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.sock`);
    const meta = join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.json`);
    const recv: string[] = [];
    const server = net.createServer((conn) => {
      const chunks: Buffer[] = [];
      conn.on('data', (d) => chunks.push(d));
      conn.on('end', () => recv.push(Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((r) => server.listen(sock, r));
    writeFileSync(
      meta,
      JSON.stringify({ ownerId, advSessionId: null, pid: process.pid, ptyPid: process.pid, sock, command: 'claude-su', startedAt: 1 }),
    );
    cleanups.push(() => {
      server.close();
      for (const p of [sock, meta]) if (existsSync(p)) unlinkSync(p);
    });

    // no live host → false (caller falls back to headless SIGINT)
    expect(await interruptViaPty('su-no-such-owner-xyz')).toBe(false);

    // sigint default = Ctrl-C, raw + immediate (ID_OK: process.pid stands in for a real host)
    expect(await interruptViaPty(ownerId, 'sigint', ID_OK)).toBe(true);
    // esc variant
    expect(await interruptViaPty(ownerId, 'esc', ID_OK)).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    expect(recv.length).toBe(2);
    expect(JSON.parse(recv[0])).toEqual({ v: 1, mode: 'raw', data: '\x03' });
    expect(JSON.parse(recv[1])).toEqual({ v: 1, mode: 'raw', data: '\x1b' });
  });
});

describe('injectIntoHost — compact envelope (WI-1804 auto-continuation)', () => {
  it('writes a v1 compact envelope carrying focus as a distinct field', async () => {
    const dir = tmpDir();
    const { sock, received } = startSocket(dir, 'su-compact');
    const ok = await injectIntoHost(sock, {
      mode: 'compact',
      data: 'Continue where you left off — resume WI-1804.',
      focus: 'keep the identity block + WI-1804 open items',
    });
    expect(ok).toBe(true);
    // `data` = the carry-note continuation; `focus` = the /compact argument. Kept separate.
    expect(JSON.parse(await received)).toEqual({
      v: 1,
      mode: 'compact',
      data: 'Continue where you left off — resume WI-1804.',
      focus: 'keep the identity block + WI-1804 open items',
    });
  });

  it('omits `focus` from the envelope for non-compact modes (unchanged wire for turn)', async () => {
    const dir = tmpDir();
    const { sock, received } = startSocket(dir, 'su-nofocus');
    const ok = await injectIntoHost(sock, { mode: 'turn', data: '/compact keep it' });
    expect(ok).toBe(true);
    const env = JSON.parse(await received);
    expect(env).toEqual({ v: 1, mode: 'turn', data: '/compact keep it' });
    expect(env).not.toHaveProperty('focus');
  });
});

describe('hostSupports (WI-1804 rollout gate)', () => {
  const hostWith = (caps: string[] | null | undefined): PsuPtyHost =>
    ({
      ownerId: 'su-x',
      advSessionId: null,
      pid: 1,
      ptyPid: 1,
      sock: '/x.sock',
      command: 'claude-su',
      startedAt: 1,
      caps,
    }) as PsuPtyHost;

  it('is false for a null / undefined host (no live host → fall back)', () => {
    expect(hostSupports(null, 'compact')).toBe(false);
    expect(hostSupports(undefined, 'compact')).toBe(false);
  });

  it('is false for an OLD host with no caps field (the rollout-safe fallback path)', () => {
    expect(hostSupports(hostWith(undefined), 'compact')).toBe(false);
    expect(hostSupports(hostWith(null), 'compact')).toBe(false);
  });

  it('is false when caps is present but does not include the capability', () => {
    expect(hostSupports(hostWith([]), 'compact')).toBe(false);
    expect(hostSupports(hostWith(['osc']), 'compact')).toBe(false);
  });

  it('is true only when caps advertises the capability', () => {
    expect(hostSupports(hostWith(['compact']), 'compact')).toBe(true);
    expect(hostSupports(hostWith(['osc', 'compact']), 'compact')).toBe(true);
  });
});
