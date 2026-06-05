import { describe, it, expect, vi } from 'vitest';
import {
  commitAndReproject,
  papercuspBlueprintPath,
  papercuspPromptPath,
  type CommitReprojectDeps,
  type LoadedForReproject,
} from '../commit-reproject';
import type { Blueprint } from '@papercusp/orchestrator/blueprint';

/**
 * P-016 — live-edit = commit → reproject (D-007/D-021). An accepted edit commits the
 * target's `.papercusp/` file FIRST, then re-projects the blueprint to PG; it
 * replaces the ungated PUT that wrote PG without a commit. Order + failure handling
 * are the contract.
 */

const FAKE_BP = { id: 'coding', version: '0.1.0' } as unknown as Blueprint;
const loaded: LoadedForReproject = { blueprint: FAKE_BP, contentHash: 'hash-xyz', sourcePath: '/repo/.papercusp/blueprint.yaml' };

function fakeDeps(over: Partial<CommitReprojectDeps> = {}): { deps: CommitReprojectDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: CommitReprojectDeps = {
    ensureDir: (p) => calls.push(`ensureDir:${p}`),
    writeFile: (p) => calls.push(`writeFile:${p}`),
    gitCommit: async (_dir, rel) => {
      calls.push(`gitCommit:${rel.join(',')}`);
      return 'sha123';
    },
    loadBlueprint: () => {
      calls.push('loadBlueprint');
      return loaded;
    },
    projectToPg: async (i) => {
      calls.push(`projectToPg:${i.sourceCommit}`);
      return { contentHash: i.contentHash };
    },
    ...over,
  };
  return { deps, calls };
}

describe('commitAndReproject', () => {
  it('prompt edit: writes the .papercusp prompt, commits, then reprojects — in that order', async () => {
    const { deps, calls } = fakeDeps();
    const res = await commitAndReproject(
      { workspaceId: 'ws', harnessSlug: 'h', harnessDir: '/repo', edit: { kind: 'prompt', role: 'worker', md: 'new prompt' } },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.committed).toBe(true);
    expect(res.commit).toBe('sha123');
    expect(res.contentHash).toBe('hash-xyz');
    expect(res.editedPath).toBe(papercuspPromptPath('/repo', 'worker'));
    // the commit path is repo-relative
    expect(calls).toContain('gitCommit:.papercusp/prompts/worker.md');
    // ORDER: write → commit → load → project (cache never ahead of the committed file)
    expect(calls).toEqual([
      'ensureDir:/repo/.papercusp/prompts',
      'writeFile:/repo/.papercusp/prompts/worker.md',
      'gitCommit:.papercusp/prompts/worker.md',
      'loadBlueprint',
      'projectToPg:sha123',
    ]);
  });

  it('blueprint edit: writes .papercusp/blueprint.yaml and reprojects', async () => {
    const { deps, calls } = fakeDeps();
    const res = await commitAndReproject(
      { workspaceId: 'ws', harnessSlug: 'h', harnessDir: '/repo', edit: { kind: 'blueprint', yaml: 'id: coding\n' } },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.editedPath).toBe(papercuspBlueprintPath('/repo'));
    expect(calls).toContain('writeFile:/repo/.papercusp/blueprint.yaml');
    expect(calls).toContain('gitCommit:.papercusp/blueprint.yaml');
  });

  it('repo-less target (no git): commit returns null → committed:false but still ok + projected', async () => {
    const { deps, calls } = fakeDeps({ gitCommit: async () => null });
    const res = await commitAndReproject(
      { workspaceId: 'ws', harnessSlug: 'r', harnessDir: '/repoless', edit: { kind: 'prompt', role: 'researcher', md: 'x' } },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.committed).toBe(false);
    expect(res.commit).toBeNull();
    expect(res.contentHash).toBe('hash-xyz'); // the file edit stands + was projected
    expect(calls).toContain('projectToPg:null');
  });

  it('git failure: returns ok:false and does NOT project (no cache write ahead of a failed commit)', async () => {
    const projectToPg = vi.fn(async (i: any) => ({ contentHash: i.contentHash }));
    const { deps } = fakeDeps({ gitCommit: async () => { throw new Error('detached HEAD'); }, projectToPg });
    const res = await commitAndReproject(
      { workspaceId: 'ws', harnessSlug: 'h', harnessDir: '/repo', edit: { kind: 'prompt', role: 'worker', md: 'x' } },
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/git commit failed/);
    expect(projectToPg).not.toHaveBeenCalled();
  });

  it('reprojection failure: committed:true but ok:false (surface, do not silently accept)', async () => {
    const { deps } = fakeDeps({ projectToPg: async () => { throw new Error('bad cache'); } });
    const res = await commitAndReproject(
      { workspaceId: 'ws', harnessSlug: 'h', harnessDir: '/repo', edit: { kind: 'blueprint', yaml: 'id: x\n' } },
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.committed).toBe(true);
    expect(res.commit).toBe('sha123');
    expect(res.reason).toMatch(/reprojection failed/);
  });

  it('uses a generated commit message that names the role', async () => {
    let seenMsg = '';
    const { deps } = fakeDeps({
      gitCommit: async (_dir, _rel) => { return 'sha'; },
    });
    // wrap gitCommit to capture the message
    const wrapped: CommitReprojectDeps = {
      ...deps,
      gitCommit: async (dir, rel, msg) => { seenMsg = msg; return 'sha'; },
    };
    await commitAndReproject(
      { workspaceId: 'ws', harnessSlug: 'myharness', harnessDir: '/repo', edit: { kind: 'prompt', role: 'validator', md: 'x' } },
      wrapped,
    );
    expect(seenMsg).toContain('validator');
    expect(seenMsg).toContain('myharness');
  });
});
