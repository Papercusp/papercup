import { describe, expect, it, vi } from 'vitest';
import { OpenRouterHostedUsageCollector, openRouterUsageRecord, type OpenRouterUsageBinding } from './openrouter-usage';
import { buildHostedUsageStatement, type HostedUsageRecord } from './usage-statement';

const scope = { controlWorkspaceId: 'control', organizationId: 'org', customerWorkspaceId: 'customer' };
const time = Date.UTC(2026, 9, 2);
const binding: OpenRouterUsageBinding = { scope, generationId: 'gen-server-recorded', payer: 'consumption',
  isByok: false, credentialRef: 'secret-ref:org-openrouter', revision: 1,
  occurredAtMs: time, observedAtMs: time + 1000, evidenceRef: 'provider-receipt:report-1' };
const payload = (cost: unknown = 0.0015, extra: Record<string, unknown> = {}) => ({ data: {
  id: binding.generationId, is_byok: false, total_cost: cost,
  // Documented generation metadata plus hostile private extras: none is saved.
  native_tokens_prompt: 100, native_tokens_cached: 80, native_tokens_completion: 25,
  upstream_inference_cost: 9, prompts: ['private prompt'], api_key: 'provider-secret',
  model: 'model/private', external_user: 'private-user', ...extra,
} });
const statement = (records: HostedUsageRecord[]) => buildHostedUsageStatement({ scope, month: '2026-10',
  asOfMs: time + 2000, source: { complete: false, observedAtMs: time + 1000, maximumAgeMs: 2000,
    evidenceRef: 'collector:incomplete-census' }, records });
function setup(change: Record<string, unknown> = {}) {
  const readBinding = vi.fn(async () => binding);
  const readCredential = vi.fn(async () => 'server-secret');
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(payload()), { status: 200 }));
  const append = vi.fn(async (_: HostedUsageRecord) => 'recorded' as const);
  return { readBinding, readCredential, fetch, append,
    collector: new OpenRouterHostedUsageCollector({ readBinding, readCredential, fetch, append, ...change }) };
}
describe('OpenRouter hosted usage collector', () => {
  it('reads only the bound generation metadata using the bound account and persists a whitelist', async () => {
    const s = setup(); const result = await s.collector.collect({ scope, generationId: binding.generationId });
    expect(result.outcome).toBe('recorded'); expect(s.readBinding).toHaveBeenCalledWith(scope, binding.generationId);
    expect(s.readCredential).toHaveBeenCalledWith(binding.credentialRef);
    const [url, options] = s.fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://openrouter.ai/api/v1/generation?id=gen-server-recorded');
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store', headers: { Authorization: 'Bearer server-secret' } });
    const saved = s.append.mock.calls[0]![0];
    expect(saved).toMatchObject({ ...scope, provider: 'openrouter', quantity: 1, unit: 'generations',
      costSource: 'provider-reported', costMicros: 1500, payer: 'consumption' });
    expect(JSON.stringify(saved)).not.toMatch(/private|secret|tokens|upstream|prompts/);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(statement([saved]).settlementEligible).toBe(false);
  });
  it('counts the account charge once for cached/uncached requests instead of adding token rates or upstream cost', () => {
    const first = openRouterUsageRecord(binding, payload(0.0001));
    const second = openRouterUsageRecord({ ...binding, generationId: 'gen-uncached', evidenceRef: 'receipt:uncached' },
      { data: { id: 'gen-uncached', is_byok: false, total_cost: 0.001, native_tokens_cached: 0 } });
    expect(statement([first, first, second]).lines[0]).toMatchObject({ usages: 2, quantity: 2, reportedMicros: 1100 });
    expect(statement([first, first, second]).consumptionBilled.micros).toBe(0);
  });
  it('keeps upstream BYOK cost separate from the bound OpenRouter account payer', () => {
    const r = openRouterUsageRecord({ ...binding, isByok: true }, payload(0.0005, { is_byok: true, upstream_inference_cost: 0.02 }));
    expect(r).toMatchObject({ payer: 'consumption', costMicros: 500 });
    const direct = openRouterUsageRecord({ ...binding, isByok: true, payer: 'customer-direct' },
      payload(0.0005, { is_byok: true }));
    expect(statement([direct]).lines[0]).toMatchObject({ payer: 'customer-direct', reportedMicros: 500 });
    expect(statement([direct]).consumptionBilled.micros).toBe(0);
  });
  it.each([0, 0.000001, 0.000123, 0.1, 1e-5, 1e3])('converts exact decimal USD %s to integer micros', usd => {
    expect(openRouterUsageRecord(binding, payload(usd)).costMicros).toBe(Math.round(usd * 1_000_000));
  });
  it.each([[0.0000001, 0, '0.1'], [0.00123456, 1234, '1234.56'],
    [5e-324, 0, '0.' + '0'.repeat(317) + '5']] as const)('preserves exact provider USD %s without request rounding', (cost, micros, exact) => {
    const r = openRouterUsageRecord(binding, payload(cost));
    expect(r).toMatchObject({ costSource: 'provider-reported', costMicros: micros, costMicrosExact: exact });
    expect(statement([r]).lines[0]).toMatchObject({ unpricedUsages: 0, reportedMicros: micros, reportedMicrosExact: exact });
    expect(statement([r]).settlementEligible).toBe(false);
  });
  it.each([null, undefined, '0.001', -1, NaN, Infinity, 1e20])(
    'preserves missing/invalid/overflow charge %s as unpriced', cost => {
      const body = cost === undefined ? { data: { id: binding.generationId, is_byok: false } } : payload(cost);
      const r = openRouterUsageRecord(binding, body);
      expect(r).toMatchObject({ costSource: 'unpriced', costMicros: null });
      expect(statement([r]).lines[0]?.unpricedUsages).toBe(1);
    });
  it('preserves cancelled generation reports without asserting a final bill or releasing a budget hold', () => {
    const r = openRouterUsageRecord(binding, payload(0, { cancelled: true, finish_reason: null }));
    expect(r).toMatchObject({ costSource: 'provider-reported', costMicros: 0 });
    expect(statement([r]).settlementEligible).toBe(false);
  });
  it('pins replay identity and replaces a later cost report through the existing revision history', () => {
    const first = openRouterUsageRecord(binding, payload(0.001));
    expect(openRouterUsageRecord(binding, payload(0.001, { prompts: ['changed private text'] }))).toEqual(first);
    const later = openRouterUsageRecord({ ...binding, revision: 2, observedAtMs: time + 1500, evidenceRef: 'receipt:correction' }, payload(0.002));
    expect(later.recordId).not.toBe(first.recordId);
    expect(statement([later, first, later]).lines[0]).toMatchObject({ usages: 1, reportedMicros: 2000 });
  });
  it('refuses missing configuration/binding and foreign tenant/account bindings before reading a key', async () => {
    expect(await new OpenRouterHostedUsageCollector().collect({ scope, generationId: binding.generationId }))
      .toEqual({ outcome: 'unavailable', reason: 'unconfigured' });
    for (const response of [null, { ...binding, scope: { ...scope, organizationId: 'other' } },
      { ...binding, scope: { ...scope, customerWorkspaceId: 'other' } }, { ...binding, generationId: 'gen-other' }]) {
      const s = setup({ readBinding: async () => response });
      expect((await s.collector.collect({ scope, generationId: binding.generationId })).outcome).toBe('unavailable');
      expect(s.readCredential).not.toHaveBeenCalled(); expect(s.fetch).not.toHaveBeenCalled(); expect(s.append).not.toHaveBeenCalled();
    }
  });
  it('snapshots the server binding before asynchronous credential lookup', async () => {
    const mutable = { ...binding, scope: { ...scope } };
    const s = setup({ readBinding: async () => mutable, readCredential: async () => {
      mutable.scope.organizationId = 'other'; mutable.payer = 'customer-direct'; return 'server-secret';
    } });
    await s.collector.collect({ scope, generationId: binding.generationId });
    expect(s.append.mock.calls[0]![0]).toMatchObject({ organizationId: scope.organizationId, payer: 'consumption' });
  });
  it('rejects malformed server authority before credential lookup', async () => {
    const s = setup({ readBinding: async () => ({ ...binding, revision: 0 }) });
    await expect(s.collector.collect({ scope, generationId: binding.generationId })).rejects.toThrow(/usage receipt/);
    expect(s.readCredential).not.toHaveBeenCalled(); expect(s.fetch).not.toHaveBeenCalled();
  });
  it.each([null, '', ' key ', 'key\nInjected: header'])('refuses missing/malformed credentials %s', async secret => {
    const s = setup({ readCredential: async () => secret });
    expect(await s.collector.collect({ scope, generationId: binding.generationId })).toEqual({ outcome: 'unavailable', reason: 'missing-credential' });
    expect(s.fetch).not.toHaveBeenCalled(); expect(s.append).not.toHaveBeenCalled();
  });
  it.each([401, 404, 429, 500])('keeps HTTP %s as an unavailable read without persisting provider error text', async status => {
    const s = setup({ fetch: async () => new Response('private error server-secret', { status }) });
    expect(await s.collector.collect({ scope, generationId: binding.generationId }))
      .toEqual({ outcome: 'unavailable', reason: 'provider-http-error', status });
    expect(s.append).not.toHaveBeenCalled();
  });
  it('does not retry a failed/aborted read or surface its private error text', async () => {
    const fetch = vi.fn(async () => { throw new Error('private error server-secret'); }); const s = setup({ fetch });
    expect(await s.collector.collect({ scope, generationId: binding.generationId }))
      .toEqual({ outcome: 'unavailable', reason: 'provider-read-failed' });
    expect(fetch).toHaveBeenCalledTimes(1); expect(s.append).not.toHaveBeenCalled();
  });
  it.each([{ data: { id: 'gen-other', is_byok: false, total_cost: 1 } },
    payload(1, { is_byok: true }), { data: null }, { error: 'private', data: payload().data }])(
    'refuses wrong generation/BYOK/error envelopes', async report => {
      const s = setup({ fetch: async () => new Response(JSON.stringify(report)) });
      expect(await s.collector.collect({ scope, generationId: binding.generationId }))
        .toEqual({ outcome: 'unavailable', reason: 'invalid-provider-report' });
      expect(s.append).not.toHaveBeenCalled();
    });
  it('passes existing store conflict outcomes through and propagates a failed durable write', async () => {
    const s = setup({ append: async () => 'revision-conflict' });
    expect((await s.collector.collect({ scope, generationId: binding.generationId })).outcome).toBe('revision-conflict');
    const failed = setup({ append: async () => { throw new Error('database unavailable'); } });
    await expect(failed.collector.collect({ scope, generationId: binding.generationId })).rejects.toThrow('database unavailable');
  });
  it('rejects caller-supplied payer/cost/account fields and invalid generation selectors before I/O', async () => {
    const s = setup();
    for (const input of [
      { scope, generationId: '../generation/content' },
      { scope, generationId: binding.generationId, payer: 'platform' },
      { scope, generationId: binding.generationId, total_cost: 0 },
      { scope: { ...scope, account: 'other' }, generationId: binding.generationId },
    ]) await expect(s.collector.collect(input)).rejects.toThrow(/invalid OpenRouter usage/);
    expect(s.readBinding).not.toHaveBeenCalled(); expect(s.fetch).not.toHaveBeenCalled();
  });
});
