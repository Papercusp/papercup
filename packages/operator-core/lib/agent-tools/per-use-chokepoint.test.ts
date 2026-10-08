import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDispatchStack, type ProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';
import { admitInstalledPerUseToolTurn, createInstalledPerUseChokepoint, type AdmittedPerUseToolTurn } from './per-use-chokepoint';
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
