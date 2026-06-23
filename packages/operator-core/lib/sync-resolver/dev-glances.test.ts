// dev.* live-ops glance resolvers for the dev admin rail (plan
// dev-admin-sidebar-2026-06-05, P-005..P-008). Verifies each is registered and
// projects its underlying data source into the useSyncQuery contract: snapshot
// reads wrap in a 1-element array (client reads data[0]); list reads stay flat.
// Each underlying source module is mocked at its boundary so no HTTP/PG/git runs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownQueryNamesV2 } from './index';

describe('dev.* glance resolvers', () => {
  it('registers all dev.* query names', () => {
    const names = knownQueryNamesV2();
    for (const n of [
      'dev.serviceHealth',
      'dev.deployState',
      'dev.gitPipeline',
      'dev.pgHealth',
      'dev.pgActiveQueries',
      'dev.telemetry',
      'dev.toolFormatAdoption',
      'dev.coordPresence',
      'dev.coordFeed',
      'dev.fleetGovernor',
    ]) {
      expect(names).toContain(n);
    }
  });

  describe('resolver projection shapes', () => {
    beforeEach(() => {
      vi.resetModules();
    });
    afterEach(() => {
      vi.resetModules();
    });

    it('dev.serviceHealth wraps probeAll() as [{ services }]', async () => {
      const services = [{ name: 'operator', up: true, status: 200, latencyMs: 4 }];
      vi.doMock('../service-health', () => ({ probeAll: vi.fn(async () => services) }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.serviceHealth', {})) as Array<{ services: unknown[] }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].services).toEqual(services);
      vi.doUnmock('../service-health');
    });

    it('dev.deployState wraps devDeployState() as a 1-element snapshot', async () => {
      const snap = { mainHead: { sha: 'abc' }, deployedBehindMain: 7, errors: [] };
      vi.doMock('../dev-deploy-state', () => ({ devDeployState: vi.fn(async () => snap) }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.deployState', {})) as unknown[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toBe(snap);
      vi.doUnmock('../dev-deploy-state');
    });

    it('dev.gitPipeline wraps gitPipelineSnapshot() as a 1-element snapshot', async () => {
      const snap = { slug: 'papercup', gitSync: { lastStatus: 'synced' }, windows: { day: {}, week: {} }, recent: [] };
      vi.doMock('../git-pipeline-stats', () => ({ gitPipelineSnapshot: vi.fn(async () => snap) }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.gitPipeline', {})) as unknown[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toBe(snap);
      vi.doUnmock('../git-pipeline-stats');
    });

    it('dev.pgHealth wraps pgHealth() as a 1-element snapshot', async () => {
      const health = { version: 'PostgreSQL 17', totalConnections: 3, activeConnections: 1, idleConnections: 2 };
      vi.doMock('../dev-data', () => ({
        pgHealth: vi.fn(async () => health),
        pgActiveQueries: vi.fn(async () => ({ queries: [] })),
      }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.pgHealth', {})) as unknown[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(health);
      vi.doUnmock('../dev-data');
    });

    it('dev.pgActiveQueries returns the flat queries array (honours the limit arg)', async () => {
      const queries = [{ pid: 1, state: 'active', query: 'SELECT 1', duration_seconds: 0.1 }];
      const pgActiveQueries = vi.fn(async () => ({ queries }));
      vi.doMock('../dev-data', () => ({ pgActiveQueries, pgHealth: vi.fn() }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.pgActiveQueries', { limit: 10 })) as unknown[];
      expect(rows).toEqual(queries);
      expect(pgActiveQueries).toHaveBeenCalledWith(10);
      vi.doUnmock('../dev-data');
    });

    it('dev.pgActiveQueries clamps an out-of-range limit to the cap (D-002: clamp, never reject)', async () => {
      // clampedLimit() transforms (clamps) rather than .max()-rejecting, so a
      // client/server version skew can't make the resolver throw a panel-breaking
      // "Too big" error (sync-resolver/index.ts P-001 / D-002). An over-cap limit
      // is bounded to the cap (200) and passed to the data source — never rejected.
      const queries = [{ pid: 1, state: 'active', query: 'SELECT 1', duration_seconds: 0.1 }];
      const pgActiveQueries = vi.fn(async () => ({ queries }));
      vi.doMock('../dev-data', () => ({ pgActiveQueries, pgHealth: vi.fn() }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.pgActiveQueries', { limit: 9999 })) as unknown[];
      expect(rows).toEqual(queries);
      expect(pgActiveQueries).toHaveBeenCalledWith(200); // clamped to cap, not 9999
      vi.doUnmock('../dev-data');
    });

    it('dev.telemetry returns the flat rollup entries (passes hours+limit through, workspaceIds:null)', async () => {
      const entries = [
        { tool_name: 'work_items:list', call_count: 5, error_count: 0, p50_ms: 10, p95_ms: 20, total_bytes: 1000, avg_bytes: 200, repeat_within_spawn: 2 },
      ];
      const telemetryRollup = vi.fn(async () => ({ entries }));
      vi.doMock('../dev-data', () => ({ telemetryRollup }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.telemetry', { hours: 168, limit: 50 })) as unknown[];
      expect(rows).toEqual(entries);
      expect(telemetryRollup).toHaveBeenCalledWith({ workspaceIds: null, hours: 168, limit: 50 });
      vi.doUnmock('../dev-data');
    });

    it('dev.toolFormatAdoption returns the flat format-mix rows (passes hours through, workspaceIds:null)', async () => {
      const formatRows = [
        { format: 'toon', n: 75 },
        { format: 'json', n: 25 },
      ];
      const toolFormatAdoption = vi.fn(async () => ({ rows: formatRows }));
      vi.doMock('../dev-data', () => ({ toolFormatAdoption }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.toolFormatAdoption', { hours: 24 })) as unknown[];
      expect(rows).toEqual(formatRows);
      expect(toolFormatAdoption).toHaveBeenCalledWith({ workspaceIds: null, hours: 24 });
      vi.doUnmock('../dev-data');
    });

    it('dev.coordPresence returns the flat presence array (passes workspace through)', async () => {
      const records = [{ ownerId: 'a', ownerLabel: 'A', stale: false, intent: 'x' }];
      const listPresence = vi.fn(async () => records);
      vi.doMock('../agent-tools/coordination/presence', () => ({ listPresence }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.coordPresence', { workspace: 'ws1' })) as unknown[];
      expect(rows).toEqual(records);
      expect(listPresence).toHaveBeenCalledWith({ workspaceId: 'ws1' });
      vi.doUnmock('../agent-tools/coordination/presence');
    });

    it('dev.coordFeed returns flat envelope rows with page _meta on row[0]', async () => {
      const rows = [
        { ts: '2026-06-07T00:00:02Z', msg_id: 'b', from: 'op', to: ['*'], kind: 'message', surface: 'messages', broadcast: true },
        { ts: '2026-06-07T00:00:01Z', msg_id: 'a', from: 'op', to: ['w'], kind: 'message', surface: 'messages', broadcast: false },
      ];
      const readCoordFeed = vi.fn(async () => ({
        rows,
        nextCursor: '2026-06-06T00:00:00Z',
        total: 9,
        byKind: { message: 2 },
      }));
      vi.doMock('../agent-tools/coordination/feed', () => ({ readCoordFeed }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const out = (await r('dev.coordFeed', { kinds: ['message'], owner: 'op', limit: 50 })) as Array<
        Record<string, unknown> & { _meta?: { total: number; byKind: Record<string, number>; nextCursor: string | null } }
      >;
      expect(out).toHaveLength(2);
      // _meta rides ONLY on row[0] (the flat-row sync contract).
      expect(out[0]!._meta).toEqual({ total: 9, byKind: { message: 2 }, nextCursor: '2026-06-06T00:00:00Z' });
      expect(out[1]!._meta).toBeUndefined();
      // Args thread through to the read seam.
      expect(readCoordFeed).toHaveBeenCalledWith(
        expect.objectContaining({ kinds: ['message'], owner: 'op', limit: 50 }),
      );
      vi.doUnmock('../agent-tools/coordination/feed');
    });

    it('dev.fleetGovernor wraps buildFleetRateStatus() as a 1-element snapshot', async () => {
      const status = { ok: true, fleet: { cap: 8, inFlight: 2, effective: 8, floor: 1 }, buckets: [] };
      vi.doMock('../fleet-rate-status', () => ({ buildFleetRateStatus: vi.fn(async () => status) }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.fleetGovernor', {})) as unknown[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toBe(status);
      vi.doUnmock('../fleet-rate-status');
    });
  });
});
