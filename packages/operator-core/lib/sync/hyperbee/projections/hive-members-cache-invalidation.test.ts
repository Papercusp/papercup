/**
 * hive-members-cache-invalidation.test.ts — WI-259 P-003 fast-path invalidation (su-c2a63).
 *
 * Pins the onMemberApplied hook: a hive_members apply (join/device-change) or delete (leave)
 * must invalidate the P-002 guard's cached member device set for this hive, so the next applied
 * content op re-checks membership against a FRESH set instead of waiting out the 30s TTL backstop
 * (during which a just-joined member's content would be wrongly dropped, or a just-left member's
 * wrongly applied). A cross-Hive op (slug mismatch) is dropped before apply → must NOT invalidate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

// Spy the invalidation while keeping the rest of the module real (the projection only calls
// invalidateHiveMemberDeviceSet; resolveHiveMemberDeviceSet etc. stay intact for any other importer).
vi.mock('../hive-member-identity-set', async (orig) => ({
  ...(await orig<typeof import('../hive-member-identity-set')>()),
  invalidateHiveMemberDeviceSet: vi.fn(),
}));

import { buildHiveMembersProjection, type HiveMemberRow } from './hive-members';
import { invalidateHiveMemberDeviceSet } from '../hive-member-identity-set';

// A tagged-template stand-in for postgres.Sql — records nothing, resolves empty (the projection's
// INSERT/DELETE "runs" so control reaches the post-write invalidate call).
const fakeSql = ((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve([])) as unknown as postgres.Sql;

const OPTS = { workspaceId: 'ws', harnessSlug: 'hive-home', sql: fakeSql };
const ROW: HiveMemberRow = {
  pot_home_slug: 'hive-home',
  github_user_id: 7,
  github_username: 'alice',
  device_attestations: [],
  revoked_pubkeys: [],
  binding_status: 'bound',
};

describe('WI-259 P-003 — hive_members apply invalidates the P-002 member-set cache', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a member apply (writeToPg) invalidates the (ws, hiveHome) cache', async () => {
    const proj = buildHiveMembersProjection(OPTS);
    await proj.writeToPg(ROW, { authorPubkey: 'A', origin: 'remote', ts: 1 });
    expect(invalidateHiveMemberDeviceSet).toHaveBeenCalledWith('ws', 'hive-home');
  });

  it('a member leave (deleteFromPg) invalidates the same cache', async () => {
    const proj = buildHiveMembersProjection(OPTS);
    await proj.deleteFromPg('7', 100, undefined);
    expect(invalidateHiveMemberDeviceSet).toHaveBeenCalledWith('ws', 'hive-home');
  });

  it('a cross-Hive op (slug mismatch, dropped before apply) does NOT invalidate', async () => {
    const proj = buildHiveMembersProjection(OPTS);
    await proj.writeToPg({ ...ROW, pot_home_slug: 'other-hive' }, undefined);
    expect(invalidateHiveMemberDeviceSet).not.toHaveBeenCalled();
  });

  it('an invalid delete key (non-positive id) returns before invalidating', async () => {
    const proj = buildHiveMembersProjection(OPTS);
    await proj.deleteFromPg('0', 100, undefined);
    expect(invalidateHiveMemberDeviceSet).not.toHaveBeenCalled();
  });
});
