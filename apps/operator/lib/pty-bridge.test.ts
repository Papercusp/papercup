/**
 * pty-bridge unit tests — covers the P4 screen-serialization path and
 * the byte-history ring (SSE fallback). Spawns a real `bash -c` so the
 * tests exercise the same node-pty + xterm-headless wiring the
 * operator uses in production. Requires bash on PATH.
 */
import { describe, it, expect, afterAll } from 'vitest';
import {
  spawnPty,
  killPty,
  getHistory,
  getScreenSerialization,
  resizePty,
  writePty,
} from './pty-bridge';

const liveIds: string[] = [];

afterAll(() => {
  for (const id of liveIds) try { killPty(id); } catch { /* */ }
});

async function waitForOutput(id: string, predicate: (s: string) => boolean, timeoutMs = 2000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = (getHistory(id)?.toString('utf8') ?? '');
    if (predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 30));
  }
  return getHistory(id)?.toString('utf8') ?? '';
}

describe('pty-bridge', () => {
  it('spawns a process and accumulates byte history', async () => {
    const handle = spawnPty({
      command: 'bash',
      args: ['-c', 'echo PTY_BRIDGE_TEST_MARKER && sleep 0.1'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    liveIds.push(handle.id);
    const out = await waitForOutput(handle.id, (s) => s.includes('PTY_BRIDGE_TEST_MARKER'));
    expect(out).toContain('PTY_BRIDGE_TEST_MARKER');
  });

  it('serializes screen state via xterm-headless (P4)', async () => {
    const handle = spawnPty({
      command: 'bash',
      args: ['-c', 'printf "LINE_ALPHA\\nLINE_BETA\\n"; sleep 0.1'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    liveIds.push(handle.id);
    await waitForOutput(handle.id, (s) => s.includes('LINE_BETA'));
    const replay = await getScreenSerialization(handle.id);
    expect(replay).toBeTruthy();
    expect(replay!).toContain('LINE_ALPHA');
    expect(replay!).toContain('LINE_BETA');
    // Bounded — should be way smaller than the byte history.
    const history = getHistory(handle.id)!;
    expect(replay!.length).toBeLessThanOrEqual(80 * 24 * 8 + 4096);
    expect(history.length).toBeGreaterThan(0);
  });

  it('keeps screen serialization geometry-correct after resize', async () => {
    const handle = spawnPty({
      command: 'bash',
      args: ['-c', 'echo PRE_RESIZE; sleep 0.5; echo POST_RESIZE; sleep 0.1'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    liveIds.push(handle.id);
    await waitForOutput(handle.id, (s) => s.includes('PRE_RESIZE'));
    expect(resizePty(handle.id, 100, 30)).toBe(true);
    await waitForOutput(handle.id, (s) => s.includes('POST_RESIZE'));
    const replay = await getScreenSerialization(handle.id);
    expect(replay).toBeTruthy();
    expect(replay!).toContain('PRE_RESIZE');
    expect(replay!).toContain('POST_RESIZE');
  });

  it('forwards keystrokes via writePty', async () => {
    const handle = spawnPty({
      command: 'bash',
      args: ['-c', 'read x; echo GOT_$x; sleep 0.05'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    liveIds.push(handle.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(writePty(handle.id, Buffer.from('TYPED\n'))).toBe(true);
    const out = await waitForOutput(handle.id, (s) => s.includes('GOT_TYPED'));
    expect(out).toContain('GOT_TYPED');
  });
});
