import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  acknowledgeControlTransition,
  convergeActivationToLaunchRecord,
  failControlTransitionActivation,
} from './agent-tools/coordination/control-anchor';
import { recordCurrentSessionIdentityActivation } from './session-identity-attribution';

const here = dirname(fileURLToPath(import.meta.url));
const migration = resolve(here, '../../../libs/papercusp/libs/db/sql/1149-session-identity-activation-spans.sql');
const carryMigration = resolve(here, '../../../libs/papercusp/libs/db/sql/1177-identity-usage-carry-correlation.sql');
const WS = 'identity-activation-test';
const OWNER = 'su-identity-test';
const SPEC_A = 'a'.repeat(64);
const SPEC_B = 'b'.repeat(64);

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('session-identity-attribution');
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
    CREATE TABLE harness_shared.agent_usage_samples (
      id bigint PRIMARY KEY, workspace_id text NOT NULL,
      session_id text, ts bigint NOT NULL
    );
    CREATE TABLE harness_shared.session_archives (
      adv_session_id bigint, session_id text NOT NULL
    );
    CREATE TABLE harness_shared.session_turns (
      workspace_id text NOT NULL, source_kind text NOT NULL,
      session_id text NOT NULL, owner text
    );
  `);
  await applyMigrationForTest(db.sql, migration);
  await applyMigrationForTest(db.sql, carryMigration);
}, 90_000);

afterAll(async () => db?.cleanup());

const ms = (iso: string) => new Date(iso).getTime();

/** A launch record carrying a real compiled specification, as the kernel resolver requires. */
function compiledLaunch(seed: string, stateRevision = `state-${seed}`) {
  const artifact = compileAgentSpecification({
    source: { id: `attribution-${seed}`, workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
    prompt: { role: 'worker', text: `attribution fixture ${seed}` },
    inputClosure: [],
  });
  const revision = { specificationRevision: artifact.specificationRevision, stateRevision };
  return { revision, launchSpec: { ...revision, specificationArtifact: artifact } };
}

async function event(input: {
  id: number; phase: string; at: string; spec: string; state: string;
  stack: string[]; transition: string; source?: string; failure?: string | null;
}) {
  await db.sql`
    INSERT INTO harness_shared.session_identity_activation_events
      (workspace_id,owner_id,actor_id,principal_id,session_id,adv_session_id,native_session_id,
       transition_id,control_generation,phase,source,specification_revision,state_revision,
       stack_refs,failure,recorded_at)
    VALUES (${WS},${OWNER},'actor-stable','principal-stable','session-stable',1,'native-a',
      ${input.transition},${input.id},${input.phase},${input.source ?? 'control'},${input.spec},
      ${input.state},${JSON.stringify(input.stack)}::text::jsonb,${input.failure ?? null},${input.at}::timestamptz)`;
}

describe('P-009 activation span views', () => {
  it('keeps failed/pending switches on the prior applied span and joins switch, revocation, and restart', async () => {
    await db.sql`INSERT INTO harness_shared.adv_sessions VALUES
      (1,${WS},${OWNER},'native-a','2026-09-09T00:00:00Z',NULL)`;
    await db.sql`INSERT INTO harness_shared.session_archives VALUES (1,'native-old')`;

    await event({ id: 1, phase: 'applied', at: '2026-09-09T00:01:00Z', spec: SPEC_A,
      state: 'state-a', stack: ['domain:researcher','autonomy:su.mode-auto'], transition: 'a' });
    await event({ id: 2, phase: 'desired', at: '2026-09-09T00:02:00Z', spec: SPEC_B,
      state: 'state-b', stack: ['domain:writer'], transition: 'b' });
    await event({ id: 2, phase: 'failed', at: '2026-09-09T00:03:00Z', spec: SPEC_B,
      state: 'state-b', stack: ['domain:writer'], transition: 'b', failure: 'render failed' });
    await event({ id: 3, phase: 'applied', at: '2026-09-09T00:04:00Z', spec: SPEC_B,
      state: 'state-b', stack: ['domain:writer'], transition: 'b-retry' });
    await event({ id: 4, phase: 'applied', at: '2026-09-09T00:05:00Z', spec: SPEC_B,
      state: 'revoked', stack: [], transition: 'revoke' });
    await event({ id: 5, phase: 'applied', at: '2026-09-09T00:06:00Z', spec: SPEC_B,
      state: 'revoked', stack: [], transition: 'restart', source: 'restart' });

    await db.sql`INSERT INTO harness_shared.tool_invocations VALUES
      (11,${WS},${OWNER},'2026-09-09T00:03:30Z'),
      (12,${WS},${OWNER},'2026-09-09T00:04:30Z'),
      (13,${WS},${OWNER},'2026-09-09T00:05:30Z')`;
    await db.sql`INSERT INTO harness_shared.agent_usage_samples VALUES
      (21,${WS},'native-old',${ms('2026-09-09T00:03:30Z')}),
      (22,${WS},'native-a',${ms('2026-09-09T00:06:30Z')}),
      (23,${WS},'native-carry-successor',${ms('2026-09-09T00:03:45Z')})`;
    // A carry respawn rewrites adv_sessions.session_id in place. The existing
    // session_turns index retains the successor native id and its owner, which
    // is the only safe bridge for this intermediate sample.
    await db.sql`INSERT INTO harness_shared.session_turns VALUES
      (${WS},'codex','native-carry-successor',${OWNER})`;

    const tools = await db.sql<Array<{ id: string; identity_state_revision: string; identity_stack_refs: string[] }>>`
      SELECT id::text, identity_state_revision, identity_stack_refs
        FROM harness_shared.tool_invocations_identity_attribution ORDER BY id`;
    expect(tools).toEqual([
      { id: '11', identity_state_revision: 'state-a', identity_stack_refs: ['domain:researcher','autonomy:su.mode-auto'] },
      { id: '12', identity_state_revision: 'state-b', identity_stack_refs: ['domain:writer'] },
      { id: '13', identity_state_revision: 'revoked', identity_stack_refs: [] },
    ]);

    const usage = await db.sql<Array<{ id: string; identity_transition_id: string }>>`
      SELECT id::text, identity_transition_id
        FROM harness_shared.agent_usage_samples_identity_attribution ORDER BY id`;
    expect(usage).toEqual([
      { id: '21', identity_transition_id: 'a' },
      { id: '22', identity_transition_id: 'restart' },
      { id: '23', identity_transition_id: 'a' },
    ]);

    const layers = await db.sql<Array<{ layer_ref: string; active_until: Date }>>`
      SELECT layer_ref, active_until FROM harness_shared.session_identity_layer_spans
       WHERE transition_id='a' ORDER BY layer_ref`;
    expect(layers.map((row) => row.layer_ref)).toEqual(['autonomy:su.mode-auto','domain:researcher']);
    expect(new Date(layers[0]!.active_until).toISOString()).toBe('2026-09-09T00:04:00.000Z');
  });

  it('records the exact current generation idempotently through the store', async () => {
    const revision = { specificationRevision: SPEC_A, stateRevision: 'store-state' };
    const activation = {
      schemaVersion: 1, attribution: { actorId: 'actor-stable', principalId: 'principal-stable', sessionId: 'session-stable' },
      desired: revision, prepared: revision, applied: null, status: 'prepared',
    };
    await db.sql`INSERT INTO harness_shared.session_briefs
      (owner_id,workspace_id,native_session_id,control_generation,control_state)
      VALUES (${OWNER},${WS},'native-a',99,${JSON.stringify({ activation, stack: ['domain:researcher'] })}::text::jsonb)`;
    const input = { workspaceId: WS, ownerId: OWNER, generation: 99, phase: 'prepared' as const,
      source: 'control' as const, revision, sql: db.sql };
    await expect(recordCurrentSessionIdentityActivation(input)).resolves.toBe('inserted');
    await expect(recordCurrentSessionIdentityActivation(input)).resolves.toBe('replayed');
  });

  it('preserves intermediate carry usage after reanchor without widening owner, workspace or applied-time attribution', async () => {
    const owner = 'su-carry-attribution';
    await db.sql`INSERT INTO harness_shared.adv_sessions VALUES
      (90,${WS},${owner},'carry-middle','2026-09-10T00:00:00Z',NULL)`;
    // As in a real carry, host acceptance predates native registration: the
    // receipt still names the preceding native id, on the same stable adv row.
    await db.sql`INSERT INTO harness_shared.session_identity_activation_events
      (workspace_id,owner_id,actor_id,principal_id,session_id,adv_session_id,native_session_id,
       transition_id,control_generation,phase,source,specification_revision,state_revision,stack_refs,recorded_at)
      VALUES
      (${WS},${owner},${owner},'principal-carry','logical-carry',90,'carry-before',
       'carry-applied',90,'applied','control',${SPEC_A},'carry-state','["domain:researcher"]','2026-09-10T00:01:00Z'),
      (${WS},${owner},${owner},'principal-carry','logical-carry',90,'carry-before',
       'carry-pending',91,'desired','control',${SPEC_B},'pending-state','["domain:writer"]','2026-09-10T00:02:00Z'),
      (${WS},${owner},${owner},'principal-carry','logical-carry',90,'carry-middle',
       'carry-revoked',92,'applied','control',${SPEC_B},'revoked-state','[]','2026-09-10T00:04:00Z')`;
    await db.sql`INSERT INTO harness_shared.session_turns VALUES
      ('default','codex','carry-middle',${owner}),
      ('default','codex','carry-middle',NULL),
      ('foreign-workspace','codex','carry-foreign',${owner}),
      ('default','agent_chat','carry-chat',${owner}),
      ('default','codex','carry-ambiguous',${owner}),
      ('default','codex','carry-ambiguous','another-owner')`;
    await db.sql`INSERT INTO harness_shared.agent_usage_samples VALUES
      (901,${WS},'carry-middle',${ms('2026-09-10T00:03:00Z')}),
      (902,${WS},'carry-middle',${ms('2026-09-10T00:00:30Z')}),
      (903,${WS},'carry-middle',${ms('2026-09-10T00:04:00Z')}),
      (904,${WS},'carry-foreign',${ms('2026-09-10T00:03:00Z')}),
      (905,${WS},'carry-chat',${ms('2026-09-10T00:03:00Z')}),
      (906,${WS},'carry-ambiguous',${ms('2026-09-10T00:03:00Z')}),
      (907,'foreign-workspace','carry-middle',${ms('2026-09-10T00:03:00Z')}),
      (908,${WS},'carry-before',${ms('2026-09-10T00:03:00Z')})`;
    const read = () => db.sql`
      SELECT id::text, identity_transition_id, identity_owner_id
        FROM harness_shared.agent_usage_samples_identity_attribution WHERE id >= 901 ORDER BY id`;
    const expected = [
      { id: '901', identity_transition_id: 'carry-applied', identity_owner_id: owner },
      { id: '902', identity_transition_id: null, identity_owner_id: null },
      { id: '903', identity_transition_id: 'carry-revoked', identity_owner_id: owner },
      ...['904', '905', '906', '907'].map((id) => ({ id, identity_transition_id: null, identity_owner_id: null })),
      { id: '908', identity_transition_id: 'carry-applied', identity_owner_id: owner },
    ];
    expect(await read()).toEqual(expected);
    await db.sql`UPDATE harness_shared.adv_sessions SET session_id='carry-after' WHERE id=90`;
    expect(await read()).toEqual(expected);

    // Calibrate the regression against the actual predecessor view, not a
    // hand-written approximation: after reanchor it loses the middle native id
    // even though the applied event and transcript-owner mapping still exist.
    // Only this disposable database is changed; never downgrade the live view.
    await applyMigrationForTest(db.sql, migration);
    try {
      const [withoutBridge] = await db.sql`
        SELECT identity_transition_id, identity_owner_id
          FROM harness_shared.agent_usage_samples_identity_attribution WHERE id=901`;
      expect(withoutBridge).toEqual({
        identity_transition_id: null,
        identity_owner_id: null,
      });
      const [positiveControl] = await db.sql`
        SELECT identity_transition_id
          FROM harness_shared.agent_usage_samples_identity_attribution WHERE id=908`;
      expect(positiveControl).toEqual({ identity_transition_id: 'carry-applied' });
    } finally {
      await applyMigrationForTest(db.sql, carryMigration);
    }
    // The repaired view restores the historical sample without weakening the
    // pending/revocation, workspace, source-kind, or ambiguous-owner exclusions.
    expect(await read()).toEqual(expected);
  });

  // EI-23703586803892464, the measured shape: a sibling launch record minted
  // `desired`, but the kernel selects a DIFFERENT, still-open row. Acknowledging
  // would have written an `applied` that row cannot resolve — a total tool wedge.
  it('refuses to acknowledge a revision the gate-selected launch record does not run', async () => {
    const owner = `${OWNER}-sibling`;
    const running = compiledLaunch('running');
    const sibling = compiledLaunch('sibling');
    await db.sql`INSERT INTO harness_shared.adv_sessions (id,workspace_id,coord_owner_id,session_id,started_at,launch_spec)
      VALUES (9101,${WS},${owner},'native-sibling','2026-09-22T21:43:05Z',${JSON.stringify(sibling.launchSpec)}::text::jsonb),
             (9102,${WS},${owner},'native-running','2026-09-22T21:43:36Z',${JSON.stringify(running.launchSpec)}::text::jsonb)`;
    const activation = {
      schemaVersion: 1,
      attribution: { actorId: 'actor-stable', principalId: 'principal-stable', sessionId: 'session-stable' },
      desired: sibling.revision,
      prepared: sibling.revision,
      applied: running.revision,
      status: 'prepared',
    };
    await db.sql`
      INSERT INTO harness_shared.session_briefs
        (owner_id,workspace_id,native_session_id,control_generation,control_delivered_generation,control_state)
      VALUES (${owner},${WS},'native-running',50,49,${JSON.stringify({ activation })}::text::jsonb)`;

    await expect(acknowledgeControlTransition(owner, WS, 50, db.sql, sibling.revision)).resolves.toBe(false);

    const [row] = await db.sql<Array<{ delivered: string; applied: unknown; status: string }>>`
      SELECT control_delivered_generation::text AS delivered,
             control_state->'activation'->'applied' AS applied,
             control_state #>> '{activation,status}' AS status
        FROM harness_shared.session_briefs
       WHERE owner_id = ${owner}`;
    expect(row).toEqual({ delivered: '49', applied: running.revision, status: 'prepared' });
  });

  // EI-23886889674609842 defect #1 on real PG: relaunched on `desired`, render failed.
  it('converges applied to the relaunched desired but leaves the delivery watermark pending', async () => {
    const owner = `${OWNER}-converge`;
    const relaunched = compiledLaunch('relaunched');
    const previous = compiledLaunch('previous').revision;
    await db.sql`INSERT INTO harness_shared.adv_sessions (id,workspace_id,coord_owner_id,session_id,started_at,launch_spec)
      VALUES (9201,${WS},${owner},'native-converge','2026-09-22T22:00:00Z',${JSON.stringify(relaunched.launchSpec)}::text::jsonb)`;
    const activation = {
      schemaVersion: 1,
      attribution: { actorId: 'actor-stable', principalId: 'principal-stable', sessionId: 'session-stable' },
      desired: relaunched.revision, prepared: null, applied: previous, status: 'failed',
    };
    await db.sql`
      INSERT INTO harness_shared.session_briefs
        (owner_id,workspace_id,native_session_id,control_generation,control_delivered_generation,control_state)
      VALUES (${owner},${WS},'native-converge',60,59,${JSON.stringify({ activation })}::text::jsonb)`;

    await expect(convergeActivationToLaunchRecord(owner, WS, 60, relaunched.revision, db.sql)).resolves.toBe(true);
    // Idempotent: once applied resolves, a retry on the next failed render is a no-op.
    await expect(convergeActivationToLaunchRecord(owner, WS, 60, relaunched.revision, db.sql)).resolves.toBe(false);

    const [row] = await db.sql<Array<{ delivered: string; applied: unknown; status: string }>>`
      SELECT control_delivered_generation::text AS delivered,
             control_state->'activation'->'applied' AS applied,
             control_state #>> '{activation,status}' AS status
        FROM harness_shared.session_briefs
       WHERE owner_id = ${owner}`;
    expect(row).toEqual({ delivered: '59', applied: relaunched.revision, status: 'applied' });
  });

  // P-008 (identity-native-applied-revision-proof) failed-injection negative control
  // on REAL Postgres. The launch record runs `desired` in every case, so the ONLY
  // thing separating Applied from refused is whether the host actually prepared
  // (injected) that revision. The unit tests mock this SQL and can only string-match
  // the `prepared = revision` guard; here Postgres evaluates it.
  describe('reports Applied only after the host injected the selected revision', () => {
    async function seedInjection(suffix: string, id: number, generation: number, injection: {
      prepared: 'revision' | null; status: 'desired' | 'prepared' | 'failed'; failure?: string;
    }) {
      const owner = `${OWNER}-inject-${suffix}`;
      const selected = compiledLaunch(`inject-${suffix}`);
      const previous = compiledLaunch(`inject-${suffix}-previous`).revision;
      await db.sql`INSERT INTO harness_shared.adv_sessions (id,workspace_id,coord_owner_id,session_id,started_at,launch_spec)
        VALUES (${id},${WS},${owner},${`native-inject-${suffix}`},'2026-09-26T00:00:00Z',${JSON.stringify(selected.launchSpec)}::text::jsonb)`;
      const activation = {
        schemaVersion: 1,
        attribution: { actorId: 'actor-stable', principalId: 'principal-stable', sessionId: 'session-stable' },
        desired: selected.revision,
        prepared: injection.prepared === 'revision' ? selected.revision : null,
        applied: previous,
        status: injection.status,
        ...(injection.failure ? { failure: injection.failure } : {}),
      };
      await db.sql`
        INSERT INTO harness_shared.session_briefs
          (owner_id,workspace_id,native_session_id,control_generation,control_delivered_generation,control_state)
        VALUES (${owner},${WS},${`native-inject-${suffix}`},${generation},${generation - 1},
          ${JSON.stringify({ activation, stack: ['domain:researcher'] })}::text::jsonb)`;
      return { owner, revision: selected.revision, previous };
    }

    async function readBack(owner: string) {
      const [brief] = await db.sql<Array<{ delivered: string; applied: unknown; status: string }>>`
        SELECT control_delivered_generation::text AS delivered,
               control_state->'activation'->'applied' AS applied,
               control_state #>> '{activation,status}' AS status
          FROM harness_shared.session_briefs
         WHERE owner_id = ${owner}`;
      const events = await db.sql<Array<{ phase: string; specification_revision: string }>>`
        SELECT phase, specification_revision
          FROM harness_shared.session_identity_activation_events
         WHERE owner_id = ${owner} AND phase = 'applied'`;
      return { brief, events };
    }

    it.each([
      ['staged (desired, never prepared)', 'staged', 9301, 81, { prepared: null, status: 'desired' }],
      ['failed (render failed, prepare skipped)', 'failed', 9302, 82, { prepared: null, status: 'failed', failure: 'render failed' }],
    ] as const)('refuses a %s injection: applied, watermark and receipts stay unchanged', async (_label, suffix, id, generation, injection) => {
      const seeded = await seedInjection(suffix, id, generation, injection);

      await expect(acknowledgeControlTransition(seeded.owner, WS, generation, db.sql, seeded.revision)).resolves.toBe(false);

      const { brief, events } = await readBack(seeded.owner);
      expect(brief).toEqual({ delivered: String(generation - 1), applied: seeded.previous, status: injection.status });
      expect(events).toEqual([]);
    });

    it('positive control: the same launch record with a prepared injection IS acknowledged and receipted', async () => {
      const seeded = await seedInjection('prepared', 9303, 83, { prepared: 'revision', status: 'prepared' });

      await expect(acknowledgeControlTransition(seeded.owner, WS, 83, db.sql, seeded.revision)).resolves.toBe(true);

      const { brief, events } = await readBack(seeded.owner);
      expect(brief).toEqual({ delivered: '83', applied: seeded.revision, status: 'applied' });
      expect(events).toEqual([{ phase: 'applied', specification_revision: seeded.revision.specificationRevision }]);
    });

    // WI-10003459: measured on a live Claude su session — every carry-respawn
    // prepared generation N, then a non-identity control write (orient, loop,
    // scope) bumped the brief to N+1 with the SAME activation. The ack's UPDATE
    // accepts control_generation >= N, but the applied receipt demanded exact
    // equality, returned 'missing', threw, and rolled the whole ack back — so
    // `applied` never landed and the retry failed identically every turn.
    it('acknowledges a prepared generation after an unrelated control bump, but never a future one', async () => {
      const seeded = await seedInjection('bumped', 9304, 84, { prepared: 'revision', status: 'prepared' });
      await db.sql`UPDATE harness_shared.session_briefs SET control_generation = 85 WHERE owner_id = ${seeded.owner}`;

      // Negative control: the receipt still refuses a generation the brief has not reached.
      await expect(recordCurrentSessionIdentityActivation({
        ownerId: seeded.owner, workspaceId: WS, generation: 86, phase: 'prepared', source: 'control',
        revision: seeded.revision, sql: db.sql,
      })).resolves.toBe('missing');

      await expect(acknowledgeControlTransition(seeded.owner, WS, 84, db.sql, seeded.revision)).resolves.toBe(true);

      const { brief, events } = await readBack(seeded.owner);
      expect(brief).toEqual({ delivered: '84', applied: seeded.revision, status: 'applied' });
      expect(events).toEqual([{ phase: 'applied', specification_revision: seeded.revision.specificationRevision }]);
      const [receipt] = await db.sql<Array<{ control_generation: string }>>`
        SELECT control_generation::text FROM harness_shared.session_identity_activation_events
         WHERE owner_id = ${seeded.owner} AND phase = 'applied'`;
      expect(receipt).toEqual({ control_generation: '84' });
    });
  });

  it('rolls back applied state and watermark when the event insert fails', async () => {
    const owner = `${OWNER}-atomic`;
    const previous = { specificationRevision: SPEC_A, stateRevision: 'previous' };
    // The ack guard admits only a revision the selected launch record resolves,
    // so this record must carry a REAL compiled specification — which also makes
    // reaching the forced event failure below the real-PG proof that it admits.
    const { revision, launchSpec } = compiledLaunch('atomic', 'next');
    await db.sql`INSERT INTO harness_shared.adv_sessions (id,workspace_id,coord_owner_id,session_id,started_at,launch_spec)
      VALUES (9001,${WS},${owner},'native-atomic','2026-09-22T00:00:00Z',${JSON.stringify(launchSpec)}::text::jsonb)`;
    const activation = {
      schemaVersion: 1,
      attribution: { actorId: 'actor-stable', principalId: 'principal-stable', sessionId: 'session-stable' },
      desired: revision,
      prepared: revision,
      applied: previous,
      status: 'prepared',
    };
    await db.sql`
      INSERT INTO harness_shared.session_briefs
        (owner_id,workspace_id,native_session_id,control_generation,control_delivered_generation,control_state)
      VALUES (${owner},${WS},'native-atomic',123,122,
        ${JSON.stringify({ activation, stack: ['domain:researcher'] })}::text::jsonb)`;
    await db.sql.unsafe(`
      CREATE OR REPLACE FUNCTION harness_shared.fail_atomic_activation_event()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.owner_id = '${owner}' THEN
          RAISE EXCEPTION 'forced activation event failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_atomic_activation_event
      BEFORE INSERT ON harness_shared.session_identity_activation_events
      FOR EACH ROW EXECUTE FUNCTION harness_shared.fail_atomic_activation_event();
    `);

    await expect(
      acknowledgeControlTransition(owner, WS, 123, db.sql, revision),
    ).rejects.toThrow('forced activation event failure');

    const [row] = await db.sql<Array<{
      delivered: string;
      applied: unknown;
      status: string;
    }>>`
      SELECT control_delivered_generation::text AS delivered,
             control_state->'activation'->'applied' AS applied,
             control_state #>> '{activation,status}' AS status
        FROM harness_shared.session_briefs
       WHERE owner_id = ${owner}`;
    expect(row).toEqual({ delivered: '122', applied: previous, status: 'prepared' });
  });

  it('retains the applied revision and records a failed phase when activation fails', async () => {
    const owner = `${OWNER}-failclosed`;
    const previous = { specificationRevision: SPEC_A, stateRevision: 'applied-previous' };
    const revision = { specificationRevision: SPEC_B, stateRevision: 'desired-next' };
    const activation = {
      schemaVersion: 1,
      attribution: { actorId: 'actor-stable', principalId: 'principal-stable', sessionId: 'session-stable' },
      desired: revision,
      prepared: revision,
      applied: previous,
      status: 'prepared',
    };
    await db.sql`INSERT INTO harness_shared.adv_sessions VALUES
      (7,${WS},${owner},'native-failclosed','2026-09-17T00:00:00Z',NULL)`;
    await db.sql`
      INSERT INTO harness_shared.session_briefs
        (owner_id,workspace_id,native_session_id,control_generation,control_delivered_generation,control_state)
      VALUES (${owner},${WS},'native-failclosed',77,76,
        ${JSON.stringify({ activation, stack: ['domain:researcher'] })}::text::jsonb)`;

    await expect(
      failControlTransitionActivation(owner, WS, 77, revision, 'render failed', db.sql),
    ).resolves.toBe(true);

    // The authority reduction must fail CLOSED: the session keeps the revision it had
    // already applied rather than dropping to the one that failed to render. Retention
    // is by omission from the jsonb_set chain, so only reading `applied` back can catch
    // a regression that starts clearing it.
    const [brief] = await db.sql<Array<{
      applied: unknown; prepared: unknown; status: string; failure: string;
    }>>`
      SELECT control_state->'activation'->'applied' AS applied,
             control_state->'activation'->'prepared' AS prepared,
             control_state #>> '{activation,status}' AS status,
             control_state #>> '{activation,failure}' AS failure
        FROM harness_shared.session_briefs
       WHERE owner_id = ${owner}`;
    expect(brief).toEqual({ applied: previous, prepared: null, status: 'failed', failure: 'render failed' });

    const events = await db.sql<Array<{ phase: string; failure: string; specification_revision: string }>>`
      SELECT phase, failure, specification_revision
        FROM harness_shared.session_identity_activation_events
       WHERE owner_id = ${owner}`;
    expect(events).toEqual([{ phase: 'failed', failure: 'render failed', specification_revision: SPEC_B }]);
  });
});
