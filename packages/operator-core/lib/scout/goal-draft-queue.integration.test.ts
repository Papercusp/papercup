/**
 * goal-draft-queue.integration.test.ts — WI-39879 / plan
 * blender-goal-amendment-rail-2026-08-19 P-001, against REAL migrated Postgres
 * (migration 623, `harness_shared.scout_cycle_stage_artifacts`).
 *
 * ## What this proves that the unit test cannot
 * `goal-draft-queue.test.ts` covers the PURE selection with a fake pg whose `sql`
 * tag returns whatever the fixture hands it. That proves the predicate, and nothing
 * about the statement: a wrong column name, a missing workspace predicate, or a
 * jsonb column the driver hands back as a STRING rather than a parsed array would
 * all sail through it — and each of those fails the same silent way, an empty array
 * that reads exactly like "the corpus has no drafts" (the change-feed-deps Phase-7
 * lesson quoted in routed-ledger.integration.test.ts). So this file runs the REAL
 * `readGoalDraftQueue` — its own SELECT, its own jsonb decode — against the real
 * migrated schema, and every non-empty assertion below is paired with a control
 * that must come back EMPTY, so a query that silently matched nothing cannot pass.
 *
 * ## The fixture is a real production row, not an invention
 * `LIVE_SP_001` is the proposal persisted by cycle `scout-1786878027729`
 * (workspace `papercusp-workspace`, 2026-08-16T11:03:51Z), transcribed verbatim.
 * It is the ONLY override-path candidate in the entire retained corpus — measured
 * 2026-08-19 across all 30 retained cycles / 106 proposals, zero on the 'asked'
 * path and exactly one on 'override'. Using invented text here would have quietly
 * made this a test of the fixture author's idea of a goal-scale proposal.
 *
 * ## ⚠ The finding this file pins: that one live draft is a FALSE POSITIVE
 * SP-001 is a proposal about a data-driven tool-policy TABLE. It reaches the goal
 * rail only because the literal string `goal mode` appears inside a quoted SQL
 * value in its `mechanism` (`reason='goal mode: delegate, do not natively mutate'`)
 * — not because the idea is goal-scale. Verified field-by-field: the marker is
 * absent from framing, bet and whyNew, and present only in mechanism.
 *
 * That is exactly the incidental match `GoalDraft.matchedMarkers` was added to
 * expose ("a marker like 'campaign' can match incidentally, and a reader deciding
 * whether to trust this draft needs to see WHICH word triggered it"), so this file
 * asserts the marker set rather than just the count — a draft queue that reported
 * this as an unqualified goal-scale ask would be actively misleading, and the
 * assertion below is what would fail if that regressed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { Proposal } from './types';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));

const { readGoalDraftQueue } = await import('./goal-draft-queue');
const { DEFAULT_GOAL_BUDGET_CENTS, GOAL_SCALE_MARKERS } = await import('./router');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'papercusp-workspace';
/** A second tenant holding the SAME row — the falsifier for the scope predicate. */
const OTHER_WS = 'ws-goal-draft-other-tenant';

/**
 * Cycle `scout-1786878027729`, proposal SP-001 — verbatim from production.
 * Do NOT "tidy" this text: the marker match is a property OF these bytes.
 */
const LIVE_SP_001: Proposal = {
  id: 'SP-001',
  framing:
    "Policy enforcement changes that should take seconds (block an edit, require approval for a write) currently require a full git→gate→deploy cycle that is blocked by a GitHub 403, a red release gate (8h43m), and a 229-commit promotion lag. The 'never-implements regression' fix is already written but cannot ship. Every future enforcement fix will hit the same wall unless the load-bearing assumption — that policy lives in compiled code — is removed.",
  mechanism:
    "Ship one generic PreToolUse policy interpreter once (via the same live-config-read path that settings-are-data already validates, avoiding a new binary deploy). On every tool call it reads `harness_shared.tool_policies` WHERE scope matches the session's bound goal_id and mode (binding proven solid by mode-and-subject-integrity). Each row is a tuple: {tool_name, path_glob_or_arg_pattern, action: deny|allow|require-approval, reason}. Activating a new enforcement rule becomes a database INSERT, not a commit. The immediate fix for the never-implements regression becomes: INSERT INTO tool_policies (goal_id='EI-20581099901890760', tool_name IN ('Edit','Write'), action='deny', reason='goal mode: delegate, do not natively mutate') — zero git involvement.",
  whyNew:
    "launch_settings.defaults is already confirmed data-driven (settings-are-data 2/2), but that covers launch arguments, not in-session tool gating. No existing data-driven PreToolUse policy table is evidenced in the digest — only claim-specs and launch_settings are confirmed live-read. The novel step is extending the proven live-read pattern one layer further: from 'what goals start with' to 'what tools goals are allowed to call at runtime'.",
  bet: "Every enforcement rule in the class 'block or gate tool X for mode Y' permanently escapes the git→gate→deploy wall. Iteration time drops from hours-to-days (blocked by 403/gate/promotion lag) to seconds (a DB insert). The never-implements regression is fixable today. Future goal-mode policy changes never need a deploy.",
  cheapExperiment: {
    hypothesis:
      'No data-driven PreToolUse policy table already exists under another name; and the live-config-read path used by settings-are-data is reachable from the PreToolUse hook without a new binary deploy.',
    method:
      'Query harness_shared (and any aliased schema) for tables with columns matching {tool_name, action, goal_id/mode}. Separately, trace the code path the settings-are-data reader uses and confirm whether the PreToolUse hook executes in the same process/runtime context that can call that reader without a redeploy.',
    falsifiableSignal:
      "Either (a) a policy table already exists under a different name — meaning the mechanism already exists and the problem is configuration, not architecture — or (b) the PreToolUse hook runs in a separate sandboxed process that cannot reach the live-config-read path without a binary update, meaning the 'ship once via live-config' assumption is false and a deploy is still required.",
  },
  routeHint: 'plan',
  sourceIdeaIds: ['scout-idea-constraint-removal-0-0'],
  addressesPatternRefs: [
    'rubric:goal-mode-e2e#never-implements',
    'rubric:goal-mode-e2e#settings-are-data',
    'fact:workspace:wall:origin-push-blocked-github-403-email-verify',
    'pipeline:gate',
    'niche:v1:empty:module|execution|medium',
  ],
};

/** A plan-hinted proposal with NO goal-scale vocabulary — routed normally, never a draft. */
const ORDINARY: Proposal = {
  id: 'SP-002',
  framing: 'Cache the digest read behind a short TTL',
  mechanism: 'memoize the corpus digest for 60s',
  whyNew: 'the digest is recomputed per ideator today',
  bet: 'cycle latency drops',
  cheapExperiment: {
    hypothesis: 'the digest read dominates cycle latency',
    method: 'time one cycle with and without the memo',
    falsifiableSignal: 'under a 10% latency delta',
  },
  routeHint: 'plan',
  sourceIdeaIds: ['idea-ordinary'],
  addressesPatternRefs: [],
};

describe('goal draft queue (real PG, migration 623)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    const sql = db.adminSql;

    // The real cycle, with the ordinary proposal alongside it — so a match on
    // SP-001 is a match on the PREDICATE, not on "the only row present".
    await sql`
      INSERT INTO harness_shared.scout_cycle_stage_artifacts
        (workspace_id, cycle_id, proposals, created_at)
      VALUES (${WS}, 'scout-1786878027729',
              ${sql.json([LIVE_SP_001, ORDINARY] as never)},
              '2026-08-16T11:03:51.848Z')`;

    // A NEWER cycle carrying no drafts — proves `limit` bounds CYCLES scanned.
    await sql`
      INSERT INTO harness_shared.scout_cycle_stage_artifacts
        (workspace_id, cycle_id, proposals, created_at)
      VALUES (${WS}, 'scout-newer-no-drafts',
              ${sql.json([ORDINARY] as never)},
              '2026-08-17T00:00:00.000Z')`;

    // proposals IS NULL — the WHERE clause must exclude it (a null jsonb reaching
    // selectGoalDrafts would be tolerated, so only the SQL can be at fault here).
    await sql`
      INSERT INTO harness_shared.scout_cycle_stage_artifacts
        (workspace_id, cycle_id, proposals, created_at)
      VALUES (${WS}, 'scout-null-proposals', NULL, '2026-08-18T00:00:00.000Z')`;

    // The SAME draft under a different tenant — the scope falsifier.
    await sql`
      INSERT INTO harness_shared.scout_cycle_stage_artifacts
        (workspace_id, cycle_id, proposals, created_at)
      VALUES (${OTHER_WS}, 'scout-other-tenant',
              ${sql.json([LIVE_SP_001] as never)},
              '2026-08-16T11:03:51.848Z')`;
  }, 120_000);

  afterAll(async () => {
    await db?.close?.();
  });

  it('returns the real override-path draft from a persisted stage-artifact row', async () => {
    const drafts = await readGoalDraftQueue({ workspaceId: WS });

    // Exactly one, from the real cycle — the ordinary proposal beside it, the
    // null-proposals row, and the other tenant's copy are all correctly absent.
    expect(drafts).toHaveLength(1);
    const [draft] = drafts;
    expect(draft!.cycleId).toBe('scout-1786878027729');
    expect(draft!.path).toBe('override');
    expect(draft!.proposal.id).toBe('SP-001');

    // The model asked for 'plan' and got it — nothing was dropped at intake. This
    // is the D-011 point in assertion form: intake is NOT what gates the goal rail.
    expect(draft!.askedRail).toBeNull();
    expect(draft!.proposal.routeHint).toBe('plan');
  });

  it('names the single marker that triggered it — the match is INCIDENTAL', async () => {
    const [draft] = await readGoalDraftQueue({ workspaceId: WS });

    // One marker, and it is 'goal mode'.
    expect(draft!.matchedMarkers).toEqual(['goal mode']);

    // ...which appears ONLY inside a quoted SQL value in the mechanism. If a
    // future edit made this proposal genuinely goal-scale, these would change and
    // this test SHOULD fail — the point is that today it is a vocabulary artifact.
    const p = draft!.proposal;
    expect(p.mechanism.toLowerCase()).toContain("reason='goal mode:");
    expect(p.framing.toLowerCase()).not.toContain('goal mode');
    expect((p.bet ?? '').toLowerCase()).not.toContain('goal mode');
    expect((p.whyNew ?? '').toLowerCase()).not.toContain('goal mode');
  });

  it('drafts the rails the goal rail WOULD have used, from the proposal itself', async () => {
    const [draft] = await readGoalDraftQueue({ workspaceId: WS });

    expect(draft!.title).toBe(
      'Policy enforcement changes that should take seconds (block an edit, require approval for a write) currently require a full git→gate→deploy cycle that is blocked by a GitHub 403, a red release gate (8h43m), and a 229-commit promotion lag. The \'never-implements regression\' fix is already written but cannot ship. Every future enforcement fix will hit the same wall unless the load-bearing assumption — that policy lives in compiled code — is removed.'.slice(
        0,
        draft!.title.length,
      ),
    );
    expect(draft!.budgetCents).toBe(DEFAULT_GOAL_BUDGET_CENTS);
    // Drafted from the proposal's OWN falsifiable signal, not a placeholder.
    expect(draft!.killCriterion).toContain('a policy table already exists under a different name');
  });

  it('CONTROL: the same row under another tenant is not returned', async () => {
    // The falsifier for every non-empty assertion above. If the workspace
    // predicate were dropped, this returns the draft and the suite goes red.
    const mine = await readGoalDraftQueue({ workspaceId: WS });
    const theirs = await readGoalDraftQueue({ workspaceId: OTHER_WS });

    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.cycleId).toBe('scout-other-tenant');
    // Same proposal, strictly partitioned by tenant — neither leaks into the other.
    expect(mine[0]!.cycleId).not.toBe(theirs[0]!.cycleId);

    // And a workspace with no artifacts at all reads empty rather than erroring.
    expect(await readGoalDraftQueue({ workspaceId: 'ws-with-nothing-in-it' })).toEqual([]);
  });

  it('bounds CYCLES scanned, not drafts returned', async () => {
    // limit:1 reads only the NEWEST cycle (scout-null-proposals is excluded by the
    // WHERE, so the newest READ cycle is scout-newer-no-drafts) — which holds no
    // draft. The real cycle is older and therefore out of range.
    expect(await readGoalDraftQueue({ workspaceId: WS, limit: 1 })).toEqual([]);
    // Widen the window and it comes back: the row was always there.
    expect(await readGoalDraftQueue({ workspaceId: WS, limit: 30 })).toHaveLength(1);
  });

  it('honours a caller-supplied marker vocabulary (the P-009 config seam)', async () => {
    // Drop 'goal mode' from the vocabulary and the incidental match disappears —
    // which is the concrete lever for the false positive this file documents.
    const without = GOAL_SCALE_MARKERS.filter((m) => m !== 'goal mode');
    expect(await readGoalDraftQueue({ workspaceId: WS, markers: without })).toEqual([]);
  });

  it('WRITES NOTHING — the corpus is byte-identical after a read', async () => {
    const sql = db.adminSql;
    const before = await sql`
      SELECT count(*)::int AS n, coalesce(md5(string_agg(proposals::text, '|' ORDER BY cycle_id)), '') AS digest
        FROM harness_shared.scout_cycle_stage_artifacts`;

    await readGoalDraftQueue({ workspaceId: WS });
    await readGoalDraftQueue({ workspaceId: OTHER_WS });

    const after = await sql`
      SELECT count(*)::int AS n, coalesce(md5(string_agg(proposals::text, '|' ORDER BY cycle_id)), '') AS digest
        FROM harness_shared.scout_cycle_stage_artifacts`;

    // The module's safety argument, asserted against real Postgres rather than a
    // statement recorder: no row added, removed, or mutated by reading the queue.
    expect(after[0]!.n).toBe(before[0]!.n);
    expect(after[0]!.digest).toBe(before[0]!.digest);

    // And nothing reached the goals table — the queue holds no write port at all.
    const goals = await sql`
      SELECT count(*)::int AS n FROM harness_shared.goals WHERE workspace_id = ${WS}`;
    expect(goals[0]!.n).toBe(0);
  });
});
