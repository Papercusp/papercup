/**
 * EI-18666147162251862: agents (and admin-commands.ts's `start-mac-vm`) guard
 * destructive/skip decisions with `pgrep -f <pattern>` / `pkill -f <pattern>`.
 * Since every such command runs as `bash -c '<the whole command string>'`, the
 * invoking shell's OWN cmdline contains the pattern text literally (it's the
 * pgrep argument itself) — and `pgrep -f` matches against every process
 * system-wide, not just descendants, so it self-matches its own ancestor.
 * Reproduced live (see scripts/proc-guard.mjs's header comment):
 *
 *   bash -c 'pgrep -f "definitely-not-a-real-process-zzqq" >/dev/null && echo MATCHED'
 *   # => MATCHED, though nothing by that name exists anywhere.
 *
 * scripts/proc-guard.mjs fixes this by excluding the caller's own pid + its
 * whole ancestor chain before matching. These tests build a fake /proc fixture
 * reproducing exactly that shape (a bash -c wrapper ancestor whose own cmdline
 * embeds the pattern) and assert the guard is immune to it while still catching
 * a genuinely unrelated external process.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getAncestryChain,
  getOperationalArgv,
  listProcesses,
  matchExternalProcesses,
  matchExternalProcessesDetailed,
  parseArgv,
  parseCmdline,
  parsePpid,
} from '../../../scripts/proc-guard.mjs';

let fixtureRoot: string | null = null;

function fixtureProc(root: string, pid: number, ppid: number, argv: string[], comm = 'bash') {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cmdline'), argv.join('\0') + '\0');
  // Minimal realistic /proc/<pid>/stat: "pid (comm) state ppid ...". Real
  // stat lines have 50+ fields; parsePpid only needs the ones up to ppid.
  writeFileSync(join(dir, 'stat'), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 0 0 0 0 0`);
}

afterEach(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = null;
  }
});

describe('parseCmdline', () => {
  it('joins NUL-separated argv into a space-joined display string', () => {
    expect(parseCmdline(Buffer.from('pgrep\0-f\0qemu.*mac_hdd_ng\0'))).toBe('pgrep -f qemu.*mac_hdd_ng');
  });

  it('drops the trailing empty segment from the terminating NUL', () => {
    expect(parseCmdline(Buffer.from('node\0script.mjs\0'))).toBe('node script.mjs');
  });
});

describe('parseArgv and getOperationalArgv', () => {
  it('keeps raw argv boundaries while parseCmdline remains display-compatible', () => {
    const raw = Buffer.from('node\0script.mjs\0argument with spaces\0');
    expect(parseArgv(raw)).toEqual(['node', 'script.mjs', 'argument with spaces']);
    expect(parseCmdline(raw)).toBe('node script.mjs argument with spaces');
  });

  it('removes kickoff prompt payloads but retains the executable and real args', () => {
    const argv = [
      '/usr/bin/gnome-terminal',
      '--wait',
      'PAPERCUSP_KICKOFF_PROMPT=green-checkpoint',
      '--target',
      'mac_hdd_ng.img',
    ];
    expect(getOperationalArgv(argv)).toEqual(['/usr/bin/gnome-terminal', '--wait', '--target', 'mac_hdd_ng.img']);
  });
});

describe('parsePpid', () => {
  it('parses ppid from a normal comm field', () => {
    expect(parsePpid('1234 (bash) S 1000 1234 1234 0 -1 0')).toBe(1000);
  });

  it('resumes field-splitting after the LAST close-paren so a comm containing ")" is safe', () => {
    // A process named "weird)proc" would otherwise be mis-split mid-name.
    expect(parsePpid('55 (weird)proc) S 42 55 55 0 -1 0')).toBe(42);
  });

  it('returns null when the line has no comm parens at all', () => {
    expect(parsePpid('garbage line with no parens')).toBeNull();
  });
});

describe('getAncestryChain', () => {
  it('walks parent -> grandparent -> ... -> pid 1', () => {
    const byPid = new Map([
      [1, null],
      [50, 1],
      [100, 50],
      [200, 100],
    ]);
    expect(getAncestryChain(200, byPid)).toEqual(new Set([200, 100, 50, 1]));
  });

  it('is cycle-safe (a corrupt ppid chain never infinite-loops)', () => {
    const byPid = new Map([
      [10, 20],
      [20, 10], // cycle
    ]);
    const chain = getAncestryChain(10, byPid);
    expect(chain).toEqual(new Set([10, 20]));
  });

  it('stops cleanly on an unknown ppid', () => {
    const byPid = new Map([[5, 999]]); // 999 not in the map
    expect(getAncestryChain(5, byPid)).toEqual(new Set([5, 999]));
  });
});

describe('matchExternalProcesses — the EI-18666147162251862 regression', () => {
  it('does NOT self-match when the pattern only appears in the caller\'s own ancestor cmdline', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'definitely-not-a-real-process-zzqq';
    // pid 1: init. pid 50: the `bash -c '<whole command>'` wrapper — its own
    // cmdline embeds the pattern text (it's literally running `pgrep -f
    // "<PATTERN>"`), which is exactly what makes a bare `pgrep -f` self-match.
    // pid 100: "us" (e.g. the proc-guard CLI itself, or the pgrep it would spawn).
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 50, 1, ['bash', '-c', `if pgrep -f "${PATTERN}" >/dev/null; then echo MATCHED; fi`]);
    fixtureProc(fixtureRoot, 100, 50, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);

    const matches = matchExternalProcesses(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    expect(matches).toEqual([]); // the naive `pgrep -f` equivalent would have returned pid 50 here
  });

  it('DOES match a genuinely unrelated external process with the pattern in its cmdline', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'qemu.*mac_hdd_ng';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 50, 1, ['bash', '-c', `if pgrep -f "${PATTERN}" >/dev/null; then echo MATCHED; fi`]);
    fixtureProc(fixtureRoot, 100, 50, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);
    // The real target: an unrelated qemu process, NOT an ancestor of pid 100.
    fixtureProc(fixtureRoot, 777, 1, ['qemu-system-x86_64', '-drive', 'file=./mac_hdd_ng.img'], 'qemu-system-x8');

    const matches = matchExternalProcesses(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    expect(matches.map((m) => m.pid)).toEqual([777]);
  });

  it('excludes an unrelated process that is merely a SIBLING ancestor-less match correctly, and excludes self', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'target-thing';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]); // self
    fixtureProc(fixtureRoot, 200, 1, ['some-other-proc', PATTERN]); // unrelated sibling, real match

    const matches = matchExternalProcesses(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    expect(matches.map((m) => m.pid)).toEqual([200]);
  });

  it('returns [] against a missing /proc root rather than throwing', () => {
    const matches = matchExternalProcesses('anything', { procRoot: '/no/such/proc/root', selfPid: 1 });
    expect(matches).toEqual([]);
  });

  it('ignores kickoff prompt text while retaining the real-vs-argv-text split', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'green-checkpoint';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);
    fixtureProc(fixtureRoot, 777, 1, ['node', 'apps/operator/lib/release/green-checkpoint.ts']);
    fixtureProc(fixtureRoot, 778, 1, [
      'bun',
      '/home/dev/.papercusp/bin/omp',
      '--model',
      'model:low',
      '⟦turn-origin:fleet-kickoff nonce:abc⟧ The green-checkpoint gate is red.',
    ]);
    fixtureProc(fixtureRoot, 779, 1, [
      'bash',
      '-lc',
      "export PAPERCUSP_KICKOFF_PROMPT='The green-checkpoint gate is red.'; exec $SHELL",
    ]);

    const report = matchExternalProcessesDetailed(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    expect(report.matches.map((m) => m.pid)).toEqual([777]);
    expect(report.fullMatches.map((m) => m.pid)).toEqual([777, 778, 779]);
    expect(report.argvTextOnly.map((m) => m.pid)).toEqual([778, 779]);
    expect(matchExternalProcesses(PATTERN, { procRoot: fixtureRoot, selfPid: 100 }).map((m) => m.pid)).toEqual([777]);
  });
});

describe('listProcesses', () => {
  it('skips a pid whose cmdline is empty (kernel threads / zombies)', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    mkdirSync(join(fixtureRoot, '2'), { recursive: true });
    writeFileSync(join(fixtureRoot, '2', 'cmdline'), ''); // kthread-like: empty cmdline
    writeFileSync(join(fixtureRoot, '2', 'stat'), '2 (kthreadd) S 0 0 0 0 -1 0');
    fixtureProc(fixtureRoot, 3, 0, ['real-process']);

    const procs = listProcesses(fixtureRoot);
    expect(procs.map((p) => p.pid)).toEqual([3]);
  });
});
