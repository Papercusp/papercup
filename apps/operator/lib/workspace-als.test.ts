import { describe, it, expect } from 'vitest';
import {
  runWithWorkspace,
  runWithWorkspaceIfConcrete,
  runInRequestScope,
  isInRequestScope,
  currentRequestWorkspaceId,
} from './workspace-als';

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

describe('runWithWorkspaceIfConcrete', () => {
  it('pins the workspace for a concrete id', () => {
    expect(runWithWorkspaceIfConcrete('ws-x', () => currentRequestWorkspaceId())).toBe('ws-x');
  });

  it('does NOT pin for the wildcard "*" (superuser without a chosen workspace)', () => {
    expect(runWithWorkspaceIfConcrete('*', () => currentRequestWorkspaceId())).toBeUndefined();
  });

  it('does NOT pin for empty / undefined', () => {
    expect(runWithWorkspaceIfConcrete('', () => currentRequestWorkspaceId())).toBeUndefined();
    expect(runWithWorkspaceIfConcrete(undefined, () => currentRequestWorkspaceId())).toBeUndefined();
  });

  it('returns the callback value and preserves it across an await', async () => {
    const v = await runWithWorkspaceIfConcrete('ws-y', async () => {
      await Promise.resolve();
      return currentRequestWorkspaceId();
    });
    expect(v).toBe('ws-y');
  });
});

describe('runInRequestScope / isInRequestScope', () => {
  it('isInRequestScope is false outside any scope', () => {
    expect(isInRequestScope()).toBe(false);
  });

  it('marks a request scope with no concrete workspace (missing header)', () => {
    const r = runInRequestScope(() => ({
      inScope: isInRequestScope(),
      ws: currentRequestWorkspaceId(),
    }));
    expect(r.inScope).toBe(true);
    expect(r.ws).toBeUndefined();
  });

  it('a workspace scope also counts as a request scope', () => {
    const r = runWithWorkspace('ws-z', () => ({
      inScope: isInRequestScope(),
      ws: currentRequestWorkspaceId(),
    }));
    expect(r.inScope).toBe(true);
    expect(r.ws).toBe('ws-z');
  });
});
