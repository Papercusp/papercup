import type { CheckEntry } from './carry-note';

export const ACTIVATION_RECEIPT_VERSION = 1 as const;
export const ACTIVATION_RECEIPT_CHECK_PREFIX = 'activation-receipt:v1:';

export type ActivationReceiptState = 'committed' | 'loaded' | 'verified' | 'failed';

export type ActivationRuntime =
  | 'operator-release'
  | 'operator-staging'
  | 'bg-host'
  | 'inference-gateway'
  | 'embed-sidecar';

export interface RuntimeIdentity {
  kind: 'git-sha' | 'content-hash' | 'build-id';
  value: string;
}

export interface ActivationBlocker {
  kind: 'critical-job' | 'resource-lock' | 'runtime-unhealthy' | 'custom';
  ref: string;
  detail?: string;
}

export interface ActivationProbe {
  tool: string;
  args: Record<string, unknown>;
  expected: string;
}

export interface ActivationReceipt {
  version: typeof ACTIVATION_RECEIPT_VERSION;
  id: string;
  workItemId: string;
  runtime: ActivationRuntime;
  expectedIdentity: RuntimeIdentity;
  observedIdentity?: RuntimeIdentity;
  blockers: ActivationBlocker[];
  probe: ActivationProbe;
  state: ActivationReceiptState;
  failure?: string;
  evidence?: string;
  updatedAtMs: number;
}

export function identitiesMatch(expected: RuntimeIdentity, observed: RuntimeIdentity | undefined): boolean {
  return observed !== undefined && expected.kind === observed.kind && expected.value === observed.value;
}

export function validateActivationReceipt(receipt: ActivationReceipt): string[] {
  const errors: string[] = [];
  if (!receipt.id.trim()) errors.push('id is required');
  if (!receipt.workItemId.trim()) errors.push('workItemId is required');
  if (!receipt.expectedIdentity.value.trim()) errors.push('expectedIdentity.value is required');
  if (!receipt.probe.tool.trim()) errors.push('probe.tool is required');
  if (!receipt.probe.expected.trim()) errors.push('probe.expected is required');
  if ((receipt.state === 'loaded' || receipt.state === 'verified') && !identitiesMatch(receipt.expectedIdentity, receipt.observedIdentity)) {
    errors.push(`${receipt.state} requires observedIdentity to match expectedIdentity`);
  }
  if (receipt.state === 'verified' && !receipt.evidence?.trim()) errors.push('verified requires evidence');
  if (receipt.state === 'failed' && !receipt.failure?.trim()) errors.push('failed requires failure');
  return errors;
}

export function activationReceiptToCheck(receipt: ActivationReceipt): CheckEntry {
  const errors = validateActivationReceipt(receipt);
  if (errors.length) throw new Error(`invalid activation receipt: ${errors.join('; ')}`);
  const encoded = Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64url');
  return {
    id: `activation:${receipt.id}`,
    claim: `${ACTIVATION_RECEIPT_CHECK_PREFIX}${encoded}`,
    recheck: `${receipt.probe.tool} ${JSON.stringify(receipt.probe.args)}`,
    ...(receipt.state === 'verified' ? { verified: receipt.evidence } : {}),
    sinceMs: receipt.updatedAtMs,
  };
}

export function activationReceiptFromCheck(check: CheckEntry): ActivationReceipt | null {
  if (!check.claim.startsWith(ACTIVATION_RECEIPT_CHECK_PREFIX)) return null;
  try {
    const decoded = Buffer.from(check.claim.slice(ACTIVATION_RECEIPT_CHECK_PREFIX.length), 'base64url').toString('utf8');
    const receipt = JSON.parse(decoded) as ActivationReceipt;
    if (receipt.version !== ACTIVATION_RECEIPT_VERSION || validateActivationReceipt(receipt).length) return null;
    return receipt;
  } catch {
    return null;
  }
}

