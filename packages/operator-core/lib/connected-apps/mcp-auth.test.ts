/**
 * external-app-access-to-workspaces-2026-09-29 P-002 — R-3 (an app key works
 * over MCP).
 *
 * Drives the real `/api/mcp` authentication step (`tryBuildSpawnContext`) with
 * an mcp-handler-shaped `extra`. Only the database handle is faked, answering
 * the connected_apps lookup with a row the test controls; the key parser, hash
 * comparison and state checks are the production ones.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const sql = Object.assign(
    // Other modules in the MCP host's graph also reach this client, some via
    // postgres.js helper calls (`sql(value)`) rather than a tagged template —
    // answer those with no rows instead of throwing an unhandled rejection.
    async (strings: TemplateStringsArray | unknown) => {
      const text = Array.isArray(strings) ? strings.join('?') : '';
      if (db.row && /SELECT[\s\S]*FROM harness_shared\.connected_apps/.test(text)) return [db.row];
      return [];
    },
    { unsafe: (fragment: string) => fragment },
  );
  return {
    ...(await importOriginal<typeof import('@papercusp/db-org')>()),
    getOrgPg: () => ({ sql }),
    withWorkspace: async (_ws: string, fn: (tx: unknown) => Promise<unknown>) => fn(sql),
  };
});

import { tryBuildSpawnContext } from '../endpoint-route/routes/transport/_mcp-host';
import { mintAppKey } from './key';

/** mcp-handler-shaped `extra` on a loopback host (the case a refused key must not exploit). */
function extraFor(query: string, bearer: string): unknown {
  return {
    requestInfo: {
      url: `http://127.0.0.1:3070/api/mcp${query}`,
      headers: { host: '127.0.0.1:3070', authorization: `Bearer ${bearer}` },
    },
  };
}

function appRow(tokenHash: string, id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    user_email: 'owner@example.com',
    workspace_id: 'ws-app',
    kind: 'app',
    label: 'ci bot',
    scopes: { capabilities: ['harness:read'] },
    limits: {},
    paired_at: new Date('2026-09-29T00:00:00Z'),
    expires_at: null,
    paused_at: null,
    revoked_at: null,
    last_seen: null,
    last_ip: null,
    token_hash: tokenHash,
    // P-010 (D-025): verifyAppKey reads the workspace's Remote access switch with the key and
    // fails closed without it; this fixture's workspace has remote access on.
    remote_access_enabled: true,
    ...over,
  };
}

let minted: ReturnType<typeof mintAppKey>;

beforeEach(() => {
  minted = mintAppKey();
  db.row = appRow(minted.tokenHash, minted.id);
});

describe('R-3 — an app key works over MCP', () => {
  it('a valid key authenticates an MCP session as app:<id> in its own workspace', async () => {
    const res = await tryBuildSpawnContext(extraFor('', minted.key));
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.ctx.workspaceId).toBe('ws-app');
    expect(res.ctx.spawnId).toBe(`app:${minted.id}`);
    expect(res.ctx.authenticatedPrincipal).toMatchObject({
      kind: 'service',
      slug: `app:${minted.id}`,
      workspaceId: 'ws-app',
      authMethod: 'bearer-token',
      trust: 'verified',
    });
    expect([...(res.ctx.authenticatedPrincipal?.capabilities ?? [])]).toEqual(['harness:read']);
  });

  it('accepts workspace= naming the key own workspace', async () => {
    const res = await tryBuildSpawnContext(extraFor('?workspace=ws-app', minted.key));
    expect(res.kind).toBe('ok');
  });

  it('refuses workspace= naming another workspace', async () => {
    const res = await tryBuildSpawnContext(extraFor('?workspace=ws-other', minted.key));
    expect(res).toEqual({ kind: 'failed', reason: 'connected_app_workspace_mismatch' });
  });

  for (const param of ['role=operator', 'spawn=s1', 'harness=papercusp', 'principal=pi', 'power_user=1']) {
    it(`refuses a URL parameter that would re-point authority (${param})`, async () => {
      const res = await tryBuildSpawnContext(extraFor(`?${param}`, minted.key));
      expect(res).toEqual({
        kind: 'failed',
        reason: `connected_app_forbidden_param:${param.split('=')[0]}`,
      });
    });
  }

  for (const [reason, over] of [
    ['paused', { paused_at: new Date() }],
    ['revoked', { revoked_at: new Date() }],
  ] as const) {
    it(`a ${reason} key is refused and never falls through to a loopback session`, async () => {
      db.row = appRow(minted.tokenHash, minted.id, over);
      const res = await tryBuildSpawnContext(extraFor('', minted.key));
      expect(res).toEqual({ kind: 'failed', reason: `connected_app_invalid_key:${reason}` });
    });
  }

  it('an unknown key id is refused', async () => {
    db.row = null;
    const res = await tryBuildSpawnContext(extraFor('', minted.key));
    expect(res).toEqual({ kind: 'failed', reason: 'connected_app_invalid_key:unknown' });
  });
});
