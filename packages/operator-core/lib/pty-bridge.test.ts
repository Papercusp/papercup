/**
 * pty-bridge unit tests — covers the P4 screen-serialization path and
 * the byte-history ring (SSE fallback). Spawns a real `bash -c` so the
 * tests exercise the same node-pty + xterm-headless wiring the
 * operator uses in production. Requires bash on PATH.
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  spawnPty,
  killPty,
  getHistory,
  getPty,
  getPtyMeta,
  getScreenSerialization,
  resizePty,
  writePty,
  findPtyByPid,
  deriveMaxConcurrentPtys,
} from './pty-bridge';
import { getResourceProfile } from './resource-profile';
import type { PtyAccessScope } from './pty-ticket';

const require = createRequire(import.meta.url);

/** Read a package's shipped ESM ("module" field) build directly off disk —
 *  the exact file Rolldown/Vite bundles for the production build, bypassing
 *  Node's own CJS→ESM interop (which resolves "main" instead and SYNTHESIZES
 *  a `.default` no matter what the package ships, masking the real shape). */
function readEsmBuild(pkgJsonSpecifier: string, moduleRelPath: string): string {
  const pkgJsonPath = require.resolve(pkgJsonSpecifier);
  const dir = pkgJsonPath.slice(0, pkgJsonPath.length - 'package.json'.length);
  return readFileSync(dir + moduleRelPath, 'utf8');
}

const liveIds: string[] = [];
const TEST_SCOPE: PtyAccessScope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  harnessSlug: 'harness-a',
  hostId: 'host-a',
  principalId: 'user-a',
};

/** Reap each test's pty as soon as that test ends. */
function reap(): void {
  for (const id of liveIds.splice(0)) {
    try {
      killPty(id, TEST_SCOPE);
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
    const s = (getHistory(id, TEST_SCOPE)?.toString('utf8') ?? '');
    if (predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 30));
  }
  return getHistory(id, TEST_SCOPE)?.toString('utf8') ?? '';
}

describe('xterm ESM export shape (EI-13212)', () => {
  // Regression for the Rolldown IMPORT_IS_UNDEFINED production-build warning:
  // getHeadlessTerminal/getSerializeAddon used to fall back to
  // `(ns as any).default?.X`. Node's own CJS-interop (via "main") always
  // synthesizes SOME `.default`, so a runtime check from inside this vitest
  // process can never see the real problem — the bug only exists in the
  // ESM ("module" field) build Rolldown/Vite actually bundles. So this reads
  // that shipped file directly: it must export the named binding the getters
  // rely on, and it must NOT export a default. If a future dependency bump
  // ever changes that, this fails LOUDLY here instead of the fallback dead
  // code (or an actually-broken one) silently creeping back into
  // pty-bridge.ts.
  it('@xterm/headless ESM build exports Terminal by name, with no default', () => {
    const src = readEsmBuild('@xterm/headless/package.json', 'lib-headless/xterm-headless.mjs');
    expect(src).toMatch(/\bas Terminal\b/);
    expect(src).not.toMatch(/\bexport\s+default\b|\bas default\b/);
  });

  it('@xterm/addon-serialize ESM build exports SerializeAddon by name, with no default', () => {
    const src = readEsmBuild('@xterm/addon-serialize/package.json', 'lib/addon-serialize.mjs');
    expect(src).toMatch(/\bas SerializeAddon\b/);
    expect(src).not.toMatch(/\bexport\s+default\b|\bas default\b/);
  });
});

describe('pty-bridge', () => {
  it('spawns a process and accumulates byte history', async () => {
    const handle = spawnPty({
      accessScope: TEST_SCOPE,
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
      accessScope: TEST_SCOPE,
      command: 'bash',
      args: ['-c', 'printf "LINE_ALPHA\\nLINE_BETA\\n"; sleep 0.1'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    liveIds.push(handle.id);
    await waitForOutput(handle.id, (s) => s.includes('LINE_BETA'));
    const replay = await getScreenSerialization(handle.id, TEST_SCOPE);
    expect(replay).toBeTruthy();
    expect(replay!).toContain('LINE_ALPHA');
    expect(replay!).toContain('LINE_BETA');
    // Bounded — should be way smaller than the byte history.
    const history = getHistory(handle.id, TEST_SCOPE)!;
    expect(replay!.length).toBeLessThanOrEqual(80 * 24 * 8 + 4096);
    expect(history.length).toBeGreaterThan(0);
  });

  it('keeps screen serialization geometry-correct after resize', async () => {
    const handle = spawnPty({
      accessScope: TEST_SCOPE,
      command: 'bash',
      args: ['-c', 'echo PRE_RESIZE; sleep 0.5; echo POST_RESIZE; sleep 0.1'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    liveIds.push(handle.id);
    await waitForOutput(handle.id, (s) => s.includes('PRE_RESIZE'));
    expect(resizePty(handle.id, 100, 30, TEST_SCOPE)).toBe(true);
    await waitForOutput(handle.id, (s) => s.includes('POST_RESIZE'));
    const replay = await getScreenSerialization(handle.id, TEST_SCOPE);
    expect(replay).toBeTruthy();
    expect(replay!).toContain('PRE_RESIZE');
    expect(replay!).toContain('POST_RESIZE');
  });

  it('forwards keystrokes via writePty', async () => {
    const handle = spawnPty({
      accessScope: TEST_SCOPE,
      command: 'bash',
      args: ['-c', 'read x; echo GOT_$x; sleep 0.05'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    liveIds.push(handle.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(writePty(handle.id, Buffer.from('TYPED\n'), TEST_SCOPE)).toBe(true);
    const out = await waitForOutput(handle.id, (s) => s.includes('GOT_TYPED'));
    expect(out).toContain('GOT_TYPED');
  });

  it('partitions handle lookup and mutations by the complete access scope', () => {
    const handle = spawnPty({
      accessScope: TEST_SCOPE,
      command: 'bash',
      args: ['-c', 'sleep 1'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    liveIds.push(handle.id);
    const foreignScope = { ...TEST_SCOPE, principalId: 'user-b' };

    expect(handle.accessScope).toEqual(TEST_SCOPE);
    expect(handle.accessScope).not.toBe(TEST_SCOPE);
    expect(getPty(handle.id, TEST_SCOPE)?.id).toBe(handle.id);
    expect(getPty(handle.id, foreignScope)).toBeUndefined();
    expect(getPtyMeta(handle.id, foreignScope)).toBeNull();
    expect(writePty(handle.id, Buffer.from('blocked\n'), foreignScope)).toBe(false);
    expect(resizePty(handle.id, 100, 30, foreignScope)).toBe(false);
    expect(killPty(handle.id, foreignScope)).toBe(false);
    expect(getPty(handle.id, TEST_SCOPE)?.killed).toBe(false);
  });

  // EI-151: a recorded pid can be recycled by the OS to a DIFFERENT agent's
  // live managed pty. findPtyByPid must never hand back a pty tagged with a
  // foreign owner, or the wake executor would inject one agent's wake turn into
  // another's session. Owner is captured from PAPERCUSP_SID at spawn.
  describe('findPtyByPid owner-scoping (cross-agent misroute guard)', () => {
    it('stamps ownerSid from the spawn env and never matches a foreign owner', async () => {
      const handle = spawnPty({
        accessScope: TEST_SCOPE,
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
        accessScope: TEST_SCOPE,
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
