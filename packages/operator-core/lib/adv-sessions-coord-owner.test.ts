import { afterEach, describe, expect, it, vi } from 'vitest';

/** A full snake_case adv_sessions DB row (what postgres-js hands back). */
const dbRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  workspace_id: 'ws1',
  plan_slug: null,
  agent: 'claude',
  role: 'worker',
  feature: 'F-001',
  mode: 'console',
  terminal_bin: null,
  pid: 100,
  window_id: null,
  omp_thread_id: null,
  label: null,
  cwd: '/repo',
  coord_owner_id: 'su-1',
  started_at: '2026-06-02T00:00:00.000Z',
  ended_at: null,
  exit_code: null,
  ...over,
});

describe('adv-sessions coord_owner_id wiring (P-001/P-003)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('./workspace-registry');
  });

  function mockSql(impl: (...a: unknown[]) => Promise<unknown>): ReturnType<typeof vi.fn> {
    const sql = vi.fn(impl);
    vi.doMock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql }) }));
    vi.doMock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    return sql;
  }

  it('recordAdvSession passes coordOwnerId into the INSERT params', async () => {
    const sql = mockSql(async () => [{ id: 7 }]);
    const mod = await import('./adv-sessions');
    await expect(
      mod.recordAdvSession({ mode: 'console', coordOwnerId: 'su-abc', label: 't' }),
    ).resolves.toBe(7);
    const values = sql.mock.calls[0]?.slice(1) ?? [];
    expect(values).toContain('su-abc'); // the SID lands in the row
  });

  it('advSessionsByCoordOwner keys by coord_owner_id, most-recent (first) wins, skips null owners', async () => {
    mockSql(async () => [
      dbRow({ id: 2, coord_owner_id: 'su-1', role: 'newer' }), // ORDER BY started_at DESC → first = newest
      dbRow({ id: 1, coord_owner_id: 'su-1', role: 'older' }),
      dbRow({ id: 3, coord_owner_id: 'su-2', role: 'other' }),
      dbRow({ id: 4, coord_owner_id: null }), // no owner → not in the map
    ]);
    const mod = await import('./adv-sessions');
    const map = await mod.advSessionsByCoordOwner();
    expect(map.size).toBe(2);
    expect(map.get('su-1')?.id).toBe(2);
    expect(map.get('su-1')?.role).toBe('newer'); // first wins
    expect(map.get('su-2')?.role).toBe('other');
  });

  it('listEndedAdvSessions maps rows and threads the workspace scope + limit params', async () => {
    const sql = mockSql(async () => [dbRow({ id: 9, ended_at: '2026-06-02T01:00:00.000Z' })]);
    const mod = await import('./adv-sessions');
    const rows = await mod.listEndedAdvSessions({ workspaceId: 'ws9', limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(9);
    expect(rows[0]?.endedAt).toBe('2026-06-02T01:00:00.000Z');
    expect(rows[0]?.coordOwnerId).toBe('su-1');
    const values = sql.mock.calls[0]?.slice(1) ?? [];
    expect(values).toContain('ws9'); // scope param interpolated
    expect(values).toContain(10); // limit
  });
});
