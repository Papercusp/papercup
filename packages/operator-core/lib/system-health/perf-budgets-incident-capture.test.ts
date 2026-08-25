/**
 * preserveIncidentCapture — EI-12982's forensic-preservation hook. Filesystem
 * tests (perf-budgets.test.ts stays pure-boundary/no-IO by design), against a
 * real temp dir so the rotation-exemption + bounded-pruning behavior is proven
 * against actual mtimes, not mocked ones.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir, utimes, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { preserveIncidentCapture, selectIncidentFilesToPrune } from './perf-budgets';

const execFileAsync = promisify(execFile);
const CAPTURE_SCRIPT = fileURLToPath(
  new URL('../../../../apps/operator/scripts/perf/capture-signals.py', import.meta.url),
);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perf-incident-capture-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const CAPTURE = JSON.stringify({
  schemaVersion: 'perf-signals-v1',
  capturedAt: '2026-07-16T03:33:00Z',
  hostState: 'wedge-active',
  signals: { operator_3070_reachable: false },
});

describe('preserveIncidentCapture', () => {
  it('returns preserved:false with an empty/missing dir', async () => {
    const out = await preserveIncidentCapture('infra-crit', join(dir, 'does-not-exist'));
    expect(out).toEqual({ preserved: false });
  });

  it('copies the newest non-incident capture into a distinctly-named incident file, leaving the source untouched', async () => {
    await writeFile(join(dir, '2026-07-16T03-30-00-000Z-scheduled.json'), CAPTURE);
    await writeFile(join(dir, '2026-07-16T03-32-00-000Z-scheduled.json'), CAPTURE); // newest

    const out = await preserveIncidentCapture('infra-crit', dir);
    expect(out.preserved).toBe(true);
    expect(out.path).toBeTruthy();
    expect(out.path).toContain('-incident-infra-crit.json');

    const files = await readdir(dir);
    // both originals still present (copy, not move) + exactly one new incident file
    expect(files.filter((f) => f.endsWith('-scheduled.json'))).toHaveLength(2);
    expect(files.filter((f) => f.includes('-incident-'))).toHaveLength(1);
  });

  it('sanitizes an unsafe reason string instead of writing a path-breaking filename', async () => {
    await writeFile(join(dir, 'a-scheduled.json'), CAPTURE);
    const out = await preserveIncidentCapture('weird/../reason with spaces!', dir);
    expect(out.preserved).toBe(true);
    expect(out.path).not.toMatch(/\.\.|\/reason| /);
  });

  it('is idempotent for a repeated edge on the same source capture', async () => {
    await writeFile(join(dir, 'a-scheduled.json'), CAPTURE);
    const first = await preserveIncidentCapture('infra-crit', dir);
    expect(first.preserved).toBe(true);
    const second = await preserveIncidentCapture('infra-crit', dir);
    expect(second).toEqual({ preserved: false });
    expect(first.path).toBe(join(dir, 'a-scheduled-incident-infra-crit.json'));
    const files = await readdir(dir);
    expect(files.filter((f) => f.includes('-incident-'))).toHaveLength(1);
  });

  it('de-duplicates concurrent workers preserving the same source capture', async () => {
    await writeFile(join(dir, 'a-scheduled.json'), CAPTURE);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => preserveIncidentCapture('infra-crit', dir)),
    );
    expect(results.filter((result) => result.preserved)).toHaveLength(1);
    expect(results.filter((result) => !result.preserved)).toHaveLength(7);
    const files = await readdir(dir);
    expect(files.filter((f) => f.includes('-incident-'))).toHaveLength(1);
  });

  // EI-20985533910345265: the old policy pruned to a flat newest-100 file
  // COUNT, which — measured live on a host whose infra panel flaps into
  // `crit` frequently — evicted evidence within HOURS instead of the "days
  // later" root-cause window EI-12982 exists to guarantee. Retention is now
  // AGE-based (a count cap remains only as a defense-in-depth backstop), so
  // these tests prove the age behavior directly instead of re-asserting the
  // count behavior that caused the regression.
  it('keeps MANY more than the old 100-file count when every file is recent (age governs, not count)', async () => {
    await writeFile(join(dir, 'src-scheduled.json'), CAPTURE);
    // Pre-seed 150 incident files — well past the old flat cap — but all
    // within the retention window (a few minutes old).
    const now = Date.now();
    for (let i = 0; i < 150; i++) {
      const p = join(dir, `seed-${i}-incident-old.json`);
      await writeFile(p, CAPTURE);
      const t = new Date(now - (150 - i) * 1000);
      await utimes(p, t, t);
    }
    const out = await preserveIncidentCapture('infra-crit', dir);
    expect(out.preserved).toBe(true);

    const files = await readdir(dir);
    const incidents = files.filter((f) => f.includes('-incident-'));
    // All 150 recent seeds + the 1 just preserved survive — nothing was
    // evicted purely for exceeding the old count.
    expect(incidents).toHaveLength(151);
    expect(incidents).toContain('seed-0-incident-old.json');
    expect(incidents).toContain('seed-149-incident-old.json');
  });

  it('prunes incident files older than the retention window, regardless of count', async () => {
    await writeFile(join(dir, 'src-scheduled.json'), CAPTURE);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const stalePath = join(dir, 'stale-incident-old.json');
    await writeFile(stalePath, CAPTURE);
    await utimes(stalePath, new Date(now - 20 * dayMs), new Date(now - 20 * dayMs)); // well past 14d
    const freshPath = join(dir, 'fresh-incident-old.json');
    await writeFile(freshPath, CAPTURE);
    await utimes(freshPath, new Date(now - 1 * dayMs), new Date(now - 1 * dayMs)); // within 14d

    const out = await preserveIncidentCapture('infra-crit', dir);
    expect(out.preserved).toBe(true);

    const files = await readdir(dir);
    const incidents = files.filter((f) => f.includes('-incident-'));
    expect(incidents).not.toContain('stale-incident-old.json'); // aged out
    expect(incidents).toContain('fresh-incident-old.json'); // within the window
  });
});

describe('selectIncidentFilesToPrune (pure retention policy)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-08-21T00:00:00Z');

  it('keeps everything within the retention window regardless of count', () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({
      path: `f${i}`,
      mtimeMs: now - i * 1000, // all within the last ~8 minutes
    }));
    const toDelete = selectIncidentFilesToPrune(entries, now, { retentionDays: 14, maxFiles: 5000 });
    expect(toDelete).toEqual([]);
  });

  it('prunes everything older than the retention window', () => {
    const entries = [
      { path: 'old', mtimeMs: now - 20 * DAY },
      { path: 'boundary-inside', mtimeMs: now - 13 * DAY },
      { path: 'recent', mtimeMs: now - 1 * DAY },
    ];
    const toDelete = selectIncidentFilesToPrune(entries, now, { retentionDays: 14, maxFiles: 5000 });
    expect(toDelete).toEqual(['old']);
  });

  it('falls back to a count-based safety cap, oldest-first, when age alone leaves too many', () => {
    // 10 files, all within the retention window, but the safety cap is 3.
    const entries = Array.from({ length: 10 }, (_, i) => ({
      path: `f${i}`,
      mtimeMs: now - i * 1000, // f0 newest, f9 oldest
    }));
    const toDelete = selectIncidentFilesToPrune(entries, now, { retentionDays: 14, maxFiles: 3 });
    expect(toDelete.sort()).toEqual(['f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9'].sort());
  });

  it('never mutates the input array', () => {
    const entries = [{ path: 'a', mtimeMs: now - 20 * DAY }];
    const copy = [...entries];
    selectIncidentFilesToPrune(entries, now, { retentionDays: 14, maxFiles: 5000 });
    expect(entries).toEqual(copy);
  });
});

describe('capture-signals cgroup memory attribution', () => {
  async function writeCgroup(
    root: string,
    relative: string,
    memoryBytes: number,
    anonBytes: number,
    swapBytes: number,
  ): Promise<void> {
    const path = join(root, relative);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'memory.current'), `${memoryBytes}\n`);
    await writeFile(
      join(path, 'memory.stat'),
      `anon ${anonBytes}\nfile ${memoryBytes - anonBytes}\nshmem 0\nkernel 10\nslab 5\nsock 1\n`,
    );
    await writeFile(join(path, 'memory.swap.current'), `${swapBytes}\n`);
    await writeFile(join(path, 'cgroup.procs'), '101\n102\n');
  }

  it('records the largest cgroups with memory composition while bounding output rows', async () => {
    const root = join(dir, 'cgroup');
    const procRoot = join(dir, 'proc');
    const workerPath = join(dir, 'worker.mjs');
    await writeCgroup(root, '', 1_000, 600, 30);
    await writeCgroup(root, 'user.slice/app.slice/papercup-dev-api.service', 700, 500, 20);
    await writeCgroup(root, 'system.slice/postgresql.service', 800, 650, 10);
    await mkdir(join(procRoot, '101'), { recursive: true });
    await writeFile(join(procRoot, '101', 'comm'), 'node-MainThread\n');
    await writeFile(
      join(procRoot, '101', 'status'),
      'Name:\tnode-MainThread\nState:\tS (sleeping)\nVmRSS:\t123 kB\nVmSwap:\t456 kB\n',
    );
    await writeFile(workerPath, '// fixture process entrypoint\n');
    await writeFile(
      join(procRoot, '101', 'cmdline'),
      Buffer.from(
        `node --startup-token=also-must-not-survive\0${workerPath}\0` +
          '--api-key=must-not-survive\0free-form-secret\0',
      ),
    );
    // PID 102 is intentionally absent: a process/scope can disappear between
    // reading cgroup.procs and resolving /proc, and the miss must be explicit.

    const code = [
      'import importlib.util,json,sys',
      's=importlib.util.spec_from_file_location("capture_signals",sys.argv[1])',
      'm=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
      'print(json.dumps(m.cgroup_memory(root=sys.argv[2],proc_root=sys.argv[3],budget_sec=10,max_scanned=100,top_n=2)))',
    ].join(';');
    const { stdout } = await execFileAsync('python3', [
      '-c',
      code,
      CAPTURE_SCRIPT,
      root,
      procRoot,
    ]);
    const captured = JSON.parse(stdout);

    expect(captured).toMatchObject({
      accounting: 'cgroup-v2-inclusive-descendants',
      scannedCgroups: 3,
      candidateCgroups: 3,
      maxRows: 2,
      maxProcessesPerCgroup: 8,
      partial: false,
    });
    expect(captured.top).toHaveLength(2);
    expect(captured.top.map((row: { path: string }) => row.path)).toEqual([
      '/',
      '/system.slice/postgresql.service',
    ]);
    expect(captured.top[1]).toMatchObject({
      memoryBytes: 800,
      anonBytes: 650,
      fileBytes: 150,
      swapBytes: 10,
      directPids: 2,
      unresolvedSampledPids: 1,
      directProcessSampleTruncated: false,
    });
    expect(captured.top[1].directProcesses).toEqual([
      {
        pid: 101,
        comm: 'node-MainThread',
        exe: null,
        state: 'S (sleeping)',
        rssBytes: 123 * 1024,
        swapBytes: 456 * 1024,
        argvPreview: ['node', workerPath, '--api-key'],
        argvTruncated: true,
      },
    ]);
    expect(JSON.stringify(captured)).not.toContain('must-not-survive');
    expect(JSON.stringify(captured)).not.toContain('startup-token');
    expect(JSON.stringify(captured)).not.toContain('free-form-secret');
  });

  it('captures bounded two-sample cgroup CPU ownership with direct pid counts', async () => {
    const root = join(dir, 'cgroup-cpu');
    await mkdir(join(root, 'user.slice', 'user@1000.service', 'papercup-vm-win.service'), { recursive: true });
    await writeFile(join(root, 'cgroup.procs'), '101\n');
    await writeFile(
      join(root, 'user.slice', 'user@1000.service', 'papercup-vm-win.service', 'cgroup.procs'),
      '202\n203\n',
    );

    const code = [
      'import importlib.util,json,sys',
      's=importlib.util.spec_from_file_location("capture_signals",sys.argv[1])',
      'm=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
      'root=sys.argv[2]; child=root+"/user.slice/user@1000.service/papercup-vm-win.service"',
      'samples={root:[100,4200],child:[100,300]}',
      'read_usage=lambda path:samples[path].pop(0)',
      'clock=[0]',
      'read=lambda: (clock.__setitem__(0,clock[0]+1) or (0.0 if clock[0] <= 6 else 1.0))',
      'captured=m.cgroup_cpu(root=root,budget_sec=10,max_scanned=10,top_n=2,sample_sec=0,usage_reader=read_usage,monotonic_fn=read,sleep_fn=lambda _:None)',
      'print(json.dumps(captured))',
    ].join(';');
    const { stdout } = await execFileAsync('python3', [
      '-c',
      code,
      CAPTURE_SCRIPT,
      root,
    ]);
    const captured = JSON.parse(stdout);

    expect(captured).toMatchObject({
      accounting: 'cgroup-v2-inclusive-descendants',
      scannedCgroups: 2,
      candidateCgroups: 2,
      maxRows: 2,
      partial: false,
    });
    expect(captured.top[0]).toMatchObject({
      path: '/',
      cpuUsageUsecDelta: 4100,
      cpuPct: 0.4,
      directPids: 1,
    });
    expect(captured.top[1]).toMatchObject({
      path: '/user.slice/user@1000.service/papercup-vm-win.service',
      cpuUsageUsecDelta: 200,
      cpuPct: 0,
      directPids: 2,
    });
  });
});
