// Behavioral probe for plan goal-brief-to-claimed-plan-work-2026-09-23, clauses AUTO-BAR-R-4-P-005 and
// AUTO-BAR-R-4-P-007 (spec revision 4), per that plan's D-019 (READ-ONLY).
//
// Run from the papercusp repo root:
//   npx tsx docs/evidence/goal-brief-r4-behavioral-probe-2026-09-29.mts > <stem>.json
//   R4_GOALS=<goal-id>,<goal-id>,... npx tsx <this file>          # any goal lineage (default: the P-007 trials)
//   R4_COUNTEREXAMPLE=duplicate-launch-in-refusal-window npx tsx <this file> > <stem>.counterexample.json
// Emits one operational-test-evidence JSON document on stdout; exit 0 iff every assertion PASSED.
//
// Oracle: the clause's own pre-registered conditions (behavior + falsifier text at rev 4), checked against
// ledger rows. No value is computed by the code under test; every read is a SELECT over the ledger:
//   harness_shared.goals, fleet_membership_events, tool_invocations, agent_activity.
// Opportunity rule (D-019 point 3): each sub-assertion reports status 'pass' | 'fail' | 'unknown'. A part with
// no real opportunity in the traces is 'unknown', never a pass, and makes the clause verdict fail (exit 1).
//
// Sub-assertions (the R-4 behavior, split as its falsifier is):
//   r4-no-progress-age      no-progress age is derived from canonical effects, not heartbeats/reads/launches.
//                           Opportunity: a goal-placement turn-end row carrying applicable demand AND an age.
//   r4-no-duplicate-launch  a blocked window (authoritative budget refusal = goal auto-kill) triggers no launch.
//                           Opportunity: a killed goal whose holder kept acting after the kill.
//   r4-first-refusal        the holder's first refusal is diagnosed (changed args, or a substantive intervening
//                           call) before any retry — never a blind identical retry.
//                           Opportunity: a holder whose first refused call was later retried.
//   r4-alternate-lane       on refusal, choose another feasible independent lane when permitted.
//                           Opportunity: a refused claim while another claimable lane was on offer.
//   r4-bounded-repair       a repair that makes no progress (same call refused >= 3 times) ends in
//                           stop/reassign/escalate through existing authority.
//                           Opportunity: a (tool,args) refused >= 3 times by a holder.
//
// Counterexample (mutation control, R-4-P-007 is mutation_required): duplicate-launch-in-refusal-window
// re-times each killed goal's first real drain-fleet join to 1s after its kill — exactly the defect R-4 rules
// out (blocked work triggering a launch). A sound instrument must report r4-no-duplicate-launch=fail.
// Counterexample heartbeat-reset-age re-anchors the newest aged turn-end row at its holder's latest
// heartbeat/read/launch call before it (age reset by a non-effect). A sound instrument must report
// r4-no-progress-age=fail.
// Only that one input changes; every read and every other sub-assertion is the same code.
import { execFileSync } from 'node:child_process';

const startedAt = new Date().toISOString();
type Status = 'pass' | 'fail' | 'unknown';
const assertions: Array<{ id: string; status: Status; passed: boolean; opportunities: number; evidence: string }> = [];
const observations: Record<string, unknown> = {};
const residualUnknowns: string[] = [];
const assert = (id: string, status: Status, opportunities: number, evidence: string) => {
  assertions.push({ id, status, passed: status === 'pass', opportunities, evidence });
  if (status === 'unknown') residualUnknowns.push(`${id}: ${evidence}`);
};
type Row = Record<string, any>;
const rows = (sql: string): Row[] => {
  const out = execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-d', 'papercusp', '-At', '-c',
    `SELECT coalesce(json_agg(t), '[]'::json) FROM (${sql}) t`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.trim()) as Row[];
};
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const inList = (xs: readonly string[]) => xs.map(lit).join(',');
const ms = (t: string | null | undefined) => (t ? Date.parse(t) : NaN);

const WS = 'papercusp-workspace';
const P007_GOALS = [
  'restore-reliable-hourly-papercusp-postgres-backu-9368ec', 'finish-restoring-reliable-hourly-papercusp-postg-406e99',
  'ship-plan-papercusp-db-backup-invalid-db-2026-09-8016e1', 'stop-work-item-duplicate-screening-from-admittin-956e4d',
  'finish-shipping-the-duplicate-screening-fix-adop-a88411', 'ship-adopted-plan-duplicate-screening-keys-on-au-81a93e',
];
const GOAL_IDS = (process.env.R4_GOALS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const LINEAGE = GOAL_IDS.length > 0 ? GOAL_IDS : P007_GOALS;
const COUNTEREXAMPLE = process.env.R4_COUNTEREXAMPLE ?? null;
const COUNTEREXAMPLES = ['duplicate-launch-in-refusal-window', 'heartbeat-reset-age'];
if (COUNTEREXAMPLE !== null && !COUNTEREXAMPLES.includes(COUNTEREXAMPLE)) {
  throw new Error(`unknown R4_COUNTEREXAMPLE=${COUNTEREXAMPLE}; known: ${COUNTEREXAMPLES.join(', ')}`);
}
// Calls that are transport wrappers or self-telemetry, never a substantive step (heartbeats/reads that R-4 says
// must not count as progress are handled the same way: they do not count as a diagnosis either).
const NON_SUBSTANTIVE = new Set(['tools:invoke', 'activity:report', 'coord:glance']);
const LAUNCH_TOOLS = ['fleet:launch-on-plan', 'capability:launch-agent', 'coord:dispatch', 'coord:wake', 'fleet:join'];
const ESCALATION_TOOLS = ['coord:escalate', 'coord:ask-owner', 'work_items:release', 'work_items:set_blocker',
  'goals:update', 'loop:end', 'fleet:dissolve'];

// ── Shared reads ──
const goals = rows(`SELECT id, status, created_at, metadata->>'agentOwnerId' AS holder, metadata->>'drainFleet' AS fleet,
    metadata->'autoKilled'->>'at' AS killed_at, metadata->'autoKilled'->>'reason' AS kill_reason
  FROM harness_shared.goals WHERE workspace_id = ${lit(WS)} AND id IN (${inList(LINEAGE)}) ORDER BY created_at`);
const missing = LINEAGE.filter((g) => !goals.some((r) => r.id === g));
if (missing.length) residualUnknowns.push(`goals not found in ledger: ${missing.join(', ')}`);
// metadata.agentOwnerId names the holder that was launched; a carry-respawned or re-bound holder session keeps
// writing turn-end rows under its own owner id, scoped to the goal, so those owners are holders too.
const turnEndOwners = rows(`SELECT DISTINCT owner_id AS owner FROM harness_shared.agent_activity
  WHERE workspace_id = ${lit(WS)} AND tool_use_id LIKE 'goal-placement-turn-end:%'
    AND detail->'goalPlacementTurnEnd'->>'goalId' IN (${inList(LINEAGE)})`).map((r) => r.owner as string);
const holders = [...new Set([...goals.map((g) => g.holder), ...turnEndOwners].filter(Boolean))] as string[];
const fleets = [...new Set(goals.map((g) => g.fleet).filter(Boolean))] as string[];
const membership = fleets.length === 0 ? [] : rows(`SELECT owner_id, fleet_slug, event, at FROM harness_shared.fleet_membership_events
  WHERE fleet_slug IN (${inList(fleets)}) ORDER BY at`);
const calls = holders.length === 0 ? [] : rows(`SELECT id, coord_owner_id AS owner, tool_name AS tool, status,
    coalesce(error_code, status) AS code, invoked_at AS at, md5(coalesce(args_json::text, '')) AS args
  FROM harness_shared.tool_invocations WHERE workspace_id = ${lit(WS)} AND coord_owner_id IN (${inList(holders)})
  ORDER BY invoked_at, id`);
const turnEnds = holders.length === 0 ? [] : rows(`SELECT owner_id AS owner, created_at AS at, detail->'goalPlacementTurnEnd' AS te
  FROM harness_shared.agent_activity WHERE workspace_id = ${lit(WS)} AND tool_use_id LIKE 'goal-placement-turn-end:%'
    AND owner_id IN (${inList(holders)}) ORDER BY created_at`);

observations.lineage = { goals: LINEAGE, parameterized: GOAL_IDS.length > 0, holders, fleets };
observations.goals = goals.map((g) => ({ id: g.id, status: g.status, holder: g.holder, fleet: g.fleet,
  killedAt: g.killed_at, killReason: g.kill_reason }));
observations.ledgerCounts = { holderCalls: calls.length, membershipEvents: membership.length, turnEnds: turnEnds.length };

// ── r4-no-progress-age ──
// Oracle, independent of the provider that computed the age: a row's anchor (noProgressSince) must be the offeredAt
// of a confirmed goalPlacementTurn receipt for the same owner+plan (the first completed eligible opportunity) or the
// progress cursor's verified lastEffect.at; age must equal observedAt - anchor; the anchor never moves backwards.
// An anchor sitting on a holder heartbeat/read/launch instant with neither canonical source is the R-4 defect.
{
  const teRows = turnEnds.flatMap((t) => ((t.te?.rows ?? []) as Row[]).map((r) => ({ owner: t.owner, at: t.at,
    observedAt: t.te?.observedAt as string, ...r })));
  const withDemand = teRows.filter((r) => Number(r.applicableDemand ?? 0) > 0 || r.planSlug);
  let withAge = withDemand.filter((r) => typeof r.noProgressAgeMs === 'number' && typeof r.noProgressSince === 'string');
  const receipts = holders.length === 0 ? [] : rows(`SELECT owner_id AS owner, detail->'goalPlacementTurn'->>'planRef' AS plan_ref,
      detail->'goalPlacementTurn'->>'offeredAt' AS offered_at, detail->'goalPlacementTurn'->>'completedAt' AS completed_at
    FROM harness_shared.agent_activity WHERE workspace_id = ${lit(WS)} AND detail ? 'goalPlacementTurn'
      AND owner_id IN (${inList(holders)})`);
  const cursors = holders.length === 0 ? [] : rows(`SELECT owner_id AS owner, committed FROM harness_shared.coord_read_cursors
    WHERE workspace_id = ${lit(WS)} AND surface LIKE 'goal-placement-progress-v1:%' AND committed IS NOT NULL
      AND owner_id IN (${inList(holders)})`);
  const effectAt = new Map<string, string>();
  for (const c of cursors) {
    try {
      const [, owner, , planRef] = JSON.parse(c.committed.scopeKey) as string[];
      if (c.committed.lastEffect?.at) effectAt.set(`${owner}|${planRef}`, c.committed.lastEffect.at);
    } catch { /* an unparsable scope key explains no anchor */ }
  }
  const noise = calls.filter((c) => NON_SUBSTANTIVE.has(c.tool) || LAUNCH_TOOLS.includes(c.tool));
  if (COUNTEREXAMPLE === 'heartbeat-reset-age' && withAge.length > 0) {
    const last = withAge[withAge.length - 1];
    const beat = noise.filter((c) => c.owner === last.owner && ms(c.at) <= ms(last.observedAt)).at(-1);
    if (beat) {
      const since = new Date(ms(beat.at)).toISOString();
      withAge = [...withAge.slice(0, -1), { ...last, noProgressSince: since, noProgressAgeMs: ms(last.observedAt) - ms(since), injected: true }];
    }
  }
  const judged = withAge.map((r) => {
    const anchor = ms(r.noProgressSince);
    const viaEffect = ms(effectAt.get(`${r.owner}|${r.planRef}`)) === anchor;
    const viaOpportunity = receipts.some((x) => x.owner === r.owner && x.plan_ref === r.planRef
      && ms(x.offered_at) === anchor && ms(x.completed_at) <= ms(r.observedAt));
    return { owner: r.owner, planRef: r.planRef, observedAt: r.observedAt, noProgressSince: r.noProgressSince,
      noProgressAgeMs: r.noProgressAgeMs, coherent: Math.abs(anchor + Number(r.noProgressAgeMs) - ms(r.observedAt)) <= 1,
      source: viaEffect ? 'effect' : viaOpportunity ? 'first-eligible-opportunity' : null,
      noiseAtAnchor: noise.some((c) => c.owner === r.owner && Math.abs(ms(c.at) - anchor) <= 1000),
      ...(r.injected ? { injected: true } : {}) };
  });
  const backwards = judged.filter((j, i) => judged.slice(0, i).some((p) => p.owner === j.owner && p.planRef === j.planRef
    && ms(p.observedAt) < ms(j.observedAt) && ms(p.noProgressSince) > ms(j.noProgressSince)));
  const incoherent = judged.filter((j) => !j.coherent);
  const noiseAnchored = judged.filter((j) => j.source === null && j.noiseAtAnchor);
  const unexplained = judged.filter((j) => j.source === null);
  observations.noProgressAge = { turnEndEvents: turnEnds.length, turnEndRows: teRows.length, rowsWithDemand: withDemand.length,
    rowsWithAge: withAge.length, confirmedReceipts: receipts.length, progressCursors: cursors.length,
    statuses: [...new Set(teRows.map((r) => r.status))], judged: judged.slice(-12) };
  const failed = incoherent.length + backwards.length + noiseAnchored.length > 0;
  assert('r4-no-progress-age', judged.length === 0 ? 'unknown' : failed ? 'fail' : unexplained.length === 0 ? 'pass' : 'unknown',
    judged.length, `${judged.length} aged row(s) of ${withDemand.length} with demand over ${turnEnds.length} turn-end(s); `
    + `anchors via effect ${judged.filter((j) => j.source === 'effect').length}, via first eligible opportunity `
    + `${judged.filter((j) => j.source === 'first-eligible-opportunity').length}, unexplained ${unexplained.length} `
    + `(on a heartbeat/read/launch instant: ${noiseAnchored.length}); incoherent age ${incoherent.length}; anchor moved `
    + `backwards ${backwards.length}. A missing age stays unknown, never a zero-age success.`);
}

// ── r4-no-duplicate-launch ──
{
  const windows = goals.filter((g) => g.killed_at).map((g) => {
    const after = calls.filter((c) => c.owner === g.holder && ms(c.at) > ms(g.killed_at));
    let joins = membership.filter((e) => e.fleet_slug === g.fleet && e.event === 'join');
    if (COUNTEREXAMPLE === 'duplicate-launch-in-refusal-window' && joins.length > 0) {
      joins = [{ ...joins[0], at: new Date(ms(g.killed_at) + 1000).toISOString(), injected: true }, ...joins.slice(1)];
    }
    const launchesInWindow = joins.filter((e) => ms(e.at) > ms(g.killed_at)).length
      + after.filter((c) => LAUNCH_TOOLS.includes(c.tool) && c.status === 'ok').length;
    return { goal: g.id, holder: g.holder, fleet: g.fleet, killedAt: g.killed_at, reason: g.kill_reason,
      holderCallsAfterKill: after.length, launchesInWindow, opportunity: after.length > 0 };
  });
  const opp = windows.filter((w) => w.opportunity);
  const dupes = opp.filter((w) => w.launchesInWindow > 0);
  observations.refusalWindows = windows;
  assert('r4-no-duplicate-launch', opp.length === 0 ? 'unknown' : dupes.length === 0 ? 'pass' : 'fail', opp.length,
    `${windows.length} authoritative budget-refusal window(s) (goal auto-kill); ${opp.length} with the holder still acting `
    + `after the kill (${opp.map((w) => `${w.goal.slice(-6)}:${w.holderCallsAfterKill} calls`).join(', ')}); launches inside `
    + `those windows: ${opp.map((w) => `${w.goal.slice(-6)}=${w.launchesInWindow}`).join(', ') || 'n/a'}`);
}

// ── r4-first-refusal ──
{
  const substantive = calls.filter((c) => !NON_SUBSTANTIVE.has(c.tool));
  const perHolder = holders.map((h) => {
    const mine = substantive.filter((c) => c.owner === h);
    const first = mine.find((c) => c.status !== 'ok');
    if (!first) return { holder: h, firstRefusal: null, retried: false, diagnosed: null };
    const retry = mine.find((c) => ms(c.at) > ms(first.at) && c.tool === first.tool);
    if (!retry) return { holder: h, firstRefusal: { tool: first.tool, code: first.code, at: first.at }, retried: false, diagnosed: null };
    const intervening = mine.filter((c) => ms(c.at) > ms(first.at) && ms(c.at) < ms(retry.at) && c.tool !== first.tool);
    const diagnosed = retry.args !== first.args || intervening.length > 0;
    return { holder: h, firstRefusal: { tool: first.tool, code: first.code, at: first.at }, retried: true,
      retry: { sameArgs: retry.args === first.args, status: retry.status, at: retry.at },
      intervening: intervening.map((c) => c.tool), diagnosed };
  });
  const opp = perHolder.filter((p) => p.retried);
  const blind = opp.filter((p) => !p.diagnosed);
  observations.firstRefusals = perHolder;
  assert('r4-first-refusal', opp.length === 0 ? 'unknown' : blind.length === 0 ? 'pass' : 'fail', opp.length,
    `${perHolder.filter((p) => p.firstRefusal).length}/${holders.length} holder(s) had a refused call; ${opp.length} retried `
    + `the refused tool; blind identical retries with no intervening step: ${blind.length}`);
}

// ── r4-alternate-lane ──
{
  const CLAIM_TOOLS = ['work_items:claim', 'work_items:claim_next', 'scheduler:get_next', 'plan_items:claim'];
  const refusedClaims = calls.filter((c) => CLAIM_TOOLS.includes(c.tool) && c.status !== 'ok');
  observations.alternateLane = { refusedHolderClaims: refusedClaims.length };
  assert('r4-alternate-lane', 'unknown', 0, `${refusedClaims.length} refused claim(s) by the holders; the ledger records no `
    + `offered-alternative-lane set at refusal time, so "another feasible independent lane was available" is unmeasured`);
}

// ── r4-bounded-repair ──
{
  const groups = new Map<string, Row[]>();
  for (const c of calls) {
    if (c.status === 'ok' || NON_SUBSTANTIVE.has(c.tool)) continue;
    const k = `${c.owner}|${c.tool}|${c.args}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const loops = [...groups.values()].filter((g) => g.length >= 3).map((g) => {
    const third = g[2];
    const esc = calls.find((c) => c.owner === third.owner && ms(c.at) > ms(third.at) && ESCALATION_TOOLS.includes(c.tool) && c.status === 'ok');
    return { owner: third.owner, tool: third.tool, refusals: g.length, escalatedVia: esc?.tool ?? null };
  });
  const maxRepeat = Math.max(0, ...[...groups.values()].map((g) => g.length));
  observations.repairLoops = { loops, maxIdenticalRefusals: maxRepeat,
    escalations: calls.filter((c) => ['coord:escalate', 'coord:ask-owner'].includes(c.tool) && c.status === 'ok')
      .map((c) => ({ owner: c.owner, tool: c.tool, at: c.at })) };
  assert('r4-bounded-repair', loops.length === 0 ? 'unknown' : loops.every((l) => l.escalatedVia) ? 'pass' : 'fail', loops.length,
    `no-progress repair loops (same call refused >= 3 times): ${loops.length}; max identical refusals by any holder: ${maxRepeat}`);
}

const subs = assertions.filter((a) => a.id.startsWith('r4-'));
const verdict: Status = subs.some((a) => a.status === 'fail') ? 'fail' : subs.every((a) => a.status === 'pass') ? 'pass' : 'unknown';
assert('auto-bar-r-4', verdict, subs.reduce((n, a) => n + a.opportunities, 0),
  `${subs.filter((a) => a.status === 'pass').length} pass / ${subs.filter((a) => a.status === 'fail').length} fail / `
  + `${subs.filter((a) => a.status === 'unknown').length} unknown over ${subs.length} R-4 sub-assertions `
  + `(${subs.map((a) => `${a.id}=${a.status}`).join(', ')})`);
{ // the roll-up restates its sub-assertions' unknowns; keep only the per-part entries
  const i = residualUnknowns.findIndex((u) => u.startsWith('auto-bar-r-4:'));
  if (i >= 0) residualUnknowns.splice(i, 1);
}

const passed = assertions.filter((a) => a.passed).length;
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  kind: 'operational-test-evidence',
  name: `goal-brief R-4 behavioral probe${COUNTEREXAMPLE ? ` — counterexample ${COUNTEREXAMPLE}` : ''}`,
  framework: 'shell',
  command: [...(COUNTEREXAMPLE ? ['env', `R4_COUNTEREXAMPLE=${COUNTEREXAMPLE}`] : []),
    ...(GOAL_IDS.length ? ['env', `R4_GOALS=${GOAL_IDS.join(',')}`] : []),
    'npx', 'tsx', 'docs/evidence/goal-brief-r4-behavioral-probe-2026-09-29.mts'],
  ...(COUNTEREXAMPLE
    ? { mode: 'counterexample', counterexample: COUNTEREXAMPLE === 'heartbeat-reset-age'
      ? { id: COUNTEREXAMPLE, targets: 'r4-no-progress-age',
        fault: 'the newest aged turn-end row re-anchored at its holder\'s latest heartbeat/read/launch call',
        expected: 'r4-no-progress-age=fail (caught)' }
      : { id: COUNTEREXAMPLE, targets: 'r4-no-duplicate-launch',
        fault: 'each killed goal\'s first real drain-fleet join re-timed to 1s after its budget kill',
        expected: 'r4-no-duplicate-launch=fail (caught)' } }
    : {}),
  exitCode: passed === assertions.length ? 0 : 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  summary: `${passed}/${assertions.length} assertions passed for plan goal-brief-to-claimed-plan-work-2026-09-23 clauses `
    + `AUTO-BAR-R-4-P-005/AUTO-BAR-R-4-P-007 (verdict ${verdict}).`,
  plan: 'goal-brief-to-claimed-plan-work-2026-09-23',
  clauses: ['AUTO-BAR-R-4-P-005@4', 'AUTO-BAR-R-4-P-007@4'],
  assertions,
  residualUnknowns,
  observations,
}, null, 2)}\n`);
process.exitCode = passed === assertions.length ? 0 : 1;
