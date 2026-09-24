/** Internal direct-item admission for a compiled blueprint operation.
 * Public invocation, idempotency, plan targets, and execution belong to the
 * later operation lifecycle. The canonical work-item row carries only a pin
 * and its validated input; the complete contract lives in the immutable store. */
import { isDeepStrictEqual } from 'node:util';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { operationFromSpecification } from '@papercusp/orchestrator/blueprint';
import { checkAgainstJsonSchema } from '../json-schema-validation';
import { createWorkItem, type WorkItem, type WorkItemKind } from '../work-items';
import { readBlueprintHashFromPg, readBlueprintSpecificationSnapshot } from './project-to-pg';

const AcceptedOperationPinSchema = z.object({
  kind: z.literal('blueprint-operation'),
  harnessSlug: z.string().min(1),
  specificationRevision: z.string().regex(/^[0-9a-f]{64}$/),
  operationId: z.string().min(1),
  operationVersion: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
}).strict();

export type AcceptedOperationPin = z.infer<typeof AcceptedOperationPinSchema>;

export interface AcceptBlueprintDirectItemInput {
  workspaceId: string;
  harnessSlug: string;
  operationId: string;
  input: Record<string, unknown>;
  title: string;
  summary?: string;
  createdBy?: string;
}

function exactJsonInput(input: Record<string, unknown>): Record<string, unknown> {
  let saved: unknown;
  try {
    saved = JSON.parse(JSON.stringify(input));
  } catch {
    throw new Error('blueprint operation input must be JSON serializable');
  }
  if (!saved || Array.isArray(saved) || typeof saved !== 'object' || !isDeepStrictEqual(saved, input)) {
    throw new Error('blueprint operation input must be a lossless JSON object');
  }
  return saved as Record<string, unknown>;
}

function validateOperationInput(schema: Record<string, unknown>, input: Record<string, unknown>): void {
  const verdict = checkAgainstJsonSchema(schema, input);
  if (!verdict.ok) {
    throw new Error(`blueprint operation ${verdict.code}: ${verdict.errors.join('; ')}`);
  }
}

/** Select the current revision once, then accept that exact immutable artifact.
 * An author moving the mutable blueprint pointer afterward cannot change the
 * accepted item's contract, even if it happens before the work-item INSERT. */
export async function acceptBlueprintDirectWorkItem(
  sql: Sql,
  request: AcceptBlueprintDirectItemInput,
): Promise<WorkItem> {
  if (!request.workspaceId.trim() || !request.harnessSlug.trim() || !request.operationId.trim()) {
    throw new Error('blueprint operation admission requires workspace, harness, and operation');
  }
  if (!request.title.trim()) throw new Error('blueprint operation work item requires a title');
  const revision = await readBlueprintHashFromPg(sql, request.workspaceId, request.harnessSlug);
  if (!revision) throw new Error('blueprint operation has no projected specification');
  const specification = await readBlueprintSpecificationSnapshot(
    sql, request.workspaceId, request.harnessSlug, revision,
  );
  if (!specification) throw new Error('blueprint operation specification snapshot is missing');
  const { operation } = operationFromSpecification(specification, request.operationId);
  if (operation.target.kind !== 'work-item') {
    throw new Error(`blueprint operation ${request.operationId} targets a plan, not a direct work item`);
  }
  const input = exactJsonInput(request.input);
  validateOperationInput(operation.inputSchema, input);
  const pin: AcceptedOperationPin = {
    kind: 'blueprint-operation',
    harnessSlug: request.harnessSlug,
    specificationRevision: revision,
    operationId: request.operationId,
    operationVersion: operation.version,
    input,
  };
  return createWorkItem({
    kind: operation.target.itemKind as WorkItemKind,
    title: request.title.trim(),
    summary: request.summary,
    harness: request.harnessSlug,
    workspaceId: request.workspaceId,
    createdBy: request.createdBy,
    payload: { blueprintOperation: pin },
  });
}

/** Resolve an accepted item from its retained revision, never the current cache. */
export async function readAcceptedBlueprintDirectWorkItem(
  sql: Sql,
  workspaceId: string,
  item: WorkItem,
) {
  const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
    ? item.payload as Record<string, unknown> : {};
  const pin = AcceptedOperationPinSchema.parse(payload.blueprintOperation);
  const specification = await readBlueprintSpecificationSnapshot(
    sql, workspaceId, pin.harnessSlug, pin.specificationRevision,
  );
  if (!specification) throw new Error('accepted blueprint operation specification snapshot is missing');
  const { operation } = operationFromSpecification(specification, pin.operationId);
  if (operation.target.kind !== 'work-item' || operation.version !== pin.operationVersion ||
      operation.target.itemKind !== item.kind) {
    throw new Error('accepted blueprint operation pin does not match the work item');
  }
  validateOperationInput(operation.inputSchema, pin.input);
  return { pin, operation };
}
