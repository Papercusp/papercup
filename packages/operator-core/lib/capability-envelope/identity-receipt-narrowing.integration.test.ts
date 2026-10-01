/**
 * Real-PostgreSQL contract for the identity gate's narrowed body read
 * (WI-10004801, #1155): the SQL in `selectNarrowedLaunchSpecBody` must return
 * exactly what `narrowIdentityHistory` states, for every record shape the
 * column can hold, and must return the record whole when asked to.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { narrowIdentityHistory, selectNarrowedLaunchSpecBody } from './identity-receipt-narrowing';

const { createOrgTestDb } = await import('../../test/_org-test-db');

const A = { specificationRevision: 'a'.repeat(64), stateRevision: 'state-a' };
const B = { specificationRevision: 'b'.repeat(64), stateRevision: 'state-b' };
const C = { specificationRevision: 'c'.repeat(64), stateRevision: 'state-c' };
const receipt = (pair: typeof A, tag: string) => ({ ...pair, specificationArtifact: { tag, bytes: 'x'.repeat(256) } });

const WORKSPACE = 'identity-receipt-narrowing-ws';
const OWNER = 'su-narrowing-owner';

const SPECS: Array<[string, unknown]> = [
  ['history matches once and other entries are dropped', {
    ...receipt(C, 'top'), workspaceId: WORKSPACE, harnessSlug: 'h',
    identityHistory: [receipt(B, 'b'), receipt(A, 'a'), receipt(C, 'older-c')],
  }],
  ['the state revision must match too, not just the specification revision', {
    ...receipt(C, 'top'),
    identityHistory: [{ ...receipt(A, 'same-spec-other-state'), stateRevision: 'state-other' }, receipt(A, 'a')],
  }],
  ['duplicates keep stored order', {
    ...receipt(C, 'top'), identityHistory: [receipt(A, 'first'), receipt(B, 'b'), receipt(A, 'second')],
  }],
  ['junk entries never survive', {
    ...receipt(C, 'top'), identityHistory: [7, 'x', null, [receipt(A, 'nested')], receipt(A, 'a')],
  }],
  ['type-exact equality: a numeric revision does not match its string', {
    ...receipt(C, 'top'), identityHistory: [{ specificationRevision: 1, stateRevision: 'state-a' }],
  }],
  ['history that is not an array is returned as stored', { ...receipt(C, 'top'), identityHistory: receipt(A, 'a') }],
  ['no history key is returned as stored', { ...receipt(A, 'top') }],
  ['a non-object record is returned as stored', ['not', 'an', 'object']],
  ['a scalar record is returned as stored', 'scalar'],
];

describe('selectNarrowedLaunchSpecBody (real PostgreSQL, WI-10004801)', () => {
  let db: OrgTestDb;
  const ids = new Map<string, number>();

  beforeAll(async () => {
    db = await createOrgTestDb();
    for (const [name, spec] of SPECS) {
      const [row] = await db.adminSql<Array<{ id: number }>>`
        INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, launch_spec)
        VALUES (${WORKSPACE}, 'console', ${OWNER}, ${JSON.stringify(spec)}::text::jsonb)
        RETURNING id`;
      ids.set(name, Number(row.id));
    }
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  for (const [name, spec] of SPECS) {
    for (const revisions of [[A], [A, B], [], [{ specificationRevision: '1', stateRevision: 'state-a' }]]) {
      it(`${name} — ${JSON.stringify(revisions.map((pair) => pair.stateRevision))}`, async () => {
        const rows = await selectNarrowedLaunchSpecBody(db.adminSql, {
          advSessionId: ids.get(name)!, ownerId: OWNER, workspaceId: WORKSPACE, revisions,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].launch_spec).toEqual(narrowIdentityHistory(spec, revisions));
        expect(typeof rows[0].launch_spec_xmin).toBe('string');
      });
    }
  }

  it('reads the record whole when no receipts are requested, or when a pair is malformed', async () => {
    const name = SPECS[0][0];
    for (const revisions of [null, [{ specificationRevision: A.specificationRevision }]]) {
      const rows = await selectNarrowedLaunchSpecBody(db.adminSql, {
        advSessionId: ids.get(name)!, ownerId: OWNER, workspaceId: WORKSPACE, revisions,
      });
      expect(rows[0].launch_spec).toEqual(SPECS[0][1]);
    }
  });

  it('keeps the selection scoped to the row, owner and workspace', async () => {
    const id = ids.get(SPECS[0][0])!;
    const rows = await Promise.all([
      selectNarrowedLaunchSpecBody(db.adminSql, { advSessionId: id, ownerId: 'someone-else', workspaceId: WORKSPACE, revisions: [A] }),
      selectNarrowedLaunchSpecBody(db.adminSql, { advSessionId: id, ownerId: OWNER, workspaceId: 'other-ws', revisions: [A] }),
    ]);
    expect(rows.map((r) => r.length)).toEqual([0, 0]);
  });
});
