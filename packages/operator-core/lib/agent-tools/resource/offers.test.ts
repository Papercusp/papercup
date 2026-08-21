/**
 * offers.test.ts — pot-seat-pools-prose-ux-2026-07-18 P-013: `toSummaryRow`,
 * the pure projection `resource:offers` returns to the chat surface. Also
 * EI-16673: the handler's multi-hive `hive` disambiguation (previously
 * `resource:offers` had NO way to disambiguate a multi-hive workspace, so
 * `potShared` could never resolve to true on one).
 *
 * The `toSummaryRow` suite is pure — no PG, no mocks needed. The handler suite
 * mocks identity/scope/store.
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/resource/offers.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredWorkOffer } from '../../p2p/offer-store';
import type { WorkOfferStoreRecord } from '../../p2p/offer-store-schema';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ workspaceId: 'ws-1' })),
}));
vi.mock('../coordination/federation-scope', async () => {
  const actual = await vi.importActual<typeof import('../coordination/federation-scope')>(
    '../coordination/federation-scope',
  );
  return { ...actual, resolveWorkspaceHiveScope: vi.fn() };
});
vi.mock('../../p2p/offer-store', async (orig) => ({
  ...(await orig<typeof import('../../p2p/offer-store')>()),
  listOffers: vi.fn(async () => []),
}));

import { resolveAgentIdentity } from '../coordination/identity';
import { resolveWorkspaceHiveScope } from '../coordination/federation-scope';
import { listOffers } from '../../p2p/offer-store';

const identM = vi.mocked(resolveAgentIdentity);
const scopeM = vi.mocked(resolveWorkspaceHiveScope);
const listM = vi.mocked(listOffers);

const mod = await import('./offers');
const { toSummaryRow } = mod;
const tool = mod.default;

type Out = { data: Record<string, unknown> };
const call = (args: Record<string, unknown> = {}) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => o.data;

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

  it('returns null for a spawn-request / unparsed record instead of throwing', () => {
    expect(toSummaryRow({ ...seatOffer({ publisherGithubUserId: 4 }), record: null })).toBeNull();
    const spawnRequest = { ...seatOffer({ publisherGithubUserId: 5 }) };
    spawnRequest.record = {
      ...spawnRequest.record!,
      fleetSlug: 'alpha',
      potSlug: null,
      kind: 'spawn_request',
      seat: null,
      spawnRequest: {
        targetPublisherGithubUserId: 6,
        targetOfferId: 'seat-6',
        count: 1,
        planSlug: 'plan-alpha',
        requesterOwnerId: 'su-owner',
        requestedAtMs: 1,
        launchContext: null,
      },
    };
    expect(toSummaryRow(spawnRequest)).toBeNull();
  });
});

describe('resource:offers handler — multi-hive `hive` disambiguation (EI-16673)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    identM.mockReturnValue({ workspaceId: 'ws-1' } as never);
    listM.mockResolvedValue([]);
  });

  it('no workspace resolvable → potShared:false, rows:[] (never throws)', async () => {
    identM.mockReturnValue({ workspaceId: null } as never);
    const b = body(await call());
    expect(b).toEqual({ ok: true, potShared: false, rows: [] });
    expect(scopeM).not.toHaveBeenCalled();
  });

  it('exactly one shared hive resolves alone (today\'s pre-fix behavior, unchanged)', async () => {
    scopeM.mockResolvedValue({ kind: 'one', homeSlug: 'the-hive' });
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, potShared: true, rows: [] });
    expect(listM.mock.calls[0]?.[1]).toBe('the-hive');
  });

  it('MULTI-hive + no `hive` arg → THE BUG, now fixed: potShared:false with candidates surfaced (never silently empty)', async () => {
    scopeM.mockResolvedValue({ kind: 'many', candidates: ['hive-a', 'hive-b'] });
    const b = body(await call());
    expect(b.ok).toBe(true);
    expect(b.potShared).toBe(false);
    expect(b.rows).toEqual([]);
    expect(b.candidates).toEqual(['hive-a', 'hive-b']);
    expect(b.hiveError).toEqual(expect.any(String));
    expect(listM).not.toHaveBeenCalled();
  });

  it('MULTI-hive + explicit `hive` naming one of the shared hives now resolves it (the fix)', async () => {
    scopeM.mockResolvedValue({ kind: 'many', candidates: ['hive-a', 'hive-b'] });
    const b = body(await call({ hive: 'hive-b' }));
    expect(b).toMatchObject({ ok: true, potShared: true, rows: [] });
    expect(listM.mock.calls[0]?.[1]).toBe('hive-b');
  });

  it('an explicit `hive` NOT in the shared set is refused, never silently accepted', async () => {
    scopeM.mockResolvedValue({ kind: 'many', candidates: ['hive-a', 'hive-b'] });
    const b = body(await call({ hive: 'not-shared' }));
    expect(b).toMatchObject({ ok: true, potShared: false, rows: [], candidates: ['hive-a', 'hive-b'] });
    expect(listM).not.toHaveBeenCalled();
  });

  it('no shared hive at all → potShared:false, no candidates key', async () => {
    scopeM.mockResolvedValue({ kind: 'none' });
    const b = body(await call());
    expect(b.ok).toBe(true);
    expect(b.potShared).toBe(false);
    expect(b.candidates).toBeUndefined();
  });

  it('threads fleetSlug and potSlug through to the store filter', async () => {
    scopeM.mockResolvedValue({ kind: 'one', homeSlug: 'the-hive' });
    await call({ fleetSlug: 'f1', potSlug: 'p1' });
    expect(listM.mock.calls[0]?.[2]).toMatchObject({ fleetSlug: 'f1', potSlug: 'p1' });
  });
});
