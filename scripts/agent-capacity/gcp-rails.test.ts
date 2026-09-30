import { describe, expect, it } from 'vitest';
import {
  admitCreate,
  buildCreateArgs,
  committedWorstCaseCents,
  hourlyPriceUsd,
  LABEL_MAXCOST,
  LABEL_RUN,
  MAX_CONCURRENT_WORST_CASE_USD,
  parseMachineType,
  PLAN_SLUG,
  readCensus,
  teardownRun,
  TEST_PROJECT,
  worstCaseCents,
  type Census,
  type Exec,
} from './gcp-rails';

const spec = { runId: 'cal-1', name: 'cap-cal-1', machineType: 'e2-standard-4', maxHours: 4 };

function flagValue(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

describe('buildCreateArgs', () => {
  it('applies every rail: test project, self-delete timer, labels', () => {
    const args = buildCreateArgs(spec);
    expect(flagValue(args, 'project')).toBe(TEST_PROJECT);
    expect(flagValue(args, 'max-run-duration')).toBe('240m');
    expect(flagValue(args, 'instance-termination-action')).toBe('DELETE');
    expect(args).toContain('--boot-disk-auto-delete');
    const labels = Object.fromEntries(flagValue(args, 'labels')!.split(',').map((kv) => kv.split('=')));
    expect(labels).toMatchObject({
      'papercusp-plan': PLAN_SLUG,
      'papercusp-ephemeral': 'true',
      [LABEL_RUN]: 'cal-1',
      [LABEL_MAXCOST]: String(worstCaseCents('e2-standard-4', 4)),
    });
  });

  it('refuses a VM without a self-delete timer or with one past the ceiling', () => {
    expect(() => buildCreateArgs({ ...spec, maxHours: 0 })).toThrow(/self-delete/);
    expect(() => buildCreateArgs({ ...spec, maxHours: Number.NaN })).toThrow(/self-delete/);
    expect(() => buildCreateArgs({ ...spec, maxHours: 13 })).toThrow(/ceiling/);
  });

  it('refuses any project but the dedicated test project', () => {
    expect(() => buildCreateArgs({ ...spec, project: 'active-alcove-504205-q3' })).toThrow(/only in pc-agent-capacity-0930/);
  });

  it('refuses a run id that is not a valid label value, so the sweep can always find it', () => {
    expect(() => buildCreateArgs({ ...spec, runId: 'Cal 1' })).toThrow(/label papercusp-run/);
  });

  it('lets caller labels through but never lets them override a rail label', () => {
    const args = buildCreateArgs({ ...spec, extraLabels: { 'papercusp-run': 'evil', scenario: 's7' } });
    const labels = Object.fromEntries(flagValue(args, 'labels')!.split(',').map((kv) => kv.split('=')));
    expect(labels[LABEL_RUN]).toBe('cal-1');
    expect(labels.scenario).toBe('s7');
  });
});

describe('pricing', () => {
  it('derives shapes for predefined and custom machine types', () => {
    expect(parseMachineType('e2-standard-4')).toEqual({ family: 'e2', vcpus: 4, ramGb: 16 });
    expect(parseMachineType('e2-highmem-8')).toEqual({ family: 'e2', vcpus: 8, ramGb: 64 });
    expect(parseMachineType('e2-custom-4-32768')).toEqual({ family: 'e2', vcpus: 4, ramGb: 32 });
    expect(() => parseMachineType('a3-megagpu-8g')).toThrow(/unpriced/);
  });

  it('prices e2-standard-4 at the catalog rate (4 x core + 16 GB x ram + disk)', () => {
    const expected = 4 * 0.02181159 + 16 * 0.00292353 + (50 * 0.1) / 730;
    expect(hourlyPriceUsd('e2-standard-4')).toBeCloseTo(expected, 8);
    expect(worstCaseCents('e2-standard-4', 4)).toBe(Math.ceil(expected * 4 * 100));
  });
});

function census(instances: Census['instances'], orphanDisks: Census['orphanDisks'] = []): Census {
  return { instances, orphanDisks, staticAddresses: [], buckets: [] };
}

describe('admission', () => {
  it('admits a create inside the concurrent worst-case ceiling', () => {
    const verdict = admitCreate(spec, census([]));
    expect(verdict.admitted).toBe(true);
  });

  it('refuses a create whose worst case would exceed the ceiling with live VMs counted', () => {
    const ceiling = MAX_CONCURRENT_WORST_CASE_USD * 100;
    const live = census([{ name: 'a', zone: 'us-central1-a', status: 'RUNNING', runId: 'x', maxCostCents: ceiling - 10 }]);
    const verdict = admitCreate(spec, live);
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toMatch(/exceeds/);
  });

  it('does not count stopped (TERMINATED) VMs as committed compute', () => {
    const c = census([
      { name: 'a', zone: 'z', status: 'TERMINATED', runId: 'x', maxCostCents: 9999 },
      { name: 'b', zone: 'z', status: 'RUNNING', runId: 'x', maxCostCents: 100 },
    ]);
    expect(committedWorstCaseCents(c)).toBe(100);
  });
});

/**
 * A fake gcloud holding a mutable project inventory, recording every call. `lingerReads` keeps a
 * deleted VM listed (as STOPPING) for that many instance-list reads, the way GCP does.
 */
function fakeGcloud(
  initial: { instances: Array<Record<string, unknown>>; disks: Array<Record<string, unknown>> },
  opts: { deleteSticks?: boolean; lingerReads?: number } = {},
) {
  const state = { instances: [...initial.instances], disks: [...initial.disks] };
  const calls: string[][] = [];
  let pendingGone: string[] = [];
  let lingerLeft = 0;
  const exec: Exec = async (argv) => {
    calls.push([...argv]);
    const [, kind, verb] = argv;
    if (verb === 'list') {
      if (kind === 'instances' && pendingGone.length) {
        if (lingerLeft > 0) {
          lingerLeft -= 1;
          state.instances = state.instances.map((i) => (pendingGone.includes(String(i.name)) ? { ...i, status: 'STOPPING' } : i));
        } else {
          state.instances = state.instances.filter((i) => !pendingGone.includes(String(i.name)));
          state.disks = state.disks.filter((d) => !pendingGone.includes(String(d.name)));
          pendingGone = [];
        }
      }
      const rows = kind === 'instances' ? state.instances : kind === 'disks' ? state.disks : [];
      return { code: 0, stdout: JSON.stringify(rows), stderr: '' };
    }
    if (kind === 'instances' && verb === 'delete') {
      const names = argv.slice(3).filter((a) => !a.startsWith('--'));
      if (!opts.deleteSticks) {
        pendingGone = [...pendingGone, ...names];
        lingerLeft = opts.lingerReads ?? 0;
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
  };
  return { exec, calls, state };
}

const zoneUrl = (z: string) => `https://www.googleapis.com/compute/v1/projects/${TEST_PROJECT}/zones/${z}`;
const vm = (name: string, run: string, zone = 'us-central1-a') => ({
  name,
  zone: zoneUrl(zone),
  status: 'RUNNING',
  labels: { [LABEL_RUN]: run, [LABEL_MAXCOST]: '60' },
});
const bootDisk = (name: string, zone = 'us-central1-a') => ({ name, zone: zoneUrl(zone), users: [`.../instances/${name}`] });

describe('teardownRun', () => {
  it('deletes only the run, per zone, and verifies with a fresh census', async () => {
    const g = fakeGcloud({
      instances: [vm('r1-a', 'r1'), vm('r1-b', 'r1', 'us-central1-b'), vm('other', 'r2')],
      disks: [bootDisk('r1-a'), bootDisk('r1-b', 'us-central1-b'), bootDisk('other')],
    });
    const result = await teardownRun('r1', g.exec);
    expect(result.verified).toBe(true);
    expect(result.deleted.sort()).toEqual(['r1-a', 'r1-b']);
    const deletes = g.calls.filter((c) => c[2] === 'delete');
    expect(deletes).toHaveLength(2);
    expect(deletes.every((c) => c.includes(`--project=${TEST_PROJECT}`))).toBe(true);
    expect(g.state.instances.map((i) => i.name)).toEqual(['other']);
  });

  const fastConverge = () => {
    const sleeps: number[] = [];
    return { sleeps, opts: { deadlineMs: 50, intervalMs: 10, sleep: async (ms: number) => void sleeps.push(ms) } };
  };

  it('waits out a VM that GCP still lists as STOPPING after the delete, then verifies', async () => {
    const g = fakeGcloud({ instances: [vm('r1-a', 'r1')], disks: [bootDisk('r1-a')] }, { lingerReads: 2 });
    const c = fastConverge();
    const result = await teardownRun('r1', g.exec, c.opts);
    expect(result.verified).toBe(true);
    expect(c.sleeps).toHaveLength(2);
  });

  it('is NOT verified when the instance is still listed at the deadline', async () => {
    const g = fakeGcloud({ instances: [vm('r1-a', 'r1')], disks: [bootDisk('r1-a')] }, { deleteSticks: true });
    const c = fastConverge();
    const result = await teardownRun('r1', g.exec, c.opts);
    expect(result.verified).toBe(false);
    expect(result.remainingInstances).toEqual(['r1-a']);
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBe(50);
  });

  it('is NOT verified while an orphaned disk remains anywhere in the project', async () => {
    const g = fakeGcloud({ instances: [vm('r1-a', 'r1')], disks: [bootDisk('r1-a'), { name: 'leaked', zone: zoneUrl('us-central1-a'), users: [] }] });
    const result = await teardownRun('r1', g.exec, fastConverge().opts);
    expect(result.verified).toBe(false);
    expect(result.orphanDisks).toEqual(['leaked']);
  });

  it('lists the project storage buckets in the census, without letting them block a run teardown', async () => {
    const g = fakeGcloud({ instances: [vm('r1-a', 'r1')], disks: [bootDisk('r1-a')] });
    const exec: Exec = async (argv) =>
      argv[0] === 'storage'
        ? { code: 0, stdout: JSON.stringify([{ name: 'pc-agent-capacity-0930-artifacts', labels: {} }]), stderr: '' }
        : g.exec(argv);
    expect((await readCensus(exec)).buckets).toEqual(['pc-agent-capacity-0930-artifacts']);
    const result = await teardownRun('r1', exec, fastConverge().opts);
    expect(result.verified).toBe(true);
    expect(result.deleted).toEqual(['r1-a']);
  });

  it('throws instead of reporting an empty census when a list call fails', async () => {
    const exec: Exec = async () => ({ code: 1, stdout: '', stderr: 'permission denied' });
    await expect(readCensus(exec)).rejects.toThrow(/permission denied/);
  });
});
