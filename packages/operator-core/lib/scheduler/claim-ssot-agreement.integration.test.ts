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
      ${o.payload ? db.sql.json(o.payload) : null},
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
const seedPlan = (slug: string, status: string) =>
  db.sql`INSERT INTO harness_shared.harness_plans (plan_slug, status) VALUES (${slug}, ${status})`;
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
}, 180_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked,
                       harness_shared.harness_plans, harness_shared.plan_item_claims`;
});

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
    await seed('F-OPEN', { kind: 'feature', status: 'open' }); // 12. blocked-dep (non-terminal blocker)
    await seed('WI-DEP-BLOCKED');
    await blockEdge('WI-DEP-BLOCKED', `${H}#F-OPEN`, 'issue', 'feature');

    const expected = ['WI-CHANGE', 'WI-DEP-OK', 'WI-DRAFT-FREE', 'WI-OP', 'WI-PLAIN', 'WI-TASK'].sort();
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
