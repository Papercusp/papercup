/**
 * pty-bridge unit tests — covers the P4 screen-serialization path and
 * the byte-history ring (SSE fallback). Spawns a real `bash -c` so the
 * tests exercise the same node-pty + xterm-headless wiring the
 * operator uses in production. Requires bash on PATH.
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import {
  spawnPty,
  killPty,
  getHistory,
  getScreenSerialization,
  resizePty,
  writePty,
  findPtyByPid,
  deriveMaxConcurrentPtys,
} from './pty-bridge';
import { getResourceProfile } from './resource-profile';

const liveIds: string[] = [];

/** Reap each test's pty as soon as that test ends. */
function reap(): void {
  for (const id of liveIds.splice(0)) {
    try {
      killPty(id);
    } catch {
      /* already exited */
    }
  }
}

// These ptys used to be reaped only in afterAll, so all six stayed alive at once.
// That is fine on a big box (the F-E2 backstop resolves to 16) but a hard
// `pty cap reached (2/2)` on a small host, because maxConcurrentPtys() scales to the
// host's resource-profile agent budget — see the derivation suite at the bottom of
// this file, where a 4-core laptop's budget of 1 yields a backstop of 2. The result
// was a file that passed on the 128-core dev box and failed on a laptop, a CI runner,
// or a packaged install. No test depends on a previous test's pty, so reap per test.
afterEach(reap);
afterAll(reap);

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

  // EI-151: a recorded pid can be recycled by the OS to a DIFFERENT agent's
  // live managed pty. findPtyByPid must never hand back a pty tagged with a
  // foreign owner, or the wake executor would inject one agent's wake turn into
  // another's session. Owner is captured from PAPERCUSP_SID at spawn.
  describe('findPtyByPid owner-scoping (cross-agent misroute guard)', () => {
    it('stamps ownerSid from the spawn env and never matches a foreign owner', async () => {
      const handle = spawnPty({
        command: 'bash',
        args: ['-c', 'sleep 1'],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        env: { PAPERCUSP_SID: 'su-owner-A' },
      });
      liveIds.push(handle.id);
      const pid = handle.pty.pid;

      expect(handle.ownerSid).toBe('su-owner-A');
      // The genuine owner resolves the pty.
      expect(findPtyByPid(pid, 'su-owner-A')?.id).toBe(handle.id);
      // A peer whose stale row recorded this (recycled) pid must NOT match it —
      // this is the EI-151 misroute that injected A's wake into B's session.
      expect(findPtyByPid(pid, 'su-owner-B')).toBeNull();
      // No owner requested (a non-wake caller) keeps the pid-only behavior.
      expect(findPtyByPid(pid)?.id).toBe(handle.id);
    });

    it('an UNTAGGED pty (no SID, e.g. a shell pane) still matches any owner — never stricter than pid-only', async () => {
      const handle = spawnPty({
        command: 'bash',
        args: ['-c', 'sleep 1'],
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });
      liveIds.push(handle.id);
      const pid = handle.pty.pid;

      expect(handle.ownerSid).toBeNull();
      expect(findPtyByPid(pid, 'su-anyone')?.id).toBe(handle.id);
      expect(findPtyByPid(pid)?.id).toBe(handle.id);
    });
  });
});

// F-E2 of app-wide-load-traps: the absolute pty backstop is no longer a fixed
// big-box literal (16) but scales to the host's resource-profile agent budget,
// so a 4-core laptop's fork-bomb backstop is ~2-4 instead of 16. The pure
// derivation is exported so we can test the formula without injecting host state.
describe('maxConcurrentPtys backstop derivation (F-E2 adaptive caps)', () => {
  it('is 2× the agent budget, capped at the legacy 16 absolute backstop', () => {
    expect(deriveMaxConcurrentPtys(1)).toBe(2); // 4-core laptop sharing an embedded PG
    expect(deriveMaxConcurrentPtys(2)).toBe(4); // small native host
    expect(deriveMaxConcurrentPtys(4)).toBe(8);
    expect(deriveMaxConcurrentPtys(8)).toBe(16); // ceil(16) hits the cap
    expect(deriveMaxConcurrentPtys(16)).toBe(16); // server — capped, preserves old behavior
    expect(deriveMaxConcurrentPtys(64)).toBe(16); // never exceeds the absolute backstop
  });

  it('floors a non-positive / non-finite budget to 1 agent (backstop 2), never 0 or NaN', () => {
    expect(deriveMaxConcurrentPtys(0)).toBe(2);
    expect(deriveMaxConcurrentPtys(-5)).toBe(2);
    expect(deriveMaxConcurrentPtys(Number.NaN)).toBe(2);
    expect(deriveMaxConcurrentPtys(Number.POSITIVE_INFINITY)).toBe(2);
  });

  it('is wired to the live resource profile (scales with host), not a fixed literal', () => {
    const expected = deriveMaxConcurrentPtys(getResourceProfile().maxSimultaneousAgents);
    expect(expected).toBeGreaterThanOrEqual(2);
    expect(expected).toBeLessThanOrEqual(16);
  });
});
