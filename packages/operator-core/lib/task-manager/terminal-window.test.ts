import { describe, expect, it } from 'vitest';
import { readTerminalAppPids, terminalWindowAlive } from './terminal-window';
import type { CgroupFs } from './cgroup-read';

const ROOT = '/sys/fs/cgroup';
const TERM = `${ROOT}/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice`;

const SERVER = 500;
const USER_MANAGER = 2026497;

/**
 * A terminal slice with one application unit and whatever windows the test names.
 * `ppid` is what the whole probe turns on, so it is the explicit input here.
 */
function box(opts: {
  /** child dir name -> pids */
  children: Record<string, number[]>;
  /** pid -> ppid; a pid with no entry gets an unreadable /proc/<pid>/stat */
  ppids: Record<number, number>;
  /** pids whose cgroup.procs read fails outright */
  unreadableScopes?: string[];
}): CgroupFs {
  const files: Record<string, string> = {};
  const dirs = new Set<string>([TERM]);

  for (const [name, pids] of Object.entries(opts.children)) {
    const abs = `${TERM}/${name}`;
    dirs.add(abs);
    if (!opts.unreadableScopes?.includes(name)) files[`${abs}/cgroup.procs`] = pids.join('\n');
  }
  for (const [pid, ppid] of Object.entries(opts.ppids)) {
    // Real /proc/<pid>/stat shape: pid (comm) state ppid …
    files[`/proc/${pid}/stat`] =
      `${pid} (node) S ${ppid} 1 1 0 -1 0 0 0 0 0 1 2 0 0 20 0 1 0 12345 0 0`;
  }

  return {
    readFile: (p) => files[p] ?? null,
    isDir: (p) => dirs.has(p),
    readDir: (p) => {
      const out = new Set<string>();
      for (const d of dirs) {
        if (d.startsWith(`${p}/`)) out.add(d.slice(p.length + 1).split('/')[0]!);
      }
      return [...out];
    },
  };
}

describe('readTerminalAppPids', () => {
  it('takes the application’s own units and skips the window scopes', () => {
    // Derived from the slice rather than from the name `gnome-terminal-server`, so
    // renaming the unit cannot silently empty the set.
    const fs = box({
      children: {
        'gnome-terminal-server.service': [SERVER, 501],
        'vte-spawn-aaaa-bbbb.scope': [600],
        'vte-spawn-cccc-dddd.scope': [700],
      },
      ppids: {},
    });
    expect([...readTerminalAppPids(TERM, fs)].sort((a, b) => a - b)).toEqual([SERVER, 501]);
  });

  it('returns an empty set when the slice cannot be read — the UNKNOWN input', () => {
    const fs = box({ children: {}, ppids: {} });
    expect(readTerminalAppPids(`${TERM}-does-not-exist`, fs).size).toBe(0);
  });
});

describe('terminalWindowAlive', () => {
  const children = {
    'gnome-terminal-server.service': [SERVER],
    'vte-spawn-0e0e-4a4a.scope': [600, 601],
    'vte-spawn-0d0d-4b4b.scope': [700, 701],
  };

  it('calls a window OPEN while its shell is still a child of the application', () => {
    const fs = box({ children, ppids: { 600: SERVER, 601: 600, 700: 1, 701: 700 } });
    const app = readTerminalAppPids(TERM, fs);
    expect(terminalWindowAlive(`${TERM}/vte-spawn-0e0e-4a4a.scope`, app, fs)).toBe(true);
  });

  it('calls a window CLOSED once nothing in it is parented to the application', () => {
    // What closing the window actually does: the shell dies and the survivors are
    // orphaned onto pid 1 / the user manager. This is the 17-scope, 123-process
    // population that was reading as `exempt/human-terminal`.
    const fs = box({ children, ppids: { 600: SERVER, 601: 600, 700: 1, 701: USER_MANAGER } });
    const app = readTerminalAppPids(TERM, fs);
    expect(terminalWindowAlive(`${TERM}/vte-spawn-0d0d-4b4b.scope`, app, fs)).toBe(false);
  });

  it('finds the shell wherever it sits in cgroup.procs, not only first', () => {
    // It is first in 86/86 live scopes on this box, which is why the loop
    // short-circuits — but ordering is not a guarantee the kernel makes.
    const fs = box({
      children: { ...children, 'vte-spawn-0e0e-4a4a.scope': [601, 600] },
      ppids: { 600: SERVER, 601: 999 },
    });
    const app = readTerminalAppPids(TERM, fs);
    expect(terminalWindowAlive(`${TERM}/vte-spawn-0e0e-4a4a.scope`, app, fs)).toBe(true);
  });

  describe('every degraded input is UNKNOWN, never dead', () => {
    // The asymmetry that keeps a probe failure from presenting the owner's live
    // terminal as residue for a reaper to act on.
    it('unknown when the application cannot be identified', () => {
      const fs = box({ children, ppids: { 700: 1 } });
      expect(terminalWindowAlive(`${TERM}/vte-spawn-0d0d-4b4b.scope`, new Set(), fs)).toBeNull();
    });

    it('unknown when the scope has no readable pids', () => {
      const fs = box({
        children,
        ppids: { 600: SERVER },
        unreadableScopes: ['vte-spawn-0d0d-4b4b.scope'],
      });
      const app = readTerminalAppPids(TERM, fs);
      expect(terminalWindowAlive(`${TERM}/vte-spawn-0d0d-4b4b.scope`, app, fs)).toBeNull();
    });

    it('unknown when the scope is empty', () => {
      const fs = box({
        children: { ...children, 'vte-spawn-0d0d-4b4b.scope': [] },
        ppids: { 600: SERVER },
      });
      const app = readTerminalAppPids(TERM, fs);
      expect(terminalWindowAlive(`${TERM}/vte-spawn-0d0d-4b4b.scope`, app, fs)).toBeNull();
    });

    it('unknown when no /proc entry could be parsed — an unreadable window is not a dead one', () => {
      // Every pid present in cgroup.procs but every stat read failing (a race, a
      // permission change). Returning `false` here would be the worst case: a
      // confident dead verdict produced entirely by our own read failure.
      const fs = box({ children, ppids: { 600: SERVER } });
      const app = readTerminalAppPids(TERM, fs);
      expect(terminalWindowAlive(`${TERM}/vte-spawn-0d0d-4b4b.scope`, app, fs)).toBeNull();
    });

    it('unknown when stat is malformed rather than absent', () => {
      const fs = box({ children, ppids: { 600: SERVER } });
      const base = fs.readFile.bind(fs);
      const broken: CgroupFs = {
        ...fs,
        readFile: (p) => (p === '/proc/700/stat' || p === '/proc/701/stat' ? 'garbage' : base(p)),
      };
      const app = readTerminalAppPids(TERM, broken);
      expect(terminalWindowAlive(`${TERM}/vte-spawn-0d0d-4b4b.scope`, app, broken)).toBeNull();
    });
  });

  it('reads ppid correctly when comm contains spaces and parens', () => {
    // The reason this uses the shared lastIndexOf(')') parser: a naive field split
    // would read the wrong number here and invent a parent.
    const fs = box({ children, ppids: {} });
    const withComm: CgroupFs = {
      ...fs,
      readFile: (p) =>
        p === `${TERM}/vte-spawn-0e0e-4a4a.scope/cgroup.procs`
          ? '600'
          : p === '/proc/600/stat'
            ? `600 (bash (x) y) S ${SERVER} 1 1 0 -1 0 0 0 0 0 1 2 0 0 20 0 1 0 1 0 0`
            : fs.readFile(p),
    };
    expect(terminalWindowAlive(`${TERM}/vte-spawn-0e0e-4a4a.scope`, new Set([SERVER]), withComm)).toBe(
      true,
    );
  });
});
