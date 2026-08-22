/** Flagship Slack mention → plan run → thread response binding (P-008). */
import type postgres from 'postgres';
import { hashPlanContent } from '@papercusp/plan-parser';
import type { TokenStorage } from '../oauth/token';
import { deriveIndexFromContent } from '../agent-tools/plans/source';
import { writePlanIndexRows } from '../agent-tools/plans/plan-index-rows';
import { ensureExternalTriggerBinding, type CreatedExternalTriggerBinding } from './admin';
import { postSlackThreadMessage, resolveSlackSocketCredentials } from './slack';
import type { ExternalTriggerSourceRow } from './source-store';

type Db = postgres.Sql | postgres.TransactionSql;

export const SLACK_RESPOND_IN_THREAD_HARNESS = 'papercusp';
export const SLACK_RESPOND_IN_THREAD_PLAN = 'slack-respond-in-thread-2026-08-22';
export const SLACK_RESPOND_IN_THREAD_EVENT = 'ext:slack:mention';

export const SLACK_RESPOND_IN_THREAD_PLAN_CONTENT = `---
title: Slack mention — respond in thread
slug: ${SLACK_RESPOND_IN_THREAD_PLAN}
status: ready
created: 2026-08-22
updated: 2026-08-22
---

# Slack mention — respond in thread

## Now

**State:** Ready built-in template. Each Slack mention creates one isolated event run.

**Next:** Read the trigger inputs, write a concise answer, and post it to the originating thread.

## Background

The trigger run carries the normalized Slack envelope under \`plan_run.inputs.trigger\`.
The response tool accepts only that run's numeric id; it resolves the source, channel,
thread, and bot credential server-side so a worker cannot redirect the reply elsewhere.

## Phase 1 — Respond

- **P-001** \`todo\` Read \`payload.plan_run.inputs.trigger.payload\`, draft a concise response to the triggering mention, then call \`slack:respond-in-thread\` with \`planRunId=payload.plan_run.runId\` and the response text. Complete only after the tool reports \`posted:true\` or \`alreadyPosted:true\`.

## Decisions

### D-001 — Bind replies to a trigger plan run, never caller-supplied Slack coordinates
Date: 2026-08-22
The reply tool resolves channel and thread from the durable trigger run. Its public input is only planRunId plus text, preventing arbitrary-channel posting and keeping credentials server-side.
`;

export const SLACK_RESPOND_IN_THREAD_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['trigger'],
  properties: {
    trigger: {
      type: 'object',
      additionalProperties: true,
      required: ['key', 'source', 'event', 'sourceId', 'externalId', 'dedupeKey', 'payload'],
      properties: {
        key: { const: SLACK_RESPOND_IN_THREAD_EVENT },
        source: { const: 'slack' },
        event: { const: 'mention' },
        sourceId: { type: 'string', minLength: 1 },
        externalId: { type: 'string', minLength: 1 },
        dedupeKey: { type: 'string', minLength: 1 },
        payload: {
          type: 'object',
          additionalProperties: true,
          required: ['channelId', 'threadId', 'text'],
          properties: {
            channelId: { type: 'string', minLength: 1 },
            threadId: { type: 'string', pattern: '^\\d+(?:\\.\\d+)?$' },
            text: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  },
} as const;

export interface SlackFlagshipPlanEnsureResult {
  created: boolean;
  schemaAdded: boolean;
}

/**
 * Create the immutable built-in plan once, using the canonical markdown-derived
 * plan index writer so plan_items and harness_plans.items cannot drift.
 */
export async function ensureSlackRespondInThreadPlan(
  sql: postgres.Sql,
  workspaceId: string,
): Promise<SlackFlagshipPlanEnsureResult> {
  const idx = deriveIndexFromContent(SLACK_RESPOND_IN_THREAD_PLAN_CONTENT);
  const itemsJson = JSON.stringify(idx.items);
  const decisionsJson = JSON.stringify(idx.decisions);
  const inputSchemaJson = JSON.stringify(SLACK_RESPOND_IN_THREAD_INPUT_SCHEMA);
  return sql.begin(async (tx) => {
    const lockKey = [workspaceId, SLACK_RESPOND_IN_THREAD_HARNESS, SLACK_RESPOND_IN_THREAD_PLAN].join(':');
    await tx`SELECT pg_advisory_xact_lock(hashtext('harness_plans'), hashtext(${lockKey}))`;
    const existing = await tx<Array<{ inputSchema: unknown }>>`
      SELECT input_schema AS "inputSchema"
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${SLACK_RESPOND_IN_THREAD_HARNESS}
         AND plan_slug = ${SLACK_RESPOND_IN_THREAD_PLAN}`;
    if (existing[0]) {
      if (existing[0].inputSchema == null) {
        await tx`
          UPDATE harness_shared.harness_plans
             SET input_schema = ${inputSchemaJson}::text::jsonb,
                 version = version + 1, updated_at = now()
           WHERE workspace_id = ${workspaceId}
             AND harness_slug = ${SLACK_RESPOND_IN_THREAD_HARNESS}
             AND plan_slug = ${SLACK_RESPOND_IN_THREAD_PLAN}`;
        return { created: false, schemaAdded: true };
      }
      return { created: false, schemaAdded: false };
    }
    await tx`
      INSERT INTO harness_shared.harness_plans (
        workspace_id, harness_slug, plan_slug, title, status, content, content_hash,
        version, created, updated, is_legacy, items, decisions, now_state, now_next,
        input_schema, origin
      ) VALUES (
        ${workspaceId}, ${SLACK_RESPOND_IN_THREAD_HARNESS}, ${SLACK_RESPOND_IN_THREAD_PLAN},
        ${idx.title}, ${idx.status}, ${SLACK_RESPOND_IN_THREAD_PLAN_CONTENT},
        ${hashPlanContent(SLACK_RESPOND_IN_THREAD_PLAN_CONTENT)}, 1,
        ${idx.created}, ${idx.updated}, ${idx.isLegacy}, ${itemsJson}::text::jsonb,
        ${decisionsJson}::text::jsonb, ${idx.nowState}, ${idx.nowNext},
        ${inputSchemaJson}::text::jsonb, 'local'
      )`;
    await writePlanIndexRows(
      tx as unknown as Parameters<typeof writePlanIndexRows>[0],
      {
        workspaceId,
        harnessSlug: SLACK_RESPOND_IN_THREAD_HARNESS,
        planSlug: SLACK_RESPOND_IN_THREAD_PLAN,
      },
      idx,
    );
    return { created: true, schemaAdded: true };
  });
}

export interface SlackFlagshipBindingResult {
  plan: SlackFlagshipPlanEnsureResult;
  binding: CreatedExternalTriggerBinding;
}

/** Install the built-in template and its one disarmed, reconnect-idempotent binding. */
export async function ensureSlackRespondInThreadBinding(
  sql: postgres.Sql,
  workspaceId: string,
  source: ExternalTriggerSourceRow,
  createdBy?: string | null,
  deps: {
    ensurePlan?: typeof ensureSlackRespondInThreadPlan;
    ensureBinding?: typeof ensureExternalTriggerBinding;
  } = {},
): Promise<SlackFlagshipBindingResult> {
  if (source.workspaceId !== workspaceId || source.kind !== 'slack') {
    throw new Error('slack_flagship_source_invalid');
  }
  const plan = await (deps.ensurePlan ?? ensureSlackRespondInThreadPlan)(sql, workspaceId);
  const binding = await (deps.ensureBinding ?? ensureExternalTriggerBinding)(sql, workspaceId, {
    sourceId: source.id,
    planHarnessSlug: SLACK_RESPOND_IN_THREAD_HARNESS,
    planSlug: SLACK_RESPOND_IN_THREAD_PLAN,
    eventPattern: SLACK_RESPOND_IN_THREAD_EVENT,
    createdBy,
  });
  return { plan, binding };
}

interface SlackReplyTriggerRow {
  id: string;
  args: Record<string, unknown>;
  outcome: Record<string, unknown> | null;
  sourceId: string;
  ownerUserId: string | null;
  credentialRef: string | null;
  sourceStatus: string;
  sourceConfig: Record<string, unknown>;
  sourceCursor: Record<string, unknown>;
}

export interface SlackPlanThreadResponseResult {
  posted: boolean;
  alreadyPosted: boolean;
  channelId: string;
  threadId: string;
  messageTs: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolve the originating Slack coordinates from a durable plan run and post
 * exactly once per recorded success. The row lock collapses concurrent retries.
 */
export async function respondToSlackTriggerPlanRun(
  sql: Db,
  workspaceId: string,
  planRunId: number,
  responseText: string,
  deps: {
    storage?: TokenStorage;
    fetch?: typeof fetch;
    apiOrigin?: string;
    now?: () => Date;
  } = {},
): Promise<SlackPlanThreadResponseResult> {
  if (!Number.isSafeInteger(planRunId) || planRunId <= 0) throw new Error('slack_reply_plan_run_id_invalid');
  const text = responseText.trim();
  if (!text || text.length > 4_000) throw new Error('slack_reply_text_invalid');
  const respondInTransaction = async (tx: Db): Promise<SlackPlanThreadResponseResult> => {
    const rows = await tx<SlackReplyTriggerRow[]>`
      SELECT tr.id::text,
             tr.args,
             tr.outcome,
             s.id::text AS "sourceId",
             s.owner_user_id::text AS "ownerUserId",
             s.credential_ref AS "credentialRef",
             s.status AS "sourceStatus",
             s.config AS "sourceConfig",
             s.cursor AS "sourceCursor"
        FROM harness_shared.trigger_runs tr
        JOIN harness_shared.trigger_bindings b
          ON b.workspace_id = tr.workspace_id AND b.id = tr.binding_id
        JOIN harness_shared.trigger_sources s
          ON s.workspace_id = b.workspace_id AND s.id = b.source_id
       WHERE tr.workspace_id = ${workspaceId}
         AND tr.plan_run_ref = ${String(planRunId)}
         AND tr.status = 'succeeded'
         AND s.kind = 'slack'
       ORDER BY tr.completed_at DESC NULLS LAST, tr.id
       LIMIT 1
       FOR UPDATE OF tr`;
    const row = rows[0];
    if (!row) throw new Error(`slack_reply_trigger_run_not_found:${planRunId}`);
    const prior = object(row.outcome).slackThreadReply;
    const priorReply = object(prior);
    const priorMessageTs = string(priorReply.messageTs);
    if (priorMessageTs) {
      return {
        posted: false,
        alreadyPosted: true,
        channelId: string(priorReply.channelId),
        threadId: string(priorReply.threadId),
        messageTs: priorMessageTs,
      };
    }
    const trigger = object(row.args.trigger);
    const payload = object(trigger.payload);
    const channelId = string(payload.channelId);
    const threadId = string(payload.threadId);
    if (!channelId || !threadId) throw new Error('slack_reply_trigger_coordinates_missing');
    const source: ExternalTriggerSourceRow = {
      id: row.sourceId,
      workspaceId,
      kind: 'slack',
      ownerUserId: row.ownerUserId,
      credentialRef: row.credentialRef,
      status: row.sourceStatus,
      config: row.sourceConfig,
      cursor: row.sourceCursor,
    };
    const installSlug = string(source.config.installSlug) || SLACK_RESPOND_IN_THREAD_HARNESS;
    const credentials = await resolveSlackSocketCredentials(source, installSlug, deps.storage);
    const posted = await postSlackThreadMessage(
      credentials.botToken,
      {
        channelId,
        threadId,
        text,
      },
      { fetch: deps.fetch, apiOrigin: deps.apiOrigin },
    );
    const outcome = {
      ...object(row.outcome),
      slackThreadReply: {
        ...posted,
        postedAt: (deps.now ?? (() => new Date()))().toISOString(),
      },
    };
    await tx`
      UPDATE harness_shared.trigger_runs
         SET outcome = ${JSON.stringify(outcome)}::text::jsonb, updated_at = now()
       WHERE workspace_id = ${workspaceId} AND id = ${row.id}::uuid`;
    return { posted: true, alreadyPosted: false, ...posted };
  };
  // Direct callers get an atomic row-lock/post/outcome transaction. Agent-tool
  // dispatch already supplies a TransactionSql (which deliberately has no
  // nested `.begin()`), so reuse that outer transaction instead.
  return 'begin' in sql ? sql.begin(respondInTransaction) : respondInTransaction(sql);
}
