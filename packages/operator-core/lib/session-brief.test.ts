/**
 * session-brief.test.ts — unit coverage for the durable successor-brief adapter (EI-1742).
 *
 * Mocks @papercusp/db-org's getOrgPg with a fake tagged-template `sql` (no PG needed).
 * The load-bearing contract is the BEST-EFFORT isolation: writeSessionBrief must NEVER
 * throw (it rides the hot presence write path), and getSessionBrief must degrade to null
 * — a brief failure can never affect coord:declare-intent / presence. Uses the
 * importOriginal spread form (TESTING.md EI-362) so generated.* stays intact.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Swappable fake `sql` tagged template; each test sets it before exercising the module.
let fakeSql: (strings: TemplateStringsArray, ...vals: unknown[]) => unknown = () =>
  Promise.resolve([]);

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => fakeSql(s, ...v) }),
}));

import { writeSessionBrief, getSessionBrief } from './session-brief';
import type { AgentIdentity } from './agent-tools/coordination/identity';

const identity: AgentIdentity = {
  ownerId: 'su-test-ei1742',
  ownerLabel: 'su · test',
  source: 'omp-hook-session',
  workspaceId: 'papercusp-workspace',
  userId: null,
};

/** A fake `sql` that records each call's interpolated values and returns `rows`. */
function recordingSql(rows: unknown[] = []) {
  const calls: unknown[][] = [];
  const sql = (_s: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(vals);
    return Promise.resolve(rows);
  };
  return { sql, calls };
}

afterEach(() => {
  fakeSql = () => Promise.resolve([]);
  vi.restoreAllMocks();
});

describe('writeSessionBrief (best-effort upsert)', () => {
  it('swallows a throwing sql — never throws (the isolation contract)', async () => {
    fakeSql = () => {
      throw new Error('db exploded mid-presence-write');
    };
    await expect(
      writeSessionBrief(identity, { intent: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('swallows a rejected-promise sql too', async () => {
    fakeSql = () => Promise.reject(new Error('connection reset'));
    await expect(writeSessionBrief(identity, { intent: 'x' })).resolves.toBeUndefined();
  });

  it('no-ops (no sql call) when ownerId is missing', async () => {
    const rec = recordingSql();
    fakeSql = rec.sql;
    await writeSessionBrief({ ...identity, ownerId: '' }, { intent: 'x' });
    expect(rec.calls).toHaveLength(0);
  });

  it('issues one upsert with the identity + brief fields interpolated', async () => {
    const rec = recordingSql();
    fakeSql = rec.sql;
    await writeSessionBrief(identity, {
      intent: 'shipping EI-1742',
      currentPlanSlug: 'plan-x',
      currentFiles: ['a.ts', 'b.ts'],
      harnessSlug: 'papercusp',
      hiveSlug: null,
    });
    expect(rec.calls).toHaveLength(1);
    const vals = rec.calls[0];
    expect(vals).toContain('su-test-ei1742');
    expect(vals).toContain('shipping EI-1742');
    expect(vals).toContain('plan-x');
    // current_files is serialized to a JSON string before the ::jsonb cast.
    expect(vals).toContain(JSON.stringify(['a.ts', 'b.ts']));
  });
});

describe('getSessionBrief (fail-soft read)', () => {
  it('returns null when neither ownerId nor nativeSessionId is given', async () => {
    const rec = recordingSql([{ owner_id: 'x' }]);
    fakeSql = rec.sql;
    expect(await getSessionBrief({})).toBeNull();
    expect(rec.calls).toHaveLength(0); // never queries without a key
  });

  it('returns null (not throw) when sql errors', async () => {
    fakeSql = () => Promise.reject(new Error('boom'));
    expect(await getSessionBrief({ ownerId: 'su-test-ei1742' })).toBeNull();
  });

  it('returns null when the owner has no brief row', async () => {
    fakeSql = recordingSql([]).sql;
    expect(await getSessionBrief({ ownerId: 'nobody' })).toBeNull();
  });

  it('maps a row to a SessionBriefRecord (by ownerId)', async () => {
    fakeSql = recordingSql([
      {
        owner_id: 'su-test-ei1742',
        workspace_id: 'papercusp-workspace',
        owner_label: 'su · test',
        source: 'omp-hook-session',
        intent: 'continue the lane',
        current_plan_slug: 'plan-x',
        current_files: ['a.ts'],
        harness_slug: 'papercusp',
        hive_slug: null,
        native_session_id: null,
        first_seen_at: '2026-06-20T00:00:00Z',
        updated_at: '2026-06-20T05:00:00Z',
      },
    ]).sql;
    const rec = await getSessionBrief({ ownerId: 'su-test-ei1742' });
    expect(rec).not.toBeNull();
    expect(rec?.ownerId).toBe('su-test-ei1742');
    expect(rec?.intent).toBe('continue the lane');
    expect(rec?.currentPlanSlug).toBe('plan-x');
    expect(rec?.currentFiles).toEqual(['a.ts']);
    expect(rec?.updatedAt).toBe('2026-06-20T05:00:00Z');
  });

  it('queries by native_session_id when only that is given', async () => {
    const rec = recordingSql([]);
    fakeSql = rec.sql;
    await getSessionBrief({ nativeSessionId: '6b161799-abcd' });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toContain('6b161799-abcd');
  });
});
