/**
 * park.integration.test.ts — consult-backed parking end to end against a real,
 * fully migrated Postgres (consult-backed-parking-2026-10-12 P-009, bar R-9).
 *
 * The pure resolver (park-resolver.test.ts) and the row mapping
 * (park-adapters.test.ts) are unit-tested. What only a real database can prove:
 *  - the park identity stored on consult_state.routing.cascade (D-013), the
 *    reviewer stance on consult_post_meta.stance (migration 1482) and the park
 *    progress on consult_state.park_state (migration 1483) round-trip through
 *    loadParkState → runParkTriggers → appendParkOutcome;
 *  - the PRODUCTION effect seams (makeProdParkSeams) clear the work item's real
 *    product-decision blocker (the exact record set_blocker writes) and fire the
 *    real awaited-event engine, so the parked agent's verdict await is consumed
 *    (the agent is woken) with the verdict payload;
 *  - the deadline sweep (sweepDueParks) selects due parks by the stored deadline,
 *    leaves parks that are not yet due alone, and never re-settles a settled park.
 *
 * Only the wake TRANSPORT is stubbed (sendMessage / admitSpawn): the await row,
 * its fire and its payload are real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: null as unknown,
  ws: 'ws-park-it',
  sendMessage: vi.fn(async () => ({ msg_id: 'm-park-it' })),
  admitSpawn: vi.fn(async () => ({ admitted: true })),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    setAdminPoolStatementTimeoutProvider: () => {},
  };
});
vi.mock('../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => h.ws,
}));
vi.mock('../agent-tools/coordination/messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-tools/coordination/messages')>()),
  sendMessage: h.sendMessage,
}));
vi.mock('../fleet/governor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fleet/governor')>()),
  admitSpawn: h.admitSpawn,
}));

const { createOrgTestDb } = await import('../../test/_org-test-db');
const awaitStore = await import('../events/await/store');
const { readExternalBlockers, updateExternalBlockerHistory } = await import('../external-blockers');
const { DECISION_REVIEW_CASCADE_FLAVOR } = await import('./decision-review');
const { parkVerdictEventKey } = await import('./park-resolver');
const { appendParkerResponse, parkBlockerRef, runParkTriggersForConsult, sweepDueParks } = await import('./park-adapters');
const { makeProdParkSeams } = await import('./park-prod');

const WS = h.ws;
const QUESTION = 'Rename the export flag before the cutover?';
const DEFAULT_ACTION = 'Keep the current flag name and ship as-is';
const ALTERNATIVE = 'Rename the flag now and alias the old name for one release';

let db: OrgTestDb;
let sql: Sql;
let seq = 0;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql as unknown as Sql;
  h.sql = sql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

interface SeededPark {
  consultId: string;
  workItemId: string;
  setterId: string;
  blockerRef: string;
  eventKey: string;
  deadlineAt: string;
}

/** A park exactly as set_blocker's park door leaves it: consult + blocker + verdict await. */
async function seedPark(deadlineAt: string): Promise<SeededPark> {
  seq += 1;
  const consultId = `conv-park-it-${seq}-${Date.now()}`;
  const workItemId = `WI-PARK-IT-${seq}-${Date.now()}`;
  const setterId = `su-parker-${seq}`;
  const blockerRef = parkBlockerRef(consultId);
  const routing = {
    selection: {
      // Two reviewers: after the first objects, the cascade is NOT exhausted, so the
      // parker gets to adopt/rebut (R-16) instead of an owner question (R-17).
      selected: [
        { ownerId: `su-reviewer-${seq}`, via: 'floor', score: 0.9, similarity: 0.8, liveness: 'live' },
        { ownerId: `su-reviewer2-${seq}`, via: 'floor', score: 0.8, similarity: 0.7, liveness: 'live' },
      ],
    },
    cascade: {
      flavor: DECISION_REVIEW_CASCADE_FLAVOR,
      workItemId,
      setterId,
      defaultAction: DEFAULT_ACTION,
      deadlineAt,
      ownerAuthorityTopic: null,
    },
  };
  await sql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, question,
       latency_contract, expires_at, routing, cascade_cursor)
    VALUES (${WS}, ${consultId}, ${setterId}, ${`su-reviewer-${seq}`}, 'awaiting_responder', ${QUESTION},
            'proceed', NULL, ${sql.json(routing as never)}, 0)`;
  const { blockers } = updateExternalBlockerHistory(
    {},
    {
      kind: 'human',
      capability: 'product-decision',
      ref: blockerRef,
      summary: QUESTION,
      defaultIfUnanswered: DEFAULT_ACTION,
      decideBy: deadlineAt,
    },
    setterId,
  );
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, payload, nature)
    VALUES (${WS}, 'papercusp', ${workItemId}, 'feature', ${QUESTION}, 'open', ${Date.now()},
            ${sql.json({ externalBlockers: blockers } as never)}, 'work')`;
  const eventKey = parkVerdictEventKey(consultId);
  await registerVerdictAwait(setterId, eventKey);
  return { consultId, workItemId, setterId, blockerRef, eventKey, deadlineAt };
}

function registerVerdictAwait(subscriberId: string, eventKey: string) {
  return awaitStore.registerAwait({ subscriberId, eventKey, note: 'park verdict', timeoutSec: 7200 });
}

async function postStance(park: SeededPark, author: string, stance: Record<string, unknown>): Promise<string> {
  const postId = 900_000 + seq * 10 + Math.floor(Math.random() * 9);
  await sql`
    INSERT INTO harness_shared.consult_post_meta (workspace_id, post_id, conversation_id, author_id, kind, stance)
    VALUES (${WS}, ${postId}, ${park.consultId}, ${author}, 'answer', ${sql.json(stance as never)})`;
  return String(postId);
}

async function blockerStatus(park: SeededPark): Promise<{ status: string; record: unknown } | null> {
  const rows = await sql<Array<{ payload: unknown }>>`
    SELECT payload FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${park.workItemId}`;
  const b = readExternalBlockers(rows[0]?.payload).find((x) => x.ref === park.blockerRef);
  return b ? { status: b.status, record: b } : null;
}

/** The parked agent's verdict awaits, newest first: fired (= woken) or still pending. */
async function verdictAwaits(park: SeededPark) {
  return sql<Array<{ fired_at: Date | null; fired_payload: Record<string, unknown> | null }>>`
    SELECT fired_at, fired_payload FROM harness_shared.event_awaits
     WHERE subscriber_id = ${park.setterId} AND event_key = ${park.eventKey}
     ORDER BY created_at DESC, id DESC`;
}

const seams = (ws: string) => makeProdParkSeams(sql, ws);

describe('consult-backed parking against real Postgres (R-9)', () => {
  it('adopt-alternative: an objection with an alternative wakes the parker, adopting it settles the park as peer review', async () => {
    const park = await seedPark(new Date(Date.now() + 3_600_000).toISOString());
    const objectionId = await postStance(park, `su-reviewer-${seq}`, {
      position: 'object',
      basis: 'alternative',
      reason: 'Old name collides with the analytics export',
      alternative: ALTERNATIVE,
    });

    // 1. The objection wakes the parked agent to adopt or rebut; the park stays blocked.
    const first = await runParkTriggersForConsult(sql, WS, park.consultId, seams(WS));
    expect(first?.verdict).toBe('consider-alternative');
    expect(first?.applied).not.toContain('clear-blocker');
    const [woken] = await verdictAwaits(park);
    expect(woken?.fired_at).not.toBeNull();
    expect(woken?.fired_payload).toMatchObject({
      verdict: 'consider-alternative',
      alternative: ALTERNATIVE,
      workItemId: park.workItemId,
      recordedAs: 'peer-review',
    });
    expect((await blockerStatus(park))?.status).toBe('active');

    // 2. The parker re-awaits and adopts the alternative.
    await registerVerdictAwait(park.setterId, park.eventKey);
    await appendParkerResponse(sql, WS, park.consultId, {
      kind: 'adopt',
      at: new Date().toISOString(),
      text: 'Adopting the rename with an alias',
      objectionId,
    });
    const second = await runParkTriggersForConsult(sql, WS, park.consultId, seams(WS));
    expect(second?.verdict).toBe('adopted');
    expect(second?.applied).toContain('clear-blocker');

    const blocker = await blockerStatus(park);
    expect(blocker?.status).toBe('cleared');
    expect(JSON.stringify(blocker?.record)).toContain('peer-review');
    const [adoptWake] = await verdictAwaits(park);
    expect(adoptWake?.fired_at).not.toBeNull();
    expect(adoptWake?.fired_payload).toMatchObject({
      verdict: 'adopted',
      alternative: ALTERNATIVE,
      blockerRef: park.blockerRef,
      recordedAs: 'peer-review',
    });

    const [{ park_state }] = await sql<Array<{ park_state: { outcomes: Array<{ verdict: string }> } }>>`
      SELECT park_state FROM harness_shared.consult_state WHERE workspace_id = ${WS} AND conversation_id = ${park.consultId}`;
    expect(park_state.outcomes.map((o) => o.verdict)).toEqual(['consider-alternative', 'adopted']);

    // 3. A settled park is idempotent: a later trigger changes nothing.
    const third = await runParkTriggersForConsult(sql, WS, park.consultId, seams(WS));
    expect(third).toMatchObject({ verdict: null, applied: [] });
  }, 60_000);

  it('silent-proceed: with no objection the deadline sweep proceeds with the default, clears the blocker and wakes the parker', async () => {
    const deadline = Date.now() + 3_600_000;
    const park = await seedPark(new Date(deadline).toISOString());
    const notDue = await seedPark(new Date(deadline + 7_200_000).toISOString());

    // Before the deadline the sweep leaves the silent park alone.
    const early = await sweepDueParks({ sql, seamsFor: seams });
    expect(early.resolved.map((r) => r.consultId)).not.toContain(park.consultId);
    expect((await verdictAwaits(park))[0]?.fired_at).toBeNull();

    // At the deadline it proceeds with the default.
    const atDeadline = new Date(deadline + 1_000).toISOString();
    const swept = await sweepDueParks({ sql, seamsFor: seams, now: atDeadline });
    expect(swept.failures).toEqual([]);
    expect(swept.resolved).toContainEqual(expect.objectContaining({ consultId: park.consultId, verdict: 'proceed' }));
    expect(swept.resolved.map((r) => r.consultId)).not.toContain(notDue.consultId);

    const blocker = await blockerStatus(park);
    expect(blocker?.status).toBe('cleared');
    expect(JSON.stringify(blocker?.record)).toContain('peer-review');
    const [woken] = await verdictAwaits(park);
    expect(woken?.fired_at).not.toBeNull();
    expect(woken?.fired_payload).toMatchObject({
      verdict: 'proceed',
      defaultAction: DEFAULT_ACTION,
      workItemId: park.workItemId,
      recordedAs: 'peer-review',
    });

    // The not-yet-due park is untouched.
    expect((await blockerStatus(notDue))?.status).toBe('active');
    expect((await verdictAwaits(notDue))[0]?.fired_at).toBeNull();

    // A second sweep never re-settles the proceeded park.
    const again = await sweepDueParks({ sql, seamsFor: seams, now: atDeadline });
    expect(again.resolved.map((r) => r.consultId)).not.toContain(park.consultId);
  }, 60_000);
});
