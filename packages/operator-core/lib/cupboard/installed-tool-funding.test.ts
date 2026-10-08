import { describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { Sql } from 'postgres';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import type { InstalledPluginProvenance } from './types';
import type { AttachedInstalledToolFunding } from '../agent-tools/per-use-chokepoint';
import { INSTALLED_TOOL_FUNDING_CONFIG, productionInstalledToolFunding } from './installed-tool-funding';
import type { HostedPerUseOffer } from './metered-invocation-door-io';

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function fixture() {
  const session = { workspaceId: 'ws', ownerId: 'su-buyer', principalId: 'system:superuser' };
  const pairs = { payer: generateKeyPairSync('ed25519'), seller: generateKeyPairSync('ed25519') };
  const pubkey = (party: keyof typeof pairs) => pairs[party].publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const provenance = { schema: 'papercusp.plugin-installation/v1', name: 'paid', version: '1.0.0',
    listing: { skuRef: 'sku:paid@1.0.0', publisherId: 'gh:9', releaseVersion: '1.0.0' },
    contentFingerprint: 'sha256:' + 'a'.repeat(64), contentSource: 'r2', hadListing: true } as InstalledPluginProvenance;
  const offer: HostedPerUseOffer = { offerId: 'offer', productId: 'product', skuRef: provenance.listing.skuRef!,
    creatorId: 'gh:9', active: true, productActive: true, terms: { meterUnit: 'tool-call', unitPriceMicros: 250,
      priceVersion: 'price-v1', splitManifestHash: 'sha256:' + 'b'.repeat(64) } };
  const grant = { ...session, skuRef: offer.skuRef, offerId: offer.offerId, productId: offer.productId,
    provenanceHash: digest(provenance), termsHash: digest(offer.terms),
    payer: { principal: 'gh:7', credentialRef: 'buyer-token', hiveSlug: 'payer', pubkeyBase64: pubkey('payer') },
    seller: { principal: 'gh:9', credentialRef: 'seller-token', hiveSlug: 'seller', pubkeyBase64: pubkey('seller') },
    quantityPerTurn: 4, maxMicrosPerTurn: '1000', expiresAtMs: 5000 };
  const keys: Record<string, string> = { 'buyer-token': 'buyer-secret-fixture', 'seller-token': 'seller-secret-fixture' };
  const requests: Array<{ path: string; token: string }> = [];
  let channelKey = grant.payer.pubkeyBase64, channelOwner = 'gh:7', channelState = 'open', escrow = 1500;
  const host: AttachedInstalledToolFunding['host'] = { admit: vi.fn(), localTurn: vi.fn(), complete: vi.fn() };
  const createHost = vi.fn((_deps: ConstructorParameters<typeof import('./funded-turn-host').FundedToolTurnHost>[0]) => host);
  const deps = { workspaceId: () => 'ws', nowMs: () => 1000, sql: async () => ({} as Sql),
    readKey: vi.fn(async (key: string) => key === INSTALLED_TOOL_FUNDING_CONFIG
      ? JSON.stringify({ schema: 'papercusp.installed-tool-funding/v1', grants: [grant] }) : keys[key]),
    readFunding: vi.fn(async () => new Map([[offer.skuRef, { skuRef: offer.skuRef, channelId: 'channel',
      pricingState: null, pricingOfferId: null, pricingUnitMicros: null, pricingCheckedAtMs: null }]])),
    readKeyStatus: vi.fn(async (_workspace: string, hive: string) => ({ kind: 'ok' as const, pubkeyBase64: pubkey(hive as keyof typeof pairs) })),
    sign: async (_workspace: string, hive: string, bytes: Buffer) => sign(null, bytes, pairs[hive as keyof typeof pairs].privateKey),
    createHost };
  // Exercise the real hosted principal and channel readers, including their
  // identity/key checks. Neither reader receives an invocation-authored payer.
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, token = new Headers(init?.headers).get('authorization')!.slice(7);
    requests.push({ path, token });
    if (path === '/commerce/entitlements') return Response.json({ buyer: token === keys['buyer-token'] ? 'gh:7' : 'gh:9', entitlements: [] });
    return Response.json({ channel: { channelId: 'channel', principalId: channelOwner, state: channelState,
      payerPubkeyBase64: channelKey, escrowMicros: escrow, committedMicros: 0 } });
  });
  // The production transport uses global fetch; restore it after each operation
  // so one case cannot silently donate credentials to another case.
  const run = async <T>(work: () => Promise<T>) => {
    const original = globalThis.fetch; globalThis.fetch = fetchImpl as typeof fetch;
    try { return await work(); } finally { globalThis.fetch = original; }
  };
  const input = { context: { workspaceId: 'ws', ownerId: 'su-buyer', nativeSessionId: 'native', ownerTurnId: 'turn' },
    installation: { name: 'paid', version: '1.0.0', path: '/installed/paid' }, provenance };
  const resolve = async () => {
    const funding = await productionInstalledToolFunding(session, deps);
    if (!funding) throw new Error('expected configured funding');
    const capability = await funding.resolveInstallation(input);
    return { funding, capability };
  };
  return { session, pairs, grant, keys, offer, input, deps, requests, createHost, run, resolve,
    changeChannel: (change: { key?: string; owner?: string; state?: string; escrow?: number }) => {
      channelKey = change.key ?? channelKey; channelOwner = change.owner ?? channelOwner;
      channelState = change.state ?? channelState; escrow = change.escrow ?? escrow;
    } };
}

describe('production installed funding with independent seller credentials', () => {
  it('provisions distinct hosted principals, signing keys and an exact budgeted channel route', async () => {
    const f = fixture();
    await f.run(async () => {
      const { capability } = await f.resolve();
      expect(await capability.resolvePayer!()).toBe('gh:7');
      expect(await capability.resolveFunding(f.offer)).toEqual({ channelId: 'channel', quantityCeiling: 4n, expiresAtMs: 5000 });
      expect(f.requests.map(row => row.token)).toEqual(['buyer-secret-fixture', 'seller-secret-fixture', 'buyer-secret-fixture']);
      const bound = f.createHost.mock.calls[0]![0];
      expect(bound.payerTransport.authToken).toBe(f.keys['buyer-token']);
      expect(bound.sellerTransport.authToken).toBe(f.keys['seller-token']);
      const bytes = Buffer.from('exact canonical signing challenge');
      expect(await bound.signVoucher(bytes)).not.toEqual(await bound.signReceipt(bytes));
    });
  });

  it('missing configuration grants no funding and reads no credentials', async () => {
    const readKey = vi.fn(async () => undefined);
    expect(await productionInstalledToolFunding(fixture().session, { workspaceId: () => 'ws', readKey })).toBeUndefined();
    expect(readKey).toHaveBeenCalledExactlyOnceWith(INSTALLED_TOOL_FUNDING_CONFIG);
  });

  it.each(['workspaceId', 'ownerId', 'principalId', 'provenanceHash'] as const)('refuses a grant with another %s', async field => {
    const f = fixture(); f.grant[field] = field === 'provenanceHash' ? 'f'.repeat(64) : 'other';
    await f.run(() => expect(f.resolve()).rejects.toThrow('exact-grant-required'));
    expect(f.requests).toHaveLength(0); expect(f.createHost).not.toHaveBeenCalled();
  });

  it.each(['credentialRef', 'pubkeyBase64', 'principal'] as const)('refuses the buyer as seller through the same %s', async field => {
    const f = fixture(); f.grant.seller[field] = f.grant.payer[field];
    await f.run(() => expect(f.resolve()).rejects.toThrow('independent-seller-required'));
    expect(f.requests).toHaveLength(0);
  });

  it('refuses missing or aliased seller tokens instead of falling back to the buyer', async () => {
    const f = fixture(); delete f.keys['seller-token'];
    await f.run(() => expect(f.resolve()).rejects.toThrow('independent-credentials-required'));
    f.keys['seller-token'] = f.keys['buyer-token']!;
    await f.run(() => expect(f.resolve()).rejects.toThrow('independent-credentials-required'));
  });

  it('refuses an independently stored token that authenticates as a different seller', async () => {
    const f = fixture(); f.grant.seller.principal = 'gh:10';
    await f.run(() => expect(f.resolve()).rejects.toThrow('credential-principal-mismatch'));
  });

  it('refuses a signer key that differs from the authorized seller key', async () => {
    const f = fixture(); f.grant.seller.pubkeyBase64 = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    await f.run(() => expect(f.resolve()).rejects.toThrow('signing-key-mismatch'));
  });

  it.each([{ key: 'wrong-key' }, { owner: 'gh:8' }, { state: 'closed' }, { escrow: 999 }])('refuses stale or insufficient hosted channel state %j', async change => {
    const f = fixture(); f.changeChannel(change);
    await f.run(async () => {
      const { capability } = await f.resolve();
      await expect(capability.resolveFunding(f.offer)).rejects.toThrow('channel-unavailable');
    });
    expect(f.createHost).not.toHaveBeenCalled();
  });

  it('refuses changed published price terms even while the channel can cover them', async () => {
    const f = fixture();
    await f.run(async () => {
      const { capability } = await f.resolve();
      await expect(capability.resolveFunding({ ...f.offer, terms: { ...f.offer.terms, priceVersion: 'new' } })).rejects.toThrow('offer-grant-mismatch');
    });
    expect(f.deps.readFunding).not.toHaveBeenCalled();
  });

  it('does not turn a stored channel or expired grant into spend authority', async () => {
    const f = fixture(); f.grant.maxMicrosPerTurn = '999';
    await f.run(async () => {
      const { capability } = await f.resolve();
      await expect(capability.resolveFunding(f.offer)).rejects.toThrow('budget-exceeded');
    });
    f.grant.expiresAtMs = 1000;
    await f.run(() => expect(f.resolve()).rejects.toThrow('grant-expired'));
  });
});
