/**
 * enterprise-data-sources P-013 / D-010, BAR R-7 (spec AUTO-BAR-R-7-P-013):
 * "A trigger reads its connector configuration from its data-source record."
 *
 * Under D-010 the data-source record IS the `harness_shared.data_sources` row
 * (migration 1317 extended it in place), so there are no separate trigger-only
 * columns that could be nulled while a copy survives elsewhere. The proof is
 * therefore behavioural: run the REAL Gmail poll trigger (`runGoogleGmailPoll`)
 * against real Postgres with only the provider I/O stubbed, keeping the default
 * source-store reads and writes, and show that
 *   1. the connector configuration the trigger hands to its provider calls
 *      (credential_ref, cursor, config) is exactly the data-source record's;
 *   2. a change made to the record (credential rotation) is what the next fire uses;
 *   3. clearing the record's credential takes the source out of the trigger's
 *      poll set: there is no second copy it could still run from;
 *   4. the trigger's own status write lands on the same record and leaves the
 *      1317 ingestion-policy columns intact.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  createOwnedExternalTriggerSource,
  getDataSourceRecord,
  upsertOwnedExternalTriggerSource,
  type ExternalTriggerSourceRow,
} from '../external-triggers/source-store';
import { runGoogleGmailPoll, type GoogleGmailPollDeps } from '../harness/routines/google-gmail-poll-action';

const WS = 'data-source-record-trigger-test';
const EMAIL = 'data-source-owner@example.com';
const WATCH_EXPIRES = '2099-01-01T00:00:00.000Z';
const CTX = { workspaceId: WS, installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null };

let org: OrgTestDb;
let sql: Sql;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const users = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'data-source-record-owner-' + Date.now()}, 'Data Source Owner')
    RETURNING id`;
  userId = users[0].id;
});

afterAll(async () => {
  if (sql) await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`.catch(() => {});
  if (sql && userId) await sql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
});

interface ProviderCall {
  step: 'auth' | 'watch';
  sourceId: string;
  credentialRef: string | null;
  cursor: Record<string, unknown>;
  config: Record<string, unknown>;
}

/** Provider-side stubs only: every source-store read and write stays the real one. */
function providerStubs() {
  const calls: ProviderCall[] = [];
  const seen = (step: ProviderCall['step'], source: ExternalTriggerSourceRow) =>
    calls.push({
      step,
      sourceId: source.id,
      credentialRef: source.credentialRef,
      cursor: source.cursor,
      config: source.config,
    });
  const resolveAccessToken = vi.fn(async (source: ExternalTriggerSourceRow) => {
    seen('auth', source);
    return `token-for:${source.credentialRef}`;
  });
  const ensureWatch = vi.fn(async (_sql: unknown, current: ExternalTriggerSourceRow, accessToken: string) => {
    seen('watch', current);
    expect(accessToken).toBe(`token-for:${current.credentialRef}`);
    return {
      renewed: false,
      emailAddress: EMAIL,
      historyId: String(current.cursor.historyId),
      expiration: WATCH_EXPIRES,
      source: current,
    };
  });
  const syncSource = vi.fn(async () => {
    throw new Error('a cursored, fully backfilled mailbox must not run a sync on an empty doorbell pull');
  });
  const deps: GoogleGmailPollDeps = {
    sql,
    resolveAccessToken,
    provision: vi.fn(async () => ({
      projectId: 'project',
      subscriptionId: 'subscription',
      topicName: 'projects/project/topics/shared',
      subscriptionName: 'projects/project/subscriptions/subscription',
      topic: 'existing' as const,
      subscription: 'existing' as const,
      publisherGrant: 'existing' as const,
    })),
    ensureWatch,
    ensureFlagshipBinding: vi.fn(),
    syncSource,
    pull: vi.fn(async () => []),
    acknowledge: vi.fn(async () => 0),
  };
  return { deps, calls, resolveAccessToken };
}

async function createGmailDataSource(credentialRef: string): Promise<string> {
  const source = await createOwnedExternalTriggerSource(sql, {
    workspaceId: WS,
    kind: 'gmail',
    ownerUserId: userId,
    providerAccountId: EMAIL,
    credentialRef,
    status: 'ready',
    config: { emailAddress: EMAIL, labelIds: ['INBOX'] },
    cursor: { emailAddress: EMAIL, historyId: 'history-100', watchExpiration: WATCH_EXPIRES },
  });
  // Ingestion policy written on the same row, as a data-source writer would.
  await sql`
    UPDATE harness_shared.data_sources
       SET sync_mode = 'poll',
           scope_mapping = ${JSON.stringify({ labels: ['INBOX'] })}::text::jsonb
     WHERE workspace_id = ${WS} AND id = ${source.id}::uuid`;
  return source.id;
}

describe('a trigger reads its connector configuration from its data-source record (P-013 R-7)', () => {
  it('runs the Gmail poll trigger from the record and writes its status back onto the same record', async () => {
    const sourceId = await createGmailDataSource('google-workspace:record-v1');
    const before = await getDataSourceRecord(sql, WS, sourceId);
    expect(before).toMatchObject({
      kind: 'gmail',
      status: 'ready',
      syncMode: 'poll',
      scope: 'personal',
      scopeMapping: { labels: ['INBOX'] },
    });

    const { deps, calls } = providerStubs();
    const result = await runGoogleGmailPoll(CTX, deps);

    expect(result).toMatchObject({ sources: 1, succeeded: 1, failed: 0, failures: [] });
    // Every provider call received exactly the record's connector configuration.
    expect(calls.map((c) => c.step)).toEqual(['auth', 'watch']);
    for (const call of calls) {
      expect(call).toEqual({
        step: call.step,
        sourceId,
        credentialRef: before!.credentialRef,
        cursor: before!.cursor,
        config: before!.config,
      });
    }

    // The trigger's state transition landed on the data-source record itself,
    // and the ingestion policy it does not own was left untouched.
    const after = await getDataSourceRecord(sql, WS, sourceId);
    expect(after).toMatchObject({
      id: sourceId,
      status: 'connected',
      credentialRef: 'google-workspace:record-v1',
      syncMode: 'poll',
      scope: 'personal',
      scopeMapping: { labels: ['INBOX'] },
      datatypeMappings: before!.datatypeMappings,
      destinationPolicy: before!.destinationPolicy,
      retentionPolicy: before!.retentionPolicy,
      permissionMapping: before!.permissionMapping,
    });
  });

  it('uses a credential rotated on the record at the next fire', async () => {
    const sourceId = await createGmailDataSource('google-workspace:record-v1');
    await runGoogleGmailPoll(CTX, providerStubs().deps);

    // Re-consent rotates the credential on the record (the real writer); the cursor survives.
    await upsertOwnedExternalTriggerSource(sql, {
      workspaceId: WS,
      kind: 'gmail',
      ownerUserId: userId,
      providerAccountId: EMAIL,
      credentialRef: 'google-workspace:record-v2',
    });
    const rotated = await getDataSourceRecord(sql, WS, sourceId);
    expect(rotated).toMatchObject({ credentialRef: 'google-workspace:record-v2' });

    const second = providerStubs();
    await runGoogleGmailPoll(CTX, second.deps);
    expect(second.calls.map((c) => [c.step, c.sourceId, c.credentialRef])).toEqual([
      ['auth', sourceId, 'google-workspace:record-v2'],
      ['watch', sourceId, 'google-workspace:record-v2'],
    ]);
    expect(second.calls[0].cursor).toEqual(rotated!.cursor);
  });

  it('has no second copy to run from: clearing the record credential stops the trigger', async () => {
    const sourceId = await createGmailDataSource('google-workspace:record-v1');
    await sql`
      UPDATE harness_shared.data_sources
         SET credential_ref = NULL
       WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
    expect(await getDataSourceRecord(sql, WS, sourceId)).toMatchObject({ credentialRef: null });

    const { deps, calls, resolveAccessToken } = providerStubs();
    const result = await runGoogleGmailPoll(CTX, deps);

    expect(result).toMatchObject({ sources: 0, succeeded: 0, failed: 0 });
    expect(resolveAccessToken).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
