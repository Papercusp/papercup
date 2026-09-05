/** Safe/Zodiac-style bounded treasury controls (P-023). */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';

export type TreasuryRole = 'settlement' | 'host-payout' | 'reserve-transfer' | 'emergency-pause';
export interface SafeTreasuryConfig {
  readonly chainId: number;
  readonly safeAddress: string;
  readonly owners: readonly string[];
  readonly threshold: number;
  readonly roles: Readonly<Record<TreasuryRole, { readonly enabled: boolean; readonly maxAmountMicros: bigint; readonly allowedRecipients: readonly string[]; readonly allowedTokens: readonly string[] }>>;
}

export type TreasuryConfigResult = { ok: true } | { ok: false; code: 'invalid-config'; detail: string };
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function validateTreasuryConfig(config: SafeTreasuryConfig): TreasuryConfigResult {
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0 || !ADDRESS.test(config.safeAddress)) return { ok: false, code: 'invalid-config', detail: 'chainId and safeAddress are required' };
  if (config.owners.length === 0 || new Set(config.owners.map((o) => o.toLowerCase())).size !== config.owners.length || !Number.isSafeInteger(config.threshold) || config.threshold < 1 || config.threshold > config.owners.length) return { ok: false, code: 'invalid-config', detail: 'owners must be unique and threshold must be within owner count' };
  for (const role of ['settlement', 'host-payout', 'reserve-transfer', 'emergency-pause'] as const) {
    const spec = config.roles[role];
    if (!spec || spec.maxAmountMicros < 0n || spec.allowedTokens.some((t) => !ADDRESS.test(t)) || spec.allowedRecipients.some((r) => !ADDRESS.test(r))) return { ok: false, code: 'invalid-config', detail: `invalid ${role} role bounds` };
  }
  return { ok: true };
}

export interface TreasuryTransferRequest {
  readonly role: TreasuryRole;
  readonly token: string;
  readonly recipient: string;
  readonly amountMicros: bigint;
  readonly settlementReceiptHash: string;
  readonly policyApproved: boolean;
}

export type TreasuryAuthorization = { ok: true; safeTxHash: string; request: TreasuryTransferRequest } | { ok: false; code: 'config-invalid' | 'role-disabled' | 'policy-not-approved' | 'token-not-allowed' | 'recipient-not-allowed' | 'amount-exceeds-role-cap' | 'invalid-request'; detail: string };

/** Authorize a bounded transfer; submitting the Safe transaction remains an injected edge. */
export function authorizeTreasuryTransfer(config: SafeTreasuryConfig, request: TreasuryTransferRequest): TreasuryAuthorization {
  const valid = validateTreasuryConfig(config);
  if (!valid.ok) return { ok: false, code: 'config-invalid', detail: valid.detail };
  const role = config.roles[request.role];
  if (!role?.enabled) return { ok: false, code: 'role-disabled', detail: `treasury role '${request.role}' is disabled` };
  if (!request.policyApproved) return { ok: false, code: 'policy-not-approved', detail: 'treasury transfer requires explicit policy approval' };
  if (!ADDRESS.test(request.token) || !role.allowedTokens.map((t) => t.toLowerCase()).includes(request.token.toLowerCase())) return { ok: false, code: 'token-not-allowed', detail: 'token is outside the role allowlist' };
  if (!ADDRESS.test(request.recipient) || !role.allowedRecipients.map((r) => r.toLowerCase()).includes(request.recipient.toLowerCase())) return { ok: false, code: 'recipient-not-allowed', detail: 'recipient is outside the role allowlist' };
  if (request.amountMicros <= 0n || request.amountMicros > role.maxAmountMicros || !request.settlementReceiptHash.trim()) return { ok: false, code: 'amount-exceeds-role-cap', detail: 'amount must be positive, within role cap, and bound to a settlement receipt' };
  const txBody = { amountMicros: request.amountMicros.toString(), chainId: config.chainId, recipient: request.recipient.toLowerCase(), role: request.role, safeAddress: config.safeAddress.toLowerCase(), settlementReceiptHash: request.settlementReceiptHash, token: request.token.toLowerCase() };
  return { ok: true, safeTxHash: createHash('sha256').update(canonicalJson(txBody)).digest('hex'), request };
}
