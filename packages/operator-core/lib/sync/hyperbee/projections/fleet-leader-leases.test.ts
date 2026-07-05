import { describe, expect, it } from 'vitest';
import {
  buildFleetLeaderLeaseProjection,
  _testing,
  type FleetLeaderLeaseWireRow,
} from './fleet-leader-leases';

const { composeKey, decodeValue, isFleetLeaderLeaseWireRow } = _testing;

const WS = 'ws-test';
const HIVE = 'hive-home';
const OWNER = 42;
const ROW: FleetLeaderLeaseWireRow = {
  harness_slug: HIVE,
  owner_github_user_id: OWNER,
  fleet_slug: 'alpha',
  device_pubkey: 'device-pubkey',
  leader_github_user_id: OWNER,
  since_ms: 1_800_000_000_000,
  roster_epoch: 3,
};

function fakeTemplateSql() {
  const calls: { text: string; vals: unknown[] }[] = [];
  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push({ text: strings.join('?'), vals });
    return Promise.resolve([]);
  }) as never;
  return { sql, calls };
}

describe('p2p fleet leader lease projection', () => {
  it('shape-guards rows and composes the generated fed key', () => {
    expect(isFleetLeaderLeaseWireRow(ROW)).toBe(true);
    expect(isFleetLeaderLeaseWireRow({ ...ROW, harness_slug: '' })).toBe(false);
    expect(isFleetLeaderLeaseWireRow({ ...ROW, owner_github_user_id: 0 })).toBe(false);
    expect(isFleetLeaderLeaseWireRow({ ...ROW, since_ms: -1 })).toBe(false);
    expect(composeKey(ROW)).toBe(`${OWNER}/alpha`);
    expect(decodeValue(ROW)).toEqual(ROW);
    expect(decodeValue({ bad: true })).toBeNull();
  });

  it('demuxes by hive home and writes with the LWW guard', async () => {
    const { sql, calls } = fakeTemplateSql();
    const p = buildFleetLeaderLeaseProjection({ workspaceId: WS, harnessSlug: HIVE, sql });
    await p.writeToPg({ ...ROW, harness_slug: 'other-hive' }, undefined);
    expect(calls.length).toBe(0);

    await p.writeToPg(ROW, { origin: 'remote', authorPubkey: 'author-pub', ts: 99, fedHlc: 'hlc' });
    expect(calls.length).toBe(1);
    expect(calls[0]!.text).toMatch(/INSERT INTO harness_shared\.p2p_fleet_leader_leases/);
    expect(calls[0]!.text).toMatch(/fed_apply_wins/);
    expect(calls[0]!.vals).toContain('author-pub');
    expect(calls[0]!.vals).toContain(99);
    expect(calls[0]!.vals).toContain('hlc');
  });

  it('delete parses fed keys defensively and LWW-guards the delete', async () => {
    const { sql, calls } = fakeTemplateSql();
    const p = buildFleetLeaderLeaseProjection({ workspaceId: WS, harnessSlug: HIVE, sql });
    await p.deleteFromPg('junk', 1, 'hlc');
    await p.deleteFromPg('/missing-owner', 1, 'hlc');
    await p.deleteFromPg('0/bad-owner', 1, 'hlc');
    expect(calls.length).toBe(0);

    await p.deleteFromPg(`${OWNER}/alpha`, 1, 'hlc');
    expect(calls.length).toBe(1);
    expect(calls[0]!.text).toMatch(/DELETE FROM harness_shared\.p2p_fleet_leader_leases/);
    expect(calls[0]!.text).toMatch(/fed_order_key/);
    expect(calls[0]!.vals).toContain(OWNER);
    expect(calls[0]!.vals).toContain('alpha');
  });
});
