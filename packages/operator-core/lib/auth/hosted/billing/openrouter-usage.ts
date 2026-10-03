/** Authenticated OpenRouter metadata collector on the existing hosted receipt rail.
 *
 * /generation is a report of account charges, not an invoice-finality receipt.
 * Only a server-recorded generation/account/tenant binding may select the key,
 * payer, revision and observation time. No provider field supplies tenant scope.
 * The aggregate charge already includes caching: never multiply token counts or
 * add upstream_inference_cost (a separate BYOK-provider bill) to total_cost.
 * Docs: https://openrouter.ai/docs/cookbook/administration/usage-accounting
 */
import { createHash } from 'node:crypto';
import { formatMicrosDecimal, splitMicrosDecimal } from '../../../cupboard/money-journal';
import { PostgresHostedUsageStore, type HostedUsageAppendResult } from './usage-store';
import { validateHostedUsageRecord, type HostedUsageRecord } from './usage-statement';
import type { HostedUsageCollector } from './usage-service';

type Scope = Pick<HostedUsageRecord, 'controlWorkspaceId' | 'organizationId' | 'customerWorkspaceId'>;
export interface OpenRouterUsageBinding {
  readonly scope: Scope;
  readonly generationId: string;
  /** Payer of this OpenRouter account; independent of upstream BYOK ownership. */
  readonly payer: HostedUsageRecord['payer'];
  readonly isByok: boolean;
  readonly credentialRef: string;
  /** SHA-256 of the actual key used for execution. Durable bindings require it. */
  readonly credentialSha256?: string;
  readonly revision: number;
  readonly occurredAtMs: number;
  readonly observedAtMs: number;
  readonly evidenceRef: string;
}
export interface OpenRouterUsageCollectorOptions {
  /** Read the durable server binding, never a browser-supplied billing claim. */
  readonly readBinding?: (scope: Scope, generationId: string) => Promise<OpenRouterUsageBinding | null>;
  /** Resolve exactly the bound account's secret without persisting it. */
  readonly readCredential?: (credentialRef: string) => Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
  readonly append?: (record: HostedUsageRecord) => Promise<HostedUsageAppendResult>;
}
const GENERATION = /^gen-[0-9A-Za-z-]{1,124}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function snapshotScope(value: Scope): Scope {
  if (!record(value) || Object.keys(value).some(k => !['controlWorkspaceId', 'organizationId', 'customerWorkspaceId'].includes(k))
      || Object.values(value).length !== 3 || Object.values(value).some(v => typeof v !== 'string' || !IDENTIFIER.test(v))) {
    throw new Error('invalid OpenRouter usage scope');
  }
  return Object.freeze({ ...value });
}
const sameScope = (a: Scope, b: Scope) => a.controlWorkspaceId === b.controlWorkspaceId
  && a.organizationId === b.organizationId && a.customerWorkspaceId === b.customerWorkspaceId;
// Constructed only by the native JSON parser's numeric-token reviver. Arbitrary
// provider strings/objects must never masquerade as a numeric account charge.
class ProviderDecimal { constructor(readonly source: string) {} }

/** Convert the provider's decimal USD representation without float multiplication.
 * Preserve submicro charges as canonical decimals on the same receipt rail;
 * never round requests or turn absent/invalid/overflowing costs into zero.
 * The shadow display's usdToMicros intentionally rounds and maps missing to
 * zero, so it cannot supply this commercial receipt's exact/unknown contract. */
function exactMicros(value: unknown): { micros: number; exact: string } | null {
  const token = value instanceof ProviderDecimal ? value.source
    : typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : '';
  if (token.length > 350) return null;
  const parts = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!parts) return null;
  const fraction = parts[2] ?? '';
  const coefficient = BigInt(parts[1]! + fraction);
  const power = 6 + Number(parts[3] ?? 0) - fraction.length;
  if (!Number.isSafeInteger(power) || Math.abs(power) > 324) return null;
  try {
    return splitMicrosDecimal(formatMicrosDecimal(power < 0 ? coefficient : coefficient * 10n ** BigInt(power), Math.max(0, -power)));
  } catch { return null; }
}

/** Whitelist only the account charge; no prompts, keys or arbitrary metadata.
 * Saved provider bodies are fixtures, not proof of a real account read. */
export function openRouterUsageRecord(binding: OpenRouterUsageBinding, payload: unknown): HostedUsageRecord {
  const scope = snapshotScope(binding.scope);
  if (!GENERATION.test(binding.generationId) || !IDENTIFIER.test(binding.credentialRef)
      || !IDENTIFIER.test(binding.evidenceRef) || typeof binding.isByok !== 'boolean'
      || (binding.credentialSha256 !== undefined && !/^[a-f0-9]{64}$/.test(binding.credentialSha256))) {
    throw new Error('invalid OpenRouter usage binding');
  }
  if (!record(payload) || !record(payload.data) || payload.error !== undefined
      || payload.data.id !== binding.generationId || payload.data.is_byok !== binding.isByok) {
    throw new Error('OpenRouter generation binding mismatch');
  }
  const amount = exactMicros(payload.data.total_cost);
  const costMicros = amount?.micros ?? null;
  const values = { ...scope, provider: 'openrouter', usageId: binding.generationId,
    revision: binding.revision, category: 'inference-fees' as const, payer: binding.payer,
    occurredAtMs: binding.occurredAtMs, observedAtMs: binding.observedAtMs,
    quantity: 1, unit: 'generations', costSource: costMicros === null ? 'unpriced' as const : 'provider-reported' as const,
    costMicros, ...(amount?.exact.includes('.') ? { costMicrosExact: amount.exact } : {}), sourceRef: binding.evidenceRef };
  // A replay pins the same observation; changed provider charges under an old
  // server revision are refused by the store, not silently replaced or added.
  const recordId = 'openrouter:' + createHash('sha256').update(JSON.stringify(values)).digest('hex');
  const result: HostedUsageRecord = Object.freeze({ ...values, recordId });
  validateHostedUsageRecord(result);
  return result;
}

export class OpenRouterHostedUsageCollector {
  private readonly options: OpenRouterUsageCollectorOptions;
  constructor(options: OpenRouterUsageCollectorOptions = {}) { this.options = { ...options }; }

  async collect(input: { readonly scope: Scope; readonly generationId: string }, signal?: AbortSignal) {
    if (!record(input) || Object.keys(input).some(k => !['scope', 'generationId'].includes(k))
        || !GENERATION.test(input.generationId)) throw new Error('invalid OpenRouter usage request');
    const scope = snapshotScope(input.scope); const generationId = input.generationId;
    if (!this.options.readBinding || !this.options.readCredential) return { outcome: 'unavailable' as const, reason: 'unconfigured' as const };
    const received = await this.options.readBinding(scope, generationId);
    if (!received) return { outcome: 'unavailable' as const, reason: 'unbound-generation' as const };
    const binding: OpenRouterUsageBinding = Object.freeze({ ...received, scope: snapshotScope(received.scope) });
    if (!sameScope(scope, binding.scope) || generationId !== binding.generationId) {
      return { outcome: 'unavailable' as const, reason: 'binding-mismatch' as const };
    }
    // Validate server counters/account ref before asking for a secret or doing I/O.
    openRouterUsageRecord(binding, { data: { id: generationId, is_byok: binding.isByok, total_cost: null } });
    const secret = await this.options.readCredential(binding.credentialRef).catch(() => null);
    if (typeof secret !== 'string' || !secret || secret.trim() !== secret || /[\r\n]/.test(secret)) {
      return { outcome: 'unavailable' as const, reason: 'missing-credential' as const };
    }
    if (binding.credentialSha256 !== undefined
        && createHash('sha256').update(secret).digest('hex') !== binding.credentialSha256) {
      return { outcome: 'unavailable' as const, reason: 'credential-mismatch' as const };
    }
    let response: Response;
    try {
      const url = new URL('https://openrouter.ai/api/v1/generation'); url.searchParams.set('id', generationId);
      response = await (this.options.fetch ?? globalThis.fetch)(url, { method: 'GET', redirect: 'error', cache: 'no-store',
        headers: { Authorization: `Bearer ${secret}` }, signal: signal ?? AbortSignal.timeout(10_000) });
    } catch {
      // Provider error text may contain a secret or customer content.
      return { outcome: 'unavailable' as const, reason: 'provider-read-failed' as const };
    }
    if (!response.ok) return { outcome: 'unavailable' as const, reason: 'provider-http-error' as const, status: response.status };
    let normalized: HostedUsageRecord;
    try {
      const payload: unknown = JSON.parse(await response.text(), (key, value: unknown, context?: { source?: string }) =>
        key === 'total_cost' && typeof value === 'number'
          // A runtime without source-token support stays explicitly unpriced.
          ? new ProviderDecimal(context?.source ?? '') : value);
      normalized = openRouterUsageRecord(binding, payload);
    }
    catch { return { outcome: 'unavailable' as const, reason: 'invalid-provider-report' as const }; }
    const append = this.options.append ?? (r => new PostgresHostedUsageStore().append(r));
    const outcome = await append(normalized);
    return { outcome, record: normalized };
  }
}

/** Production reader of server-captured bindings on the SAME usage ledger.
 * Only known generations are read; this cannot certify the provider's entire
 * population or final invoice. Private binding fields never enter a receipt.
 * Revision races are refused; a later read reconciles from committed history. */
export function createOpenRouterHostedUsageCollector(options: {
  readonly store: Pick<PostgresHostedUsageStore, 'readOpenRouterBindings'>;
  readonly readCredential: (reference: string) => Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
}): HostedUsageCollector {
  return {
    id: 'openrouter:bound-generations', provider: 'openrouter', categories: ['inference-fees'],
    async read(input) {
      const bindings = await options.store.readOpenRouterBindings(input);
      const records: HostedUsageRecord[] = [];
      // Sequential provider reads keep account rate pressure bounded. No
      // incomplete/failed read is represented as a zero charge or full census.
      for (const binding of bindings) {
        const collector = new OpenRouterHostedUsageCollector({
          readBinding: async (scope, generationId) => sameScope(scope, binding.scope)
            && generationId === binding.generationId ? binding : null,
          readCredential: options.readCredential, fetch: options.fetch,
          // createHostedUsageSource validates the whole batch before appending.
          append: async () => 'recorded',
        });
        const result = await collector.collect({ scope: binding.scope, generationId: binding.generationId });
        if (result.outcome === 'recorded' && 'record' in result) records.push(result.record);
      }
      return { scope: input.scope, month: input.month, complete: false,
        observedAtMs: input.asOfMs, evidenceRef: 'openrouter:bound-generations', records };
    },
  };
}
