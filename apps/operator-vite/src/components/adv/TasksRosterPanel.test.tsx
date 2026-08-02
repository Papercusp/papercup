// @vitest-environment jsdom
/**
 * TasksRosterPanel coverage (WI-6844).
 *
 * The panel's job is to make "every Papercusp process is visible here" TRUE while
 * keeping "we know who started this" HONEST — two claims that pull against each
 * other, because the ledger only knows what a chokepoint enrolled. So the cases
 * that matter are the ones about the SEAM between its two row sources:
 *
 *   - a scanned-but-unenrolled process is SHOWN (WI-6475's whole point: the pane
 *     once rendered an empty table beside "400 process(es) scanned"),
 *   - and shown SEPARATELY, never merged into the ledger group, because merging
 *     would imply provenance those rows do not have.
 *
 * Plus the pure projections, which is where the arithmetic actually lives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  payload: null as unknown,
  lastArgs: undefined as unknown,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { args?: unknown }) => {
    H.lastArgs = opts.args;
    return { data: H.payload == null ? undefined : [H.payload] };
  },
}));

const nuqs = vi.hoisted(() => ({ q: null as string | null, set: vi.fn() }));
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: () => [nuqs.q, nuqs.set],
  parseAsString: {},
}));

import TasksRosterPanel, {
  fmtAge,
  fmtBytes,
  groupByClass,
  shortCmd,
  unaccountedGroups,
} from './TasksRosterPanel';

type Row = Parameters<typeof groupByClass>[0][number];

const row = (over: Partial<Row> = {}): Row => ({
  taskId: 't1',
  parentTaskId: null,
  rootTaskId: 't1',
  class: 'agent-session',
  title: 'su-bb5d5',
  state: 'running',
  launchedBy: 'capability:launch-agent',
  workItemId: 'WI-6844',
  planSlug: null,
  startedAt: new Date().toISOString(),
  endedAt: null,
  confined: true,
  scopeUnit: 'pc-t1--su.scope',
  rssBytes: 842 * 1024 * 1024,
  peakRssBytes: null,
  cpuUsec: null,
  pids: 4,
  memoryMaxBytes: null,
  deadlineAt: null,
  exitCode: null,
  exitReason: null,
  logPath: null,
  ...over,
} as Row);

const payload = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  summary: { total: 2, byState: { running: 2 }, byClass: {} },
  live: { scan: { processes: 400, ownedTruncated: false, foreignTruncated: false }, stranded: 0 },
  rows: [row(), row({ taskId: 't2', class: 'bash-job', title: 'bash-4f2a' })],
  liveProcesses: [],
  ...over,
});

beforeEach(() => {
  H.payload = payload();
  H.lastArgs = undefined;
  nuqs.q = null;
  nuqs.set = vi.fn();
});
afterEach(() => cleanup());

describe('pure projections', () => {
  it('fmtBytes scales and keeps 3 significant figures', () => {
    expect(fmtBytes(null)).toBe('—');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(842 * 1024 * 1024)).toBe('842 MB');
    expect(fmtBytes(2.4 * 1024 ** 3)).toBe('2.4 GB');
  });

  it('fmtAge compacts to the largest whole unit', () => {
    const now = Date.parse('2026-08-02T12:00:00Z');
    expect(fmtAge(null, now)).toBe('—');
    expect(fmtAge('2026-08-02T11:59:56Z', now)).toBe('4s');
    expect(fmtAge('2026-08-02T11:48:00Z', now)).toBe('12m');
    expect(fmtAge('2026-08-02T06:00:00Z', now)).toBe('6h');
    expect(fmtAge('2026-07-30T12:00:00Z', now)).toBe('3d');
  });

  it('shortCmd strips the interpreter and the path', () => {
    expect(shortCmd('node /a/b/hono-host.ts --port 3070')).toBe('hono-host.ts');
    expect(shortCmd('npx tsx /x/deploy-cli.ts')).toBe('deploy-cli.ts');
    expect(shortCmd(null)).toBe('—');
  });

  /**
   * Owner-reported 2026-08-02: "why am i seeing so many tasks like this — `-lc` pid
   * 1623888". The old implementation skipped interpreter NAMES but not FLAGS, so the
   * first surviving token was the flag. Against the live scan that hit 321 of 647 rows
   * (`-lc` ×188, `--require` ×65, `-c` ×55, `exec` ×48) — just under half the pane.
   *
   * Each case below is a VERBATIM shape from that scan, not an invented one.
   */
  describe('shortCmd never renders a bare flag as the command name', () => {
    it('picks the real script past a value-consuming flag, not the loader shim', () => {
      // `--require <loader>` swallows its value; skipping only the flag promotes the
      // shim. The tsx loader also lives under node_modules — it is never the job.
      // Path prefixes are generic on purpose: the shape (node_modules shim vs real
      // entry) is what is under test, and a hardcoded home path in shipped source
      // reds the green-checkpoint identity-lint leg for the whole fleet.
      const cmd =
        '/opt/node/bin/node --require ' +
        '/repo/node_modules/tsx/dist/loader.mjs ' +
        '/repo/apps/operator/bin/spawner-sidecar.ts';
      expect(shortCmd(cmd)).toBe('spawner-sidecar.ts');
    });

    it('sees past a leading node flag that takes no value', () => {
      const cmd =
        '/usr/bin/node --experimental-import-meta-resolve --require /x/node_modules/tsx/dist/loader.mjs /srv/real-entry.ts';
      expect(shortCmd(cmd)).toBe('real-entry.ts');
    });

    it('skips the `exec` builtin in an npm exec chain', () => {
      expect(shortCmd('npm exec tsx /a/b/spawner-sidecar.ts')).toBe('spawner-sidecar.ts');
    });

    it('reaches into a shell -c body for the script being run', () => {
      expect(shortCmd('sh -c "tsx" /a/b/spawner-sidecar.ts')).toBe('spawner-sidecar.ts');
      expect(shortCmd('/bin/bash -c source /state/.papercusp/shell-snapshots/snapshot-bash-123.sh 2>/dev/null || true')).toBe(
        'snapshot-bash-123.sh',
      );
    });

    it('falls back to an HONEST shell shape when the body is truncated away', () => {
      // /proc/<pid>/cmdline is captured truncated at 300 chars, so for these EI-9748
      // SIGTERM-trap wrappers the real command is genuinely absent from the string.
      // The correct answer is a vague-but-true label, never a confident wrong one and
      // never the flag. This was the single largest bad group (188 rows).
      const truncated = "/usr/bin/bash -lc trap 'echo \"[EI-9748] SIGTERM received at $(date -u +%FT%TZ) — on this host";
      expect(shortCmd(truncated)).toBe('bash -lc');
      expect(shortCmd(truncated)).not.toMatch(/^-/);
    });

    it('never returns a token beginning with a dash, across every observed shape', () => {
      const observed = [
        "/usr/bin/bash -lc trap 'echo hi'",
        '/bin/bash -c source /x/snapshot-bash-1.sh 2>/dev/null || true && shopt -u extglob',
        '/usr/bin/node --require /x/node_modules/tsx/dist/loader.mjs /y/z.ts',
        '/usr/bin/node --experimental-import-meta-resolve /y/z.ts',
        'npm exec tsx /y/z.ts',
        'sh -c "tsx" /y/z.ts',
        'node',
        '/usr/bin/bash -lc',
      ];
      for (const c of observed) {
        const label = shortCmd(c);
        expect(label.startsWith('-'), `${c} → ${label}`).toBe(false);
        expect(label.length, `${c} → empty label`).toBeGreaterThan(0);
      }
    });

    it('still handles a bare interpreter and an env-prefixed command', () => {
      expect(shortCmd('node')).toBe('node');
      expect(shortCmd('/usr/bin/env NODE_ENV=production node /a/server.js')).toBe('server.js');
    });
  });

  it('unaccountedGroups tolerates the scan reporting a COUNT instead of groups', () => {
    // `unaccounted` is typed `number | groups[]` upstream — reading a number as an
    // array is how a "2 unaccounted" alarm would silently render as none.
    expect(unaccountedGroups({ unaccounted: 3 })).toEqual([]);
    expect(unaccountedGroups({ unaccounted: [{ cgroupPath: '/x', pids: [1], sample: 's' }] })).toHaveLength(1);
    expect(unaccountedGroups(null)).toEqual([]);
  });

  it('groupByClass orders biggest group first, then alphabetically', () => {
    const got = groupByClass([
      row({ class: 'bash-job' }),
      row({ class: 'agent-session' }),
      row({ class: 'agent-session' }),
      row({ class: 'routine' }),
    ]);
    expect(got.map((g) => `${g.cls}:${g.rows.length}`)).toEqual([
      'agent-session:2',
      'bash-job:1',
      'routine:1',
    ]);
  });
});

describe('<TasksRosterPanel>', () => {
  it('requests the live scan when active, and not when inactive', () => {
    render(<TasksRosterPanel active={false} />);
    expect(H.lastArgs).toEqual({});
    cleanup();
    render(<TasksRosterPanel active />);
    expect(H.lastArgs).toEqual({ live: true });
  });

  it('reports Enrolled and Scanned as two separate numbers', () => {
    // The ledger undercounts real processes until every seam enrols (P-009), so
    // collapsing these into one figure would present a known undercount as a total.
    render(<TasksRosterPanel active />);
    const text = screen.getByTestId('tasks-roster').textContent ?? '';
    expect(text).toContain('Enrolled');
    expect(text).toContain('Scanned');
    expect(text).toContain('400');
  });

  it('SHOWS a scanned process that no chokepoint enrolled', () => {
    H.payload = payload({
      liveProcesses: [
        { pid: 41208, cmdline: 'node /x/papercup-bg-host.ts', cgroupPath: '/sys/fs/cgroup/x', owned: false },
      ],
    });
    render(<TasksRosterPanel active />);
    expect(screen.getByTestId('task-scanned-41208')).toBeTruthy();
    // The row carries no `scope`, so splitUnowned's absent-discriminant rule puts
    // it in the `unaccounted` group (over-report rather than silently exempt).
    expect(screen.getByTestId('tasks-roster').textContent).toContain('unaccounted');
  });

  it('keeps unenrolled rows OUT of the ledger groups', () => {
    H.payload = payload({
      liveProcesses: [
        { pid: 41208, cmdline: 'node /x/bg.ts', cgroupPath: '/c', owned: false },
        { pid: 41209, cmdline: 'node /x/enrolled.ts', cgroupPath: '/c', owned: true },
      ],
    });
    render(<TasksRosterPanel active />);
    // owned:true is already represented by its ledger row — listing it again in the
    // unenrolled group would double-count it and invent a gap that is not there.
    expect(screen.queryByTestId('task-scanned-41209')).toBeNull();
    expect(screen.getByTestId('task-scanned-41208')).toBeTruthy();
  });

  it('raises the unaccounted alarm only when the scan reports groups', () => {
    render(<TasksRosterPanel active />);
    expect(screen.queryByTestId('tasks-unaccounted')).toBeNull();

    cleanup();
    H.payload = payload({
      live: { scan: { processes: 400 }, unaccounted: [{ cgroupPath: '/x', pids: [9], sample: 's' }] },
    });
    render(<TasksRosterPanel active />);
    expect(screen.getByTestId('tasks-unaccounted').textContent).toContain('1 unaccounted cgroup');
  });

  it('surfaces a degraded scan rather than silently showing a stale ledger', () => {
    H.payload = payload({ live: { degraded: true, degradedReason: 'budget exhausted' } });
    render(<TasksRosterPanel active />);
    expect(screen.getByTestId('tasks-degraded').textContent).toContain('budget exhausted');
  });

  it('warns when the scan was capped, so an absent process is not read as absent', () => {
    H.payload = payload({
      live: { scan: { processes: 400, ownedTruncated: true, foreignTruncated: false } },
    });
    render(<TasksRosterPanel active />);
    expect(screen.getByTestId('tasks-roster').textContent).toContain('Scan capped');
  });
});
