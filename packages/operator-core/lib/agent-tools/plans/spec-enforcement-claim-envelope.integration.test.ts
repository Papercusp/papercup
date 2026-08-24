/**
 * spec-enforcement-claim-envelope.integration.test.ts
 *
 * P-014 leg 2: real-Postgres coverage for the SHARED claim reader that every shipped
 * enforcement rollup depends on — `listWonClaimEnvelope` (the exported alias of
 * `defaultListFirstClaims` in ./spec-enforcement-latency).
 *
 * WHY THIS FILE EXISTS (measured 2026-08-24). All three measures — latency (P-012),
 * escape and repeated-approach (P-013) — read claims through this ONE query, by design,
 * so they share an outcome filter, a tenant predicate and a units conversion. But every
 * one of the 105 unit tests across the five spec-enforcement files injects the
 * `listFirstClaims` / `listWonClaims` seam instead of executing it. Measured directly:
 * `defaultListFirstClaims`, `defaultListWorkItemLifecycle` and `defaultListPlanAdoption`
 * each appear in ZERO *.test.ts files. The SQL below had no test at all.
 *
 * WHY THAT IS DANGEROUS RATHER THAN MERELY UNTIDY — every failure mode of this query is
 * SILENT, not loud:
 *
 *   · a wrong/dropped `outcome = 'won'` predicate returns MORE rows (lost and timed-out
 *     attempts counted as real work), inflating wonClaimCount and distinctClaimants;
 *   · a dropped workspace_id/harness_slug predicate leaks another tenant's claims in;
 *   · a wrong tenant value returns ZERO rows — and zero rows is indistinguishable from
 *     the legitimate "this item was never claimed", so all three rollups would report a
 *     confident, well-formed, entirely empty measurement;
 *   · a broken epoch conversion shifts every latency by a factor of 1000.
 *
 * None of those throw. All of them keep the injected-seam unit tests green. That is the
 * surviving-mutant / vacuous-coverage shape P-014 exists to find, and it was live in the
 * plan's own shipped work.
 *
 * FIXTURE DISCIPLINE: the table is hand-provisioned (applying frozen 000-baseline.sql in
 * full is not viable here), which is the known recurring break EI-21270668928342264 — a
 * hand-rolled harness_shared fixture silently falling a column behind the real schema.
 * The first test below is therefore a DRIFT GUARD that derives baseline's column set from
 * the migration file itself and fails if this fixture no longer matches it. A stale
 * fixture then fails loudly here instead of quietly testing yesterday's schema.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const WORKSPACE = 'ws-claim-envelope';
const OTHER_WORKSPACE = 'ws-claim-envelope-other';
const HARNESS = 'web';
const OTHER_HARNESS = 'mobile';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: postgres.Sql) => Promise<T>) =>
      h.sql.begin(async (tx) => fn(tx as unknown as postgres.Sql)),
  };
});

vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return {
    ...actual,
    resolvePlanScope: async (opts: { harnessSlug?: string } = {}) => ({
      workspaceId: WORKSPACE,
      harnessSlug: opts.harnessSlug?.trim() || HARNESS,
    }),
  };
});

// The PUBLIC contract name. escape and repeated-approach both import this exact alias, so
// testing it (rather than the private declaration) is testing what they actually consume.
const { listWonClaimEnvelope } = await import('./spec-enforcement-latency');

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_SQL = path.resolve(here, '../../../../../libs/papercusp/libs/db/sql/000-baseline.sql');

/** Columns of the fixture below — kept in one place so the drift guard can compare it. */
const FIXTURE_COLUMNS = [
  'workspace_id',
  'id',
  'harness_slug',
  'feature_id',
  'claimer_pubkey',
  'attempt_ts',
  'outcome',
  'detail',
] as const;

/**
 * Derive claim_audit's real column set from 000-baseline.sql rather than restating it.
 * Rung 1 of the derived-truth ladder: the migration is the single source, so this cannot
 * drift the way a second hand-maintained list would.
 */
function baselineClaimAuditColumns(): string[] {
  const text = readFileSync(BASELINE_SQL, 'utf8');
  const start = text.indexOf('CREATE TABLE IF NOT EXISTS harness_shared.claim_audit (');
  if (start === -1) {
    throw new Error(
      'Could not find the claim_audit CREATE TABLE in 000-baseline.sql. The drift guard is ' +
        'broken (not the fixture) — fix the locator before trusting any result in this file.',
    );
  }
  const body = text.slice(start + text.slice(start).indexOf('(') + 1);
  const end = body.indexOf('\n);');
  const columns: string[] = [];
  for (const rawLine of body.slice(0, end).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('CONSTRAINT') || line.startsWith('--')) continue;
    const m = /^([a-z_]+)\s+/.exec(line);
    if (m?.[1]) columns.push(m[1]);
  }
  return columns;
}

let db: FreshPgDb;
let rootSql: postgres.Sql;

const MS = (iso: string) => new Date(iso).getTime();

async function seedClaim(over: {
  workspaceId?: string;
  harnessSlug?: string;
  featureId: string;
  claimer: string;
  outcome: 'won' | 'lost' | 'timeout' | 'error';
  atMs: number;
}) {
  await rootSql`
    INSERT INTO harness_shared.claim_audit
      (workspace_id, harness_slug, feature_id, claimer_pubkey, outcome, attempt_ts)
    VALUES (
      ${over.workspaceId ?? WORKSPACE},
      ${over.harnessSlug ?? HARNESS},
      ${over.featureId},
      ${over.claimer},
      ${over.outcome},
      to_timestamp(${over.atMs} / 1000.0)
    )`;
}

beforeAll(async () => {
  // A FRESH, per-file database — NOT the shared `papercusp_test` default that
  // getTestPg() hands back. That container is `.withReuse()`d by every vitest process
  // on this box (30+ fleet agents concurrently), so provisioning a harness_shared table
  // directly in it means this file's DDL races every other suite touching the same name.
  // createFreshPgDb isolates us, which is also what the sibling spec-*.integration tests
  // in this directory already do.
  db = await createFreshPgDb('spec-claim-envelope');
  rootSql = db.sql;
  h.sql = rootSql;
  await rootSql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.claim_audit (
      workspace_id text DEFAULT '' NOT NULL,
      id bigserial,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      claimer_pubkey text NOT NULL,
      attempt_ts timestamptz DEFAULT now() NOT NULL,
      outcome text NOT NULL,
      detail text,
      CONSTRAINT claim_audit_outcome_check CHECK (outcome IN ('won','lost','timeout','error'))
    )`);
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await rootSql`DELETE FROM harness_shared.claim_audit`;
});

describe('claim_audit fixture is not stale (EI-21270668928342264 recurrence guard)', () => {
  it('matches the column set 000-baseline.sql actually declares', () => {
    const baseline = baselineClaimAuditColumns();

    // Positive control: if the locator silently matched nothing, `baseline` would be empty
    // and the comparison below would be vacuously satisfiable. Assert the instrument first.
    expect(baseline.length).toBeGreaterThan(0);
    expect(baseline).toContain('claimer_pubkey');

    expect([...FIXTURE_COLUMNS].sort()).toEqual([...baseline].sort());
  });

  it('provisioned the fixture with exactly those columns in the live test database', async () => {
    const rows = await rootSql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = 'claim_audit'`;
    expect(rows.map((r) => r.column_name).sort()).toEqual([...FIXTURE_COLUMNS].sort());
  });
});

describe('listWonClaimEnvelope against real Postgres', () => {
  it('counts ONLY won claims — lost, timeout and error attempts are not work', async () => {
    const at = MS('2026-08-01T00:00:00Z');
    await seedClaim({ featureId: 'WI-1', claimer: 'pk-a', outcome: 'won', atMs: at });
    await seedClaim({ featureId: 'WI-1', claimer: 'pk-b', outcome: 'lost', atMs: at + 1_000 });
    await seedClaim({ featureId: 'WI-1', claimer: 'pk-c', outcome: 'timeout', atMs: at + 2_000 });
    await seedClaim({ featureId: 'WI-1', claimer: 'pk-d', outcome: 'error', atMs: at + 3_000 });

    const [row] = await listWonClaimEnvelope({ harnessSlug: HARNESS, workItemIds: ['WI-1'] });

    expect(row?.wonClaimCount).toBe(1);
    expect(row?.distinctClaimants).toBe(1);
    // The non-won rows must not move the window either.
    expect(row?.lastWonAtMs).toBe(at);
  });

  it('distinguishes attempt count from claimant count (a swapped aggregate must fail here)', async () => {
    const at = MS('2026-08-02T00:00:00Z');
    // 3 won claims, but only 2 distinct claimants: pk-a re-attempted.
    await seedClaim({ featureId: 'WI-2', claimer: 'pk-a', outcome: 'won', atMs: at });
    await seedClaim({ featureId: 'WI-2', claimer: 'pk-b', outcome: 'won', atMs: at + 60_000 });
    await seedClaim({ featureId: 'WI-2', claimer: 'pk-a', outcome: 'won', atMs: at + 120_000 });

    const [row] = await listWonClaimEnvelope({ harnessSlug: HARNESS, workItemIds: ['WI-2'] });

    // Asymmetric ON PURPOSE. A fixture where these two are equal cannot tell count(*) from
    // count(DISTINCT ...), so it would pass against an implementation that confuses them.
    expect(row?.wonClaimCount).toBe(3);
    expect(row?.distinctClaimants).toBe(2);
    expect(row?.wonClaimCount).not.toBe(row?.distinctClaimants);
  });

  it('converts attempt_ts to epoch MILLISECONDS and spans first to last', async () => {
    const first = MS('2026-08-03T10:00:00Z');
    const last = MS('2026-08-03T14:30:00Z');
    await seedClaim({ featureId: 'WI-3', claimer: 'pk-a', outcome: 'won', atMs: first });
    await seedClaim({ featureId: 'WI-3', claimer: 'pk-a', outcome: 'won', atMs: MS('2026-08-03T12:00:00Z') });
    await seedClaim({ featureId: 'WI-3', claimer: 'pk-a', outcome: 'won', atMs: last });

    const [row] = await listWonClaimEnvelope({ harnessSlug: HARNESS, workItemIds: ['WI-3'] });

    expect(row?.firstWonAtMs).toBe(first);
    expect(row?.lastWonAtMs).toBe(last);
    // Guards the seconds-vs-milliseconds factor of 1000 directly: a seconds-valued result
    // would be ~1.8e9 rather than ~1.8e12, and every latency built on it would be wrong.
    expect(row!.lastWonAtMs - row!.firstWonAtMs).toBe(4.5 * 60 * 60 * 1000);
    expect(String(row!.firstWonAtMs).length).toBe(13);
  });

  it('excludes claims belonging to another workspace', async () => {
    const at = MS('2026-08-04T00:00:00Z');
    await seedClaim({ featureId: 'WI-4', claimer: 'pk-a', outcome: 'won', atMs: at });
    await seedClaim({
      workspaceId: OTHER_WORKSPACE,
      featureId: 'WI-4',
      claimer: 'pk-intruder',
      outcome: 'won',
      atMs: at + 1_000,
    });

    const [row] = await listWonClaimEnvelope({ harnessSlug: HARNESS, workItemIds: ['WI-4'] });

    expect(row?.wonClaimCount).toBe(1);
    expect(row?.distinctClaimants).toBe(1);
    expect(row?.lastWonAtMs).toBe(at);
  });

  it('excludes claims belonging to another harness in the same workspace', async () => {
    const at = MS('2026-08-05T00:00:00Z');
    await seedClaim({ featureId: 'WI-5', claimer: 'pk-a', outcome: 'won', atMs: at });
    await seedClaim({
      harnessSlug: OTHER_HARNESS,
      featureId: 'WI-5',
      claimer: 'pk-other-harness',
      outcome: 'won',
      atMs: at + 1_000,
    });

    const [row] = await listWonClaimEnvelope({ harnessSlug: HARNESS, workItemIds: ['WI-5'] });

    expect(row?.wonClaimCount).toBe(1);
    expect(row?.lastWonAtMs).toBe(at);
  });

  it('returns only the requested ids, and groups per item', async () => {
    const at = MS('2026-08-06T00:00:00Z');
    await seedClaim({ featureId: 'WI-6', claimer: 'pk-a', outcome: 'won', atMs: at });
    await seedClaim({ featureId: 'WI-6', claimer: 'pk-b', outcome: 'won', atMs: at + 1_000 });
    await seedClaim({ featureId: 'WI-7', claimer: 'pk-c', outcome: 'won', atMs: at + 2_000 });

    const rows = await listWonClaimEnvelope({ harnessSlug: HARNESS, workItemIds: ['WI-6'] });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.workItemId).toBe('WI-6');
    expect(rows[0]?.wonClaimCount).toBe(2);

    // Control: WI-7 exists and is reachable — so the single row above is the id filter
    // working, not an empty table masquerading as a filtered result.
    const both = await listWonClaimEnvelope({ harnessSlug: HARNESS, workItemIds: ['WI-6', 'WI-7'] });
    expect(both.map((r) => r.workItemId).sort()).toEqual(['WI-6', 'WI-7']);
  });

  it('short-circuits an empty id list without consulting the database', async () => {
    const at = MS('2026-08-07T00:00:00Z');
    await seedClaim({ featureId: 'WI-8', claimer: 'pk-a', outcome: 'won', atMs: at });

    expect(await listWonClaimEnvelope({ harnessSlug: HARNESS, workItemIds: [] })).toEqual([]);

    // Control: the row IS there, so the empty result above is the short-circuit rather
    // than a seeding failure that would make this test vacuous.
    expect(await listWonClaimEnvelope({ harnessSlug: HARNESS, workItemIds: ['WI-8'] })).toHaveLength(1);
  });

  it('reports an unclaimed item as an ABSENT row, not a zero-count row', async () => {
    await seedClaim({ featureId: 'WI-9', claimer: 'pk-a', outcome: 'won', atMs: MS('2026-08-08T00:00:00Z') });

    const rows = await listWonClaimEnvelope({ harnessSlug: HARNESS, workItemIds: ['WI-9', 'WI-never-claimed'] });

    // Consumers treat a missing row as "no claim ledger for this item" (see the escape
    // measure's header: an item with no ledger row cannot exhibit a post-close reclaim).
    // A zero-count row instead of an absent one would silently enter their denominators.
    expect(rows.map((r) => r.workItemId)).toEqual(['WI-9']);
    expect(rows.every((r) => r.wonClaimCount >= 1)).toBe(true);
  });
});
