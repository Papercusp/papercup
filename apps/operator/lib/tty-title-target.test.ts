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
import { claimTtyOwnership, resolveOwnedTtyPath, shouldSilenceClaudeTitle } from '../scripts/psu-launcher.mjs';

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

describe('claimTtyOwnership — psu stamps a claim on every terminal it resolves (EI-10377)', () => {
  it('writes the sid to a filename derived from the full device path', () => {
    const claimsDir = join(dir, `claims-${Math.random().toString(36).slice(2)}`);
    claimTtyOwnership('/dev/pts/24', 'su-abc', { dir: claimsDir });
    const files = execFileSync('ls', [claimsDir], { encoding: 'utf8' }).trim().split('\n');
    expect(files).toHaveLength(1);
    expect(readFileSync(join(claimsDir, files[0]), 'utf8')).toBe('su-abc');
  });

  it('a later claim on the SAME path overwrites the earlier one — no accumulation', () => {
    const claimsDir = join(dir, `claims-${Math.random().toString(36).slice(2)}`);
    claimTtyOwnership('/dev/pts/24', 'su-old', { dir: claimsDir });
    claimTtyOwnership('/dev/pts/24', 'su-new', { dir: claimsDir });
    const files = execFileSync('ls', [claimsDir], { encoding: 'utf8' }).trim().split('\n');
    expect(files).toHaveLength(1); // same path ⇒ same filename ⇒ overwrite, not a second file
    expect(readFileSync(join(claimsDir, files[0]), 'utf8')).toBe('su-new');
  });

  it('is a no-op (never throws, never creates the dir) with no path or no sid', () => {
    const claimsDir = join(dir, `claims-${Math.random().toString(36).slice(2)}`);
    expect(() => claimTtyOwnership('', 'su-abc', { dir: claimsDir })).not.toThrow();
    expect(() => claimTtyOwnership('/dev/pts/24', '', { dir: claimsDir })).not.toThrow();
    expect(existsSync(claimsDir)).toBe(false);
  });
});

describe.runIf(hasSetsid)(
  'EI-10377 — a stale claim blocks the write even under setsid (both CLI hooks, live on-camera repro)',
  () => {
    for (const [name, hook] of [
      ['claude statusline', STATUSLINE],
      ['codex objective-title', OBJ_TITLE],
    ] as const) {
      it(`${name}: a claim naming a DIFFERENT session blocks the PAPERCUSP_TTY write`, () => {
        // Reproduces the bug exactly: su-9859e's PAPERCUSP_TTY still spells a path that has
        // since been claimed by a different session (the recycled-pty case) — the write must
        // not land, same as a closed terminal.
        const ttyFile = join(dir, `${Math.random().toString(36).slice(2)}.tty`);
        writeFileSync(ttyFile, '');
        const claimsDir = join(dir, `claims-${Math.random().toString(36).slice(2)}`);
        claimTtyOwnership(ttyFile, 'su-someone-else', { dir: claimsDir });
        const wrote = runSetsid(hook, { PAPERCUSP_TTY: ttyFile, PAPERCUSP_TTY_CLAIMS_DIR: claimsDir });
        // setsid ⇒ /dev/tty is unopenable too, so a correctly-blocked claim means total silence.
        expect(wrote).toBe('');
      });

      it(`${name}: a claim naming OUR OWN session still lands the write`, () => {
        const ttyFile = join(dir, `${Math.random().toString(36).slice(2)}.tty`);
        writeFileSync(ttyFile, '');
        const claimsDir = join(dir, `claims-${Math.random().toString(36).slice(2)}`);
        claimTtyOwnership(ttyFile, SID, { dir: claimsDir }); // SID matches runSetsid's default PAPERCUSP_SID
        const wrote = runSetsid(hook, { PAPERCUSP_TTY: ttyFile, PAPERCUSP_TTY_CLAIMS_DIR: claimsDir });
        expect(wrote).toBe(`\x1b]0;${glance.display.title}\x07`);
      });

      it(`${name}: no claim on record fails OPEN — a session that predates the registry keeps working`, () => {
        const ttyFile = join(dir, `${Math.random().toString(36).slice(2)}.tty`);
        writeFileSync(ttyFile, '');
        const claimsDir = join(dir, `claims-${Math.random().toString(36).slice(2)}`); // never populated
        const wrote = runSetsid(hook, { PAPERCUSP_TTY: ttyFile, PAPERCUSP_TTY_CLAIMS_DIR: claimsDir });
        expect(wrote).toBe(`\x1b]0;${glance.display.title}\x07`);
      });
    }
  },
);

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
  // EI-20782070131658758: `.mjs` MUST be in this filter. It used to read `.sh || .py`, which
  // exempted the ENTIRE modern hook population — every PreToolUse guard and PostToolUse nudge
  // written since the shell era is `.mjs`. All three "guard existed in-repo but never
  // installed" incidents (WI-5543, WI-5542, EI-20782070131658758) were `.mjs`, so this suite
  // reported green through every one of them while claiming to check that the installers
  // "cop[y] every hooks/cc file". Widening it exposed 12 of 18 `.mjs` hooks uncopied by
  // install-standalone-mcp.sh; that installer now enumerates instead of listing by hand.
  const hookFiles = execFileSync('ls', [HOOKS_CC], { encoding: 'utf8' })
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => /\.(sh|py|mjs)$/.test(f))
    .filter((f) => !/\.(tmp|d\.mts)$/.test(f) && !/\.bak(-|\.|$)/.test(f));

  it('the repo actually has hook files + the shared lib (guards a vacuous suite)', () => {
    expect(hookFiles).toContain('pc_tty.py');
    expect(hookFiles).toContain('statusline-fleet.sh');
    // EI-20782070131658758: pin the .mjs half of the filter. Without this the suite goes
    // vacuous again the moment someone "simplifies" the extension test back to .sh/.py, and
    // that regression is invisible — every assertion below still passes, on a smaller set.
    expect(hookFiles).toContain('pretooluse-control-bytes-content-guard.mjs');
    expect(hookFiles.filter((f) => f.endsWith('.mjs')).length).toBeGreaterThan(10);
    // ...and pin the exclusions, so tracked install residue never enters the population.
    expect(hookFiles.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('1/3 install-standalone-mcp.sh copies every hooks/cc file', () => {
    const sh = readFileSync(INSTALLER, 'utf8');
    // EI-20782070131658758: the installer now ENUMERATES the hook dir
    // (`for cc_hook_src in "${CC_HOOK_SRC_DIR}"/*.sh "${CC_HOOK_SRC_DIR}"/*.mjs`) rather than
    // naming each file in its own `cp` line. So "is this filename mentioned in the script"
    // is no longer a valid instrument — under enumeration it is false for every file while
    // all of them ARE copied. The invariant that survives the mechanism change, and is the
    // one that actually prevents a forgotten hook, is per EXTENSION: every extension present
    // in hooks/cc must be either enumerated by a glob or exhaustively named.
    const extOf = (f: string) => f.slice(f.lastIndexOf('.'));
    const exts = [...new Set(hookFiles.map(extOf))].sort();

    const uncovered = exts.filter((ext) => {
      const enumerated = sh.includes(`"\${CC_HOOK_SRC_DIR}"/*${ext}`);
      const allNamed = hookFiles.filter((f) => extOf(f) === ext).every((f) => sh.includes(f));
      return !enumerated && !allNamed;
    });

    expect(
      uncovered,
      `install-standalone-mcp.sh copies neither a "\${CC_HOOK_SRC_DIR}"/*<ext> glob nor every ` +
        `file for these extensions, so a hook with one is silently never installed: ` +
        `${uncovered.join(', ')}`,
    ).toEqual([]);

    // Calibration: the check above is only meaningful if it read a real, populated dir with
    // more than one extension in it — otherwise `uncovered` is trivially empty.
    expect(exts.length).toBeGreaterThan(1);
    expect(exts).toContain('.mjs');

    // Claude native edit batches need a separate matcher-less lifecycle hook;
    // copying the file without registering it would leave the union lock held
    // until TTL. Pin the standalone installer wiring, not just the copy glob.
    expect(sh).toContain('CC_POST_BATCH_LOCKS_HOOK');
    expect(sh).toContain('posttoolbatch-locks-release.sh');
    expect(sh).toContain("hooks['PostToolBatch'] = arr");
    // EI-21220966892195714: copying the guard is not enough; the standalone
    // installer must also register its Write-only PostToolUse matcher.
    expect(sh).toContain('CC_WRITE_BYTE_INTEGRITY_HOOK');
    expect(sh).toContain('merge_write_byte_integrity_guard_hook');
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

  it('OMP companion guard: the desktop sidecar ships every direct OMP hook TypeScript sibling', () => {
    const sidecar = readFileSync(SIDECAR_BUILD, 'utf8');
    // OMP entrypoints are loaded as independent TypeScript files. Copying only
    // coord-hook.ts/inject-hook.ts recreates EI-20228871846415832 the next time
    // either entrypoint gains a relative sibling import. Keep this assertion
    // generic so a future extracted sibling is covered without adding its name.
    expect(sidecar).toMatch(/hooks\/omp[\s\S]{0,500}\*\.ts/);
    expect(sidecar).toContain('non-preempting-delivery.ts');
  });

  it('a python lib is installed non-executable (imported, never exec\'d)', () => {
    const ts = readFileSync(DESKTOP_INSTALL, 'utf8');
    expect(ts).toContain('CC_HOOK_LIB_FILES');
    expect(ts).toContain('0o644');
  });
});
