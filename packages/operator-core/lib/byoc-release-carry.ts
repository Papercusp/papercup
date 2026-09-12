/** BYOC release-journal -> agent carry adapter. */
import type { Sql } from 'postgres';
import type { TaskReleaseJournal, TaskReleaseReceipt, TaskReleaseReceiptState } from './task-manager/store';
import { taskReleaseJournalFromDetail } from './task-manager/store';

export const BYOC_RELEASE_CARRY_SCHEMA_VERSION = 'byoc-release-carry-v1' as const;
export const BYOC_RELEASE_CARRY_MAX = 3;

export interface ByocReleaseCarrySnapshot {
  schemaVersion: typeof BYOC_RELEASE_CARRY_SCHEMA_VERSION;
  taskId: string;
  workItemId: string | null;
  operationId: string;
  cursor: number;
  currentStage: string | null;
  currentState: TaskReleaseReceiptState | null;
  artifactIdentity: unknown;
  sourceIdentity: unknown;
  credentialGeneration: string | null;
  credentialExpiresAt: string | null;
  spentRequestIdentities: string[];
  evidenceRefs: string[];
  nextAction: string;
  /** Exact ledger pointer for older receipts/input preimages omitted here. */
  historyRef: string;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function latestReceipt(journal: TaskReleaseJournal): TaskReleaseReceipt | null {
  return journal.receipts.at(-1) ?? null;
}

function nextActionFor(journal: TaskReleaseJournal): string {
  const latest = latestReceipt(journal);
  if (!latest) return 'Begin the first stage through the maintained release driver.';
  if (latest.state === 'intent' || latest.state === 'unknown') {
    return `Reconcile request ${latest.requestIdentity} at stage ${latest.stage} before any further mutation.`;
  }
  if (latest.state === 'refused') {
    return latest.evidenceRefs.includes('reconcile:confirmed-absent')
      ? `Resume stage ${latest.stage} through the maintained driver; it must mint a new one-use request identity.`
      : `Stop at stage ${latest.stage}; inspect its refusal evidence before retrying.`;
  }
  return `Advance through the maintained release driver without rerunning committed stage ${latest.stage}.`;
}

/**
 * Build the current compact receipt from the complete canonical journal. A
 * later call replaces an older projection wholesale; carry prose is never an
 * authority that can outvote the journal.
 */
export function projectByocReleaseCarry(
  taskId: string,
  workItemId: string | null,
  journal: TaskReleaseJournal,
): ByocReleaseCarrySnapshot {
  const credential = objectOrNull(journal.credential);
  return {
    schemaVersion: BYOC_RELEASE_CARRY_SCHEMA_VERSION,
    taskId,
    workItemId,
    operationId: journal.operationId,
    cursor: journal.cursor,
    currentStage: journal.currentStage,
    currentState: journal.currentState,
    artifactIdentity: journal.artifactIdentity ?? null,
    sourceIdentity: journal.source ?? null,
    credentialGeneration: typeof credential?.generation === 'string' ? credential.generation : null,
    credentialExpiresAt: typeof credential?.expiresAt === 'string' ? credential.expiresAt : null,
    spentRequestIdentities: [...journal.spentOperationIds],
    evidenceRefs: [...new Set(journal.receipts.flatMap((receipt) => receipt.evidenceRefs))],
    nextAction: nextActionFor(journal),
    historyRef: `task:${taskId}#release`,
  };
}

export interface ReadLinkedByocReleaseCarryInput {
  ownerId: string;
  workspaceId: string;
  heldWorkItemIds: readonly string[];
  limit?: number;
}

/**
 * Read only explicitly-associated deploy tasks. Selecting the workspace's
 * latest deploy would leak another agent's lane into this session's carry.
 */
export async function readLinkedByocReleaseCarries(
  input: ReadLinkedByocReleaseCarryInput,
  sql: Sql,
): Promise<ByocReleaseCarrySnapshot[]> {
  const held = [...new Set(input.heldWorkItemIds.filter(Boolean))];
  const limit = Math.min(Math.max(input.limit ?? BYOC_RELEASE_CARRY_MAX, 1), BYOC_RELEASE_CARRY_MAX);
  const rows = await sql<Array<{
    task_id: string;
    work_item_id: string | null;
    detail: Record<string, unknown> | null;
  }>>`
    SELECT task_id, work_item_id, detail
      FROM harness_shared.task_ledger
     WHERE workspace_id = ${input.workspaceId}
       AND class = 'deploy'
       AND jsonb_typeof(detail -> 'release') = 'object'
       AND (
         (${held.length > 0} AND work_item_id = ANY(${sql.array(held)}::text[]))
         OR detail ->> 'coordOwnerId' = ${input.ownerId}
       )
     ORDER BY (ended_at IS NULL) DESC, updated_at DESC, task_id DESC
     LIMIT ${limit}
  `;
  const snapshots: ByocReleaseCarrySnapshot[] = [];
  for (const row of rows) {
    const journal = taskReleaseJournalFromDetail(row.detail);
    if (journal) snapshots.push(projectByocReleaseCarry(row.task_id, row.work_item_id, journal));
  }
  return snapshots;
}

function compactList(values: readonly string[], empty: string): string {
  return values.length > 0 ? values.join(', ') : empty;
}

export function renderByocReleaseCarry(snapshot: ByocReleaseCarrySnapshot): string {
  return [
    `  • task ${snapshot.taskId}${snapshot.workItemId ? ` (work-item ${snapshot.workItemId})` : ''}`,
    `    operation=${snapshot.operationId}; cursor=${snapshot.cursor}; stage=${snapshot.currentStage ?? 'not-started'}; state=${snapshot.currentState ?? 'absent'}`,
    `    source=${JSON.stringify(snapshot.sourceIdentity)}; artifact=${JSON.stringify(snapshot.artifactIdentity)}`,
    `    credential=${snapshot.credentialGeneration ?? 'none'}${snapshot.credentialExpiresAt ? ` (expires ${snapshot.credentialExpiresAt})` : ''}`,
    `    spent request ids: ${compactList(snapshot.spentRequestIdentities, 'none')}`,
    `    evidence refs: ${compactList(snapshot.evidenceRefs, 'none')}`,
    `    next: ${snapshot.nextAction}`,
    `    older receipt narrative/input preimages: ${snapshot.historyRef}`,
  ].join('\n');
}
