/**
 * Real-store regression for work_items:burn_down's fleet-attributed `since`
 * census. The unit suite proves classification with mocks; this test proves the
 * handler's actual work_items + fleet_membership_events reads agree at the MCP
 * tool boundary before payload-tier shaping is applied.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  publicBrief: false,
  metricItemsUnavailable: false as false | 'sync' | 'async',
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../../workspace-registry')>('../../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
vi.mock('../../long-lived-admin-pool', () => ({ getLongLivedAdminPool: () => h.sql }));
vi.mock('../../work-items', async (orig) => {
  const actual = await orig<typeof import('../../work-items')>();
  return {
    ...actual,
    listAllWorkItemsForFileExport: (...args: Parameters<typeof actual.listAllWorkItemsForFileExport>) => {
      if (h.metricItemsUnavailable === 'sync') throw new Error('fixture item reader unavailable');
      if (h.metricItemsUnavailable === 'async') return Promise.reject(new Error('fixture item reader unavailable'));
      return actual.listAllWorkItemsForFileExport(...args);
    },
  };
});
vi.mock('../../bounded-timeout', async (orig) => {
  const actual = await orig<typeof import('../../bounded-timeout')>();
  return {
    ...actual,
    withBoundedTimeout: async <T>(
      work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
      opts: import('../../bounded-timeout').BoundedTimeoutOptions<T>,
    ) => {
      // Exercise the public assembly and its real metric reader/builder. Keep
      // unrelated desktop, control and supervision reads outside this fixture;
      // their production fallbacks remain unknown rather than invented counts.
      if (!h.publicBrief || !opts.label?.startsWith('leader-brief:') ||
          opts.label === 'leader-brief:fleet-metrics' || opts.label === 'leader-brief:lane-health') {
        return actual.withBoundedTimeout(work, opts);
      }
      if (typeof work !== 'function') void work.catch(() => undefined);
      return { value: opts.fallback, degraded: true, reason: 'timeout' as const, elapsedMs: 0 };
    },
  };
});

const { default: burnDownTool, buildFleetMetricsResult } = await import('./burn_down');
const { default: leaderBriefTool, readLeaderBriefFleetMetrics } = await import('../fleet/leader-brief');
const { resolveFleetMetricScope, readFleetMetricSourceItems } = await import('../fleet/fleet-metrics-scope');
const { shapeLeaderBrief } = await import('../fleet/leader-brief-shape');
const { explainIssueClaimFloors, listWorkItems, listAllWorkItemsForFileExport,
  countWorkItems, countWorkItemsByState } = await import('../../work-items');
const { FLEET_METRIC_ARCHIVE_KEYS, projectWorkItemColumns } = await import('../../work-item-read-projection');
const { readIssueOccurrenceCounts } = await import('../../issue-occurrence-ledger');
const { DEFAULT_CLAIM_SPEC } = await import('../../scheduler/claim-spec');
import type { FilterNode } from '../../scheduler/claim-spec';
const { fleetSpecBeeKey, setClaimSpec } = await import('../../scheduler/claim-spec-store');

const CTX = { isSuperuser: true, uiClientId: 'burn-down-integration', workspaceId: 'default' } as never;
const HARNESS = 'papercusp';
const FLEET = 'burn-down-real-fleet';
const SINCE = '2026-08-11T18:48:00.000Z';

let db: OrgTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  // Default metrics traverse scope, roster, claim floors and review ledgers.
  // The maintained migrated fixture keeps that read graph production-faithful.
  db = await createOrgTestDb();
  h.sql = sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  h.publicBrief = false;
  h.metricItemsUnavailable = false;
  await sql`TRUNCATE harness_shared.work_items,
                         harness_shared.coord_presence,
                         harness_shared.fleet_membership_events,
                         harness_shared.work_item_occurrences,
                         harness_shared.agent_fleets,
                         harness_shared.cup_claim_specs,
                         harness_shared.cup_claim_spec_revisions,
                         harness_shared.scout_routed_ideas,
                         harness_shared.tool_invocations,
                         harness_shared.work_item_deps,
                         harness_shared.work_item_blocked RESTART IDENTITY CASCADE`;
  await sql`ALTER SEQUENCE harness_shared.work_item_seq RESTART WITH 1`;
});

function epoch(iso: string): number {
  return Date.parse(iso);
}

describe('work_items:burn_down real-store fleet attribution', () => {
  it('reads a fleet-attributed since window and returns the complete declared census fields', async () => {
    await sql`
      INSERT INTO harness_shared.fleet_membership_events
        (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, event)
      VALUES
        ('default', 'fleet-member-dead', 'fleet-member-dead', ${FLEET}, 'member', 'join'),
        ('default', 'fleet-member-live', 'fleet-member-live', ${FLEET}, 'member', 'join')
    `;
    await sql`
      INSERT INTO harness_shared.coord_presence
        (owner_id, owner_label, workspace_id, heartbeat_at)
      VALUES ('fleet-member-live', 'fleet-member-live', 'default', now())
    `;
    await sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, title, summary, status, item_kind, taken_by,
         taken_at, last_progress_at, workspace_id, created_ts, updated_ts, closed_ts,
         terminal_owner, authority)
      VALUES
        (${HARNESS}, 'EI-real-fleet-closed', 'closed by fleet member', 'closed', 'done', 'task', NULL,
         NULL, NULL, 'default', ${epoch('2026-08-11T18:00:00.000Z')}, ${epoch('2026-08-11T19:00:00.000Z')},
         ${epoch('2026-08-11T19:00:00.000Z')}, 'fleet-member-dead', 'validated'),
        (${HARNESS}, 'EI-real-fleet-live', 'in flight by fleet member', 'live', 'open', 'task', 'fleet-member-live',
         '2026-08-11T19:30:00.000Z', '2026-08-11T19:40:00.000Z', 'default', ${epoch('2026-08-11T19:00:00.000Z')},
         ${epoch('2026-08-11T19:40:00.000Z')}, NULL, NULL, NULL),
        (${HARNESS}, 'EI-real-fleet-unclaimed', 'unclaimed work', 'open', 'open', 'task', NULL,
         NULL, NULL, 'default', ${epoch('2026-08-11T19:10:00.000Z')}, ${epoch('2026-08-11T19:10:00.000Z')}, NULL, NULL, NULL)
    `;
    await sql`
      INSERT INTO harness_shared.work_item_occurrences
        (workspace_id, canonical_harness_slug, canonical_work_item_id, reporter,
         source_tool, report_kind, reported_title, evidence)
      VALUES
        ('default', ${HARNESS}, 'EI-real-fleet-closed', 'fleet-member-dead',
         'work_items:create', 'canonical-created', 'closed by fleet member', '{}'::jsonb),
        ('default', ${HARNESS}, 'EI-real-fleet-closed', 'fleet-member-live',
         'improvements:capture', 'duplicate', 'same failure again', '{"repro":true}'::jsonb)
    `;

    const response = await (burnDownTool as unknown as {
      handler: (args: unknown, ctx: unknown) => Promise<{ data: Record<string, any> }>;
    }).handler({ harness: HARNESS, since: SINCE, fleet: FLEET, limit: 2000 }, CTX);
    const data = response.data;

    expect(data).toEqual(expect.objectContaining({
      ok: true,
      harness: HARNESS,
      parked: [],
      counts: { total: 3, terminal: 1, inFlight: 1, parked: 0, unclaimed: 1 },
    }));
    expect(data.inFlight).toHaveLength(1);
    expect(data.inFlight[0]).toEqual(expect.objectContaining({
      id: 'EI-real-fleet-live',
      assignee: 'fleet-member-live',
      assigneeLive: true,
      takenAt: '2026-08-11T19:30:00.000Z',
      lastProgressAt: '2026-08-11T19:40:00.000Z',
    }));
    expect(data.terminal.delta).toBe(1);
    expect(data.issueOccurrences).toEqual({
      canonicalClusters: 1,
      rawOccurrences: 2,
      duplicateOccurrences: 1,
      units: {
        canonicalClusters: 'distinct canonical work-item ids with occurrences',
        rawOccurrences: 'append-only report rows',
        duplicateOccurrences: 'report rows not creating a canonical item',
      },
      writer: 'harness_shared.work_item_occurrences',
    });
    expect(data.terminal.deltaBy).toEqual(expect.objectContaining({
      fleet: 1,
      otherAgents: 0,
      system: 0,
      unattributed: 0,
      basis: expect.objectContaining({
        fleet: FLEET,
        fleetSource: 'arg',
        membership: 'ever-members',
        memberCount: 2,
      }),
    }));
    expect(data.closedSince.rows.map((row: { id: string }) => row.id)).toEqual(['EI-real-fleet-closed']);
    // This is the raw handler result; each itemized row is an object before the
    // payload-tier shaper projects/caps it for an agent context.
    for (const rows of [data.inFlight, data.parked, data.unclaimed, data.closedSince.rows]) {
      expect(rows.every((row: unknown) => row && typeof row === 'object')).toBe(true);
    }
  });
});

describe('default fleet reports over the real current-spec queue', () => {
  const ids = ['WI-health-review', 'WI-health-held', 'WI-health-blocked', 'WI-health-ready'];
  const enteredAt = '2026-08-12T00:00:00.000Z';
  const createdAt = epoch('2026-08-11T00:00:00.000Z');

  async function seedFleet(lane: 'implementation' | 'verification' = 'implementation',
    filter: FilterNode = { field: 'id', op: 'in', value: ids }) {
    await sql`
      INSERT INTO harness_shared.agent_fleets
        (workspace_id, fleet_slug, created_at, updated_at)
      VALUES ('default', ${FLEET}, ${createdAt}, ${createdAt})`;
    const spec = {
      ...DEFAULT_CLAIM_SPEC,
      specId: 'real-health-current-spec',
      lane,
      view: { ...DEFAULT_CLAIM_SPEC.view, filter },
    };
    expect(await setClaimSpec({ cupId: fleetSpecBeeKey(FLEET), workspaceId: 'default',
      potSlug: HARNESS, spec }, sql)).toMatchObject({ ok: true });
  }

  async function seedQueue() {
    // These newer, excluded rows consume the entire ordinary display census.
    // The selected queue must come from the uncapped internal reader instead.
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, created_ts, updated_ts)
      SELECT 'default', ${HARNESS}, 'WI-excluded-' || n, 'outside current spec', 'open', 'bug',
             ${Date.now()}, ${Date.now()} FROM generate_series(1, 2001) AS n`;
    const payloads = [
      { agentReview: { status: 'pending', submittedBy: 'su-author', round: 1,
          ledgerIdeaId: ids[0], timing: { round: 1, enteredAt } } },
      { _claimHold: true, claim_hold_by: 'su-parker', claim_hold_reason: 'waiting for credential',
        claim_hold_at: enteredAt,
        claim_hold_release: { condition: 'credential supplied', owner: 'su-condition-owner',
          trigger: 'credential:supplied', reachability: 'satisfied', evidence: 'credential event fired' },
        agentReview: { status: 'pending', submittedBy: 'su-author', round: 1, ledgerIdeaId: ids[1] } },
      { _claimHold: true, claim_hold_by: 'su-parker', claim_hold_reason: 'dependency and review remain',
        claim_hold_at: enteredAt },
      {},
    ];
    for (const [index, id] of ids.entries()) {
      await sql`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, title, status, item_kind,
           created_ts, updated_ts, payload, admission)
        VALUES ('default', ${HARNESS}, ${id}, ${id}, 'open', 'bug',
                ${createdAt}, ${createdAt}, ${JSON.stringify(payloads[index])}::jsonb, 'admitted')`;
    }
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, created_ts, updated_ts, admission)
      VALUES ('default', ${HARNESS}, 'WI-active-dependency', 'active prerequisite', 'open', 'task',
              ${createdAt}, ${createdAt}, 'admitted')`;
    await sql`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref)
      VALUES ('default', 'issue', ${ids[2]}, 'issue', 'WI-active-dependency')`;
  }

  async function readDefaultBurnDown() {
    return (burnDownTool as unknown as {
      handler: (args: unknown, ctx: unknown) => Promise<{ data: Record<string, any> }>;
    }).handler({ harness: HARNESS, fleet: FLEET, window: 'fleet-lifetime',
      flowMode: 'current-spec', limit: 5 }, CTX);
  }

  it('one public leader-brief call retains complete current-spec partitions and unknown counts through shaping', async () => {
    await seedFleet();
    await seedQueue();
    h.publicBrief = true;
    const response = await (leaderBriefTool as unknown as {
      handler: (args: unknown, ctx: unknown) => Promise<{ data: Record<string, any> }>;
    }).handler({ fleet: FLEET, harness: HARNESS }, CTX);
    expect(response.data.ok).toBe(true);
    expect(response.data.fleetMetrics.ok).toBe(true);
    const snapshot = response.data.fleetMetrics.snapshot;
    const floors = await explainIssueClaimFloors(HARNESS, ids, { includeAllFloors: true });
    expect(snapshot.remaining).toMatchObject({ total: 4, buckets: {
      needsHuman: 0, blocked: 1, claimHeld: 1, inFlight: 0, claimable: 1, otherUnclaimable: 1,
    } });
    expect(Object.values(snapshot.remaining.buckets).reduce(
      (sum: number, count) => sum + Number(count), 0,
    )).toBe(snapshot.remaining.total);
    expect(snapshot.remaining.buckets.claimable).toBe(floors.filter(row => row.admissible).length);
    expect(snapshot.quality.exactness).toMatchObject({ status: 'exact', sourceCap: null });
    expect(snapshot.queueHealth.waiting.reviewWait).toMatchObject({
      population: 2, known: 1, unknown: 1, oldestMs: null,
    });
    // Required scheduler data runs with production bounds, not the optional
    // fallback mock. An issue-family oracle must actually be measured.
    expect(response.data.summary.claimable_now.value).toBe(1);
    expect(response.data.summary.claimable_now.unknown).toBeUndefined();
    for (const tier of ['trimmed', 'standard'] as const) {
      const shaped = shapeLeaderBrief(response.data, tier) as Record<string, any>;
      expect(shaped.fleetMetrics.snapshot.remaining).toEqual(snapshot.remaining);
      expect(shaped.fleetMetrics.snapshot.queueHealth).toEqual(snapshot.queueHealth);
      expect(shaped.summary.claimable_now.value).toBe(1);
    }
  }, 30_000);

  it('skips an impossible feature hydration without losing full issue stock or historical kinds', async () => {
    await seedFleet('implementation', { field: 'kind', op: '=', value: 'bug' });
    await seedQueue();
    const oldAt = createdAt - 86_400_000;
    await sql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
       created_ts, updated_ts, closed_ts)
      VALUES ('default', ${HARNESS}, 'WI-kind-old-bug', 'old bug', 'retained body', 'done', 'bug',
              ${oldAt}, ${oldAt}, ${oldAt}),
             ('default', ${HARNESS}, 'WI-kind-feature', 'feature control', 'feature body', 'open', 'feature',
              ${oldAt}, ${oldAt}, NULL),
             ('default', ${HARNESS}, 'WI-kind-task', 'task control', 'task body', 'open', 'task',
              ${oldAt}, ${oldAt}, NULL)`;
    const read = async (flowMode: 'current-spec' | 'at-event-spec' = 'current-spec') => {
      const scope = await resolveFleetMetricScope({ workspaceId: 'default', harness: HARNESS,
        fleet: FLEET, flowMode });
      if (!scope.ok) throw new Error(scope.reason);
      if (flowMode === 'at-event-spec') {
        expect(scope.claimSpec.segments.some(segment => segment.source === 'history')).toBe(true);
      }
      const queries: string[] = [];
      const originalDebug = sql.options.debug;
      sql.options.debug = (connection, query, parameters, types, queryId) => {
        if (typeof originalDebug === 'function') originalDebug(connection, query, parameters, types, queryId);
        queries.push(query);
      };
      try { return { source: await readFleetMetricSourceItems(scope), queries }; }
      finally { sql.options.debug = originalDebug; }
    };
    const current = await read();
    expect(current.queries).toHaveLength(1);
    expect(current.queries[0]).toContain('FROM harness_shared.engineer_issues');
    expect(current.source).toHaveLength(2006);
    expect(current.source.find(item => item.id === 'WI-kind-old-bug'))
      .toMatchObject({ state: 'done', summary: 'retained body' });
    const full = await listAllWorkItemsForFileExport({ harness: HARNESS, kind: 'bug',
      includeObservations: true, payloadProjection: 'fleetMetrics' });
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect(current.source.sort(byId)).toEqual(full.sort(byId));

    expect(await setClaimSpec({ cupId: fleetSpecBeeKey(FLEET), workspaceId: 'default',
      potSlug: HARNESS, spec: { ...DEFAULT_CLAIM_SPEC, revision: 2, specId: 'task-kind-current',
        view: { ...DEFAULT_CLAIM_SPEC.view, filter: { field: 'kind', op: '=', value: 'task' } },
      } }, sql)).toMatchObject({ ok: true });
    const historical = await read('at-event-spec');
    expect(historical.queries).toHaveLength(2);
    // seedQueue's prerequisite is also a task; the historical union must keep
    // it even though it was outside the original bug-only current population.
    expect(new Set(historical.source.map(item => item.id)))
      .toEqual(new Set([...full.map(item => item.id), 'WI-kind-task', 'WI-active-dependency']));
    expect(historical.source.find(item => item.id === 'WI-kind-feature')).toBeUndefined();
  }, 30_000);

  it('hydrates only current-spec identities while preserving uncapped source and empty-set semantics', async () => {
    await seedFleet();
    await seedQueue();
    const resolution = await resolveFleetMetricScope({ workspaceId: 'default', harness: HARNESS,
      fleet: FLEET, flowMode: 'current-spec' });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error(resolution.reason);
    const source = await readFleetMetricSourceItems(resolution);
    expect(source.map(item => item.id).sort()).toEqual([...ids].sort());
    expect(await listWorkItems({ harness: HARNESS, ids: [], includeObservations: true })).toEqual([]);
    expect((await listWorkItems({ harness: HARNESS, ids: [ids[0]], includeObservations: true }))
      .map(item => item.id)).toEqual([ids[0]]);
  });

  it('retains over 2000 matched rows, pre-lifetime stock and terminal rows, and the historical-spec union', async () => {
    await seedFleet();
    await seedQueue();
    const olderAt = createdAt - 86_400_000;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, created_ts, updated_ts)
      SELECT 'default', ${HARNESS}, 'WI-large-source-' || n, 'matched source stock', 'open', 'bug',
             ${createdAt}, ${createdAt} FROM generate_series(1, 2101) AS n`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind,
         created_ts, updated_ts, closed_ts)
      VALUES ('default', ${HARNESS}, 'WI-old-source-stock', 'matched source stock', 'open', 'bug',
              ${olderAt}, ${olderAt}, NULL),
             ('default', ${HARNESS}, 'WI-old-source-terminal', 'matched source stock', 'done', 'bug',
              ${olderAt}, ${olderAt}, ${olderAt})`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, parent_id,
         created_ts, updated_ts, closed_ts)
      VALUES ('default', ${HARNESS}, 'WI-source-feature', 'matched source stock', 'done', 'feature', NULL,
              ${olderAt}, ${olderAt}, ${olderAt}),
             ('default', ${HARNESS}, 'WI-source-task', 'matched source stock', 'open', 'task', NULL,
              ${olderAt}, ${olderAt}, NULL),
             ('default', ${HARNESS}, 'WI-source-child', 'matched source stock', 'open', 'bug', 'WI-source-task',
              ${olderAt}, ${olderAt}, NULL),
             ('foreign-workspace', ${HARNESS}, 'WI-source-foreign', 'matched source stock', 'open', 'bug', NULL,
              ${olderAt}, ${olderAt}, NULL),
             ('default', 'foreign-harness', 'WI-source-other-harness', 'matched source stock', 'open', 'bug', NULL,
              ${olderAt}, ${olderAt}, NULL)`;
    const priorSpecs = await sql`SELECT revision, spec FROM harness_shared.cup_claim_specs
      WHERE workspace_id = 'default' AND bee_id = ${fleetSpecBeeKey(FLEET)}`;
    expect(priorSpecs).toHaveLength(1);
    expect(priorSpecs[0]!.spec.view.filter).toEqual({ field: 'id', op: 'in', value: ids });
    expect(await setClaimSpec({ cupId: fleetSpecBeeKey(FLEET), workspaceId: 'default',
      potSlug: HARNESS, spec: {
        ...DEFAULT_CLAIM_SPEC,
        revision: 2,
        specId: 'real-health-next-spec',
        view: { ...DEFAULT_CLAIM_SPEC.view,
          filter: { field: 'title', op: '=', value: 'matched source stock' } },
      } }, sql)).toMatchObject({ ok: true, revision: 2 });

    const resolution = await resolveFleetMetricScope({ workspaceId: 'default', harness: HARNESS,
      fleet: FLEET, flowMode: 'at-event-spec' });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error(resolution.reason);
    expect(resolution.claimSpec.segments.some(segment => segment.source === 'history')).toBe(true);
    // Capture the actual SQL boundary: two family hydration reads, with no
    // standalone identity download followed by a large ID-array upload.
    const queries: string[] = [];
    const originalDebug = sql.options.debug;
    sql.options.debug = (connection, query, parameters, types, queryId) => {
      if (typeof originalDebug === 'function') originalDebug(connection, query, parameters, types, queryId);
      queries.push(query);
    };
    let source: Awaited<ReturnType<typeof readFleetMetricSourceItems>>;
    try { source = await readFleetMetricSourceItems(resolution); }
    finally { sql.options.debug = originalDebug; }
    expect(queries).toHaveLength(2);
    const selectedIds = new Set(source.map(item => item.id));
    const expectedIds = [
      ...ids, ...Array.from({ length: 2101 }, (_, index) => `WI-large-source-${index + 1}`),
      'WI-old-source-stock', 'WI-old-source-terminal', 'WI-source-feature', 'WI-source-task',
    ];
    expect(selectedIds).toEqual(new Set(expectedIds));
    expect(source).toHaveLength(expectedIds.length);
    const selected = sql`SELECT feature_id FROM harness_shared.work_items
      WHERE workspace_id = 'default' AND feature_id = ANY(${expectedIds}::text[])`;
    const selectedFilter = { harness: HARNESS, includeObservations: true, ids: selected };
    expect(await countWorkItems(selectedFilter)).toBe(expectedIds.length);
    expect(await countWorkItemsByState(selectedFilter)).toEqual(await countWorkItemsByState({
      harness: HARNESS, includeObservations: true, ids: expectedIds,
    }));
    expect(source.find(item => item.id === 'WI-old-source-terminal')).toMatchObject({ state: 'done' });
    for (const id of ['WI-old-source-stock', 'WI-old-source-terminal']) {
      expect(Date.parse(source.find(item => item.id === id)!.createdAt!))
        .toBeLessThan(Date.parse(resolution.scope.window.startAt));
    }
  }, 30_000);

  it('keeps complete fleet snapshot semantics when archival payloads are projected at the source', async () => {
    await seedFleet();
    await seedQueue();
    // Equal update times exercise the issue reader's created-time secondary
    // order. Distinct creation times avoid relying on unspecified SQL tie order.
    for (const [index, id] of ids.entries()) {
      await sql`UPDATE harness_shared.work_items SET created_ts = ${createdAt + index * 1000}
        WHERE workspace_id = 'default' AND feature_id = ${id}`;
    }
    const archives = Object.fromEntries(FLEET_METRIC_ARCHIVE_KEYS.map(key => [key, { receipt: 'x'.repeat(8192) }]));
    await sql`UPDATE harness_shared.work_items SET payload = payload || ${sql.json(archives)}::jsonb
      WHERE workspace_id = 'default' AND feature_id = ANY(${ids}::text[])`;
    // Admission clocks are live metric inputs. Seed real pending/terminal
    // transitions after the archival envelopes so a misclassified archive key
    // cannot overwrite this independent control and make both readers agree.
    await sql`UPDATE harness_shared.work_items SET payload = payload || ${sql.json({
      admissionReview: { state: 'pending', enteredAt },
    })}::jsonb WHERE workspace_id = 'default' AND feature_id = ${ids[0]}`;
    await sql`UPDATE harness_shared.work_items SET payload = payload || ${sql.json({
      admissionReview: { state: 'terminal', enteredAt, terminalAt: '2026-08-12T00:00:01.000Z' },
    })}::jsonb WHERE workspace_id = 'default' AND feature_id = ${ids[3]}`;
    const resolution = await resolveFleetMetricScope({ workspaceId: 'default', harness: HARNESS,
      fleet: FLEET, flowMode: 'current-spec' });
    if (!resolution.ok) throw new Error(resolution.reason);
    const full = await listAllWorkItemsForFileExport({ harness: HARNESS, includeObservations: true, ids });
    const projected = await readFleetMetricSourceItems(resolution);
    expect(projected.map(item => item.id)).toEqual(full.map(item => item.id));
    expect(projected.map(item => item.id)).toEqual([...ids].reverse());
    for (const item of projected) {
      const original = full.find(row => row.id === item.id)!;
      const retained = { ...(original.payload as Record<string, unknown>) };
      for (const key of FLEET_METRIC_ARCHIVE_KEYS) delete retained[key];
      // Guard the entire mapper output, not just today's metric inputs. If a
      // future mapper starts consuming an omitted field, this comparison fails.
      expect(item).toEqual({ ...original, payload: retained, terminalCompletionEvidence: null });
    }
    const occurrenceCounts = await readIssueOccurrenceCounts({ workspaceId: 'default', harnessSlug: HARNESS,
      since: resolution.scope.window.startAt });
    const options = { workspaceId: 'default', sourceCapExhausted: false, issueOccurrences: occurrenceCounts };
    const metrics = await buildFleetMetricsResult(resolution, projected, options);
    expect(metrics).toEqual(await buildFleetMetricsResult(resolution, full, options));
    if (!metrics.ok) throw new Error(metrics.reason);
    if (!metrics.snapshot.queueHealth) throw new Error('required queue health is missing');
    expect(metrics.snapshot.queueHealth.waiting.admissionWait).toMatchObject({
      population: 1, known: 1, unknown: 0,
      oldestMs: Date.parse(resolution.scope.window.endAt) - Date.parse(enteredAt),
    });
    expect(metrics.snapshot.queueHealth.waiting.admissionDelay).toMatchObject({
      population: 1, known: 1, unknown: 0, oldestMs: 1000,
    });

    // Both physical families honor the policy, preserving future control keys.
    for (const kind of ['feature', 'bug'] as const) {
      const value = { tags: ['kept'], futureControl: { active: true }, ...archives };
      const id = `WI-projection-${kind}`;
      await sql`INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, payload)
        VALUES ('default', ${HARNESS}, ${id}, 'projection shape', 'open', ${kind}, ${sql.json(value)}::jsonb)`;
      const read = await listAllWorkItemsForFileExport({ harness: HARNESS, ids: [id], payloadProjection: 'fleetMetrics' });
      expect(read).toHaveLength(1);
      expect(read[0]!.payload).toEqual({ tags: ['kept'], futureControl: { active: true } });
    }
    // The maintained table rejects malformed payloads. Test the SQL policy on
    // VALUES instead of weakening that constraint just to seed legacy shapes.
    // The production client's hybrid JSON serializer treats strings as already
    // encoded. Bind explicit JSON text so a scalar string keeps its JSON quotes.
    for (const value of [['legacy-array'], 'legacy-scalar', null]) {
      const rows = await sql`SELECT ${sql.unsafe(projectWorkItemColumns('payload, marker', 'fleetMetrics'))}
        FROM (SELECT ${JSON.stringify(value)}::text::jsonb AS payload, 1 AS marker) fixture`;
      expect(rows[0]!.payload).toEqual(value);
    }
  }, 30_000);

  it.each([
    { label: 'item-read failure', mode: 'sync' },
    { label: 'rejected item read', mode: 'async' },
  ] as const)('a public leader-brief $label stays unavailable through shaping', async ({ mode }) => {
    await seedFleet();
    h.publicBrief = true;
    h.metricItemsUnavailable = mode;
    const response = await (leaderBriefTool as unknown as {
      handler: (args: unknown, ctx: unknown) => Promise<{ data: Record<string, any> }>;
    }).handler({ fleet: FLEET, harness: HARNESS }, CTX);
    expect(response.data.ok).toBe(true);
    expect(response.data.fleetMetrics).toMatchObject({
      ok: false, error: 'fleet_metrics_unavailable',
      reason: expect.stringContaining('fixture item reader unavailable'),
      recoverVia: expect.stringContaining('work_items:burn_down'),
    });
    expect(response.data.fleetMetrics).not.toHaveProperty('snapshot');
    for (const tier of ['trimmed', 'standard'] as const) {
      const shaped = shapeLeaderBrief(response.data, tier) as Record<string, any>;
      expect(shaped.fleetMetrics).toEqual(response.data.fleetMetrics);
      expect(shaped.fleetMetrics).not.toHaveProperty('snapshot');
    }
  }, 30_000);

  it('preserves the complete selected stock and independent scheduler floors beyond the display cap', async () => {
    await seedFleet();
    await seedQueue();
    const display = await listWorkItems({ harness: HARNESS, limit: 2000 });
    expect(display).toHaveLength(2000);
    expect(display.some(row => ids.includes(row.id))).toBe(false);

    const floors = await explainIssueClaimFloors(HARNESS, ids, { includeAllFloors: true });
    expect(floors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ids[0], admissible: false, refusedBy: 'agent-review' }),
      expect.objectContaining({ id: ids[1], admissible: false, refusedBy: 'agent-review' }),
      expect.objectContaining({ id: ids[2], admissible: false, refusedBy: 'claim-hold',
        failedFloors: expect.arrayContaining(['claim-hold', 'blocked-dep']) }),
      expect.objectContaining({ id: ids[3], admissible: true }),
    ]));
    const [brief, burnDown] = await Promise.all([
      readLeaderBriefFleetMetrics({ workspaceId: 'default', fleet: FLEET, harness: HARNESS }),
      readDefaultBurnDown(),
    ]);
    expect(brief.ok).toBe(true);
    expect(burnDown.data.fleetMetrics.ok).toBe(true);
    if (!brief.ok) throw new Error(brief.reason);
    const snapshot = brief.snapshot;
    expect(snapshot.quality.exactness).toMatchObject({ status: 'exact', sourceCap: null });
    expect(snapshot.remaining).toMatchObject({ total: 4, buckets: {
      needsHuman: 0, blocked: 1, claimHeld: 1, inFlight: 0, claimable: 1, otherUnclaimable: 1,
    } });
    expect(burnDown.data.fleetMetrics.snapshot.remaining).toEqual(snapshot.remaining);
    const health = snapshot.queueHealth!;
    expect(health.population).toBe(4);
    expect(health.waiting.reviewWait).toMatchObject({ population: 2, known: 1, unknown: 1, oldestMs: null,
      oldestKnownMs: Date.parse(snapshot.scope.window.endAt) - Date.parse(enteredAt) });
    expect(health.controls).toMatchObject({ durableParks: 2 });
    expect(health.releaseConditions).toMatchObject({ flagged: 2 });
    expect(health.releaseConditions.nextAction).toBeTruthy();
    expect(health.releaseConditions.examples).toMatchObject({ total: 2, omitted: 0 });
    expect(health.releaseConditions.examples.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ids[1], parker: 'su-parker', clearer: 'su-condition-owner',
        condition: 'credential supplied', trigger: 'credential:supplied', reachability: 'satisfied',
        ageSource: 'payload.claim_hold_at', nextAction: expect.stringContaining('preserve other floors'),
        recheck: expect.stringContaining('credential:supplied') }),
      expect.objectContaining({ id: ids[2], clearer: null, trigger: null,
        recheck: expect.stringContaining('No recheck trigger recorded') }),
    ]));
    expect(health.overdueReview.examples.rows).toEqual([
      expect.objectContaining({ id: ids[0], submittedBy: 'su-author', clearer: null,
        ledgerIdeaId: ids[0], round: 1,
        ageSource: 'payload.agentReview.timing.enteredAt (matching round)',
        nextAction: expect.stringContaining('independent verifier'),
        recheck: expect.stringContaining('elapsed time never approves') }),
    ]);
    expect(health.verificationService).toEqual({ status: 'not-applicable', reason: 'fleet-spec-is-not-verification' });
    const shaped = shapeLeaderBrief({ ok: true, fleetMetrics: brief }, 'trimmed') as { fleetMetrics: typeof brief };
    expect(shaped.fleetMetrics.snapshot.queueHealth).toEqual(health);

    // Distinguish a hidden dependency from a missing edge: clear only the hold.
    // The primary claim refusal changes, but the report's blocked bucket does not.
    await sql`UPDATE harness_shared.work_items SET payload = payload - '_claimHold'
      WHERE workspace_id = 'default' AND harness_slug = ${HARNESS} AND feature_id = ${ids[2]}`;
    expect(await explainIssueClaimFloors(HARNESS, [ids[2]])).toEqual([
      expect.objectContaining({ admissible: false, refusedBy: 'blocked-dep' }),
    ]);
    const afterRelease = await readLeaderBriefFleetMetrics({ workspaceId: 'default', fleet: FLEET, harness: HARNESS });
    expect(afterRelease.ok).toBe(true);
    if (!afterRelease.ok) throw new Error(afterRelease.reason);
    expect(afterRelease.snapshot.remaining).toEqual(snapshot.remaining);
  }, 30_000);

  it('reads the real verification ledgers and keeps unstaffed outcomes unmeasured', async () => {
    await seedFleet('verification');
    await seedQueue();
    const brief = await readLeaderBriefFleetMetrics({ workspaceId: 'default', fleet: FLEET, harness: HARNESS });
    expect(brief.ok).toBe(true);
    if (!brief.ok) throw new Error(brief.reason);
    expect(brief.snapshot.queueHealth?.verificationService).toMatchObject({
      status: 'known', workers: 0, arrivals: 1, arrivalsUnknown: 1,
      outcomes: null, pickups: null, specId: 'real-health-current-spec',
      basis: 'dated-review-rounds-and-scheduler-dispositions',
    });
  }, 30_000);
});
