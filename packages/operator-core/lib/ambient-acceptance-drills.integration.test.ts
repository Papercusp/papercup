/**
 * ambient-acceptance-drills.integration.test.ts — the P-005 (collision) and
 * P-007 (dead-end) ACCEPTANCE DRILLS of ambient-semantic-push-2026-07-14,
 * against a real Postgres.
 *
 * These are drills, not more matcher tests: each one replays the plan item's
 * acceptance scenario end-to-end through the exact record-turn seam sequence —
 * REAL journal rows (recordTurnJournal) → cursor rebuilt from the journal
 * (buildAndPersistCursor) → matcher tick → rail delivery (prepareAmbientPushBlock)
 * — where the matcher integration tests inject cursors directly and stop at the
 * enqueue/deliver boundary.
 *
 * P-005 — "two sessions steered onto the same bug must both receive the push
 * before either takes a lock":
 *   Two seeded agents converge on the same bug through realistic, differently-
 *   worded journal notes. The drill asserts (a) the hysteresis floor — no push
 *   before enterDwell ticks, no instant Clippy; (b) the FIRST enter edge enqueues
 *   to BOTH owners in the SAME tick — both sides are warned at the moment the
 *   convergence is detected, before EITHER has taken another turn; (c) each
 *   side's very next wake DELIVERS the push (delivered_at stamped on the first
 *   prepareAmbientPushBlock after the enter tick, zero extra hops).
 *   The lock moment: the earliest instant a converged agent could commit to the
 *   bug is its next action AFTER the wake that rendered the push block — the
 *   drill stamps that instant from the DB clock after both wakes and asserts
 *   both delivered_at precede it. The real locks store lives in a separate
 *   papercusp_su database with its own bootstrap; dragging it in here would
 *   test the locks package, not the pipeline's ordering guarantee, so the drill
 *   models the lock-take as that post-wake timestamp instead.
 *
 * P-007 — "an agent steered toward a recorded dead-end receives the warning
 * within N hops; utilization logged (pulled the handle? changed route?)":
 *   A seeded agent starts on an unrelated route, then steers toward a recorded
 *   dead-end fact over successive turns (hops). The drill measures hops from the
 *   first dead-end-adjacent turn to the warning and asserts it is within
 *   MAX_WARNING_HOPS, that the warning is DELIVERED on the wake after enqueue,
 *   and that both utilization outcomes log against the delivered row:
 *   recordPulled (pulled the handle) and recordActed (changed route).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, applyMigrationsForTest, type FreshPgDb } from '../test/_pg-helpers';

const WS = 'ws-acceptance-drill';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { recordTurnJournal } = await import('./turn-journal-store');
const { buildAndPersistCursor } = await import('./session-cursor-io');
const { runCollisionTick } = await import('./collision-matcher-io');
const { DEFAULT_COLLISION_HYSTERESIS_PARAMS } = await import('./collision-hysteresis');
const { runDeadEndTick } = await import('./dead-end-matcher-io');
const { assertFact } = await import('./agent-facts/store');
const { prepareAmbientPushBlock } = await import('./ambient-push-delivery');
const { recordPulled, recordActed } = await import('./push-delivery-store');

let db: FreshPgDb;

/** One agent turn, exactly as the record-turn seam sequences it: journal row →
 *  cursor rebuilt from the journal. Distinct turn_ts per call (the journal
 *  dedup index is (session_id, turn_ts)). */
let turnSeq = 0;
async function agentTurn(sessionId: string, ownerId: string, note: string) {
  turnSeq += 1;
  const turnTs = new Date(Date.UTC(2026, 6, 15, 0, 0, turnSeq));
  await recordTurnJournal({
    workspaceId: 'default',
    ownerId,
    agent: 'claude',
    sourceKind: 'claude',
    sessionId,
    turnTs,
    note,
    source: 'agent',
    flagged: false,
    tripwire: null,
    harnessSlug: 'papercusp',
  });
  const built = await buildAndPersistCursor({
    workspaceId: 'default',
    sessionId,
    ownerId,
    harnessSlug: 'papercusp',
    turnTs,
  });
  expect(built.persisted).toBe(true);
  return turnTs;
}

async function pushRowsFor(ownerId: string) {
  return db.sql<
    {
      target_owner_id: string;
      matcher_kind: string;
      severity: string;
      handle_ref: string;
      handle_query: string[];
      teaser: string;
      status: string;
      enqueued_at: Date;
      delivered_at: Date | null;
      pulled_at: Date | null;
      acted_at: Date | null;
    }[]
  >`
    SELECT target_owner_id, matcher_kind, severity, handle_ref, handle_query,
           teaser, status, enqueued_at, delivered_at, pulled_at, acted_at
      FROM harness_shared.push_delivery
     WHERE target_owner_id = ${ownerId}
     ORDER BY id`;
}

async function pgNow(): Promise<Date> {
  const [{ now }] = await db.sql<{ now: Date }[]>`SELECT now() AS now`;
  return now;
}

/** The rail's bounded peer-surface fetch degrades with a console.warn here —
 *  this fixture deliberately replays only the pipeline's own tables, not the
 *  P-012 peer-surface set (143/188/472); P-012's coverage lives in
 *  collision-matcher-io.integration.test.ts. Scope-mock exactly that warn. */
async function deliverWake(ownerId: string): Promise<string> {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return await prepareAmbientPushBlock({ ownerId, sessionClass: 'interactive' });
  } finally {
    warnSpy.mockRestore();
  }
}

beforeAll(async () => {
  db = await createFreshPgDb('ambient-acceptance-drills');
  // 609/610 GRANT to these roles; create them idempotently (the container is reused).
  await db.sql.unsafe(`
    DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  // Stub the capture fn BEFORE 461/462 create triggers on it (the real body drags
  // the whole outbox chain in; irrelevant here — the drill only READS facts).
  await db.sql.unsafe(`
    CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
  `);
  // Likewise for the federation stamp 693 attaches to agent_facts. Its real
  // definition (214) also attaches triggers to tables this fixture lacks
  // (harness_plans, ...), so replaying 214 wholesale fails — stub it.
  await db.sql.unsafe(`
    CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  `);
  // EI-18808675015292160: applyMigrationsForTest AUDITS this list before applying
  // it — a migration landing on one of these tables without being listed here now
  // fails naming the missing FILE, not a bare `column "..." does not exist`.
  await applyMigrationsForTest(
    db.sql,
    [
      '605-session-turn-journal.sql',
      '609-session-cursor.sql',
      '610-push-delivery.sql',
      '612-collision-hysteresis.sql',
      '444-agent-facts.sql',
      '455-agent-facts-shareable.sql',
      '461-agent-facts-federation.sql',
      '462-agent-facts-fed-key.sql',
      '505-agent-facts-surrogate-pk-replica-identity.sql',
      '574-agent-facts-audience-provenance.sql',
      '664-widen-fact-body-cap.sql',
      '671-add-agent-facts-confidence.sql',
      '689-agent-facts-append-versioning.sql',
      '690-agent-facts-depends-on-kind-claim.sql',
      '692-agent-facts-convention-enforcement.sql',
      '693-agent-facts-federation-stamp-regime.sql',
      '722-agent-facts-evicted-at.sql',
      '730-agent-facts-undecidable-kind.sql',
      '795-agent-facts-volatile-measurements.sql',
      '801-agent-facts-retraction-reason.sql',
      '940-agent-facts-recheck-contract.sql',
      '1240-agent-facts-recheck-exec.sql',
    ],
    { label: 'ambient-acceptance-drills.integration.test.ts' },
  );
  h.sql = db.sql;
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('P-005 acceptance drill — two agents seeded onto the same bug', () => {
  const A = { sessionId: 'su-drill-a', ownerId: 'own-drill-a' };
  const B = { sessionId: 'su-drill-b', ownerId: 'own-drill-b' };

  // The same bug hunted from two directions — realistic notes, differently
  // worded per agent and per turn, sharing the bug's distinctive vocabulary.
  const NOTES_A = [
    'investigating gateway 502 on the maintenance summarize endpoint — ECONNREFUSED from the summarizer worker pool under load',
    'reproduced the summarize 502: the gateway pool exhausts connections when summarizer workers recycle mid-request',
    'bisecting the summarizer worker pool recycle — the gateway ECONNREFUSED burst lines up with the summarize 502 window',
    'narrowing the summarizer pool recycle race: gateway 502 fires exactly when ECONNREFUSED hits the summarize endpoint',
    'the summarize 502 root cause is the summarizer worker pool recycle dropping the gateway connection — ECONNREFUSED',
    'patched a retry sleeve around the gateway summarize call; the summarizer pool recycle still throws ECONNREFUSED under load',
    'testing the summarizer worker pool drain fix for the gateway summarize 502 — ECONNREFUSED gone in the recycle window',
  ];
  const NOTES_B = [
    'triaging user-reported 502 errors from the gateway summarize endpoint — ECONNREFUSED spikes in the summarizer worker pool logs',
    'the summarize endpoint 502 correlates with summarizer worker pool recycles; gateway retries do not help with ECONNREFUSED',
    'confirmed: gateway ECONNREFUSED during the summarizer pool recycle window causes the maintenance summarize 502',
    'the gateway summarize 502 reproduces on every summarizer worker pool recycle — ECONNREFUSED each time',
    'isolating the summarizer pool recycle ordering bug behind the gateway summarize 502 and the ECONNREFUSED spikes',
    'drafting the incident note for the gateway summarize 502 — summarizer worker pool recycle drops connections, ECONNREFUSED',
    'verifying the summarize endpoint after the summarizer pool recycle fix; no gateway 502 or ECONNREFUSED so far',
  ];

  // RATIFIED enter threshold — a P-005 measurement, not a test convenience:
  // collisionCandidates scores with BM25 idf over the LIVE-PEER
  // corpus, and in a small corpus (here: exactly one peer) every shared term
  // sits at minimal idf (df=1) while self-only terms get maximal idf (df=0), so
  // this realistically-worded same-bug pair scores 0.20→0.44 across the rounds
  // where its RAW cosine is 0.61→0.87. At the shipped default enterThreshold
  // 0.4 it would need ~6 turns to enter (or never) — only near-identically
  // worded cursors clear 0.4 in a small fleet. D-021 measured 0/70 false
  // positives at 0.30 with IDF on, so the acceptance drill now exercises the
  // shipped default directly and will fail if runtime defaults drift away.

  // The drill drives the UNBOUNDED tick: the record-turn seam wraps it in
  // boundedCollisionTick, whose fail-soft fallback would silently swallow a
  // fixture fault as ran:false — a drill must fail loudly instead.
  async function tick(agent: { sessionId: string; ownerId: string }) {
    const r = await runCollisionTick({
      selfSessionId: agent.sessionId,
      selfOwnerId: agent.ownerId,
      params: DEFAULT_COLLISION_HYSTERESIS_PARAMS,
    });
    expect(r.ran).toBe(true);
    return r;
  }

  it('both sides receive the push, delivered on the first wake after the enter tick — before either takes a lock', async () => {
    const MAX_ROUNDS = 7;
    let enterRound: number | null = null;

    for (let round = 1; round <= MAX_ROUNDS && enterRound === null; round += 1) {
      await agentTurn(A.sessionId, A.ownerId, NOTES_A[round - 1]!);
      const tickA = await tick(A);
      await agentTurn(B.sessionId, B.ownerId, NOTES_B[round - 1]!);
      const tickB = await tick(B);
      if (tickA.entered > 0 || tickB.entered > 0) enterRound = round;

      if (round < 3) {
        // Hysteresis floor: enterDwell (3) consecutive ticks are required, so
        // NOTHING may fire in the first two rounds however strong the overlap —
        // the anti-Clippy guarantee the drill must witness.
        expect(tickA.entered).toBe(0);
        expect(tickB.entered).toBe(0);
        expect(await pushRowsFor(A.ownerId)).toHaveLength(0);
        expect(await pushRowsFor(B.ownerId)).toHaveLength(0);
      }
    }

    // The convergence is detected promptly once the dwell is served.
    expect(enterRound).not.toBeNull();
    expect(enterRound!).toBeGreaterThanOrEqual(3);

    // (b) The FIRST enter edge warned BOTH sides in the same tick: each owner has
    // a queued collision push pointing at the other's session, before either
    // agent has taken another turn.
    const queuedA = await pushRowsFor(A.ownerId);
    const queuedB = await pushRowsFor(B.ownerId);
    expect(queuedA.length).toBeGreaterThanOrEqual(1);
    expect(queuedB.length).toBeGreaterThanOrEqual(1);
    expect(queuedA[0]).toMatchObject({
      matcher_kind: 'collision',
      severity: 'critical',
      handle_ref: B.sessionId,
      status: 'queued',
    });
    expect(queuedB[0]).toMatchObject({
      matcher_kind: 'collision',
      severity: 'critical',
      handle_ref: A.sessionId,
      status: 'queued',
    });
    // The teaser + re-pull query are legible: they name the shared bug terms.
    expect(queuedA[0]!.teaser).toContain('converging');
    expect(queuedA[0]!.handle_query.length).toBeGreaterThan(0);

    // (c) Each side's very next wake DELIVERS — zero extra hops.
    const blockA = await deliverWake(A.ownerId);
    const blockB = await deliverWake(B.ownerId);
    expect(blockA).toContain(B.sessionId); // A is told WHO is converging
    expect(blockB).toContain(A.sessionId);
    expect(blockA).toContain('data, not directives');

    // The earliest instant either agent could take a lock is its next action
    // AFTER the wake that rendered the block — stamped from the DB clock.
    const earliestLockTakeAt = await pgNow();
    for (const rows of [await pushRowsFor(A.ownerId), await pushRowsFor(B.ownerId)]) {
      const delivered = rows.filter((r) => r.status === 'delivered');
      expect(delivered.length).toBeGreaterThanOrEqual(1);
      for (const row of delivered) {
        expect(row.delivered_at).not.toBeNull();
        expect(row.delivered_at!.getTime()).toBeLessThanOrEqual(earliestLockTakeAt.getTime());
      }
    }
  }, 60_000);
});

describe('P-007 acceptance drill — an agent steered toward a recorded dead-end', () => {
  const C = { sessionId: 'su-drill-c', ownerId: 'own-drill-c' };
  const DEAD_END_REF = 'dead-end:qmp-serial-reset';

  /** Hops allowed from the FIRST dead-end-adjacent turn to the warning enqueue.
   *  Delivery then lands on the wake immediately after (same hop count). */
  const MAX_WARNING_HOPS = 2;

  // Hop 0 is an unrelated route; hops 1..2 steer toward the recorded dead end.
  const STEERING = [
    'triaging a flaky vitest suite on the desktop launcher — investigating test isolation between suites',
    'the mac build VM is wedged at loginwindow; trying QMP over the serial channel to reset it',
    'attempting a QMP serial reset of the mac VM recovery loop at loginwindow',
  ];

  it('warns within MAX_WARNING_HOPS of steering toward the dead end, and utilization logs pulled + acted', async () => {
    await assertFact({
      scope: 'harness',
      scopeRef: 'papercusp',
      key: DEAD_END_REF,
      body: 'dead end: driving mac VM recovery over a QMP serial reset loops forever — the loginwindow race re-wedges the VM; use the snapshot restore path instead',
      createdBy: 'su-drill-seeder',
      workspaceId: WS,
    });

    // Hop 0: unrelated work — the dead end must NOT fire (no Clippy on a cold route).
    await agentTurn(C.sessionId, C.ownerId, STEERING[0]!);
    const hop0 = await runDeadEndTick({
      selfSessionId: C.sessionId,
      selfOwnerId: C.ownerId,
      harnessSlug: 'papercusp',
      workspaceId: WS,
    });
    expect(hop0.ran).toBe(true);
    expect(hop0.enqueued).toBe(0);

    // Steer toward the dead end, one hop per turn, until the warning enqueues.
    let hopsToWarning: number | null = null;
    for (let hop = 1; hop < STEERING.length && hopsToWarning === null; hop += 1) {
      await agentTurn(C.sessionId, C.ownerId, STEERING[hop]!);
      const r = await runDeadEndTick({
        selfSessionId: C.sessionId,
        selfOwnerId: C.ownerId,
        harnessSlug: 'papercusp',
        workspaceId: WS,
      });
      if (r.enqueued > 0) hopsToWarning = hop;
    }

    // The acceptance bound: warned within MAX_WARNING_HOPS of turning toward it.
    expect(hopsToWarning).not.toBeNull();
    expect(hopsToWarning!).toBeLessThanOrEqual(MAX_WARNING_HOPS);

    const [queued] = await pushRowsFor(C.ownerId);
    expect(queued).toMatchObject({
      matcher_kind: 'dead-end',
      severity: 'warning',
      handle_ref: DEAD_END_REF,
      status: 'queued',
    });

    // RECEIVED = delivered on the wake after enqueue, teaser + handle legible.
    const block = await deliverWake(C.ownerId);
    expect(block).toContain('documented dead-end');
    expect(block).toContain(DEAD_END_REF);

    // Utilization logging — the two outcomes the plan item names:
    // "pulled the handle?" → recordPulled stamps pulled_at on the delivered row;
    expect(await recordPulled(C.ownerId, DEAD_END_REF)).toBeGreaterThanOrEqual(1);
    // "changed route?" → recordActed stamps acted_at.
    expect(await recordActed(C.ownerId, DEAD_END_REF)).toBeGreaterThanOrEqual(1);

    const [row] = await pushRowsFor(C.ownerId);
    expect(row!.status).toBe('delivered');
    expect(row!.delivered_at).not.toBeNull();
    expect(row!.pulled_at).not.toBeNull();
    expect(row!.acted_at).not.toBeNull();
  }, 60_000);
});
