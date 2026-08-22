/** Flagship Gmail inbound message → plan run → anchored draft reply binding (P-011). */
import type postgres from 'postgres';
import { hashPlanContent } from '@papercusp/plan-parser';
import { deriveIndexFromContent } from '../agent-tools/plans/source';
import { writePlanIndexRows } from '../agent-tools/plans/plan-index-rows';
import { ensureExternalTriggerBinding, type CreatedExternalTriggerBinding } from './admin';
import { createGoogleGmailDraft, type GoogleGmailDraftResult } from './google-gmail';
import { resolveGoogleWorkspaceAccessToken } from './google-workspace';
import type { ExternalTriggerSourceRow } from './source-store';

type Db = postgres.Sql | postgres.TransactionSql;

export const GMAIL_RESPOND_DRAFT_HARNESS = 'papercusp';
export const GMAIL_RESPOND_DRAFT_PLAN = 'gmail-respond-with-draft-2026-08-22';
export const GMAIL_RESPOND_DRAFT_EVENT = 'ext:gmail:message.received';

export const GMAIL_RESPOND_DRAFT_PLAN_CONTENT = `---
title: Gmail message — respond with a draft
slug: ${GMAIL_RESPOND_DRAFT_PLAN}
status: ready
created: 2026-08-22
updated: 2026-08-22
---

# Gmail message — respond with a draft

## Now

**State:** Ready built-in template. Each inbound Gmail message creates one isolated event run.

**Next:** Read the trigger inputs, draft a useful response, and save it to the originating Gmail thread.

## Background

The trigger run carries the normalized email under \`plan_run.inputs.trigger.payload\`.
The draft tool accepts only that run's numeric id; it resolves the recipient, thread,
reply headers, and OAuth credential server-side. It creates a Gmail DRAFT and never sends.

## Phase 1 — Draft

- **P-001** \`todo\` Read \`payload.plan_run.inputs.trigger.payload\`, compose a concise response, then call \`gmail:create-draft\` with \`planRunId=payload.plan_run.runId\` and the response text. Complete only after the tool reports \`created:true\` or \`alreadyCreated:true\`.

## Decisions

### D-001 — Draft creation is anchored to a trigger plan run; auto-send stays outside this tool
Date: 2026-08-22
The tool resolves every Gmail coordinate and credential from the durable trigger run. Its public input is only planRunId plus text. It has no send branch; automatic sending is a separate owner-authority dark-flag surface.
`;

export const GMAIL_RESPOND_DRAFT_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['trigger'],
  properties: {
    trigger: {
      type: 'object',
      additionalProperties: true,
      required: ['key', 'source', 'event', 'sourceId', 'externalId', 'dedupeKey', 'payload'],
      properties: {
        key: { const: GMAIL_RESPOND_DRAFT_EVENT },
        source: { const: 'gmail' },
        event: { const: 'message.received' },
        sourceId: { type: 'string', minLength: 1 },
        externalId: { type: 'string', minLength: 1 },
        dedupeKey: { type: 'string', minLength: 1 },
        payload: {
          type: 'object',
          additionalProperties: true,
          required: ['id', 'threadId', 'from', 'subject', 'messageId', 'direction'],
          properties: {
            id: { type: 'string', minLength: 1 },
            threadId: { type: 'string', minLength: 1 },
            from: { type: 'string', minLength: 1 },
            subject: { type: 'string', minLength: 1 },
            messageId: { type: 'string', minLength: 1 },
            direction: { const: 'inbound' },
          },
        },
      },
    },
  },
} as const;

export const GMAIL_RESPOND_DRAFT_EVENT_FILTER = {
  all: [
    { direction: 'inbound' },
    { threadId: { exists: true } },
    { from: { exists: true } },
    { subject: { exists: true } },
    { messageId: { exists: true } },
  ],
} as const;

export interface GmailFlagshipPlanEnsureResult {
  created: boolean;
  schemaAdded: boolean;
}

export async function ensureGmailRespondDraftPlan(
  sql: postgres.Sql,
  workspaceId: string,
): Promise<GmailFlagshipPlanEnsureResult> {
  const idx = deriveIndexFromContent(GMAIL_RESPOND_DRAFT_PLAN_CONTENT);
  const itemsJson = JSON.stringify(idx.items);
  const decisionsJson = JSON.stringify(idx.decisions);
  const inputSchemaJson = JSON.stringify(GMAIL_RESPOND_DRAFT_INPUT_SCHEMA);
  return sql.begin(async (tx) => {
    const lockKey = [workspaceId, GMAIL_RESPOND_DRAFT_HARNESS, GMAIL_RESPOND_DRAFT_PLAN].join(':');
    await tx`SELECT pg_advisory_xact_lock(hashtext('harness_plans'), hashtext(${lockKey}))`;
    const existing = await tx<Array<{ inputSchema: unknown }>>`
      SELECT input_schema AS "inputSchema"
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${GMAIL_RESPOND_DRAFT_HARNESS}
         AND plan_slug = ${GMAIL_RESPOND_DRAFT_PLAN}`;
    if (existing[0]) {
      if (existing[0].inputSchema == null) {
        await tx`
          UPDATE harness_shared.harness_plans
             SET input_schema = ${inputSchemaJson}::text::jsonb,
                 version = version + 1, updated_at = now()
           WHERE workspace_id = ${workspaceId}
             AND harness_slug = ${GMAIL_RESPOND_DRAFT_HARNESS}
             AND plan_slug = ${GMAIL_RESPOND_DRAFT_PLAN}`;
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
        ${workspaceId}, ${GMAIL_RESPOND_DRAFT_HARNESS}, ${GMAIL_RESPOND_DRAFT_PLAN},
        ${idx.title}, ${idx.status}, ${GMAIL_RESPOND_DRAFT_PLAN_CONTENT},
        ${hashPlanContent(GMAIL_RESPOND_DRAFT_PLAN_CONTENT)}, 1,
        ${idx.created}, ${idx.updated}, ${idx.isLegacy}, ${itemsJson}::text::jsonb,
        ${decisionsJson}::text::jsonb, ${idx.nowState}, ${idx.nowNext},
        ${inputSchemaJson}::text::jsonb, 'local'
      )`;
    await writePlanIndexRows(
      tx as unknown as Parameters<typeof writePlanIndexRows>[0],
      {
        workspaceId,
        harnessSlug: GMAIL_RESPOND_DRAFT_HARNESS,
        planSlug: GMAIL_RESPOND_DRAFT_PLAN,
      },
      idx,
    );
    return { created: true, schemaAdded: true };
  });
}

export interface GmailFlagshipBindingResult {
  plan: GmailFlagshipPlanEnsureResult;
  binding: CreatedExternalTriggerBinding;
}

/** Install the built-in template and one reconnect-idempotent, disarmed inbound binding. */
export async function ensureGmailRespondDraftBinding(
  sql: postgres.Sql,
  workspaceId: string,
  source: ExternalTriggerSourceRow,
  createdBy?: string | null,
  deps: {
    ensurePlan?: typeof ensureGmailRespondDraftPlan;
    ensureBinding?: typeof ensureExternalTriggerBinding;
  } = {},
): Promise<GmailFlagshipBindingResult> {
  if (source.workspaceId !== workspaceId || source.kind !== 'gmail') {
    throw new Error('gmail_flagship_source_invalid');
  }
  const plan = await (deps.ensurePlan ?? ensureGmailRespondDraftPlan)(sql, workspaceId);
  const binding = await (deps.ensureBinding ?? ensureExternalTriggerBinding)(sql, workspaceId, {
    sourceId: source.id,
    planHarnessSlug: GMAIL_RESPOND_DRAFT_HARNESS,
    planSlug: GMAIL_RESPOND_DRAFT_PLAN,
    eventPattern: GMAIL_RESPOND_DRAFT_EVENT,
    eventFilter: GMAIL_RESPOND_DRAFT_EVENT_FILTER,
    createdBy,
  });
  return { plan, binding };
}

interface GmailDraftTriggerRow {
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

export interface GmailPlanDraftResponseResult extends GoogleGmailDraftResult {
  created: boolean;
  alreadyCreated: boolean;
  to: string;
  subject: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function replySubject(subject: string): string {
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** Resolve the originating email from a durable run and create exactly one draft reply. */
export async function draftResponseToGmailTriggerPlanRun(
  sql: Db,
  workspaceId: string,
  planRunId: number,
  responseText: string,
  deps: {
    resolveAccessToken?: typeof resolveGoogleWorkspaceAccessToken;
    createDraft?: typeof createGoogleGmailDraft;
    fetch?: typeof fetch;
    apiOrigin?: string;
    now?: () => Date;
  } = {},
): Promise<GmailPlanDraftResponseResult> {
  if (!Number.isSafeInteger(planRunId) || planRunId <= 0) throw new Error('gmail_draft_plan_run_id_invalid');
  const text = responseText.trim();
  if (!text || text.length > 100_000) throw new Error('gmail_draft_text_invalid');
  const draftInTransaction = async (tx: Db): Promise<GmailPlanDraftResponseResult> => {
    const rows = await tx<GmailDraftTriggerRow[]>`
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
         AND s.kind = 'gmail'
       ORDER BY tr.completed_at DESC NULLS LAST, tr.id
       LIMIT 1
       FOR UPDATE OF tr`;
    const row = rows[0];
    if (!row) throw new Error(`gmail_draft_trigger_run_not_found:${planRunId}`);
    const priorDraft = object(object(row.outcome).gmailDraft);
    const priorDraftId = string(priorDraft.draftId);
    if (priorDraftId) {
      return {
        created: false,
        alreadyCreated: true,
        draftId: priorDraftId,
        messageId: string(priorDraft.messageId),
        threadId: string(priorDraft.threadId),
        to: string(priorDraft.to),
        subject: string(priorDraft.subject),
      };
    }
    const payload = object(object(row.args.trigger).payload);
    if (string(payload.direction) !== 'inbound') throw new Error('gmail_draft_trigger_not_inbound');
    const to = string(payload.from);
    const subject = replySubject(string(payload.subject));
    const threadId = string(payload.threadId);
    const inReplyTo = string(payload.messageId);
    if (!to || !subject || !threadId || !inReplyTo) throw new Error('gmail_draft_trigger_coordinates_missing');
    const source: ExternalTriggerSourceRow = {
      id: row.sourceId,
      workspaceId,
      kind: 'gmail',
      ownerUserId: row.ownerUserId,
      credentialRef: row.credentialRef,
      status: row.sourceStatus,
      config: row.sourceConfig,
      cursor: row.sourceCursor,
    };
    const installSlug = string(source.config.installSlug) || GMAIL_RESPOND_DRAFT_HARNESS;
    const token = await (deps.resolveAccessToken ?? resolveGoogleWorkspaceAccessToken)(source, installSlug);
    const created = await (deps.createDraft ?? createGoogleGmailDraft)(
      token,
      {
        to,
        subject,
        text,
        threadId,
        inReplyTo,
        references: string(payload.references) || null,
      },
      { fetch: deps.fetch, apiOrigin: deps.apiOrigin },
    );
    const outcome = {
      ...object(row.outcome),
      gmailDraft: {
        ...created,
        to,
        subject,
        draftedAt: (deps.now ?? (() => new Date()))().toISOString(),
      },
    };
    await tx`
      UPDATE harness_shared.trigger_runs
         SET outcome = ${JSON.stringify(outcome)}::text::jsonb, updated_at = now()
       WHERE workspace_id = ${workspaceId} AND id = ${row.id}::uuid`;
    return { created: true, alreadyCreated: false, ...created, to, subject };
  };
  return 'begin' in sql ? sql.begin(draftInTransaction) : draftInTransaction(sql);
}
