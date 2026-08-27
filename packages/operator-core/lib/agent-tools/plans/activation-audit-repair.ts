/**
 * File the repair lane for an activation audit that cannot yet be recorded.
 *
 * Both the MCP handler and the lower-level activation writer can reject the
 * same open mapping/blocker. They must converge on one claimable item rather
 * than each minting a sibling, so the condition-upsert seam owns the filing
 * and the condition key stays stable for the plan.
 */
import { upsertConditionWorkItem } from '../../coord/condition-upsert';
import type { ActivationAuditPayload } from '../../plan-audits';

export interface ActivationAuditRepairFilingInput {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  activation: ActivationAuditPayload;
}

export interface ActivationAuditRepairFiling {
  conditionKey: string;
  /** The one work-item owning this blocked activation condition, if filed. */
  id: string | null;
  /** True only when this call minted the owning item. */
  created: boolean;
  /** A lost-race duplicate that could not be settled, if condition-upsert reports one. */
  duplicateLeftOpen?: string;
  /** Filing errors are returned with the original activation refusal. */
  error?: string;
}

export function activationAuditRepairConditionKey(input: {
  harnessSlug: string;
  planSlug: string;
}): string {
  return `activation-audit:${input.harnessSlug}/${input.planSlug}`;
}

function boundedDetails(values: string[], limit = 12): string {
  const shown = values.slice(0, limit);
  const suffix = values.length > shown.length ? `; ... and ${values.length - shown.length} more` : '';
  return `${shown.join('; ')}${suffix}`;
}

export function activationAuditRepairSummary(input: ActivationAuditRepairFilingInput): string {
  const openMappings = input.activation.mappings
    .filter((mapping) => mapping.disposition === 'open')
    .map((mapping) => `${mapping.id}: ${mapping.requirement}`);
  const blockers = input.activation.unresolvedBlockers;
  const causes = [
    openMappings.length > 0 ? `Open mappings: ${boundedDetails(openMappings)}` : null,
    blockers.length > 0 ? `Unresolved blockers: ${boundedDetails(blockers)}` : null,
  ].filter((value): value is string => value !== null);

  return [
    `Activation audit for plan '${input.planSlug}' is blocked and needs repair before ready/active.`,
    ...causes,
    "Repair/map the listed gaps, then rerun plans:audit with phase:'activation'.",
  ].join('\n\n');
}

/**
 * File-or-refresh the one activation repair item. This is deliberately
 * fail-soft: the caller must still report the original activation refusal if
 * the repair queue itself is temporarily unavailable.
 */
export async function ensureActivationAuditRepairFiling(
  input: ActivationAuditRepairFilingInput,
): Promise<ActivationAuditRepairFiling> {
  const conditionKey = activationAuditRepairConditionKey(input);
  try {
    const result = await upsertConditionWorkItem(conditionKey, {
      kind: 'task',
      harness: input.harnessSlug,
      workspaceId: input.workspaceId,
      createdBy: 'system:plans-audit',
      title: `Repair activation audit for plan '${input.planSlug}'`,
      summary: activationAuditRepairSummary(input),
      payload: {
        activationAuditRepair: {
          planSlug: input.planSlug,
          openMappingIds: input.activation.mappings
            .filter((mapping) => mapping.disposition === 'open')
            .map((mapping) => mapping.id),
          unresolvedBlockers: input.activation.unresolvedBlockers,
        },
      },
    });
    return {
      conditionKey,
      id: result.id,
      created: result.created,
      ...(result.duplicateLeftOpen ? { duplicateLeftOpen: result.duplicateLeftOpen } : {}),
    };
  } catch (error) {
    return {
      conditionKey,
      id: null,
      created: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
