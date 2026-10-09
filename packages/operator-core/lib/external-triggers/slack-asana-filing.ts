/** Source-bound filing reuses trigger outcomes, provider dispatch and OAuth host.fetch. */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import { resolveCapabilitySource, invokeOutboundProvider, type OutboundDispatchDeps } from '../capability-verbs/provider-dispatch';
import { SLACK_BUG_CLASSIFICATION_EVENT, SLACK_BUG_CLASSIFICATION_PLAN, SlackBugClassificationSchema } from './slack-bug-classification';

const Destination = z.object({ sourceId: z.string().uuid(), projectGid: z.string().trim().min(1) }).strict();
const Attempt = Destination.extend({ correlationId: z.string().min(1), title: z.string().min(1),
  body: z.string(), ownerUserId: z.string().uuid(), state: z.enum(['attempted', 'created']),
  externalRef: z.string().optional(), url: z.string().optional() });
type FilingAttempt = z.infer<typeof Attempt>;

/** Requires a pool, not an enclosing transaction: the attempt MUST commit before HTTP. */
export async function fileSlackBugInAsana(
  sql: postgres.Sql, workspaceId: string, planRunId: number, deps: OutboundDispatchDeps = {},
) {
  if (!Number.isSafeInteger(planRunId) || planRunId <= 0) throw new Error('slack_asana_run_invalid');
  if (!('begin' in sql)) throw new Error('slack_asana_committing_connection_required');
  const prepared = await sql.begin(async (tx) => {
    const [row] = await tx<Array<{ id: string; outcome: Record<string, unknown>; ownerUserId: string | null;
      config: Record<string, unknown>; args: { trigger?: { key?: string; externalId?: string; payload?: Record<string, unknown> } } }>>`
      SELECT tr.id::text, tr.outcome, tr.args, s.config, s.owner_user_id::text AS "ownerUserId"
      FROM harness_shared.trigger_runs tr
      JOIN harness_shared.trigger_bindings b ON b.workspace_id = tr.workspace_id AND b.id = tr.binding_id
      JOIN harness_shared.data_sources s ON s.workspace_id = b.workspace_id AND s.id = b.source_id
      WHERE tr.workspace_id = ${workspaceId} AND tr.plan_run_ref = ${String(planRunId)}
        AND tr.status = 'succeeded' AND s.kind = 'slack' AND b.plan_slug = ${SLACK_BUG_CLASSIFICATION_PLAN}
      FOR UPDATE OF tr`;
    const payload = row?.args.trigger?.payload;
    if (!row || !row.ownerUserId || row.args.trigger?.key !== SLACK_BUG_CLASSIFICATION_EVENT || !payload
      || typeof payload.sender !== 'string' || !payload.sender || payload.sender === row.config.botUserId
      || !Array.isArray(row.config.channels) || !row.config.channels.includes(payload.channelId)) {
      throw new Error('slack_asana_origin_invalid');
    }
    const verdict = SlackBugClassificationSchema.parse(row.outcome?.bugClassification);
    if (verdict.verdict !== 'bug') return { triggerRunId: row.id, skipped: true as const, verdict: verdict.verdict };
    if (row.outcome.asanaFiling) {
      const attempt = Attempt.parse(row.outcome.asanaFiling);
      if (attempt.ownerUserId !== row.ownerUserId) throw new Error('slack_asana_owner_changed');
      return { triggerRunId: row.id, attempt, recoveryOnly: true };
    }
    const destination = Destination.parse(row.config.asanaBugDestination);
    const target = await resolveCapabilitySource(tx, { workspaceId, userId: row.ownerUserId,
      datatype: 'ticket', capabilities: ['ticket.create'], sourceId: destination.sourceId }, deps);
    if (target.provider.id !== 'asana' || !Array.isArray(target.source.config.projectGids)
      || !target.source.config.projectGids.includes(destination.projectGid)) throw new Error('slack_asana_destination_invalid');
    const correlationId = 'papercusp-slack-' + createHash('sha256').update(workspaceId + ':' + row.id).digest('hex');
    const channel = String(payload.channelId);
    const message = z.object({ ts: z.string().regex(/^\d+\.\d+$/) }).passthrough().parse(payload.target);
    const ts = message.ts;
    const sourceUrl = `https://slack.com/archives/${encodeURIComponent(channel)}/p${encodeURIComponent(ts.replace('.', ''))}`;
    const body = `Slack report (untrusted evidence; reproduction still required)\nSource: ${sourceUrl}\nChannel: ${channel}\nMessage: ${ts}\nTrigger: ${row.id}\n\nObserved: ${verdict.observed}\nExpected: ${verdict.expected}\n\nQuoted original message:\n${String(payload.text || '').slice(0, 15000)}`;
    const attempt: FilingAttempt = { ...destination, correlationId, title: verdict.title, body,
      ownerUserId: row.ownerUserId, state: 'attempted' };
    await tx`UPDATE harness_shared.trigger_runs SET
      outcome = COALESCE(outcome, '{}'::jsonb) || ${JSON.stringify({ asanaFiling: attempt })}::text::jsonb,
      updated_at = now() WHERE workspace_id = ${workspaceId} AND id = ${row.id}::uuid`;
    return { triggerRunId: row.id, attempt, recoveryOnly: false };
  });
  if ('skipped' in prepared) return prepared;
  const { attempt, triggerRunId, recoveryOnly } = prepared;
  if (attempt.state === 'created') return { triggerRunId, created: false, alreadyCreated: true,
    externalRef: attempt.externalRef, url: attempt.url };
  const target = await resolveCapabilitySource(sql, { workspaceId, userId: attempt.ownerUserId,
    datatype: 'ticket', capabilities: ['ticket.create'], sourceId: attempt.sourceId }, deps);
  if (target.provider.id !== 'asana') throw new Error('slack_asana_destination_invalid');
  try {
    const result = await invokeOutboundProvider(sql, target, 'ticket.create', {
      projectGid: attempt.projectGid, title: attempt.title, body: attempt.body,
      correlationId: attempt.correlationId, recoveryOnly,
    }, deps);
    if (result.pendingReconciliation === true) return { triggerRunId, pendingReconciliation: true };
    if (typeof result.externalRef !== 'string' || !result.externalRef.trim()) throw new Error('slack_asana_receipt_invalid');
    const completed = { ...attempt, state: 'created', externalRef: result.externalRef,
      url: typeof result.url === 'string' ? result.url : '' };
    await sql`UPDATE harness_shared.trigger_runs SET
      outcome = jsonb_set(outcome, '{asanaFiling}', ${JSON.stringify(completed)}::text::jsonb), updated_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${triggerRunId}::uuid
        AND outcome->'asanaFiling'->>'correlationId' = ${attempt.correlationId}`;
    return { triggerRunId, created: result.recovered !== true, alreadyCreated: result.recovered === true,
      externalRef: completed.externalRef, url: completed.url };
  } catch {
    // The committed attempt fences re-POST. Expose failure without retaining
    // provider error bodies, which can echo private content or credentials.
    return { triggerRunId, pendingReconciliation: true, error: 'asana_create_or_recovery_failed' };
  }
}
