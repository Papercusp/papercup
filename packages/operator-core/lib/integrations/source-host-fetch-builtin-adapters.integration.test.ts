/**
 * WI-10006541 regression — a process that has never served an OAuth route must
 * still resolve first-party (Google) source tokens through the production
 * host.fetch.
 *
 * The connector sync driver failed every Google source with
 * `host.fetch: no access token for source "…"` because the google-workspace
 * connection adapter was registered only by the OAuth start/callback routes.
 * This file deliberately imports NO OAuth route module: importing one registers
 * the built-in adapters as a side effect, which is exactly what hid the defect
 * from connection-lifecycle.integration.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { ProviderAdapter, ProviderDescriptor } from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { GOOGLE_WORKSPACE_OAUTH_PLUGIN } from '../external-triggers/google-workspace';
import { connectionAdapterForPlugin } from './connection-lifecycle';
import { providerRegistry } from './provider-registry';
import { createSourceHostFetch } from './source-host-fetch';

const WS = 'source-host-fetch-builtin-test';
const HARNESS = 'papercusp';
const PLUGIN_NAME = 'source-host-fetch-builtin-test-plugin';
const PROVIDER_ID = 'gcal';
const FIELD = 'owner-fixture-account';
const STORED_TOKEN = 'stored-google-access-token';

const descriptor: ProviderDescriptor = {
  id: PROVIDER_ID,
  contractVersion: 1,
  datatypes: ['calendar-event'],
  capabilities: ['calendar.read'],
  egressHosts: ['www.googleapis.com', 'accounts.google.com', 'oauth2.googleapis.com'],
  oauth: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    pkce: true,
  },
};

const adapter: ProviderAdapter = {
  describe: () => descriptor,
  syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
  invoke: async () => ({ ok: true }),
};

let org: OrgTestDb;
let sql: Sql;
let home: string;
let previousHome: string | undefined;
let sourceId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;

  previousHome = process.env.PAPERCUSP_HOME;
  home = await fs.mkdtemp(join(tmpdir(), 'paperhome-source-host-fetch-builtin-'));
  process.env.PAPERCUSP_HOME = home;
  const configDir = join(home, 'harnesses', HARNESS, 'plugin-configs');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    join(configDir, `${GOOGLE_WORKSPACE_OAUTH_PLUGIN}.json`),
    JSON.stringify({ [FIELD]: STORED_TOKEN, [`${FIELD}_expires_at`]: Date.now() + 3_600_000 }),
  );

  // Mirrors the live failing source (personal scope, owned): a personal
  // data source requires owner_user_id (data_sources_personal_owner_chk).
  const ownerUserId = randomUUID();
  await sql`
    INSERT INTO harness_shared.users (id, username, display_name)
    VALUES (${ownerUserId}, ${`source-host-fetch-${ownerUserId}`}, 'Source host fetch owner')`;

  sourceId = randomUUID();
  await sql`
    INSERT INTO harness_shared.data_sources
      (workspace_id, id, kind, sync_mode, scope, status, credential_ref, owner_user_id, provider_account_id)
    VALUES
      (${WS}, ${sourceId}, ${PROVIDER_ID}, 'poll', 'personal', 'connected',
       ${`${GOOGLE_WORKSPACE_OAUTH_PLUGIN}:${FIELD}`}, ${ownerUserId}, 'owner@example.com')`;

  const registry = providerRegistry();
  registry.unregisterPlugin(PLUGIN_NAME);
  await registry.register({ descriptor, adapter, pluginName: PLUGIN_NAME });
}, 180_000);

afterAll(async () => {
  providerRegistry().unregisterPlugin(PLUGIN_NAME);
  if (previousHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = previousHome;
  await fs.rm(home, { recursive: true, force: true });
  await org?.cleanup();
}, 300_000);

describe('production host.fetch in a process that never served an OAuth route', () => {
  it('injects the stored Google token for a google-workspace credential ref', async () => {
    // Precondition: nothing in this process has registered the built-in
    // adapters, so this reproduces the connector driver's fresh process.
    expect(connectionAdapterForPlugin(GOOGLE_WORKSPACE_OAUTH_PLUGIN)).toBeNull();

    const seen: Array<string | null> = [];
    const hostFetch = createSourceHostFetch(sql, {
      providerId: PROVIDER_ID,
      workspaceId: WS,
      harness: HARNESS,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('authorization'));
        return Response.json({ items: [] });
      }) as typeof fetch,
    });

    const response = await hostFetch({
      source: sourceId,
      request: { url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events', method: 'GET' },
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual([`Bearer ${STORED_TOKEN}`]);
  });
});
