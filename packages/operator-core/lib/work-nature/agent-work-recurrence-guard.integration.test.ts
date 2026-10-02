/**
 * agent-work-recurrence-guard.integration.test.ts — the P-012 recurrence guard for the ONE
 * work predicate (plan enterprise-data-sources-2026-10-01; P-009 / D-011 / D-022 / D-024).
 *
 * WHAT IT PROVES. Seeds one work_items row per (nature, audience) class from the P-007
 * census seed table (WORK_SELECTION_SEED_ROWS), plus the two natures that have no live
 * instances yet (document, event), then DRAINS every self-select door until it returns
 * nothing — exactly what an agent told to "drain the queue" does. Every door may serve
 * only rows that are agent work, and every door must serve at least one row, so a door
 * that silently stopped serving anything cannot pass vacuously.
 *
 * WHY IT IS A RECURRENCE GUARD, not a one-off check: the door table is tied to the census.
 * Every `selection` row of WORK_SELECTION_CENSUS must be exercised by a door here or name
 * the door it delegates to (COVERED_BY). Adding a selection path to the census without a
 * door fails this file, and a door whose census id disappears fails it too.
 *
 * THE BY-ID ASYMMETRY IS DELIBERATE (D-024). The by-id claim applies only the CATEGORY half
 * of the predicate (nature + audience). Readiness floors — owner action, the observation
 * lane — stay off the by-id door (work-item-dependency-edges-2026-08-02#D-008: claiming by
 * name is the operator override). So the by-id test asserts only that every non-agent
 * CATEGORY is refused and agent work is still served; it says nothing about lane or owner
 * action rows, and must not be "tidied" into the self-select expectation.
 *
 * FIXTURE NOTE. This narrow fixture has no D-018 stamping trigger (production derives
 * nature/audience from datatype_registry at mint), so each row's category is written
 * directly, as the trigger would stamp it for that kind (stampedCategory below).
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   npm run test:file -- packages/operator-core/lib/work-nature/agent-work-recurrence-guard.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEventSubstrateMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { WORK_SELECTION_CENSUS, WORK_SELECTION_SEED_ROWS, type WorkSelectionSeedRow } from '../work-selection-census';
import { isAgentWork } from './agent-work-predicate';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l) && !/\bGRANT\b/.test(l) && !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
const leaderDispatchAdmission = vi.hoisted(() => ({
  resolveFleetScopeContext: vi.fn(),
  fleetControlWindDownRefusal: vi.fn(),
  leaderDispatchedAdmission: vi.fn(),
  selfFiledFalloutAdmission: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});
vi.mock('../work-item-lock-release', () => ({
  releaseReclaimedWorkItemLocks: async () => ({ releases: [], failures: 0, skipped: null }),
}));
vi.mock('../scheduler/fleet-scope-admission', () => ({
  resolveFleetScopeContext: (...a: unknown[]) => leaderDispatchAdmission.resolveFleetScopeContext(...a),
  fleetControlWindDownRefusal: (...a: unknown[]) => leaderDispatchAdmission.fleetControlWindDownRefusal(...a),
  leaderDispatchedAdmission: (...a: unknown[]) => leaderDispatchAdmission.leaderDispatchedAdmission(...a),
  selfFiledFalloutAdmission: (...a: unknown[]) => leaderDispatchAdmission.selfFiledFalloutAdmission(...a),
}));

const WS = 'default';
const H = 'papercup';

const wi = await import('../work-items');
const { getNextWorkItemDefault, readIssueClaimability } = await import('../scheduler/get-next');

// ---------------------------------------------------------------------------
// The seed population.
// ---------------------------------------------------------------------------

/** Every value the work_items.nature column carries (migration 1322 column comment, D-011). */
const NATURES = ['work', 'record', 'document', 'event'] as const;

/**
 * Natures with no work_items instances today. The census defers their seeds to P-012; the
 * column admits them, so a guard over "every nature" seeds them too.
 */
const EXTRA_SEEDS: readonly WorkSelectionSeedRow[] = [
  { itemKind: 'org-document', nature: 'document', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: 'P-012: document nature (D-005)' },
  { itemKind: 'slack-message', nature: 'event', audience: null, payload: {}, status: 'open', expectAgentClaimable: false, source: 'P-012: event nature (D-001)' },
];

interface Seeded {
  id: string;
  seed: WorkSelectionSeedRow;
  nature: string;
  audience: string | null;
  status: string;
}

/**
 * What the D-018 trigger stamps for the seed's kind. Two census labels are not nature
 * values: 'internal-excluded' (an observation-lane row) and 'retired' (chunk) are kinds the
 * registry maps to work/agent, so the exclusion must come from the lane or from the
 * terminal status — D-022 point 2 says to seed chunk terminal rather than add a chunk case.
 * The needs-owner-action row is a bug, which the trigger stamps work/agent; stamping it
 * 'human' would let the audience test hide a broken needs_owner_action exclusion.
 */
function stampedCategory(seed: WorkSelectionSeedRow): { nature: string; audience: string | null; status: string } {
  if (seed.nature === 'internal-excluded') return { nature: 'work', audience: 'agent', status: seed.status };
  if (seed.nature === 'retired') return { nature: 'work', audience: 'agent', status: 'passed' };
  if (seed.payload.needsOwnerAction === true) return { nature: 'work', audience: 'agent', status: seed.status };
  return { nature: seed.nature, audience: seed.audience, status: seed.status };
}

const SEEDS: Seeded[] = [...WORK_SELECTION_SEED_ROWS, ...EXTRA_SEEDS].map((seed, i) => ({
  id: `NG-${String(i).padStart(2, '0')}-${seed.itemKind}`,
  seed,
  ...stampedCategory(seed),
}));
const EXPECTED = new Set(SEEDS.filter((s) => s.seed.expectAgentClaimable).map((s) => s.id));
const label = (id: string) => {
  const s = SEEDS.find((x) => x.id === id);
  return s ? `${id} (${s.nature}/${s.audience ?? '-'} ${JSON.stringify(s.seed.payload)} ${s.status})` : `${id} (not seeded)`;
};

async function seedAll(): Promise<void> {
  for (const [i, s] of SEEDS.entries()) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, title, item_kind, status, taken_by, workspace_id, created_ts, updated_ts,
         origin, payload, nature, audience)
      VALUES (${H}, ${s.id}, ${`seed ${s.id}`}, ${s.seed.itemKind}, ${s.status}, NULL, ${WS}, ${100 + i}, 0,
              'local', ${JSON.stringify(s.seed.payload)}::text::jsonb, ${s.nature}, ${s.audience})`;
  }
}

// ---------------------------------------------------------------------------
// The door table — every `selection` path of the P-007 census.
// ---------------------------------------------------------------------------

interface DrainDoor {
  name: string;
  /** WORK_SELECTION_CENSUS ids this door exercises. */
  census: string[];
  /** Claim the next item; null when the door has nothing left to serve. */
  next: () => Promise<string | null>;
}

const DRAIN_DOORS: DrainDoor[] = [
  {
    name: 'claimNextWorkItem (feature floors + frontier placement)',
    census: ['claim-floors-feature', 'frontier-placement-clause', 'claim-next-tool'],
    next: async () => (await wi.claimNextWorkItem({ harness: H, assignee: 'drain-probe' }))?.id ?? null,
  },
  {
    name: 'claimNextIssueWorkItem (issue family)',
    census: ['claim-next-tool'],
    next: async () => (await wi.claimNextIssueWorkItem({ harness: H, assignee: 'drain-probe' }, WS))?.id ?? null,
  },
  {
    name: 'getNextWorkItemDefault (scheduler:get_next)',
    census: ['get-next-issue'],
    next: async () => (await getNextWorkItemDefault({ assignee: 'drain-probe' }, { harness: H }))?.workItem.id ?? null,
  },
];

/** Census selection rows with no door of their own, and the door that carries them. */
const COVERED_BY: Record<string, string> = {
  'fleet-scope-admission': 'getNextWorkItemDefault — the census row delegates to the get-next floors',
  'claimable-tool': 'readIssueClaimability preview test below',
  'by-id-claim': 'claimWorkItem by-id test below',
};

async function drain(door: DrainDoor): Promise<string[]> {
  const served: string[] = [];
  for (let i = 0; i <= SEEDS.length; i++) {
    const id = await door.next();
    if (id === null) return served;
    if (served.includes(id)) throw new Error(`${door.name} served ${id} twice — the claim did not stick`);
    served.push(id);
  }
  throw new Error(`${door.name} served more rows than were seeded: ${served.join(', ')}`);
}

// ---------------------------------------------------------------------------

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('agent-work-recurrence-guard');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(readMigration('140-plan-item-assignments.sql')).simple();
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  // The claim path reads the active operation-worker receipt (adv_sessions / session_briefs /
  // blueprint_specifications). Without them every claim throws "operation claim authority
  // unavailable" — the WI-10005130 fixture gap — and this guard would measure nothing.
  await db.sql
    .unsafe(`
      CREATE TABLE harness_shared.adv_sessions (
        id bigserial PRIMARY KEY, workspace_id text NOT NULL, coord_owner_id text,
        role text, started_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz, ended_by text, launch_spec jsonb
      );
      CREATE TABLE harness_shared.session_briefs (
        workspace_id text NOT NULL, owner_id text NOT NULL, control_state jsonb,
        PRIMARY KEY (workspace_id, owner_id)
      );
      CREATE TABLE harness_shared.blueprint_specifications (
        workspace_id text NOT NULL, harness_slug text NOT NULL,
        specification_revision text NOT NULL, artifact jsonb NOT NULL,
        PRIMARY KEY (workspace_id, harness_slug, specification_revision)
      );
      ALTER TABLE harness_shared.work_items
        ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
        ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz,
        ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`)
    .simple();
  await applyEventSubstrateMigrationsForTest(db.sql, { label: 'agent-work-recurrence-guard.integration.test.ts' });
  await ensureCoordCapabilityTables(db.sql);
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`
    TRUNCATE harness_shared.work_items,
             harness_shared.event_awaits,
             harness_shared.event_wake_deliveries,
             harness_shared.event_key_fires,
             harness_shared.predicate_watches`;
  leaderDispatchAdmission.resolveFleetScopeContext.mockReset().mockResolvedValue(null);
  leaderDispatchAdmission.fleetControlWindDownRefusal.mockReset().mockResolvedValue(null);
  leaderDispatchAdmission.leaderDispatchedAdmission.mockReset().mockResolvedValue(false);
  leaderDispatchAdmission.selfFiledFalloutAdmission.mockReset().mockReturnValue(false);
  await seedAll();
});

describe('P-012: the seed population and the door table are complete', () => {
  it('seeds every nature, a human-audience work row, and agrees with the predicate twin', () => {
    expect(new Set(SEEDS.map((s) => s.nature))).toEqual(new Set(NATURES));
    expect(SEEDS.some((s) => s.nature === 'work' && s.audience === 'human')).toBe(true);
    // The census expectation and the in-memory predicate must agree row by row, so a seed
    // whose expectation drifts from the predicate fails here, not as a confusing door failure.
    for (const s of SEEDS) {
      const terminal = !['open', 'wip', 'blocked'].includes(s.status);
      const agent = isAgentWork({
        nature: s.nature,
        audience: s.audience,
        lane: (s.seed.payload.lane as string | undefined) ?? null,
        needsOwnerAction: s.seed.payload.needsOwnerAction === true,
      });
      expect({ id: s.id, claimable: agent && !terminal }).toEqual({ id: s.id, claimable: s.seed.expectAgentClaimable });
    }
  });

  it('every census `selection` path has a door here, and every door names a live census row', () => {
    const selection = WORK_SELECTION_CENSUS.filter((r) => r.role === 'selection').map((r) => r.id);
    const doored = new Set([...DRAIN_DOORS.flatMap((d) => d.census), ...Object.keys(COVERED_BY)]);
    expect(selection.filter((id) => !doored.has(id))).toEqual([]);
    expect([...doored].filter((id) => !selection.includes(id))).toEqual([]);
  });
});

describe('P-012: a drained self-select door serves only agent work', () => {
  it.each(DRAIN_DOORS.map((d) => [d.name, d] as const))('%s', async (_name, door) => {
    const served = await drain(door);
    expect(served.filter((id) => !EXPECTED.has(id)).map(label)).toEqual([]);
    expect(served.length).toBeGreaterThan(0);
  });

  it('the feature and issue claim doors together drain EXACTLY the agent work, nothing else', async () => {
    const served = [...(await drain(DRAIN_DOORS[0]!)), ...(await drain(DRAIN_DOORS[1]!))];
    expect(served.filter((id) => !EXPECTED.has(id)).map(label)).toEqual([]);
    expect([...EXPECTED].filter((id) => !served.includes(id)).map(label)).toEqual([]);
  });
});

describe('P-012: the claimable preview surfaces only agent work', () => {
  it('readIssueClaimability (work_items:claimable) never lists a non-agent row', async () => {
    const result = await readIssueClaimability(undefined, { harness: H, workspaceId: WS, client: db.sql as never }, { limit: 100 });
    const text = JSON.stringify(result);
    const surfaced = SEEDS.filter((s) => text.includes(`"${s.id}"`)).map((s) => s.id);
    expect(surfaced.filter((id) => !EXPECTED.has(id)).map(label)).toEqual([]);
    expect(surfaced.length).toBeGreaterThan(0);
  });
});

describe('P-012 / D-024: the by-id claim refuses every non-agent category', () => {
  it('refuses records, documents, events and human-audience work by id, and still serves agent work', async () => {
    const live = SEEDS.filter((s) => s.status === 'open');
    const categoryAgent = (s: Seeded) => s.nature === 'work' && s.audience === 'agent';
    const plainAgent = live.filter(
      (s) => categoryAgent(s) && s.seed.payload.lane === undefined && s.seed.payload.needsOwnerAction === undefined,
    );
    const nonAgent = live.filter((s) => !categoryAgent(s));
    expect(nonAgent.length).toBeGreaterThan(0);
    expect(plainAgent.length).toBeGreaterThan(0);

    const servedNonAgent: string[] = [];
    for (const s of nonAgent) {
      if ((await wi.claimWorkItem(s.id, 'byid-probe', { harness: H })) !== null) servedNonAgent.push(label(s.id));
    }
    expect(servedNonAgent).toEqual([]);

    const refusedAgent: string[] = [];
    for (const s of plainAgent) {
      if ((await wi.claimWorkItem(s.id, 'byid-probe', { harness: H }))?.assignee !== 'byid-probe') refusedAgent.push(label(s.id));
    }
    expect(refusedAgent).toEqual([]);
  });
});
