/**
 * R-3, live plane — grader recruitment is IDEMPOTENT, and a pickup verdict is
 * THREE-VALUED with `not-yet` and `unreadable` each leaving the grader in place.
 *
 * Real PG on purpose, for two different reasons.
 *
 * 1. The pickup verdict is computed from the grader's OWN activity timestamps
 *    read out of `harness_shared.coord_presence` (plus the ingested transcript
 *    leg). A unit test hands `classifyGraderPickup` a literal reading, so it
 *    proves the comparison and nothing about whether the production reader
 *    supplies the thing being compared. Here `observeGraderPickup` runs with its
 *    DEFAULT reader — `prodReadGraderActivity`, no injection — against rows this
 *    test really wrote.
 *
 * 2. ⚠ "Neither re-recruits nor re-wakes" is a NEGATIVE, and the agreed spec
 *    (WI-10002379) requires it OBSERVED rather than inferred from a call count
 *    on a mock. So the discovery and cascade legs are left REAL: if the dedup
 *    guard failed, `prodOpenGradingCascade` would write a `consult_state` row
 *    and a conversation. The assertion is therefore that those durable
 *    populations are UNCHANGED across a second resolve — a fact about the
 *    database, not about a spy.
 *
 * `not-yet` is the failure mode that regresses silently, because the "safe"
 * reflex on an inconclusive probe is to re-recruit — and D-009 independence
 * makes the eligible pool non-replenishable, so every redundant dispatch
 * permanently shrinks it. Hence one explicit negative PER VERDICT.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { observeGraderPickup } from './acceptance-grader-pickup';
import { isInFlightAcceptanceGradingRequest, resolveAcceptanceGrader } from './acceptance-grader';
import { activeWorkspaceId } from './workspace-registry';

const { createOrgTestDb } = await import('../test/_org-test-db');
const { _resetHarnessAdminUrlCacheForTests } = await import('./embedded-pg-discovery');

const WORKSPACE = 'r3-grader-pickup-ws';
/**
 * ⚠ The grading-request row must live under the workspace `listWorkItems`
 * actually reads. That read is scoped by `activeWorkspaceId()` (an ambient
 * value), NOT by anything the caller passes — so seeding the row under this
 * file's own WORKSPACE constant makes the dedup guard find nothing and the
 * resolver falls through to a launch. That failure looks like "dedup is
 * broken" while really meaning "the fixture was invisible".
 */
const LIST_WORKSPACE = activeWorkspaceId();
const HARNESS = 'papercusp';
const PLAN_SLUG = 'r3-pickup-subject-plan';
const RUBRIC_ID = 'acceptance-r3-pickup-subject-plan';
const SAVED_ADMIN_URL = process.env.HARNESS_ADMIN_DATABASE_URL;

const WAKE_INSTANT_MS = Date.parse('2026-09-22T12:00:00.000Z');

/** Minimal LaunchCtx — resolve only reads identity/workspace off it. */
const ctx = {
  workspaceId: LIST_WORKSPACE,
  harnessSlug: HARNESS,
  ownerId: 'su-r3-shipper',
  emit: () => {},
} as unknown as Parameters<typeof resolveAcceptanceGrader>[1];

/** Counts of every durable trace a recruit-or-wake would leave. */
async function dispatchFootprint(db: OrgTestDb): Promise<{ consults: number; conversations: number; tasks: number }> {
  const [[consults], [conversations], [tasks]] = await Promise.all([
    db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.consult_state`,
    db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.coord_conversations`,
    db.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.work_items
       WHERE workspace_id = ${LIST_WORKSPACE} AND item_kind = 'task'`,
  ]);
  return { consults: consults.n, conversations: conversations.n, tasks: tasks.n };
}

describe('R-3 grader recruitment idempotence + three-valued pickup (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetHarnessAdminUrlCacheForTests();

    // Clear the store-identity pin, and warm the org-admin pool, HERE — not
    // inside a test. The first `getOrgPg()` after the env re-route notices its
    // target moved and logs a one-time `[db] org-admin pool rebound` warning —
    // which `vitest-fail-on-console` turns into a test failure attributed to
    // whichever case happened to be first. Absorbing it in setup keeps that
    // rebind from masquerading as a verdict about the subject.
    //
    // ⚠ The pin reset is load-bearing, not tidiness: `createOrgTestDb`
    // provisions through the real cluster on :5432, which pins store identity
    // THERE. Without clearing it, the production readers below
    // (`prodReadGraderActivity` → `getOrgPg()`, and the dedup read inside
    // `resolveAcceptanceGrader`) keep answering off the pinned store, so every
    // row this test seeds is invisible and all three verdicts collapse to
    // `unreadable` / a fall-through launch — a fixture fault wearing the
    // costume of a verdict about the subject.
    {
      const { getOrgPg, _resetStoreIdentityForTests } = await import('@papercusp/db-org');
      _resetStoreIdentityForTests();
      await getOrgPg().sql`SELECT 1`;
    }

    // Three graders, differing ONLY in what their own activity record says.
    await db.adminSql`
      INSERT INTO harness_shared.coord_presence
        (owner_id, owner_label, workspace_id, source, intent, host, last_active_at, heartbeat_at)
      VALUES
        -- activity strictly AFTER the wake ⇒ confirmed
        ('su-grader-confirmed', 'confirmed', ${WORKSPACE}, 'omp-hook-session', 'grading',
         '', ${new Date(WAKE_INSTANT_MS + 60_000).toISOString()}, now()),
        -- activity strictly BEFORE the wake ⇒ not-yet (no turn since the wake)
        ('su-grader-not-yet', 'not yet', ${WORKSPACE}, 'omp-hook-session', 'grading',
         '', ${new Date(WAKE_INSTANT_MS - 60_000).toISOString()}, now()),
        -- present but with NO readable activity instant ⇒ unreadable
        ('su-grader-unreadable', 'unreadable', ${WORKSPACE}, 'omp-hook-session', 'grading',
         '', NULL, now())`;

    // A REAL in-flight acceptance-grading request: HELD (a held request is
    // in-flight on `assignee` alone, with no recency window to age out mid-run)
    // and titled so the identity predicate matches.
    //
    // ⚠ The column is `taken_by` — `work_items` has no `assignee` and no
    // `created_by`; `listWorkItems` projects those names. Leaving authorship
    // unset is correct here: `createdBy` is read ONLY to exclude the
    // acceptance-drain actor (WI-10002453), and this request is not one.
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, summary, status, taken_by, last_progress_at)
      VALUES (
        ${LIST_WORKSPACE}, ${HARNESS}, 'EI-R3-GRADING-REQUEST', 'task',
        ${`Acceptance grading for plan ${PLAN_SLUG}`},
        ${`A non-implementer grader must run scorecards:emit against ${PLAN_SLUG}.`},
        'wip', 'su-grader-confirmed', now())`;
  }, 180_000);

  afterAll(async () => {
    if (SAVED_ADMIN_URL === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
    else process.env.HARNESS_ADMIN_DATABASE_URL = SAVED_ADMIN_URL;
    _resetHarnessAdminUrlCacheForTests();
    await db?.cleanup();
  });

  describe('the pickup verdict is three-valued, read from the grader\'s own record', () => {
    it('CONFIRMED — activity strictly after the wake, via the PRODUCTION reader', async () => {
      const { getOrgPg } = await import('@papercusp/db-org');
      const diag = await getOrgPg().sql`
        SELECT current_database() AS db,
               (SELECT count(*)::int FROM harness_shared.coord_presence) AS presence_rows,
               (SELECT count(*)::int FROM harness_shared.coord_presence WHERE owner_id = 'su-grader-confirmed') AS mine`;
      const obs = await observeGraderPickup({
        graderId: 'su-grader-confirmed',
        wakeInstantMs: WAKE_INSTANT_MS,
        nowMs: WAKE_INSTANT_MS + 120_000,
      });
      expect(`DIAG ${JSON.stringify(diag)} OBS ${JSON.stringify(obs)}`).toBe('SHOWME');
      expect(obs.verdict).toBe('confirmed');
      expect(obs.sinceWakeMs).toBeGreaterThan(0);
      // The reading came from a real row, not a literal handed to the classifier.
      expect(obs.source).not.toBeNull();
    });

    it('NOT-YET — activity predates the wake, and the grader is LEFT IN PLACE', async () => {
      const before = await dispatchFootprint(db);

      const obs = await observeGraderPickup({
        graderId: 'su-grader-not-yet',
        wakeInstantMs: WAKE_INSTANT_MS,
        nowMs: WAKE_INSTANT_MS + 120_000,
      });
      expect(obs.verdict).toBe('not-yet');
      expect(obs.sinceWakeMs).toBeLessThan(0);
      // ⛔ The negative this case exists for: an inconclusive probe is NOT a
      // licence to re-recruit. Observed as durable state, not as a spy count.
      expect(await dispatchFootprint(db)).toEqual(before);
    });

    it('UNREADABLE — no readable activity instant, and the grader is LEFT IN PLACE', async () => {
      const before = await dispatchFootprint(db);

      const obs = await observeGraderPickup({
        graderId: 'su-grader-unreadable',
        wakeInstantMs: WAKE_INSTANT_MS,
        nowMs: WAKE_INSTANT_MS + 120_000,
      });
      expect(obs.verdict).toBe('unreadable');
      // A failed measurement reports no instant at all — it must not be
      // downgraded into `not-yet`, which is a statement ABOUT the grader.
      expect(obs.graderLastActiveMs).toBeNull();
      expect(obs.sinceWakeMs).toBeNull();
      expect(await dispatchFootprint(db)).toEqual(before);
    });

    it('a grader with no record at all is unreadable, never absent-therefore-replaceable', async () => {
      const before = await dispatchFootprint(db);
      const obs = await observeGraderPickup({
        graderId: 'su-grader-never-existed',
        wakeInstantMs: WAKE_INSTANT_MS,
        nowMs: WAKE_INSTANT_MS + 120_000,
      });
      expect(obs.verdict).toBe('unreadable');
      expect(await dispatchFootprint(db)).toEqual(before);
    });
  });

  describe('recruitment is idempotent against an already-live grading', () => {
    it('the seeded request really is in-flight (instrument check)', async () => {
      const [row] = await db.adminSql<
        Array<{ title: string; summary: string; taken_by: string | null; created_ts: string; last_progress_at: string }>
      >`SELECT title, summary, taken_by, created_ts, last_progress_at
          FROM harness_shared.work_items WHERE feature_id = 'EI-R3-GRADING-REQUEST'`;
      expect(row).toBeTruthy();
      // If this predicate ever stops matching, every assertion below would pass
      // vacuously — the resolver would dedup on nothing and simply find no
      // eligible grader. Assert the premise rather than assume it.
      expect(
        isInFlightAcceptanceGradingRequest(
          {
            title: row.title,
            summary: row.summary,
            createdBy: null,
            assignee: row.taken_by,
            createdAt: new Date(row.created_ts).toISOString(),
            lastProgressAt: new Date(row.last_progress_at).toISOString(),
          } as Parameters<typeof isInFlightAcceptanceGradingRequest>[0],
          PLAN_SLUG,
          Date.now(),
        ),
      ).toBe(true);
    });

    it('a re-run neither re-recruits nor re-wakes — observed in durable state', async () => {
      // `readPlan` / `getRubric` are supplied so the resolver reaches its dedup
      // guard; everything the assertion depends on — the work-item listing that
      // finds the in-flight request, and the discovery + cascade legs that would
      // leave a trace if dedup failed — is left REAL.
      const deps = {
        readPlan: async () => ({
          row: { workspaceId: LIST_WORKSPACE, harnessSlug: HARNESS, planSlug: PLAN_SLUG, content: '' },
        }),
        getRubric: async () => ({ rubricId: RUBRIC_ID, revision: 4 }),
      } as unknown as Parameters<typeof resolveAcceptanceGrader>[2];

      const before = await dispatchFootprint(db);

      const first = await resolveAcceptanceGrader(PLAN_SLUG, ctx, deps);
      expect(first.state).toBe('deduped');
      expect((first as { existingWorkItemId?: string }).existingWorkItemId).toBe('EI-R3-GRADING-REQUEST');

      const second = await resolveAcceptanceGrader(PLAN_SLUG, ctx, deps);
      expect(second.state).toBe('deduped');
      // The SAME grading is pointed at — a second resolve did not open a rival.
      expect((second as { existingWorkItemId?: string }).existingWorkItemId).toBe(
        (first as { existingWorkItemId?: string }).existingWorkItemId,
      );

      // The load-bearing assertion: two resolves left the database exactly as
      // one found it. No new consult cascade (no re-recruit), no new
      // conversation (no re-wake), no second grading request.
      expect(await dispatchFootprint(db)).toEqual(before);
    });
  });
});
