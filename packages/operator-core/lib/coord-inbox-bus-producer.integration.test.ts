/**
 * coord-inbox-bus-producer.integration.test.ts — the coord_inbox observer
 * (P-002 / tui-workbench D-003b) END-TO-END against REAL Postgres (the shared
 * baseline-schema DB via inject('baselineSchemaDsn')).
 *
 * BRIEF-test-coverage-fu-coordination-federation-area target #1. Today only the
 * pure `isHumanRelevantRow` predicate is tested (coord-inbox-bus.test.ts); the
 * cursor/peek/coalescing machine that actually decides whether a human sees a
 * message — the producer the substrate audit rated the single most important
 * untested seam — was unguarded. This covers it two ways:
 *
 *  • REAL NOTIFY rail: a coord_event_log INSERT fires migration-126's
 *    `NOTIFY coord_inbox` trigger → the module's LISTEN connection wakes →
 *    peekHumanRelevant advances the cursor → a human-addressed row (and ONLY a
 *    human-addressed row) fires the handler; pre-seeded rows below the initial
 *    cursor never wake it. (This is the exact path the originally-shipped
 *    `writer_key==='human'` filter broke — woke on zero real messages.)
 *  • DETERMINISTIC state machine via `_coordInboxTestSeam` (stubbed peek, no
 *    NOTIFY race): the draining/dirty re-entrancy coalescing + the
 *    `handlers.size===0` skip.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { onCoordInbox, _stopForTests, _coordInboxTestSeam } from './coord-inbox-bus';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

const MARKER = 'test-cib-';
let seq = 0;

function makeDeferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await delay(15);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
  ]);
}

/** INSERT one coord_event_log row (admin/bypass) → fires NOTIFY coord_inbox.
 *  Returns the new row id. `to` is the recipient list the producer keys off. */
async function insertEvent(opts: {
  surface: string;
  to?: string[];
  writerKey?: string;
}): Promise<number> {
  const msgId = `${MARKER}${++seq}`;
  const body = { to: opts.to ?? [], msg_id: msgId };
  const rows = await admin<{ id: string }[]>`
    INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body)
    VALUES ('default', ${opts.surface}, ${opts.writerKey ?? 'su-sender'}, ${msgId}, ${admin.json(body)})
    RETURNING id::text AS id`;
  return Number(rows[0].id);
}

async function deleteTestRows(): Promise<void> {
  await admin`DELETE FROM harness_shared.coord_event_log WHERE msg_id LIKE ${MARKER + '%'}`.catch(() => {});
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
  await deleteTestRows();
});
afterAll(async () => {
  await _stopForTests();
  await deleteTestRows();
  await fx.dispose();
});
beforeEach(async () => {
  await _stopForTests(); // clean module state (closes any LISTEN, resets cursor/handlers/peek)
});
afterEach(async () => {
  await _stopForTests();
  await deleteTestRows();
});

describe('coord-inbox producer — real NOTIFY → peek → wake', () => {
  it('wakes the handler EXACTLY ONCE and ONLY on a human-addressed row', async () => {
    let count = 0;
    const woke = makeDeferred();
    const unsub = onCoordInbox(() => {
      count += 1;
      woke.resolve();
    });
    await _coordInboxTestSeam.ready();

    // A non-human row drives a peek (cursor advances) but must NOT wake.
    const n1 = await insertEvent({ surface: 'messages', to: ['su-x', 'su-y'] });
    await waitFor(() => _coordInboxTestSeam.state().cursor >= n1);
    expect(count).toBe(0);

    // A human-addressed row wakes — exactly once.
    await insertEvent({ surface: 'messages', to: ['su-z', 'human'] });
    await withTimeout(woke.promise, 4000, 'wake on human row');
    expect(count).toBe(1);

    // Settle: no spurious second wake.
    await delay(150);
    expect(count).toBe(1);
    unsub();
  });

  it('wakes on an escalation row (any escalation is human-relevant)', async () => {
    const woke = makeDeferred();
    const unsub = onCoordInbox(() => woke.resolve());
    await _coordInboxTestSeam.ready();

    await insertEvent({ surface: 'escalations', to: [], writerKey: undefined });
    await withTimeout(woke.promise, 4000, 'wake on escalation');
    unsub();
  });

  it('does NOT wake on a handoff addressed to a peer (not human)', async () => {
    let count = 0;
    const unsub = onCoordInbox(() => {
      count += 1;
    });
    await _coordInboxTestSeam.ready();

    const id = await insertEvent({ surface: 'handoffs', to: ['su-peer'] });
    await waitFor(() => _coordInboxTestSeam.state().cursor >= id);
    expect(count).toBe(0);
    unsub();
  });

  it('never wakes on rows pre-seeded BELOW the initial cursor', async () => {
    // A human row exists BEFORE any handler — so it is below the seeded cursor.
    await insertEvent({ surface: 'messages', to: ['human'] });

    let count = 0;
    const unsub = onCoordInbox(() => {
      count += 1;
    });
    await _coordInboxTestSeam.ready();
    const seeded = _coordInboxTestSeam.state().cursor; // == MAX(id), at/above the pre-seeded human row

    // A later non-human row drives a peek over (cursor, …] — the pre-seeded human
    // row is below the cursor and is never re-scanned, so no wake.
    const after = await insertEvent({ surface: 'messages', to: ['su-q'] });
    expect(after).toBeGreaterThan(seeded);
    await waitFor(() => _coordInboxTestSeam.state().cursor >= after);
    expect(count).toBe(0);
    unsub();
  });
});

describe('coord-inbox producer — re-entrancy state machine (deterministic seam)', () => {
  it('coalesces overlapping NOTIFYs: a notify during a drain re-runs the peek ONCE more (dirty), one drain', async () => {
    let handlerCalls = 0;
    _coordInboxTestSeam.addHandler(() => {
      handlerCalls += 1;
    });

    // A peek we control: #1 blocks (keeps draining=true), returns human=true;
    // #2 returns human=false. So exactly one handler fire across the coalesced drain.
    const firstPeek = makeDeferred<boolean>();
    let peekCalls = 0;
    _coordInboxTestSeam.setPeek(async () => {
      peekCalls += 1;
      return peekCalls === 1 ? firstPeek.promise : false;
    });

    // Pump #1 enters the drain and is parked inside peek #1.
    const p1 = _coordInboxTestSeam.pump();
    await waitFor(() => _coordInboxTestSeam.state().draining);
    expect(_coordInboxTestSeam.state().draining).toBe(true);

    // Pump #2 arrives mid-drain → coalesced: sets dirty, returns immediately.
    const p2 = _coordInboxTestSeam.pump();
    await p2;
    expect(_coordInboxTestSeam.state().dirty).toBe(true);

    // Release peek #1 (human) → handler fires once; the dirty flag forces peek #2
    // (no human) → loop ends.
    firstPeek.resolve(true);
    await p1;

    expect(peekCalls).toBe(2); // two passes inside ONE drain (coalesced)
    expect(handlerCalls).toBe(1); // only peek #1 reported a human row
    expect(_coordInboxTestSeam.state().draining).toBe(false);
    expect(_coordInboxTestSeam.state().dirty).toBe(false);
  });

  it('skips the peek entirely when no handlers are registered (handlers.size===0)', async () => {
    // No handler added. Force a non-zero cursor so we can prove it does NOT move.
    _coordInboxTestSeam.setCursor(42);
    let peekCalls = 0;
    _coordInboxTestSeam.setPeek(async () => {
      peekCalls += 1;
      return true;
    });

    await _coordInboxTestSeam.pump();

    expect(_coordInboxTestSeam.state().handlerCount).toBe(0);
    expect(peekCalls).toBe(0); // returned before peeking
    expect(_coordInboxTestSeam.state().cursor).toBe(42); // cursor untouched
  });
});
