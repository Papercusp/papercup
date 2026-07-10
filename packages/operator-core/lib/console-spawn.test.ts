/**
 * Coverage for console-spawn.buildConsoleOneliner — the one-liner that the
 * spawned terminal runs as its first command. This is the mechanism behind
 * capability:terminal: the `greeting` is the caller's arbitrary command, and it
 * must (a) run in a subshell, (b) survive shell-quoting verbatim, then (c) hand
 * off to an interactive login shell so the window stays open.
 */
import { EventEmitter } from 'node:events';
// NOTE: 'node:child_process' is vi.mock'd below with the original module
// spread — only `spawn` is stubbed, so this execFileSync is the real one
// (used to prove one-liners parse/execute under actual bash).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  buildConsoleOneliner,
  advSessionTitleTag,
  macConsoleInvocation,
  spawnConsole,
  spawnHeadless,
  headlessLogPath,
  type AppearanceOpts,
  type DesktopEnvProbes,
} from './console-spawn';
import type { ConsoleEnvelope } from './console-launcher';
import { isWindowsDesktopHost } from './windows-desktop-windows';
import { requestDesktopConsoleLaunch } from './console-launch-bridge';

// WI-1882: make the WSL2/Windows-desktop signal deterministic on the Linux CI
// host (where process.platform is already 'linux'). console-spawn consumes only
// isWindowsDesktopHost from this module.
vi.mock('./windows-desktop-windows', () => ({ isWindowsDesktopHost: vi.fn(() => false) }));

// WI-3289: stub the desktop bridge so no sync-bus emit / PG connection happens.
vi.mock('./console-launch-bridge', () => ({ requestDesktopConsoleLaunch: vi.fn() }));

// WI-1886: mock the OS spawn so these tests NEVER open a real desktop window
// (the dev box HAS gnome-terminal + an X socket — an unmocked Linux-path call
// would now actually open one, since spawnConsole injects the desktop env).
const spawnMock = vi.fn();
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  spawn: (...a: unknown[]) => spawnMock(...a),
}));

/** A fake detached terminal child: emit 'exit' to simulate an early death. */
function fakeChild(pid = 4242) {
  const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
  child.pid = pid;
  child.unref = () => {};
  return child;
}

const APPEARANCE: AppearanceOpts = { mode: 'console', planSlug: null, label: null };

// WI-3114: HERMETIC desktop-env probes. The stubbed DISPLAY=:99 alone is NOT
// deterministic — resolveLinuxDesktopEnv validates the display's X socket
// against the REAL /tmp/.X11-unix (WI-2840 stale-DISPLAY healing), so these
// tests passed or failed with the box's live X state (the 2026-07-05 /tmp wipe
// removed X99 → the healing console.warn → vitest-fail-on-console red-pinned
// the green gate). Every spawnConsole call that reaches the Linux desktop path
// must inject these so no real socket/cookie is ever consulted.
const FAKE_DESKTOP_PROBES: DesktopEnvProbes = {
  existsSync: () => true, // every socket/cookie the resolver checks "exists"
  readdirSync: () => ['X99'],
  uid: 1000,
  home: '/home/test',
};

describe('spawnConsole Windows-desktop (WSL2) defer — WI-1882', () => {
  const envelope: ConsoleEnvelope = {
    cwd: '/tmp',
    env: {},
    mcpJsonContents: '',
    greetingCmd: 'true',
    needsSuperuserBootstrap: false,
    sessionId: 'test-sid',
  };
  beforeEach(() => {
    vi.mocked(isWindowsDesktopHost).mockReset();
    vi.mocked(requestDesktopConsoleLaunch).mockReset();
    spawnMock.mockReset();
    // Deterministic desktop env: the resolver short-circuits when DISPLAY is set.
    vi.stubEnv('DISPLAY', ':99');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns code:501 (defer to the Tauri console_launch) on a Windows desktop host, even though process.platform is "linux" inside WSL', async () => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(true);
    const r = await spawnConsole({ envelope });
    expect(r.status).toBe('error');
    expect((r as { code: number }).code).toBe(501);
    expect(spawnMock).not.toHaveBeenCalled();
    // Without allowDesktopBridge the bridge must NOT be consulted — the 501 is
    // the renderer-fallback contract for the user "+" path (native-console.ts).
    expect(vi.mocked(requestDesktopConsoleLaunch)).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit to 501 on a real Linux desktop (isWindowsDesktopHost false)', async () => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(false);
    // A child that dies instantly → the WI-1886 probe reports 502, not 501.
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    });
    const r = await spawnConsole({ envelope, desktopEnvProbes: FAKE_DESKTOP_PROBES });
    if (r.status === 'error') expect(r.code).not.toBe(501);
  });
});

// WI-3289: the agent-tool callers (capability:terminal, fleet:launch-on-plan)
// opt into the desktop bridge — a Windows host relays the envelope to the
// desktop shell's Tauri console_launch instead of hard-501ing the agent.
describe('spawnConsole Windows desktop-bridge — WI-3289', () => {
  const envelope: ConsoleEnvelope = {
    cwd: '/tmp',
    env: {},
    mcpJsonContents: '',
    greetingCmd: 'psu --no-picker',
    needsSuperuserBootstrap: false,
    sessionId: 'test-sid',
  };
  beforeEach(() => {
    vi.mocked(isWindowsDesktopHost).mockReset();
    vi.mocked(requestDesktopConsoleLaunch).mockReset();
    spawnMock.mockReset();
    vi.stubEnv('DISPLAY', ':99');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('allowDesktopBridge on a Windows desktop host relays via the bridge and returns ok (child:null)', async () => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(true);
    vi.mocked(requestDesktopConsoleLaunch).mockResolvedValue({ ok: true, pid: 777, error: null });
    const r = await spawnConsole({
      envelope,
      allowDesktopBridge: true,
      label: 'lbl',
      planSlug: 'p1',
    });
    expect(vi.mocked(requestDesktopConsoleLaunch)).toHaveBeenCalledWith(
      expect.objectContaining({ envelope, label: 'lbl', planSlug: 'p1' }),
    );
    expect(r.status).toBe('ok');
    const ok = r as Extract<typeof r, { status: 'ok' }>;
    expect(ok.terminal).toContain('desktop-bridge');
    expect(ok.pid).toBe(777);
    expect(ok.child).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled(); // never a Session-0 WSL spawn
  });

  it('surfaces a LOUD bridge failure (desktop shell closed / timeout) instead of ok-with-no-window', async () => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(true);
    vi.mocked(requestDesktopConsoleLaunch).mockResolvedValue({
      ok: false,
      pid: null,
      error: 'no desktop shell answered the console-launch request within 30000ms',
    });
    const r = await spawnConsole({ envelope, allowDesktopBridge: true });
    expect(r.status).toBe('error');
    const err = r as { code: number; error: string };
    expect(err.code).toBe(502);
    expect(err.error).toMatch(/desktop-bridge launch failed/);
    expect(err.error).toMatch(/no desktop shell answered/);
  });

  it('allowDesktopBridge is a no-op on a real Linux desktop — the server-side spawn stays in charge', async () => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(false);
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    });
    const r = await spawnConsole({
      envelope,
      allowDesktopBridge: true,
      desktopEnvProbes: FAKE_DESKTOP_PROBES,
    });
    expect(vi.mocked(requestDesktopConsoleLaunch)).not.toHaveBeenCalled();
    if (r.status === 'error') expect(r.code).not.toBe(501);
  });
});

describe('spawnConsole early-exit probe — WI-1886(b)', () => {
  const envelope: ConsoleEnvelope = {
    cwd: '/tmp',
    env: {},
    mcpJsonContents: '',
    greetingCmd: 'true',
    needsSuperuserBootstrap: false,
    sessionId: 'test-sid',
  };
  beforeEach(() => {
    vi.mocked(isWindowsDesktopHost).mockReturnValue(false);
    spawnMock.mockReset();
    vi.stubEnv('DISPLAY', ':99');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('a terminal client that dies nonzero inside the probe ⇒ LOUD error (no more ok+pid ghost windows)', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild(1111);
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    });
    const r = await spawnConsole({ envelope, desktopEnvProbes: FAKE_DESKTOP_PROBES });
    expect(r.status).toBe('error');
    const err = r as { code: number; error: string };
    expect(err.code).toBe(502);
    expect(err.error).toMatch(/no window opened/i);
    expect(err.error).toMatch(/WI-1886/);
  });

  it('a client killed by a signal inside the probe ⇒ LOUD error', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild(2222);
      queueMicrotask(() => child.emit('exit', null, 'SIGSEGV'));
      return child;
    });
    const r = await spawnConsole({ envelope, desktopEnvProbes: FAKE_DESKTOP_PROBES });
    expect(r.status).toBe('error');
    expect((r as { error: string }).error).toContain('SIGSEGV');
  });

  it('a client that outlives the probe ⇒ ok with its pid', async () => {
    spawnMock.mockImplementation(() => fakeChild(3333)); // never exits
    const r = await spawnConsole({ envelope, desktopEnvProbes: FAKE_DESKTOP_PROBES });
    expect(r.status).toBe('ok');
    expect((r as { pid: number | null }).pid).toBe(3333);
  }, 10_000);
});

describe('headlessLogPath — per-session log filename (headless-fleet-launch P-002)', () => {
  it('slugifies the label + stamps pid/time under the given dir', () => {
    const p = headlessLogPath({ logDir: '/var/log/fleet', label: 'my-fleet · member 1/3 (plan)', pid: 42, nowMs: 1000 });
    expect(p.startsWith('/var/log/fleet/')).toBe(true);
    const base = p.slice('/var/log/fleet/'.length);
    // no whitespace or shell-meta survives into the filename
    expect(base).not.toMatch(/[\s·()]/);
    expect(base).toBe('my-fleet-member-1-3-plan-42-1000.log');
  });
  it('falls back to tmpdir when no dir given, and never yields an empty base name', () => {
    const p = headlessLogPath({ logDir: null, label: '···', pid: 1, nowMs: 2 });
    expect(p).toMatch(/headless-1-2\.log$/);
  });
});

describe('spawnHeadless — no-window managed-pty launch (headless-fleet-launch P-002)', () => {
  const envelope: ConsoleEnvelope = {
    cwd: '/tmp',
    env: {},
    mcpJsonContents: '',
    greetingCmd: 'psu --headless',
    needsSuperuserBootstrap: false,
    sessionId: 'test-sid',
  };
  beforeEach(() => spawnMock.mockReset());

  it('runs bash -lc (no terminal emulator) detached with a log fd, and reports ok+pid when the session outlives the probe', async () => {
    spawnMock.mockImplementation(() => fakeChild(7777)); // never exits = a live agent
    const r = await spawnHeadless({ envelope, label: 'hl', logDir: null });
    expect(r.status).toBe('ok');
    expect((r as { pid: number | null }).pid).toBe(7777);
    // the spawned program is bash -lc <oneliner>, NOT a terminal emulator
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('bash');
    expect(args[0]).toBe('-lc');
    expect(args[1]).toContain('psu --headless');
  }, 10_000);

  it('a psu that dies at boot inside the probe ⇒ LOUD error (not a false ok+pid)', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild(8888);
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    });
    const r = await spawnHeadless({ envelope, label: 'hl', logDir: null });
    expect(r.status).toBe('error');
    expect((r as { code: number }).code).toBe(502);
    expect((r as { error: string }).error).toMatch(/died at boot/i);
  });
});

describe('buildConsoleOneliner', () => {
  it('cds, evals the greeting in a subshell, then execs an interactive login shell', () => {
    const out = buildConsoleOneliner('/proj', {}, 'npm run dev', APPEARANCE);
    expect(out).toContain("cd '/proj'");
    expect(out).toContain("(eval 'npm run dev'); __papercusp_greeting_rc=$?");
    expect(out).toContain('exec "${SHELL:-/bin/bash}" -l');
  });

  it('always drops to the shell after the greeting and prints a failure banner for non-zero greetings', () => {
    const out = buildConsoleOneliner('/x', {}, 'false', APPEARANCE);
    // The post-greeting separator must be ';' so exit-non-zero
    // does not short-circuit the interactive shell (matches native_console.rs).
    expect(out).toContain('); __papercusp_greeting_rc=$?');
    expect(out).toContain('initial terminal command exited with status %s');
    expect(out).toContain('; exec "${SHELL:-/bin/bash}" -l');
    expect(out).not.toContain(') && exec');
  });

  it('drops the sentinel + EXIT trap so the desktop side can detect shell exit', () => {
    const out = buildConsoleOneliner('/x', {}, 'true', APPEARANCE);
    expect(out).toContain('touch .papercup-console-active.$$');
    expect(out).toContain("trap 'rm -f .papercup-console-active.$$' EXIT");
  });

  it('carries a command containing quotes as an escaped eval literal (no breakout, no mangle)', () => {
    const out = buildConsoleOneliner('/x', {}, "echo 'hi there'", APPEARANCE);
    // The greeting is shellEscape'd as ONE literal the subshell evals — the
    // pre-fix bare `'` → `'\''` replace (an escape for a single-quoted context
    // the greeting was never inside) made any quoted greeting unparseable
    // (macOS Terminal: `unexpected EOF while looking for matching "'"`).
    expect(out).toContain("(eval 'echo '\\''hi there'\\''')");
  });

  it('a quote-bearing greeting yields a one-liner bash can actually parse (bash -n)', () => {
    // The exact failure class from the 2026-07-07 mac fleet launch: a greeting
    // with legitimate shq()-style quoting killed the whole window at parse time.
    const greeting = "psu --context='it'\\''s a fleet' --plan=p1 | tee log && echo done";
    const out = buildConsoleOneliner('/proj', { A: "va'l" }, greeting, {
      mode: 'console',
      planSlug: 'plan-x',
      label: "owner's run",
      scheme: null,
    });
    expect(() => execFileSync('bash', ['-n', '-c', out])).not.toThrow();
  });

  it('executes a quoted greeting verbatim end-to-end (subshell eval round-trip)', () => {
    // Full execution proof: run the one-liner with SHELL=/bin/true so the
    // trailing `exec "${SHELL:-/bin/bash}" -l` terminates instead of going
    // interactive; the greeting must have written its apostrophe payload.
    const dir = mkdtempSync(join(tmpdir(), 'papercup-oneliner-'));
    try {
      const payload = "it's a fleet's directive";
      const greeting = `printf %s '${payload.replace(/'/g, "'\\''")}' > out.txt`;
      const out = buildConsoleOneliner(dir, { SHELL: '/bin/true' }, greeting, APPEARANCE);
      execFileSync('bash', ['-c', out], { stdio: 'ignore' });
      expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a MALFORMED greeting (unbalanced quote) errors inside the subshell without killing the one-liner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercup-oneliner-'));
    try {
      const out = buildConsoleOneliner(dir, { SHELL: '/bin/true' }, "echo 'oops", APPEARANCE);
      // Parses fine (the broken greeting is data, not syntax) …
      expect(() => execFileSync('bash', ['-n', '-c', out])).not.toThrow();
      // … and still reaches the trailing exec (exit 0 via /bin/true) — the
      // window would stay open showing eval's error instead of dying at parse.
      expect(() => execFileSync('bash', ['-c', out], { stdio: 'ignore' })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves pipes / redirects / && in the arbitrary command', () => {
    const cmd = 'grep -r foo . | tee out.log && echo done';
    const out = buildConsoleOneliner('/x', {}, cmd, APPEARANCE);
    expect(out).toContain(`(eval '${cmd}')`);
  });

  it('exports env vars with valid bash names and skips invalid ones', () => {
    const out = buildConsoleOneliner('/x', { GOOD_NAME: 'v', '1BAD': 'nope', 'BAD-DASH': 'nope' }, 'true', APPEARANCE);
    expect(out).toContain("export GOOD_NAME='v'");
    expect(out).not.toContain('1BAD');
    expect(out).not.toContain('BAD-DASH');
  });

  it('prepends PAPERCUSP_BIN_DIR ahead of PAPERCUSP_SCRIPTS_DIR on PATH', () => {
    const out = buildConsoleOneliner(
      '/x',
      { PAPERCUSP_BIN_DIR: '/home/u/.papercusp/bin', PAPERCUSP_SCRIPTS_DIR: '/bundle/scripts' },
      'true',
      APPEARANCE,
    );
    expect(out).toContain("export PATH='/home/u/.papercusp/bin':'/bundle/scripts':${PATH}");
  });

  it('emits the OSC window-title prelude', () => {
    const out = buildConsoleOneliner('/x', {}, 'true', { mode: 'console', planSlug: null, label: 'my run' });
    expect(out).toContain('printf');
    expect(out).toContain('my run');
  });
});

describe('advSessionTitleTag', () => {
  it('formats a present id and elides a missing one', () => {
    expect(advSessionTitleTag(42)).toBe('[adv:42]');
    expect(advSessionTitleTag(null)).toBe('');
    expect(advSessionTitleTag(undefined)).toBe('');
  });
});

describe('fleet color scheme (AppearanceOpts.scheme)', () => {
  const SCHEME = { name: 'royal-purple', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' };

  it('a bound scheme drives fg (OSC 10), bg (OSC 11) and cursor (OSC 12) — overriding the plan hash', () => {
    const out = buildConsoleOneliner('/x', {}, 'true', {
      mode: 'console',
      planSlug: 'some-plan',
      label: null,
      scheme: SCHEME,
    });
    expect(out).toContain("printf '\\033]10;#f5e8ff\\007'");
    expect(out).toContain("printf '\\033]11;#581c87\\007'");
    expect(out).toContain("printf '\\033]12;#d8b4fe\\007'");
  });

  it('without a scheme: no cursor OSC, and bg falls back to the per-plan hash', () => {
    const out = buildConsoleOneliner('/x', {}, 'true', { mode: 'console', planSlug: null, label: null });
    expect(out).not.toContain('\\033]12;'); // no cursor sequence
    expect(out).toContain("printf '\\033]11;#1e1b4b\\007'"); // console null-slug fallback
  });
});

describe('macConsoleInvocation (operator-direct macOS spawn — approach C)', () => {
  const baseOpts = { tmpDir: '/tmp', nowMs: 1234, pid: 999, hasITerm: false };

  it('writes a one-shot .command that self-deletes then execs the login-shell one-liner', () => {
    const oneliner = buildConsoleOneliner('/proj', {}, 'npm run dev', APPEARANCE);
    const inv = macConsoleInvocation(oneliner, baseOpts);
    expect(inv.content).toMatch(/^#!\/bin\/bash\n/);
    expect(inv.content).toContain('rm -f "$0"'); // self-delete so /tmp doesn't accrete one-shots
    expect(inv.content).toContain('exec bash -lc');
    expect(inv.content).toContain('npm run dev'); // the full one-liner is carried
  });

  it('a quote-bearing greeting survives BOTH layers: the .command parses and its inner bash -lc payload parses', () => {
    // The 2026-07-07 owner repro: mac fleet launch → Terminal.app ran the
    // .command → `bash: -c: line 0: unexpected EOF while looking for matching
    // "'"`. The .command wraps the one-liner in shellEscape (outer layer); the
    // one-liner itself must ALSO be parseable when that inner bash -lc runs.
    const oneliner = buildConsoleOneliner(
      '/proj',
      {},
      "psu --context='it'\\''s a fleet' --plan=p1",
      APPEARANCE,
    );
    const inv = macConsoleInvocation(oneliner, baseOpts);
    // Outer layer: the .command body itself is valid bash.
    expect(() => execFileSync('bash', ['-n'], { input: inv.content })).not.toThrow();
    // Inner layer: what `exec bash -lc <arg>` will parse is the one-liner.
    expect(() => execFileSync('bash', ['-n', '-c', oneliner])).not.toThrow();
  });

  it('names a fresh .command per pid+timestamp under tmpDir', () => {
    const inv = macConsoleInvocation('true', { ...baseOpts, tmpDir: '/var/folders/x', nowMs: 42, pid: 7 });
    expect(inv.file).toBe('/var/folders/x/papercup-console-7-42.command');
  });

  it('opens a FRESH instance (open -na) so every call is a new window', () => {
    const inv = macConsoleInvocation('true', baseOpts);
    expect(inv.openArgs).toEqual(['-na', 'Terminal.app', inv.file]);
  });

  it('prefers iTerm when installed, else Terminal.app', () => {
    expect(macConsoleInvocation('true', { ...baseOpts, hasITerm: true }).term).toBe('iTerm.app');
    expect(macConsoleInvocation('true', { ...baseOpts, hasITerm: false }).term).toBe('Terminal.app');
  });

  it('carries the OSC color prelude into the .command (fleet colors work on Mac, no Rust port)', () => {
    const SCHEME = { name: 'royal-purple', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' };
    const oneliner = buildConsoleOneliner('/x', {}, 'true', {
      mode: 'console',
      planSlug: 'p',
      label: null,
      scheme: SCHEME,
    });
    const inv = macConsoleInvocation(oneliner, baseOpts);
    expect(inv.content).toContain('#581c87'); // bg (OSC 11) survives into the .command
    expect(inv.content).toContain('#d8b4fe'); // cursor (OSC 12) survives
  });
});
