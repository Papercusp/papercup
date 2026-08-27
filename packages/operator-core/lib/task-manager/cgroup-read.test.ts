import { describe, it, expect } from 'vitest';
import {
  parseProcCgroup,
  parseCgroupProcs,
  parseCgroupInt,
  parseCgroupPidsEventsMax,
  parseCpuStatUsageUsec,
  parseProcCmdline,
  sampleCgroup,
  walkCgroupTree,
  absCgroupDir,
  relCgroupPath,
  type CgroupFs,
} from './cgroup-read';

/** An in-memory /sys + /proc. */
function fakeFs(files: Record<string, string>, dirs: string[] = []): CgroupFs {
  const dirSet = new Set(dirs);
  for (const f of Object.keys(files)) dirSet.add(f.slice(0, f.lastIndexOf('/')));
  return {
    readFile: (p) => files[p] ?? null,
    isDir: (p) => dirSet.has(p),
    readDir: (p) => {
      const children = new Set<string>();
      for (const d of dirSet) {
        if (d.startsWith(`${p}/`)) {
          const rest = d.slice(p.length + 1);
          children.add(rest.split('/')[0]!);
        }
      }
      return [...children];
    },
  };
}

describe('parseProcCgroup', () => {
  it('extracts the unified v2 path', () => {
    expect(
      parseProcCgroup('0::/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-abc.scope\n'),
    ).toBe('/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-abc.scope');
  });

  it('returns null on a v1/hybrid host rather than guessing', () => {
    // Accepting a v1 controller path as if it were unified would make the
    // ownership test answer confidently and WRONGLY.
    const v1 = ['12:memory:/user.slice', '11:cpu,cpuacct:/user.slice', '1:name=systemd:/user.slice'].join('\n');
    expect(parseProcCgroup(v1)).toBeNull();
  });

  it('ignores malformed lines', () => {
    expect(parseProcCgroup('garbage\n\n0::/ok')).toBe('/ok');
    expect(parseProcCgroup('0::relative-no-slash')).toBeNull();
  });
});

describe('parseCgroupProcs', () => {
  it('parses pids and tolerates a trailing newline', () => {
    expect(parseCgroupProcs('12\n34\n56\n')).toEqual([12, 34, 56]);
  });

  it('treats an emptied scope as an empty list, not an error', () => {
    expect(parseCgroupProcs('')).toEqual([]);
    expect(parseCgroupProcs('\n\n')).toEqual([]);
  });

  it('drops non-pid noise', () => {
    expect(parseCgroupProcs('12\nnope\n-4\n0\n9')).toEqual([12, 9]);
  });
});

describe('parseCgroupInt', () => {
  it('parses a plain integer', () => {
    expect(parseCgroupInt('1048576\n')).toBe(1048576);
  });

  it('returns null — never 0 — for absent/unlimited/garbage', () => {
    // A fabricated 0 reads as a real measurement in a pane whose entire job is
    // telling you what is eating the box. Unknown must stay unknown.
    expect(parseCgroupInt(null)).toBeNull();
    expect(parseCgroupInt('')).toBeNull();
    expect(parseCgroupInt('max')).toBeNull();
    expect(parseCgroupInt('not-a-number')).toBeNull();
  });

  it('still parses a genuine zero', () => {
    expect(parseCgroupInt('0')).toBe(0);
  });
});

describe('parseCpuStatUsageUsec', () => {
  it('finds usage_usec among other fields', () => {
    expect(parseCpuStatUsageUsec('usage_usec 123456\nuser_usec 100\nsystem_usec 200\n')).toBe(123456);
  });

  it('tolerates field order and extra fields a newer kernel adds', () => {
    expect(parseCpuStatUsageUsec('nr_periods 0\nusage_usec 42\nnr_throttled 0\n')).toBe(42);
  });

  it('returns null when the field is absent', () => {
    expect(parseCpuStatUsageUsec('user_usec 100\n')).toBeNull();
    expect(parseCpuStatUsageUsec(null)).toBeNull();
  });
});

describe('parseCgroupPidsEventsMax', () => {
  it('reads the cumulative max counter among the other pids events', () => {
    expect(parseCgroupPidsEventsMax('max 17\n')).toBe(17);
    expect(parseCgroupPidsEventsMax('max 0\n')).toBe(0);
  });

  it('returns null for an unavailable, malformed, or unsafe counter', () => {
    expect(parseCgroupPidsEventsMax(null)).toBeNull();
    expect(parseCgroupPidsEventsMax('')).toBeNull();
    expect(parseCgroupPidsEventsMax('oom 2\n')).toBeNull();
    expect(parseCgroupPidsEventsMax('max nope\n')).toBeNull();
    expect(parseCgroupPidsEventsMax('max -1\n')).toBeNull();
    expect(parseCgroupPidsEventsMax(`max ${Number.MAX_SAFE_INTEGER + 1}\n`)).toBeNull();
  });
});

describe('parseProcCmdline', () => {
  it('joins NUL-separated args without a phantom trailing empty', () => {
    expect(parseProcCmdline('node\0vitest\0run\0')).toBe('node vitest run');
  });

  it('is empty for a kernel thread with no cmdline', () => {
    expect(parseProcCmdline('')).toBe('');
    expect(parseProcCmdline(null)).toBe('');
  });
});

describe('sampleCgroup', () => {
  it('samples all four fields', () => {
    const fs = fakeFs({
      '/cg/memory.current': '2048',
      '/cg/memory.peak': '4096',
      '/cg/cpu.stat': 'usage_usec 900\n',
      '/cg/pids.current': '7',
      '/cg/pids.events': 'max 11\n',
    });
    expect(sampleCgroup('/cg', fs)).toEqual({
      memoryBytes: 2048,
      peakMemoryBytes: 4096,
      cpuUsec: 900,
      pidsCurrent: 7,
      pidsEventsMax: 11,
    });
  });

  it('degrades each field independently on an older kernel', () => {
    // memory.peak does not exist before 5.19 — that must not null out the fields
    // that DO exist, and must not become a 0.
    const fs = fakeFs({ '/cg/memory.current': '2048', '/cg/pids.current': '1' });
    expect(sampleCgroup('/cg', fs)).toEqual({
      memoryBytes: 2048,
      peakMemoryBytes: null,
      cpuUsec: null,
      pidsCurrent: 1,
      pidsEventsMax: null,
    });
  });
});

describe('walkCgroupTree', () => {
  it('finds every directory holding processes, at any depth', () => {
    const fs = fakeFs(
      {
        '/root/cgroup.procs': '',
        '/root/a/cgroup.procs': '10\n11\n',
        '/root/a/b/cgroup.procs': '20\n',
        '/root/c/cgroup.procs': '30\n',
      },
      ['/root', '/root/a', '/root/a/b', '/root/c'],
    );
    const found = walkCgroupTree('/root', fs);
    expect(found.map((f) => f.absDir).sort()).toEqual(['/root/a', '/root/a/b', '/root/c']);
    expect(found.find((f) => f.absDir === '/root/a')!.pids).toEqual([10, 11]);
  });

  it('omits empty cgroups — an emptied scope is not a running task', () => {
    const fs = fakeFs({ '/root/cgroup.procs': '', '/root/x/cgroup.procs': '' }, ['/root', '/root/x']);
    expect(walkCgroupTree('/root', fs)).toEqual([]);
  });

  it('is depth-bounded so a pathological tree cannot hang the 30s reconciler', () => {
    const files: Record<string, string> = {};
    const dirs: string[] = [];
    let path = '/root';
    for (let i = 0; i < 100; i++) {
      dirs.push(path);
      files[`${path}/cgroup.procs`] = `${i + 1}\n`;
      path = `${path}/d`;
    }
    const fs = fakeFs(files, dirs);
    const found = walkCgroupTree('/root', fs, 5);
    expect(found.length).toBeLessThanOrEqual(6);
  });
});

describe('path helpers', () => {
  it('round-trips absolute <-> kernel-relative', () => {
    const rel = '/user.slice/papercusp.slice/pc-abc.scope';
    const abs = absCgroupDir(rel, '/sys/fs/cgroup');
    expect(abs).toBe('/sys/fs/cgroup/user.slice/papercusp.slice/pc-abc.scope');
    expect(relCgroupPath(abs, '/sys/fs/cgroup')).toBe(rel);
  });

  it('maps the root to "/" rather than an empty string', () => {
    expect(relCgroupPath('/sys/fs/cgroup', '/sys/fs/cgroup')).toBe('/');
  });
});
