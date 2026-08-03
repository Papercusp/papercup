/**
 * work-items-blocked-audit.test.ts — pure unit coverage for `recordWorkItemBlockedAudit`
 * (EI-19397599078921465).
 *
 * A FEATURE-family `→ blocked` transition used to record nothing anywhere: no audit row, no
 * payload provenance. Measured 2026-08-03: 59 feature items sitting at `blocked` with no trace of
 * who moved them or when. (The ISSUE family was already covered indirectly — its blocked
 * transition auto-parks, and the park audits as `work_items:claim_hold:set` reason='blocked'.)
 *
 * `recordWorkItemBlockedAudit` takes its `sql` INJECTED rather than resolving `getOrgPg()`
 * internally — which is exactly what keeps this a PG-FREE unit test (db-org still mocked
 * defensively, matching work-items-claim-hold-attribution.test.ts's pattern).
 *
 * The two properties worth guarding hardest, because both fail SILENTLY in production:
 *   1. the audit row lands in the located row's OWN workspace, never the ambient one (EI-15345 —
 *      a row written to the wrong tenant reads as ABSENT, i.e. as the very bug being fixed);
 *   2. the write NEVER throws — a lifecycle write must not fail over its own bookkeeping.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: Object.assign(async () => [], { unsafe: vi.fn() }) }),
}));

const { recordWorkItemBlockedAudit } = await import('./work-items');

type SqlArg = Parameters<typeof recordWorkItemBlockedAudit>[0];

/** A fake `{ unsafe }` that answers the locate SELECT with `locateRows` and records every call. */
function fakeSql(locateRows: Array<{ workspace_id: string }>) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const unsafe = vi.fn(async (text: string, params: unknown[]) => {
    calls.push({ text, params });
    return text.includes('SELECT workspace_id') ? locateRows : [];
  });
  return {
    sql: { unsafe } as unknown as SqlArg,
    calls,
    locate: () => calls.find((c) => c.text.includes('SELECT workspace_id')),
    insert: () => calls.find((c) => c.text.includes('INSERT INTO harness_shared.audit_log')),
  };
}

/** A fake whose `unsafe` rejects — the failure paths this write must absorb. */
function rejectingSql(err: unknown) {
  return { unsafe: vi.fn(async () => Promise.reject(err)) } as unknown as SqlArg;
}

const BASE = { to: 'blocked', requested: 'blocked', family: 'feature' } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordWorkItemBlockedAudit', () => {
  it('writes a work_items:state:blocked audit row for the item', async () => {
    const f = fakeSql([{ workspace_id: 'ws-real' }]);
    await recordWorkItemBlockedAudit(f.sql, 'WI-123', { ...BASE, by: 'su-abc123' });

    const insert = f.insert();
    expect(insert).toBeDefined();
    const [, ts, actor, action, subject, , workspaceId] = insert!.params as [
      string,
      number,
      string,
      string,
      string,
      string,
      string,
    ];
    expect(action).toBe('work_items:state:blocked');
    expect(subject).toBe('WI-123');
    expect(actor).toBe('su-abc123');
    expect(typeof ts).toBe('number');
    expect(workspaceId).toBe('ws-real');
  });

  it("records the LOCATED row's workspace, not the ambient one (EI-15345)", async () => {
    const f = fakeSql([{ workspace_id: 'ws-owning' }]);
    await recordWorkItemBlockedAudit(f.sql, 'WI-123', {
      ...BASE,
      by: 'su-abc123',
      activeWorkspaceId: 'ws-ambient-wrong',
    });

    const workspaceId = (f.insert()!.params as unknown[])[6];
    expect(workspaceId).toBe('ws-owning');
    expect(workspaceId).not.toBe('ws-ambient-wrong');
  });

  it('passes id, harness and ambient workspace to the locate query as bound params', async () => {
    const f = fakeSql([{ workspace_id: 'ws-real' }]);
    await recordWorkItemBlockedAudit(f.sql, 'WI-123', {
      ...BASE,
      harness: 'papercusp',
      activeWorkspaceId: 'ws-ambient',
    });

    expect(f.locate()!.params).toEqual(['WI-123', 'papercusp', 'ws-ambient']);
  });

  it('binds null (not undefined) for an omitted harness / ambient workspace', async () => {
    const f = fakeSql([{ workspace_id: 'ws-real' }]);
    await recordWorkItemBlockedAudit(f.sql, 'WI-123', BASE);

    expect(f.locate()!.params).toEqual(['WI-123', null, null]);
  });

  it('falls back to actor "system" when no `by` is supplied', async () => {
    const f = fakeSql([{ workspace_id: 'ws-real' }]);
    await recordWorkItemBlockedAudit(f.sql, 'WI-123', { ...BASE, by: null });

    expect((f.insert()!.params as unknown[])[2]).toBe('system');
  });

  it('carries to/requested/family/by in the details payload', async () => {
    const f = fakeSql([{ workspace_id: 'ws-real' }]);
    await recordWorkItemBlockedAudit(f.sql, 'WI-123', {
      to: 'blocked',
      requested: 'BLOCKED',
      family: 'feature',
      by: 'su-abc123',
    });

    expect(JSON.parse((f.insert()!.params as string[])[5])).toEqual({
      to: 'blocked',
      requested: 'BLOCKED',
      family: 'feature',
      by: 'su-abc123',
    });
  });

  it('writes NOTHING when the item cannot be located (no workspace to attribute it to)', async () => {
    const f = fakeSql([]);
    await recordWorkItemBlockedAudit(f.sql, 'WI-missing', BASE);

    expect(f.insert()).toBeUndefined();
    expect(f.calls).toHaveLength(1); // the locate only
  });

  it('swallows a missing audit_log table (42P01) silently — lightweight fixtures lack it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = Object.assign(new Error('relation "harness_shared.audit_log" does not exist'), {
      code: '42P01',
    });

    await expect(recordWorkItemBlockedAudit(rejectingSql(err), 'WI-123', BASE)).resolves.toBeUndefined();
    // A console.warn here would red every test using an audit_log-less fixture.
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws on a real write failure — it warns and resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      recordWorkItemBlockedAudit(rejectingSql(new Error('connection terminated')), 'WI-123', BASE),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('recordWorkItemBlockedAudit');
  });
});
