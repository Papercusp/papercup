import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { expect } from 'vitest';
import { z } from 'zod';
import { submittedGoalReportDeliveries } from '../../../apps/operator/scripts/hooks/inject/core.mjs';
import { type ReportRecord } from './report-library';

const entrySchema = z.object({
  reportId: z.string(), title: z.string(), finding: z.string(), findingTruncated: z.boolean(),
  publishedAt: z.string(), relationship: z.string(), sourceRef: z.string(), disposition: z.string(),
  read: z.object({ tool: z.literal('reports:get'), args: z.object({ id: z.string() }) }),
});
const historySchema = z.object({
  recovery: z.object({ tool: z.literal('goals:get'), args: z.object({ id: z.string() }) }),
  relatedReports: z.object({
    status: z.literal('available'), deliveryToken: z.string().uuid(), entries: z.array(entrySchema),
  }),
});

/** Inspect only the GOAL history block that the holder submitted. Text elsewhere
 * in the prompt can cite the same edition without delivering its finding. */
export function deliveredEdition(prompt: string, goalId: string, reportId: string) {
  const lines = prompt.split(/\r?\n/);
  const headings = lines.flatMap((line, i) => line === 'GOAL HISTORY — own and bounded descendant evidence' ? [i] : []);
  expect(headings, 'one submitted GOAL history block').toHaveLength(1);
  const history = historySchema.parse(JSON.parse(lines[headings[0] + 1]));
  expect(history.recovery.args.id, 'GOAL history recipient scope').toBe(goalId);
  const page = history.relatedReports;
  const entries = page.entries.filter(entry => entry.reportId === reportId);
  if (entries.length !== 1) throw new Error('Expected exactly one delivered copy of edition ' + reportId);
  const [entry] = entries;
  expect(entry.read.args.id, 'issued library operation').toBe(reportId);

  // Compute the proof from the original bytes consumed by the submit hook.
  // Zod produces new objects and may change field order, so never re-hash its projection.
  const fragments = submittedGoalReportDeliveries(prompt)
    .filter(proof => proof.token === page.deliveryToken)
    .flatMap(proof => proof.fragments).filter(f => f.id === 'report:' + reportId);
  expect(fragments, 'submitted report fragment').toHaveLength(1);
  return { entry, fragment: fragments[0] };
}

function requireBuild(fullSha: string, observed: string | null | undefined, source: string) {
  expect(observed, source).toMatch(/^[a-f0-9]{7,40}$/);
  expect(fullSha.startsWith(observed!), source).toBe(true);
}

async function readKickoff(sql: Sql, workspace: string, owner: string, build: string) {
  const { readArchivedSessionTurns } = await import('./session-archive-read');
  const { SESSION_TURN_TEXT_CAP } = await import('./search/session-ingest');
  const { parseEnvelope, payloadSha256, readLedgerRowsAsync } = await import('./turn-provenance/turn-provenance');
  const [first] = await sql<{
    source_kind: 'codex' | 'claude' | 'omp'; session_id: string; turn_idx: number; text: string; submitted: Date;
  }[]>`
    SELECT source_kind, session_id, turn_idx, text, coalesce(ts, ingested_at) AS submitted
    FROM harness_shared.session_turns WHERE workspace_id IN (${workspace}, 'default') AND owner = ${owner}
      AND speaker = 'user' AND turn_origin = 'fleet-kickoff' AND turn_origin_verdict = 'agent-injected'
    ORDER BY coalesce(ts, ingested_at), turn_idx LIMIT 1`;
  if (!first) throw new Error('Missing verified first kickoff for ' + owner);
  const ref = 'session_turn:' + first.source_kind + ':' + first.session_id + ':' + first.turn_idx;
  let text = first.text;
  if (text.length >= SESSION_TURN_TEXT_CAP) {
    const source = await readArchivedSessionTurns(first.session_id, first.source_kind, undefined,
      { fullSource: true, turnIndices: [first.turn_idx] });
    const turn = source?.turns.find(t => t.turn_idx === first.turn_idx && t.speaker === 'user');
    if (source?.owner !== owner || source.errors.length || !turn || !turn.text.startsWith(text)) {
      throw new Error('Complete submitted source unavailable for ' + ref);
    }
    text = turn.text;
  }
  const envelope = parseEnvelope(text);
  if (envelope?.origin !== 'fleet-kickoff') throw new Error('Missing native kickoff envelope at ' + ref);
  const enrolled = (await readLedgerRowsAsync(owner, { includeExpired: true })).filter(row =>
    row.sid === owner && row.origin === envelope.origin && row.nonce === envelope.nonce);
  expect(enrolled.length, 'native kickoff enrollment for ' + ref).toBe(1);
  expect(enrolled[0].sha256, 'complete submitted payload at ' + ref).toBe(payloadSha256(envelope.payload));
  requireBuild(build, enrolled[0].issuer?.buildSha, 'loaded kickoff issuer build for ' + ref);
  return { ref, prompt: envelope.payload, submitted: first.submitted };
}

async function observeHolder(sql: Sql, workspace: string, goal: string, owner: string, build: string, report: ReportRecord) {
  const { reportSourceVersion } = await import('./memory/temporal-render');
  const kickoff = await readKickoff(sql, workspace, owner, build);
  const { entry, fragment } = deliveredEdition(kickoff.prompt, goal, report.reportId);
  const otherEdition = 'rpt_' + randomUUID();
  expect(() => deliveredEdition(kickoff.prompt, goal, otherEdition))
    .toThrow('Expected exactly one delivered copy of edition ' + otherEdition);
  expect(entry).toMatchObject({ title: report.title, finding: report.summary || report.bodyMd,
    findingTruncated: false, relationship: 'cited by goal', sourceRef: goal, disposition: 'current' });
  expect(Date.parse(entry.publishedAt)).toBe(Date.parse(report.publishedAt));
  const fingerprint = reportSourceVersion(workspace, report.reportId, report.title, report.bodyMd, entry.publishedAt).fingerprint;
  const [stamp] = await sql<{ epoch: number }[]>`
    SELECT epoch FROM harness_shared.corpus_session_surfaced WHERE session_id = ${owner}
      AND epoch = 0 AND port = 'goal-brief' AND ref = ${fragment.id} AND source_fingerprint = ${fingerprint}`;
  expect(stamp?.epoch, 'native confirmation in fresh holder context ' + owner).toBe(0);

  // The normal library handler emits this metadata only after reading and
  // returning the requested edition under the calling holder's visibility.
  const [lookup] = await sql<{ id: string; serving_build_sha: string }[]>`
    SELECT ti.id::text, ti.serving_build_sha FROM harness_shared.tool_invocations ti
    CROSS JOIN LATERAL jsonb_array_elements(ti.metadata_json->'reportReadbacks') receipt
    WHERE ti.workspace_id = ${workspace} AND ti.coord_owner_id = ${owner} AND ti.goal_id = ${goal}
      AND ti.goal_actor_class = 'holder-agent' AND ti.serving_host = 'port-3070'
      AND ti.tool_name = 'reports:get' AND ti.status = 'ok' AND ti.invoked_at >= ${kickoff.submitted}
      AND ti.args_json->>'id' = ${entry.read.args.id} AND receipt->>'id' = ${report.reportId}
      AND receipt->>'visibility' = ${report.visibility} AND receipt->>'bodySha256' = ${report.bodySha256}
      AND (receipt->>'bodyBytes')::bigint = ${Buffer.byteLength(report.bodyMd)}
      AND (receipt->>'publishedAt')::timestamptz = ${new Date(report.publishedAt)}
    ORDER BY ti.id LIMIT 1`;
  if (!lookup) throw new Error('Missing same-holder release library readback for ' + owner);
  requireBuild(build, lookup.serving_build_sha, 'reports:get ' + lookup.id);
  return { owner, ref: kickoff.ref, lookup: lookup.id, epoch: stamp.epoch, fragment,
    kickoffSha256: createHash('sha256').update(kickoff.prompt, 'utf8').digest('hex') };
}

/** The two inputs identify the scoped acceptance exercise. All observations
 * come from the release, the two elected holders, and the library read ledger. */
export async function observeReleasedGoalReport() {
  const { gitPipelinePosition } = await import('./git-pipeline-position');
  const position = await gitPipelinePosition({ path: 'packages/operator-core/lib/goal-related-reports.ts' });
  const build = position.verdictProvenance.lastGreenSha;
  if (!build || !/^[a-f0-9]{40}$/.test(build) || build !== position.deployedSha ||
      position.verdictProvenance.deployOrigin !== 'gate-green') throw new Error('Missing exact green deployment');
  const release = position.servingRuntimes?.find(runtime => runtime.runtime === 'release-operator');
  if (!release?.containsChange) throw new Error('Green release lacks the GOAL report change');
  requireBuild(build, release.buildSha, 'serving release build');

  const goal = process.env.PAPERCUSP_GOAL_REPORT_ACCEPTANCE_GOAL;
  const edition = process.env.PAPERCUSP_GOAL_REPORT_ACCEPTANCE_EDITION;
  if (!goal || !edition) throw new Error('Set PAPERCUSP_GOAL_REPORT_ACCEPTANCE_GOAL and PAPERCUSP_GOAL_REPORT_ACCEPTANCE_EDITION');
  const { getOrgPg } = await import('@papercusp/db-org');
  const { activeWorkspaceId } = await import('./workspace-registry');
  const { getReport } = await import('./report-library');
  const workspace = activeWorkspaceId();
  const sql = getOrgPg().sql;
  const report = await getReport(sql, workspace, edition, {}, undefined, { currentEditionOnly: true });
  if (!report || report.visibility !== 'workspace' || report.retiredAt) throw new Error('Missing current workspace acceptance edition');
  const [fixture] = await sql<{ body: string }[]>`
    SELECT body FROM harness_shared.goals WHERE workspace_id = ${workspace} AND id = ${goal}`;
  expect(fixture?.body.match(/\brpt_[\w-]+/g), 'independent citation on the scoped goal').toContain(edition);
  const holders = await sql<{ owner_id: string; lease: number }[]>`
    SELECT DISTINCT owner_id, goal_lease_epoch::int AS lease FROM harness_shared.agent_mode_changes
    WHERE workspace_id = ${workspace} AND subject = ${goal} AND new_mode = 'goal' AND goal_lease_epoch IS NOT NULL
    ORDER BY lease`;
  expect(holders, 'initial and replacement elections on the scoped goal').toHaveLength(2);
  expect(holders[1].lease).toBeGreaterThan(holders[0].lease);
  expect(holders[1].owner_id).not.toBe(holders[0].owner_id);
  const deliveries = await Promise.all(holders.map(async holder => ({ lease: holder.lease,
    ...await observeHolder(sql, workspace, goal, holder.owner_id, build, report) })));
  return { build, goal, edition, deliveries };
}
