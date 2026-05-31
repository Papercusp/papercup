import { describe, it, expect } from 'vitest';
import { runWithWorkspace, currentRequestWorkspaceId } from './workspace-als';

describe('workspace-als', () => {
  it('returns undefined outside any runWithWorkspace scope', () => {
    expect(currentRequestWorkspaceId()).toBeUndefined();
  });

  it('exposes the workspace id inside a runWithWorkspace scope', () => {
    const seen = runWithWorkspace('ws-a', () => currentRequestWorkspaceId());
    expect(seen).toBe('ws-a');
  });

  it('preserves the workspace across an async boundary', async () => {
    const seen = await runWithWorkspace('ws-b', async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      return currentRequestWorkspaceId();
    });
    expect(seen).toBe('ws-b');
  });

  it('isolates concurrent scopes (no cross-talk)', async () => {
    const [a, b] = await Promise.all([
      runWithWorkspace('ws-1', async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentRequestWorkspaceId();
      }),
      runWithWorkspace('ws-2', async () => {
        await new Promise((r) => setTimeout(r, 1));
        return currentRequestWorkspaceId();
      }),
    ]);
    expect(a).toBe('ws-1');
    expect(b).toBe('ws-2');
  });

  it('restores the outer scope after a nested run returns', () => {
    const result = runWithWorkspace('outer', () => {
      const inner = runWithWorkspace('inner', () => currentRequestWorkspaceId());
      return { inner, afterInner: currentRequestWorkspaceId() };
    });
    expect(result.inner).toBe('inner');
    expect(result.afterInner).toBe('outer');
  });
});
