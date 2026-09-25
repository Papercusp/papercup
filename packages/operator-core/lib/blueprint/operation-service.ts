/** Shared, internal blueprint operation service. Public defineTool registrations
 * are deliberately separate; every transport uses this service and its handles. */
import type { JSONValue, Sql } from 'postgres';
import type { TransactionSql } from 'postgres';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { operationFromSpecification } from '@papercusp/orchestrator/blueprint';
import { normalizeModelId } from '@papercusp/model-pricing';
import { readAcceptedBlueprintDirectWorkItem } from './operation-admission';
import { checkAgainstJsonSchema } from '../json-schema-validation';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { getWorkItem, type WorkItem } from '../work-items';
import { isSettledWorkItem } from '../work-items-events';
import { runWithWorkspace } from '../workspace-als';
import {
  acceptBlueprintDirectWorkItem,
  acceptBlueprintPlanRun,
} from './operation-admission';
import { readBlueprintHashFromPg, readBlueprintSpecificationSnapshot } from './project-to-pg';

const OperationHandleSchema = z.object({
  workspaceId: z.string().min(1),
  harnessSlug: z.string().min(1),
  receiptId: z.number().int().positive(),
  operationId: z.string().min(1),
  specificationRevision: z.string().regex(/^[0-9a-f]{64}$/),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('work-item'), id: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('plan'), runId: z.number().int().positive(), instanceSlug: z.string().min(1) }).strict(),
  ]),
}).strict();

export type BlueprintOperationHandle = z.infer<typeof OperationHandleSchema>;

export interface SubmitBlueprintOperationInput {
  workspaceId: string;
  harnessSlug: string;
  callerId: string;
  operationId: string;
  requestKey: string;
  input: Record<string, unknown>;
  title?: string;
  summary?: string;
}

type InvocationRow = {
  id: string | number;
  caller_id: string;
  operation_id: string;
  specification_revision: string;
  target_kind: 'work-item' | 'plan';
  target_ref: string | null;
};

type PlanRunRow = {
  id: string | number;
  instance_plan_slug: string | null;
  status: string;
  outcome: string | null;
  outputs: unknown | null;
};

function checkedReceiptId(value: string | number): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('invalid blueprint operation receipt id');
  return id;
}

/** The receipt pins the operation target on replay, even if the mutable
 * blueprint pointer has since moved to a different revision or target. */
export function submitBlueprintOperation(sql: Sql, input: SubmitBlueprintOperationInput): Promise<BlueprintOperationHandle> {
  return runWithWorkspace(input.workspaceId, async () => {
    const callerId = input.callerId?.trim();
    const requestKey = input.requestKey?.trim();
    if (!input.workspaceId?.trim() || !input.harnessSlug?.trim() || !input.operationId?.trim() ||
        !callerId || callerId.length > 200 || !requestKey || requestKey.length > 200) {
      throw new Error('blueprint submission requires workspace, harness, operation, authenticated caller and request key');
    }
    const previous = await sql<InvocationRow[]>`
      SELECT id, caller_id, operation_id, specification_revision, target_kind, target_ref
        FROM harness_shared.blueprint_operation_invocations
       WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
         AND caller_id = ${callerId} AND operation_id = ${input.operationId}
         AND request_key = ${requestKey}
    `;
    const revision = previous[0]?.specification_revision ??
      await readBlueprintHashFromPg(sql, input.workspaceId, input.harnessSlug);
    if (!revision) throw new Error('blueprint operation has no projected specification');
    const specification = await readBlueprintSpecificationSnapshot(sql, input.workspaceId, input.harnessSlug, revision);
    if (!specification) throw new Error('blueprint operation specification snapshot is missing');
    const { operation } = operationFromSpecification(specification, input.operationId);
    const targetKind = previous[0]?.target_kind ?? operation.target.kind;
    if (targetKind !== operation.target.kind) throw new Error('blueprint operation receipt and pinned target disagree');

    let target: BlueprintOperationHandle['target'];
    if (targetKind === 'work-item') {
      const item = await acceptBlueprintDirectWorkItem(sql, {
        workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
        callerId, requestKey, operationId: input.operationId, input: input.input,
        title: input.title?.trim() || operation.description?.trim() || operation.id,
        summary: input.summary,
        createdBy: callerId,
      });
      target = { kind: 'work-item', id: item.id };
    } else {
      const run = await acceptBlueprintPlanRun(sql, {
        workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
        callerId, requestKey, operationId: input.operationId, input: input.input,
      });
      target = { kind: 'plan', runId: run.runId, instanceSlug: run.instanceSlug };
    }
    const receipts = await sql<InvocationRow[]>`
      SELECT id, caller_id, operation_id, specification_revision, target_kind, target_ref
        FROM harness_shared.blueprint_operation_invocations
       WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
         AND caller_id = ${callerId} AND operation_id = ${input.operationId}
         AND request_key = ${requestKey}
    `;
    const receipt = receipts[0];
    if (!receipt || receipt.target_kind !== target.kind ||
        receipt.target_ref !== (target.kind === 'plan' ? target.instanceSlug : target.id)) {
      throw new Error('blueprint operation was accepted without a matching durable receipt');
    }
    return OperationHandleSchema.parse({
      workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
      receiptId: checkedReceiptId(receipt.id), operationId: input.operationId,
      specificationRevision: receipt.specification_revision, target,
    });
  });
}

export type BlueprintOperationPhase = 'accepted' | 'dispatched' | 'waiting' | 'terminal';
export type BlueprintOperationOutcome = 'succeeded' | 'unverified' | 'failed' | 'cancelled' | 'dropped';
export interface BlueprintOperationStatus {
  handle: BlueprintOperationHandle;
  phase: BlueprintOperationPhase;
  outcome: BlueprintOperationOutcome | null;
  items: Array<{ id: string; state: string; assignee: string | null }>;
  planRun: { status: string; outcome: string | null } | null;
  cancellationRequested: boolean;
  wait: { name: string; token: string } | null;
}

interface OperationControls {
  cancellationRequested: boolean;
  wait: { name: string; token: string } | null;
}

function cancellationRequested(item: WorkItem): boolean {
  return Boolean(item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload) &&
    (item.payload as Record<string, unknown>).blueprintCancellation);
}

/** Classify only canonical lifecycle state. An accepted receipt is never a
 * completed result, and an assigned item is not proof of a started executor. */
export function projectBlueprintOperationStatus(
  handle: BlueprintOperationHandle,
  items: WorkItem[],
  planRun: Pick<PlanRunRow, 'status' | 'outcome'> | null = null,
  controls: OperationControls = { cancellationRequested: false, wait: null },
): BlueprintOperationStatus {
  const allSettled = items.length > 0 && items.every(isSettledWorkItem);
  const cancelling = controls.cancellationRequested || items.some(cancellationRequested);
  let outcome: BlueprintOperationOutcome | null = null;
  if (allSettled) {
    const dropped = (item: WorkItem) => item.state === 'dropped' || item.state === 'deprecated' || item.state === 'closed';
    const succeeded = (item: WorkItem) => item.state === 'done' || item.state === 'passed' || item.state === 'resolved';
    if (cancelling && items.every(dropped)) outcome = 'cancelled';
    else if (items.some(dropped)) outcome = 'dropped';
    else if (items.every(succeeded)) {
      outcome = items.every((item) => item.completionAuthority === 'committed' || item.completionAuthority === 'validated')
        ? 'succeeded' : 'unverified';
    }
    else outcome = 'failed';
  } else if (planRun?.outcome) {
    if (planRun.outcome === 'success' && items.length === 0) outcome = 'succeeded';
    else if (planRun.outcome === 'skipped') outcome = 'dropped';
    else if (['failed', 'partial', 'timed-out'].includes(planRun.outcome)) outcome = 'failed';
  }
  const phase: BlueprintOperationPhase = outcome ? 'terminal' :
    controls.wait ? 'waiting' :
    items.some((item) => item.state === 'blocked' || item.state === 'needs-human') ? 'waiting' :
    items.some((item) => item.assignee !== null || item.state === 'wip' || item.state === 'in-progress') ? 'dispatched' :
    'accepted';
  return {
    handle, phase, outcome,
    items: items.map((item) => ({ id: item.id, state: item.state, assignee: item.assignee })),
    planRun: planRun ? { status: planRun.status, outcome: planRun.outcome } : null,
    cancellationRequested: cancelling,
    wait: outcome ? null : controls.wait,
  };
}

async function readOperationControls(sql: Sql | TransactionSql, handle: BlueprintOperationHandle): Promise<OperationControls> {
  const writerKey = `receipt:${handle.receiptId}`;
  const rows = await sql<Array<{ cancel_requested: boolean; wait_body: unknown }>>`
    SELECT
      EXISTS(
        SELECT 1 FROM harness_shared.coord_event_log
         WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
           AND msg_id = ${eventIdentity('cancel', handle, 'once')}
      ) AS cancel_requested,
      (
        SELECT w.body FROM harness_shared.coord_event_log AS w
         WHERE w.workspace_id = ${handle.workspaceId} AND w.surface = 'blueprint-operation'
           AND w.writer_key = ${writerKey} AND w.body->>'kind' = 'wait'
           AND NOT EXISTS (
             SELECT 1 FROM harness_shared.coord_event_log AS r
              WHERE r.workspace_id = w.workspace_id AND r.surface = w.surface
                AND r.writer_key = w.writer_key AND r.body->>'kind' = 'resume'
                AND r.body->>'token' = w.body->>'token'
           )
         ORDER BY w.id DESC LIMIT 1
      ) AS wait_body
  `;
  const raw = rows[0]?.wait_body;
  const wait = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  return {
    cancellationRequested: Boolean(rows[0]?.cancel_requested),
    wait: wait && typeof wait.waitName === 'string' && typeof wait.token === 'string'
      ? { name: wait.waitName, token: wait.token } : null,
  };
}

async function readCanonicalOperation(sql: Sql, handle: BlueprintOperationHandle, callerId: string): Promise<{
  status: BlueprintOperationStatus;
  items: WorkItem[];
  run: PlanRunRow | null;
}> {
  const ref = OperationHandleSchema.parse(handle);
  const receipts = await sql<InvocationRow[]>`
    SELECT id, caller_id, operation_id, specification_revision, target_kind, target_ref
      FROM harness_shared.blueprint_operation_invocations
     WHERE id = ${ref.receiptId} AND workspace_id = ${ref.workspaceId}
       AND harness_slug = ${ref.harnessSlug}
  `;
  const receipt = receipts[0];
  if (!receipt || receipt.caller_id !== callerId.trim() || receipt.operation_id !== ref.operationId ||
      receipt.specification_revision !== ref.specificationRevision ||
      receipt.target_kind !== ref.target.kind ||
      receipt.target_ref !== (ref.target.kind === 'plan' ? ref.target.instanceSlug : ref.target.id)) {
    throw new Error('blueprint operation handle does not match its durable receipt');
  }
  const controls = await readOperationControls(sql, ref);
  if (ref.target.kind === 'work-item') {
    const item = await getWorkItem(ref.target.id, ref.harnessSlug);
    if (!item || item.harness !== ref.harnessSlug) throw new Error('blueprint operation work item is missing or outside its harness');
    const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? item.payload as Record<string, unknown> : null;
    const pin = payload?.blueprintOperation && typeof payload.blueprintOperation === 'object' &&
      !Array.isArray(payload.blueprintOperation) ? payload.blueprintOperation as Record<string, unknown> : null;
    if (!pin || pin.kind !== 'blueprint-operation' || pin.operationId !== ref.operationId ||
        pin.specificationRevision !== ref.specificationRevision || pin.callerId !== callerId.trim()) {
      throw new Error('blueprint operation receipt and canonical work item pin disagree');
    }
    return { status: projectBlueprintOperationStatus(ref, [item], null, controls), items: [item], run: null };
  }
  const runs = await sql<PlanRunRow[]>`
    SELECT id, instance_plan_slug, status, outcome, outputs
      FROM harness_shared.plan_runs
     WHERE id = ${ref.target.runId} AND workspace_id = ${ref.workspaceId}
       AND harness_slug = ${ref.harnessSlug} AND instance_plan_slug = ${ref.target.instanceSlug}
  `;
  const run = runs[0];
  if (!run) throw new Error('blueprint operation plan run is missing or outside its harness');
  const rows = await sql<Array<{ feature_id: string; harness_slug: string }>>`
    SELECT feature_id, harness_slug FROM harness_shared.work_items
     WHERE workspace_id = ${ref.workspaceId}
       AND payload->'plan_run'->>'runId' = ${String(ref.target.runId)}
       AND payload->'plan_run'->>'instancePlanSlug' = ${ref.target.instanceSlug}
     ORDER BY feature_id
  `;
  const items = await Promise.all(rows.map(async ({ feature_id, harness_slug }) => {
    const item = await getWorkItem(feature_id, harness_slug);
    if (!item || item.harness !== harness_slug) throw new Error('blueprint plan run item disappeared');
    return item;
  }));
  return { status: projectBlueprintOperationStatus(ref, items, run, controls), items, run };
}

export function getBlueprintOperationStatus(sql: Sql, handle: BlueprintOperationHandle, callerId: string): Promise<BlueprintOperationStatus> {
  return runWithWorkspace(handle.workspaceId, async () => (await readCanonicalOperation(sql, handle, callerId)).status);
}

const OperationEventBodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('work-item'), workItemId: z.string().min(1),
    runId: z.string().nullable(), harnessSlug: z.string().min(1),
    state: z.string().min(1), prevState: z.string().nullable(),
    assignee: z.string().nullable(), outputStored: z.boolean(),
    cancellationRequested: z.boolean(),
  }),
  z.object({
    kind: z.literal('plan-run'), runId: z.string().min(1),
    instanceSlug: z.string().min(1), harnessSlug: z.string().min(1),
    status: z.string().min(1), prevStatus: z.string().nullable(),
    outcome: z.string().nullable(), outputStored: z.boolean(),
  }),
  z.object({
    kind: z.literal('cancel'), receiptId: z.number().int().positive(),
    workItemId: z.string().nullable(), runId: z.string().nullable(),
    requestedBy: z.string().min(1), reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal('signal'), receiptId: z.number().int().positive(),
    workItemId: z.string().nullable(), runId: z.string().nullable(),
    channel: z.string().min(1), payload: z.unknown(),
  }),
  z.object({
    kind: z.literal('wait'), receiptId: z.number().int().positive(),
    workItemId: z.string().nullable(), runId: z.string().nullable(),
    waitName: z.string().min(1), token: z.string().min(1),
  }),
  z.object({
    kind: z.literal('resume'), receiptId: z.number().int().positive(),
    workItemId: z.string().nullable(), runId: z.string().nullable(),
    waitName: z.string().min(1), token: z.string().min(1), response: z.unknown(),
  }),
]);

export type BlueprintOperationEvent = z.infer<typeof OperationEventBodySchema> & {
  cursor: string;
  at: string;
};

/** Cursor replay reads the existing append-only coord event log, while the
 * snapshot comes from the canonical target. A reconnect always receives the
 * latest outcome even if it started before this event writer was installed. */
export function getBlueprintOperationEvents(
  sql: Sql,
  handle: BlueprintOperationHandle,
  callerId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<{ status: BlueprintOperationStatus; events: BlueprintOperationEvent[]; cursor: string; hasMore: boolean }> {
  return runWithWorkspace(handle.workspaceId, async () => {
    const cursor = options.cursor ?? '0';
    if (!/^(0|[1-9][0-9]*)$/.test(cursor)) throw new Error('blueprint operation cursor must be a decimal event id');
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const { status } = await readCanonicalOperation(sql, handle, callerId);
    const rows = handle.target.kind === 'work-item'
      ? await sql<Array<{ id: string | number; ts: Date | string; body: unknown }>>`
          SELECT id, ts, body FROM harness_shared.coord_event_log
           WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
             AND body->>'workItemId' = ${handle.target.id} AND id > ${cursor}::bigint
           ORDER BY id LIMIT ${limit + 1}
        `
      : await sql<Array<{ id: string | number; ts: Date | string; body: unknown }>>`
          SELECT id, ts, body FROM harness_shared.coord_event_log
           WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
             AND body->>'runId' = ${String(handle.target.runId)} AND id > ${cursor}::bigint
           ORDER BY id LIMIT ${limit + 1}
        `;
    const page = rows.slice(0, limit);
    const events = page.map((row) => ({
      ...OperationEventBodySchema.parse(row.body),
      cursor: String(row.id), at: new Date(row.ts).toISOString(),
    }));
    return { status, events, cursor: events.at(-1)?.cursor ?? cursor, hasMore: rows.length > limit };
  });
}

function targetEventFields(handle: BlueprintOperationHandle): { workItemId: string | null; runId: string | null } {
  return handle.target.kind === 'work-item'
    ? { workItemId: handle.target.id, runId: null }
    : { workItemId: null, runId: String(handle.target.runId) };
}

function eventIdentity(kind: string, handle: BlueprintOperationHandle, key: string): string {
  return kind + ':' + createHash('sha256').update(canonicalJson({ receiptId: handle.receiptId, key })).digest('hex');
}

function exactJsonValue(value: unknown, kind: 'input' | 'output' = 'input'): unknown {
  let saved: unknown;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('not JSON');
    saved = JSON.parse(encoded);
  } catch {
    throw new Error(`blueprint operation ${kind} must be lossless JSON`);
  }
  if (!isDeepStrictEqual(saved, value)) throw new Error(`blueprint operation ${kind} must be lossless JSON`);
  return saved;
}

async function appendControlEvent(
  sql: Sql | TransactionSql,
  handle: BlueprintOperationHandle,
  msgId: string,
  body: Record<string, unknown>,
): Promise<{ id: string; replayed: boolean }> {
  const fingerprint = createHash('sha256').update(canonicalJson(body)).digest('hex');
  const saved = JSON.stringify({ ...body, fingerprint });
  const inserted = await sql<Array<{ id: string | number }>>`
    INSERT INTO harness_shared.coord_event_log
      (workspace_id, surface, writer_key, msg_id, body)
    VALUES (${handle.workspaceId}, 'blueprint-operation', ${`receipt:${handle.receiptId}`},
            ${msgId}, ${saved}::text::jsonb)
    ON CONFLICT DO NOTHING RETURNING id
  `;
  if (inserted[0]) return { id: String(inserted[0].id), replayed: false };
  const prior = await sql<Array<{ id: string | number; body: Record<string, unknown> }>>`
    SELECT id, body FROM harness_shared.coord_event_log
     WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
       AND msg_id = ${msgId}
  `;
  if (!prior[0] || prior[0].body.fingerprint !== fingerprint) {
    throw new Error('blueprint operation control key was reused with different input');
  }
  return { id: String(prior[0].id), replayed: true };
}

async function declaredOperation(sql: Sql, handle: BlueprintOperationHandle) {
  const specification = await readBlueprintSpecificationSnapshot(
    sql, handle.workspaceId, handle.harnessSlug, handle.specificationRevision,
  );
  if (!specification) throw new Error('blueprint operation specification snapshot is missing');
  return operationFromSpecification(specification, handle.operationId).operation;
}

async function notifyControl(key: string, eventId: string, payload: unknown): Promise<boolean> {
  try {
    const { emitAwaitedEvent } = await import('../events/await/engine');
    await emitAwaitedEvent({ key, source: 'blueprint-operation', summary: `Blueprint operation input ${eventId}`, payload });
    return true;
  } catch {
    // The input is committed to the append-only log. A worker must replay it
    // from its cursor; a wake notification alone is never delivery proof.
    return false;
  }
}

export interface BlueprintOperationInputReceipt {
  eventId: string;
  replayed: boolean;
  accepted: true;
  wakeQueued: boolean;
  handled: false;
}

/** Cancellation is an append-only request plus a marker on each canonical
 * unfinished item. It never pretends to have fenced a running attempt. */
export function cancelBlueprintOperation(
  sql: Sql, handle: BlueprintOperationHandle, callerId: string,
  input: { requestKey: string; reason: string },
): Promise<BlueprintOperationInputReceipt & { effected: boolean }> {
  return runWithWorkspace(handle.workspaceId, async (): Promise<BlueprintOperationInputReceipt & { effected: boolean }> => {
    const { status, items } = await readCanonicalOperation(sql, handle, callerId);
    if (!input.requestKey?.trim() || !input.reason?.trim()) throw new Error('blueprint cancellation requires a key and reason');
    if (status.phase === 'terminal' && !status.cancellationRequested) {
      throw new Error('cannot cancel a terminal blueprint operation');
    }
    const body = { kind: 'cancel', receiptId: handle.receiptId, ...targetEventFields(handle),
      requestedBy: callerId, requestKey: input.requestKey, reason: input.reason.trim() };
    const receipt = await sql.begin(async (tx) => {
      const saved = await appendControlEvent(tx, handle, eventIdentity('cancel', handle, 'once'), body);
      const marker = JSON.stringify({ eventId: saved.id, requestedBy: callerId, reason: input.reason.trim() });
      for (const item of items) {
        if (isSettledWorkItem(item)) continue;
        await tx`
          UPDATE harness_shared.work_items
             SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{blueprintCancellation}',
                                     ${marker}::text::jsonb, true)
           WHERE workspace_id = ${handle.workspaceId} AND harness_slug = ${item.harness}
             AND feature_id = ${item.id} AND status NOT IN ('passed', 'deprecated', 'resolved', 'closed')
        `;
      }
      return saved;
    });
    const current = await readCanonicalOperation(sql, handle, callerId);
    const effected = current.status.outcome === 'cancelled';
    const wakeQueued = current.status.phase === 'terminal' ? false : await notifyControl(
      `blueprint-operation:cancel:${handle.receiptId}`, receipt.id, body,
    );
    return { eventId: receipt.id, replayed: receipt.replayed, accepted: true,
      wakeQueued, handled: false, effected };
  });
}

/** A signal is durably accepted and wakes interested workers. Handling is a
 * separate worker acknowledgement; the receipt never calls a wake a result. */
export function signalBlueprintOperation(
  sql: Sql, handle: BlueprintOperationHandle, callerId: string,
  input: { channel: string; payload: unknown; requestKey: string },
): Promise<BlueprintOperationInputReceipt> {
  return runWithWorkspace(handle.workspaceId, async (): Promise<BlueprintOperationInputReceipt> => {
    const { status } = await readCanonicalOperation(sql, handle, callerId);
    if (!input.requestKey?.trim()) throw new Error('blueprint signal requires a request key');
    const operation = await declaredOperation(sql, handle);
    const schema = operation.signals[input.channel]?.payloadSchema;
    if (!schema) throw new Error('blueprint operation signal channel is not declared');
    const payload = exactJsonValue(input.payload);
    const valid = checkAgainstJsonSchema(schema, payload);
    if (!valid.ok) throw new Error(`blueprint signal payload is invalid: ${valid.errors.join('; ')}`);
    const body = { kind: 'signal', receiptId: handle.receiptId, ...targetEventFields(handle),
      channel: input.channel, payload, requestKey: input.requestKey };
    const msgId = eventIdentity('signal', handle, `${input.channel}:${input.requestKey}`);
    if (status.phase === 'terminal') {
      const prior = await sql<Array<{ id: string | number }>>`
        SELECT id FROM harness_shared.coord_event_log
         WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation' AND msg_id = ${msgId}
      `;
      if (!prior[0]) throw new Error('cannot signal a terminal blueprint operation');
    }
    const receipt = await appendControlEvent(sql, handle, msgId, body);
    const wakeQueued = status.phase === 'terminal' ? false : await notifyControl(
      `blueprint-operation:signal:${handle.receiptId}:${input.channel}`, receipt.id, body,
    );
    return { eventId: receipt.id, replayed: receipt.replayed, accepted: true, wakeQueued, handled: false };
  });
}

/** The trusted executor declares a stable wait token before suspending. A
 * response is accepted only for that exact outstanding token. */
export function openBlueprintOperationWait(
  sql: Sql, handle: BlueprintOperationHandle, callerId: string,
  input: { waitName: string; token: string },
): Promise<{ eventId: string; replayed: boolean }> {
  return runWithWorkspace(handle.workspaceId, async () => {
    const { status } = await readCanonicalOperation(sql, handle, callerId);
    if (status.phase === 'terminal') throw new Error('cannot open a wait on a terminal blueprint operation');
    if (!input.token?.trim()) throw new Error('blueprint wait token is required');
    const operation = await declaredOperation(sql, handle);
    if (!operation.waits[input.waitName]) throw new Error('blueprint operation wait is not declared');
    const body = { kind: 'wait', receiptId: handle.receiptId, ...targetEventFields(handle),
      waitName: input.waitName, token: input.token };
    const receipt = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`blueprint-wait:${handle.workspaceId}:${handle.receiptId}`}, 0))`;
      const current = await readOperationControls(tx, handle);
      if (current.wait && current.wait.token !== input.token) {
        throw new Error('blueprint operation already has a different outstanding wait');
      }
      const responses = await tx<Array<{ id: string | number }>>`
        SELECT id FROM harness_shared.coord_event_log
         WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
           AND msg_id = ${eventIdentity('resume', handle, input.token)}
      `;
      if (responses[0]) throw new Error('blueprint operation wait token was already resumed');
      return appendControlEvent(tx, handle, eventIdentity('wait', handle, input.token), body);
    });
    return { eventId: receipt.id, replayed: receipt.replayed };
  });
}

export function resumeBlueprintOperation(
  sql: Sql, handle: BlueprintOperationHandle, callerId: string,
  input: { token: string; response: unknown; requestKey: string },
): Promise<BlueprintOperationInputReceipt> {
  return runWithWorkspace(handle.workspaceId, async (): Promise<BlueprintOperationInputReceipt> => {
    const { status } = await readCanonicalOperation(sql, handle, callerId);
    if (!input.token?.trim() || !input.requestKey?.trim()) throw new Error('blueprint resume requires a wait token and request key');
    const waits = await sql<Array<{ body: Record<string, unknown> }>>`
      SELECT body FROM harness_shared.coord_event_log
       WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
         AND msg_id = ${eventIdentity('wait', handle, input.token)}
    `;
    const waitName = waits[0]?.body.waitName;
    if (waits[0]?.body.receiptId !== handle.receiptId || typeof waitName !== 'string') {
      throw new Error('blueprint operation wait token is stale or outside this operation');
    }
    const prior = await sql<Array<{ id: string | number }>>`
      SELECT id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
         AND msg_id = ${eventIdentity('resume', handle, input.token)}
    `;
    if ((!status.wait || status.wait.token !== input.token || status.phase === 'terminal') && !prior[0]) {
      throw new Error('blueprint operation wait token is no longer outstanding');
    }
    const operation = await declaredOperation(sql, handle);
    const schema = operation.waits[waitName]?.responseSchema;
    if (!schema) throw new Error('blueprint operation wait is no longer declared');
    const response = exactJsonValue(input.response);
    const valid = checkAgainstJsonSchema(schema, response);
    if (!valid.ok) throw new Error(`blueprint resume response is invalid: ${valid.errors.join('; ')}`);
    const body = { kind: 'resume', receiptId: handle.receiptId, ...targetEventFields(handle),
      waitName, token: input.token, response, requestKey: input.requestKey };
    const receipt = await appendControlEvent(sql, handle, eventIdentity('resume', handle, input.token), body);
    const wakeQueued = status.phase === 'terminal' ? false :
      await notifyControl(`blueprint-operation:resume:${handle.receiptId}:${input.token}`, receipt.id, body);
    return { eventId: receipt.id, replayed: receipt.replayed, accepted: true, wakeQueued, handled: false };
  });
}

export type BlueprintOperationResult =
  | { state: 'pending'; status: BlueprintOperationStatus }
  | { state: 'failed' | 'cancelled' | 'dropped' | 'unavailable'; status: BlueprintOperationStatus; reason: string }
  | { state: 'ready'; status: BlueprintOperationStatus; output: unknown; evidenceRef: string };

/** A launch selector or a requested model cannot prove what served a turn.
 * Read only transcript request observations from the session whose launch
 * receipt carries this exact accepted item pin. Other backends need their own
 * independently reported model seam before they can satisfy this policy. */
async function verifyDirectOperationModel(
  sql: Sql,
  workspaceId: string,
  workItemId: string,
  pin: Record<string, unknown>,
  policy: { mode: 'exact' | 'allowed' | 'preferred'; models: readonly string[]; effort?: string },
): Promise<string | null> {
  if (policy.effort) return 'actual reasoning effort is not attested by the worker transcript';
  const rows = await sql<Array<{
    agent: string | null; model: string | null; provider: string | null;
    model_source: string | null; grain: string | null;
  }>>`
    SELECT s.agent, u.model, u.provider,
           u.usage_provenance->>'modelSource' AS model_source,
           u.usage_provenance->>'grain' AS grain
      FROM harness_shared.adv_sessions s
      LEFT JOIN harness_shared.agent_usage_samples u
        ON u.workspace_id = s.workspace_id AND u.session_id = s.session_id
       AND u.source = 'interactive'
     WHERE s.workspace_id = ${workspaceId}
       AND s.feature = ${workItemId}
       AND s.launch_spec->'acceptedOperation'->'pin' = ${sql.json(pin as JSONValue)}
     ORDER BY s.id, u.id
     LIMIT 1001
  `;
  if (!rows.length) return 'no accepted worker session reported an actual model';
  if (rows.length > 1000) return 'model evidence exceeds the bounded verification window';
  const allowed = new Set(policy.models.map(normalizeModelId));
  for (const row of rows) {
    if (row.agent !== 'claude' || row.provider !== 'anthropic' ||
        row.model_source !== 'transcript' || row.grain !== 'request' || !row.model) {
      return 'accepted worker has an unreported or unsupported actual model';
    }
    if (!allowed.has(normalizeModelId(row.model))) {
      return `accepted worker reported a model outside the ${policy.mode} policy`;
    }
  }
  return null;
}

/** Prepare the result before a successful terminal state write. The state
 * writer merges this receipt with completion evidence in the same transaction;
 * a missing or incompatible actual model cannot become a successful close. */
export async function prepareDirectOperationCompletion(
  sql: Sql,
  workspaceId: string,
  item: WorkItem,
  outputPayload: unknown,
): Promise<{ operationId: string; specificationRevision: string; output: unknown; evidenceRef: string }> {
  if (!item.harness) throw new Error('blueprint operation completion requires a harness');
  const { pin, operation } = await readAcceptedBlueprintDirectWorkItem(sql, workspaceId, item);
  if (pin.harnessSlug !== item.harness) throw new Error('blueprint operation completion harness differs from its pin');
  if (outputPayload === undefined) throw new Error('blueprint operation completion requires outputPayload');
  const output = exactJsonValue(outputPayload, 'output');
  const valid = checkAgainstJsonSchema(operation.acceptance.resultSchema, output);
  if (!valid.ok) throw new Error(`blueprint operation output is invalid: ${valid.errors.join('; ')}`);
  if (operation.policy.model) {
    const modelFailure = await verifyDirectOperationModel(
      sql, workspaceId, item.id, pin as Record<string, unknown>, operation.policy.model,
    );
    if (modelFailure) throw new Error(`blueprint operation model attestation failed: ${modelFailure}`);
  }
  return {
    operationId: pin.operationId,
    specificationRevision: pin.specificationRevision,
    output,
    evidenceRef: `work-item:completion:${item.id}`,
  };
}

/** Read a typed output from the canonical target only. P-008 owns the write-side
 * completion validator; a terminal row without validated output is explicit. */
export function getBlueprintOperationResult(sql: Sql, handle: BlueprintOperationHandle, callerId: string): Promise<BlueprintOperationResult> {
  return runWithWorkspace(handle.workspaceId, async (): Promise<BlueprintOperationResult> => {
    const { status, items, run } = await readCanonicalOperation(sql, handle, callerId);
    if (status.phase !== 'terminal') return { state: 'pending', status };
    if (status.outcome !== 'succeeded') {
      return { state: status.outcome === 'unverified' ? 'unavailable' : (status.outcome ?? 'failed'),
        status, reason: 'canonical target settled without a validated successful result' };
    }
    if (handle.target.kind === 'work-item' &&
        items[0]?.completionAuthority !== 'committed' && items[0]?.completionAuthority !== 'validated') {
      return { state: 'unavailable', status, reason: 'canonical completion has no validated authority for its operation output' };
    }
    const specification = await readBlueprintSpecificationSnapshot(
      sql, handle.workspaceId, handle.harnessSlug, handle.specificationRevision,
    );
    if (!specification) throw new Error('blueprint operation specification snapshot is missing');
    const { operation } = operationFromSpecification(specification, handle.operationId);
    if (operation.policy.model) {
      const pin = handle.target.kind === 'work-item' && items[0]?.payload &&
        typeof items[0].payload === 'object' && !Array.isArray(items[0].payload)
        ? (items[0].payload as Record<string, unknown>).blueprintOperation : null;
      if (!pin || typeof pin !== 'object' || Array.isArray(pin) ||
          handle.target.kind !== 'work-item' || operation.execution?.kind !== 'agent') {
        return { state: 'unavailable', status, reason: 'model policy has no attested agent worker result' };
      }
      const modelFailure = await verifyDirectOperationModel(
        sql, handle.workspaceId, handle.target.id, pin as Record<string, unknown>, operation.policy.model,
      );
      if (modelFailure) return { state: 'unavailable', status, reason: modelFailure };
    }
    const raw = handle.target.kind === 'plan' ? run?.outputs :
      (items[0]?.payload && typeof items[0].payload === 'object' && !Array.isArray(items[0].payload)
        ? (items[0].payload as Record<string, unknown>).blueprintResult : null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { state: 'unavailable', status, reason: 'canonical target has no validated operation output' };
    }
    const result = raw as Record<string, unknown>;
    const output = handle.target.kind === 'plan' ? raw : result.output;
    const evidenceRef = handle.target.kind === 'plan' ? `plan-run:${handle.target.runId}` : result.evidenceRef;
    if (typeof evidenceRef !== 'string' || !evidenceRef.trim() ||
        (handle.target.kind === 'work-item' &&
          (result.operationId !== handle.operationId || result.specificationRevision !== handle.specificationRevision))) {
      return { state: 'unavailable', status, reason: 'canonical target output has no matching validation receipt' };
    }
    const validation = checkAgainstJsonSchema(operation.acceptance.resultSchema, output);
    if (!validation.ok) return { state: 'unavailable', status, reason: `canonical target output is invalid: ${validation.errors.join('; ')}` };
    return { state: 'ready', status, output, evidenceRef };
  });
}
