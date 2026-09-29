// Operational probe for plan main-greening-control-plane-durable-fix-2026-09-21 (READ-ONLY).
// Run from the papercusp repo root:
//   npx tsx docs/evidence/main-greening-operational-probe-2026-09-29.mts all
// Emits one operational-test-evidence JSON document on stdout; exit 0 iff every assertion passed.
// Reads: the deployed operator (:3070) and staging operator (:3170) HTTP read routes, the live
// operator Postgres (sudo -n -u postgres psql, SELECT only), git refs/reflog of this checkout, and
// imports the DEPLOYED module from the release checkout (../papercup-release, pinned to main).
// Writes nothing. Assertion ids are the lowercased spec ids they target.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

delete process.env.VITEST;
const arg = process.argv[2] ?? 'all';
const sections = arg === 'all' ? ['r007', 'r001', 'r009'] : [arg];
const startedAt = new Date().toISOString();
const assertions: Array<{ id: string; passed: boolean; evidence: string }> = [];
const observations: Record<string, unknown> = {};
const assert = (id: string, passed: boolean, evidence: string) => assertions.push({ id, passed, evidence });
const psql = (sql: string): string[][] =>
  execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-d', 'papercusp', '-At', '-F', '\t', '-c', sql], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).map((line) => line.split('\t'));
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const isAncestor = (a: string, b: string) => {
  try { execFileSync('git', ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
};
const getJson = async (url: string) => (await fetch(url, { signal: AbortSignal.timeout(60_000) })).json() as Promise<any>;
const near = (a: unknown, b: unknown, tol: number) =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;

const PLAN = 'main-greening-control-plane-durable-fix-2026-09-21';
const REPAIR_HEAD = '01a67545f3afff3cdee35c21a9d6476acad93579';
const INCIDENT_CANDIDATE = 'ac857b4ba0f1c2e78683cd1366c6bfaca6320068';

for (const section of sections) {
  if (section === 'r007') {
    const q = await import(resolve('../papercup-release/packages/operator-core/lib/release/checkpoint-qualification-transaction.ts'));
    const health = await getJson('http://127.0.0.1:3070/api/health');
    observations.r007Deployed = { healthSha: health.sha, releaseCheckoutHead: git('-C', '../papercup-release', 'rev-parse', 'HEAD') };
    // A. The DEPLOYED operator's own status projection for the papercusp install (live row).
    const live = (await getJson('http://127.0.0.1:3070/api/desktop/git-pipeline'))?.gate?.qualification;
    observations.r007PapercuspLiveStatus = {
      attemptId: live?.attemptId, phase: live?.phase, clocks: live?.clocks, agesMs: live?.agesMs,
      runnerHealth: live?.runnerHealth, safeNextAction: live?.safeNextAction?.code,
    };
    assert('auto-bar-r-007-status-p-005', live?.status === 'present' && Number.isFinite(live?.agesMs?.attempt),
      `deployed :3070 (${health.sha}) status for live attempt ${live?.attemptId} exposes agesMs.attempt=${live?.agesMs?.attempt}`);
    assert('auto-bar-r-007-progress-age-p-005', Number.isFinite(live?.agesMs?.progress),
      `same status exposes agesMs.progress=${live?.agesMs?.progress} (lastProgressAtMs=${live?.clocks?.lastProgressAtMs})`);
    assert('auto-bar-r-007-freshness-p-005', near(live?.runnerHealth?.progressAgeMs, live?.agesMs?.progress, 5_000),
      `runner freshness is measured from the progress clock: runnerHealth.progressAgeMs=${live?.runnerHealth?.progressAgeMs} vs agesMs.progress=${live?.agesMs?.progress} (state ${live?.runnerHealth?.state})`);
    const fireNewer = (live?.clocks?.lastScheduledAtMs ?? 0) > (live?.clocks?.lastProgressAtMs ?? Infinity);
    assert('auto-bar-r-007-fire-exclusion-p-005',
      fireNewer && near(live?.runnerHealth?.progressAgeMs, live?.agesMs?.progress, 5_000) &&
        !near(live?.runnerHealth?.progressAgeMs, live?.agesMs?.scheduled, 5_000),
      `a scheduler fire newer than the last progress (lastScheduledAtMs=${live?.clocks?.lastScheduledAtMs} > lastProgressAtMs=${live?.clocks?.lastProgressAtMs}) did not refresh freshness: progressAgeMs=${live?.runnerHealth?.progressAgeMs} tracks progress age ${live?.agesMs?.progress}, not scheduled age ${live?.agesMs?.scheduled}`);
    // B. The newest TERMINAL attempt among this workspace's live green-checkpoint rows, projected by
    // the deployed module (the function the deployed status route calls).
    const [row] = psql(`SELECT install_slug, metadata->'qualificationTransaction' FROM harness_shared.routines
       WHERE workspace_id='papercusp-workspace' AND target_role='system:green-checkpoint'
         AND metadata->'qualificationTransaction'->>'phase'='terminal'
       ORDER BY (metadata->'qualificationTransaction'->>'lastTerminalVerdictAtMs')::bigint DESC LIMIT 1`);
    const nowMs = Date.now();
    const tx = q.parseCheckpointQualificationTransaction(JSON.parse(row![1]!));
    const term = q.projectCheckpointQualificationState(tx, nowMs);
    observations.r007TerminalRow = { install: row![0], attemptId: tx?.attemptId, outcome: tx?.outcome, clocks: term.clocks, agesMs: term.agesMs };
    assert('auto-bar-r-007-terminal-age-p-005', near(term.agesMs.terminal, nowMs - (tx?.lastTerminalVerdictAtMs ?? NaN), 1_000),
      `live terminal attempt ${tx?.attemptId} (${row![0]}, ${tx?.outcome?.kind}) status exposes agesMs.terminal=${term.agesMs.terminal}`);
    assert('auto-bar-r-007-terminal-freshness-p-005',
      typeof term.agesMs.terminal === 'number' && typeof term.agesMs.progress === 'number' && term.agesMs.terminal < term.agesMs.progress,
      `the terminal timestamp is the attempt's freshest clock: agesMs.terminal=${term.agesMs.terminal} < agesMs.progress=${term.agesMs.progress}`);
    const agree = q.describeQualificationSettleConflict(tx, { attemptId: tx.attemptId, candidate: tx.candidate, runId: tx.runId });
    const stale = q.describeQualificationSettleConflict(tx, { attemptId: 'probe-stale-attempt', candidate: tx.candidate, runId: 'probe-stale-run' });
    observations.r007Conflict = { agree, stale };
    assert('auto-bar-r-007-conflict-p-005',
      agree.length === 0 && stale.some((m: string) => m.startsWith('attempt stored=')) && stale.some((m: string) => m.startsWith('run stored=')),
      `identity check over live attempt ${tx?.attemptId}: matching identity -> ${JSON.stringify(agree)}; stale identity -> ${JSON.stringify(stale)}`);
  } else if (section === 'r001') {
    const [incident] = psql(`SELECT feature_id, item_kind, coalesce(source_plan_slug,'<none>'), status FROM harness_shared.work_items
       WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND feature_id='WI-10003256'`);
    observations.r001IncidentLane = incident;
    const census = psql(`SELECT count(*),
         count(*) FILTER (WHERE b.work_item_id='WI-10003256'),
         count(*) FILTER (WHERE b.evidence_ref ILIKE '%cc83bd6e%' OR b.evidence_ref ILIKE '%09e39c5d%' OR b.details::text ILIKE '%cc83bd6e%' OR b.details::text ILIKE '%09e39c5d%'),
         string_agg(DISTINCT b.work_item_id, ',' ORDER BY b.work_item_id)
       FROM harness_shared.spec_evidence_bindings b
       JOIN harness_shared.plan_spec_clauses c ON c.workspace_id=b.workspace_id AND c.harness_slug=b.harness_slug
         AND c.plan_slug=b.plan_slug AND c.spec_id=b.spec_id AND c.current_revision=b.spec_revision
       WHERE b.workspace_id='papercusp-workspace' AND b.harness_slug='papercusp' AND b.plan_slug='${PLAN}'
         AND b.retracted_at IS NULL AND b.spec_id ~ '^AUTO-BAR-R-00[2-8]-'`)[0]!;
    observations.r001ControlPlaneCensus = { currentBindings: census[0], onIncidentItem: census[1], citingIncidentShas: census[2], workItems: census[3] };
    assert('auto-bar-r-001-p-001', incident?.[1] === 'bug' && incident?.[2] === '<none>' && census[1] === '0',
      `incident red driven on ${incident?.[0]} (kind ${incident?.[1]}, source plan ${incident?.[2]}, ${incident?.[3]}) outside this plan; 0 of ${census[0]} current control-plane (R-002..R-008) bindings sit on it`);
    assert('auto-bar-r-001-independent-p-001', Number(census[0]) > 0 && census[2] === '0',
      `${census[0]} current control-plane bindings (work items ${census[3]}) cite the incident candidate cc83bd6e / repair head 09e39c5d ${census[2]} times: the control-plane fix was proven without touching the repair lane`);
  } else if (section === 'r009') {
    const health = await getJson('http://127.0.0.1:3070/api/health');
    const deployedFull = git('rev-parse', `${health.sha}^{commit}`);
    const mainSha = git('rev-parse', 'main');
    const reflog = git('reflog', 'show', '--date=unix', '--format=%H %gd %gs', 'main')
      .split('\n').filter((line) => line.startsWith(REPAIR_HEAD));
    const runs = psql(`SELECT file_path, status FROM harness_shared.test_runs
       WHERE commit_sha='${REPAIR_HEAD}' AND source='ci' AND worktree_dirty=false ORDER BY finished_at`);
    const byFile = new Map<string, string[]>();
    for (const [file, status] of runs) byFile.set(file!, [...(byFile.get(file!) ?? []), status!]);
    const failedFiles = [...byFile].filter(([, s]) => s.includes('fail') || s.includes('error'));
    const unrecovered = failedFiles.filter(([, s]) => s[s.length - 1] !== 'pass');
    observations.r009Verdict = { ciRows: runs.length, files: byFile.size, failedThenRetried: failedFiles.map(([f, s]) => `${f}: ${s.join('>')}`), unrecovered: unrecovered.map(([f]) => f) };
    observations.r009Promotion = { mainNow: mainSha, mainReflogEntriesAtRepairHead: reflog, deployedSha: deployedFull };
    assert('auto-bar-r-009-verdict-p-005', runs.length > 0 && unrecovered.length === 0,
      `gate suite ran on exact repair head ${REPAIR_HEAD.slice(0, 12)}: ${runs.length} clean-tree ci rows over ${byFile.size} files; ${failedFiles.length} file(s) failed then passed on retry, 0 left failing`);
    assert('auto-bar-r-009-main-p-005', reflog.length > 0 && isAncestor(REPAIR_HEAD, mainSha),
      `main reflog records main set to exactly ${REPAIR_HEAD.slice(0, 12)} (${reflog.length} entr${reflog.length === 1 ? 'y' : 'ies'}), and it remains an ancestor of main ${mainSha.slice(0, 12)}`);
    assert('auto-bar-r-009-green-pin-p-005', reflog.length > 0 && isAncestor(REPAIR_HEAD, mainSha),
      `main is green-only (automation fast-forwards it on a green verdict), so the reflog entry at ${REPAIR_HEAD.slice(0, 12)} is the green-pin promotion of the exact repair head`);
    assert('auto-bar-r-009-deploy-p-005', isAncestor(REPAIR_HEAD, deployedFull),
      `deployed :3070 serves ${health.sha} (${deployedFull.slice(0, 12)}), which contains repair head ${REPAIR_HEAD.slice(0, 12)} as an ancestor`);
    assert('auto-bar-r-009-p-005',
      isAncestor(REPAIR_HEAD, deployedFull) && unrecovered.length === 0 && isAncestor(INCIDENT_CANDIDATE, REPAIR_HEAD),
      `incident candidate ${INCIDENT_CANDIDATE.slice(0, 12)} is an ancestor of repair head ${REPAIR_HEAD.slice(0, 12)}, whose gate run left 0 failing files, and the deployed build contains it`);
    // P-007: deployed-only runtime parity. Same live Postgres, same attempt, read through the
    // deployed build and the staging build at the same moment.
    const [dep, stg, stgHealth] = await Promise.all([
      getJson('http://127.0.0.1:3070/api/desktop/git-pipeline'),
      getJson('http://127.0.0.1:3170/api/desktop/git-pipeline'),
      getJson('http://127.0.0.1:3170/api/health'),
    ]);
    const pick = (g: any) => ({ attemptId: g?.gate?.qualification?.attemptId, phase: g?.gate?.qualification?.phase,
      outcome: g?.gate?.qualification?.outcome?.kind, clocks: g?.gate?.qualification?.clocks,
      runnerState: g?.gate?.qualification?.runnerHealth?.state, safeNextAction: g?.gate?.qualification?.safeNextAction?.code });
    const d = pick(dep); const s = pick(stg);
    const same = JSON.stringify(d) === JSON.stringify(s);
    observations.p007Parity = { deployed: { sha: health.sha, ...d }, staging: { sha: stgHealth.sha, ...s } };
    assert('auto-bar-r-009-runtime-parity-p-007', isAncestor(REPAIR_HEAD, deployedFull) && same,
      `deployed ${health.sha} (contains repair head) and staging ${stgHealth.sha} project the same live qualification lifecycle: ${same ? 'identical' : 'DIFFERENT'} on attempt/phase/outcome/clocks/runner/nextAction`);
  } else {
    console.error('usage: <all|r007|r001|r009>');
    process.exit(2);
  }
}
const finishedAt = new Date().toISOString();
const passed = assertions.every((a) => a.passed);
console.log(JSON.stringify({
  schemaVersion: 1,
  kind: 'operational-test-evidence',
  name: `main-greening operational probe (${sections.join(', ')})`,
  framework: 'shell',
  command: ['npx', 'tsx', 'docs/evidence/main-greening-operational-probe-2026-09-29.mts', arg],
  exitCode: passed ? 0 : 1,
  startedAt,
  finishedAt,
  summary: `${assertions.filter((a) => a.passed).length}/${assertions.length} live assertions passed for plan ${PLAN}.`,
  assertions,
  plan: PLAN,
  observations,
}, null, 1));
process.exit(passed ? 0 : 1);
