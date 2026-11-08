import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocksHost } from '@papercusp/locks';

const h = vi.hoisted(() => ({
  configure: vi.fn(), preserve: vi.fn(), validRepo: vi.fn(),
}));
vi.mock('@papercusp/locks', () => ({ configureLocks: h.configure }));
vi.mock('@papercusp/db-org', () => ({ setAdminPoolStatementTimeoutProvider: vi.fn() }));
vi.mock('@papercusp/db-org/acquire-registry', () => ({ beginAcquire: vi.fn(), recordPoolMax: vi.fn() }));
vi.mock('../../embedded-pg-discovery', () => ({ getHarnessAdminUrl: () => 'postgresql://fixture/unused' }));
vi.mock('../../txn-timeouts-config', () => ({
  adminPoolStatementTimeoutMs: () => 0,
  txnTimeoutsConfig: () => ({ lockTimeoutMs: 5000, statementTimeoutMs: 5000 }),
}));
vi.mock('./valid-git-entry', () => ({ hasValidGitEntry: h.validRepo }));
vi.mock('../../edit-attribution', () => ({ preserveReleasedEditGenerations: h.preserve }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'workspace-fixture' }));
import './configure';

const host = h.configure.mock.calls[0][0] as LocksHost;
const preserve = host.beforeFileLocksRelease!;
beforeEach(() => {
  h.preserve.mockReset().mockResolvedValue(true);
  h.validRepo.mockReset().mockReturnValue(true);
});

describe('file-lock custody host wiring', () => {
  const row = (owner: string, path: string, goal: string | null) => ({
    owner, path, goal_ref: goal, lock_id: `lease-${owner}`, intent: 'original edit',
    acquired_ts: new Date('2026-11-01T12:00:00Z'), acquired_identity: '1793534400.000001',
  });

  it('uses each stored predecessor owner and goal, including unassigned edits', async () => {
    const a = row('predecessor-A', 'a.ts', 'WI-original');
    const b = row('predecessor-B', 'b.ts', null);
    const c = row('predecessor-A', 'c.ts', 'WI-original');
    await preserve({ coordinationDomain: '/fixture/repo', rows: [a, b, c] });
    expect(h.preserve.mock.calls.map(([input]) => input)).toEqual([
      { repoRoot: '/fixture/repo', rows: [a, c], agentId: 'predecessor-A',
        sessionId: 'predecessor-A', workspaceId: 'workspace-fixture' },
      { repoRoot: '/fixture/repo', rows: [b], agentId: 'predecessor-B',
        sessionId: 'predecessor-B', workspaceId: 'workspace-fixture' },
    ]);
  });

  it('propagates custody failure instead of acknowledging a safe handoff', async () => {
    h.preserve.mockRejectedValueOnce(new Error('immutable custody unavailable'));
    await expect(preserve({ coordinationDomain: '/fixture/repo', rows: [row('A', 'a.ts', null)] }))
      .rejects.toThrow('immutable custody unavailable');
  });

  it('keeps non-repository lock domains outside Git custody', async () => {
    h.validRepo.mockReturnValue(false);
    await preserve({ coordinationDomain: 'opaque-lock-domain', rows: [row('A', 'a.ts', null)] });
    expect(h.preserve).not.toHaveBeenCalled();
  });
});
