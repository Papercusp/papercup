import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fairLspTasksObserved, fairObservedScopeCosts, qualifyFairProcessWitness, type FairProcessWitness } from './fair-process-observer';

const scope = '/user.slice/pc-test.scope';
const expected = { cgroupPath: scope, payloadPid: 20, payloadIdentity: 'linux:boot:20' };
const fixture = (): FairProcessWitness => ({ schemaVersion: 1, scope: 'launch-root-process-descendants', clockTicksPerSecond: 100,
  counters: { writers: 0, version: 8, errors: 0, root_pid: 10, root_start: '100000000',
    current: 1, peak: 3, births: 4, exits: 3, threads: 50, migrations: 2 },
  members: [{ pid: 10, startNs: '100000000' }, { pid: 20, startNs: '200000000' }],
  cgroupPaths: [scope, '/user.slice/pc-lsp123.scope'] });
const qualify = (value: FairProcessWitness) => qualifyFairProcessWitness(value, expected, () => expected.payloadIdentity);

describe('fair process lifetime witness', () => {
  it('preserves fleeting forks, ignores thread births, and keeps a distinct launch root and migrated LSP scope', () => {
    expect(qualify(fixture())).toEqual({ peakChildProcesses: 3, unknown: [] });
  });
  it('refuses event/map faults, concurrent snapshots, missing roots and reset counters', () => {
    for (const patch of [{ errors: 1 }, { writers: 1 }, { root_pid: 0 }, { peak: 0 }, { births: 1 },
      { current: -1 }, { peak: NaN }, { version: Infinity }]) {
      const witness = fixture(); Object.assign(witness.counters, patch);
      expect(qualify(witness).peakChildProcesses, JSON.stringify(patch)).toBeNull();
    }
  });
  it('does not accept a missing/reused payload or a foreign target scope', () => {
    const missing = fixture(); missing.members = missing.members.filter(row => row.pid !== 20);
    expect(qualify(missing).peakChildProcesses).toBeNull();
    expect(qualifyFairProcessWitness(fixture(), expected, () => 'linux:boot:reused').peakChildProcesses).toBeNull();
    const reused = fixture(); reused.members[1].startNs = '300000000';
    expect(qualify(reused).peakChildProcesses).toBeNull();
    const foreign = fixture(); foreign.cgroupPaths = ['/foreign'];
    expect(qualify(foreign).peakChildProcesses).toBeNull();
  });
  it('refuses malformed or duplicate membership instead of certifying an empty population', () => {
    for (const members of [[{ pid: 20, startNs: 'unknown' }], [{ pid: 20, startNs: '1' }, { pid: 20, startNs: '2' }]]) {
      const witness = fixture(); witness.members = members;
      expect(qualify(witness).peakChildProcesses).toBeNull();
    }
    expect(qualify(null as never).peakChildProcesses).toBeNull();
  });
});

describe('separately managed process scope costs', () => {
  it('includes observed nested projects but refuses foreign roots, escaping links and missing task lineage', () => {
    const owned = mkdtempSync(join(tmpdir(), 'fair-lsp-custody-'));
    try {
      const tree = join(owned, 'tree'), project = join(tree, 'packages', 'project'), foreign = join(owned, 'tree-other');
      mkdirSync(project, { recursive: true }); mkdirSync(foreign);
      symlinkSync(foreign, join(tree, 'escaping'));
      const paths = [scope, '/user.slice/pc-lsp123.scope'];
      const tasks = [{ taskId: 'lsp123', rootPath: project }];
      expect(fairLspTasksObserved(tree, tasks, paths, 3)).toBe(true);
      expect(fairLspTasksObserved(tree, [{ ...tasks[0]!, rootPath: tree }], paths, 3)).toBe(true);
      for (const rootPath of [foreign, join(tree, 'escaping'), join(tree, 'missing')])
        expect(fairLspTasksObserved(tree, [{ ...tasks[0]!, rootPath }], paths, 3)).toBe(false);
      expect(fairLspTasksObserved(tree, tasks, [scope], 3)).toBe(false);
      expect(fairLspTasksObserved(tree, tasks, paths, null)).toBe(false);
    } finally { rmSync(owned, { recursive: true, force: true }); }
  });
  const read = (path: string) => ({ memoryBytes: path.includes('pc-lsp') ? 30 : 10,
    peakMemoryBytes: path.includes('pc-lsp') ? 50 : 20, cpuUsec: 1, pidsCurrent: 99, pidsEventsMax: 0 });
  it('includes migrated LSP task memory while leaving thread counters out of process counts', () => {
    const costs = fairObservedScopeCosts([scope, '/user.slice/pc-lsp123.scope'], scope, read);
    expect(costs.memoryCurrentBytes).toBe(40);
    expect(costs.memoryPeakBytes).toBe(70);
    expect(costs.memoryPeakBasis).toBe('sum-of-scope-peaks-upper-bound');
    expect(costs.unknown).toEqual([]);
  });
  it('does not count a nested scope twice', () => {
    expect(fairObservedScopeCosts([scope, `${scope}/pc-nested.scope`, scope], scope, read).memoryPeakBytes).toBe(20);
  });
  it('preserves missing/retired server costs and foreign or unsafe paths as unknown', () => {
    const costs = fairObservedScopeCosts([scope, '/user.slice/pc-lsp123.scope', '/foreign', '/a/../pc-x.scope'], scope,
      path => path.includes('pc-lsp') ? { ...read(path), peakMemoryBytes: null } : read(path));
    expect(costs.memoryPeakBytes).toBeNull();
    expect(costs.unknown).toContain('process-observer-unowned-cost-scope');
    expect(costs.unknown.some(reason => reason.includes('pc-lsp123.scope:peakMemoryBytes'))).toBe(true);
  });
});
