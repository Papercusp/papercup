/**
 * owner-directive-action-verdict.integration.test.ts — real-PG proof for
 * `directiveActionVerdict`, the authority gate shared by BOTH directive-clearing
 * verbs (`orders:clear` and `orders:disposition`; `orders:clear` is the former
 * `orders:resolve-pending`, whose promote/dismiss half was retired by D-001 of
 * `owner-directive-delivery-redesign-2026-09-22`).
 *
 * WHY THIS FILE EXISTS, given the handler suites (clear.test.ts and
 * disposition-foreign-directive.test.ts) already pass between them.
 * Both MOCK `directiveActionVerdict` outright (`vi.mock('../../owner-directive-agenda')`)
 * and assert only on how the handler branches over a verdict object handed to it. That is
 * the right call at that layer — those files have no database — but it means the function's
 * own SQL had never once been executed by a test.
 *
 * It was wrong. The holders lookup selected `assignee` from `harness_shared.work_items`,
 * which has no such column (claim ownership is `taken_by` there; `assignee` is the
 * ISSUE-family spelling, and `pg-read-query.ts` even ships a redirect hint for exactly
 * this confusion). So the query did not merely miss rows — it THREW
 * `column "assignee" does not exist`, taking out every dismiss/disposition path
 * fleet-wide for any caller who was not the directive's own addressee, while the mocked
 * suites stayed green.
 *
 * The regression case below is therefore the NON-ADDRESSEE one: that is the branch that
 * reaches the holders query at all. An addressee returns before it and would have stayed
 * green through the entire outage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { directiveActionVerdict } from './owner-directive-agenda';
import { recordOwnerDirective } from './owner-directives';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('directiveActionVerdict (real PG)', () => {
  let db: OrgTestDb;
  const workspaceId = 'directive-action-verdict-ws';
  const harnessSlug = 'papercusp';

  async function recordFrom(recordedBy: string, turnRef: string): Promise<number> {
    const row = await recordOwnerDirective(
      {
        workspaceId,
        sessionRef: `session-${recordedBy}`,
        sourceTurnRef: turnRef,
        verbatimText: 'an owner turn captured against one session',
        recordedBy,
      },
      db.adminSql,
    );
    return row.id;
  }

  async function linkWorkItem(featureId: string, directiveId: number, takenBy: string, status: string) {
    await db.adminSql`
      INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, directive_ref, taken_by, status)
      VALUES (${workspaceId}, ${harnessSlug}, ${featureId}, ${directiveId}, ${takenBy}, ${status})
    `;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup?.();
  });

  it('CALIBRATION: the addressee is allowed — else every case below is unobservable', async () => {
    const id = await recordFrom('su-addressee', 'turn-calibration');
    await expect(
      directiveActionVerdict({ directiveId: id, ownerId: 'su-addressee', workspaceId }, db.adminSql),
    ).resolves.toMatchObject({ allowed: true, because: 'addressee' });
  });

  it('REGRESSION: a NON-addressee gets a real verdict instead of a thrown column error', async () => {
    const id = await recordFrom('su-addressee', 'turn-foreign');

    // Before the fix this rejected with `column "assignee" does not exist`. The assertion
    // that matters is that it RESOLVES at all; the shape is checked for good measure.
    const verdict = await directiveActionVerdict(
      { directiveId: id, ownerId: 'su-someone-else', workspaceId },
      db.adminSql,
    );

    expect(verdict).toMatchObject({ allowed: false, addressedTo: 'su-addressee', holders: [] });
  });

  it('a non-terminal linked work-item grants its HOLDER authority', async () => {
    const id = await recordFrom('su-addressee', 'turn-held');
    await linkWorkItem('WI-verdict-open', id, 'su-holder', 'open');

    await expect(
      directiveActionVerdict({ directiveId: id, ownerId: 'su-holder', workspaceId }, db.adminSql),
    ).resolves.toMatchObject({ allowed: true, because: 'holds-linking-work-item' });
  });

  it('a TERMINAL linked work-item does NOT keep granting its holder authority', async () => {
    const id = await recordFrom('su-addressee', 'turn-done');
    await linkWorkItem('WI-verdict-done', id, 'su-stale-holder', 'done');

    const verdict = await directiveActionVerdict(
      { directiveId: id, ownerId: 'su-stale-holder', workspaceId },
      db.adminSql,
    );

    // The holder is reported as absent, not merely unauthorized: a done item must drop
    // out of the holders set entirely.
    expect(verdict).toMatchObject({ allowed: false, addressedTo: 'su-addressee', holders: [] });
  });

  it('an unknown directive id is notFound rather than an error', async () => {
    await expect(
      directiveActionVerdict({ directiveId: 2_147_483_000, ownerId: 'su-anyone', workspaceId }, db.adminSql),
    ).resolves.toMatchObject({ allowed: false, notFound: true });
  });
});
