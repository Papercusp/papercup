/**
 * group-set.test.ts — routines:group-set (WI-5018 routines grouping).
 *
 * Mocks getOrgPg/workspace + the control harness (separately covered elsewhere), so no PG.
 * Asserts: role gate · requires at least one of active/description/steward/reviewCadence/
 * markReviewed · errors loudly when the group doesn't exist yet (no silent auto-create — unlike
 * routines:set's per-routine assign) · bulk-pauses every member · dryRun does not apply.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/routines/group-set.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
}));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getOrgPg: () => ({ sql: sqlMock }) }));
vi.mock('../../workspace-registry', async (orig) => ({ ...(await orig<Record<string, unknown>>()), activeWorkspaceId: () => 'default' }));
vi.mock('../../gateway-control/control-harness', () => ({
  runControlMutation: vi.fn(async (spec: any, opts: any = {}) => {
    const prev = await spec.capturePrev();
    if (opts.dryRun) return { dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
    const next = await spec.apply();
    const verify = spec.verify ? await spec.verify(next) : undefined;
    return { dryRun: false, applied: true, prev, next, verify, auditId: 'aud-1' };
  }),
}));

const groupSetTool = (await import('./group-set')).default;

// group-set returns the canonical { data } shape (definetool-token-optimization P-003
// migration) — a direct .handler() call (bypassing the wire-encoding path) gets the raw
// { data } object, not a { content } envelope.
type Out = { data: unknown };
const body = (o: unknown) => (o as Out).data as Record<string, unknown>;

const GROUP_ROW = { description: 'Cleanup sweeps.', steward: null, review_cadence: '90d', last_reviewed_at: new Date('2026-01-01') };
const MEMBER_ROWS = [
  { install_slug: 'papercusp', name: 'idle-session-reaper', active: true },
  { install_slug: 'papercusp', name: 'session-dir-gc', active: false },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('routines:group-set', () => {
  it('rejects a role without operator-config write authority', async () => {
    await expect(
      groupSetTool.handler({ group: 'health', active: false } as never, { role: 'cup' } as never),
    ).rejects.toThrow(/operator, architect, or mug/i);
  });

  it('requires at least one of active/description/steward/reviewCadence/markReviewed', async () => {
    await expect(
      groupSetTool.handler({ group: 'health' } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/requires active, description, steward, reviewCadence, and\/or markReviewed/i);
  });

  it('errors loudly when the group does not exist yet — no silent auto-create', async () => {
    sqlMock.mockResolvedValueOnce([]); // readSnap's group-row SELECT comes back empty
    await expect(
      groupSetTool.handler({ group: 'nonexistent', active: false } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/routine group not found: "nonexistent"/i);
  });

  it('bulk-pauses every member of the group, capturing per-row prev active for a faithful revert', async () => {
    // Call order: capturePrev.readSnap (group,members) -> apply's readSnap (group,members) ->
    // writeGroupMeta (write) -> bulk active UPDATE (write, since `active` is set) ->
    // verify.readSnap (group,members). 8 sqlMock calls total, in that exact order.
    sqlMock
      .mockResolvedValueOnce([GROUP_ROW])
      .mockResolvedValueOnce(MEMBER_ROWS)
      .mockResolvedValueOnce([GROUP_ROW])
      .mockResolvedValueOnce(MEMBER_ROWS)
      .mockResolvedValueOnce([]) // writeGroupMeta UPDATE
      .mockResolvedValueOnce([]) // bulk active UPDATE
      .mockResolvedValueOnce([GROUP_ROW])
      .mockResolvedValueOnce(MEMBER_ROWS);

    const b = body(
      await groupSetTool.handler({ group: 'health', active: false } as never, { role: 'operator' } as never),
    );
    expect(b).toMatchObject({ ok: true, group: 'health', applied: true });
    // the bulk UPDATE targeted group_slug = 'health'
    const calls = sqlMock.mock.calls.map((c) => c.flat().join(' '));
    expect(calls.some((c) => c.includes('UPDATE harness_shared.routines') && c.includes('health'))).toBe(true);
  });

  it('markReviewed bumps last_reviewed_at without touching active', async () => {
    // No `active` arg -> the bulk UPDATE is skipped, so only ONE write call (writeGroupMeta)
    // sits between apply's readSnap and verify's readSnap. 7 sqlMock calls total.
    sqlMock
      .mockResolvedValueOnce([GROUP_ROW])
      .mockResolvedValueOnce(MEMBER_ROWS)
      .mockResolvedValueOnce([GROUP_ROW])
      .mockResolvedValueOnce(MEMBER_ROWS)
      .mockResolvedValueOnce([]) // writeGroupMeta UPDATE
      .mockResolvedValueOnce([{ ...GROUP_ROW, last_reviewed_at: new Date() }])
      .mockResolvedValueOnce(MEMBER_ROWS);
    const b = body(
      await groupSetTool.handler({ group: 'health', markReviewed: true } as never, { role: 'operator' } as never),
    );
    expect(b).toMatchObject({ ok: true, applied: true, verify: { ok: true } });
  });

  it('dryRun does not apply', async () => {
    sqlMock.mockResolvedValueOnce([GROUP_ROW]).mockResolvedValueOnce(MEMBER_ROWS);
    const b = body(
      await groupSetTool.handler({ group: 'health', active: false, dryRun: true } as never, { role: 'operator' } as never),
    );
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });
});
