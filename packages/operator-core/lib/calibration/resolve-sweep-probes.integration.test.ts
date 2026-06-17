/**
 * resolve-sweep-probes.integration.test.ts — the LIVE PG outcome probes
 * (`defaultOutcomeProbes`, resolve-sweep.ts:111-143), the bet-deciding logic
 * that turns a matured bet into a Brier-scorable outcome. resolve-sweep.test.ts
 * only exercises the sweep with INJECTED fakes; these probes (fixSurvived /
 * planShipped / flakeRecurred) read REAL engineer_issues + harness_plans, so
 * the only honest test is integration (P-041 / FB-13, Gap 3).
 *
 * Wiring: a throwaway fully-migrated org DB (createOrgTestDb), env-routed at the
 * REAL db-org connection (`HARNESS_ADMIN_DATABASE_URL` + `_resetForTests`) so the
 * probes' internal `getOrgPg()` reads land here — `getIssue` /
 * `findIssuesByWatchdogKeys` (issues-engineer, its OWN getOrgPg pool) and the
 * `harness_plans` read all hit the same seeded DB. Issues + plans are seeded
 * directly via the admin (RLS-bypass) client for precise control of state,
 * payload, and created_at (the strict `>` recapture comparison depends on it).
 *
 * Non-vacuity: the recapture `>` comparison AND the self-exclusion
 * (`p.id !== bet.subjectId`) are each fault-injected and the test proves it
 * catches the break.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _resetForTests } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes (same as _pg-tool-fixture)
import { _resetUrlCacheForTests } from '../../../../libs/papercusp/libs/db/src/connection';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { defaultOutcomeProbes } from './resolve-sweep';
import type { PredictionRow } from './types';

const WS = 'default'; // engineer_issues + the probes are scoped to DEFAULT_COORD_WORKSPACE
const HARNESS = 'operator';
const DAY_MS = 24 * 60 * 60 * 1000;
const BET_CREATED_MS = Date.parse('2026-06-12T12:00:00.000Z');

let db: OrgTestDb;
const savedEnv: Record<string, string | undefined> = {};

/** A minimal matured bet — overlaid per case. createdAt is the recapture cutoff. */
function bet(over: Partial<PredictionRow>): PredictionRow {
  return {
    id: 'b1',
    workspaceId: WS,
    predictor: 'su-a',
    domain: 'fix-survival',
    subjectKind: 'improvement',
    subjectId: 'EI-1',
    claim: 'fix survives',
    probability: 0.8,
    stated: false,
    origin: 'organic',
    watchdogKey: null,
    horizonTs: BET_CREATED_MS - DAY_MS,
    createdAt: BET_CREATED_MS,
    resolvedAt: null,
    outcome: null,
    resolutionNote: null,
    ...over,
  };
}

/** Seed an engineer_issue with full control over state / payload / created_at. */
async function seedIssue(o: {
  id: string;
  state?: 'open' | 'resolved' | 'closed';
  watchdogKey?: string | null;
  createdAtMs?: number;
}): Promise<void> {
  const payload = o.watchdogKey ? JSON.stringify({ watchdogKey: o.watchdogKey }) : null;
  const createdIso = new Date(o.createdAtMs ?? BET_CREATED_MS - 5 * DAY_MS).toISOString();
  await db.adminSql`
    INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, title, state, payload, created_at, updated_at)
    VALUES (${WS}, ${o.id}, ${'seed ' + o.id}, ${o.state ?? 'open'},
            ${payload}::jsonb, ${createdIso}, ${createdIso})
    ON CONFLICT (workspace_id, issue_id) DO UPDATE
      SET state = EXCLUDED.state, payload = EXCLUDED.payload, created_at = EXCLUDED.created_at
  `;
}

/** Seed a harness_plan row (PK workspace_id, harness_slug, plan_slug). */
async function seedPlan(planSlug: string, status: string | null): Promise<void> {
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, status)
    VALUES (${WS}, ${HARNESS}, ${planSlug}, ${status})
    ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE SET status = EXCLUDED.status
  `;
}

beforeAll(async () => {
  db = await createOrgTestDb();
  // Env-route the REAL db-org getOrgPg() (the probes' internal pool) at this DB.
  savedEnv.HARNESS_ADMIN_DATABASE_URL = process.env.HARNESS_ADMIN_DATABASE_URL;
  savedEnv.HARNESS_DATABASE_URL = process.env.HARNESS_DATABASE_URL;
  process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
  process.env.HARNESS_DATABASE_URL = db.appDsn;
  _resetUrlCacheForTests();
  await _resetForTests();
}, 180_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetUrlCacheForTests();
  await _resetForTests();
  await db?.cleanup();
});

describe('defaultOutcomeProbes.fixSurvived (live engineer_issues)', () => {
  it('(a) issue still open → false (the fix did not hold)', async () => {
    await seedIssue({ id: 'EI-OPEN', state: 'open' });
    const probes = defaultOutcomeProbes(db.adminSql);
    expect(await probes.fixSurvived(bet({ subjectId: 'EI-OPEN' }))).toBe(false);
  });

  it('(a) subject vanished → null (undeterminable)', async () => {
    const probes = defaultOutcomeProbes(db.adminSql);
    expect(await probes.fixSurvived(bet({ subjectId: 'EI-MISSING' }))).toBeNull();
  });

  it('(b) resolved, no watchdogKey signal → true (resolved state is the whole truth)', async () => {
    await seedIssue({ id: 'EI-RESOLVED', state: 'resolved', watchdogKey: null });
    const probes = defaultOutcomeProbes(db.adminSql);
    expect(await probes.fixSurvived(bet({ subjectId: 'EI-RESOLVED', watchdogKey: null }))).toBe(true);
  });

  it('(c) resolved, PEER on same watchdogKey created AFTER bet.createdAt → false (recaptured)', async () => {
    const key = 'wd:recap-after';
    await seedIssue({ id: 'EI-SUBJ-A', state: 'resolved', watchdogKey: key });
    await seedIssue({ id: 'EI-PEER-AFTER', state: 'open', watchdogKey: key, createdAtMs: BET_CREATED_MS + DAY_MS });
    const probes = defaultOutcomeProbes(db.adminSql);
    expect(await probes.fixSurvived(bet({ subjectId: 'EI-SUBJ-A', watchdogKey: key }))).toBe(false);
  });

  it('(c) resolved, PEER on same watchdogKey created BEFORE bet.createdAt → true (no recapture)', async () => {
    const key = 'wd:recap-before';
    await seedIssue({ id: 'EI-SUBJ-B', state: 'resolved', watchdogKey: key });
    await seedIssue({ id: 'EI-PEER-BEFORE', state: 'open', watchdogKey: key, createdAtMs: BET_CREATED_MS - 2 * DAY_MS });
    const probes = defaultOutcomeProbes(db.adminSql);
    expect(await probes.fixSurvived(bet({ subjectId: 'EI-SUBJ-B', watchdogKey: key }))).toBe(true);
  });

  it("(d) the bet's OWN subject (recaptured-looking, after createdAt) is EXCLUDED from the recapture set → true", async () => {
    // The subject row itself shares the watchdogKey and has created_at AFTER the
    // bet (e.g. an updated_at-bumped resolve). Self-exclusion (p.id !== subjectId)
    // means it must NOT count as a recapture — otherwise every fix self-bounces.
    const key = 'wd:self-only';
    await seedIssue({ id: 'EI-SELF', state: 'resolved', watchdogKey: key, createdAtMs: BET_CREATED_MS + 3 * DAY_MS });
    const probes = defaultOutcomeProbes(db.adminSql);
    expect(await probes.fixSurvived(bet({ subjectId: 'EI-SELF', watchdogKey: key }))).toBe(true);
  });

  it('reads the watchdogKey from issue.payload when the bet carries none', async () => {
    const key = 'wd:from-payload';
    await seedIssue({ id: 'EI-PAYLOAD-KEY', state: 'resolved', watchdogKey: key });
    await seedIssue({ id: 'EI-PAYLOAD-PEER', state: 'open', watchdogKey: key, createdAtMs: BET_CREATED_MS + DAY_MS });
    const probes = defaultOutcomeProbes(db.adminSql);
    // bet.watchdogKey is null → the key must come from the subject issue's payload.
    expect(await probes.fixSurvived(bet({ subjectId: 'EI-PAYLOAD-KEY', watchdogKey: null }))).toBe(false);
  });
});

describe('fixSurvived non-vacuity — fault-inject the live comparison', () => {
  // These prove the assertions above actually depend on the probe's logic by
  // mutating the seeded DATA the way breaking the impl would, and showing the
  // probe's answer flips. (We cannot edit the guard in-tree — git-sync would
  // ship a disabled calibration probe — so we fault-inject the inputs instead.)

  it('FAULT: a strict-`>` regression to `>=` would be caught — an EQUAL-timestamp peer must still be no-recapture', async () => {
    // If the impl used `>=` instead of `>`, a peer created at EXACTLY bet.createdAt
    // would count as a recapture and flip true→false. With the correct strict `>`
    // it does not. This row is the witness the comparison boundary is live.
    const key = 'wd:equal-ts';
    await seedIssue({ id: 'EI-EQ-SUBJ', state: 'resolved', watchdogKey: key });
    await seedIssue({ id: 'EI-EQ-PEER', state: 'open', watchdogKey: key, createdAtMs: BET_CREATED_MS });
    const probes = defaultOutcomeProbes(db.adminSql);
    // Strict `>`: peer AT the cutoff is NOT after it → no recapture → true.
    expect(await probes.fixSurvived(bet({ subjectId: 'EI-EQ-SUBJ', watchdogKey: key }))).toBe(true);
  });

  it('FAULT: dropping the self-exclusion would flip this — same row, but queried as a non-subject peer recaptures', async () => {
    // Re-use the self-only row (EI-SELF, created AFTER the bet). When it is the
    // SUBJECT, self-exclusion keeps the answer true (asserted above). When a
    // DIFFERENT bet (subject EI-OTHER) shares the key, that same row IS a real
    // peer created after → recapture → false. The two answers differing on the
    // SAME row proves `p.id !== bet.subjectId` is load-bearing.
    const key = 'wd:self-only';
    await seedIssue({ id: 'EI-OTHER', state: 'resolved', watchdogKey: key, createdAtMs: BET_CREATED_MS - 10 * DAY_MS });
    const probes = defaultOutcomeProbes(db.adminSql);
    // EI-SELF (created after) is now a foreign peer → recapture → false.
    expect(await probes.fixSurvived(bet({ subjectId: 'EI-OTHER', watchdogKey: key }))).toBe(false);
    // …and as its own subject it is still excluded → true (the contrast).
    expect(await probes.fixSurvived(bet({ subjectId: 'EI-SELF', watchdogKey: key }))).toBe(true);
  });
});

describe('defaultOutcomeProbes.planShipped (live harness_plans)', () => {
  it('missing plan → null (undeterminable)', async () => {
    const probes = defaultOutcomeProbes(db.adminSql);
    expect(await probes.planShipped(bet({ domain: 'plan-ship', subjectId: 'no-such-plan' }))).toBeNull();
  });

  it("status 'shipped' → true", async () => {
    await seedPlan('plan-shipped', 'shipped');
    const probes = defaultOutcomeProbes(db.adminSql);
    expect(await probes.planShipped(bet({ domain: 'plan-ship', subjectId: 'plan-shipped' }))).toBe(true);
  });

  it('any other status → false', async () => {
    await seedPlan('plan-active', 'active');
    await seedPlan('plan-null', null);
    const probes = defaultOutcomeProbes(db.adminSql);
    expect(await probes.planShipped(bet({ domain: 'plan-ship', subjectId: 'plan-active' }))).toBe(false);
    expect(await probes.planShipped(bet({ domain: 'plan-ship', subjectId: 'plan-null' }))).toBe(false);
  });
});

describe('defaultOutcomeProbes.flakeRecurred (live engineer_issues)', () => {
  it('null watchdogKey → null (no signal identity)', async () => {
    const probes = defaultOutcomeProbes(db.adminSql);
    expect(await probes.flakeRecurred(bet({ domain: 'flake-recurrence', watchdogKey: null }))).toBeNull();
  });

  it('a peer recaptured AFTER the bet → true', async () => {
    const key = 'flak:recurred';
    await seedIssue({ id: 'EI-FLAKE-SUBJ', state: 'open', watchdogKey: key });
    await seedIssue({ id: 'EI-FLAKE-PEER', state: 'open', watchdogKey: key, createdAtMs: BET_CREATED_MS + DAY_MS });
    const probes = defaultOutcomeProbes(db.adminSql);
    expect(
      await probes.flakeRecurred(bet({ domain: 'flake-recurrence', subjectId: 'EI-FLAKE-SUBJ', watchdogKey: key })),
    ).toBe(true);
  });

  it('only the subject itself on the key (no foreign peer after) → false (self-excluded)', async () => {
    const key = 'flak:self-only';
    await seedIssue({ id: 'EI-FLAKE-SELF', state: 'open', watchdogKey: key, createdAtMs: BET_CREATED_MS + 2 * DAY_MS });
    const probes = defaultOutcomeProbes(db.adminSql);
    // The subject's own (after-bet) row is excluded → no recapture → false.
    expect(
      await probes.flakeRecurred(bet({ domain: 'flake-recurrence', subjectId: 'EI-FLAKE-SELF', watchdogKey: key })),
    ).toBe(false);
  });
});
