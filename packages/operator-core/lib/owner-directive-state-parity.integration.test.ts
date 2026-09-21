/**
 * owner-directive-state-parity.integration.test.ts — real-PG proof for P-005 of plan
 * `turn-start-memory-two-class-2026-09-21` (the `orders:list` state filter).
 *
 * WHY THIS FILE EXISTS. The five-state lifecycle precedence is expressed TWICE: once as
 * the pure `ownerDirectiveState()` in TypeScript, and once as a SQL `CASE` inside
 * `listOwnerDirectives()` so the predicate can run in the database. Two expressions of
 * one rule drift silently, and the drift is invisible in the worst way: the filter would
 * start disagreeing with the `state` field it returns on the very same row, so
 * `orders:list { state:'pending' }` could omit a directive whose own rendered state reads
 * `pending`. No typecheck sees that — the types are identical either way.
 *
 * The load-bearing assertion is therefore not "the filter returns rows" but the PARTITION
 * test plus the per-state agreement: filtering by S must return exactly the rows whose
 * INDEPENDENTLY-derived TS state is S, and the five states must classify every row exactly
 * once. Change either expression alone and that fails.
 *
 * The last test pins the property that motivated the filter at all: the predicate is
 * applied in SQL BEFORE `limit`. Filtering client-side over a limited page cannot do this
 * — a matching row truncated away by non-matching rows ahead of it reads as a genuine
 * absence, which is the bounded-instrument failure the old boolean `open` had.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  OWNER_DIRECTIVE_STATES,
  dismissOwnerDirective,
  dispositionOwnerDirective,
  listOwnerDirectives,
  ownerDirectiveState,
  promoteOwnerDirective,
  recordOwnerDirective,
  type OwnerDirectiveState,
} from './owner-directives';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('owner-directive lifecycle state: SQL filter vs TS derivation (P-005)', () => {
  let db: OrgTestDb;
  const workspaceId = 'owner-directive-state-parity-ws';
  /** One row deliberately manufactured into each of the five lifecycle states. */
  const expectedByState = new Map<OwnerDirectiveState, number>();

  async function record(
    turnRef: string,
    text: string,
    captureStatus: 'pending' | 'open',
  ): Promise<number> {
    const row = await recordOwnerDirective(
      {
        workspaceId,
        sessionRef: 'session-parity',
        sourceTurnRef: turnRef,
        verbatimText: text,
        recordedBy: 'su-parity-test',
        captureStatus,
      },
      db.adminSql,
    );
    return row.id;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();

    // pending — hook-captured, not yet resolved.
    expectedByState.set('pending', await record('turn-pending', 'a pending turn', 'pending'));

    // open — recorded straight to open (the orders:record path).
    expectedByState.set('open', await record('turn-open', 'an open directive', 'open'));

    // dismissed — a pending row explicitly dismissed with a reason.
    const toDismiss = await record('turn-dismissed', 'thinking aloud, not an order', 'pending');
    expect(
      (
        await dismissOwnerDirective(
          { id: toDismiss, reason: 'owner was musing, not directing', dismissedBy: 'su-parity-test' },
          db.adminSql,
        )
      ).ok,
    ).toBe(true);
    expectedByState.set('dismissed', toDismiss);

    // done — promoted out of pending, then dispositioned done.
    const toDo = await record('turn-done', 'please do the thing', 'pending');
    expect((await promoteOwnerDirective({ id: toDo, promotedBy: 'su-parity-test' }, db.adminSql)).ok).toBe(
      true,
    );
    await dispositionOwnerDirective(
      { id: toDo, status: 'done', note: 'carried out, see WI-parity', dispositionedBy: 'su-parity-test' },
      db.adminSql,
    );
    expectedByState.set('done', toDo);

    // declined — recorded open, then consciously refused. Newest row, which the
    // limit-ordering test below depends on.
    const toDecline = await record('turn-declined', 'please do the other thing', 'open');
    await dispositionOwnerDirective(
      {
        id: toDecline,
        status: 'declined',
        note: 'out of scope; explained to owner',
        dispositionedBy: 'su-parity-test',
      },
      db.adminSql,
    );
    expectedByState.set('declined', toDecline);
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup?.();
  });

  it('CONTROL: the fixture really populates all five states (else every filter below passes vacuously)', async () => {
    const all = await listOwnerDirectives({ workspaceId, limit: 200 }, db.adminSql);
    expect(all).toHaveLength(5);
    expect(all.map((r) => ownerDirectiveState(r)).sort()).toEqual([...OWNER_DIRECTIVE_STATES].sort());
  });

  it.each([...OWNER_DIRECTIVE_STATES])(
    'state=%s returns exactly the rows whose independently-derived TS state matches',
    async (state) => {
      const rows = await listOwnerDirectives({ workspaceId, state, limit: 200 }, db.adminSql);
      // The SQL predicate selected precisely the expected row...
      expect(rows.map((r) => r.id)).toEqual([expectedByState.get(state)]);
      // ...and the TS derivation independently agrees about what that row is.
      expect(rows.map((r) => ownerDirectiveState(r))).toEqual([state]);
    },
  );

  it('the five states PARTITION the population — every row classified exactly once', async () => {
    const seen: number[] = [];
    for (const state of OWNER_DIRECTIVE_STATES) {
      const rows = await listOwnerDirectives({ workspaceId, state, limit: 200 }, db.adminSql);
      seen.push(...rows.map((r) => r.id));
    }
    const all = await listOwnerDirectives({ workspaceId, limit: 200 }, db.adminSql);
    expect([...seen].sort()).toEqual(all.map((r) => r.id).sort());
    expect(new Set(seen).size).toBe(seen.length); // no row claimed by two states
  });

  it('accepts a state ARRAY and unions them', async () => {
    const rows = await listOwnerDirectives(
      { workspaceId, state: ['pending', 'dismissed'], limit: 200 },
      db.adminSql,
    );
    expect(rows.map((r) => ownerDirectiveState(r)).sort()).toEqual(['dismissed', 'pending']);
  });

  it('REGRESSION: the boolean `open` BUNDLES states and cannot isolate them', async () => {
    // This is the defect P-005 exists to fix, pinned so nobody "simplifies" the
    // filter back into the boolean.
    const openTrue = await listOwnerDirectives({ workspaceId, open: true, limit: 200 }, db.adminSql);
    expect(openTrue.map((r) => ownerDirectiveState(r)).sort()).toEqual(['open', 'pending']);

    const openFalse = await listOwnerDirectives({ workspaceId, open: false, limit: 200 }, db.adminSql);
    expect(openFalse.map((r) => ownerDirectiveState(r)).sort()).toEqual([
      'declined',
      'dismissed',
      'done',
    ]);
  });

  it('applies the predicate BEFORE limit — a match is not truncated away by non-matches ahead of it', async () => {
    // `declined` is the NEWEST row and ordering is created_at ASC, so four
    // non-matching rows sit ahead of it. A client-side filter over a 1-row page
    // would see nothing and read that as "no declined directives exist".
    const rows = await listOwnerDirectives({ workspaceId, state: 'declined', limit: 1 }, db.adminSql);
    expect(rows).toHaveLength(1);
    expect(ownerDirectiveState(rows[0])).toBe('declined');

    // CONTROL: the same limit WITHOUT the filter returns a different (older) row,
    // proving the limit really was small enough to have hidden the match.
    const unfiltered = await listOwnerDirectives({ workspaceId, limit: 1 }, db.adminSql);
    expect(unfiltered).toHaveLength(1);
    expect(ownerDirectiveState(unfiltered[0])).not.toBe('declined');
  });
});
