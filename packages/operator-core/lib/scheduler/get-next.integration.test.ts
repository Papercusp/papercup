/**
 * get-next.integration.test.ts — the deterministic spec-driven `get_next` resolver
 * (hybrid-bee-scheduler-work-stealing-2026-06-22, Phase 3 / D-002, D-003, D-010).
 *
 * Proves against real Postgres (testcontainer; Docker required), modelled on
 * work-items-claim-readiness.integration.test.ts (the floors share that test's
 * bootstrap — get_next ANDs in the IDENTICAL claimFloorsWhereSql fragment):
 *
 *   • a spec filter + rank claims the CORRECT item (narrow + reorder);
 *   • a FLOOR ALWAYS applies — a blocked / non-ready / claimed / wrong-status item is
 *     NEVER claimed, even when spec.filter would explicitly select it (D-002: a spec
 *     can only narrow + reorder, never widen past or re-assert a floor);
 *   • two CONCURRENT get_next claim DIFFERENT items (FOR UPDATE SKIP LOCKED);
 *   • DEFAULT_CLAIM_SPEC reproduces today's ordering (feature_order ASC NULLS LAST,
 *     then created_ts ASC) — "no spec == current behavior" (D-003);
 *   • provenance: every claim records the specId@revision that selected it.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/get-next.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { ClaimSpec } from './claim-spec';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
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

const { getNextWorkItem, getNextWorkItemDefault } = await import('./get-next');
const { DEFAULT_CLAIM_SPEC, validateClaimSpec } = await import('./claim-spec');
const wi = await import('../work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

interface SeedOpts {
  createdTs?: number;
  status?: string;
  takenBy?: string | null;
  featureOrder?: number | null;
  tags?: string[];
  paths?: string[];
  riskTier?: string;
  estCost?: number;
}
async function seedFeature(id: string, opts: SeedOpts = {}) {
  const payload =
    opts.paths || opts.riskTier
      ? JSON.stringify({ ...(opts.paths ? { paths: opts.paths } : {}), ...(opts.riskTier ? { risk_tier: opts.riskTier } : {}) })
      : null;
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,
       created_ts, updated_ts, feature_order, tags, payload, expected_cost_cents)
    VALUES (${H}, ${id}, 'feature', ${opts.status ?? 'todo'}, ${opts.takenBy ?? null}, ${WS},
       ${opts.createdTs ?? 0}, 0, ${opts.featureOrder ?? null},
       ${opts.tags ? db.sql.json(opts.tags) : null},
       ${payload ? db.sql.json(JSON.parse(payload)) : null},
       ${opts.estCost ?? null})`;
}

async function blockByFeature(blockedId: string, blockerId: string) {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, 'feature', ${`${H}#${blockedId}`}, 'feature', ${`${H}#${blockerId}`}, 'blocks')`;
}

/** A validated spec or fail the test loudly — every spec under test must pass the validator. */
function spec(s: ClaimSpec): ClaimSpec {
  const v = validateClaimSpec(s);
  expect(v.ok, `spec invalid: ${v.errors.join('; ')}`).toBe(true);
  return s;
}

const BEE = { assignee: 'bee-1' };

beforeAll(async () => {
  db = await createFreshPgDb('sched-get-next');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(readMigration('131-engineer-issues.sql')).simple();
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
}, 90_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps `;
});

// ────────────────────────────────────────────────────────────────────────────
// 1. Filter + rank: claims the CORRECT item.
// ────────────────────────────────────────────────────────────────────────────
describe('get_next — spec filter + rank selects the correct item', () => {
  it('a tags filter NARROWS to the matching item', async () => {
    await seedFeature('F-sync', { tags: ['sync'], createdTs: 100 });
    await seedFeature('F-docs', { tags: ['docs'], createdTs: 50 }); // older but filtered out
    const s = spec({
      specVersion: '1.0',
      specId: 'sync-only',
      revision: 3,
      view: { filter: { field: 'tags', op: 'contains', value: 'sync' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-sync');
    expect(r?.claimedUnder).toEqual({ specId: 'sync-only', revision: 3 });
  });

  it('rank by priority (feature_order) desc picks the HIGHEST-priority item', async () => {
    // feature_order is an INVERTED scale (lower = higher priority); `priority desc`
    // ("highest priority first") ⇒ feature_order ASC ⇒ the order-1 item wins.
    await seedFeature('F-lo', { featureOrder: 9, createdTs: 10 });
    await seedFeature('F-hi', { featureOrder: 1, createdTs: 999 }); // newest, but top priority
    const s = spec({
      specVersion: '1.0',
      specId: 'by-priority',
      revision: 1,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-hi');
  });

  it('a relational filter on risk_tier (payload) excludes over-ceiling items', async () => {
    await seedFeature('F-risky', { riskTier: '4', tags: ['sync'], createdTs: 10 });
    await seedFeature('F-safe', { riskTier: '1', tags: ['sync'], createdTs: 20 });
    const s = spec({
      specVersion: '1.0',
      specId: 'low-risk-sync',
      revision: 1,
      view: {
        filter: {
          all: [
            { field: 'tags', op: 'contains', value: 'sync' },
            { field: 'risk_tier', op: '<=', value: 2 },
          ],
        },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-safe');
  });

  it('the live affinity rank term prefers an item whose paths overlap the bee held_paths', async () => {
    await seedFeature('F-far', { paths: ['apps/ui/page.tsx'], featureOrder: 1, createdTs: 10 });
    await seedFeature('F-near', { paths: ['libs/sync/queue.ts'], featureOrder: 1, createdTs: 20 });
    // Lexicographic: affinity desc FIRST, then priority — equal priority, so affinity
    // breaks the tie. The bee holds libs/sync/*, so F-near (overlapping path) wins.
    const s = spec({
      specVersion: '1.0',
      specId: 'affine',
      revision: 1,
      view: {},
      rank: {
        mode: 'lexicographic',
        terms: [
          { expr: 'affinity(bee.held_paths,item.paths)', dir: 'desc' },
          { expr: 'priority', dir: 'desc' },
        ],
      },
    });
    const r = await getNextWorkItem(s, { assignee: 'bee-1', heldPaths: ['libs/sync/'] }, { harness: H });
    expect(r?.workItem.id).toBe('F-near');
  });

  it('a glob filter on paths (payload) matches by path prefix', async () => {
    await seedFeature('F-sync-lib', { paths: ['libs/sync/index.ts'], createdTs: 10 });
    await seedFeature('F-ui', { paths: ['apps/ui/page.tsx'], createdTs: 5 });
    const s = spec({
      specVersion: '1.0',
      specId: 'sync-path',
      revision: 1,
      view: { filter: { field: 'paths', op: 'glob', value: 'libs/sync/**' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-sync-lib');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. The FLOORS always apply — a spec can never widen past them (D-002).
// ────────────────────────────────────────────────────────────────────────────
describe('get_next — floors ALWAYS apply (D-002: spec narrows+reorders, never un-floors)', () => {
  it('NEVER claims a blocked item even when spec.filter selects it', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 50 });
    await seedFeature('F-blocked', { tags: ['sync'], status: 'todo', createdTs: 100 });
    await blockByFeature('F-blocked', 'F-blocker');
    // The spec EXPLICITLY selects F-blocked (tags=sync) — but the readiness floor (a
    // non-terminal blocker) holds it back regardless of the spec.
    const s = spec({
      specVersion: '1.0',
      specId: 'wants-blocked',
      revision: 1,
      view: { filter: { field: 'tags', op: 'contains', value: 'sync' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();

    // Satisfy the blocker ⇒ the SAME spec now claims it (the floor lifted, not the spec).
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='passed' WHERE feature_id='F-blocker'`;
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-blocked');
  });

  it('NEVER claims an already-claimed item the spec selects', async () => {
    await seedFeature('F-taken', { tags: ['sync'], takenBy: 'someone-else', createdTs: 100 });
    const s = spec({
      specVersion: '1.0',
      specId: 'wants-taken',
      revision: 1,
      view: { filter: { field: 'tags', op: 'contains', value: 'sync' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
  });

  it('NEVER claims a non-claimable-status item the spec selects', async () => {
    await seedFeature('F-passed', { tags: ['sync'], status: 'passed', createdTs: 100 });
    const s = spec({
      specVersion: '1.0',
      specId: 'wants-passed',
      revision: 1,
      view: { filter: { field: 'tags', op: 'contains', value: 'sync' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
  });

  it('skips a blocked higher-ranked item for a ready lower-ranked one', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 1 });
    await seedFeature('F-top', { featureOrder: 1, status: 'todo', createdTs: 10 }); // top priority, but blocked
    await seedFeature('F-next', { featureOrder: 5, status: 'todo', createdTs: 20 }); // lower priority, ready
    await blockByFeature('F-top', 'F-blocker');
    const s = spec({
      specVersion: '1.0',
      specId: 'priority',
      revision: 1,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect((await getNextWorkItem(s, BEE, { harness: H }))?.workItem.id).toBe('F-next');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Concurrency — two get_next claim DIFFERENT items (FOR UPDATE SKIP LOCKED).
// ────────────────────────────────────────────────────────────────────────────
describe('get_next — concurrent claims take DIFFERENT items (SKIP LOCKED)', () => {
  it('two simultaneous get_next never double-claim', async () => {
    await seedFeature('F-a', { tags: ['sync'], createdTs: 100 });
    await seedFeature('F-b', { tags: ['sync'], createdTs: 200 });
    const s = spec({
      specVersion: '1.0',
      specId: 'race',
      revision: 1,
      view: { filter: { field: 'tags', op: 'contains', value: 'sync' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const [r1, r2] = await Promise.all([
      getNextWorkItem(s, { assignee: 'bee-1' }, { harness: H }),
      getNextWorkItem(s, { assignee: 'bee-2' }, { harness: H }),
    ]);
    const ids = [r1?.workItem.id, r2?.workItem.id].sort();
    expect(ids).toEqual(['F-a', 'F-b']); // both claimed, DIFFERENT items
    expect(r1?.workItem.id).not.toBe(r2?.workItem.id);
  });

  it('with only ONE eligible item, exactly one of two racers wins', async () => {
    await seedFeature('F-solo', { tags: ['sync'], createdTs: 100 });
    const s = spec({
      specVersion: '1.0',
      specId: 'race-one',
      revision: 1,
      view: { filter: { field: 'tags', op: 'contains', value: 'sync' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const [r1, r2] = await Promise.all([
      getNextWorkItem(s, { assignee: 'bee-1' }, { harness: H }),
      getNextWorkItem(s, { assignee: 'bee-2' }, { harness: H }),
    ]);
    const winners = [r1, r2].filter((r) => r != null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.workItem.id).toBe('F-solo');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. DEFAULT_CLAIM_SPEC == today's ordering (D-003: no spec = current behavior).
// ────────────────────────────────────────────────────────────────────────────
describe('get_next — DEFAULT_CLAIM_SPEC reproduces current ordering (D-003)', () => {
  it('with feature_order set, prefers lower feature_order (the Queen-intended order)', async () => {
    await seedFeature('F-hi', { featureOrder: 1, createdTs: 999 });
    await seedFeature('F-lo', { featureOrder: 9, createdTs: 10 });
    await seedFeature('F-mid', { featureOrder: 5, createdTs: 500 });
    // Same ordering claimNextWorkItem applies with a swarmId (feature_order ASC NULLS
    // LAST, then created_ts ASC) — the default spec's priority desc → age asc.
    expect((await getNextWorkItemDefault(BEE, { harness: H }))?.workItem.id).toBe('F-hi');
  });

  it('with NO feature_order anywhere, falls to oldest-first (created_ts ASC) — the legacy claim', async () => {
    await seedFeature('F-old', { createdTs: 10 });
    await seedFeature('F-new', { createdTs: 99 });
    // DEFAULT_CLAIM_SPEC and the legacy affinity-blind claimNextWorkItem must agree.
    const viaDefault = await getNextWorkItemDefault({ assignee: 'bee-A' }, { harness: H });
    expect(viaDefault?.workItem.id).toBe('F-old');
    // Re-seed and cross-check the legacy path picks the SAME item.
    await db.sql`TRUNCATE harness_shared.work_items `;
    await seedFeature('F-old', { createdTs: 10 });
    await seedFeature('F-new', { createdTs: 99 });
    const viaLegacy = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-B' });
    expect(viaLegacy?.id).toBe('F-old');
    expect(viaLegacy?.id).toBe(viaDefault?.workItem.id);
  });

  it('the default spec records default-fixed-ordering@0 provenance', async () => {
    await seedFeature('F-only', { createdTs: 10 });
    const r = await getNextWorkItemDefault(BEE, { harness: H });
    expect(r?.claimedUnder).toEqual({ specId: DEFAULT_CLAIM_SPEC.specId, revision: 0 });
  });
});
