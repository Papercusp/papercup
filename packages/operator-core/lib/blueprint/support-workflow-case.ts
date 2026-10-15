/** Current-principal ACL adapter for the selected support case.
 *
 * Identity comes only from the verified user principal in the transport's tool
 * context. The selected ids narrow the canonical corpus query; they never grant
 * access. documents-corpus rechecks the live organization grant, provider ACL,
 * identity mapping, revocation and disclosure ledger on every call.
 */
import type { Sql } from 'postgres';
import type { operationFromSpecification } from '@papercusp/orchestrator/blueprint';
import {
  searchOrganizationDocuments,
  type OrganizationSearchOutcome,
} from '../data-sources/documents-corpus';
import type { PersonalToolContext } from '../personal-vault/types';
import { assertSupportCaseInput, parseSupportToEngineeringResult, type ApprovedSupportWorkflow, type SupportCaseInput } from './support-workflow-contract';
import { BlueprintOperationRefusal } from './operation-refusal';
import type { AcceptedOperationPin } from './operation-admission';
import { supportWorkflowFromOperation } from './support-workflow-operation';
import { runWithWorkspace } from '../workspace-als';

export async function readSelectedSupportCase(
  sql: Sql,
  context: PersonalToolContext & { principal?: {
    kind?: string; slug?: string; workspaceId?: string; trust?: string;
  } | null },
  workflow: ApprovedSupportWorkflow,
  input: SupportCaseInput,
): Promise<OrganizationSearchOutcome> {
  const selected = assertSupportCaseInput(workflow, input);
  const principal = context.principal;
  if (principal?.kind !== 'user' || principal.trust !== 'verified' ||
      !principal.slug || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principal.slug) ||
      !principal.workspaceId?.trim() || principal.workspaceId === '*' ||
      (context.workspaceId != null && context.workspaceId !== principal.workspaceId)) {
    throw new BlueprintOperationRefusal('handle_mismatch', 'support workflow requires a verified user principal in the current workspace');
  }
  const result = await searchOrganizationDocuments(sql, context, {
    workspaceId: principal.workspaceId,
    principalUserId: principal.slug,
    agentOwnerId: principal.slug,
    query: selected.query,
    sources: [...workflow.allowedSources],
    documentIds: selected.documentIds,
    limit: selected.documentIds.length,
  });
  if (result.allowed && (result.results.length !== selected.documentIds.length ||
      result.results.some((document) => !selected.documentIds.includes(document.id)))) {
    throw new BlueprintOperationRefusal('invalid_payload', 'selected support case is unavailable or its current source access was revoked');
  }
  return result;
}

/** Shape validation alone cannot bind citations to the employee's case. Both
 * completion and later result/reviewer reads use the accepted selection and a
 * fresh canonical corpus read; worker output never supplies its own evidence. */
export async function validateSupportOperationResult(sql: Sql, workspaceId: string,
  operation: ReturnType<typeof operationFromSpecification>['operation'], pin: AcceptedOperationPin, output: unknown): Promise<void> {
  const workflow = supportWorkflowFromOperation(operation, pin.harnessSlug, pin.specificationRevision);
  if (!workflow) return;
  await runWithWorkspace(workspaceId, async () => {
    const selection = assertSupportCaseInput(workflow, pin.input as unknown as SupportCaseInput);
    const selected = await readSelectedSupportCase(sql, { workspaceId, harnessSlug: pin.harnessSlug,
      role: operation.execution?.kind === 'agent' ? operation.execution.role : undefined,
      principal: { kind: 'user', trust: 'verified', workspaceId, slug: pin.callerId?.split('/')[0] },
    }, workflow, selection);
    if (!selected.allowed) throw new BlueprintOperationRefusal('invalid_payload',
      'support result source access was revoked');
    try { parseSupportToEngineeringResult(output, selection, selected.results); }
    catch (error) {
      throw new BlueprintOperationRefusal('invalid_payload',
        `support result is invalid: ${error instanceof Error ? error.message : 'invalid evidence'}`);
    }
  });
}
