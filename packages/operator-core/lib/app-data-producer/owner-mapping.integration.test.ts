import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  appAudience,
  deleteAppOwnerMapping,
  listAppOwnerMappings,
  requireAppOwnerId,
  resolveAppOwnerId,
  setAppOwnerMapping,
} from './owner-mapping';

let org: OrgTestDb;
let userA: string;
let userB: string;
const WS = 'app-owner-mapping-test';

async function makeUser(label: string): Promise<string> {
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`app-owner-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, ${label})
    RETURNING id`;
  return user.id;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  userA = await makeUser('Owner A');
  userB = await makeUser('Owner B');
});

afterAll(async () => {
  for (const id of [userA, userB]) {
    if (org && id) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${id}`.catch(() => {});
  }
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.app_owner_mappings WHERE workspace_id = ${WS}`;
});

describe('app owner mapping (P-003)', () => {
  it('round-trips an explicitly configured mapping', async () => {
    const saved = await setAppOwnerMapping(org.adminSql, {
      workspaceId: WS, userId: userA, app: 'email', ownerId: 'owner-a@example.com', note: 'configured by test',
    });
    expect(saved).toMatchObject({ workspaceId: WS, userId: userA, app: 'email', ownerId: 'owner-a@example.com' });
    expect(await resolveAppOwnerId(org.adminSql, WS, userA, 'email')).toBe('owner-a@example.com');
    expect(await requireAppOwnerId(org.adminSql, WS, userA, 'email')).toBe('owner-a@example.com');
  });

  it('keeps each app independent for the same platform user', async () => {
    await setAppOwnerMapping(org.adminSql, { workspaceId: WS, userId: userA, app: 'email', ownerId: 'a-email' });
    await setAppOwnerMapping(org.adminSql, { workspaceId: WS, userId: userA, app: 'calendar', ownerId: 'a-calendar' });
    expect(await resolveAppOwnerId(org.adminSql, WS, userA, 'email')).toBe('a-email');
    expect(await resolveAppOwnerId(org.adminSql, WS, userA, 'calendar')).toBe('a-calendar');
  });

  // The core P-003 requirement. An unmapped user must produce NOTHING, loudly —
  // never a plausible-looking fallback such as the platform uuid, which would
  // deliver real data to a subject nobody can authenticate as.
  it('never infers an owner: resolve returns null and require throws', async () => {
    expect(await resolveAppOwnerId(org.adminSql, WS, userB, 'email')).toBeNull();
    await expect(requireAppOwnerId(org.adminSql, WS, userB, 'email'))
      .rejects.toThrow(`app_owner_mapping_required:email:${userB}`);
  });

  // Assert the ABSENCE of the tempting fallback explicitly — a test that only
  // checks the happy path cannot tell "no mapping" from "silently used the uuid".
  it('does not fall back to the platform user id', async () => {
    const resolved = await resolveAppOwnerId(org.adminSql, WS, userB, 'email');
    expect(resolved).not.toBe(userB);
    expect(resolved).toBeNull();
  });

  // THE CROSS-TENANT LEAK P-003 EXISTS TO PREVENT. Two platform users mapped to
  // one app owner would merge their data inside that app's store, with no error
  // to read anywhere. The unique constraint makes it structurally impossible.
  it('refuses to point a second platform user at an app owner already taken', async () => {
    await setAppOwnerMapping(org.adminSql, { workspaceId: WS, userId: userA, app: 'email', ownerId: 'shared-owner' });
    await expect(setAppOwnerMapping(org.adminSql, {
      workspaceId: WS, userId: userB, app: 'email', ownerId: 'shared-owner',
    })).rejects.toThrow('app_owner_mapping_owner_taken:email:shared-owner');
    // The original mapping survives the rejected write.
    expect(await resolveAppOwnerId(org.adminSql, WS, userA, 'email')).toBe('shared-owner');
    expect(await resolveAppOwnerId(org.adminSql, WS, userB, 'email')).toBeNull();
  });

  // The same owner id in a DIFFERENT app is a different tenant space entirely.
  it('allows the same owner id across different apps', async () => {
    await setAppOwnerMapping(org.adminSql, { workspaceId: WS, userId: userA, app: 'email', ownerId: 'same-id' });
    await expect(setAppOwnerMapping(org.adminSql, {
      workspaceId: WS, userId: userB, app: 'calendar', ownerId: 'same-id',
    })).resolves.toMatchObject({ ownerId: 'same-id', app: 'calendar' });
  });

  it('re-points an existing user to a new app owner', async () => {
    await setAppOwnerMapping(org.adminSql, { workspaceId: WS, userId: userA, app: 'email', ownerId: 'old-owner' });
    await setAppOwnerMapping(org.adminSql, { workspaceId: WS, userId: userA, app: 'email', ownerId: 'new-owner' });
    expect(await resolveAppOwnerId(org.adminSql, WS, userA, 'email')).toBe('new-owner');
    expect(await listAppOwnerMappings(org.adminSql, WS, 'email')).toHaveLength(1);
  });

  it('scopes mappings by workspace', async () => {
    await setAppOwnerMapping(org.adminSql, { workspaceId: WS, userId: userA, app: 'email', ownerId: 'ws-scoped' });
    expect(await resolveAppOwnerId(org.adminSql, `${WS}-other`, userA, 'email')).toBeNull();
    await org.adminSql`DELETE FROM harness_shared.app_owner_mappings WHERE workspace_id = ${`${WS}-other`}`;
  });

  it('lists the producer work list, and deletes', async () => {
    await setAppOwnerMapping(org.adminSql, { workspaceId: WS, userId: userA, app: 'email', ownerId: 'a' });
    await setAppOwnerMapping(org.adminSql, { workspaceId: WS, userId: userB, app: 'email', ownerId: 'b' });
    expect(await listAppOwnerMappings(org.adminSql, WS, 'email')).toHaveLength(2);
    expect(await deleteAppOwnerMapping(org.adminSql, WS, userA, 'email')).toBe(true);
    expect(await deleteAppOwnerMapping(org.adminSql, WS, userA, 'email')).toBe(false);
    expect(await listAppOwnerMappings(org.adminSql, WS, 'email')).toHaveLength(1);
  });

  it('rejects an unknown app rather than storing an undeliverable mapping', async () => {
    await expect(setAppOwnerMapping(org.adminSql, {
      workspaceId: WS, userId: userA, app: 'chat', ownerId: 'x',
    })).rejects.toThrow('app_owner_mapping_unknown_app:chat');
    await expect(resolveAppOwnerId(org.adminSql, WS, userA, 'chat'))
      .rejects.toThrow('app_owner_mapping_unknown_app:chat');
  });

  it('rejects a non-uuid platform user id', async () => {
    await expect(setAppOwnerMapping(org.adminSql, {
      workspaceId: WS, userId: 'not-a-uuid', app: 'email', ownerId: 'x',
    })).rejects.toThrow('app_owner_mapping_user_id_invalid');
  });

  it('rejects a blank owner id', async () => {
    await expect(setAppOwnerMapping(org.adminSql, {
      workspaceId: WS, userId: userA, app: 'email', ownerId: '   ',
    })).rejects.toThrow('app_owner_mapping_owner_id_required');
  });

  // Pinned against the audiences the apps actually verify in
  // apps/sidecar/src/auth.ts — the JWT P-004 mints must match these exactly.
  it('derives the audience each app verifies', () => {
    expect(appAudience('email')).toBe('papercusp-email');
    expect(appAudience('calendar')).toBe('papercusp-calendar');
  });
});
