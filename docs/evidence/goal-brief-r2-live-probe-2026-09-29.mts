// Operational probe for plan goal-brief-to-claimed-plan-work-2026-09-23, clause AUTO-BAR-R-2-P-003 @rev4 (READ-ONLY).
// Run from the papercusp repo root:
//   npx tsx docs/evidence/goal-brief-r2-live-probe-2026-09-29.mts > docs/evidence/goal-brief-r2-live-probe-2026-09-29.json
//   R2_COUNTEREXAMPLE=scope-mismatch npx tsx <this file> > <this file stem>.counterexample.json   (must exit 1)
// Emits one operational-test-evidence JSON document on stdout; exit 0 iff every assertion passed.
//
// Clause (rev 4): a currently eligible plan must reach an independently led plan fleet, positive plan/plan_item
// filter, valid delegated lease and actual member claim within two completed eligible decision opportunities after
// actionable delivery, or expose a current typed blocker. FALSIFIED by leader-only or launch-only evidence treated as
// pickup, scope/lease mismatch, duplicate execution owner, or two eligible opportunities with neither claim nor repair.
//
// Subject: the six P-007 GOAL lineages (same set as the R-7 probe), re-measured from the live ledger:
//   Arm A plan papercusp-db-backup-invalid-db-2026-09-27: goals 9368ec, 406e99, 8016e1
//   Arm B plan duplicate-screening-keys-on-authored-prose-and-its-normalize-2026-09-05: goals 956e4d, a88411, 81a93e
// Pickup evidence is ONLY a work-item claim (work_items.worked_by_history) by a joined, non-leader, non-holder fleet
// member. Fleet creation, leader join/lead events and claim-spec writes are recorded as observations, never as pickup.
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
const COUNTEREXAMPLE = process.env.R2_COUNTEREXAMPLE ?? null;
if (COUNTEREXAMPLE !== null && COUNTEREXAMPLE !== 'scope-mismatch') {
  throw new Error(`unknown R2_COUNTEREXAMPLE=${COUNTEREXAMPLE}; the only counterexample is scope-mismatch`);
}
const PLAN_A = 'papercusp-db-backup-invalid-db-2026-09-27';
const PLAN_B = 'duplicate-screening-keys-on-authored-prose-and-its-normalize-2026-09-05';
const LINEAGES: Array<{ goal: string; plan: string }> = [
  { goal: 'restore-reliable-hourly-papercusp-postgres-backu-9368ec', plan: PLAN_A },
  { goal: 'finish-restoring-reliable-hourly-papercusp-postg-406e99', plan: PLAN_A },
  { goal: 'ship-plan-papercusp-db-backup-invalid-db-2026-09-8016e1', plan: PLAN_A },
  { goal: 'stop-work-item-duplicate-screening-from-admittin-956e4d', plan: PLAN_B },
  { goal: 'finish-shipping-the-duplicate-screening-fix-adop-a88411', plan: PLAN_B },
  { goal: 'ship-adopted-plan-duplicate-screening-keys-on-au-81a93e', plan: PLAN_B },
];
const OPPORTUNITY_LIMIT = 2;
const goalIds = LINEAGES.map((l) => l.goal);

const goals = rows(`SELECT id, created_at, metadata->>'agentOwnerId' AS holder, metadata->>'drainFleet' AS fleet
  FROM harness_shared.goals WHERE workspace_id = ${lit(WS)} AND id IN (${inList(goalIds)})`);
const goalRow = (id: string) => goals.find((g) => g.id === id);
const fleetSlugs = goals.map((g) => g.fleet).filter(Boolean) as string[];
const holders = goals.map((g) => g.holder).filter(Boolean) as string[];

const fleets = rows(`SELECT fleet_slug, leader_owner_id, fleet_type, to_timestamp(created_at / 1000.0) AS created_at
  FROM harness_shared.agent_fleets WHERE workspace_id = ${lit(WS)} AND fleet_slug IN (${inList(fleetSlugs)})`);
const membership = rows(`SELECT owner_id, fleet_slug, fleet_role, event, at FROM harness_shared.fleet_membership_events
  WHERE workspace_id = ${lit(WS)} AND fleet_slug IN (${inList(fleetSlugs)}) ORDER BY at`);
const specCurrent = rows(`SELECT bee_id, revision, updated_at, spec->'view'->'filter' AS filter FROM harness_shared.cup_claim_specs
  WHERE workspace_id = ${lit(WS)} AND bee_id IN (${inList(fleetSlugs.map((f) => `fleet:${f}`))})`);
const specHistory = rows(`SELECT bee_id, revision, superseded_at, spec->'view'->'filter' AS filter
  FROM harness_shared.cup_claim_spec_revisions
  WHERE workspace_id = ${lit(WS)} AND bee_id IN (${inList(fleetSlugs.map((f) => `fleet:${f}`))}) ORDER BY revision`);
const couplings = rows(`SELECT agent_a, agent_b, state, reason, created_at, updated_at, expires_at FROM harness_shared.agent_couplings
  WHERE workspace_id = ${lit(WS)} AND (agent_a IN (${inList(holders)}) OR agent_b IN (${inList(holders)}))`);
const items = rows(`SELECT feature_id, goal_id, source_plan_slug, source_plan_item_ids, status,
    to_timestamp(created_ts / 1000.0) AS created_at, first_claimed_at, worked_by_history
  FROM harness_shared.work_items WHERE workspace_id = ${lit(WS)} AND harness_slug = 'papercusp'
    AND goal_id IN (${inList(goalIds)}) AND lane IS DISTINCT FROM 'observation'`);
// Every work item of either plan, whatever goal it carries: a plan item that was open during a goal's life but never
// stamped to that goal is eligible plan work that did not reach the goal's lane (a scope gap, not "no work").
const planWork = rows(`SELECT feature_id, goal_id, source_plan_slug, status, to_timestamp(created_ts / 1000.0) AS created_at,
    CASE WHEN closed_ts IS NULL THEN NULL ELSE to_timestamp(closed_ts / 1000.0) END AS closed_at
  FROM harness_shared.work_items WHERE workspace_id = ${lit(WS)} AND harness_slug = 'papercusp'
    AND source_plan_slug IN (${inList([PLAN_A, PLAN_B])}) AND lane IS DISTINCT FROM 'observation'`);
// session_turns rows carry workspace_id 'default' and owner = the full su-id, so they are selected by owner only.
const turns = rows(`SELECT owner, speaker, turn_origin, ts FROM harness_shared.session_turns
  WHERE owner IN (${inList(holders)}) ORDER BY ts`);
residualUnknowns.push("session_turns rows are stored under workspace_id 'default', so holder turns are selected by owner su-id alone "
  + "(a workspace_id='papercusp-workspace' predicate returns zero rows for every owner, including a positive control).");

const ms = (t: unknown) => (typeof t === 'number' ? t : Date.parse(String(t)));
const fleetFor = (i: number): string | null => {
  const idx = COUNTEREXAMPLE === 'scope-mismatch' ? (i + 1) % LINEAGES.length : i;
  return goalRow(LINEAGES[idx].goal)?.fleet ?? null;
};
const leaderOf = (fleet: string) => fleets.find((f) => f.fleet_slug === fleet)?.leader_owner_id
  ?? membership.find((e) => e.fleet_slug === fleet && e.event === 'lead')?.owner_id ?? null;
/** Replays join/lead/leave events: was `owner` a member of `fleet` at instant `at`? */
const memberAt = (owner: string, fleet: string, at: number): boolean => {
  let inside = false;
  for (const e of membership) {
    if (e.owner_id !== owner || e.fleet_slug !== fleet || ms(e.at) > at) continue;
    inside = e.event !== 'leave';
  }
  return inside;
};
/** The claim-spec filter in force at `at`: the lowest revision superseded after `at`, else the current row. */
const filterAt = (fleet: string, at: number): { revision: number | null; filter: any } => {
  const bee = `fleet:${fleet}`;
  const hist = specHistory.filter((r) => r.bee_id === bee && ms(r.superseded_at) > at);
  if (hist.length > 0) return { revision: hist[0].revision, filter: hist[0].filter };
  const cur = specCurrent.find((r) => r.bee_id === bee);
  return { revision: cur?.revision ?? null, filter: cur?.filter ?? null };
};
/** Positive scope: a leaf naming the goal, the plan, or the claimed item id; `not` never counts. */
const namesScope = (f: any, goal: string, plan: string, itemId: string): boolean => {
  if (!f || typeof f !== 'object') return false;
  if (Array.isArray(f.any)) return f.any.some((x: any) => namesScope(x, goal, plan, itemId));
  if (Array.isArray(f.all)) return f.all.some((x: any) => namesScope(x, goal, plan, itemId)) && !f.all.some((x: any) => x?.not);
  if (f.not) return false;
  if (f.op === '=' && f.field === 'goal') return f.value === goal;
  if (f.op === '=' && f.field === 'plan') return f.value === plan;
  if (f.op === 'in' && f.field === 'id') return Array.isArray(f.value) && f.value.includes(itemId);
  return false;
};
const leaseAt = (holder: string, leader: string, at: number) => couplings.find((c) =>
  ((c.agent_a === holder && c.agent_b === leader) || (c.agent_a === leader && c.agent_b === holder))
  && c.state === 'coupled' && ms(c.created_at) <= at && (c.expires_at === null || ms(c.expires_at) > at)) ?? null;
/** Upper bound on completed holder decision opportunities in (from, to]: user-turn starts in the window, plus one
 *  for a turn already running at `from`. Self-compaction starts are counted too, so the bound is conservative. */
const opportunities = (holder: string, from: number, to: number) => {
  const own = turns.filter((t) => t.owner === holder);
  const starts = own.filter((t) => t.speaker === 'user' && ms(t.ts) > from && ms(t.ts) <= to);
  const firstStart = starts.length ? ms(starts[0].ts) : to;
  const running = own.some((t) => t.speaker === 'assistant' && ms(t.ts) > from && ms(t.ts) < firstStart);
  return { upperBound: starts.length + (running ? 1 : 0), starts: starts.map((t) => `${t.turn_origin ?? 'null'}@${t.ts}`), running };
};

type Verdict = 'pass' | 'unknown-opportunities' | 'no-goal-stamped-plan-work' | 'unclaimed' | 'leader-only'
  | 'non-fleet-claim' | 'dependent-leader' | 'lease-gap' | 'scope-gap' | 'duplicate-owner';
const lineageResults = LINEAGES.map((l, i) => {
  const g = goalRow(l.goal);
  const fleet = fleetFor(i);
  const holder: string | null = g?.holder ?? null;
  const leader = fleet ? leaderOf(fleet) : null;
  const planItems = items.filter((w) => w.goal_id === l.goal && w.source_plan_slug === l.plan);
  const claims = planItems.flatMap((w) => (Array.isArray(w.worked_by_history) ? w.worked_by_history : [])
    .slice(0, 1).map((h: any) => ({ item: w, owner: String(h.owner), at: ms(h.at) })))
    .sort((a, b) => a.at - b.at);
  const base = { goal: l.goal, plan: l.plan, holder, fleet, leader, fleetType: fleets.find((f) => f.fleet_slug === fleet)?.fleet_type ?? null,
    goalStampedPlanItems: planItems.map((w) => `${w.feature_id}:${w.status}`) };
  if (!g || !fleet || !holder) return { ...base, verdict: 'scope-gap' as Verdict, detail: 'goal row, holder or drain fleet missing' };
  if (planItems.length === 0) {
    const born = ms(g.created_at);
    const openElsewhere = planWork.filter((w) => w.source_plan_slug === l.plan && w.goal_id !== l.goal
      && ms(w.created_at) <= born && (w.closed_at === null || ms(w.closed_at) > born));
    return openElsewhere.length > 0
      ? { ...base, verdict: 'scope-gap' as Verdict, detail: `plan items open at goal start but stamped elsewhere: ${openElsewhere.map((w) => `${w.feature_id}->${w.goal_id ?? 'no-goal'}`).join(', ')}` }
      : { ...base, verdict: 'no-goal-stamped-plan-work' as Verdict, detail: `no work item carries this goal and plan, and none of the plan's ${planWork.filter((w) => w.source_plan_slug === l.plan).length} items was open at goal start` };
  }
  if (claims.length === 0) return { ...base, verdict: 'unclaimed' as Verdict, detail: 'goal-stamped plan work was never claimed' };
  const member = claims.find((c) => c.owner !== leader && c.owner !== holder && memberAt(c.owner, fleet, c.at));
  if (!member) {
    const first = claims[0];
    const v: Verdict = first.owner === leader ? 'leader-only' : 'non-fleet-claim';
    return { ...base, verdict: v, detail: `first claim ${first.item.feature_id} by ${first.owner} at ${new Date(first.at).toISOString()}` };
  }
  const actionableAt = Math.max(ms(g.created_at), ms(member.item.created_at));
  const scope = filterAt(fleet, member.at);
  const lease = leader ? leaseAt(holder, leader, member.at) : null;
  const owners = [...new Set((member.item.worked_by_history as any[]).map((h) => String(h.owner)))];
  const opp = opportunities(holder, actionableAt, member.at);
  const facts = {
    pickup: { kind: 'work-item-claim', item: member.item.feature_id, planItems: member.item.source_plan_item_ids,
      owner: member.owner, at: new Date(member.at).toISOString() },
    actionableAt: new Date(actionableAt).toISOString(),
    filterAtClaim: scope, lease: lease && { state: lease.state, createdAt: lease.created_at, expiresAt: lease.expires_at },
    itemOwners: owners, opportunities: opp,
  };
  let verdict: Verdict = 'pass';
  if (!leader || leader === holder) verdict = 'dependent-leader';
  else if (!lease) verdict = 'lease-gap';
  else if (!namesScope(scope.filter, l.goal, l.plan, member.item.feature_id)) verdict = 'scope-gap';
  else if (owners.includes(holder) || owners.length > 1) verdict = 'duplicate-owner';
  else if (opp.upperBound > OPPORTUNITY_LIMIT) verdict = 'unknown-opportunities';
  return { ...base, verdict, ...facts };
});
observations.lineages = lineageResults;
observations.launchEvents = membership.map((e) => `${e.fleet_slug.slice(-6)} ${e.owner_id.slice(0, 11)} ${e.fleet_role}/${e.event} ${e.at}`);

const passes = lineageResults.filter((r) => r.verdict === 'pass');
assert('r2-clean-lineage-exists', passes.length > 0,
  `${passes.length}/${lineageResults.length} lineages show independent leader + valid coupling lease + positive filter at claim time `
  + `+ sole non-leader member claim within ${OPPORTUNITY_LIMIT} holder opportunities: ${passes.map((r) => r.goal.slice(-6)).join(', ') || 'none'}`);
const pickups = lineageResults.filter((r: any) => r.pickup);
assert('r2-pickup-is-member-claim', pickups.every((r: any) => r.pickup.kind === 'work-item-claim'
    && r.pickup.owner !== r.leader && r.pickup.owner !== r.holder),
  `${pickups.length} counted pickup(s), each a work-item claim by a joined member that is neither the fleet leader nor the goal holder; `
  + `${membership.length} fleet launch/lead events recorded as observations only`);
const misses = lineageResults.filter((r) => ['unclaimed', 'leader-only', 'non-fleet-claim', 'scope-gap'].includes(r.verdict));
assert('r2-no-unexplained-miss', misses.length === 0,
  misses.length === 0 ? 'every lineage with eligible plan work has an in-scope member claim; the rest had no plan item open at goal start'
    : `lineages with eligible plan work but no in-scope member pickup: ${misses.map((r) => `${r.goal.slice(-6)}=${r.verdict}`).join(', ')}`);
const dup = lineageResults.filter((r) => r.verdict === 'duplicate-owner');
assert('r2-no-duplicate-owner', dup.length === 0,
  dup.length === 0 ? 'no picked-up plan item was also worked by the holder or a second owner'
    : `duplicate execution owners: ${dup.map((r) => r.goal.slice(-6)).join(', ')}`);
for (const r of lineageResults) {
  if (!['pass', 'no-goal-stamped-plan-work'].includes(r.verdict)) residualUnknowns.push(`${r.goal}: ${r.verdict}${'detail' in r ? ` (${(r as any).detail})` : ''}`);
}
residualUnknowns.push('Fleet filters are the D-005 positive `=` leaf on goal (plan items reach the lane through the goal_id stamp); '
  + 'a lineage passes the positive-filter check only when the leaf in force at claim time names this goal, this plan, or the claimed item id.');
residualUnknowns.push('Plan eligibility is measured over the plan\'s WORK ITEMS (source_plan_slug); plan-level steps that are not '
  + 'claimable work items (ship, grading) are not decision opportunities for a fleet and are not counted.');
residualUnknowns.push('agent_couplings stores the CURRENT edge state only; a lease is treated as valid at claim time when the edge is '
  + 'coupled now, was created before the claim and has no earlier expiry. Historical suspension of the edge is not visible.');

const subs = assertions.filter((a) => a.id.startsWith('r2-'));
assert('auto-bar-r-2-p-003', subs.every((a) => a.passed),
  `${subs.filter((a) => a.passed).length}/${subs.length} R-2 sub-assertions passed over ${lineageResults.length} P-007 lineages `
  + `(${lineageResults.map((r) => `${r.goal.slice(-6)}=${r.verdict}`).join(', ')}); ${residualUnknowns.length} residual unknown(s) disclosed`);

const passed = assertions.filter((a) => a.passed).length;
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  kind: 'operational-test-evidence',
  name: COUNTEREXAMPLE ? 'goal-brief R-2 live pickup probe — counterexample scope-mismatch' : 'goal-brief R-2 live pickup probe',
  framework: 'shell',
  command: [...(COUNTEREXAMPLE ? ['env', `R2_COUNTEREXAMPLE=${COUNTEREXAMPLE}`] : []),
    'npx', 'tsx', 'docs/evidence/goal-brief-r2-live-probe-2026-09-29.mts'],
  ...(COUNTEREXAMPLE
    ? {
        mode: 'counterexample',
        counterexample: {
          id: COUNTEREXAMPLE,
          targets: 'auto-bar-r-2-p-003',
          fault: 'each lineage is judged against the NEXT lineage\'s drain fleet (roster, leader, lease pair, claim filter) — a scope/lease mismatch',
          expected: 'r2-clean-lineage-exists=false, auto-bar-r-2-p-003=false, exitCode 1 (caught)',
        },
      }
    : {}),
  exitCode: passed === assertions.length ? 0 : 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  summary: `${passed}/${assertions.length} live assertions passed for plan goal-brief-to-claimed-plan-work-2026-09-23 clause AUTO-BAR-R-2-P-003.`,
  assertions,
  plan: 'goal-brief-to-claimed-plan-work-2026-09-23',
  residualUnknowns,
  observations,
}, null, 2)}\n`);
process.exitCode = passed === assertions.length ? 0 : 1;
