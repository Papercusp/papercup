import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import manifest from './harness-leaderboard-manifest.json';

describe('Harness Leaderboard retained source manifest (P-023)', () => {
  it('preserves the complete reviewed source witness byte for byte', () => {
    const bytes = readFileSync(new URL('./harness-leaderboard-manifest.json', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('948cedf2bdd10631ec53b12d1aa5ba2dfb3822773d71f067f595598c1bb09806');
  });

  it('pins the Space registry and Harbor version independently of installed tools', () => {
    expect(manifest.sourceRevision).toBe('f07159ad073de40bb8d13da9d09ed831e265266f');
    expect(manifest.sourceRegistrySha256)
      .toBe('281a4fceead2303927f9dbf0a4efd25eee6f349f68752b59f18b015c61e71f82');
    expect(manifest.harborVersion).toBe('0.24.0');
    expect(Object.keys(manifest.suites).sort()).toEqual(['deep-swe', 'terminal-bench-2.1']);
  });

  describe.each([
    {
      id: 'deep-swe', selected: 111, upstream: 113,
      revision: '0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea',
      repository: 'https://github.com/datacurve-ai/deep-swe.git',
      network: 'enforced',
      excluded: ['helm-unified-manifest-stream', 'vulture-persistent-analysis-cache'],
    },
    {
      id: 'terminal-bench-2.1', selected: 87, upstream: 89,
      revision: 'd49e28f1e4ddd13d289e85a5f312a66750951932',
      repository: 'https://github.com/harbor-framework/terminal-bench-2-1.git',
      network: 'task-declared',
      excluded: ['qemu-alpine-ssh', 'qemu-startup'],
    },
  ] as const)('$id frozen population', ({ id, selected, upstream, revision, repository, network, excluded }) => {
    const suite = manifest.suites[id];

    it('accounts for the full upstream population, including explicit exclusions', () => {
      const ids = suite.tasks.map(task => task.id);
      expect(ids).toHaveLength(selected);
      expect(new Set(ids).size).toBe(selected);
      expect(ids).toEqual(suite.subsets.full);
      expect(suite.upstreamTaskCount).toBe(upstream);
      expect(ids.length + Object.keys(suite.excluded).length).toBe(upstream);
      expect(Object.keys(suite.excluded).sort()).toEqual([...excluded].sort());
      for (const [taskId, reason] of Object.entries(suite.excluded)) {
        expect(ids).not.toContain(taskId);
        expect(reason.trim().length).toBeGreaterThan(0);
      }
    });

    it('retains source, license, network and per-task Git identities', () => {
      expect(suite.repository).toBe(repository);
      expect(suite.revision).toBe(revision);
      expect(suite.sourceTree).toBe(revision);
      expect(suite.license).toBe('Apache-2.0');
      expect(suite.network).toBe(network);
      for (const task of suite.tasks) {
        expect(task.id.trim()).toBe(task.id);
        expect(task.id.length).toBeGreaterThan(0);
        expect(task.instructionGitBlob).toMatch(/^[a-f0-9]{40}$/);
        expect(task.taskTomlGitBlob).toMatch(/^[a-f0-9]{40}$/);
      }
    });

    it('keeps smoke and pilot as unique ordered subsets of the frozen full roster', () => {
      expect(suite.subsets.smoke).toHaveLength(3);
      expect(suite.subsets.pilot).toHaveLength(50);
      for (const subset of [suite.subsets.smoke, suite.subsets.pilot]) {
        expect(new Set(subset).size).toBe(subset.length);
        expect(subset).toEqual(suite.subsets.full.filter(taskId => subset.includes(taskId)));
      }
      for (const taskId of suite.subsets.smoke) {
        expect(suite.subsets.pilot).toContain(taskId);
      }
    });
  });
});
