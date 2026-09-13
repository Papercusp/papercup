/**
 * fleet-directory-publish.test.ts — the WI-2006 publish leg (P-101 wiring).
 *
 * What a regression here breaks: fleets silently stop getting directory cards
 * again (the exact built-not-wired gap WI-2006 closed), an unchanged card
 * re-federates on every launch (version churn), an archive drops the record
 * instead of publishing archived:true, or a benign no-hive/no-identity box
 * starts failing fleet writes.
 *
 * Pure DI — no PG, no keychain, no gh.
 * Run: cd packages/operator-core && npx vitest run lib/p2p/fleet-directory-publish.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import {
  describeFleetDirectoryOutcome,
  publishFleetDirectoryRecord,
  publishFleetDirectoryRecordBestEffort,
  type PublishFleetDirectoryDeps,
} from './fleet-directory-publish';
import { DEFAULT_FLEET_BILLING, type FleetDirectoryRecord } from './fleet-directory-schema';
import type { StoredFleetRecord } from './fleet-directory';

const WS = 'ws-1';
const HOME = 'hive-home';
const UID = 279242982;

const fleetRow = {
  workspaceId: WS,
  fleetSlug: 'alpha',
  title: 'Alpha Fleet',
  description: 'does alpha things',
  owner: 'su-x',
  leaderOwnerId: 'su-x',
  colorScheme: null,
  createdAt: 1,
  updatedAt: 1,
} as const;

function storedOf(record: FleetDirectoryRecord): StoredFleetRecord {
  return {
    workspaceId: WS,
    potHomeSlug: HOME,
    ownerGithubUserId: record.ownerGithubUserId,
    fleetSlug: record.fleetSlug,
    record,
    recordJson: JSON.stringify(record),
    signerDevicePubkey: 'pk',
    signature: 'sig',
    recordVersion: record.recordVersion,
    archived: record.archived,
    fedHlc: null,
    updatedAt: 2,
  };
}

const signer = { pubkey: 'pk', sign: vi.fn(async () => Buffer.from('s')) };

function deps(over: Partial<Record<keyof PublishFleetDirectoryDeps, any>> = {}): {
  d: PublishFleetDirectoryDeps;
  putRecord: ReturnType<typeof vi.fn>;
} {
  const putRecord = vi.fn(async (input: any) => ({ ok: true as const, stored: storedOf(input.record) }));
  const d: PublishFleetDirectoryDeps = {
    resolveScope: vi.fn(async () => ({ kind: 'one' as const, homeSlug: HOME })),
    resolveActor: vi.fn(async () => ({ githubUserId: UID, devicePubkey: 'pk' })),
    getFleetRow: vi.fn(async () => ({ ...fleetRow })),
    getRecord: vi.fn(async () => null),
    putRecord,
    buildSigner: vi.fn(async () => signer),
    ...over,
  };
  return { d, putRecord };
}

const OPTS = { workspaceId: WS, fleetSlug: 'alpha' };

describe('publishFleetDirectoryRecord — fail-soft gates', () => {
  it('no exactly-one shared hive → skipped, nothing authored', async () => {
    for (const scope of [{ kind: 'none' as const }, { kind: 'many' as const, candidates: ['a', 'b'] }]) {
      const { d, putRecord } = deps({ resolveScope: vi.fn(async () => scope) });
      const r = await publishFleetDirectoryRecord(OPTS, d);
      expect(r).toEqual({ ok: false, skipped: `no_single_shared_hive:${scope.kind}` });
      expect(putRecord).not.toHaveBeenCalled();
    }
  });

  it('no resolvable gh identity → skipped (never forge an owner)', async () => {
    const { d, putRecord } = deps({ resolveActor: vi.fn(async () => null) });
    expect(await publishFleetDirectoryRecord(OPTS, d)).toEqual({ ok: false, skipped: 'no_github_identity' });
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('fleet row missing and not an archive → skipped fleet_not_found', async () => {
    const { d } = deps({ getFleetRow: vi.fn(async () => null) });
    expect(await publishFleetDirectoryRecord(OPTS, d)).toEqual({ ok: false, skipped: 'fleet_not_found' });
  });
});

describe('publishFleetDirectoryRecord — authoring', () => {
  it('fresh publish: composes the card from the fleet row, version 1, owner = actor', async () => {
    const { d, putRecord } = deps();
    const r = await publishFleetDirectoryRecord(OPTS, d);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(putRecord).toHaveBeenCalledTimes(1);
    const input = putRecord.mock.calls[0]![0];
    expect(input).toMatchObject({ workspaceId: WS, potHomeSlug: HOME, selfGithubUserId: UID, signer });
    expect(input.record).toEqual({
      fleetSlug: 'alpha',
      ownerGithubUserId: UID,
      title: 'Alpha Fleet',
      description: 'does alpha things',
      tags: [],
      publisherGithubUserIds: [],
      billingDefault: DEFAULT_FLEET_BILLING,
      successorGithubUserId: null,
      offerRateCapPerHour: null,
      unclaimedOfferTtlSec: null,
      recordVersion: 1,
      archived: false,
    });
  });

  it('refresh: carries owner-authored state (publishers/tags/knobs), fleet-row meta wins, version bumps', async () => {
    const carried: FleetDirectoryRecord = {
      fleetSlug: 'alpha',
      ownerGithubUserId: UID,
      title: 'Old title',
      description: 'old desc',
      tags: ['t1'],
      publisherGithubUserIds: [7, 8],
      billingDefault: 'requester-pays',
      successorGithubUserId: 9,
      offerRateCapPerHour: 4,
      unclaimedOfferTtlSec: 60,
      recordVersion: 3,
      archived: false,
    };
    const { d, putRecord } = deps({ getRecord: vi.fn(async () => storedOf(carried)) });
    const r = await publishFleetDirectoryRecord(OPTS, d);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(putRecord.mock.calls[0]![0].record).toMatchObject({
      title: 'Alpha Fleet', // fleet row wins on meta
      description: 'does alpha things',
      tags: ['t1'], // carried
      publisherGithubUserIds: [7, 8],
      billingDefault: 'requester-pays',
      successorGithubUserId: 9,
      offerRateCapPerHour: 4,
      unclaimedOfferTtlSec: 60,
      recordVersion: 4,
    });
  });

  it('no-churn gate: identical card → ok changed:false, NO put (no version churn per launch)', async () => {
    const current: FleetDirectoryRecord = {
      fleetSlug: 'alpha',
      ownerGithubUserId: UID,
      title: 'Alpha Fleet',
      description: 'does alpha things',
      tags: [],
      publisherGithubUserIds: [],
      billingDefault: DEFAULT_FLEET_BILLING,
      successorGithubUserId: null,
      offerRateCapPerHour: null,
      unclaimedOfferTtlSec: null,
      recordVersion: 5,
      archived: false,
    };
    const stored = storedOf(current);
    const { d, putRecord } = deps({ getRecord: vi.fn(async () => stored) });
    const r = await publishFleetDirectoryRecord(OPTS, d);
    expect(r).toEqual({ ok: true, stored, changed: false });
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('archive with the fleet row already deleted: carries the record, publishes archived:true', async () => {
    const carried: FleetDirectoryRecord = {
      fleetSlug: 'alpha',
      ownerGithubUserId: UID,
      title: 'Alpha Fleet',
      description: 'x',
      tags: [],
      publisherGithubUserIds: [7],
      billingDefault: DEFAULT_FLEET_BILLING,
      successorGithubUserId: null,
      offerRateCapPerHour: null,
      unclaimedOfferTtlSec: null,
      recordVersion: 2,
      archived: false,
    };
    const { d, putRecord } = deps({
      getFleetRow: vi.fn(async () => null),
      getRecord: vi.fn(async () => storedOf(carried)),
    });
    const r = await publishFleetDirectoryRecord({ ...OPTS, archived: true }, d);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(putRecord.mock.calls[0]![0].record).toMatchObject({
      archived: true,
      recordVersion: 3,
      publisherGithubUserIds: [7],
    });
  });

  it('archive of a fleet that never had a card → skipped no_record_to_archive', async () => {
    const { d, putRecord } = deps({ getFleetRow: vi.fn(async () => null) });
    expect(await publishFleetDirectoryRecord({ ...OPTS, archived: true }, d)).toEqual({
      ok: false,
      skipped: 'no_record_to_archive',
    });
    expect(putRecord).not.toHaveBeenCalled();
  });
});

describe('publishFleetDirectoryRecord — failure passthrough', () => {
  it('putFleetRecord refusal → error passthrough', async () => {
    const { d } = deps({ putRecord: vi.fn(async () => ({ ok: false as const, error: 'stale version' })) });
    expect(await publishFleetDirectoryRecord(OPTS, d)).toEqual({ ok: false, error: 'stale version' });
  });

  it('signer failure (locked keychain) → error, fleet write unaffected by contract', async () => {
    const { d, putRecord } = deps({ buildSigner: vi.fn(async () => { throw new Error('keychain locked'); }) });
    const r = await publishFleetDirectoryRecord(OPTS, d);
    expect(r).toEqual({ ok: false, error: 'device signer unavailable: keychain locked' });
    expect(putRecord).not.toHaveBeenCalled();
  });
});

describe('EI-23024280755553126: a non-publishing directory record is never silent', () => {
  it('reports a benign skip with its reason', async () => {
    const log = vi.fn();
    const { d } = deps({ resolveActor: vi.fn(async () => null), log });
    publishFleetDirectoryRecordBestEffort(OPTS, d);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    const line = log.mock.calls[0]![0] as string;
    expect(line).toContain('NOT PUBLISHED');
    expect(line).toContain('no_github_identity');
    expect(line).toContain('fleet:alpha');
  });

  it('reports a real authoring error with its cause', async () => {
    const log = vi.fn();
    const { d } = deps({
      putRecord: vi.fn(async () => ({ ok: false as const, error: 'stale version' })),
      log,
    });
    publishFleetDirectoryRecordBestEffort(OPTS, d);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(log.mock.calls[0]![0]).toContain('stale version');
  });

  it('reports an unexpected throw while preserving the fire-and-forget contract', async () => {
    const log = vi.fn();
    const { d } = deps({
      resolveScope: vi.fn(async () => {
        throw new Error('scope lookup failed');
      }),
      log,
    });
    expect(() => publishFleetDirectoryRecordBestEffort(OPTS, d)).not.toThrow();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(log.mock.calls[0]![0]).toContain('publish THREW');
    expect(log.mock.calls[0]![0]).toContain('scope lookup failed');
  });

  it('labels successful and no-churn outcomes distinctly', () => {
    expect(describeFleetDirectoryOutcome(OPTS, { ok: true, stored: {} as never, changed: true }).msg).toContain(
      'published',
    );
    const noChurn = describeFleetDirectoryOutcome(OPTS, { ok: true, stored: {} as never, changed: false });
    expect(noChurn.msg).toContain('already current');
    expect(noChurn.level).toBe('info');
  });
});
