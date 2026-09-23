import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { openSync, closeSync, readSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * WI-10002566 — recurrence guard for a whole bug CLASS, not one script.
 *
 * WHAT WENT WRONG. `kopia-backup-alert.sh` — the alarm built for EI-10733, after a
 * backup outage went unnoticed for 30 days — entered this repo on 2026-09-05 at mode
 * `100644` and stayed there. It had never been executable in repo history. Two
 * consumers broke, and only one of them complained:
 *
 *   - `papercusp-db-backup-alert.service` died `203/EXEC` every time its OnFailure=
 *     fired. Loud, but only in a journal nobody was tailing.
 *   - `kopia-healthcheck.sh` guarded the same call with `[ -x "$ALERT" ] && "$ALERT"`,
 *     which short-circuits to SILENCE for a non-executable file: no page, no error,
 *     no log line — and it then recorded a page in its dedup marker anyway, so the
 *     next 4 hours of real alarms were suppressed too.
 *
 * So for 17 days the alarm was inert while every surface reported normal operation.
 *
 * WHY A TEST AND NOT A CODE REVIEW. A mode bit is invisible in a diff's content, in a
 * code review, and in every `cat`/`grep` an agent runs to check a script. It shows up
 * only in `ls -l` / `git ls-files -s`, which nobody reads by habit. The healthcheck's
 * own self-test could not catch it either: every case injects a stub the harness itself
 * chmod +x'd, so the one property that broke in production was the one property never
 * varied. (That gap is now covered directly by its case 2b.)
 *
 * WHY THE WORKTREE MODE AND NOT THE GIT INDEX. The index is tempting — it is what a
 * fresh checkout materialises — but it LAGS an uncommitted `chmod` on this shared tree,
 * where a background sweep owns committing. Asserting on it would make this guard red
 * for every correct repair until the sweep lands, and a guard that is red for doing the
 * right thing gets weakened by whoever next trips over it. The worktree mode is what
 * systemd actually execs, and a fresh clone of a badly-committed file shows 644 there
 * too — so the case that matters is still caught. `core.fileMode` is asserted
 * separately below, because with it off the bit cannot be recorded at all and a correct
 * local chmod would silently never ship.
 */

const SYSTEMD_DIR =
  process.env.SYSTEMD_EXEC_BIT_DIR ?? resolve(__dirname, '..', 'systemd');
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

/**
 * Scripts deliberately NOT executable. Each entry needs a reason, because "it is not
 * invoked by a unit yet" is exactly what was true of the alarm above right up until it
 * was. Empty is the correct state; prefer `chmod 755` over an entry here.
 */
const NOT_EXECUTABLE_BY_DESIGN = new Map<string, string>();

/** Read only the first two bytes — these scripts are large and only `#!` matters. */
function hasShebang(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(2);
    return readSync(fd, buf, 0, 2, 0) === 2 && buf.toString('latin1') === '#!';
  } finally {
    closeSync(fd);
  }
}

function shellScripts(): { name: string; path: string; mode: number }[] {
  return readdirSync(SYSTEMD_DIR)
    .filter((name) => name.endsWith('.sh'))
    .map((name) => ({ name, path: resolve(SYSTEMD_DIR, name) }))
    .filter(({ path }) => statSync(path).isFile() && hasShebang(path))
    .map(({ name, path }) => ({ name, path, mode: statSync(path).mode & 0o777 }));
}

describe('systemd helper scripts are executable', () => {
  it('measures a non-empty population (a zero-file scan would pass vacuously)', () => {
    const scripts = shellScripts();
    expect(scripts.length).toBeGreaterThan(5);
    if (!process.env.SYSTEMD_EXEC_BIT_DIR) {
      // Positive control: the script this guard was written for must be IN the scanned
      // set. If a rename moves it out, this fails rather than silently passing.
      expect(scripts.map((s) => s.name)).toContain('kopia-backup-alert.sh');
    }
  });

  it('gives every shebanged script the executable bit', () => {
    const offenders = shellScripts()
      .filter((s) => (s.mode & 0o111) === 0)
      .filter((s) => !NOT_EXECUTABLE_BY_DESIGN.has(s.name))
      .map((s) => `${s.name} is ${s.mode.toString(8)} (want 755)`);

    expect(
      offenders,
      offenders.length
        ? 'A shebanged script systemd may be told to exec is not executable.\n' +
            'systemd fails such a unit with 203/EXEC, and a `[ -x ]` guard skips it SILENTLY.\n' +
            'Fix with: chmod 755 <file>   (verify git recorded it: git ls-files -s <file> -> 100755)\n' +
            offenders.join('\n')
        : undefined,
    ).toEqual([]);
  });

  it('keeps git able to RECORD the mode (core.fileMode off would drop the fix)', () => {
    const value = execFileSync('git', ['config', '--get', 'core.fileMode'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .trim()
      // An unset core.fileMode defaults to true on this platform.
      .toLowerCase();
    expect(value === '' || value === 'true').toBe(true);
  });

  it('keeps the allowlist justified', () => {
    for (const [name, reason] of NOT_EXECUTABLE_BY_DESIGN) {
      expect(reason.length, `${name} needs a real reason, not a placeholder`).toBeGreaterThan(20);
    }
  });
});
