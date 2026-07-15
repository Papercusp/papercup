import { afterEach, describe, expect, it, vi } from 'vitest';

describe('adv_sessions port-column rollout compatibility (WI-4936)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('./workspace-registry');
  });

  function installSql(result: unknown[] = []) {
    const sql = vi.fn(async () => result);
    vi.doMock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql }) }));
    vi.doMock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    return sql;
  }

  const textOf = (sql: ReturnType<typeof vi.fn>, call = 0) =>
    (sql.mock.calls[call]?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '';

  it('ordinary recordAdvSession keeps the legacy INSERT while migration 611 is pending', async () => {
    const sql = installSql([{ id: 7 }]);
    const mod = await import('./adv-sessions');
    await expect(mod.recordAdvSession({ mode: 'console', agent: 'claude', cwd: '/repo' })).resolves.toBe(7);
    expect(textOf(sql)).not.toContain('port_id');
    expect(textOf(sql)).not.toContain('port_status');
  });

  it('only an actual port target opts into the post-611 INSERT and fails closed on old schema', async () => {
    const sql = installSql([{ id: 8 }]);
    const mod = await import('./adv-sessions');
    await expect(mod.recordAdvSession({
      mode: 'console', agent: 'codex', cwd: '/repo',
      portId: '22222222-2222-4222-8222-222222222222',
      portSourceAdvSessionId: 7,
      portStatus: 'pending',
    })).resolves.toBe(8);
    expect(textOf(sql)).toContain('port_id');
    expect(textOf(sql)).toContain('port_status');
  });

  it('ordinary read surfaces extract optional lineage through to_jsonb(row), never a parse-time column reference', async () => {
    const sql = installSql([]);
    const mod = await import('./adv-sessions');
    await mod.listAdvSessions();
    await mod.getAdvSession(1);
    await mod.getAdvSessionInWorkspace(1, 'ws-test');
    for (let i = 0; i < 3; i++) {
      const query = textOf(sql, i);
      expect(query).toContain("to_jsonb(a)->>'port_id'");
      expect(query).toContain("to_jsonb(a)->>'port_status'");
      expect(query).not.toMatch(/[,\s]port_id\s*[,\n]/);
    }
  });

  it('resumable filtering treats a missing pre-611 key as delivered but still excludes pending ports post-611', async () => {
    const sql = installSql([]);
    const mod = await import('./adv-sessions');
    await mod.listResumableSessions();
    const query = textOf(sql);
    expect(query).toContain("COALESCE(to_jsonb(a)->>'port_status', 'delivered') = 'delivered'");
    expect(query).not.toMatch(/\(port_status IS NULL/);
  });
});
