import { describe, expect, it } from 'vitest';
import {
  buildProductionSupervisionDeps,
  productionLivenessInput,
  productionOriginLastSeenAt,
} from './foreign-supervision-production';
import type { ForeignWorkspace } from './foreign-workspaces';

const NOW = 1_000_000;
const WORKSPACE_ID = 'ws-1';
const HIVE = 'papercup-hive';

function ws(over: Partial<ForeignWorkspace> = {}): ForeignWorkspace {
  return {
    workspaceId: WORKSPACE_ID,
    offerId: 'offer-1',
    fleetSlug: 'fleet-a',
    originGithubUserId: 42,
    executorDevice: 'dev-host',
    rootPath: '/foreign/offer-1',
    clonePath: '/foreign/offer-1/repo',
    sessionId: 'sess-9',
    executionEpoch: 0,
    state: 'active',
    parkReason: null,
    baseSha: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 5_000,
    ...over,
  };
}

/** A fake sql that's BOTH a callable tagged-template (queryFederatedPresenceRows)
 *  AND carries an `.unsafe()` method (getWorkOffer / offer-store.ts's `pg().unsafe`
 *  pattern) — the two shapes the two production reads need. */
function fakeSql(opts: { offerRows?: Array<Record<string, unknown>>; presenceRows?: Array<Record<string, unknown>> }) {
  const fn = ((_strings: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.resolve(opts.presenceRows ?? [])) as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
    unsafe: (query: string, params?: unknown[]) => Promise<unknown>;
  };
  fn.unsafe = (_query: string, _params?: unknown[]) => Promise.resolve(opts.offerRows ?? []);
  return fn as never;
}

function offerRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    workspace_id: WORKSPACE_ID,
    harness_slug: HIVE,
    publisher_github_user_id: 42,
    offer_id: 'offer-1',
    record_json: '{}',
    signer_device_pubkey: 'pub',
    signature: 'sig',
    record_version: 1,
    fleet_slug: 'fleet-a',
    pot_slug: null,
    offer_kind: 'work',
    status: 'open',
    local_disposition: null,
    fed_hlc: null,
    updated_at: NOW - 5_000,
    ...over,
  };
}

describe('productionLivenessInput (H12)', () => {
  it('an open offer: not cancelled, lastConfirmedAt = the ForeignWorkspace row updatedAt', async () => {
    const sql = fakeSql({ offerRows: [offerRow({ status: 'open' })] });
    const read = productionLivenessInput({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE, sql });
    const out = await read(ws({ updatedAt: NOW - 12_345 }));
    expect(out.cancelSignalSeen).toBe(false);
    expect(out.lastConfirmedAt).toBe(NOW - 12_345);
  });

  it('a cancelled offer: cancelSignalSeen true', async () => {
    const sql = fakeSql({ offerRows: [offerRow({ status: 'cancelled' })] });
    const read = productionLivenessInput({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE, sql });
    const out = await read(ws());
    expect(out.cancelSignalSeen).toBe(true);
  });

  it('a vanished offer (no row): treated as cancelled (nothing left to confirm against)', async () => {
    const sql = fakeSql({ offerRows: [] });
    const read = productionLivenessInput({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE, sql });
    const out = await read(ws());
    expect(out.cancelSignalSeen).toBe(true);
  });
});

describe('productionOriginLastSeenAt (H13)', () => {
  it('returns the MAX last_seen_ms across every machine for that github_user_id', async () => {
    const sql = fakeSql({
      presenceRows: [
        { workspace_id: WORKSPACE_ID, harness_slug: HIVE, pot_slug: HIVE, github_user_id: 42, machine_label: 'a', device_pubkey: 'p1', intent: null, current_view: null, last_seen_ms: NOW - 30_000 },
        { workspace_id: WORKSPACE_ID, harness_slug: HIVE, pot_slug: HIVE, github_user_id: 42, machine_label: 'b', device_pubkey: 'p2', intent: null, current_view: null, last_seen_ms: NOW - 5_000 },
        { workspace_id: WORKSPACE_ID, harness_slug: HIVE, pot_slug: HIVE, github_user_id: 999, machine_label: 'c', device_pubkey: 'p3', intent: null, current_view: null, last_seen_ms: NOW },
      ],
    });
    const read = productionOriginLastSeenAt({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE, sql });
    expect(await read(42)).toBe(NOW - 5_000);
  });

  it('no matching presence rows: null (H13 fail-closed — the caller orphans it)', async () => {
    const sql = fakeSql({ presenceRows: [] });
    const read = productionOriginLastSeenAt({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE, sql });
    expect(await read(42)).toBeNull();
  });
});

describe('buildProductionSupervisionDeps', () => {
  it('composes both reads into one SupervisionDeps-shaped object', async () => {
    const sql = fakeSql({
      offerRows: [offerRow({ status: 'open' })],
      presenceRows: [{ workspace_id: WORKSPACE_ID, harness_slug: HIVE, pot_slug: HIVE, github_user_id: 42, machine_label: 'a', device_pubkey: 'p1', intent: null, current_view: null, last_seen_ms: NOW - 1_000 }],
    });
    const deps = buildProductionSupervisionDeps({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE, sql });
    expect(await deps.livenessInput(ws())).toEqual({ cancelSignalSeen: false, lastConfirmedAt: ws().updatedAt });
    expect(await deps.originLastSeenAt(42)).toBe(NOW - 1_000);
  });
});
