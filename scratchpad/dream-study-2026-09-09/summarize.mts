import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOrgPg } from '@papercusp/db-org';
import { dreamCapabilityRun, dreamRunAssessments } from '../../packages/operator-core/lib/dream/dream-run-provenance.ts';
import { STUDY_BLOCKS, readStudyTotals, validateStudyBlocks } from './accounting.mts';

const here = dirname(fileURLToPath(import.meta.url));
const workspaceId = 'papercusp-workspace';
process.env.PAPERCUSP_WORKSPACE_ID = workspaceId;
const blocks = await Promise.all(Object.values(STUDY_BLOCKS).map(async b => JSON.parse(await readFile(resolve(here, b.file), 'utf8'))));
validateStudyBlocks(blocks);
const pins = blocks.map(b => b.pin);
const { sql } = getOrgPg();
try {
  const rows = await sql<any[]>`
    SELECT run_id, started_at, completed_at, status, outcome, review, cost_usd, error
      FROM harness_shared.dream_runs
     WHERE workspace_id = ${workspaceId} AND pot_slug = 'papercusp'
       AND outcome->'capabilityRun'->'evaluation'->>'protocolPin' = ANY(${pins}::text[])
     ORDER BY started_at, run_id`;
  if (rows.some(r => !r.completed_at)) throw new Error('A study Dream is still running; summarize only after completion');
  const totals = await readStudyTotals(sql, workspaceId);
  const ticks = await sql<any[]>`
    SELECT status, tick_at, ideas_generated, ideas_routed, detail->'study' AS study
      FROM harness_shared.scout_ticks
     WHERE workspace_id = ${workspaceId}
       AND detail->'study'->>'protocolPin' = ANY(${pins}::text[])
       AND detail->'study'->>'arm' = 'blender' ORDER BY tick_at, id`;
  const byCycle = new Map<string, any[]>();
  for (const t of ticks) byCycle.set(t.study.cycleId, [...(byCycle.get(t.study.cycleId) ?? []), t]);
  const blender = [...byCycle].map(([cycleId, entries]) => {
    const final = entries.filter(e => e.status !== 'gated');
    if (final.length !== 1) throw new Error('Blender cycle lacks one authoritative final receipt: ' + cycleId);
    const row = final[0];
    return { cycleId, pin: row.study.protocolPin, configHash: row.study.configHash, status: row.status,
      settled: row.study.settled, ideasGenerated: row.ideas_generated, routed: row.ideas_routed,
      costUsd: row.study.costUsd, calls: row.study.calls, tickAt: row.tick_at };
  });
  const dreams = rows.map(row => {
    const run = dreamCapabilityRun(row)!;
    const selection = run.sampling?.status === 'selected' ? run.sampling.selection : null;
    const calls = run.calls.map(c => ({ phase: c.phase, status: c.status, model: c.model,
      settledUsd: c.usage?.costUsd ?? null, reservedUsd: c.reservedUsd,
      zeroPricedUsage: c.status === 'settled' && !c.model.startsWith('local:') && c.usage?.costUsd === 0 &&
        (c.usage.inputTokens + c.usage.outputTokens) > 0 }));
    const amount = calls.reduce((n,c) => n + (c.zeroPricedUsage || c.settledUsd === null ? c.reservedUsd : c.settledUsd), 0);
    const zeroPriceReserve = calls.filter(c => c.zeroPricedUsage).reduce((n,c) => n + c.reservedUsd, 0);
    if (Math.abs(amount - (Number(row.cost_usd) + zeroPriceReserve)) > 1e-8)
      throw new Error('Call/row accounting mismatch: ' + row.run_id);
    const candidate = row.outcome?.insight?.capability ?? null;
    return {
      runId: row.run_id, pin: run.evaluation!.protocolPin, arm: run.evaluation!.arm,
      matchedPairIndex: run.evaluation!.matchedPairIndex ?? null, startedAt: row.started_at,
      status: row.status, verdict: row.review?.verdict ?? null, reason: row.review?.reason ?? row.outcome?.verdict ?? row.error ?? 'unknown',
      note: row.review?.note ?? null, candidateHash: row.review?.candidateHash ?? null,
      behavior: candidate?.behavior ?? null, beneficiary: candidate?.beneficiary ?? null,
      units: selection ? [selection.a.packet.unit.id, selection.b.packet.unit.id, ...(selection.c ? [selection.c.entry.packet.unit.id] : [])] : [],
      sourceSnapshot: run.sampling?.log.snapshotFingerprint ?? null,
      aOnly: row.review?.controls?.aOnly?.unchanged ?? null, bOnly: row.review?.controls?.bOnly?.unchanged ?? null,
      assessments: dreamRunAssessments(row), calls, accountedUsd: amount,
      settledProviderUsd: calls.filter(c => !c.model.startsWith('local:')).reduce((n,c) => n + (c.settledUsd ?? 0), 0),
    };
  });
  const grouped = totals.map(total => {
    const selected = dreams.filter(r => r.pin === total.pin && r.arm === total.arm);
    const scientific: Record<string, number> = {};
    for (const row of selected) {
      const key = (row.verdict ?? 'no-review') + '/' + row.reason;
      scientific[key] = (scientific[key] ?? 0) + 1;
    }
    return { ...total, scientific, sourceUnitIds: [...new Set(selected.flatMap(r => r.units))].sort(),
      qualifiedFamilyAssessment: 'not completed; do not substitute accepted-row counts',
      sourceSnapshots: [...new Set(selected.map(r => r.sourceSnapshot).filter(Boolean))] };
  });
  const paired = new Map<string, typeof dreams>();
  for (const d of dreams.filter(d => d.matchedPairIndex !== null)) {
    const key = d.pin + ':' + d.matchedPairIndex;
    paired.set(key, [...(paired.get(key) ?? []), d]);
  }
  const matchedPairs = [...paired].map(([key, entries]) => {
    const pair = entries.find(x => x.arm === 'structured-pair');
    const triple = entries.find(x => x.arm === 'structured-triple');
    const primaryMatch = !!pair && !!triple && JSON.stringify(pair.units.slice(0,2)) === JSON.stringify(triple.units.slice(0,2));
    if (pair && triple && !primaryMatch) throw new Error('Mismatched A/B ablation: ' + key);
    return { key, complete: !!pair && !!triple, primaryMatch, pair: pair?.runId, triple: triple?.runId,
      units: triple?.units ?? pair?.units, pairVerdict: pair?.verdict, tripleVerdict: triple?.verdict,
      pairReason: pair?.reason, tripleReason: triple?.reason,
      pairAccountedUsd: pair?.accountedUsd, tripleAccountedUsd: triple?.accountedUsd };
  });
  const accountedUsd = totals.reduce((n,r) => n + r.cost, 0);
  const attempts = totals.reduce((n,r) => n + r.attempts, 0);
  if (attempts !== dreams.length + blender.length) throw new Error('Study attempt census mismatch');
  const output = { measuredAt: new Date().toISOString(), disposition: 'interim/inconclusive', attempts, accountedUsd,
    accountingBasis: 'Production ledgers plus conservative reservations for unknown calls and historical zero-priced provider usage; not invoice cost.',
    grouped, dreams, blender, matchedPairs,
    scientific: { dreamAttempts: dreams.length, acceptedDreamRows: dreams.filter(d=>d.verdict==='accept').length,
      unverifiedDreamReviews: dreams.filter(d=>d.verdict==='unverified').length,
      noDreamReview: dreams.filter(d=>d.verdict===null).length,
      blenderIdeas: blender.reduce((n,b)=>n+b.ideasGenerated,0),
      blenderRouted: blender.reduce((n,b)=>n+b.routed,0) },
    historicalDiagnosticWarnings: [
      'Historical timeout notes claiming never-admitted/local-governor starvation were retracted in EI-22769219749818913: the Codex adapter did not emit onAdmitted. These raw persisted strings do not establish the cause or prove no generation occurred.',
      'For the original Haiku cycle 36930ec0-0135-4c3d-8261-b9b8f8028545, the recovered driver log records four HTTP 429 rate_limit_error retries before the deadline. This contradicts its persisted never-admitted explanation. The responding hop, pool account, later retry progress and billed usage remain unestablished; retain the USD 0.039173 unknown-call reservation. Evidence is preserved in EI-22756328656642291 comment 203056; source /tmp/dream-study-pair-after-readiness-20260909.log, SHA-256 ea874cd3a74f97ec879eb9d490a8d1e257684a52f54dc487ccf716e080fe5e3c. This historical evidence does not prove current Haiku recovery.',
    ],
    outstanding: ['Blinded human/domain review of stratified rejected/unverified sample', 'Flat versus faceted offline ablation',
      'Qualified family and feasibility adjudication', 'Bounded downstream trials where qualified candidates exist', 'Independent final acceptance and owner disposition'],
    limitations: ['Four source units and one source snapshot; no domain-general inference',
      'Model blocks and pre/post infrastructure or prompt-contract windows must remain distinct',
      'Ordinary Blender uses its production corpus and one ideator, not the Dream source population',
      'Unequal spend so far; no matched-spend superiority claim',
      'All phase cost figures exclude unmeasured engineer/reviewer time and local compute dollar valuation',
      'No substantive rejection should be inferred from an unverified verdict or a missing judgment'],
  };
  const lines = ['# Dream study evidence — interim', '', `Measured ${output.measuredAt}. **Inconclusive; final acceptance remains open.**`, '',
    `${attempts} governed study attempts; $${accountedUsd.toFixed(6)} accounted, including conservative reservations. This is not invoice cost.`, '',
    '| Model block | Arm | Attempts | Accounted USD |', '|---|---|---:|---:|',
    ...grouped.map(g => `| ${g.pin === STUDY_BLOCKS.luna.pin ? 'Luna/Sol' : 'Haiku/Sol'} | ${g.arm} | ${g.attempts} | ${g.cost.toFixed(6)} |`), '',
    '## Observed outcomes', '',
    `Dream: ${output.scientific.dreamAttempts} attempts, ${output.scientific.acceptedDreamRows} accepted review rows, ${output.scientific.unverifiedDreamReviews} unverified reviews, and ${output.scientific.noDreamReview} attempts without a completed review. Unverified results are not substantive proposal rejections.`, '',
    `Blender: ${blender.length} governed cycles, ${output.scientific.blenderIdeas} generated ideas, ${output.scientific.blenderRouted} routed ideas. Routing was explicitly deferred in the newer block; its scored-idea artifacts report no survivors.`, '',
    `${matchedPairs.filter(x=>x.complete).length} matched A/B pairs were verified against the stored unit IDs. Both members of every completed matched comparison remain unverified; these data do not establish an incremental benefit from C.`, '',
    '## Interpretation', '', ...output.limitations.map(s => '- '+s), '',
    ...output.historicalDiagnosticWarnings.map(s=>'- '+s), '', '## Remaining acceptance work', '',
    ...output.outstanding.map(s => '- '+s), '',
    '## Reproduction and evidence', '',
    '`PAPERCUSP_WORKSPACE_ID=papercusp-workspace node --import tsx scratchpad/dream-study-2026-09-09/summarize.mts`', '',
    'The companion [JSON evidence](evidence-summary.json) records each attempt, settled calls and conservative reservations, source-unit coverage, exact paired-run matching, Blender receipts, and outstanding work. The source ledgers are `harness_shared.dream_runs` and `harness_shared.scout_ticks`; `accounting.mts` owns cumulative budget accounting. Historic trial rows are not rewritten.', ''];
  await writeFile(resolve(here,'evidence-summary.json'),JSON.stringify(output,null,2)+'\n');
  await writeFile(resolve(here,'evidence-summary.md'),lines.join('\n'));
  console.log(JSON.stringify({attempts,accountedUsd,groups:grouped.map(({pin,arm,attempts,cost,scientific})=>({pin,arm,attempts,cost,scientific})),matchedPairs:matchedPairs.length,completePairs:matchedPairs.filter(x=>x.complete).length}));
} finally { await sql.end(); }
process.exit(0);
