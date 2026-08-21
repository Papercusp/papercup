/**
 * work-items-issue-claim-spec-rank.integration.test.ts — EI-19497592871345016: the
 * issue-family claim path must APPLY the caller's compiled `spec.rank`, not discard it.
 *
 * ROOT CAUSE (confirmed live 2026-08-04): `claimNextIssueWorkItem`'s ORDER BY was HARDCODED
 * to `feature_order ASC NULLS LAST, created_ts ASC`, while the SAME query already honored the
 * caller's compiled `spec.view.filter` (opts.specFilterSql). So a claim spec could NARROW the
 * issue family but never REORDER it — contradicting scheduler:get_next's own contract
 * ("ordered by spec.rank") and the spec provenance it stamps on every claim. Because
 * `feature_order` is NULL across the entire issue pool, that hardcoded ordering collapsed to
 * plain OLDEST-FIRST.
 *
 * Two consequences, both measured on the live pool that day:
 *   • scheduler:get_next served EI-8600 (minor, created 2026-07-07) while work_items:claimable
 *     — the same floor oracle — reported 1,675 claimable with SEVEN criticals at the head,
 *     none claim-held. The criticals were effectively unreachable by self-pull.
 *   • the `severity_rank` term added to DEFAULT_CLAIM_SPEC by EI-19286355119013384 was INERT
 *     for the family its own comment says it was added to fix ("Net effect is scoped to
 *     issue-family rows, which is the family that was mis-ordered"). It reaches only the
 *     feature-family tiers 1/2, and the issue family is served exclusively by tier 3.
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   • WITHOUT a compiled spec rank, ordering is unchanged — plain oldest-first (this is the
 *     regression guard for the legacy `claimNextWorkItem` tier-3 caller, which has no spec);
 *   • WITH DEFAULT_CLAIM_SPEC's compiled rank, a NEWER critical is served ahead of an OLDER
 *     minor — i.e. severity_rank finally reaches the family it was written for;
 *   • severity ordering is a true ordinal, not a lexical sort (critical > major > minor > nit
 *     — a lexical `severity DESC` would put `nit` first, which is why the bare field is not
 *     rankable and `severity_rank` exists);
 *   • an absent/unrecognized severity sorts LAST rather than NULL-first, so an unlabelled row
 *     can never outrank a real critical;
 *   • `feature_order` steering (EI-7407) still wins where the spec declares `priority`, which
 *     DEFAULT_CLAIM_SPEC does — so the Mug's set_priority lever survives this change.
 *
 * FALSIFIABILITY: the `applies DEFAULT_CLAIM_SPEC's rank` cases fail if `specOrderSql` stops
 * being threaded from get-next.ts's tier-3 call site into claimNextIssueWorkItem — the exact
 * wiring that was missing. The `no spec rank` case fails if the legacy fallback is dropped.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-issue-claim-spec-rank.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');
const { compileRank } = await import('./scheduler/get-next');
const { DEFAULT_CLAIM_SPEC } = await import('./scheduler/claim-spec');
// getOrgPg is mocked above to hand back the testcontainer client, so this returns `db.sql`
// at runtime while keeping the STATIC `OrgSql` type compileRank expects — no cast needed.
const { getOrgPg } = await import('@papercusp/db-org');

const H = 'papercup';
const WS = 'default';
const BEE = 'bee-rank-1';
let db: FreshPgDb;

/**
 * Seed one issue-family row. `severity` is written to `payload._ei.severity` — the accessor
 * the claim query actually reads on `harness_shared.work_items` (the TABLE). Note the sibling
 * `engineer_issues` VIEW exposes severity as a real column and DROPS the `_ei` blob, so the
 * two relations need different accessors; binding the wrong one yields a well-formed, plausible
 * and WRONG answer (WI-6674). This test deliberately exercises the TABLE path.
 */
async function seedIssue(
  id: string,
  opts: { createdTs: number; severity?: string; featureOrder?: number | null },
) {
  const payload = opts.severity === undefined ? {} : { _ei: { severity: opts.severity } };
  // Use postgres-js `sql.json()` here — the idiom every sibling work_items integration test
  // uses against this raw testcontainer client. A hand-rolled `${JSON.stringify(p)}::jsonb`
  // double-encodes into a jsonb STRING SCALAR, and the engineer_issues view's `payload - '_ei'`
  // then fails the post-claim re-read with "cannot delete from scalar" (measured 2026-08-04).
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id,
       created_ts, updated_ts, payload, feature_order)
    VALUES (${H}, ${id}, 'bug', ${`title ${id}`}, 'open', ${null}, ${WS},
            ${opts.createdTs}, 0, ${db.sql.json(payload)}, ${opts.featureOrder ?? null})`;
}

/** The compiled DEFAULT_CLAIM_SPEC rank, exactly as get-next.ts's tier 3 now passes it down. */
const defaultSpecOrder = () => compileRank(getOrgPg().sql, DEFAULT_CLAIM_SPEC, { assignee: BEE });

/** Claim one issue-family item through the real claim path, optionally with a spec rank. */
const claimIssue = (opts: { withSpecRank: boolean }) =>
  wi.claimNextIssueWorkItem({ harness: H, assignee: BEE }, WS, {
    issueKinds: ['bug'],
    ...(opts.withSpecRank ? { specOrderSql: defaultSpecOrder() } : {}),
  });

beforeAll(async () => {
  db = await createFreshPgDb('wi-issue-claim-spec-rank');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await ensureCoordCapabilityTables(db.sql);
}, 180_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
  });
  // Never let the release-cooldown floor confound an ordering assertion.
  delete process.env.PAPERCUSP_RELEASE_COOLDOWN_SEC;
});
afterEach(() => {
  setFlagOverridesForTest({});
});

describe('issue-family claim ordering WITHOUT a compiled spec rank (legacy caller unchanged)', () => {
  it('serves oldest-first, ignoring severity — the pre-existing behavior', async () => {
    await seedIssue('WI-old-minor', { createdTs: 100, severity: 'minor' });
    await seedIssue('WI-new-critical', { createdTs: 900, severity: 'critical' });

    const got = await claimIssue({ withSpecRank: false });
    expect(got?.id).toBe('WI-old-minor');
  });
});

describe('issue-family claim ordering WITH DEFAULT_CLAIM_SPEC’s compiled rank (EI-19497592871345016)', () => {
  it('serves the NEWER critical ahead of the OLDER minor', async () => {
    await seedIssue('WI-old-minor', { createdTs: 100, severity: 'minor' });
    await seedIssue('WI-new-critical', { createdTs: 900, severity: 'critical' });

    const got = await claimIssue({ withSpecRank: true });
    expect(got?.id).toBe('WI-new-critical');
  });

  it('orders severity as an ORDINAL, not lexically (critical > major > minor > nit)', async () => {
    // Seeded so that BOTH plain oldest-first AND a lexical `severity DESC` would pick a
    // different row than the correct ordinal answer: oldest-first would take WI-nit (the
    // oldest), and a lexical sort would take WI-nit as well ('nit' > 'minor' > 'major' >
    // 'critical' as text). Only a true ordinal serves the critical.
    await seedIssue('WI-nit', { createdTs: 100, severity: 'nit' });
    await seedIssue('WI-minor', { createdTs: 200, severity: 'minor' });
    await seedIssue('WI-major', { createdTs: 300, severity: 'major' });
    await seedIssue('WI-critical', { createdTs: 400, severity: 'critical' });

    expect((await claimIssue({ withSpecRank: true }))?.id).toBe('WI-critical');
    expect((await claimIssue({ withSpecRank: true }))?.id).toBe('WI-major');
    expect((await claimIssue({ withSpecRank: true }))?.id).toBe('WI-minor');
    expect((await claimIssue({ withSpecRank: true }))?.id).toBe('WI-nit');
  });

  it('sorts an ABSENT severity last, so an unlabelled row cannot outrank a real critical', async () => {
    await seedIssue('WI-unlabelled', { createdTs: 100 }); // no severity at all
    await seedIssue('WI-critical', { createdTs: 900, severity: 'critical' });

    expect((await claimIssue({ withSpecRank: true }))?.id).toBe('WI-critical');
    expect((await claimIssue({ withSpecRank: true }))?.id).toBe('WI-unlabelled');
  });

  it('still honors feature_order steering (EI-7407) — DEFAULT_CLAIM_SPEC declares `priority`', async () => {
    // Same severity across the board, so `severity_rank` is inert here and the NEXT term
    // decides: feature_order ASC NULLS LAST. The Mug's set_priority lever must survive.
    await seedIssue('WI-unsteered', { createdTs: 100, severity: 'minor' });
    await seedIssue('WI-steered', { createdTs: 900, severity: 'minor', featureOrder: 1 });

    const got = await claimIssue({ withSpecRank: true });
    expect(got?.id).toBe('WI-steered');
  });
});
