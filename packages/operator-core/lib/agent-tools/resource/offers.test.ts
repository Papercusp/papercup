/**
 * offers.test.ts — pot-seat-pools-prose-ux-2026-07-18 P-013: `toSummaryRow`,
 * the pure projection `resource:offers` returns to the chat surface.
 *
 * Pure — no PG, no mocks needed.
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/resource/offers.test.ts
 */
import { describe, expect, it } from 'vitest';
import { toSummaryRow } from './offers';
import type { StoredWorkOffer } from '../../p2p/offer-store';
import type { WorkOfferStoreRecord } from '../../p2p/offer-store-schema';

function seatOffer(over: {
  publisherGithubUserId: number;
  fleetSlug?: string | null;
  potSlug?: string | null;
  hostLabel?: string | null;
  audience?: 'trusted-members' | 'whole-pot' | null;
  count?: number;
}): StoredWorkOffer {
  const record: WorkOfferStoreRecord = {
    offerId: `seat-${over.publisherGithubUserId}`,
    publisherGithubUserId: over.publisherGithubUserId,
    fleetSlug: over.fleetSlug ?? null,
    potSlug: over.potSlug ?? 'hive-home',
    kind: 'seat',
    status: 'open',
    cancelReason: null,
    workOffer: null,
    authorship: null,
    seat: {
      model: 'sonnet',
      effort: 'high',
      count: over.count ?? 3,
      accountScope: 'auto',
      hostLabel: over.hostLabel ?? null,
      audience: over.audience ?? null,
    },
    spawnRequest: null,
    recordVersion: 1,
  };
  return {
    workspaceId: 'ws-1',
    potHomeSlug: 'hive-home',
    publisherGithubUserId: record.publisherGithubUserId,
    offerId: record.offerId,
    record,
    recordJson: JSON.stringify(record),
    signerDevicePubkey: 'pk',
    signature: 'sig',
    recordVersion: 1,
    fleetSlug: record.fleetSlug,
    potSlug: record.potSlug,
    offerKind: record.kind,
    status: record.status,
    localDisposition: null,
    fedHlc: null,
    updatedAt: 1,
  };
}

describe('resource:offers toSummaryRow', () => {
  it('projects a seat offer to the summary shape, carrying hostLabel through', () => {
    const row = seatOffer({ publisherGithubUserId: 1, hostLabel: 'box-b', audience: 'whole-pot', count: 5 });
    expect(toSummaryRow(row)).toEqual({
      offerId: 'seat-1',
      hostLabel: 'box-b',
      model: 'sonnet',
      effort: 'high',
      count: 5,
      fleetSlug: null,
      audience: 'whole-pot',
    });
  });

  it('hostLabel/audience stay null when the donor never set them — never invented', () => {
    const row = seatOffer({ publisherGithubUserId: 2 });
    const out = toSummaryRow(row);
    expect(out?.hostLabel).toBeNull();
    expect(out?.audience).toBeNull();
  });

  it('a fleet-scoped offer carries its fleetSlug through', () => {
    const row = seatOffer({ publisherGithubUserId: 3, fleetSlug: 'alpha', potSlug: null });
    expect(toSummaryRow(row)?.fleetSlug).toBe('alpha');
  });

  it('returns null for a non-seat / unparsed record instead of throwing', () => {
    expect(toSummaryRow({ ...seatOffer({ publisherGithubUserId: 4 }), record: null })).toBeNull();
    const workKind = { ...seatOffer({ publisherGithubUserId: 5 }) };
    workKind.record = { ...workKind.record!, kind: 'work', seat: null };
    expect(toSummaryRow(workKind)).toBeNull();
  });
});
