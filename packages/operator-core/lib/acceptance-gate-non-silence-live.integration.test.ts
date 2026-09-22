/**
 * R-8, live plane — no acceptance-gate disposition leaves a plan in
 * `awaiting-acceptance` with neither a recruited grader nor a RAISED, OWNED
 * author-repair obligation. The author-repair path is not silent.
 *
 * The bar is plan decision D-019's ruling, and D-019 records why the first
 * draft was unpassable: R-1 REQUIRES author-repair codes not to recruit a
 * grader, so "no grader" is the correct state for that whole class and cannot
 * be the falsification. The real defect D-019 named is that the author-repair
 * path was SILENT — the refusal was returned and nothing was raised, so a stall
 * could only be found by a human or a passing agent. This file asserts the
 * non-silence half, on both sides of the class split.
 *
 * ⚠ SCOPE, STATED HONESTLY. Two legs of D-019's chain are deliberately NOT
 * re-proven here:
 *  - grader RECRUITMENT and PICKUP is the subject of
 *    `acceptance-grader-pickup-live.integration.test.ts` (R-3), against real PG.
 *    Restating it here would duplicate a live proof, not add one.
 *  - the terminal `shipped` transition is R-4's.
 * What this file adds is the property neither covers: that EVERY disposition
 * the gate can report classifies into a raised obligation, and that the author
 * class raises an owned, actionable one WITHOUT widening recruitment.
 *
 * Real PG for the author leg: the classification is driven by
 * `evaluatePlanAcceptanceGate`'s own `code`, so a test that hand-writes the code
 * proves the mapping and nothing about whether the gate ever emits a code in
 * that class. The first case therefore drives a real plan row through the real
 * gate and feeds the REAL verdict to the provider.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { evaluatePlanAcceptanceGate } from './plan-acceptance-gate';
import type { PlanAcceptanceGateVerdict } from './plan-acceptance-gate';
import {
  GATE_CODE_OWNERSHIP,
  independentVerificationObligation,
} from './agent-obligation-providers';
import { activeWorkspaceId } from './workspace-registry';

const { createOrgTestDb } = await import('../test/_org-test-db');
const { _resetHarnessAdminUrlCacheForTests } = await import('./embedded-pg-discovery');

/**
 * `evaluatePlanAcceptanceGate` takes no `workspaceId` — it resolves one
 * ambiently — so the fixture row must be seeded under the SAME ambient value the
 * gate will resolve, or the gate reads an empty database and refuses for a
 * reason this test never arranged.
 */
const WORKSPACE = activeWorkspaceId();
const HARNESS = 'papercusp';
const SLUG = 'plan-r8-author-repair';

const SAVED_ADMIN_URL = process.env.HARNESS_ADMIN_DATABASE_URL;

/** Filled by the live gate in `beforeAll`; every case below builds on it. */
let liveVerdict: PlanAcceptanceGateVerdict;

function obligationFor(gate: PlanAcceptanceGateVerdict) {
  return independentVerificationObligation({
    workspaceId: WORKSPACE,
    ownerId: 'su-r8-live-fixture',
    observedAt: new Date().toISOString(),
    sourceGeneration: 'r8-live-1',
    planSlug: SLUG,
    read: {
      status: 'known',
      value: {
        gate,
        evidenceRef: 'evaluatePlanAcceptanceGate',
        // `gradeable: false` short-circuits to a 'not-applicable' obligation
        // ABOVE the classification this bar is about, so every case here must
        // pass `true` or it measures the short-circuit instead.
        gradeable: true,
      },
    },
  });
}

describe('R-8 acceptance-gate non-silence (real PG + real gate)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetHarnessAdminUrlCacheForTests();

    // One-time, process-global side effects of the re-route, taken HERE so
    // `vitest-fail-on-console` cannot attribute them to whichever test ran
    // first. The store-identity pin is set against the real cluster by
    // `createOrgTestDb`'s own provisioning connection; the gate then opens the
    // admin pool against this test database and the guard correctly reports a
    // different `system_identifier`.
    {
      const { getOrgPg, _resetStoreIdentityForTests } = await import('@papercusp/db-org');
      _resetStoreIdentityForTests();
      await getOrgPg().sql`SELECT 1`;
    }

    // A plan that has finished its work and is waiting to be certified, with NO
    // acceptance rubric and no completion audit. That is an AUTHOR-REPAIR
    // disposition by construction: the repair (author a rubric / file the audit)
    // is the plan author's alone, and R-1 forbids recruiting a peer for it.
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, content, items)
      VALUES (
        ${WORKSPACE}, ${HARNESS}, ${SLUG}, 'R-8 author-repair plan', 'awaiting-acceptance',
        ${[
          '---',
          'title: R-8 author-repair plan',
          `slug: ${SLUG}`,
          'status: awaiting-acceptance',
          '---',
          '',
          '## Now',
          '',
          'state: implementation finished, certification not yet possible',
          'next: none',
          '',
        ].join('\n')},
        ${db.adminSql.json([{ id: 'P-001', status: 'done', text: 'implementation, finished' }])}
      )`;

    liveVerdict = await evaluatePlanAcceptanceGate(SLUG, { harnessSlug: HARNESS });
  }, 180_000);

  afterAll(async () => {
    if (SAVED_ADMIN_URL === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
    else process.env.HARNESS_ADMIN_DATABASE_URL = SAVED_ADMIN_URL;
    _resetHarnessAdminUrlCacheForTests();
    // Leave no pin on a database that is about to be dropped.
    {
      const { _resetStoreIdentityForTests } = await import('@papercusp/db-org');
      _resetStoreIdentityForTests();
    }
    await db?.cleanup();
  });

  it('INSTRUMENT: the live gate really refuses this plan, with a code in the AUTHOR class', () => {
    // Without this, a gate that returned `ok: true` — or a code the Record does
    // not classify — would let every assertion below pass while measuring
    // nothing about the author branch.
    expect(
      liveVerdict.skipped,
      'the gate must actually APPLY — a skipped verdict decides nothing to classify',
    ).toBeUndefined();
    expect(
      liveVerdict.satisfied,
      'the seeded plan must be refused, or there is no disposition to classify',
    ).toBe(false);
    expect(liveVerdict.code, 'the refusal must name a code').toBeTruthy();
    const code = liveVerdict.code as keyof typeof GATE_CODE_OWNERSHIP;

    // The specific code is not pinned: several author-owned prerequisites are
    // missing at once and their order is the gate's business. What this bar
    // claims is the CLASS.
    expect(
      GATE_CODE_OWNERSHIP[code],
      `live gate code ${String(code)} must classify as author-owned repair`,
    ).toBe('author');
  });

  it('AUTHOR REPAIR IS RAISED, NOT SILENT — from the real verdict, and it recruits nobody', () => {
    const obligation = obligationFor(liveVerdict);

    // RAISED: an actionable obligation an operator does not have to notice.
    expect(obligation.status, 'an author-owned repair is actionable now').toBe('due');
    expect(obligation.action?.kind).toBe('repair');
    expect(obligation.action?.targetRef).toBe(SLUG);

    // OWNED, and ranked upstream: author repair is a prerequisite to grading, so
    // it must not sit below the downstream symptoms it unblocks.
    expect(obligation.causalRank, 'author repair is upstream work').toBe(0);
    expect(obligation.title).toContain('author repair');

    // NOT SILENT: the refusal reaches the reader as a reason, rather than being
    // swallowed into a bare status.
    expect(typeof obligation.reason).toBe('string');
    expect((obligation.reason ?? '').length).toBeGreaterThan(0);

    // ⛔ THE R-1 NEGATIVE: making author work visible must never widen
    // recruitment. No peer is delegated to for this class.
    expect(obligation.action?.kind).not.toBe('delegate');
  });

  it('CONTROL: swapping ONE field — the gate code — to a grader-gap code does delegate', () => {
    // Everything else is the live verdict, unchanged. A negative assertion that
    // can never fail is worth nothing, so this is the case that proves the
    // `not.toBe('delegate')` above discriminates rather than matching a branch
    // the provider never takes.
    const graderGap = { ...liveVerdict, code: 'acceptance_ungraded' as const };
    const obligation = obligationFor(graderGap);

    expect(GATE_CODE_OWNERSHIP.acceptance_ungraded).toBe('grader');
    expect(obligation.action?.kind).toBe('delegate');
    expect(obligation.status).toBe('due');
    expect(obligation.title).toContain('independent grader');
  });

  it('FALSIFIER: NO gate disposition yields an unraised obligation — swept over every code', () => {
    // The population is derived from the Record's own keys. A hand-listed copy
    // is exactly the drift the exhaustive Record replaced, and would silently
    // stop covering the next code anyone adds — which is the hole D-009 found
    // seven codes sitting in.
    const codes = Object.keys(GATE_CODE_OWNERSHIP) as Array<keyof typeof GATE_CODE_OWNERSHIP>;
    expect(codes.length, 'the code population must be non-empty, or this sweep is vacuous').toBeGreaterThan(0);

    const unraised: string[] = [];
    const seen = new Set<string>();

    for (const code of codes) {
      const obligation = obligationFor({ ...liveVerdict, code } as PlanAcceptanceGateVerdict);
      const ownership = GATE_CODE_OWNERSHIP[code];
      seen.add(ownership);

      // The property, stated once: every disposition produces a RAISED
      // obligation carrying a named action. "Neither a grader nor an author
      // obligation" is the thing that must not exist.
      if (!obligation.action?.kind || !obligation.status) {
        unraised.push(`${String(code)} (${ownership})`);
        continue;
      }

      if (ownership === 'grader') {
        expect(obligation.action.kind, `${String(code)} must recruit a grader`).toBe('delegate');
        expect(obligation.status).toBe('due');
      } else if (ownership === 'author') {
        expect(obligation.action.kind, `${String(code)} must raise an owned author repair`).toBe('repair');
        expect(obligation.status, `${String(code)} must be actionable, not merely blocked`).toBe('due');
        expect(obligation.causalRank, `${String(code)} must rank upstream`).toBe(0);
        expect(obligation.action.kind, `${String(code)} must not recruit`).not.toBe('delegate');
      } else if (ownership === 'not-here') {
        // `plan_items_unfinished` never reaches this classification in
        // production — `gradeable` short-circuits it well above — so it is
        // covered for completeness rather than as a live disposition.
        expect(obligation.action.kind).toBe('repair');
      } else {
        // `unmeasured` is the ONE class that is deliberately neither a grader
        // gap nor an author repair, and widening it would dress a failed gate
        // READ up as work the author owes. It still must not be silent: it is
        // raised as an explicit `inspect`, which is a stated disposition rather
        // than a fall-through.
        expect(ownership).toBe('unmeasured');
        expect(obligation.action.kind, `${String(code)} must be raised for inspection`).toBe('inspect');
        expect(obligation.status).toBe('blocked');
      }
    }

    expect(unraised, 'these gate codes produced no raised obligation').toEqual([]);

    // The sweep is only meaningful if it actually crossed the class boundary.
    // If a future edit collapsed every code into one ownership, the per-branch
    // assertions above would all still pass.
    expect(seen.has('grader'), 'the sweep must include at least one grader-gap code').toBe(true);
    expect(seen.has('author'), 'the sweep must include at least one author-repair code').toBe(true);
  });
});
