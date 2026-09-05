import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  postCommerceOffer: vi.fn(),
}));

vi.mock('../../cupboard/commerce-door-gate-io', () => io);

import tool from './publish-offer';

const PER_USE_INPUT = {
  productId: 'prod-use',
  offerId: 'offer-use',
  skuRef: 'sku-use',
  title: 'Metered tool',
  pricingModel: 'per-use' as const,
  amountMinor: 0,
  currency: 'USD',
  unitPriceMicros: 25,
  meterUnit: 'tool-call',
  priceVersion: 'price-v1',
  splitManifestHash: `sha256:${'a'.repeat(64)}`,
};

function body(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe('cupboard:publish-offer agent-tool production door', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires the complete per-use term set and forbids it on provider-backed offers', () => {
    expect(tool.name).toBe('cupboard:publish-offer');
    expect(tool.capability).toBe('harness:write');
    expect(tool.args.safeParse(PER_USE_INPUT).success).toBe(true);
    expect(
      tool.args.safeParse({
        ...PER_USE_INPUT,
        splitManifestHash: undefined,
      }).success,
    ).toBe(false);
    expect(
      tool.args.safeParse({
        ...PER_USE_INPUT,
        pricingModel: 'one-time',
      }).success,
    ).toBe(false);
  });

  it('routes the exact per-use terms through the authenticated Worker transport', async () => {
    io.postCommerceOffer.mockResolvedValue({
      ok: true,
      replayed: false,
      product: { productId: 'prod-use', creatorId: 'gh:42' },
      offer: { offerId: 'offer-use', pricingModel: 'per-use' },
    });

    const result = await tool.handler(PER_USE_INPUT, {} as never);

    expect(io.postCommerceOffer).toHaveBeenCalledWith({
      productId: 'prod-use',
      offerId: 'offer-use',
      skuRef: 'sku-use',
      title: 'Metered tool',
      pricingModel: 'per-use',
      price: { amountMinor: 0, currency: 'USD' },
      perUse: {
        unitPriceMicros: 25,
        meterUnit: 'tool-call',
        priceVersion: 'price-v1',
        splitManifestHash: `sha256:${'a'.repeat(64)}`,
      },
    });
    expect(body(result)).toMatchObject({
      ok: true,
      replayed: false,
      offer: { offerId: 'offer-use', pricingModel: 'per-use' },
    });
  });

  it('preserves hosted validation evidence for the caller', async () => {
    io.postCommerceOffer.mockResolvedValue({
      ok: false,
      status: 422,
      error: 'invalid_offer',
      detail: 'missing per-use terms',
    });

    expect(body(await tool.handler(PER_USE_INPUT, {} as never))).toEqual({
      ok: false,
      error: 'invalid_offer',
      detail: 'missing per-use terms',
      status: 422,
    });
  });
});
