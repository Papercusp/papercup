/**
 * claim-ssot-agreement.integration.test.ts — P-002 (work-item-claimability-clarity-2026-07-20):
 * the ANTI-DRIFT AGREEMENT between the two representations of the issue-family claim floors.
 *
 * P-001 (migration 654) landed a QUERYABLE SQL SSOT for the issue-family claim floors —
 * `harness_shared.work_item_claim_floors(...)` + the `harness_shared.work_items_claimable`
 * view — so a raw `dev:pg_query` / `admissibleOnly` read AGREES with what the scheduler
 * actually serves. But that SQL function is a HAND-TRANSLATION of the inline TS `sql`-tagged
 * floor fragments the real claim path (`claimNextIssueWorkItem`) ANDs into its
 * `UPDATE … WHERE … FOR UPDATE SKIP LOCKED`. Two hand-maintained copies of the same predicate
 * in two different engines (PL/pgSQL vs TS query-builder) are exactly the drift risk P-001
 * exists to kill — edit one floor and forget the other, and `work_items_claimable` silently
 * disagrees with the scheduler, re-opening the 2026-07-12 idle-fleet incident (a leader fed a
 * tranche `admissibleOnly:true` reported claimable that `scheduler:get_next` correctly refused).
 *
 * WHY A BINDING TEST, NOT A PHYSICAL MERGE (the P-002 "call the same predicate" wording).
 * A literal refactor — route `claimNextIssueWorkItem` through the SSOT view / function — is
 * NOT achievable without a federation-recovery REGRESSION, by the SSOT's own owner-ratified
 * design (see migration 654's header):
 *   • the OWN-NODE drift-recovery origin leg (admit a remote row whose author_pubkey is one
 *     THIS workspace also wrote locally — owner 2026-07-20 "these can't be truly remote") is a
 *     correlated self-join over the whole work_items table, so it is INTENTIONALLY not baked
 *     into the bulk view (the view uses the fail-safe origin-only form, which "only ever
 *     UNDER-admits"). The scheduler still applies the own-node leg with its live workspace
 *     context. ANDing the view can never RE-admit a row the view already dropped, so a
 *     "SELECT FROM the view" claim path would permanently strand this box's own federated bugs.
 *   • the PER-CLAIM floors (cross-machine-rig, swarm-affinity, redundancy, release-cooldown) and
 *     the own-LEASE plan-item exemption depend on the CLAIMING caller's capability/spec, not the
 *     row, so a generic "claimable by someone" view CANNOT bake them in.
 * So the two representations must stay PHYSICALLY SEPARATE, and the achievable "never diverge"
 * guarantee is this AGREEMENT TEST: for a seeded DB state, the SSOT view admits EXACTLY the
 * issue-family rows the inline claim path serves — MODULO the three deliberate, documented
 * divergences, each of which is pinned below so a future "alignment" that accidentally erases
 * one (breaking federation recovery or the fail-safe under-admit) reds HERE.
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   1. AGREEMENT — across every UNCONDITIONAL floor (not-open, taken, federated-remote,
 *      claim-hold, observation-lane, needs-human, external-blocker, federation-detector,
 *      loop-noise, already-completed, reserved-active-plan, other-owner-lease, blocked-dep,
 *      and their satisfied/admit counterparts) the view's membership set === the set the inline
 *      claim path drains, EXACTLY.
 *   2. DIVERGENCE A (per-claim rig floor) — the view admits a rig-gated row (SSOT omits per-claim
 *      floors); a default single-box claim does NOT serve it; a rigAvailable caller DOES.
 *   3. DIVERGENCE B (own-node drift recovery) — the view under-admits a remote own-authored row
 *      (fail-safe); the scheduler recovers it via the own-node origin leg.
 *   4. DIVERGENCE C (own-lease plan-item exemption) — the view excludes a plan-item under any
 *      live lease (caller-independent); the LEASE HOLDER can still claim it.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/claim-ssot-agreement.integration.test.ts
 * (or, from the repo root: npm run test:file -- \
 *     packages/operator-core/lib/scheduler/claim-ssot-agreement.integration.test.ts)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAG_DEFAULTS, type FlagKey } from '@papercusp/flags';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  USER_TRUST_LIST_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
/** Read a migration file for `sql.unsafe(...).simple()`, dropping psql meta / GRANT /
 *  bare BEGIN|COMMIT lines the simple-protocol bootstrap can't run (mirrors the sibling
 *  claim-issues-claimable.integration.test.ts helper). */
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
// Every flag resolves to its production default. We drive the ISSUE claim path DIRECTLY
// (claimNextIssueWorkItem), so SCHEDULER_ISSUES_CLAIMABLE (the ladder gate) is irrelevant here;
// resolveIssuesScopeWorkspace('default') returns 'default' on either ISSUES_PER_WORKSPACE branch
// because we pass the workspace explicitly.
vi.mock('@papercusp/flags/server', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return { ...actual, getFlag: async (key: FlagKey) => FLAG_DEFAULTS[key] ?? false };
});

const wi = await import('../work-items');

const H = 'papercup';
const WS = 'default'; // == DEFAULT_COORD_WORKSPACE; work_item_deps + issues live here
const OP = `operator:${WS}`; // operator-scope encoding (migration 382)
let db: FreshPgDb;

/** Seed one issue-family (or, for a blocker, feature-family) row on the work_items base,
 *  exposing every column the SSOT view / inline claim path key on. */
async function seed(
  id: string,
  o: {
    kind?: string;
    status?: string;
    takenBy?: string | null;
    origin?: string;
    authorPubkey?: string | null;
    harnessSlug?: string;
    title?: string;
    payload?: Record<string, unknown> | null;
    terminalOwner?: string | null;
    terminalCompletionRef?: string | null;
    swarmAffinity?: string | null;
    redundancy?: number | null;
    createdTs?: number;
  } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,
       created_ts, updated_ts, payload, origin, author_pubkey, title,
       terminal_owner, terminal_completion_ref, swarm_affinity, redundancy)
    VALUES (
      ${o.harnessSlug ?? H}, ${id}, ${o.kind ?? 'bug'}, ${o.status ?? 'open'}, ${o.takenBy ?? null}, ${WS},
      ${o.createdTs ?? 0}, 0,
      ${o.payload ? db.sql.json(o.payload as Parameters<typeof db.sql.json>[0]) : null},
      ${o.origin ?? 'local'}, ${o.authorPubkey ?? null}, ${o.title ?? id},
      ${o.terminalOwner ?? null}, ${o.terminalCompletionRef ?? null}, ${o.swarmAffinity ?? null}, ${o.redundancy ?? null})`;
}

/** A blocks edge (issue blocked_ref is BARE; feature blocker_ref is harness-qualified). */
async function blockEdge(blockedRef: string, blockerRef: string, blockedKind = 'issue', blockerKind = 'feature') {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, ${blockedKind}, ${blockedRef}, ${blockerKind}, ${blockerRef}, 'blocks')`;
}
// `opStatus` is the OPERATIONAL axis (started/paused/done — what plans:start / plans:pause
// write); `status` is the LIFECYCLE one. Floor #11 reads BOTH, and a plan that is genuinely
// RUNNING normally reads status='ready' + op_status='started' (EI-19409397800537963).
const seedPlan = (slug: string, status: string, opStatus: string | null = null) =>
  db.sql`INSERT INTO harness_shared.harness_plans (plan_slug, status, op_status)
          VALUES (${slug}, ${status}, ${opStatus})`;
const seedLease = (slug: string, itemId: string, owner: string, expiresMinFromNow: number) =>
  db.sql`INSERT INTO harness_shared.plan_item_claims (plan_slug, item_id, owner, expires_ts)
          VALUES (${slug}, ${itemId}, ${owner}, now() + make_interval(mins => ${expiresMinFromNow}))`;
const seedPlanLinkedIssue = (id: string, planSlug: string, itemId: string) =>
  seed(id, { kind: 'task', payload: { plan_item: { plan_slug: planSlug, item_id: itemId, harness_slug: H } } });

/** REPRESENTATION 1 — the SSOT: the issue-family rows the queryable view admits, scoped the
 *  SAME way the inline claim path scopes (this issue workspace + harness-or-operator slug). */
async function viewClaimableIds(): Promise<string[]> {
  const rows = await db.sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.work_items_claimable
     WHERE workspace_id = ${WS} AND harness_slug IN (${H}, ${OP})
     ORDER BY feature_id`;
  return rows.map((r) => r.feature_id);
}

/** REPRESENTATION 2 — the AUTHORITY: the rows the REAL inline claim path
 *  (`claimNextIssueWorkItem`) hands out. Drain by claiming with a plain, single-box caller and
 *  LEAVING each row taken (floor 2 excludes it next round), so the admissible set is enumerated
 *  exactly once with no cooldown/own-lease interference. Sorted for set comparison. */
async function drainInlineClaimIds(assignee = 'probe'): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 200; i++) {
    const claimed = (await wi.claimNextIssueWorkItem({ harness: H, assignee }, WS))?.id ?? null;
    if (!claimed) break;
    out.push(claimed);
  }
  return out.sort();
}

beforeAll(async () => {
  db = await createFreshPgDb('claim-ssot-agreement');
  h.sql = db.sql;
  await ensureCoordCapabilityTables(db.sql);
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL); // base work_items + hfc + engineer_issues + plan tables
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql
    .unsafe(`ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`)
    .simple();
  await db.sql.unsafe(readMigration('379-maintained-ready-column.sql')).simple();
  // P-001 (the thing under test): the SSOT function + view. Applying the REAL migration file (not
  // a re-typed copy) is the point — this test binds the migration's SQL to the TS claim path.
  await db.sql.unsafe(readMigration('654-work-item-claim-floors-ssot.sql')).simple();
  // EI-19409397800537963: re-points floor #11 at the OPERATIONAL plan axis (op_status
  // started/paused, not the lifecycle status alone) and tenant-scopes both plan subqueries.
  // Applied AFTER 654 for the same reason 654 itself is applied here rather than re-typed —
  // the migration chain, in order, is what this test binds the TS claim path to.
  await db.sql.unsafe(readMigration('744-plan-lane-floor-op-status.sql')).simple();
}, 180_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked,
                       harness_shared.harness_plans, harness_shared.plan_item_claims`;
});

// @covers INV-06
// Cited by dependency-subsystem-thorough-testing-2026-08-02 P-009 after READING the case
// below, not from this file's header. INV-06 is "every claim entry point applies the SAME
// blocking verdict", and the `blocked-dep` floor is exercised here in BOTH directions on one
// seed — WI-DEP-OK (terminal blocker) must appear in both sets, WI-DEP-BLOCKED (non-terminal
// blocker) in neither — with the PREVIEW door (the work_items_claimable SSOT view) and the
// real claim door (claimNextIssueWorkItem) asserted equal. That pair is exactly where D-007's
// drift was measured: the preview reported 0 blocked against the claim path's 5, so agents
// were handed items the door then refused. The proof was here all along and simply carried no
// citation — the same unattributed-coverage gap P-005 found across the whole corpus.
describe('work_items_claimable (SSOT view) admits EXACTLY the rows claimNextIssueWorkItem serves (P-002)', () => {
  it('agrees across every unconditional floor — the view membership set === the inline claim drain set', async () => {
    // ── ADMIT: rows that pass every unconditional floor (must be in BOTH sets) ────────────────
    await seed('WI-PLAIN'); // plain open/untaken/local bug
    await seed('WI-CHANGE', { kind: 'change' });
    await seed('WI-TASK', { kind: 'task' });
    await seed('WI-OP', { harnessSlug: OP }); // operator-scope encoding, still self-pickable
    // reserved-plan-lane floor SATISFIED: a draft plan with no live lease ⇒ free backlog.
    await seedPlan('draft-free', 'draft');
    await seedPlanLinkedIssue('WI-DRAFT-FREE', 'draft-free', 'P-01');
    // blocked-dep floor SATISFIED: blocker is TERMINAL (passed feature) ⇒ not blocking.
    await seed('F-DONE', { kind: 'feature', status: 'passed' });
    await seed('WI-DEP-OK');
    await blockEdge('WI-DEP-OK', `${H}#F-DONE`, 'issue', 'feature');

    // ── EXCLUDE: one row per unconditional floor VIOLATED (must be in NEITHER set) ────────────
    await seed('WI-RESOLVED', { status: 'resolved' }); // 1. not-open
    await seed('WI-TAKEN', { takenBy: 'someone-else' }); // 2. taken
    await seed('WI-REMOTE', { origin: 'remote', authorPubkey: 'foreign-peer-key' }); // 3. federated-remote (true peer)
    await seed('WI-HOLD', { payload: { _claimHold: true } }); // 4. claim-hold
    await seed('WI-OBS', { kind: 'change', payload: { lane: 'observation' } }); // 5. observation-lane
    await seed('WI-NEEDSHUMAN', { payload: { needsHuman: true } }); // 6. needs-human
    await seed('WI-EXTBLOCK', { payload: { externalBlockers: [{ status: 'active' }] } }); // 7. external-blocker
    await seed('WI-FEDDET', { payload: { _ei: { created_by: 'system:replication-liveness' } } }); // 8. federation-detector
    await seed('WI-LOOPNOISE', { title: 'Loop wake #3: continue backlog drain' }); // 9. loop-iteration-noise
    await seed('WI-COMPLETED', { terminalOwner: 'su-peer', terminalCompletionRef: 'commit:abc123' }); // 10. already-completed
    await seedPlan('active-plan', 'active'); // 11a. reserved to an ACTIVE plan lane
    await seedPlanLinkedIssue('WI-ACTIVE-PLAN', 'active-plan', 'P-02');
    await seedPlan('other-lease-plan', 'draft'); // 11b. reserved by ANOTHER owner's live lease
    await seedPlanLinkedIssue('WI-OTHER-LEASE', 'other-lease-plan', 'P-03');
    await seedLease('other-lease-plan', 'P-03', 'su-other-owner', 20);
    // 11c. reserved to a STARTED plan whose LIFECYCLE status is still 'ready' — the shape a
    // real running plan actually has, since plans:start writes op_status and never touches
    // status. Both representations read the lifecycle column ALONE until
    // EI-19409397800537963, so this row was served by both doors; on live papercusp that was
    // 31 items across 12 running plans. 11d is the same for an owner-PAUSED plan, whose
    // plans:pause contract is "no new features are picked until plans:start".
    await seedPlan('started-plan', 'ready', 'started');
    await seedPlanLinkedIssue('WI-STARTED-PLAN', 'started-plan', 'P-04');
    await seedPlan('paused-plan', 'ready', 'paused'); // 11d. owner-paused
    await seedPlanLinkedIssue('WI-PAUSED-PLAN', 'paused-plan', 'P-05');
    // …and the anti-over-exclusion control: a plan whose op run FINISHED reserves nothing, so
    // its leftover items drain normally rather than starving behind a done plan.
    await seedPlan('done-plan', 'ready', 'done');
    await seedPlanLinkedIssue('WI-DONE-PLAN-FREE', 'done-plan', 'P-06');
    await seed('F-OPEN', { kind: 'feature', status: 'open' }); // 12. blocked-dep (non-terminal blocker)
    await seed('WI-DEP-BLOCKED');
    await blockEdge('WI-DEP-BLOCKED', `${H}#F-OPEN`, 'issue', 'feature');

    const expected = [
      'WI-CHANGE', 'WI-DEP-OK', 'WI-DONE-PLAN-FREE', 'WI-DRAFT-FREE', 'WI-OP', 'WI-PLAIN', 'WI-TASK',
    ].sort();
    const viewSet = await viewClaimableIds();
    const drainSet = await drainInlineClaimIds();

    // The core anti-drift assertion: the two hand-maintained representations agree EXACTLY.
    expect(drainSet).toEqual(viewSet);
    // …and both equal the hand-computed admit set (guards a mutual-but-wrong drift where a floor
    // was dropped from BOTH copies at once — a set-equality-only check would miss that).
    expect(viewSet).toEqual(expected);
  });
});

describe('the three DELIBERATE, documented divergences are pinned (a future "alignment" that erases one reds here)', () => {
  it('DIVERGENCE A — per-claim rig floor: the view admits a rig-gated row (SSOT omits per-claim floors); a single-box claim does not, a rigAvailable caller does', async () => {
    await seed('WI-RIG', { payload: { needs_2_machine_rig: true } });

    expect(await viewClaimableIds()).toContain('WI-RIG'); // SSOT deliberately omits the per-claim rig floor
    expect(await drainInlineClaimIds()).not.toContain('WI-RIG'); // default single-box caller excludes it

    // proves ONLY the per-claim rig floor gated it: a rig-capable caller is served the same row.
    const claimed = (await wi.claimNextIssueWorkItem({ harness: H, assignee: 'rig-fleet', rigAvailable: true }, WS))?.id ?? null;
    expect(claimed).toBe('WI-RIG');
  });

  it('DIVERGENCE B — own-node drift recovery: the view UNDER-admits a remote own-authored row (fail-safe); the scheduler recovers it via the own-node origin leg', async () => {
    // A local row enrolls 'key-own' as one of THIS workspace's own substrate-log author keys…
    await seed('WI-LOCAL-OWN', { origin: 'local', authorPubkey: 'key-own' });
    // …so a remote row carrying the SAME author key is our OWN work that round-tripped federation.
    await seed('WI-REMOTE-OWN', { origin: 'remote', authorPubkey: 'key-own' });

    const view = await viewClaimableIds();
    expect(view).toContain('WI-LOCAL-OWN');
    expect(view).not.toContain('WI-REMOTE-OWN'); // the bulk view uses the fail-safe origin-only form ⇒ under-admits

    const drained = await drainInlineClaimIds();
    expect(drained).toContain('WI-REMOTE-OWN'); // the scheduler's own-node leg re-admits it (federation-recovery)
  });

  it('DIVERGENCE C — own-lease plan-item exemption: the view excludes a plan-item under any live lease (caller-independent); the LEASE HOLDER can still claim it', async () => {
    await seedPlan('own-lease-plan', 'draft');
    await seedPlanLinkedIssue('WI-OWN-LEASE', 'own-lease-plan', 'P-001');
    await seedLease('own-lease-plan', 'P-001', 'probe', 20); // the lease is held by the CLAIMING assignee

    expect(await viewClaimableIds()).not.toContain('WI-OWN-LEASE'); // SSOT is caller-independent ⇒ any live lease excludes

    const claimed = (await wi.claimNextIssueWorkItem({ harness: H, assignee: 'probe' }, WS))?.id ?? null;
    expect(claimed).toBe('WI-OWN-LEASE'); // the holder's own-lease exemption admits it
  });
});

/**
 * P-001 (claimable-read-tool-and-sql-encapsulation-audit-2026-07-21): the read tool's two
 * primitives — `aggregateIssueClaimExclusions().claimable` (the survivors COUNT) and
 * `listIssueClaimableRows()` (the survivors ROW LIST) — are built on ONE shared inner
 * subquery + ONE shared all-floors-pass predicate, so the count and the list can never
 * disagree, and both apply the SAME per-row floors the scheduler does. These bind that.
 */
describe('work_items:claimable primitives — the survivors COUNT === the row LIST === the inline claim drain (P-001)', () => {
  it('count, list, and inline-drain all agree for a divergence-free seed; floors actually remove rows', async () => {
    const gn = await import('./get-next');
    // 3 plainly-claimable rows + one row per representative UNCONDITIONAL floor.
    await seed('WI-A'); // bug, claimable
    await seed('WI-B', { kind: 'change' }); // change, claimable
    await seed('WI-C', { kind: 'task' }); // task, claimable
    await seed('WI-TAKEN2', { takenBy: 'peer' }); // taken
    await seed('WI-HOLD2', { payload: { _claimHold: true } }); // claim-hold
    await seed('WI-NH2', { payload: { needsHuman: true } }); // needs-human
    await seed('WI-OBS2', { kind: 'change', payload: { lane: 'observation' } }); // observation-lane
    await seed('WI-DONE2', { terminalOwner: 'su-x', terminalCompletionRef: 'commit:z' }); // already-completed
    await seedPlan('active2', 'active');
    await seedPlanLinkedIssue('WI-ACTIVE2', 'active2', 'P-9'); // reserved ACTIVE plan lane

    const breakdown = await gn.aggregateIssueClaimExclusions(undefined, { harness: H, assignee: 'probe' });
    const rows = await gn.listIssueClaimableRows(undefined, { harness: H, assignee: 'probe' }, 50);
    const expected = ['WI-A', 'WI-B', 'WI-C'];

    // 1. the row list is EXACTLY the claimable set (ordered ids).
    expect(rows.map((r) => r.id).sort()).toEqual(expected);
    // 2. the survivors COUNT equals the row-list length — the drift-proof SSOT guarantee.
    expect(breakdown.claimable).toBe(rows.length);
    expect(breakdown.claimable).toBe(expected.length);
    // 3. both equal what the REAL inline claim path drains (no rig/own-node/lease divergence here).
    expect(await drainInlineClaimIds()).toEqual(expected);
    // the floors genuinely removed rows (matched pre-floor strictly exceeds the survivors)…
    expect(breakdown.matchedByFilter).toBe(9);
    expect(breakdown.matchedByFilter).toBeGreaterThan(breakdown.claimable);
    // …and every floored row is absent from the survivors list.
    for (const floored of ['WI-TAKEN2', 'WI-HOLD2', 'WI-NH2', 'WI-OBS2', 'WI-DONE2', 'WI-ACTIVE2']) {
      expect(rows.map((r) => r.id)).not.toContain(floored);
    }
    // the projected row carries the self-selection fields.
    const a = rows.find((r) => r.id === 'WI-A')!;
    expect(a.kind).toBe('bug');
    expect(a.status).toBe('open');
  });

  it('a kind filter narrows both the count and the list; LIMIT caps the list only', async () => {
    const gn = await import('./get-next');
    await seed('WI-BUG1');
    await seed('WI-BUG2');
    await seed('WI-CHG1', { kind: 'change' });

    const bugOnly: import('./claim-spec').FilterNode = { field: 'kind', op: '=', value: 'bug' };
    const b = await gn.aggregateIssueClaimExclusions(bugOnly, { harness: H, assignee: 'probe' });
    expect(b.matchedByFilter).toBe(2); // the change row is filtered OUT before floors
    expect(b.claimable).toBe(2);

    const capped = await gn.listIssueClaimableRows(bugOnly, { harness: H, assignee: 'probe' }, 1);
    expect(capped).toHaveLength(1); // LIMIT honored (the count still reports the true 2)
    expect(capped[0]!.kind).toBe('bug');
  });
});

/**
 * REGRESSION GUARD — the CLAIM path must honor EVERY spec leg, not just kind/id.
 *
 * Why this block exists: the agreement tests above compared the read path and the claim
 * path only under NO filter and under a `kind` filter — the one filter shape the claim SQL
 * could already narrow by. Coverage therefore coincided exactly with the working case, and
 * the following live failure slipped through five successive patches to this area (WI-1407,
 * EI-10062, WI-4309, WI-5258, WI-5275), every one of which tuned id/kind extraction without
 * ever comparing the two paths on a leg the claim SQL could not express.
 *
 * The failure: `claimNextIssueWorkItem` saw only kind/id, so `paths`/`plan`/`title`/`tags`
 * legs were enforced only AFTER the atomic claim, by claim-spec-store.ts's post-claim
 * `matchesWorkItemClaimSpec` release-and-retry — which shares MAX_PLAN_LANE_ATTEMPTS (5), a
 * budget sized for consecutive plan-lane-BLOCKED candidates. Measured live on fleet
 * p2p-release (spec p2p-release-lane@9): 26 spec-matching rows out of 1073 lane-wide
 * claimable (2.4%), so P(>=1 match in 5 draws) ~= 11.6% — scheduler:get_next returned a
 * FALSE "no claimable work" on ~88% of pulls, indistinguishable from a drained lane, while
 * work_items:claimable correctly reported 26. Three fleet members independently misread that
 * as "floor-gated" when zero floors were firing.
 *
 * The shape matters: a TOP-LEVEL `any` is what makes this bite. positiveIdCohortIds
 * correctly refuses to extract a closed-world id set from an OR, so tier 3 runs unrestricted
 * and leans entirely on the post-claim bounce. Keep the `any` here.
 */
describe('the CLAIM path honors every spec leg, not just kind/id (false-drain regression)', () => {
  it('serves a narrow paths+id OR-shaped lane instead of falsely reporting it drained', async () => {
    const gn = await import('./get-next');

    // A lane where the spec's matches are a small MINORITY, and the non-matching rows rank
    // FIRST (older createdTs) — so a claim path blind to `paths` draws violators every time.
    for (let i = 0; i < 20; i++) await seed(`WI-OUT${i}`, { kind: 'change', createdTs: i });
    await seed('WI-INPATH1', {
      kind: 'change', createdTs: 900, payload: { paths: ['packages/operator-core/lib/p2p/boot.ts'] },
    });
    await seed('WI-INPATH2', {
      kind: 'change', createdTs: 901, payload: { paths: ['packages/operator-core/lib/p2p/wire.ts'] },
    });
    await seed('WI-INPIN', { kind: 'change', createdTs: 902 });

    const lane: import('./claim-spec').FilterNode = {
      any: [
        { field: 'id', op: 'in', value: ['WI-INPIN'] },
        { field: 'paths', op: 'glob', value: 'packages/operator-core/lib/p2p/*' },
      ],
    };
    const inLane = ['WI-INPATH1', 'WI-INPATH2', 'WI-INPIN'];

    // The READ path was always correct — pin it as the oracle.
    const rows = await gn.listIssueClaimableRows(lane, { harness: H, assignee: 'probe' }, 50);
    expect(rows.map((r) => r.id).sort()).toEqual(inLane);

    // The CLAIM path must now agree. Pre-fix this drained WI-OUT* rows (spec violations the
    // caller then had to bounce) or, under the real bounded retry, returned nothing at all.
    const compiled = gn.compileFilter(db.sql as never, lane);
    const claimed: string[] = [];
    for (let i = 0; i < 50; i++) {
      const got = await wi.claimNextIssueWorkItem(
        { harness: H, assignee: 'probe' },
        WS,
        { specFilterSql: compiled },
      );
      if (!got) break;
      claimed.push(got.id);
    }

    // 1. The lane is SERVED, not falsely drained — this is the actual regression.
    expect(claimed.length).toBeGreaterThan(0);
    // 2. It serves EXACTLY the spec-matching rows: no violator ever reaches the member, so
    //    the post-claim quarantine release (and its spurious-wake fanout) never has to run.
    expect(claimed.sort()).toEqual(inLane);
    // 3. Claim and read agree — the SSOT guarantee, now extended to the claim path.
    expect(claimed.sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it('an undefined spec filter still drains the whole lane (the narrowing is opt-in)', async () => {
    await seed('WI-FREE1', { kind: 'change', createdTs: 1 });
    await seed('WI-FREE2', { kind: 'bug', createdTs: 2 });
    expect(await drainInlineClaimIds()).toEqual(['WI-FREE1', 'WI-FREE2']);
  });
});
