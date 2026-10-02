import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getDatatype, upsertDatatype } from '../datatype-registry-store';
import { ingestExternalTriggerEvent } from './ingestion';
import { syncFacebookPersonalVaultSource } from './facebook';
import { createOwnedExternalTriggerSource, getExternalTriggerSource } from './source-store';

const WS = 'facebook-personal-vault-adapter-test';
const FIRST_NOW = new Date('2026-08-23T04:00:00.000Z');
const SECOND_NOW = new Date('2026-08-23T04:15:00.000Z');
let org: OrgTestDb;
let sql: Sql;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const users = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'facebook-owner-' + Date.now()}, 'Facebook Owner')
    RETURNING id`;
  userId = users[0].id;
  const socialType = await getDatatype(sql, 'papercusp-workspace', 'social-post');
  if (!socialType) throw new Error('facebook_test_datatype_missing');
  await upsertDatatype(sql, {
    id: socialType.id,
    workspaceId: WS,
    potSlug: socialType.potSlug,
    title: socialType.title,
    description: socialType.description,
    tier: socialType.tier,
    nature: socialType.nature,
    audience: socialType.audience,
    workItemKind: socialType.workItemKind,
    payloadSchema: socialType.payloadSchema,
    authoritativeWriter: socialType.authoritativeWriter,
    selfImprovement: socialType.selfImprovement,
    published: socialType.published,
    tags: socialType.tags,
    createdBy: 'facebook-integration',
  });
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
});

describe('Facebook adapter with the real delivery ledger and Personal Vault sink', () => {
  it('seeds the active durable poll routine on the registered system action', async () => {
    const rows = await sql<Array<{
      target_role: string;
      trigger_config: Record<string, unknown>;
      active: boolean;
      tier: string;
    }>>`
      SELECT target_role, trigger_config, active, tier
        FROM harness_shared.routines
       WHERE install_slug = 'papercusp'
         AND name = 'facebook-personal-vault-poll'`;
    expect(rows).toEqual([{
      target_role: 'system:facebook-personal-vault-poll',
      trigger_config: { cron: '45 */15 * * * *' },
      active: true,
      tier: 'durable',
    }]);
  });

  it('persists the since cursor and dedupes replayed provider entities into private documents', async () => {
    const source = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'facebook',
      ownerUserId: userId,
      providerAccountId: 'profile-1',
      credentialRef: 'facebook-personal-vault:owner-1',
      status: 'ready',
    });
    const otherAccount = await createOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'facebook',
      ownerUserId: userId,
      providerAccountId: 'profile-2',
      credentialRef: 'facebook-personal-vault:owner-2',
      status: 'connected',
      cursor: { since: '2026-08-22T00:00:00.000Z', keep: 'other-account' },
    });
    const responses = [
      { id: 'profile-1', name: 'Owner', about: 'Private profile context' },
      { data: [{ id: 'post-1', message: 'Launch update', created_time: '2026-08-23T03:00:00.000Z', from: { name: 'Owner' } }] },
      { data: [{ id: 'photo-1', name: 'Launch photo', created_time: '2026-08-23T03:30:00.000Z', picture: 'https://images.test/photo.jpg' }] },
    ];
    let call = 0;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(responses[call++ % responses.length]))) as unknown as typeof fetch;
    const emit = vi.fn(async (opts: { key: string }) => ({
      ok: true as const,
      key: opts.key,
      woken: 0,
      notified: [],
      msgId: null,
      waiters: 0,
    }));
    let now = FIRST_NOW;
    const deps = {
      fetch: fetchImpl,
      now: () => now,
      apiOrigin: 'https://graph.test',
      ingest: (db: Sql, input: Parameters<typeof ingestExternalTriggerEvent>[1]) =>
        ingestExternalTriggerEvent(db, input, { emit }),
    };

    await expect(syncFacebookPersonalVaultSource(sql, source, 'access-token', deps)).resolves.toMatchObject({
      profile: 1, posts: 1, photos: 1, since: FIRST_NOW.toISOString(),
    });
    const advanced = await getExternalTriggerSource(sql, WS, source.id);
    expect(advanced).toMatchObject({
      status: 'connected',
      cursor: { since: FIRST_NOW.toISOString(), lastSyncAt: FIRST_NOW.toISOString(), profileId: 'profile-1' },
    });
    await expect(getExternalTriggerSource(sql, WS, otherAccount.id)).resolves.toMatchObject({
      providerAccountId: 'profile-2',
      credentialRef: 'facebook-personal-vault:owner-2',
      cursor: { since: '2026-08-22T00:00:00.000Z', keep: 'other-account' },
    });
    now = SECOND_NOW;
    await expect(syncFacebookPersonalVaultSource(sql, advanced!, 'access-token', deps)).resolves.toMatchObject({
      profile: 1, posts: 1, photos: 1, since: SECOND_NOW.toISOString(),
    });

    const documents = await sql<Array<{
      source: string;
      kind: string;
      external_id: string;
      title: string;
    }>>`
      SELECT source, kind, external_id, title
        FROM harness_shared.documents
       WHERE workspace_id = ${WS} AND user_id = ${userId}
       ORDER BY kind, external_id`;
    expect(documents).toEqual([
      expect.objectContaining({ source: 'facebook', kind: 'photo', external_id: 'photo-1', title: 'Launch photo' }),
      expect.objectContaining({ source: 'facebook', kind: 'post', external_id: 'post-1', title: 'Facebook post' }),
      expect.objectContaining({ source: 'facebook', kind: 'profile', external_id: 'profile-1', title: 'Owner' }),
    ]);

    const deliveries = await sql<Array<{ event_key: string; sink_kind: string; attempts: number }>>`
      SELECT event_key, sink_kind, attempts
        FROM harness_shared.trigger_deliveries
       WHERE workspace_id = ${WS} AND source_id = ${source.id}::uuid
       ORDER BY event_key, sink_kind`;
    expect(deliveries).toHaveLength(9);
    expect(deliveries.map((row) => row.event_key)).toEqual(expect.arrayContaining([
      'ext:facebook:profile.synced',
      'ext:facebook:post.synced',
      'ext:facebook:photo.synced',
    ]));
    expect(deliveries.every((row) => row.attempts === 1)).toBe(true);
    expect(emit).toHaveBeenCalledTimes(3);
  });
});
