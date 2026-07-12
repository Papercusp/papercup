import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./local-backend-store', () => ({
  listLocalBackends: vi.fn(),
}));

import { listLocalBackends } from './local-backend-store';
import type { LocalBackendRecord } from './local-backend-store';
import { runWithWorkspace } from '../workspace-als';
import {
  localModelIdsSync,
  __refreshLocalModelIdsForTests,
  __resetLocalModelIdsCacheForTests,
} from './local-model-ids-cache';

const mockListLocalBackends = vi.mocked(listLocalBackends);

beforeEach(() => {
  mockListLocalBackends.mockReset();
  __resetLocalModelIdsCacheForTests();
});

describe('localModelIdsSync — WI-4395 (per-workspace snapshot, resolved at the call site)', () => {
  it('cold start (no refresh landed yet) fails open: empty array, never throws', () => {
    mockListLocalBackends.mockResolvedValue([]);
    const result = runWithWorkspace('ws-cold', () => localModelIdsSync());
    expect(result).toEqual([]);
  });

  it('a landed refresh (via the test seam) is visible to a later sync call in the SAME workspace', async () => {
    mockListLocalBackends.mockResolvedValue([
      { id: 'b1', kind: 'ollama', baseUrl: 'http://x', models: ['ornith-35b'], maxConcurrent: 4, enabled: true, createdAt: '', updatedAt: '' },
    ]);
    await runWithWorkspace('ws-a', () => __refreshLocalModelIdsForTests());
    const result = runWithWorkspace('ws-a', () => localModelIdsSync());
    expect(result).toEqual(['ornith-35b']);
    // The refresh (and the subsequent sync read) resolved the workspace SYNCHRONOUSLY at the
    // call site — listLocalBackends must have been asked for exactly that workspace, never the
    // ambient/global fallback.
    expect(mockListLocalBackends).toHaveBeenCalledWith({ workspaceId: 'ws-a' });
  });

  it('WI-4395 regression: a snapshot resolved under one workspace does NOT leak into another workspace\'s sync read (the old module-global `snapshot` bug)', async () => {
    mockListLocalBackends.mockImplementation(async ({ workspaceId }: { workspaceId?: string } = {}) => {
      if (workspaceId === 'ws-with-backend') {
        return [
          { id: 'b1', kind: 'ollama', baseUrl: 'http://x', models: ['ornith-35b'], maxConcurrent: 4, enabled: true, createdAt: '', updatedAt: '' },
        ];
      }
      return [];
    });
    await runWithWorkspace('ws-with-backend', () => __refreshLocalModelIdsForTests());
    // A DIFFERENT workspace's sync read must see its OWN (empty) registry, not the other
    // workspace's populated one.
    const other = runWithWorkspace('ws-empty', () => localModelIdsSync());
    expect(other).toEqual([]);
    // And the original workspace still sees its own populated snapshot.
    const original = runWithWorkspace('ws-with-backend', () => localModelIdsSync());
    expect(original).toEqual(['ornith-35b']);
  });

  it('WI-4395: activeWorkspaceId() is captured at the localModelIdsSync() call site itself — not re-resolved inside the async refresh chain', async () => {
    // Simulate the real failure shape: refreshSoon() is kicked from INSIDE the correct
    // workspace's synchronous call stack (runWithWorkspace), even though the underlying
    // listLocalBackends() promise resolves later, asynchronously, outside any ALS scope. The
    // workspace id must have been captured synchronously — not re-read from ALS after the await.
    let resolveBackends!: (v: LocalBackendRecord[]) => void;
    mockListLocalBackends.mockImplementation(
      () => new Promise<LocalBackendRecord[]>((resolve) => { resolveBackends = resolve; }),
    );
    const syncResultDuringLoad = runWithWorkspace('ws-b', () => localModelIdsSync());
    expect(syncResultDuringLoad).toEqual([]); // not landed yet — fail-open
    expect(mockListLocalBackends).toHaveBeenCalledWith({ workspaceId: 'ws-b' });
    // Resolve OUTSIDE any workspace ALS scope (mirrors the real fire-and-forget .then()).
    resolveBackends([
      { id: 'b1', kind: 'llama-server', baseUrl: 'http://x', models: ['m1'], maxConcurrent: 4, enabled: true, createdAt: '', updatedAt: '' },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    const after = runWithWorkspace('ws-b', () => localModelIdsSync());
    expect(after).toEqual(['m1']);
  });

  it('fail-open on a rejected refresh: keeps the previous snapshot rather than throwing', async () => {
    mockListLocalBackends.mockResolvedValueOnce([
      { id: 'b1', kind: 'ollama', baseUrl: 'http://x', models: ['m1'], maxConcurrent: 4, enabled: true, createdAt: '', updatedAt: '' },
    ]);
    await runWithWorkspace('ws-c', () => __refreshLocalModelIdsForTests());
    expect(runWithWorkspace('ws-c', () => localModelIdsSync())).toEqual(['m1']);

    mockListLocalBackends.mockRejectedValueOnce(new Error('db down'));
    const result = await runWithWorkspace('ws-c', () => __refreshLocalModelIdsForTests());
    expect(result).toEqual(['m1']); // unchanged — fail-open
  });
});
