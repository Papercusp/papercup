// Operational probe for plan goal-brief-to-claimed-plan-work-2026-09-23, bar R-10
// (clauses AUTO-BAR-R-10-P-007 and AUTO-BAR-R-10-P-009, which carry the same bar text). READ-ONLY.
// Run from the papercusp repo root:
//   npx tsx docs/evidence/goal-brief-p007-trials-r10-feedback-probe-2026-09-29.mts \
//     > docs/evidence/goal-brief-p007-trials-r10-feedback-probe-2026-09-29.json
// Emits one operational-test-evidence JSON document on stdout; exit 0 iff every assertion passed.
//
// R-10 (rev 4): goal-local recurring problems and observed outcomes feed Blender's learning; Blender proposals
// are routed to the right goal holder; original proposal ids, plan refs, goal attribution and amendment/adoption
// history are preserved on the existing routed-idea/outcome surfaces; one accountable execution owner stays
// visible; feedback must not silently fork another plan.
// Falsifier: duplicate idea/plan, reassigned origin/goal, discarded revision history, feedback credited to the
// wrong holder, or terminal evidence not reaching the existing feedback surface.
//
// Subject: the two P-007 GOAL trials (same lineages as the R-7 probe,
// docs/evidence/goal-brief-p007-trials-operational-probe-2026-09-29.mts), re-measured from the live ledger.
// Each sub-assertion below maps to one falsifier phrase. The conditions were written from the clause text
// before the probe was first run; the oracle is the ledger, never a value computed by goal code.
// Known residue goes to `residualUnknowns`; it is never suppressed to make an assertion pass.
//
// Counterexample mode, the falsifiability control for "feedback credited to the wrong holder":
//   R10_COUNTEREXAMPLE=wrong-holder npx tsx <this file> > <this file stem>.counterexample.json
// swaps the EXPECTED lineage for Arm A's feedback to Arm B's goals. A sound instrument must then report
// r10-credited-to-correct-holder=false and exit 1. Every read and every other condition is the same code.
import { execFileSync } from 'node:child_process';

const startedAt = new Date().toISOString();
const assertions: Array<{ id: string; passed: boolean; evidence: string }> = [];
const observations: Record<string, unknown> = {};
const residualUnknowns: string[] = [];
const assert = (id: string, passed: boolean, evidence: string) => assertions.push({ id, passed, evidence });
type Row = Record<string, any>;
const rows = (sql: string): Row[] => {
  const out = execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-d', 'papercusp', '-At', '-c',
    `SELECT coalesce(json_agg(t), '[]'::json) FROM (${sql}) t`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.trim()) as Row[];
};
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const inList = (xs: readonly string[]) => xs.map(lit).join(',');

const WS = 'papercusp-workspace';
const COUNTEREXAMPLE = process.env.R10_COUNTEREXAMPLE ?? null;
if (COUNTEREXAMPLE !== null && COUNTEREXAMPLE !== 'wrong-holder') {
  throw new Error(`unknown R10_COUNTEREXAMPLE=${COUNTEREXAMPLE}; the only counterexample is wrong-holder`);
}
const ARMS = {
  A: {
    label: 'need discovery -> goal-local plan',
    goals: ['restore-reliable-hourly-papercusp-postgres-backu-9368ec', 'finish-restoring-reliable-hourly-papercusp-postg-406e99',
      'ship-plan-papercusp-db-backup-invalid-db-2026-09-8016e1'],
    plan: 'papercusp-db-backup-invalid-db-2026-09-27',
  },
  B: {
    label: 'adopt existing Blender plan without cloning',
    goals: ['stop-work-item-duplicate-screening-from-admittin-956e4d', 'finish-shipping-the-duplicate-screening-fix-adop-a88411',
      'ship-adopted-plan-duplicate-screening-keys-on-au-81a93e'],
    plan: 'duplicate-screening-keys-on-authored-prose-and-its-normalize-2026-09-05',
    blenderIdea: 'EI-22406075136912314',
  },
} as const;
const allGoals = [...ARMS.A.goals, ...ARMS.B.goals];
const bothPlans = [ARMS.A.plan, ARMS.B.plan];
/** The lineage Arm A's feedback is EXPECTED to be credited to. The counterexample points it at the wrong arm. */
const expectedArmALineage: readonly string[] = COUNTEREXAMPLE === 'wrong-holder' ? ARMS.B.goals : ARMS.A.goals;

// ── Shared reads ──
const goals = rows(`SELECT id, status, created_at, metadata->>'agentOwnerId' AS holder
  FROM harness_shared.goals WHERE workspace_id = ${lit(WS)} AND id IN (${inList(allGoals)})`);
const holders = goals.map((g) => g.holder).filter(Boolean) as string[];
const plans = rows(`SELECT plan_slug, status, goal_id, is_blender_origin, version
  FROM harness_shared.harness_plans WHERE workspace_id = ${lit(WS)} AND harness_slug = 'papercusp'
    AND plan_slug IN (${inList(bothPlans)})`);
const plan = (slug: string) => plans.find((p) => p.plan_slug === slug);
const plansByTrialGoals = rows(`SELECT plan_slug, goal_id FROM harness_shared.harness_plans
  WHERE workspace_id = ${lit(WS)} AND goal_id IN (${inList(allGoals)})`);
const ideas = rows(`SELECT idea_id, routed_ref, outcome, origin, created_by, rail, outcome_checked_at, routed_at
  FROM harness_shared.scout_routed_ideas WHERE workspace_id = ${lit(WS)}
    AND (routed_ref IN (${inList(bothPlans.map((p) => `plan:${p}`))}) OR idea_id = ${lit(ARMS.B.blenderIdea)}
         OR idea_id LIKE 'goal-plan:%')`);
const ideasFor = (slug: string) => ideas.filter((i) => i.routed_ref === `plan:${slug}`);
const revs = rows(`SELECT plan_slug, seq, author_id, created_at FROM harness_shared.plan_revisions
  WHERE workspace_id = ${lit(WS)} AND plan_slug IN (${inList(bothPlans)}) ORDER BY plan_slug, seq`);
const revsFor = (slug: string) => revs.filter((r) => r.plan_slug === slug);
const items = rows(`SELECT source_plan_slug AS plan, feature_id, status, terminal_owner FROM harness_shared.work_items
  WHERE workspace_id = ${lit(WS)} AND harness_slug = 'papercusp' AND lane IS DISTINCT FROM 'observation'
    AND source_plan_slug IN (${inList(bothPlans)})`);
/** The goal id a goal-plan feedback row is credited to: `goal-plan:<goalId>:<harness>/<plan>`. */
const creditedGoal = (ideaId: string): string | null => /^goal-plan:([^:]+):/.exec(ideaId)?.[1] ?? null;
observations.plans = plans;
observations.ideas = ideas.filter((i) => bothPlans.some((p) => i.routed_ref === `plan:${p}`) || i.idea_id === ARMS.B.blenderIdea);

// ── 1. "terminal evidence not reaching the existing feedback surface" ──
{
  const detail = (['A', 'B'] as const).map((arm) => {
    const slug = ARMS[arm].plan;
    const rowsForPlan = ideasFor(slug);
    const shipRev = revsFor(slug).at(-1);
    const row = rowsForPlan[0];
    const reachedAfterShip = !!row && !!shipRev && Number(row.outcome_checked_at) >= Number(shipRev.created_at);
    return { arm, plan: slug, planStatus: plan(slug)?.status, feedbackRows: rowsForPlan.length, outcome: row?.outcome,
      outcomeCheckedAt: row ? new Date(Number(row.outcome_checked_at)).toISOString() : null,
      lastRevisionAt: shipRev ? new Date(Number(shipRev.created_at)).toISOString() : null, reachedAfterShip };
  });
  observations.terminalFeedback = detail;
  assert('r10-terminal-evidence-reaches-feedback',
    detail.every((d) => d.planStatus === 'shipped' && d.feedbackRows === 1 && d.outcome === 'won'),
    detail.map((d) => `Arm ${d.arm}: plan ${d.planStatus}; ${d.feedbackRows} feedback row(s) on plan:${d.plan}, outcome=${d.outcome} `
      + `checked ${d.outcomeCheckedAt} (last plan revision ${d.lastRevisionAt}; after-ship=${d.reachedAfterShip})`).join('; '));
  for (const d of detail) if (!d.reachedAfterShip) residualUnknowns.push(
    `Arm ${d.arm}: the feedback outcome was last checked at ${d.outcomeCheckedAt}, not after the plan's last revision (${d.lastRevisionAt}); `
    + 'the won outcome is present, but its check time does not prove it was derived from the terminal revision.');
}

// ── 2. "duplicate idea/plan" and "must not silently fork another plan" ──
{
  const aOwned = plansByTrialGoals.filter((p) => (ARMS.A.goals as readonly string[]).includes(p.goal_id)).map((p) => p.plan_slug);
  const bOwned = plansByTrialGoals.filter((p) => (ARMS.B.goals as readonly string[]).includes(p.goal_id)).map((p) => p.plan_slug);
  const aGoalPlanRows = ideas.filter((i) => i.idea_id.startsWith('goal-plan:') && (ARMS.A.goals as readonly string[]).includes(creditedGoal(i.idea_id) ?? ''));
  const bGoalPlanRows = ideas.filter((i) => i.idea_id.startsWith('goal-plan:') && (ARMS.B.goals as readonly string[]).includes(creditedGoal(i.idea_id) ?? ''));
  const ok = aOwned.length === 1 && aOwned[0] === ARMS.A.plan && bOwned.every((s) => s === ARMS.B.plan)
    && ideasFor(ARMS.A.plan).length === 1 && ideasFor(ARMS.B.plan).length === 1
    && aGoalPlanRows.length === 1 && bGoalPlanRows.length === 0;
  observations.forkCheck = { aOwned, bOwned, aGoalPlanRows: aGoalPlanRows.map((i) => i.idea_id), bGoalPlanRows: bGoalPlanRows.map((i) => i.idea_id) };
  assert('r10-no-duplicate-idea-or-plan', ok,
    `Arm A lineage owns plans [${aOwned.join(', ')}] and ${aGoalPlanRows.length} goal-plan feedback row(s); `
    + `Arm B lineage owns plans [${bOwned.join(', ')}] (adopted, must be only the Blender plan) and ${bGoalPlanRows.length} goal-plan row(s) `
    + `(an adopted plan must not get a second, goal-minted idea); feedback rows per plan: A=${ideasFor(ARMS.A.plan).length}, B=${ideasFor(ARMS.B.plan).length}`);
}

// ── 3. "reassigned original origin/goal": the original Blender proposal keeps its id, origin and proposer ──
{
  const blender = ideas.find((i) => i.idea_id === ARMS.B.blenderIdea);
  const firstRev = revsFor(ARMS.B.plan)[0];
  const ok = !!blender && blender.routed_ref === `plan:${ARMS.B.plan}` && plan(ARMS.B.plan)?.is_blender_origin === true
    && !!firstRev && blender.created_by === firstRev.author_id && !holders.includes(blender.created_by)
    && Number(blender.routed_at) < Math.min(...goals.map((g) => Date.parse(g.created_at)));
  observations.blenderOrigin = { blender, firstRevisionAuthor: firstRev?.author_id, trialHolders: holders };
  assert('r10-original-proposal-preserved', ok,
    `Blender idea ${ARMS.B.blenderIdea} still routes to plan:${ARMS.B.plan} (is_blender_origin=${plan(ARMS.B.plan)?.is_blender_origin}), `
    + `origin=${blender?.origin}, created_by=${blender?.created_by}, which is the plan's seq-1 author (${firstRev?.author_id}) and no trial holder; `
    + `routed ${blender ? new Date(Number(blender.routed_at)).toISOString() : 'never'}, before every trial goal existed`);
}

// ── 4. "feedback credited to the wrong holder" (the counterexample target) ──
{
  const aRow = ideasFor(ARMS.A.plan).find((i) => i.idea_id.startsWith('goal-plan:'));
  const aCredit = aRow ? creditedGoal(aRow.idea_id) : null;
  const bGoal = plan(ARMS.B.plan)?.goal_id ?? null;
  const ok = !!aCredit && expectedArmALineage.includes(aCredit) && !!bGoal && (ARMS.B.goals as readonly string[]).includes(bGoal);
  observations.credit = { armAFeedbackRow: aRow?.idea_id, armACreditedGoal: aCredit, expectedArmALineage, armBPlanGoal: bGoal };
  assert('r10-credited-to-correct-holder', ok,
    `Arm A feedback ${aRow?.idea_id ?? '(none)'} credits goal ${aCredit}; expected one of [${expectedArmALineage.join(', ')}]. `
    + `Arm B plan is attributed to goal ${bGoal}; expected one of [${ARMS.B.goals.join(', ')}]`);
  if (bGoal && bGoal !== ARMS.B.goals[0]) residualUnknowns.push(
    `Arm B plan goal_id is ${bGoal}, a continuation goal in the right lineage, not the adopting goal ${ARMS.B.goals[0]} (first attribution wins at the first stamp; tracked as WI-10003900).`);
}

// ── 5. "discarded revision history", including the pre-adoption history of the adopted plan ──
{
  const detail = bothPlans.map((slug) => {
    const r = revsFor(slug);
    const seqs = r.map((x) => Number(x.seq));
    const contiguousFrom1 = seqs.length > 0 && seqs[0] === 1 && seqs.every((s, i) => s === i + 1);
    return { plan: slug, revisions: seqs.length, maxSeq: seqs.at(-1) ?? null, contiguousFrom1, version: Number(plan(slug)?.version) };
  });
  const firstTrialGoalAt = Math.min(...goals.map((g) => Date.parse(g.created_at)));
  const preAdoption = revsFor(ARMS.B.plan).filter((r) => Number(r.created_at) < firstTrialGoalAt).length;
  observations.revisionHistory = { detail, armBPreAdoptionRevisions: preAdoption };
  assert('r10-revision-history-preserved', detail.every((d) => d.contiguousFrom1) && preAdoption > 0,
    detail.map((d) => `${d.plan}: ${d.revisions} revision rows, seq 1..${d.maxSeq} contiguous=${d.contiguousFrom1} (plan version ${d.version})`).join('; ')
    + `; Arm B keeps ${preAdoption} revision(s) written before any trial goal existed (the Blender proposal's own history)`);
  for (const d of detail) if (d.version !== d.revisions) residualUnknowns.push(
    `${d.plan}: plan version ${d.version} but ${d.revisions} revision rows. The rows are contiguous from seq 1, so no row was deleted, but one version bump has no revision row and its content change (if any) is not in the history.`);
}

// ── 6. "one accountable execution owner remains visible" ──
{
  const detail = bothPlans.map((slug) => {
    const own = items.filter((i) => i.plan === slug);
    return { plan: slug, goal: plan(slug)?.goal_id ?? null, items: own.length,
      doneWithoutOwner: own.filter((i) => i.status === 'done' && !i.terminal_owner).map((i) => i.feature_id) };
  });
  observations.accountableOwner = detail;
  assert('r10-one-accountable-owner', detail.every((d) => !!d.goal && d.items > 0 && d.doneWithoutOwner.length === 0),
    detail.map((d) => `${d.plan}: owning goal ${d.goal}; ${d.items} plan work-items, ${d.doneWithoutOwner.length} done without a terminal owner`).join('; '));
}

const subs = assertions.filter((a) => a.id.startsWith('r10-'));
for (const specId of ['auto-bar-r-10-p-007', 'auto-bar-r-10-p-009']) {
  assert(specId, subs.every((a) => a.passed),
    `${subs.filter((a) => a.passed).length}/${subs.length} R-10 sub-assertions passed over both trial lineages `
    + `(${subs.map((a) => `${a.id}=${a.passed}`).join(', ')}); ${residualUnknowns.length} residual unknown(s) disclosed`);
}

const passed = assertions.filter((a) => a.passed).length;
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  kind: 'operational-test-evidence',
  name: COUNTEREXAMPLE
    ? 'goal-brief P-007 GOAL trials feedback probe (R-10), counterexample wrong-holder'
    : 'goal-brief P-007 GOAL trials feedback probe (R-10)',
  framework: 'shell',
  command: [...(COUNTEREXAMPLE ? ['env', `R10_COUNTEREXAMPLE=${COUNTEREXAMPLE}`] : []),
    'npx', 'tsx', 'docs/evidence/goal-brief-p007-trials-r10-feedback-probe-2026-09-29.mts'],
  ...(COUNTEREXAMPLE
    ? {
        mode: 'counterexample',
        counterexample: {
          id: COUNTEREXAMPLE,
          targets: 'auto-bar-r-10-p-007, auto-bar-r-10-p-009',
          fault: "Arm A's feedback is expected to be credited to Arm B's goal lineage (feedback credited to the wrong holder)",
          expected: 'r10-credited-to-correct-holder=false, auto-bar-r-10-p-007=false, auto-bar-r-10-p-009=false, exitCode 1 (caught)',
        },
      }
    : {}),
  exitCode: passed === assertions.length ? 0 : 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  summary: `${passed}/${assertions.length} live assertions passed for plan goal-brief-to-claimed-plan-work-2026-09-23 bar R-10.`,
  assertions,
  plan: 'goal-brief-to-claimed-plan-work-2026-09-23',
  residualUnknowns,
  observations,
}, null, 2)}\n`);
process.exitCode = passed === assertions.length ? 0 : 1;
