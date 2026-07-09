/**
 * claim-respects-blocking.integration.test.ts — the scheduler claim path NEVER hands
 * out a BLOCKED work-item, and DOES once it is unblocked
 * (work-item-deps-and-readiness-2026-06-22 P-005, owned by su-0e44e75b).
 *
 * The eligibility floors are defined ONCE — `claimFloorsWhereSql` in work-items.ts — and
 * shared by BOTH claim entry points: the decentralized `claimNextWorkItem` (work-items.ts)
 * AND the spec-driven `getNextForBee` (scheduler/claim-spec-store.ts → get-next.ts). This
 * test asserts the readiness invariant against BOTH, in one place, so a regression in either
 * caller (or in the shared floor) is caught:
 *
 *   1. A feature F blocked-by a NON-TERMINAL feature G (a work_item_deps 'blocks' edge) is
 *      NEVER claimed — by claimNextWorkItem NOR getNextForBee — even with a filter/spec that
 *      WOULD otherwise select F.
 *   2. Flip G → 'passed' (terminal) ⇒ F becomes claimable (both paths return it).
 *   3. A feature with NO blockers is always claimable.
 *   4. An ABSENT / dangling blocker ref does NOT block (no deadlock).
 *
 * Distinct from work-items-claim-readiness.integration.test.ts (which proves only
 * claimNextWorkItem against the inline predicate) and get-next.integration.test.ts (which
 * proves getNextWorkItem with a hand-built spec): THIS file drives the bee-spec ENTRY point
 * (getClaimSpec → getNextWorkItem) the live scheduler actually calls, alongside the legacy
 * claim, and ALSO materializes migration 379's MAINTAINED readiness sidecar
 * (harness_shared.work_item_blocked) to cross-check that the sidecar's membership (the
 * indexed read the SCHEDULER_MAINTAINED_READY flag will switch the claim to) stays IDENTICAL
 * to the inline `NOT EXISTS` predicate at every step — i.e. behavior is the same either way.
 *
 * Real Postgres (testcontainer; Docker required).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/claim-respects-blocking.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  USER_TRUST_LIST_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
/** Read a migration verbatim, stripping psql meta-commands / GRANTs / bare BEGIN/COMMIT
 *  the bare testcontainer schema can't run (mirrors the sibling integration tests). */
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

// Keep the import chain (claim-spec-store → get-next → work-items) safe at module load and
// route every getOrgPg() in the engine at the throwaway test db.
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('../work-items');
const { getNextForBee } = await import('./claim-spec-store');

const H = 'papercup';
const WS = 'default'; // == DEFAULT_COORD_WORKSPACE; work_item_deps + the sidecar live here
let db: FreshPgDb;

interface SeedOpts {
  createdTs?: number;
  status?: string;
  takenBy?: string | null;
  tags?: string[];
}
async function seedFeature(id: string, opts: SeedOpts = {}) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts, tags)
    VALUES (${H}, ${id}, 'feature', ${opts.status ?? 'todo'}, ${opts.takenBy ?? null}, ${WS},
       ${opts.createdTs ?? 0}, 0, ${opts.tags ? db.sql.json(opts.tags) : null})`;
}

/** A feature→feature blocks edge (harness-qualified refs, the featureRef convention). */
async function blockByFeature(blockedId: string, blockerId: string) {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, 'feature', ${`${H}#${blockedId}`}, 'feature', ${`${H}#${blockerId}`}, 'blocks')`;
}

/** The MAINTAINED sidecar (migration 379) view of readiness: true ⇒ a row exists ⇒ NOT ready.
 *  This is exactly the membership the SCHEDULER_MAINTAINED_READY flag's anti-join probes. */
async function sidecarSaysBlocked(id: string): Promise<boolean> {
  const rows = (await db.sql`
    SELECT 1 FROM harness_shared.work_item_blocked
     WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = ${id} LIMIT 1`) as unknown[];
  return rows.length > 0;
}

/** The inline-predicate ORACLE (migration 379's work_item_is_blocked == the live claim's
 *  NOT EXISTS). The maintained sidecar must AGREE with it at every step. */
async function oracleSaysBlocked(id: string): Promise<boolean> {
  const rows = (await db.sql`
    SELECT harness_shared.work_item_is_blocked(${H}, ${id}) AS blocked`) as Array<{ blocked: boolean }>;
  return rows[0]!.blocked === true;
}

/**
 * Drive both claim entry points that share `claimFloorsWhereSql` and return the id each
 * claimed (or null). Each runs in isolation: we RELEASE any claim between calls so the two
 * paths see the identical pre-claim state. The two callers must agree on every assertion —
 * that is the "one floor, two paths" invariant P-005 protects.
 */
async function claimViaBothPaths(assignee: string): Promise<{ legacy: string | null; spec: string | null }> {
  const legacy = (await wi.claimNextWorkItem({ harness: H, assignee: `${assignee}-legacy` }))?.id ?? null;
  if (legacy) {
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET taken_by = NULL, taken_at = NULL WHERE feature_id = ${legacy}`;
  }
  const spec = (await getNextForBee({ cupId: `${assignee}-spec`, harness: H }))?.workItem.id ?? null;
  if (spec) {
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET taken_by = NULL, taken_at = NULL WHERE feature_id = ${spec}`;
  }
  return { legacy, spec };
}

beforeAll(async () => {
  db = await createFreshPgDb('claim-respects-blocking');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL); // claim path LEFT-JOINs the trust list (autoPickableWhereSql)
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple(); // the dep table the readiness clause reads
  // The bee_claim_specs store getNextForBee → getClaimSpec reads (absent bee ⇒ DEFAULT_CLAIM_SPEC).
  await db.sql.unsafe(readMigration('372-bee-claim-specs.sql')).simple();
  // Columns get-next / claim-readiness fixtures add on top of the base superset.
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
  // Migration 379: the MAINTAINED readiness sidecar + its maintenance triggers + the
  // work_item_is_blocked oracle. Self-contained + idempotent — applying it here lets us
  // cross-check the sidecar (the indexed read the flag will switch to) against the inline
  // predicate the claim uses today.
  await db.sql.unsafe(readMigration('379-maintained-ready-column.sql')).simple();
}, 180_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked`;
});

// ────────────────────────────────────────────────────────────────────────────
// Flag arms. SCHEDULER_MAINTAINED_READY (being added to libs/flags/src/types.ts by
// su-0e44e) will switch the claim from the inline `NOT EXISTS` predicate to the indexed
// work_item_blocked sidecar — behavior must be IDENTICAL either way. The flag is NOT wired
// into the claim path yet (verified: claimFloorsWhereSql / get-next.ts read no flag), so we
// run the DEFAULT (inline) arm and, in EVERY case, assert the maintained sidecar AGREES with
// the inline oracle — proving the two readiness sources are byte-equivalent ahead of the
// switch. When su-0e44e lands the flag, add a second arm that sets it true and re-runs cases
// 1–2 through the same body (see TODO below).
//
// TODO(su-0e44e75b): once SCHEDULER_MAINTAINED_READY is wired into claimFloorsWhereSql /
// get-next.ts, parametrize the "claim respects blocking" describes over
// [{ name: 'inline (default)', maintained: false }, { name: 'maintained sidecar', maintained: true }]
// — set the flag via the flags store and assert IDENTICAL claim outcomes across both arms.
// ────────────────────────────────────────────────────────────────────────────

describe('scheduler claim respects blocking — NEVER hands out a blocked item (P-005)', () => {
  // Explicit INLINE arm (flag OFF) — the reversible kill-switch fallback. (The sidecar/ON arm — now the
  // shipped default — is the dedicated describe at the bottom.) Pinned so both paths stay covered
  // regardless of the default value.
  beforeEach(() => setFlagOverridesForTest({ [FLAGS.SCHEDULER_MAINTAINED_READY]: false }));
  afterEach(() => setFlagOverridesForTest({}));

  it('1. does NOT claim a feature with a non-terminal feature blocker — NEITHER claim path', async () => {
    // F-blocker is 'wip' (not itself claimable here); F-blocked is the only 'todo' candidate,
    // tagged so a filter/spec WOULD otherwise select it — but its blocker is non-terminal.
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'todo', createdTs: 200, tags: ['sync'] });
    await blockByFeature('F-blocked', 'F-blocker');

    // The inline ORACLE and the MAINTAINED sidecar agree: F-blocked is NOT ready.
    expect(await oracleSaysBlocked('F-blocked')).toBe(true);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(true);

    // Neither claim entry point hands it out.
    const { legacy, spec } = await claimViaBothPaths('w1');
    expect(legacy).toBeNull();
    expect(spec).toBeNull();
  });

  it('2. CLAIMS the blocked feature via BOTH paths once the blocker reaches a terminal status', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'todo', createdTs: 200, tags: ['sync'] });
    await blockByFeature('F-blocked', 'F-blocker');
    // Blocked first.
    expect((await claimViaBothPaths('w2')).legacy).toBeNull();

    // Satisfy the blocker: 'passed' is terminal. The status-crossing trigger re-syncs the
    // dependent's sidecar membership.
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='passed' WHERE feature_id='F-blocker'`;

    // Oracle + sidecar now agree: F-blocked is READY.
    expect(await oracleSaysBlocked('F-blocked')).toBe(false);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(false);

    // The SAME claim that returned null now hands out F-blocked — by BOTH paths.
    const { legacy, spec } = await claimViaBothPaths('w2');
    expect(legacy).toBe('F-blocked');
    expect(spec).toBe('F-blocked');
  });

  it('3. a feature with NO blockers is claimable via BOTH paths', async () => {
    await seedFeature('F-free', { status: 'todo', createdTs: 100 });
    expect(await oracleSaysBlocked('F-free')).toBe(false);
    expect(await sidecarSaysBlocked('F-free')).toBe(false);

    const { legacy, spec } = await claimViaBothPaths('w3');
    expect(legacy).toBe('F-free');
    expect(spec).toBe('F-free');
  });

  it('4. an ABSENT / dangling blocker ref does NOT block (no deadlock) — BOTH paths', async () => {
    await seedFeature('F-blocked', { status: 'todo', createdTs: 100 });
    // The edge points at a blocker with NO row in the table — an absent blocker never deadlocks.
    await blockByFeature('F-blocked', 'F-ghost');

    expect(await oracleSaysBlocked('F-blocked')).toBe(false);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(false);

    const { legacy, spec } = await claimViaBothPaths('w4');
    expect(legacy).toBe('F-blocked');
    expect(spec).toBe('F-blocked');
  });

  it('skips a blocked item for a ready one — the floor never starves the ready queue (BOTH paths)', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 1 });
    await seedFeature('F-blocked', { status: 'todo', createdTs: 100 }); // older, but blocked
    await seedFeature('F-ready', { status: 'todo', createdTs: 200 }); //  newer, but ready
    await blockByFeature('F-blocked', 'F-blocker');

    // Oldest-first would pick F-blocked, but it's blocked ⇒ both claims skip to F-ready.
    const { legacy, spec } = await claimViaBothPaths('w5');
    expect(legacy).toBe('F-ready');
    expect(spec).toBe('F-ready');
  });
});

describe('maintained readiness sidecar tracks the inline oracle through the lifecycle (379)', () => {
  it('add-edge → blocked, terminal-blocker → ready, drop-edge → ready: sidecar mirrors the oracle at every step', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 1 });
    await seedFeature('F-blocked', { status: 'todo', createdTs: 2 });
    // Pre-edge: no blocker ⇒ ready in both.
    expect(await oracleSaysBlocked('F-blocked')).toBe(false);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(false);

    // Add the blocks-edge ⇒ blocked in both (wir_deps_sync_trg).
    await blockByFeature('F-blocked', 'F-blocker');
    expect(await oracleSaysBlocked('F-blocked')).toBe(true);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(true);

    // Blocker → terminal ⇒ ready in both (wir_status_sync_dependents_trg).
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='passed' WHERE feature_id='F-blocker'`;
    expect(await oracleSaysBlocked('F-blocked')).toBe(false);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(false);

    // Re-block (blocker back to a non-terminal status) ⇒ blocked again.
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='wip' WHERE feature_id='F-blocker'`;
    expect(await oracleSaysBlocked('F-blocked')).toBe(true);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(true);

    // Drop the edge ⇒ ready in both (wir_deps_sync_trg on DELETE).
    await db.sql`DELETE FROM harness_shared.work_item_deps WHERE blocked_ref = ${`${H}#F-blocked`}`;
    expect(await oracleSaysBlocked('F-blocked')).toBe(false);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(false);
  });
});

// Closes the agent's TODO(su-0e44e75b): exercise the claim with SCHEDULER_MAINTAINED_READY ON,
// so the INDEXED work_item_blocked anti-join in claimFloorsWhereSql is driven end-to-end through
// BOTH entry points (the equivalence proof above covers the sidecar==oracle predicate; this covers
// the anti-join SQL fragment itself — a wrong column match would claim a blocked item or claim none).
describe('claim respects blocking with SCHEDULER_MAINTAINED_READY ON — the indexed sidecar anti-join (P-005 cutover)', () => {
  beforeEach(() => setFlagOverridesForTest({ [FLAGS.SCHEDULER_MAINTAINED_READY]: true }));
  afterEach(() => setFlagOverridesForTest({}));

  it('flag ON: a feature with a non-terminal blocker is NOT claimed via EITHER path', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'todo', createdTs: 200, tags: ['sync'] });
    await blockByFeature('F-blocked', 'F-blocker');
    expect(await sidecarSaysBlocked('F-blocked')).toBe(true);
    const { legacy, spec } = await claimViaBothPaths('m1');
    expect(legacy).toBeNull();
    expect(spec).toBeNull();
  });

  it('flag ON: the blocked feature becomes claimable via BOTH paths once the blocker is terminal', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'todo', createdTs: 200, tags: ['sync'] });
    await blockByFeature('F-blocked', 'F-blocker');
    expect((await claimViaBothPaths('m2')).legacy).toBeNull();
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='passed' WHERE feature_id='F-blocker'`;
    expect(await sidecarSaysBlocked('F-blocked')).toBe(false);
    const { legacy, spec } = await claimViaBothPaths('m2');
    expect(legacy).toBe('F-blocked');
    expect(spec).toBe('F-blocked');
  });

  it('flag ON: skips a blocked item for a ready one — the indexed floor never starves the queue', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 1 });
    await seedFeature('F-blocked', { status: 'todo', createdTs: 100 });
    await seedFeature('F-ready', { status: 'todo', createdTs: 200 });
    await blockByFeature('F-blocked', 'F-blocker');
    const { legacy, spec } = await claimViaBothPaths('m3');
    expect(legacy).toBe('F-ready');
    expect(spec).toBe('F-ready');
  });
});
