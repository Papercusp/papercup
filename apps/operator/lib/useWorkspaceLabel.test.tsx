/**
 * @vitest-environment jsdom
 *
 * RTL tests for useWorkspaceLabel — the hook that shows the active workspace's
 * display NAME (falling back to its raw id until the registry read lands).
 * Covers: the synchronous id fallback, resolve-to-name, name-absent fallback,
 * rejection fallback, and the unmount cancellation guard. The two operator-core
 * registry reads are mocked.
 *
 * Run: cd apps/operator && npx vitest run lib/useWorkspaceLabel.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  getBrowserWorkspaceId: vi.fn<() => string>(() => 'ws-fallback'),
  resolveActiveWorkspaceId: vi.fn<(reg: unknown, fb: string) => string>((_reg, fb) => fb),
  listWorkspaces: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ workspaces: [] })),
}));

vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({
  getBrowserWorkspaceId: h.getBrowserWorkspaceId,
  resolveActiveWorkspaceId: h.resolveActiveWorkspaceId,
}));
vi.mock('@papercusp/operator-core/lib/workspaces-tauri', () => ({
  listWorkspaces: h.listWorkspaces,
}));

import { useWorkspaceLabel } from './useWorkspaceLabel';

beforeEach(() => {
  h.getBrowserWorkspaceId.mockReturnValue('ws-fallback');
  h.resolveActiveWorkspaceId.mockImplementation((_reg, fb) => fb);
  h.listWorkspaces.mockResolvedValue({ workspaces: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useWorkspaceLabel', () => {
  it('starts at the browser workspace id before the registry read lands', () => {
    h.getBrowserWorkspaceId.mockReturnValue('ws-123');
    const { result } = renderHook(() => useWorkspaceLabel());
    expect(result.current).toBe('ws-123');
  });

  it('resolves to the active workspace display name', async () => {
    h.getBrowserWorkspaceId.mockReturnValue('ws-123');
    h.resolveActiveWorkspaceId.mockReturnValue('ws-123');
    h.listWorkspaces.mockResolvedValue({ workspaces: [{ id: 'ws-123', name: 'Acme HQ' }] });
    const { result } = renderHook(() => useWorkspaceLabel());
    await waitFor(() => expect(result.current).toBe('Acme HQ'));
  });

  it('keeps the id fallback when the active workspace has no name', async () => {
    h.getBrowserWorkspaceId.mockReturnValue('ws-123');
    h.resolveActiveWorkspaceId.mockReturnValue('ws-123');
    h.listWorkspaces.mockResolvedValue({ workspaces: [{ id: 'ws-123' }] }); // no name field
    const { result } = renderHook(() => useWorkspaceLabel());
    await waitFor(() => expect(h.listWorkspaces).toHaveBeenCalled());
    // let the resolved .then run, then assert it chose not to overwrite the id
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current).toBe('ws-123');
  });

  it('keeps the id fallback when the registry read rejects', async () => {
    h.getBrowserWorkspaceId.mockReturnValue('ws-err');
    h.listWorkspaces.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useWorkspaceLabel());
    await waitFor(() => expect(h.listWorkspaces).toHaveBeenCalled());
    await Promise.resolve();
    expect(result.current).toBe('ws-err');
  });

  it('does not apply the name after unmount (cancellation guard)', async () => {
    let resolveList: (v: unknown) => void = () => {};
    h.getBrowserWorkspaceId.mockReturnValue('ws-late');
    h.resolveActiveWorkspaceId.mockReturnValue('ws-late');
    h.listWorkspaces.mockReturnValue(new Promise((res) => { resolveList = res; }));
    const { result, unmount } = renderHook(() => useWorkspaceLabel());
    unmount();
    resolveList({ workspaces: [{ id: 'ws-late', name: 'Should Not Apply' }] });
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current).toBe('ws-late'); // last committed value, never the post-unmount name
  });
});
