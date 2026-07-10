/**
 * tty-title-target.test.ts — the RECURRENCE GUARD for WI-3665.
 *
 * The bug: every CLI hook wrote its OSC-0 terminal title to `/dev/tty`, the process's
 * CONTROLLING terminal. Claude Code spawns the `statusLine` command setsid'd (its own
 * session, no controlling terminal), so the open raised ENXIO, the hook fail-opened, and
 * the fleet-identity title (👑 leader / 👤 member) silently never appeared — on every tick,
 * for the entire life of the hook. Nothing caught it because a fail-open write and a
 * successful write are indistinguishable from outside.
 *
 * So the guard is not "does the title render" (objective-title-parity.test.ts already owns
 * that) but "does the title LAND when the hook has no controlling terminal". These tests
 * run the real hooks under `setsid`, which reproduces Claude's spawn mode exactly, and
 * assert the escape reaches the terminal named by PAPERCUSP_TTY.
 *
 * They also pin the two invariants that keep the fix safe:
 *   - a hook with NO owned terminal writes NOTHING (a headless bee must never retitle a
 *     window it doesn't own);
 *   - psu re-derives PAPERCUSP_TTY per launch and never lets an inherited one leak into a
 *     headless child.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveOwnedTtyPath, shouldSilenceClaudeTitle } from '../scripts/psu-launcher.mjs';

const STATUSLINE = resolve(__dirname, '../scripts/hooks/cc/statusline-fleet.sh');
const OBJ_TITLE = resolve(__dirname, '../scripts/hooks/cc/posttooluse-objective-title.sh');
const HOOKS_CC = resolve(__dirname, '../scripts/hooks/cc');
const INSTALLER = resolve(__dirname, '../scripts/install-standalone-mcp.sh');
const dir = mkdtempSync(join(tmpdir(), 'tty-title-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SID = 'su-9859ea5e-926d-4c65-b8fb-4d7c25a21353';
const hasSetsid = (() => {
  try {
    execFileSync('setsid', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const glance = {
  ok: true,
  wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
  bees: { running: 0 },
  governor: { anyPaused: false, paused: [] },
  activity: [],
  tips: [],
  display: {
    title: '👑 windows-parity 🟦 · su-9859e · 🔭 ship the crown',
    statusline: ['🔭 ship the crown · ◇ su-9859e'],
    notice: null,
  },
};

/** Run a hook DETACHED FROM ANY CONTROLLING TERMINAL — exactly how Claude spawns statusLine.
 *  Returns whatever landed at the PAPERCUSP_TTY path (here, a plain file standing in for a
 *  terminal device: the hook opens and writes it identically). */
function runSetsid(hook: string, env: Record<string, string>): string {
  const fixtureKey = hook === STATUSLINE ? 'PAPERCUSP_STATUSLINE_FIXTURE' : 'PAPERCUSP_OBJECTIVE_FIXTURE';
  const fixture = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(fixture, JSON.stringify(glance));
  execFileSync('setsid', ['bash', hook], {
    encoding: 'utf8',
    input: '{}',
    // setsid + pipes ⇒ the child has NO controlling terminal: /dev/tty is unopenable.
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      [fixtureKey]: fixture,
      PAPERCUSP_SID: SID,
      COLUMNS: '200',
      PAPERCUSP_LOCKS_CACHE_DIR: join(dir, `cache-${Math.random().toString(36).slice(2)}`),
      ...env,
    },
  });
  const out = env.PAPERCUSP_TTY ?? '';
  if (!out || !existsSync(out)) return '';
  return readFileSync(out, 'utf8');
}

describe.runIf(hasSetsid)('WI-3665 — the title lands from a hook with NO controlling terminal', () => {
  for (const [name, hook] of [
    ['claude statusline', STATUSLINE],
    ['codex objective-title', OBJ_TITLE],
  ] as const) {
    it(`${name}: a setsid'd hook still writes the OSC-0 title to the OWNED terminal`, () => {
      const ttyFile = join(dir, `${Math.random().toString(36).slice(2)}.tty`);
      writeFileSync(ttyFile, '');
      const wrote = runSetsid(hook, { PAPERCUSP_TTY: ttyFile });
      // The exact wire form: ESC ] 0 ; <title> BEL — and the crown must survive intact.
      expect(wrote).toBe(`\x1b]0;${glance.display.title}\x07`);
      expect(wrote).toContain('👑');
    });

    it(`${name}: with NO owned terminal and no /dev/tty, it writes nothing and exits clean`, () => {
      // The headless-bee invariant. No PAPERCUSP_TTY ⇒ every candidate fails ⇒ silence.
      // (If this ever throws, a hook has started treating a cosmetic title as load-bearing.)
      const ttyFile = join(dir, `${Math.random().toString(36).slice(2)}.tty`);
      writeFileSync(ttyFile, '');
      expect(() => runSetsid(hook, {})).not.toThrow();
      expect(readFileSync(ttyFile, 'utf8')).toBe('');
    });
  }
});

describe('resolveOwnedTtyPath — psu names the terminal it owns, or nothing', () => {
  const notTty = { isTTY: false } as NodeJS.WriteStream;
  const isTty = { isTTY: true } as NodeJS.WriteStream;

  it('returns null when neither stdout nor stdin is a tty (a headless launch owns no window)', () => {
    expect(
      resolveOwnedTtyPath({
        stdin: notTty,
        stdout: notTty,
        platform: 'linux',
        readLink: () => '/dev/pts/24',
        psTty: () => 'pts/24',
      }),
    ).toBeNull();
  });

  it('reads the device off /proc/self/fd/1 on linux', () => {
    expect(
      resolveOwnedTtyPath({
        stdin: isTty,
        stdout: isTty,
        platform: 'linux',
        readLink: (p: string) => (p === '/proc/self/fd/1' ? '/dev/pts/24' : '/dev/pts/99'),
        psTty: () => '',
      }),
    ).toBe('/dev/pts/24');
  });

  it('falls back to stdin when stdout is redirected to a file', () => {
    expect(
      resolveOwnedTtyPath({
        stdin: isTty,
        stdout: notTty,
        platform: 'linux',
        readLink: (p: string) => (p === '/proc/self/fd/1' ? '/tmp/some.log' : '/dev/pts/24'),
        psTty: () => '',
      }),
    ).toBe('/dev/pts/24');
  });

  it('never returns a non-terminal path even when a fd points at a regular file', () => {
    // The guard that keeps us from "setting the title" of a log file.
    expect(
      resolveOwnedTtyPath({
        stdin: isTty,
        stdout: isTty,
        platform: 'linux',
        readLink: () => '/tmp/some.log',
        psTty: () => '?',
      }),
    ).toBeNull();
  });

  it('uses `ps -o tty=` on darwin, resolving a bare name to the device that EXISTS', () => {
    expect(
      resolveOwnedTtyPath({
        stdin: isTty,
        stdout: isTty,
        platform: 'darwin',
        readLink: () => {
          throw new Error('no /proc on darwin');
        },
        // 'console' must become /dev/console, NOT /dev/ttyconsole. '/dev/console' exists on
        // both linux + darwin, so this assertion is portable.
        psTty: () => 'console\n',
      }),
    ).toBe('/dev/console');
  });

  it("resolves darwin's short 's003' form to /dev/ttys003 (the 'tty' prefix is implied)", () => {
    // The spelling that broke the first cut of this resolver: a bare 's003' is NOT /dev/s003.
    // Probing existence is what disambiguates it from 'console'; assert against a fake fs.
    const seen: string[] = [];
    expect(
      resolveOwnedTtyPath({
        stdin: isTty,
        stdout: isTty,
        platform: 'darwin',
        readLink: () => {
          throw new Error('no /proc on darwin');
        },
        psTty: () => 's003\n',
        exists: (p: string) => {
          seen.push(p);
          return p === '/dev/ttys003';
        },
      }),
    ).toBe('/dev/ttys003');
    expect(seen).toEqual(['/dev/s003', '/dev/ttys003']);
  });

  it('returns null when ps reports no controlling terminal', () => {
    expect(
      resolveOwnedTtyPath({
        stdin: isTty,
        stdout: isTty,
        platform: 'darwin',
        readLink: () => {
          throw new Error('no /proc');
        },
        psTty: () => '??\n',
      }),
    ).toBeNull();
  });
});

describe('shouldSilenceClaudeTitle — exactly one writer owns the title', () => {
  const ours = JSON.stringify({ statusLine: { type: 'command', command: '/x/hooks/cc/statusline-fleet.sh' } });
  const foreign = JSON.stringify({ statusLine: { type: 'command', command: '~/bin/my-statusline.sh' } });
  const base = { agent: 'claude', ownsTty: true, env: {} as NodeJS.ProcessEnv, home: '/home/u' };

  it('silences Claude when OUR statusline is the configured writer', () => {
    expect(shouldSilenceClaudeTitle({ ...base, readFile: () => ours })).toBe(true);
  });

  it('leaves a FOREIGN statusline alone — silencing it would leave no title at all', () => {
    expect(shouldSilenceClaudeTitle({ ...base, readFile: () => foreign })).toBe(false);
  });

  it('never silences when settings.json is missing or unparseable (fail open)', () => {
    expect(
      shouldSilenceClaudeTitle({
        ...base,
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBe(false);
    expect(shouldSilenceClaudeTitle({ ...base, readFile: () => 'not json' })).toBe(false);
  });

  it('is claude-only — codex and omp never wrote a title of their own', () => {
    for (const agent of ['codex', 'omp']) {
      expect(shouldSilenceClaudeTitle({ ...base, agent, readFile: () => ours })).toBe(false);
    }
  });

  it('is a no-op for a headless launch (owns no terminal ⇒ nobody writes)', () => {
    expect(shouldSilenceClaudeTitle({ ...base, ownsTty: false, readFile: () => ours })).toBe(false);
  });

  it('reads the per-session CLAUDE_CONFIG_DIR settings when psu pinned one (EI-155)', () => {
    const seen: string[] = [];
    shouldSilenceClaudeTitle({
      ...base,
      env: { CLAUDE_CONFIG_DIR: '/iso/su-abc' } as NodeJS.ProcessEnv,
      readFile: (p: string) => {
        seen.push(p);
        return ours;
      },
    });
    expect(seen).toEqual(['/iso/su-abc/settings.json']);
  });

  it('falls back to the shared ~/.claude/settings.json with no CLAUDE_CONFIG_DIR', () => {
    const seen: string[] = [];
    shouldSilenceClaudeTitle({
      ...base,
      readFile: (p: string) => {
        seen.push(p);
        return ours;
      },
    });
    expect(seen).toEqual(['/home/u/.claude/settings.json']);
  });
});

describe('every hook pins format=json on its LIVE glance read (EI-7029 / WI-3665)', () => {
  // coord:glance answers in TOON by default. A hook that forgets to pin JSON cannot parse the
  // reply, silently falls back to a bare-id title, and loses the 👑/👤 entirely. The
  // fixture-driven parity suite CANNOT see this — fixtures never touch the network — so it is
  // asserted here, at the request-construction site, for all three CLIs.
  const OMP_HOOK = resolve(__dirname, '../scripts/hooks/omp/coord-hook.ts');

  it('claude statusline pins format=json on the mcp url', () => {
    expect(readFileSync(STATUSLINE, 'utf8')).toContain('format=json');
  });

  it('codex objective-title pins format=json on the mcp url', () => {
    expect(readFileSync(OBJ_TITLE, 'utf8')).toContain('format=json');
  });

  it("omp's emitStatusDisplay passes _meta { format: 'json' } to callMcpTool", () => {
    const src = readFileSync(OMP_HOOK, 'utf8');
    const fn = src.slice(src.indexOf('export async function emitStatusDisplay'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain("callMcpTool(\n    'coord:glance'");
    expect(body).toContain("meta: { format: 'json' }");
  });
});

describe('install parity — hooks/cc reaches ALL THREE deploy paths', () => {
  // A hook that ships without the lib it imports raises ImportError, fails OPEN, and silently
  // stops setting the title. There are three independent copy paths and each one has its own
  // way of leaving a file behind (a `*.sh` glob, an explicit allowlist, a cp list) — so each
  // gets its own assertion. This is the guard for the EI-8191 / WI-3665 shape.
  const SIDECAR_BUILD = resolve(__dirname, '../../../papercusp-desktop/bin/build-desktop-sidecar.sh');
  const DESKTOP_INSTALL = resolve(
    __dirname,
    '../../../packages/operator-core/lib/desktop-install/papercusp-files.ts',
  );
  const hookFiles = execFileSync('ls', [HOOKS_CC], { encoding: 'utf8' })
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.endsWith('.sh') || f.endsWith('.py'));

  it('the repo actually has hook files + the shared lib (guards a vacuous suite)', () => {
    expect(hookFiles).toContain('pc_tty.py');
    expect(hookFiles).toContain('statusline-fleet.sh');
  });

  it('1/3 install-standalone-mcp.sh copies every hooks/cc file', () => {
    const sh = readFileSync(INSTALLER, 'utf8');
    const missing = hookFiles.filter((f) => !sh.includes(f));
    expect(missing, `never copied by install-standalone-mcp.sh: ${missing.join(', ')}`).toEqual([]);
  });

  it('2/3 build-desktop-sidecar.sh ships the *.py libs, not just *.sh', () => {
    const sh = readFileSync(SIDECAR_BUILD, 'utf8');
    // `cp -a .../*.sh` alone would silently drop pc_tty.py from every packaged app.
    expect(sh).toMatch(/\*\.py/);
  });

  it('3/3 the desktop installer allowlists every hooks/cc file', () => {
    const ts = readFileSync(DESKTOP_INSTALL, 'utf8');
    const list = ts.slice(ts.indexOf('const CC_HOOK_FILES'), ts.indexOf('] as const;'));
    const missing = hookFiles.filter((f) => !list.includes(f));
    expect(missing, `absent from CC_HOOK_FILES: ${missing.join(', ')}`).toEqual([]);
  });

  it('a python lib is installed non-executable (imported, never exec\'d)', () => {
    const ts = readFileSync(DESKTOP_INSTALL, 'utf8');
    expect(ts).toContain('CC_HOOK_LIB_FILES');
    expect(ts).toContain('0o644');
  });
});
