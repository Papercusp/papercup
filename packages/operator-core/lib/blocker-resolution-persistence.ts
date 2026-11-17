import type { Sql, TransactionSql } from 'postgres';
import { consumeBindingCorrection, type PreparedBlockerDecision } from './blocker-resolution-decision';

/** Internal handoff to the existing lifecycle transaction, never a tool argument.
 * The public boundary owns evidence validation; this seam owns atomic custody,
 * predecessor and physical-row fencing. It introduces no independent store. */
export interface BlockerDecisionMutation {
  prepared: Extract<PreparedBlockerDecision, { ok: true }>;
  expectedState: string;
  expectedCustodianId: string;
  expectedExternalBlockers: unknown;
  payloadPatch: Record<string, unknown>;
  unset: readonly string[];
  bindingCorrection?: boolean;
}

export class BlockerDecisionMutationConflict extends Error {
  readonly code = 'blocker_decision_revision_conflict';
  constructor() {
    super('Blocker decision, lifecycle or custody changed; read the canonical row and retry. No paired mutation was committed.');
    this.name = 'BlockerDecisionMutationConflict';
  }
}

/** Called only INSIDE the lifecycle writer's bounded transaction. Holding this
 * update's row lock through the state write prevents a claim/close/clear race.
 * The caller must also throw on a lifecycle no-op so this update rolls back. */
export async function applyBlockerDecisionMutation(
  tx: Sql | TransactionSql,
  identity: { workspace: string; harness: string | null; id: string },
  mutation: BlockerDecisionMutation,
): Promise<void> {
  if (mutation.prepared.replayed || mutation.prepared.record.workItemId !== identity.id ||
      mutation.prepared.record.authorId !== mutation.expectedCustodianId ||
      mutation.unset.includes('blockerResolution') || !consumeBindingCorrection(mutation.prepared)) throw new BlockerDecisionMutationConflict();
  const correction = mutation.prepared.record.decision.disposition === 'self_resolve' &&
    Boolean(mutation.prepared.record.decision.bindingCorrection);
  if (correction && !mutation.bindingCorrection) throw new BlockerDecisionMutationConflict();
  const rows = await tx`
    UPDATE harness_shared.work_items
       SET payload = (COALESCE(payload, '{}'::jsonb) ||
             ${JSON.stringify({ ...mutation.payloadPatch, ...mutation.prepared.patch })}::text::jsonb) - ${[...mutation.unset]}::text[]
     WHERE workspace_id = ${identity.workspace} AND harness_slug IS NOT DISTINCT FROM ${identity.harness} AND feature_id = ${identity.id}
       AND origin <> 'remote'
       AND status = ${mutation.expectedState}
       AND taken_by = ${mutation.expectedCustodianId}
       AND COALESCE(payload->'blockerResolution', 'null'::jsonb) = ${JSON.stringify(mutation.prepared.expectedState ?? null)}::text::jsonb
       AND COALESCE(payload->'externalBlockers', '[]'::jsonb) = ${JSON.stringify(mutation.expectedExternalBlockers ?? [])}::text::jsonb
       AND (${!correction} OR (source_plan_slug IS NULL AND COALESCE(cardinality(source_plan_item_ids), 0) = 0
         AND plan_slug IS NULL AND plan_line_id IS NULL
         AND COALESCE(payload->'plan_item', 'null'::jsonb) = 'null'::jsonb
         AND COALESCE(payload->'planItem', 'null'::jsonb) = 'null'::jsonb))
    RETURNING feature_id`;
  if (!rows.length) throw new BlockerDecisionMutationConflict();
}
