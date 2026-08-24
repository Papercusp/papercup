/** Shared activation-audit gate used by every plan lifecycle entry door. */

type Tx = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

export const ACTIVATION_PLAN_STATUSES = ['ready', 'active'] as const;

export function isActivationPlanStatus(status: string | null | undefined): boolean {
  return status === 'ready' || status === 'active';
}

/** True only for the transition that ENTERS ready/active, not a later edit. */
export function entersActivationPlanStatus(
  before: string | null | undefined,
  after: string | null | undefined,
): boolean {
  return !isActivationPlanStatus(before) && isActivationPlanStatus(after);
}

export interface ConversationActivationGateVerdict {
  satisfied: boolean;
  code?: 'conversation_audit_required';
  message?: string;
  auditSeq?: number;
}

export function conversationAuditRequiredMessage(planSlug: string): string {
  return (
    `Plan '${planSlug}' cannot enter ready/active or start until it has a completed conversation audit. ` +
    `Read the full source conversation with sessions:search/read, then call plans:audit { phase:'activation', ` +
    `slug:'${planSlug}', sourceRanges:[...], mappings:[...] }; repair every omission/open mapping and retry.`
  );
}

export async function evaluateConversationActivationGate(
  tx: Tx,
  scope: { workspaceId: string; harnessSlug: string; planSlug: string },
): Promise<ConversationActivationGateVerdict> {
  const rows = await tx<Array<{ audit_seq: number }>>`
    SELECT audit_seq
      FROM harness_shared.plan_audits
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ${scope.planSlug}
       AND audit_kind = 'activation'
     ORDER BY audit_seq DESC
     LIMIT 1`;
  const row = rows[0];
  return row
    ? { satisfied: true, auditSeq: Number(row.audit_seq) }
    : {
        satisfied: false,
        code: 'conversation_audit_required',
        message: conversationAuditRequiredMessage(scope.planSlug),
      };
}

export interface ConversationAuditRequiredValue {
  ok: false;
  code: 'conversation_audit_required';
  message: string;
}

export function conversationAuditRequiredValue(planSlug: string): ConversationAuditRequiredValue {
  return {
    ok: false,
    code: 'conversation_audit_required',
    message: conversationAuditRequiredMessage(planSlug),
  };
}

export function domainFailureMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}
