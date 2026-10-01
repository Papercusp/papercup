import { describe, expect, it } from 'vitest';
import {
  DELETE_FIXTURE,
  EDIT_FIXTURE,
  runEngineArm,
  summarizeArm,
  type EngineArm,
  type EngineComparisonDeps,
  type EngineQueryResult,
  type PhaseCost,
} from './engine-comparison';
import {
  parseElapsedMs,
  parseLoadAvg1,
  phaseCostFromTimeLogs,
  withPrecomputedIndex,
} from './engine-comparison-precomputed';
import type { CorpusCase } from './acceptance-corpus';
import { SELECTIVE_ACCEPTANCE_CORPUS } from './selective-corpus';

const ROOT = '/t';
const OK: PhaseCost = { wallMs: 5, peakRssKb: 1000, ok: true, error: null, loadAvg1: 1 };

interface World {
  readonly disk: Map<string, string>;
  readonly baseline: Map<string, string>;
  readonly modes: Map<string, number>;
  readonly deps: EngineComparisonDeps;
}

function makeWorld(): World {
  const disk = new Map<string, string>();
  disk.set(`${ROOT}/${EDIT_FIXTURE.file}`, 'a\nb\n');
  disk.set(`${ROOT}/${DELETE_FIXTURE.file}`, 'consumer\n');
  const baseline = new Map(disk);
  const modes = new Map<string, number>();
  let clock = 0;
  const deps: EngineComparisonDeps = {
    now: () => (clock += 3),
    loadAvg1: () => 1,
    readFile: async (p) => {
      const v = disk.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFile: async (p, c) => void disk.set(p, c),
    rm: async (p) => void disk.delete(p),
    chmod: async (p, m) => void modes.set(p, m),
    gitRestore: async (root, rels) => {
      for (const r of rels) disk.set(`${root}/${r}`, baseline.get(`${root}/${r}`) ?? '');
    },
    treeFingerprint: async () => 'fp-1',
  };
  return { disk, baseline, modes, deps };
}

/**
 * A scripted engine. `live` engines re-read the tree on refresh (so they see edits and
 * deletes); a stale engine snapshots once at index time and never again.
 */
function fakeArm(world: World, opts: { live: boolean; surfaceFault?: boolean }): EngineArm & { refreshes: number } {
  let snapshot = new Map(world.disk);
  const arm = {
    id: opts.live ? 'fake-live' : 'fake-stale',
    version: '0',
    treeRoot: ROOT,
    unavailable: null,
    refreshes: 0,
    async index() {
      snapshot = new Map(world.disk);
      return OK;
    },
    async refresh(): Promise<PhaseCost> {
      arm.refreshes += 1;
      if (opts.surfaceFault && world.modes.get(`${ROOT}/scripts`) === 0) {
        return { ...OK, ok: false, error: 'EACCES scripts' };
      }
      if (opts.live) snapshot = new Map(world.disk);
      return OK;
    },
    async query(kase: CorpusCase): Promise<EngineQueryResult> {
      if (kase.id === 'fixture-edit-new-symbol') {
        const text = snapshot.get(`${ROOT}/${EDIT_FIXTURE.file}`) ?? '';
        const idx = text.split('\n').findIndex((l) => l.includes(`export function ${EDIT_FIXTURE.symbol}`));
        const sites = idx < 0 ? [] : [{ path: EDIT_FIXTURE.file, line1: idx + 1, kind: null, detail: '' }];
        return { sites, responseBytes: 40, error: null };
      }
      const sites = kase.expectedSites
        .filter((s) => s.path !== DELETE_FIXTURE.file || snapshot.has(`${ROOT}/${s.path}`))
        .map((s) => ({ path: s.path, line1: s.line1, kind: null, detail: '' }));
      return { sites, responseBytes: 100, error: null };
    },
    async indexBytes() {
      return 123;
    },
  };
  return arm;
}

const OPTS = { warmSamples: 2, cases: SELECTIVE_ACCEPTANCE_CORPUS };

describe('runEngineArm (fake engines)', () => {
  it('scores a live engine fully correct and passes every update fixture', async () => {
    const world = makeWorld();
    const report = await runEngineArm(fakeArm(world, { live: true }), OPTS, world.deps);
    expect(report.error).toBeNull();
    expect(report.cases.every((c) => c.correct)).toBe(true);
    expect(report.fixtures.map((f) => [f.name, f.pass])).toEqual([
      ['edit', true],
      ['delete', true],
      ['refresh-failure', true],
    ]);
    // the runner must put the tree back: fixtures never leave edits behind
    expect(world.disk.get(`${ROOT}/${EDIT_FIXTURE.file}`)).toBe('a\nb\n');
    expect(world.disk.has(`${ROOT}/${DELETE_FIXTURE.file}`)).toBe(true);
    expect(world.modes.get(`${ROOT}/scripts`)).toBe(0o755);
    const s = summarizeArm(report);
    expect(s.correct).toBe(s.total);
    expect(s.fixturesPassed).toBe(3);
  });

  it('FAILS the edit and delete fixtures for an engine that never refreshes (stale index)', async () => {
    const world = makeWorld();
    const report = await runEngineArm(fakeArm(world, { live: false }), OPTS, world.deps);
    const byName = Object.fromEntries(report.fixtures.map((f) => [f.name, f]));
    expect(byName.edit?.pass).toBe(false);
    expect(byName.delete?.pass).toBe(false);
    expect(byName.delete?.detail).toMatch(/STALE sites still returned/);
  });

  it('records whether a failed refresh was SURFACED, and still restores the tree', async () => {
    const world = makeWorld();
    const report = await runEngineArm(fakeArm(world, { live: true, surfaceFault: true }), OPTS, world.deps);
    const refreshFailure = report.fixtures.find((f) => f.name === 'refresh-failure');
    expect(refreshFailure?.faultSurfaced).toBe(true);
    expect(refreshFailure?.recoveryCost?.ok).toBe(true);
  });

  it('turns an unavailable arm into explicit residue instead of a pass or a crash', async () => {
    const world = makeWorld();
    const arm = { ...fakeArm(world, { live: true }), unavailable: 'binary not built' };
    const report = await runEngineArm(arm, OPTS, world.deps);
    expect(report.unavailable).toBe('binary not built');
    expect(report.cases).toEqual([]);
    expect(summarizeArm(report).available).toBe(false);
  });

  it('reports a failed cold index as an error and measures nothing after it', async () => {
    const world = makeWorld();
    const arm = { ...fakeArm(world, { live: true }), index: async (): Promise<PhaseCost> => ({ ...OK, ok: false, error: 'boom' }) };
    const report = await runEngineArm(arm, OPTS, world.deps);
    expect(report.error).toMatch(/cold index failed: boom/);
    expect(report.cases).toEqual([]);
  });
});

const TIME_V_OK = [
  '\tCommand being timed: "gitnexus analyze"',
  '\tElapsed (wall clock) time (h:mm:ss or m:ss): 14:49.45',
  '\tMaximum resident set size (kbytes): 8354216',
  '\tExit status: 0',
].join('\n');

describe('precomputed cold-index cost', () => {
  it('parses m:ss.ss and h:mm:ss wall clocks', () => {
    expect(parseElapsedMs(TIME_V_OK)).toBe(889450);
    expect(parseElapsedMs('\tElapsed (wall clock) time (h:mm:ss or m:ss): 1:02:03')).toBe(3723000);
    expect(parseElapsedMs('no timing here')).toBeNull();
  });

  it('reads the load average from uptime output and from a load-before line', () => {
    expect(parseLoadAvg1(' 09:34:57 up 1 day,  load average: 95.64, 132.54, 144.20')).toBe(95.64);
    expect(parseLoadAvg1('load-before: 131.65 124.84 128.63 101/54567 196618')).toBe(131.65);
    expect(parseLoadAvg1('nothing')).toBeNull();
  });

  it('turns a clean log into an ok PhaseCost carrying wall, RSS and load', () => {
    const c = phaseCostFromTimeLogs({ timeV: TIME_V_OK, stdout: '', loadAfter: 'load average: 95.64, 1, 1' });
    expect(c).toEqual({ wallMs: 889450, peakRssKb: 8354216, ok: true, error: null, loadAvg1: 95.64 });
  });

  it('REFUSES (ok:false) a nonzero exit and an unfinished log — never a silent pass', () => {
    const failed = phaseCostFromTimeLogs({ timeV: TIME_V_OK.replace('Exit status: 0', 'Exit status: 137'), stdout: 'killed', loadAfter: null });
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/exit 137/);
    const unfinished = phaseCostFromTimeLogs({ timeV: 'GitNexus Analyzer (1.6.12)\nSkipped 2 large files', stdout: '', loadAfter: null });
    expect(unfinished.ok).toBe(false);
    expect(unfinished.error).toMatch(/no Elapsed\/Exit status/);
  });

  it('withPrecomputedIndex re-uses the measured cost and never re-runs the real index', async () => {
    const world = makeWorld();
    let realIndexCalls = 0;
    const base = fakeArm(world, { live: true });
    const arm = withPrecomputedIndex({ ...base, index: async () => { realIndexCalls += 1; return OK; } }, async () => ({ ...OK, wallMs: 889450 }));
    const cost = await arm.index();
    expect(cost.wallMs).toBe(889450);
    expect(realIndexCalls).toBe(0);
    // refresh/query/indexBytes stay live
    expect(await arm.indexBytes()).toBe(123);
  });
});
