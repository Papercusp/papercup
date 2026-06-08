/**
 * psu-pty-discovery.test.ts — the operator's read side of the psu-hosted
 * managed-pty control socket (turn-lifecycle-control Phase 3, P-014).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { findLiveHost, injectIntoHost, sanitizeKey } from './psu-pty-discovery';

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

  it('returns the host when pid is alive AND the socket exists', () => {
    const dir = tmpDir();
    const { sock } = startSocket(dir, 'su-live');
    writeMeta(dir, 'su-live', { pid: process.pid, ptyPid: process.pid, sock, command: 'claude-su', startedAt: 1 });
    const h = findLiveHost('su-live', dir);
    expect(h).not.toBeNull();
    expect(h!.sock).toBe(sock);
    expect(h!.ownerId).toBe('su-live');
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

  it('resolves false when the socket does not exist', async () => {
    const ok = await injectIntoHost(join(tmpDir(), 'absent.sock'), { mode: 'turn', data: 'x' }, 500);
    expect(ok).toBe(false);
  });
});
