/**
 * R-6, live plane — the plan-agent brief's DIRECTED NEXT ACTION is computed from
 * the live counts at build time, and acceptance out-ranks delegation in the one
 * state where delegation's own preconditions are all satisfied.
 *
 * Real PG on purpose. `delegation-posture-brief.test.ts` already covers every
 * branch of `directedDelegationAction` — including this conjunction — but it does
 * so by handing `renderDelegationPostureBlock` a literal `DelegationCounts`. That
 * proves the BRANCHING and nothing about the WIRING: whether a real database
 * state producing this conjunction actually reaches the renderer. A bundle that
 * read a stale cache, resolved the wrong workspace, or lost the counts between
 * the provider and the block renders identically under every unit fixture,
 * because a unit fixture supplies the value the wiring is supposed to fetch.
 * So `buildPlanContextBundle` runs here with `readDelegation` OMITTED — the
 * production path, `readDelegationCounts` against rows this test really wrote.
 *
 * ⚠ THE CONJUNCTION IS THE WHOLE POINT. `plansAwaitingAcceptance >= 1` AND
 * `planExecutionAgents === 0` AND `plansAwaitingDelegation >= 1` is the only
 * state where the two top priority rules disagree: rule 2's entire test
 * (`acceptanceSettled && noLiveAgents && haveActionable`) is satisfied except
 * for the acceptance clause, so an implementation that checked delegation first
 * — or that dropped the acceptance count on the floor — emits a LAUNCH here and
 * passes every single-population fixture. The negative assertion ("does not
 * launch") is therefore load-bearing, and the settled-acceptance control below
 * is what proves it discriminates rather than matching a string that is never
 * emitted in either state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { readDelegationCounts } from './delegation-counts';
import { buildPlanContextBundle } from './agent-tools/plans/context-bundle';

const { createOrgTestDb } = await import('../test/_org-test-db');
const { _resetHarnessAdminUrlCacheForTests } = await import('./embedded-pg-discovery');

const WORKSPACE = 'plan-agent-brief-posture-live-ws';

/**
 * `plansAwaitingDelegation` and `plansAwaitingAcceptance` both filter their rows
 * through `isHarnessInScope`, whose policy cache is EMPTY under VITEST (the
 * refresh is a deliberate no-op there) and therefore fails OPEN. Seeding an
 * in-policy harness rather than an arbitrary one means this fixture counts the
 * same whether the cache is cold or primed, so the test is not silently resting
 * on that fail-open (WI-10002448).
 */
const HARNESS = 'papercusp';

/** The plan whose brief is built — and the one actionable plan awaiting delegation. */
const SUBJECT_SLUG = 'plan-r6-subject';
/** A DIFFERENT plan, awaiting acceptance. It is the acceptance count, nothing else. */
const AWAITING_SLUG = 'plan-r6-awaiting';
/** The acceptance rubric that makes AWAITING_SLUG gradeable. */
const RUBRIC_SLUG = 'acceptance-plan-r6-awaiting';

const SAVED_ADMIN_URL = process.env.HARNESS_ADMIN_DATABASE_URL;

/**
 * Per-source budget for the bundle's own delegation read — the SAME 30s this file
 * passes to its direct `readDelegationCounts` calls, so the two agree about what
 * counts as measured.
 *
 * Production's default is 900ms and correct (a turn-start brief must not block on a
 * slow source). But every source degrading to `unknown` renders a DO-NOT-SPAWN
 * directive, and on a loaded box — ~100 agents, a testcontainer PG, the pc-heavy
 * queue — that budget is regularly missed. This file asserts on which DIRECTIVE the
 * block renders, so under the production budget a red here means "the box was busy"
 * while looking exactly like "the brief directed the wrong action". Measured: this
 * file passed at 19:15Z and failed CONTROL at 20:09Z with no change to the code path
 * under test. The budget is widened rather than the assertions loosened, and the
 * PRODUCTION reader still runs — which is the wiring property these tests exist for.
 */
const BUNDLE_READ_BUDGET_MS = 30_000;

/**
 * The two directives, as the renderer actually spells them.
 *
 * Each is asserted POSITIVELY in one of the two states below, so a typo here
 * turns into a red test rather than a negative assertion that can never match.
 * That mutual coverage is what keeps `not.toContain(LAUNCH_DIRECTIVE)` from
 * being vacuous.
 */
const ACCEPTANCE_DIRECTIVE = 'ACCEPTANCE FIRST — at least one plan is awaiting acceptance';
const LAUNCH_DIRECTIVE =
  'DELEGATE — no acceptance is pending and live plan-execution agents is 0';
/** The THIRD state R-6 promises. Asserted positively by the IDLE case below. */
const IDLE_DIRECTIVE =
  'REPORT IDLE — no plan is awaiting acceptance and no actionable plan is awaiting delegation';

function planContent(slug: string, title: string, status: string): string {
  return [
    '---',
    `title: ${title}`,
    `slug: ${slug}`,
    `status: ${status}`,
    '---',
    '',
    '## Now',
    '',
    'state: seeded by the R-6 live fixture',
    'next: none',
    '',
  ].join('\n');
}

describe('R-6 live delegation posture (real PG through buildPlanContextBundle)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetHarnessAdminUrlCacheForTests();

    // Reset db-org, and warm the org-admin pool, HERE — not inside a test.
    // Both are one-time, process-global side effects of the env re-route above,
    // and `vitest-fail-on-console` attributes whichever fires first to whichever
    // TEST ran first — a setup artefact wearing the costume of a verdict about
    // the subject.
    //
    // ⚠ `_resetForTests` and not just `_resetStoreIdentityForTests`: db-org's
    // `adminUrl()` caches an env-sourced DSN for the life of the process
    // ("Env is stable for process lifetime → safe to cache", connection.ts:597).
    // That premise holds in production and is FALSE for the re-route above — if
    // anything resolved the admin URL before this `beforeAll`, the cache
    // short-circuits every later resolution, `endStalePool` compares the pool
    // against that same stale URL and never rebinds, and every read below goes
    // to whatever database the PARENT process was pointed at. So the outcome
    // depended on the RUNNER: a bare shell starts with the var unset, so the
    // first resolution lands as `discovery` (re-read every call) and the
    // re-route wins; `testing:run`'s child inherits :3070's live
    // HARNESS_ADMIN_DATABASE_URL and it does not. Measured one-variable:
    // unset ⇒ 5/5 pass, set ⇒ 5/5 fail with `acceptance is outstanding:
    // expected +0 to be 1` — the fixture's rows were being counted in the wrong
    // database. `_resetForTests` is db-org's one test-reset entrypoint and
    // clears the URL caches, the store-identity pin and every built pool
    // together.
    //
    // The pin specifically: `createOrgTestDb` provisions through the real
    // cluster on :5432, which pins store identity there. `buildPlanContextBundle`
    // then opens the admin pool against this test database on its own port, and
    // the guard correctly reports a different `system_identifier` as a WRONG
    // STORE via `console.error`. That guard is doing its job — the pin is simply
    // stale with respect to a re-route this test makes deliberately, so it is
    // reset at the same boundary as the URL cache rather than suppressed.
    {
      const { getOrgPg, _resetForTests } = await import('@papercusp/db-org');
      await _resetForTests();
      await getOrgPg().sql`SELECT 1`;
    }

    // SUBJECT: status `active` + `template IS NULL` + one `todo` item is exactly
    // the predicate `plansAwaitingDelegation` selects on, so this row IS the
    // actionable plan. No presence row is ever written, so nothing is staffed
    // and `planExecutionAgents` is an established 0.
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, content, items)
      VALUES (
        ${WORKSPACE}, ${HARNESS}, ${SUBJECT_SLUG}, 'R-6 subject plan', 'active',
        ${planContent(SUBJECT_SLUG, 'R-6 subject plan', 'active')},
        ${db.adminSql.json([{ id: 'P-001', status: 'todo', text: 'seeded actionable item' }])}
      )`;

    // AWAITING ACCEPTANCE: `awaiting-acceptance` is outside the ('ready','active')
    // set `plansAwaitingDelegation` requires, so this plan contributes to the
    // acceptance count and NOT to the delegation count. Keeping the two
    // populations on different rows is what makes the control below a
    // single-variable change.
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, content, items)
      VALUES (
        ${WORKSPACE}, ${HARNESS}, ${AWAITING_SLUG}, 'R-6 awaiting plan', 'awaiting-acceptance',
        ${planContent(AWAITING_SLUG, 'R-6 awaiting plan', 'awaiting-acceptance')},
        ${db.adminSql.json([{ id: 'P-001', status: 'done', text: 'already finished' }])}
      )`;

    // The acceptance rubric. `template = 'rubric'` keeps it out of BOTH counted
    // populations in its own right; it exists only to make AWAITING_SLUG
    // gradeable.
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, content, template, template_data)
      VALUES (
        ${WORKSPACE}, ${HARNESS}, ${RUBRIC_SLUG}, 'R-6 acceptance rubric', 'active',
        ${planContent(RUBRIC_SLUG, 'R-6 acceptance rubric', 'active')},
        'rubric',
        ${db.adminSql.json({ kind: 'acceptance', subjectPlan: AWAITING_SLUG })}
      )`;

    // The completion audit — the second half of "gradeable". This single row is
    // the variable the control test removes.
    await db.adminSql`
      INSERT INTO harness_shared.plan_audits
        (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind)
      VALUES (${WORKSPACE}, ${HARNESS}, ${AWAITING_SLUG}, 1, 'r6-live-fixture', 'completion')`;

    // Take the plan-bundle path's own one-time process chatter here too, for the
    // same reason. This runs AFTER the rows above exist, so it is a real build
    // rather than a probe of an empty database.
    await buildPlanContextBundle(SUBJECT_SLUG, {
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      delegationTimeoutMs: BUNDLE_READ_BUDGET_MS,
    });
  }, 180_000);

  afterAll(async () => {
    if (SAVED_ADMIN_URL === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
    else process.env.HARNESS_ADMIN_DATABASE_URL = SAVED_ADMIN_URL;
    _resetHarnessAdminUrlCacheForTests();
    // Leave no pin — and no cached URL, and no live pool — on a database that is
    // about to be dropped: a later file in this process would otherwise inherit
    // a pin to a store that no longer exists and report the real cluster as the
    // impostor, or keep resolving the admin DSN to this dropped database for the
    // rest of the process (the same env-cache pin explained in `beforeAll`).
    {
      const { _resetForTests } = await import('@papercusp/db-org');
      await _resetForTests();
    }
    await db?.cleanup();
  });

  it('INSTRUMENT: the seeded state really is the conjunction, measured — not assumed', async () => {
    const counts = await readDelegationCounts({ workspaceId: WORKSPACE, sourceTimeoutMs: 30_000 });

    // Guard the instrument before reading any verdict. `readDelegationCounts`
    // degrades a failed source to `unknown` rather than throwing, so a broken
    // fixture yields an all-unknown posture block — which renders a DO NOT SPAWN
    // directive that would satisfy the "does not launch" assertion below for
    // entirely the wrong reason. Asserting all three are `known` is what stops
    // this test passing while measuring nothing.
    expect(counts.degradedSources).toEqual([]);
    expect(counts.plansAwaitingAcceptance.status).toBe('known');
    expect(counts.planExecutionAgents.status).toBe('known');
    expect(counts.plansAwaitingDelegation.status).toBe('known');
    if (
      counts.plansAwaitingAcceptance.status !== 'known' ||
      counts.planExecutionAgents.status !== 'known' ||
      counts.plansAwaitingDelegation.status !== 'known'
    ) {
      return;
    }

    // All three legs of the conjunction, each stated separately so a failure
    // names which one the fixture lost.
    expect(counts.plansAwaitingAcceptance.value.count, 'acceptance is outstanding').toBe(1);
    expect(counts.planExecutionAgents.value.count, 'no plan-execution agent is live').toBe(0);
    expect(
      counts.plansAwaitingDelegation.value.count,
      'an actionable plan is awaiting delegation',
    ).toBe(1);
  });

  it('CONJUNCTION: acceptance outranks delegation even though every delegation precondition holds', async () => {
    const bundle = await buildPlanContextBundle(SUBJECT_SLUG, {
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      delegationTimeoutMs: BUNDLE_READ_BUDGET_MS,
    });
    expect(bundle, 'the subject plan must resolve, or nothing below is measured').not.toBeNull();
    if (!bundle) return;

    // The directive the brief must carry.
    expect(bundle.text).toContain(ACCEPTANCE_DIRECTIVE);

    // The NEGATIVE, observed rather than inferred from a spy: the launch
    // directive is absent from the seed text the agent is actually handed.
    expect(bundle.text).not.toContain(LAUNCH_DIRECTIVE);

    // ...and absent for the stated reason, not because the block degraded. A
    // measurement failure renders its own DO NOT SPAWN directive, which would
    // also satisfy the line above.
    expect(bundle.text).not.toContain('The live delegation counts could not be read');
    expect(bundle.text).not.toContain('DO NOT SPAWN');
  });

  it('WIRING: the rendered counts are the live ones, not a constant or an empty read', async () => {
    const counts = await readDelegationCounts({ workspaceId: WORKSPACE, sourceTimeoutMs: 30_000 });
    const bundle = await buildPlanContextBundle(SUBJECT_SLUG, {
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      delegationTimeoutMs: BUNDLE_READ_BUDGET_MS,
    });
    expect(bundle).not.toBeNull();
    if (!bundle || counts.plansAwaitingAcceptance.status !== 'known') return;

    // The block claims to render a read taken in this same pass. The provider
    // stamp is the cheapest thing that cannot survive a baked-in constant: a
    // literal block carries no `observedAt` from a read that just happened.
    expect(bundle.text).toContain(counts.schemaVersion);
    expect(bundle.text).toContain('DELEGATION POSTURE — live at launch, not a prompt constant');

    // And the seeded populations reach the rendered lines. A wrong-workspace
    // resolution returns zeros here while every other assertion still passes.
    expect(bundle.text).toMatch(/plans awaiting acceptance\s*:\s*1/);
    expect(bundle.text).toMatch(/actionable plans awaiting delegation\s*:\s*1/);
  });

  it('CONTROL: settling the acceptance — one variable — flips the same brief to a launch', async () => {
    // The ONLY change: the completion audit that made AWAITING_SLUG gradeable.
    // Both plans, the rubric, the workspace, the harness and the absence of any
    // presence row are untouched, so a difference in the directive cannot be
    // attributed to anything but the acceptance count.
    await db.adminSql`
      DELETE FROM harness_shared.plan_audits
       WHERE workspace_id = ${WORKSPACE} AND plan_slug = ${AWAITING_SLUG}`;

    const counts = await readDelegationCounts({ workspaceId: WORKSPACE, sourceTimeoutMs: 30_000 });
    expect(counts.plansAwaitingAcceptance.status).toBe('known');
    if (counts.plansAwaitingAcceptance.status !== 'known') return;
    expect(counts.plansAwaitingAcceptance.value.count, 'acceptance is now settled').toBe(0);

    const bundle = await buildPlanContextBundle(SUBJECT_SLUG, {
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      delegationTimeoutMs: BUNDLE_READ_BUDGET_MS,
    });
    expect(bundle).not.toBeNull();
    if (!bundle) return;

    // The launch directive IS emitted here — which is what proves the previous
    // test's `not.toContain` matched a real, reachable string rather than one
    // the renderer never produces.
    expect(bundle.text).toContain(LAUNCH_DIRECTIVE);
    expect(bundle.text).not.toContain(ACCEPTANCE_DIRECTIVE);
  });

  it('IDLE: with acceptance settled AND nothing actionable, the brief reports idle and launches nothing', async () => {
    // R-6's bar promises THREE states — acceptance-first, delegation-second,
    // idle-third — and the cases above only reach the first two. Without this one
    // the third is asserted by the bar and evidenced by nothing.
    //
    // This runs after CONTROL, which already removed the completion audit, so the
    // acceptance count is an established 0 and the ONE further change is the
    // subject plan's only item: `todo` → `done` drops it out of
    // `plansAwaitingDelegation` while leaving the plan resolvable, so the brief
    // still builds for the same subject. Delegation is the single variable
    // separating this state from CONTROL's launch.
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET items = ${db.adminSql.json([{ id: 'P-001', status: 'done', text: 'seeded actionable item' }])}
       WHERE workspace_id = ${WORKSPACE} AND plan_slug = ${SUBJECT_SLUG}`;

    const counts = await readDelegationCounts({ workspaceId: WORKSPACE, sourceTimeoutMs: 30_000 });
    // Same instrument guard as every other case: an unknown count renders DO NOT
    // SPAWN, which would satisfy "does not launch" while measuring nothing.
    expect(counts.degradedSources).toEqual([]);
    expect(counts.plansAwaitingAcceptance.status).toBe('known');
    expect(counts.plansAwaitingDelegation.status).toBe('known');
    if (
      counts.plansAwaitingAcceptance.status !== 'known' ||
      counts.plansAwaitingDelegation.status !== 'known'
    ) {
      return;
    }
    expect(counts.plansAwaitingAcceptance.value.count, 'acceptance stays settled').toBe(0);
    expect(counts.plansAwaitingDelegation.value.count, 'nothing is actionable any more').toBe(0);

    const bundle = await buildPlanContextBundle(SUBJECT_SLUG, {
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      delegationTimeoutMs: BUNDLE_READ_BUDGET_MS,
    });
    expect(bundle).not.toBeNull();
    if (!bundle) return;

    expect(bundle.text).toContain(IDLE_DIRECTIVE);
    // The other two states are absent, and absent because THIS state was chosen —
    // not because the read degraded into the measurement-failure directive.
    expect(bundle.text).not.toContain(LAUNCH_DIRECTIVE);
    expect(bundle.text).not.toContain(ACCEPTANCE_DIRECTIVE);
    expect(bundle.text).not.toContain('DO NOT SPAWN');
    expect(bundle.text).not.toContain('The live delegation counts could not be read');
  });
});
