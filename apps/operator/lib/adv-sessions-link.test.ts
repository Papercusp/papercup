import { afterEach, describe, expect, it, vi } from 'vitest';

describe('adv-sessions link persistence', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('./workspace-registry');
  });

  it('returns conflict when the ADV row is already linked to a different OMP session', async () => {
    const sql = vi.fn(async () => [{ omp_thread_id: '019-old' }]);
    vi.doMock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql }) }));
    vi.doMock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

    const mod = await import('./adv-sessions');
    await expect(mod.setAdvSessionOmpThreadId(7, '019-new')).resolves.toBe('conflict');
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it('updates an unlinked ADV row and reports linked', async () => {
    const sql = vi.fn()
      .mockResolvedValueOnce([{ omp_thread_id: null }])
      .mockResolvedValueOnce([]);
    vi.doMock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql }) }));
    vi.doMock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

    const mod = await import('./adv-sessions');
    await expect(mod.setAdvSessionOmpThreadId(7, '019-new')).resolves.toBe('linked');
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it('stores cwd when recording a session row', async () => {
    const sql = vi.fn(async () => [{ id: 42 }]);
    vi.doMock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql }) }));
    vi.doMock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

    const mod = await import('./adv-sessions');
    await expect(
      mod.recordAdvSession({ mode: 'omp', cwd: '/repo/harness-a', label: 'test-session' }),
    ).resolves.toBe(42);
    const values = sql.mock.calls[0]?.slice(1) ?? [];
    expect(values).toContain('/repo/harness-a');
  });
});
