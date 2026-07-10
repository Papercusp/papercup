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
import { resolveOwnedTtyPath } from '../scripts/psu-launcher.mjs';

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

describe('install parity — every hooks/cc file reaches the installed runtime dir', () => {
  it('the installer copies pc_tty.py (its importers fail open without it — silently)', () => {
    const sh = readFileSync(INSTALLER, 'utf8');
    expect(sh).toContain('pc_tty.py');
  });

  it('no hooks/cc file is left behind by the installer', () => {
    const sh = readFileSync(INSTALLER, 'utf8');
    const files = execFileSync('ls', [HOOKS_CC], { encoding: 'utf8' })
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.endsWith('.sh') || f.endsWith('.py'));
    expect(files.length).toBeGreaterThan(0);
    const missing = files.filter((f) => !sh.includes(f));
    expect(missing, `hooks/cc files never copied by install-standalone-mcp.sh: ${missing.join(', ')}`).toEqual([]);
  });
});
