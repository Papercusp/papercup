import { describe, test, expect, vi, beforeEach } from 'vitest';

// fireDirector only touches loopbackFetch + activeWorkspaceId; stub the rest so
// importing autoloop.ts is side-effect-free (no DB, no DBOS scheduling).
const loopbackFetch = vi.fn();
vi.mock('./loopback-fetch', () => ({ loopbackFetch: (...a: unknown[]) => loopbackFetch(...a) }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-x' }));
vi.mock('./dbos/dbos-flags', () => ({ dbosAutoloopActive: () => true }));
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: vi.fn(), db: {} }),
  generated: { autoloopStateInHarnessShared: {} },
}));

import { fireDirector } from './autoloop';

beforeEach(() => loopbackFetch.mockReset());

describe('fireDirector — fires the director in the resolved workspace (Phase E P-020)', () => {
  test('appends &ws=<activeWorkspaceId> so the invoke resolves the harness in the right workspace', async () => {
    loopbackFetch.mockResolvedValue({ ok: true });
    const r = await fireDirector('http://op', 'papercup', 'director');
    expect(r.ok).toBe(true);
    const url = loopbackFetch.mock.calls[0][0] as string;
    expect(url).toBe('http://op/api/harness/papercup/invoke?role=director&ws=ws-x');
  });

  test('url-encodes the slug + role + workspace', async () => {
    loopbackFetch.mockResolvedValue({ ok: true });
    await fireDirector('http://op', 'a b', 'co/ord');
    const url = loopbackFetch.mock.calls[0][0] as string;
    expect(url).toContain('/api/harness/a%20b/invoke?role=co%2Ford&ws=ws-x');
  });
});
