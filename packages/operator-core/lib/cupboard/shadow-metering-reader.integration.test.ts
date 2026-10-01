/**
 * agent-economy-flywheel P-003 (E1, WI-10004287): the shadow statement reader against the real
 * attribution views (1149 + 1177 + 1275) on a fresh Postgres.
 *
 * Pins the parts the pure pricing tests cannot see: which month a sample falls in, how the
 * launch record's layers become slot-qualified refs, that layers are withheld when the launch
 * record no longer carries the revision the span applied, and that tool calls are counted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { readShadowStatement, readShadowUsageAggregates, shadowMonthBounds } from './shadow-metering-reader';

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = resolve(here, '../../../../libs/papercusp/libs/db/sql');
const MIGRATIONS = [
  '1149-session-identity-activation-spans.sql',
  '1177-identity-usage-carry-correlation.sql',
  '1275-identity-attribution-indexed-spans.sql',
];
const WS = 'shadow-reader-ws';
const OTHER_WS = 'shadow-reader-other';
const OWNER = 'su-shadow-reader';
const SPEC_A = 'a'.repeat(64);
const SPEC_B = 'b'.repeat(64);
const SPEC_NEWER = 'c'.repeat(64);
const MONTH = '2026-08';

let db: FreshPgDb;

const ms = (iso: string) => new Date(iso).getTime();

/** A specification input as the compiler records it; `slots` marks an identity layer. */
function layer(ref: string, slots?: string[]) {
  return {
    kind: 'blueprint-layer',
    ref,
    sourceKind: slots ? 'identity' : 'blueprint',
    document: { id: ref, ...(slots ? { slots: slots.map((slot) => ({ slot })) } : {}) },
  };
}

function launchSpec(revision: string, agent: string, inputs: unknown[]) {
  return { agent, profile: 'engineer', specificationRevision: revision, stateRevision: 'state-1', specificationArtifact: { inputs } };
}

beforeAll(async () => {
  db = await createFreshPgDb('shadow-metering-reader');
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.adv_sessions (
      id bigint PRIMARY KEY, workspace_id text NOT NULL, coord_owner_id text,
      session_id text, started_at timestamptz NOT NULL, ended_at timestamptz,
      ended_by text, launch_spec jsonb
    );
    CREATE TABLE harness_shared.session_briefs (
      owner_id text PRIMARY KEY, workspace_id text NOT NULL,
      native_session_id text, control_generation bigint NOT NULL,
      control_delivered_generation bigint NOT NULL DEFAULT 0,
      control_state jsonb
    );
    CREATE TABLE harness_shared.tool_invocations (
      id bigint PRIMARY KEY, workspace_id text NOT NULL,
      coord_owner_id text, invoked_at timestamptz NOT NULL
    );
    -- The real table's column prefix, in order (1275 names these columns explicitly).
    CREATE TABLE harness_shared.agent_usage_samples (
      id bigint PRIMARY KEY, workspace_id text NOT NULL, ts bigint NOT NULL,
      bucket_key text, provider text, model_class text, source text,
      input_tokens bigint, output_tokens bigint, cache_read_tokens bigint,
      cost_usd double precision, rl_requests_limit bigint, rl_requests_remaining bigint,
      rl_tokens_limit bigint, rl_tokens_remaining bigint, rl_reset_at bigint,
      model text, cost_source text, harness_slug text, run_id text, role text,
      cache_creation_tokens bigint, turn_count integer, session_id text,
      tool_name text, turn_trigger text, account_id text, goal_id text
    );
    CREATE TABLE harness_shared.session_archives (adv_session_id bigint, session_id text NOT NULL);
    CREATE TABLE harness_shared.session_turns (
      workspace_id text NOT NULL, source_kind text NOT NULL, session_id text NOT NULL, owner text
    );
  `);
  for (const file of MIGRATIONS) await applyMigrationForTest(db.sql, resolve(sqlDir, file));

  const specA = launchSpec(SPEC_A, 'codex', [
    layer('base'),
    layer('papercusp-engineer', ['domain']),
    layer('papercusp'),
    // A slot-bearing input that is not a blueprint layer carries no identity.
    { kind: 'package', ref: 'pkg-with-slot', document: { slots: [{ slot: 'domain' }] } },
    { kind: 'setting', ref: 'model' },
  ]);
  const specNewer = launchSpec(SPEC_NEWER, 'claude', [layer('papercusp-engineer', ['domain'])]);
  await db.sql`INSERT INTO harness_shared.adv_sessions VALUES
    (1,${WS},${OWNER},'adv-key-1','2026-08-01T00:00:00Z',NULL,NULL,${JSON.stringify(specA)}::text::jsonb),
    (2,${WS},${OWNER},'adv-key-2','2026-08-01T00:00:00Z',NULL,NULL,${JSON.stringify(specNewer)}::text::jsonb)`;
  const applied = (row: { gen: number; session: string; adv: number; native: string; spec: string; stack: string[] }) => db.sql`
    INSERT INTO harness_shared.session_identity_activation_events
      (workspace_id,owner_id,actor_id,principal_id,session_id,adv_session_id,native_session_id,
       transition_id,control_generation,phase,source,specification_revision,state_revision,stack_refs,recorded_at)
    VALUES (${WS},${OWNER},${OWNER},'principal-shadow',${row.session},${row.adv},${row.native},
      ${`t${row.gen}`},${row.gen},'applied','control',${row.spec},'state-1',
      ${JSON.stringify(row.stack)}::text::jsonb,'2026-08-01T00:01:00Z'::timestamptz)`;
  await applied({ gen: 1, session: 'shadow-p1', adv: 1, native: 'native-shadow-1', spec: SPEC_A, stack: ['autonomy:su.mode-auto'] });
  // The span applied SPEC_B; the launch record has since moved on to SPEC_NEWER.
  await applied({ gen: 2, session: 'shadow-p2', adv: 2, native: 'native-shadow-2', spec: SPEC_B, stack: [] });

  const sample = (id: number, ws: string, session: string | null, at: string, cost: number | null, source: string | null) => db.sql`
    INSERT INTO harness_shared.agent_usage_samples (id, workspace_id, session_id, ts, cost_usd, cost_source)
    VALUES (${id},${ws},${session},${ms(at)},${cost},${source})`;
  await sample(101, WS, 'native-shadow-1', '2026-08-15T00:00:00Z', 1.0, 'provider');
  await sample(102, WS, 'native-shadow-1', '2026-08-15T01:00:00Z', 0.5, 'estimated');
  await sample(103, WS, 'native-shadow-2', '2026-08-16T00:00:00Z', 2.0, 'estimated');
  await sample(104, WS, 'unknown-session', '2026-08-17T00:00:00Z', 0.25, 'estimated');
  await sample(105, WS, 'native-shadow-1', '2026-09-01T00:00:00Z', 7.0, 'provider');       // next month (end exclusive)
  await sample(106, WS, 'native-shadow-1', '2026-07-31T23:59:59.999Z', 11.0, 'provider');  // previous month
  await sample(107, OTHER_WS, 'native-shadow-1', '2026-08-15T00:00:00Z', 3.0, 'provider'); // other workspace
  await sample(108, WS, null, '2026-08-18T00:00:00Z', null, null);                        // keyless, costless
  await sample(109, WS, 'native-shadow-1', '2026-08-01T00:00:00Z', 0.125, 'estimated');  // month start, before the span

  await db.sql`INSERT INTO harness_shared.tool_invocations VALUES
    (201,${WS},${OWNER},'2026-08-15T00:00:00Z'),
    (202,${WS},'someone-else','2026-08-15T00:00:00Z'),
    (203,${WS},${OWNER},'2026-09-01T00:00:00Z'),
    (204,${OTHER_WS},${OWNER},'2026-08-15T00:00:00Z')`;
}, 90_000);

afterAll(async () => db?.cleanup());

describe('shadowMonthBounds', () => {
  it('returns UTC month bounds, end exclusive, across a year boundary', () => {
    expect(shadowMonthBounds('2026-12')).toEqual({ startMs: ms('2026-12-01T00:00:00Z'), endMs: ms('2027-01-01T00:00:00Z') });
    expect(() => shadowMonthBounds('2026-13')).toThrow(/YYYY-MM/);
    expect(() => shadowMonthBounds('2026-8')).toThrow(/YYYY-MM/);
  });
});

describe('readShadowStatement (P-003)', () => {
  it('prices one workspace-month from the attribution views', async () => {
    const st = await readShadowStatement(db.sql, { workspaceId: WS, month: MONTH });
    // In month and workspace: 101, 102, 103, 104, 108, 109.
    expect(st.inference).toEqual({ costMicros: 3_875_000, billGradeMicros: 1_000_000, samples: 6 });
    expect(st.lines).toEqual([
      { identityClass: 'domain:papercusp-engineer', basis: 'specification-layer', markupBps: 2000,
        baseMicros: 1_500_000, markupMicros: 300_000, daoMicros: 30_000, sellerMicros: 270_000, samples: 2 },
      { identityClass: 'papercusp-engineer', basis: 'inferred-profile', markupBps: 2000,
        baseMicros: 2_000_000, markupMicros: 400_000, daoMicros: 40_000, sellerMicros: 360_000, samples: 1 },
    ]);
    expect(st.totals).toEqual({ markupMicros: 700_000, daoMicros: 70_000, sellerMicros: 630_000, wouldHaveChargedMicros: 700_000 });
    expect(st.zeroPriced).toEqual({
      axisLayers: [{ layerRef: 'autonomy:su.mode-auto', baseMicros: 1_500_000 }],
      toolCalls: { attributed: 1, unattributed: 1 },
    });
    expect(st.cleanliness).toEqual({
      verdict: 'not-bill-grade',
      reasons: ['unattributed-cost', 'estimated-cost', 'inferred-base-identity'],
      attributedShareBps: 9032,
      billGradeCostShareBps: 2580,
      inferredShareBps: 5714,
      unattributedMicros: 375_000,
      unclassifiedMicros: 0,
    });
  });

  it('reads slot-qualified layers only while the launch record carries the applied revision', async () => {
    const layersFor = async () => {
      const rows = await readShadowUsageAggregates(db.sql, { workspaceId: WS, month: MONTH });
      return rows.filter((r) => r.attributed)
        .map((r) => ({ agent: r.agent, profile: r.profile, layers: r.specificationLayerRefs }))
        .sort((a, b) => String(a.agent).localeCompare(String(b.agent)));
    };
    expect(await layersFor()).toEqual([
      { agent: 'claude', profile: 'engineer', layers: [] },
      { agent: 'codex', profile: 'engineer', layers: ['domain:papercusp-engineer'] },
      { agent: 'codex', profile: 'engineer', layers: ['domain:papercusp-engineer'] },
    ]);
    // Positive control for the revision gate: once the record carries SPEC_B, its layer is read.
    await db.sql`UPDATE harness_shared.adv_sessions
      SET launch_spec = jsonb_set(launch_spec, '{specificationRevision}', to_jsonb(${SPEC_B}::text)) WHERE id = 2`;
    try {
      expect((await layersFor())[0]).toEqual({ agent: 'claude', profile: 'engineer', layers: ['domain:papercusp-engineer'] });
    } finally {
      await db.sql`UPDATE harness_shared.adv_sessions
        SET launch_spec = jsonb_set(launch_spec, '{specificationRevision}', to_jsonb(${SPEC_NEWER}::text)) WHERE id = 2`;
    }
  });

  it('returns an itemized no-usage statement for a month with no activity', async () => {
    const st = await readShadowStatement(db.sql, { workspaceId: WS, month: '2026-06' });
    expect(st).toMatchObject({ workspaceId: WS, month: '2026-06', lines: [], totals: { wouldHaveChargedMicros: 0 } });
    expect(st.zeroPriced.toolCalls).toEqual({ attributed: 0, unattributed: 0 });
    expect(st.cleanliness).toMatchObject({ verdict: 'not-bill-grade', reasons: ['no-usage'] });
  });
});
