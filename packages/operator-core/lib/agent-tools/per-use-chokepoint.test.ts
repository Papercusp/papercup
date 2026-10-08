import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { runDispatchStack, type ProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';
import { admitInstalledPerUseToolTurn, createInstalledPerUseChokepoint, NativeInstalledPerUseTurns,
  nativeInstalledPerUseTurns, type AdmittedPerUseToolTurn } from './per-use-chokepoint';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import type { FundedToolTurnBinding, FundedToolTurnResult } from '../cupboard/funded-tool-turn-store';
import { PROJECTED_DEPS } from '../projected-tool-deps';
import { readInstalledPluginProvenance } from '../cupboard/install-plugin-core';
import type { InstalledPluginProvenance } from '../cupboard/types';
import { declareMeter, LocalMeteredTurn, type LocalMeteredTurnState } from '../p2p/metered-invocation';
import { createMicrochargeChannel } from '../p2p/microcharge';
import { signPaymentTestBytes } from '../p2p/_payment-voucher-fixture';
import invokeTool, { NestedToolRefusalError } from './tools/invoke';
import type { ToolResult } from '@papercusp/tooldef';

vi.mock('../cupboard/install-plugin-core', () => ({ readInstalledPluginProvenance: vi.fn() }));

const terms = { unitPriceMicros: 250, meterUnit: 'tool-call', priceVersion: 'v1',
  splitManifestHash: `sha256:${'a'.repeat(64)}` };
const provenance: InstalledPluginProvenance = {
  schema: 'papercusp.plugin-installation/v1', name: 'paid-plugin', version: '1.0.0',
  contentFingerprint: 'b'.repeat(64), hadListing: true, contentSource: 'r2',
  listing: { listingId: 'listing-paid', githubUrl: 'https://github.com/seller/tool', ref: '.',
    publisherId: 'gh:4242', skuRef: 'opaque-paid-sku', releaseVersion: '1.0.0',
    priceModel: 'per-use', releaseContentHash: 'c'.repeat(64) },
};
const ctx = (): UnifiedToolContext => ({ log: vi.fn(), signal: new AbortController().signal,
  progress: vi.fn(), emit: vi.fn(), workspaceId: 'workspace', role: 'worker',
  principal: { slug: 'target-agent', workspaceId: 'workspace', trust: 'verified', capabilities: new Set() },
}) as UnifiedToolContext;
const tool = (fn = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'served' }] }))): ProjectedTool => ({
  pluginName: provenance.name, pluginInstallation: { version: provenance.version, path: '/loaded/plugin', source: 'project' },
  description: 'paid tool', capabilities: [], inputSchema: { type: 'object' },
  expose: { mcp: { name: 'paid.run' }, http: { path: '/api/plugins/paid/run' } }, fn,
});

describe('trusted observed native call lookup', () => {
  const fp = (value: string) => createHash('sha256').update(value).digest('hex');
  function nativeFixture(registry = new NativeInstalledPerUseTurns()) {
    const { authority, turn } = admitted();
    const binding: FundedToolTurnBinding = { kind: 'tool', workspaceId: 'workspace', ownerId: 'host-owner',
      principalId: 'target-agent', executionId: 'native-session', admissionId: 'owner-turn',
      provenanceHash: fp(canonicalJson(provenance)), payer: authority.payer, seller: authority.offer.creatorId,
      channelId: 'funded-channel', offer: authority.offer, quantityCeiling: 4n, expiresAtMs: 10_000 };
    const input = { workspaceId: 'workspace', ownerId: 'host-owner', principalId: 'target-agent',
      nativeSessionId: 'native-session', ownerTurnId: 'owner-turn', advSessionId: 7,
      mcpServer: 'papercusp-su', nativeTools: { paid_run: 'paid.run', tools_invoke: 'tools:invoke' },
      admissions: [{ ok: true as const, admission: authority, turnId: 'host-turn', binding }] };
    const context = ctx();
    Object.assign(context, { advSessionId: 7, uiClientId: 'host-owner',
      requestOrigin: { transport: 'mcp', nativeSession: { carrier: 'meta:threadId', binding: 'bound',
        valueFingerprint: fp('native-session'), callIdFingerprint: fp('native-call'), candidateAdvSessionId: 7 } } });
    const hooks = registry.register(input);
    const observation = { nativeTurnId: 'native-turn', callId: 'native-call', server: 'papercusp-su', tool: 'paid_run' };
    const aroundInvoke = createInstalledPerUseChokepoint({ readProvenance: async () => provenance,
      resolveAdmittedTurn: request => registry.resolve(request) });
    const observe = async (changes: Partial<typeof observation> = {}) => {
      await hooks.bindNativeTurn('native-turn');
      await hooks.observeToolCall!({ ...observation, ...changes });
    };
    return { registry, input, context, hooks, observe, observation, aroundInvoke, turn };
  }

  it('production consumes the exact observed native call once across different dispatch nonces', async () => {
    const f = nativeFixture(nativeInstalledPerUseTurns);
    vi.mocked(readInstalledPluginProvenance).mockResolvedValue(provenance);
    try {
      await f.observe();
      const target = tool();
      expect((await execute(target, PROJECTED_DEPS.aroundInvoke, {}, f.context)).result?.isError).not.toBe(true);
      expect((await execute(target, PROJECTED_DEPS.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
      expect(target.fn).toHaveBeenCalledOnce();
      expect(Object.values(f.turn.snapshot().units)).toHaveLength(1);
      expect(Object.keys(f.turn.snapshot().units)[0]).not.toBe('native-call');
    } finally { await f.hooks.withdraw(); }
  });

  it('native metadata and forged arguments without a trusted observation grant no execution', async () => {
    const f = nativeFixture(), target = tool(); await f.hooks.bindNativeTurn('native-turn');
    const result = await execute(target, f.aroundInvoke, { funded: true, callId: 'native-call', entitled: true }, f.context);
    expect(result.result?.isError).toBe(true); expect(target.fn).not.toHaveBeenCalled();
    expect(f.turn.snapshot().units).toEqual({});
  });

  it.each(['binding', 'carrier', 'session', 'call', 'adv-session', 'context-adv-session', 'owner', 'principal', 'workspace', 'trust']) (
    'refuses changed %s lineage without consuming the original observation', async kind => {
      const f = nativeFixture(); await f.observe();
      const changed = { ...f.context, principal: { ...f.context.principal! },
        requestOrigin: { ...f.context.requestOrigin!, nativeSession: { ...f.context.requestOrigin!.nativeSession! } } };
      const native = changed.requestOrigin.nativeSession;
      if (kind === 'binding') native.binding = 'unbound';
      if (kind === 'carrier') native.carrier = 'header:x-papercusp-native-session';
      if (kind === 'session') native.valueFingerprint = fp('other-session');
      if (kind === 'call') native.callIdFingerprint = fp('other-call');
      if (kind === 'adv-session') native.candidateAdvSessionId = 8;
      if (kind === 'context-adv-session') changed.advSessionId = 8;
      if (kind === 'owner') changed.uiClientId = 'other-owner';
      if (kind === 'principal') changed.principal.slug = 'other-agent';
      if (kind === 'workspace') changed.workspaceId = 'other-workspace';
      if (kind === 'trust') changed.principal.trust = 'unverified-loopback';
      const target = tool();
      expect((await execute(target, f.aroundInvoke, {}, changed)).result?.isError).toBe(true);
      expect(target.fn).not.toHaveBeenCalled();
      expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).not.toBe(true);
      expect(target.fn).toHaveBeenCalledOnce();
    });

  it('does not associate a foreign MCP server or unknown tool with the funded host', async () => {
    const f = nativeFixture(), target = tool();
    await f.observe({ server: 'other-server' }); await f.observe({ tool: 'unknown' });
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
    expect(target.fn).not.toHaveBeenCalled();
    await f.observe();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).not.toBe(true);
  });

  it('requires the exact native turn before observations and refuses rebinding', async () => {
    const f = nativeFixture();
    await expect(f.hooks.observeToolCall!(f.observation)).rejects.toThrow('original active bound turn');
    await f.hooks.bindNativeTurn('native-turn');
    await expect(f.hooks.observeToolCall!({ ...f.observation, nativeTurnId: 'other-turn' })).rejects.toThrow('original active bound turn');
    await expect(f.hooks.bindNativeTurn('other-turn')).rejects.toThrow('original bound turn');
    await f.observe();
    await expect(f.hooks.observeToolCall!({ ...f.observation, tool: 'tools_invoke' })).rejects.toThrow('changed its target');
  });

  it('direct target observation cannot authorize another target or an indirect dispatch', async () => {
    const f = nativeFixture(); await f.observe();
    const target = tool();
    const other = await runDispatchStack(target, 'paid.other', {}, f.context, { aroundInvoke: f.aroundInvoke });
    expect(other.result?.isError).toBe(true);
    expect((await execute(target, f.aroundInvoke, {}, { ...f.context, indirectDispatch: true })).result?.isError).toBe(true);
    expect(target.fn).not.toHaveBeenCalled();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).not.toBe(true);
  });

  it('tools:invoke observation grants one indirect funded target and cannot be reused', async () => {
    const f = nativeFixture(); await f.observe({ tool: 'tools_invoke' });
    const target = tool();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
    const outer = { ...f.context, dispatchTool: async (_name: string, args: unknown) =>
      (await execute(target, f.aroundInvoke, args, { ...f.context, indirectDispatch: true })).result! };
    const wrapper = invokeTool as unknown as { handler(args: { name: string }, context: UnifiedToolContext): Promise<ToolResult> };
    expect((await wrapper.handler({ name: 'paid.run' }, outer)).isError).not.toBe(true);
    await expect(wrapper.handler({ name: 'paid.run' }, outer)).rejects.toBeInstanceOf(NestedToolRefusalError);
    expect(target.fn).toHaveBeenCalledOnce();
  });

  it('parallel duplicate requests elect only one dispatch', async () => {
    const f = nativeFixture(), target = tool(); await f.observe();
    const results = await Promise.all([execute(target, f.aroundInvoke, {}, f.context), execute(target, f.aroundInvoke, {}, f.context)]);
    expect(results.filter(result => result.result?.isError === true)).toHaveLength(1);
    expect(target.fn).toHaveBeenCalledOnce();
  });

  it('retains call consumption across duplicate observations', async () => {
    const f = nativeFixture(), target = tool(); await f.observe();
    await execute(target, f.aroundInvoke, {}, f.context); await f.observe();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
    expect(target.fn).toHaveBeenCalledOnce();
  });

  it('withdraws lookup authority synchronously and refuses a late observation', async () => {
    const f = nativeFixture(); await f.observe();
    let release!: () => void;
    const stopped = new Promise<void>(resolve => { release = resolve; });
    const stop = vi.spyOn(f.turn, 'stopAdmission').mockImplementation(() => stopped);
    const withdrawing = f.hooks.withdraw(), target = tool();
    expect(() => f.registry.register(f.input)).toThrow('already has a host admission');
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
    await expect(f.hooks.observeToolCall!(f.observation)).rejects.toThrow('original active bound turn');
    expect(target.fn).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledOnce();
    release(); await withdrawing;
  });

  it('failed durable revocation does not restore lookup authority', async () => {
    const f = nativeFixture(); await f.observe();
    vi.spyOn(f.turn, 'stopAdmission').mockRejectedValue(new Error('storage unavailable'));
    await expect(f.hooks.withdraw()).rejects.toThrow('storage unavailable');
    expect(() => f.registry.register(f.input)).toThrow('already has a host admission');
    const target = tool();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
    expect(target.fn).not.toHaveBeenCalled();
  });

  it('copies original authority and catalog terms rather than retaining mutable caller objects', async () => {
    const f = nativeFixture();
    Object.assign(f.input.admissions[0]!.admission, { payer: 'forged-payer' });
    Object.assign(f.input.admissions[0]!.binding, { executionId: 'other-session' });
    f.input.nativeTools.paid_run = 'paid.other';
    await f.observe();
    const target = tool();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).not.toBe(true);
    expect(target.fn).toHaveBeenCalledOnce();
    expect(Object.values(f.turn.snapshot().units)[0]!.voucher.payer).toBe('authenticated-buyer');
  });

  it.each(['owner', 'session', 'admission', 'principal', 'provenance', 'terms', 'turn']) (
    'rejects registration that borrows a funded %s binding', kind => {
      const f = nativeFixture();
      const input = { ...f.input, nativeSessionId: 'second-session',
        admissions: [{ ...f.input.admissions[0]!, binding: { ...f.input.admissions[0]!.binding, executionId: 'second-session' } }] };
      const b = input.admissions[0]!.binding;
      if (kind === 'owner') b.ownerId = 'other-owner';
      if (kind === 'session') b.executionId = 'other-session';
      if (kind === 'admission') b.admissionId = 'other-admission';
      if (kind === 'principal') b.principalId = 'other-agent';
      if (kind === 'provenance') b.provenanceHash = 'd'.repeat(64);
      if (kind === 'terms') b.offer = { ...b.offer, terms: { ...b.offer.terms, unitPriceMicros: 1 } };
      if (kind === 'turn') input.admissions[0]!.turnId = 'other-turn';
      expect(() => f.registry.register(input)).toThrow('original funded installation');
    });

  it('rejects a concurrent admission for the same native execution', () => {
    const f = nativeFixture();
    expect(() => f.registry.register(f.input)).toThrow('already has a host admission');
  });
});

describe('host-owned installed tool admission composition', () => {
  function fixture(entitled = true) {
    const { authority, turn } = admitted();
    const admit = vi.fn(async (binding: FundedToolTurnBinding): Promise<FundedToolTurnResult> => ({ ok: true,
      turn: { turnId: 'host-turn', accountId: 'account', revision: 2, state: 'running', binding,
        fundingReceipt: null, meterState: turn.snapshot(), usageEventKeys: null, closedAtMs: null, settlementOutbox: null } }));
    const localTurn = vi.fn(() => turn), readProvenance = vi.fn(async () => structuredClone(provenance));
    const resolvePayer = vi.fn(async () => authority.payer);
    const resolveFunding = vi.fn(async () => ({ channelId: 'bound-channel', quantityCeiling: 4n, expiresAtMs: 10_000 }));
    const fetchImpl = vi.fn<typeof fetch>(async url => String(url).includes('/commerce/offers')
      ? Response.json({ offers: [{ ...authority.offer, pricingModel: 'per-use', perUse: terms }] })
      : Response.json({ buyer: authority.payer, entitlements: entitled
        ? [{ buyer_id: authority.payer, product_id: authority.offer.productId, state: 'active', revoked_at_ms: null }] : [] }));
    const input = { host: { admit, localTurn }, payerTransport: { baseUrl: 'https://cupboard.test', authToken: 'host-auth', fetchImpl },
      context: { workspaceId: authority.workspaceId, principalId: authority.principalId,
        ownerId: 'authenticated-owner', executionId: 'native-session', admissionId: 'host-turn-identity' },
      installation: { name: provenance.name, version: provenance.version, path: '/loaded/plugin' },
      resolvePayer, resolveFunding, readProvenance };
    return { input, admit, localTurn, fetchImpl, readProvenance, resolvePayer, resolveFunding };
  }

  it('binds hosted provenance, authenticated buyer and exact offer before requesting turn funding', async () => {
    const f = fixture(), result = await admitInstalledPerUseToolTurn(f.input);
    expect(result).toMatchObject({ ok: true, turnId: 'host-turn', admission: { payer: 'authenticated-buyer', entitled: true } });
    expect(f.readProvenance).toHaveBeenCalledWith(f.input.installation);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.resolveFunding).toHaveBeenCalledWith(admitted().authority.offer);
    expect(f.admit).toHaveBeenCalledWith({ ...f.input.context, kind: 'tool', payer: 'authenticated-buyer', seller: 'gh:4242',
      channelId: 'bound-channel', quantityCeiling: 4n, expiresAtMs: 10_000, offer: admitted().authority.offer,
      provenanceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(f.localTurn).toHaveBeenCalledOnce();
  });

  it('uses the hosted bearer payer when the host supplies no organization resolver', async () => {
    const f = fixture();
    const { resolvePayer: _unused, ...input } = f.input;
    f.fetchImpl.mockImplementation(async url => String(url).includes('/commerce/offers')
      ? Response.json({ offers: [{ ...admitted().authority.offer, pricingModel: 'per-use', perUse: terms }] })
      : Response.json({ buyer: 'gh:1001', entitlements: [{ buyer_id: 'gh:1001', product_id: 'product', state: 'active', revoked_at_ms: null }] }));
    expect(await admitInstalledPerUseToolTurn(input)).toMatchObject({ ok: true, admission: { payer: 'gh:1001' } });
    expect(f.admit.mock.calls[0]?.[0].payer).toBe('gh:1001');
    expect(f.resolvePayer).not.toHaveBeenCalled();
    expect(String(f.fetchImpl.mock.calls[1]?.[0])).toBe('https://cupboard.test/commerce/entitlements');
  });

  it('refuses an unverified hosted self principal before funding', async () => {
    const f = fixture();
    const { resolvePayer: _unused, ...input } = f.input;
    expect(await admitInstalledPerUseToolTurn(input)).toMatchObject({ ok: false, code: 'invalid_entitlements' });
    expect(f.resolveFunding).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
  });

  it('refuses revoked entitlement before funding resolution or monetary admission', async () => {
    const f = fixture(false);
    expect(await admitInstalledPerUseToolTurn(f.input)).toMatchObject({ ok: false, code: 'tool-entitlement-required' });
    expect(f.resolveFunding).not.toHaveBeenCalled();
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.localTurn).not.toHaveBeenCalled();
  });

  it('refuses a token read for another buyer before funding resolution', async () => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async url => String(url).includes('/commerce/offers')
      ? Response.json({ offers: [{ ...admitted().authority.offer, pricingModel: 'per-use', perUse: terms }] })
      : Response.json({ buyer: 'someone-else', entitlements: [] }));
    expect(await admitInstalledPerUseToolTurn(f.input)).toMatchObject({ ok: false, code: 'invalid_entitlements' });
    expect(f.resolveFunding).not.toHaveBeenCalled();
    expect(f.admit).not.toHaveBeenCalled();
  });

  it('preserves a hosted funding refusal rather than manufacturing an admitted local handle', async () => {
    const f = fixture(); f.admit.mockResolvedValue({ ok: false, code: 'funding-not-confirmed', detail: 'no authoritative reservation' });
    expect(await admitInstalledPerUseToolTurn(f.input)).toMatchObject({ ok: false, code: 'funding-not-confirmed' });
    expect(f.localTurn).not.toHaveBeenCalled();
  });
});

function admitted(overrides: Partial<LocalMeteredTurnState> = {}) {
  const declared = declareMeter(terms);
  if (!declared.ok) throw new Error(declared.detail);
  let persisted: LocalMeteredTurnState | undefined;
  const turn = new LocalMeteredTurn({ state: { turnId: 'host-turn', payer: 'authenticated-buyer',
    seller: 'gh:4242', releaseRef: 'opaque-paid-sku', meter: declared.meter, ceilingMicros: 1_000n,
    expiresAtMs: 10_000, reservedMicros: 0n, channel: createMicrochargeChannel('funded-channel', 2_000n),
    units: {}, ...overrides }, nowMs: () => 1_000, signVoucher: signPaymentTestBytes,
    signReceipt: () => 'seller-signature', persist: async (state) => { persisted = state; } });
  const authority: AdmittedPerUseToolTurn = { kind: 'per-use', workspaceId: 'workspace', principalId: 'target-agent',
    payer: 'authenticated-buyer',
    provenance: structuredClone(provenance), offer: { offerId: 'offer', productId: 'product',
      skuRef: 'opaque-paid-sku', creatorId: 'gh:4242', active: true, productActive: true, terms },
    entitled: true, turn };
  return { authority, turn, persisted: () => persisted };
}
const execute = (target: ProjectedTool, aroundInvoke = PROJECTED_DEPS.aroundInvoke, input: unknown = {}, context = ctx()) =>
  runDispatchStack(target, 'paid.run', input, context, { aroundInvoke });

afterEach(() => vi.resetAllMocks());

describe('installed per-use shared chokepoint', () => {
  it('production refuses an installed paid tool before dispatch, including forged funding arguments', async () => {
    vi.mocked(readInstalledPluginProvenance).mockResolvedValue(provenance);
    const target = tool();
    const result = await execute(target, undefined, { entitled: true, payer: 'authenticated-buyer', funded: true });
    expect(result.result).toMatchObject({ isError: true });
    expect(JSON.parse((result.result!.content[0] as { text: string }).text).error).toBe('funded_tool_turn_required');
    expect(target.fn).not.toHaveBeenCalled();
    expect(readInstalledPluginProvenance).toHaveBeenCalledWith({ name: 'paid-plugin', version: '1.0.0', path: '/loaded/plugin' });
  });

  it('refuses unreadable installation provenance before the handler', async () => {
    vi.mocked(readInstalledPluginProvenance).mockRejectedValue(new Error('loaded bytes changed'));
    const target = tool();
    expect((await execute(target)).result).toMatchObject({ isError: true });
    expect(target.fn).not.toHaveBeenCalled();
  });

  it.each([null, { slug: 'target-agent', workspaceId: 'workspace', capabilities: new Set<string>(), trust: 'unverified-loopback' as const }])(
    'refuses an unauthenticated target', async (principal) => {
      const target = tool();
      const lookup = vi.fn(() => admitted().authority);
      const context = ctx(); context.principal = principal;
      expect((await execute(target, createInstalledPerUseChokepoint({ readProvenance: async () => provenance,
        resolveAdmittedTurn: lookup }), {}, context)).result).toMatchObject({ isError: true });
      expect(lookup).not.toHaveBeenCalled(); expect(target.fn).not.toHaveBeenCalled();
    });

  it.each(['principal', 'workspace', 'payer', 'provenance', 'entitlement', 'publisher', 'sku', 'terms', 'meter-unit', 'seller', 'release']) (
    'refuses changed %s before serving', async (kind) => {
      const { authority } = admitted(kind === 'seller' ? { seller: 'other' } : kind === 'release' ? { releaseRef: 'other' } : {});
      const changed = { ...authority };
      if (kind === 'principal') changed.principalId = 'outer-wrapper';
      if (kind === 'workspace') changed.workspaceId = 'other';
      if (kind === 'payer') changed.payer = 'another-buyer';
      if (kind === 'provenance') changed.provenance = { ...provenance, contentFingerprint: 'd'.repeat(64) };
      if (kind === 'entitlement') changed.entitled = false;
      if (kind === 'publisher') changed.offer = { ...authority.offer, creatorId: 'other' };
      if (kind === 'sku') changed.offer = { ...authority.offer, skuRef: 'other' };
      if (kind === 'terms') changed.offer = { ...authority.offer, terms: { ...terms, priceVersion: 'other' } };
      if (kind === 'meter-unit') changed.offer = { ...authority.offer, terms: { ...terms, meterUnit: 'seconds' } };
      const target = tool();
      const result = await execute(target, createInstalledPerUseChokepoint({ readProvenance: async () => provenance,
        resolveAdmittedTurn: () => changed }));
      expect(result.result).toMatchObject({ isError: true }); expect(target.fn).not.toHaveBeenCalled();
    });

  it('persists one reservation before serving and awaits exactly one local settlement', async () => {
    const { authority, persisted, turn } = admitted();
    const target = tool(vi.fn(async () => {
      expect(Object.keys(persisted()!.channel.reservations)).toHaveLength(1);
      return { content: [{ type: 'text' as const, text: 'served' }] };
    }));
    const lookup = vi.fn((_request: Parameters<ReturnType<typeof createInstalledPerUseChokepoint>>[0]) => authority);
    const result = await execute(target, createInstalledPerUseChokepoint({ readProvenance: async () => provenance,
      resolveAdmittedTurn: lookup }));
    expect(result.result?.isError).not.toBe(true); expect(target.fn).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]![0].ctx.principal?.slug).toBe('target-agent');
    const entries = Object.values(turn.snapshot().units);
    expect(entries).toHaveLength(1); expect(entries[0]!.receipt?.amountMicros).toBe(250n);
    expect(persisted()!.channel.committedMicros).toBe(250n);
  });

  it('settles a thrown handler and refuses a depleted turn before another handler', async () => {
    const { authority, turn } = admitted({ ceilingMicros: 250n });
    const aroundInvoke = createInstalledPerUseChokepoint({ readProvenance: async () => provenance,
      resolveAdmittedTurn: () => authority });
    const throwing = tool(vi.fn(async () => { throw new Error('handler failed'); }));
    expect((await execute(throwing, aroundInvoke)).error?.code).toBe('handler_error');
    expect(Object.values(turn.snapshot().units)[0]!.receipt?.amountMicros).toBe(250n);
    const next = tool();
    expect((await execute(next, aroundInvoke)).result).toMatchObject({ isError: true });
    expect(next.fn).not.toHaveBeenCalled();
  });

  it('passes built-in and unmanaged/free installations through without funding lookup', async () => {
    const lookup = vi.fn();
    const aroundInvoke = createInstalledPerUseChokepoint({ readProvenance: async () => null, resolveAdmittedTurn: lookup });
    const builtIn = tool(); delete builtIn.pluginInstallation;
    const local = tool();
    await execute(builtIn, aroundInvoke); await execute(local, aroundInvoke);
    expect(builtIn.fn).toHaveBeenCalledTimes(1); expect(local.fn).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('requires hosted classification even when an editable receipt claims free pricing', async () => {
    const free = { ...provenance, listing: { ...provenance.listing, priceModel: 'free' as const } };
    const target = tool();
    const refused = await execute(target, createInstalledPerUseChokepoint({ readProvenance: async () => free }));
    expect(refused.result).toMatchObject({ isError: true }); expect(target.fn).not.toHaveBeenCalled();
    await execute(target, createInstalledPerUseChokepoint({ readProvenance: async () => free,
      resolveAdmittedTurn: () => ({ kind: 'free', workspaceId: 'workspace', principalId: 'target-agent', provenance: free }) }));
    expect(target.fn).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('tools:invoke reaches the same target-bound paid seat (admitted=%s)', async (funded) => {
    const { authority, turn } = admitted();
    const target = tool();
    const aroundInvoke = createInstalledPerUseChokepoint({ readProvenance: async () => provenance,
      resolveAdmittedTurn: () => funded ? authority : null });
    const outer = ctx(); outer.principal = { ...outer.principal!, slug: 'synthesized-wrapper' };
    outer.dispatchTool = async (name, input) => {
      expect(name).toBe('paid.run');
      const result = await execute(target, aroundInvoke, input);
      return result.result!;
    };
    const wrapper = invokeTool as unknown as { handler(args: { name: string; args?: Record<string, unknown> },
      context: UnifiedToolContext): Promise<ToolResult> };
    const result = wrapper.handler({ name: 'paid.run', args: { entitled: true } }, outer);
    if (funded) {
      expect((await result).isError).not.toBe(true); expect(target.fn).toHaveBeenCalledTimes(1);
      expect(Object.values(turn.snapshot().units)).toHaveLength(1);
      expect(Object.values(turn.snapshot().units)[0]!.receipt?.amountMicros).toBe(250n);
    } else {
      await expect(result).rejects.toBeInstanceOf(NestedToolRefusalError);
      expect(target.fn).not.toHaveBeenCalled(); expect(turn.snapshot().units).toEqual({});
    }
  });
});
