/**
 * shards.test.ts — DG-2 pure-manifest unit tests (P-045): determinism,
 * transitive input closure, layer derivation, cycle safety. The git-backed
 * discovery + inputsHash paths are covered by shards.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  buildShardManifest,
  shardId,
  LAYER_SCRIPTS,
  ROOT_INPUT_FILES,
  type WorkspaceMeta,
} from './shards';

function ws(partial: Partial<WorkspaceMeta> & { name: string; dir: string }): WorkspaceMeta {
  return { deps: [], hasUnit: true, hasIntegration: false, ...partial };
}

const A = ws({ name: '@t/a', dir: 'pkgs/a', deps: ['@t/b', 'left-pad'], hasIntegration: true });
const B = ws({ name: '@t/b', dir: 'pkgs/b', deps: ['@t/c'] });
const C = ws({ name: '@t/c', dir: 'libs/c' });
const NO_TESTS = ws({ name: '@t/none', dir: 'pkgs/none', hasUnit: false });

describe('buildShardManifest (pure)', () => {
  it('derives one shard per (workspace, declared layer) with the affected-tests scripts', () => {
    const m = buildShardManifest([A, B, C, NO_TESTS]);
    const ids = m.shards.map((s) => s.shardId);
    expect(ids).toEqual([
      shardId('@t/a', 'integration'),
      shardId('@t/a', 'unit'),
      shardId('@t/b', 'unit'),
      shardId('@t/c', 'unit'),
    ]);
    // no shard for a workspace with no test scripts
    expect(ids.some((i) => i.includes('@t/none'))).toBe(false);
    for (const s of m.shards) expect(s.npmScript).toBe(LAYER_SCRIPTS[s.layer]);
    expect(m.rootInputFiles).toEqual([...ROOT_INPUT_FILES]);
  });

  it('inputDirs is the TRANSITIVE workspace-dep closure (external deps ignored)', () => {
    const m = buildShardManifest([A, B, C]);
    const aUnit = m.shards.find((s) => s.shardId === shardId('@t/a', 'unit'))!;
    // a → b → c: all three dirs, sorted; 'left-pad' (external) contributes nothing.
    expect(aUnit.inputDirs).toEqual(['libs/c', 'pkgs/a', 'pkgs/b']);
    const bUnit = m.shards.find((s) => s.shardId === shardId('@t/b', 'unit'))!;
    expect(bUnit.inputDirs).toEqual(['libs/c', 'pkgs/b']);
    const cUnit = m.shards.find((s) => s.shardId === shardId('@t/c', 'unit'))!;
    expect(cUnit.inputDirs).toEqual(['libs/c']);
  });

  it('is deterministic: shuffled input order yields a byte-identical manifest', () => {
    const m1 = buildShardManifest([A, B, C, NO_TESTS]);
    const m2 = buildShardManifest([NO_TESTS, C, B, A]);
    expect(JSON.stringify(m2)).toBe(JSON.stringify(m1));
  });

  it('dependency cycles terminate and include both sides', () => {
    const x = ws({ name: '@t/x', dir: 'pkgs/x', deps: ['@t/y'] });
    const y = ws({ name: '@t/y', dir: 'pkgs/y', deps: ['@t/x'] });
    const m = buildShardManifest([x, y]);
    const sx = m.shards.find((s) => s.workspaceName === '@t/x')!;
    expect(sx.inputDirs).toEqual(['pkgs/x', 'pkgs/y']);
    const sy = m.shards.find((s) => s.workspaceName === '@t/y')!;
    expect(sy.inputDirs).toEqual(['pkgs/x', 'pkgs/y']);
  });

  it('unreadable workspaces are carried loudly (sorted), never dropped', () => {
    const m = buildShardManifest([A], {
      unreadableWorkspaces: [
        { dir: 'libs/z', reason: 'behind gitlink libs/z@abc' },
        { dir: 'libs/m', reason: 'behind gitlink libs/m@def' },
      ],
    });
    expect(m.unreadableWorkspaces.map((u) => u.dir)).toEqual(['libs/m', 'libs/z']);
  });
});
