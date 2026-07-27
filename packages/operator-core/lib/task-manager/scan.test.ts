import { describe, it, expect } from 'vitest';
import { scanProcesses, deriveUserManagerRoot, defaultForeignSignature } from './scan';
import type { CgroupFs } from './cgroup-read';

const ROOT = '/sys/fs/cgroup';
const MGR = '/user.slice/user-1000.slice/user@1000.service';
const OURS = `${MGR}/papercusp.slice`;

/** Build a fake /sys + /proc for one scan. */
function box(opts: {
  /** kernel-relative cgroup dir -> pids */
  cgroups: Record<string, number[]>;
  cmdlines?: Record<number, string>;
  selfCgroup?: string;
  bootId?: string | null;
}): CgroupFs {
  const files: Record<string, string> = {};
  const dirs = new Set<string>([ROOT]);

  for (const [rel, pids] of Object.entries(opts.cgroups)) {
    const abs = `${ROOT}${rel}`;
    // register every ancestor directory
    let acc = ROOT;
    for (const seg of rel.split('/').filter(Boolean)) {
      acc = `${acc}/${seg}`;
      dirs.add(acc);
    }
    files[`${abs}/cgroup.procs`] = pids.join('\n');
    for (const pid of pids) {
      files[`/proc/${pid}/cgroup`] = `0::${rel}\n`;
      files[`/proc/${pid}/stat`] = `${pid} (node) S 1 1 1 0 -1 0 0 0 0 0 1 2 0 0 20 0 1 0 ${1000 + pid} 0 0`;
      files[`/proc/${pid}/cmdline`] = (opts.cmdlines?.[pid] ?? `proc-${pid}`).split(' ').join('\0');
    }
  }
  if (opts.bootId !== null) files['/proc/sys/kernel/random/boot_id'] = opts.bootId ?? 'BOOTID';
  files['/proc/999/cgroup'] = `0::${opts.selfCgroup ?? `${MGR}/papercup-dev-api.service`}\n`;

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

describe('deriveUserManagerRoot', () => {
  it('derives the manager root from our own cgroup rather than assuming it', () => {
    expect(deriveUserManagerRoot(`${MGR}/papercup-dev-api.service`)).toBe(MGR);
  });

  it('returns null for a shape it does not recognise — degrade, never guess', () => {
    expect(deriveUserManagerRoot('/system.slice/papercup.service')).toBeNull();
    expect(deriveUserManagerRoot(null)).toBeNull();
  });
});

describe('scanProcesses — the owned pass', () => {
  it('finds every descendant at any depth inside our slice', () => {
    // The inheritance claim, tested: a grandchild that ended up two slices deep
    // is still enumerated by one walk of the root slice.
    const fs = box({
      cgroups: {
        [`${OURS}/papercusp-bash-job.slice/pc-aaa111.scope`]: [10, 11],
        [`${OURS}/papercusp-agent.slice/papercusp-agent-session.slice/pc-bbb222.scope`]: [20],
      },
    });
    const r = scanProcesses({ fs, selfPid: 999 });
    expect(r.ownedRootExists).toBe(true);
    expect(r.processes.map((p) => p.pid).sort((a, b) => a - b)).toEqual([10, 11, 20]);
    expect(r.processes.every((p) => p.owned)).toBe(true);
  });

  it('stamps each process with a kernel identity, not just a pid', () => {
    const fs = box({ cgroups: { [`${OURS}/pc-aaa111.scope`]: [10] } });
    const r = scanProcesses({ fs, selfPid: 999 });
    expect(r.processes[0]!.processIdentity).toBe('linux:BOOTID:1010');
  });

  it('degrades identity to null when boot_id is unreadable, without dropping the row', () => {
    const fs = box({ cgroups: { [`${OURS}/pc-aaa111.scope`]: [10] }, bootId: null });
    const r = scanProcesses({ fs, selfPid: 999 });
    expect(r.processes).toHaveLength(1);
    expect(r.processes[0]!.processIdentity).toBeNull();
  });

  it('reports ownedRootExists:false rather than silently reporting "nothing running"', () => {
    // The difference matters enormously: an empty scan on a misconfigured root
    // would otherwise read as "the box is idle" and strand every live row.
    const fs = box({ cgroups: { [`${MGR}/other.slice`]: [10] } });
    const r = scanProcesses({ fs, selfPid: 999 });
    expect(r.ownedRootExists).toBe(false);
    expect(r.processes).toHaveLength(0);
  });

  it('caps the result and says so', () => {
    const cgroups: Record<string, number[]> = {};
    for (let i = 0; i < 20; i++) cgroups[`${OURS}/pc-s${i}0000.scope`] = [100 + i];
    const r = scanProcesses({ fs: box({ cgroups }), selfPid: 999, maxProcesses: 5 });
    expect(r.processes).toHaveLength(5);
    expect(r.truncated).toBe(true);
  });
});

describe('scanProcesses — the foreign pass', () => {
  it('includes an out-of-slice process ONLY when it matches the signature', () => {
    const fs = box({
      cgroups: {
        [`${OURS}/pc-aaa111.scope`]: [10],
        [`${MGR}/session-3.scope`]: [20, 21],
      },
      cmdlines: {
        20: 'node /srv/ws/papercusp/bin/thing',
        21: 'firefox',
      },
    });
    const r = scanProcesses({
      fs,
      selfPid: 999,
      foreignSignature: defaultForeignSignature('/srv/ws/papercusp'),
    });
    const foreign = r.processes.filter((p) => !p.owned);
    expect(foreign.map((p) => p.pid)).toEqual([20]);
    // firefox is not ours to look at, let alone control.
    expect(r.processes.map((p) => p.pid)).not.toContain(21);
  });

  it('scans nothing foreign when no signature is supplied', () => {
    const fs = box({
      cgroups: { [`${OURS}/pc-aaa111.scope`]: [10], [`${MGR}/session-3.scope`]: [20] },
      cmdlines: { 20: 'node /repo/thing' },
    });
    expect(scanProcesses({ fs, selfPid: 999 }).processes.map((p) => p.pid)).toEqual([10]);
  });

  it('never double-counts a process that is already owned', () => {
    const fs = box({
      cgroups: { [`${OURS}/pc-aaa111.scope`]: [10] },
      cmdlines: { 10: '/repo/thing' },
    });
    const r = scanProcesses({ fs, selfPid: 999, foreignSignature: /repo/ });
    expect(r.processes).toHaveLength(1);
    expect(r.processes[0]!.owned).toBe(true);
  });
});

describe('defaultForeignSignature', () => {
  it('anchors on the repo PATH, not a binary name', () => {
    // Matching a bare binary name is exactly the `pkill -f` mistake: it matches
    // the owner's desktop window and every peer's test instance.
    const sig = defaultForeignSignature('/srv/ws/papercusp');
    expect(sig.test('node /srv/ws/papercusp/bin/dev')).toBe(true);
    expect(sig.test('/usr/bin/papercusp-desktop')).toBe(false);
  });

  it('escapes regex metacharacters in the path', () => {
    // `+` and `.` unescaped would make this signature match paths it must not.
    const sig = defaultForeignSignature('/srv/a+b/c.d');
    expect(sig.test('/srv/a+b/c.d/x')).toBe(true);
    expect(sig.test('/srv/aab/cXd/x')).toBe(false);
  });
});
