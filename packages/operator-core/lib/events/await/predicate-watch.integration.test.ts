/**
 * predicate-watch.integration.test.ts — the predicate-watch store + eval + GC
 * lifecycle against real Postgres (fleet-deltas-leader-primitives-2026-07-10
 * P-008, migration 541 + the paired event_awaits rows from migration 163).
 *
 * Dispatch is faked via the configurePredicateDispatch seam (the projected-tool
 * dispatch itself is dispatch-projected's tested territory); emitAwaitedEvent is
 * faked to RECORD the emit and still drive the REAL store.fireAwaitsForKey, so
 * once-await consumption and the GC coupling stay honest. Follows the
 * org-fixture mock pattern (test/_org-test-db.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: null as any,
  emits: [] as Array<{ key: string; payload: any; summary?: string }>,
}));

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async (_ws: string, fn: (tx: unknown) => Promise<unknown>) => fn(h.sql),
}));
// The real dispatch path is exercised in prod via dispatch-projected (tested
// there); tests drive the configurePredicateDispatch seam instead.
vi.mock('@papercusp/agent-mcp', () => ({
  lookupByMcpName: () => undefined,
  dispatchProjectedTool: async () => ({ ok: false, error: { code: 'test', message: 'not wired in tests' } }),
}));
vi.mock('../../projected-tool-deps', () => ({ PROJECTED_DEPS: {} }));
vi.mock('@papercusp/scheduled-registry', () => ({ managedSetInterval: () => ({ unref: () => {} }) }));
vi.mock('./engine', () => ({
  emitAwaitedEvent: async (opts: { key: string; payload?: unknown; summary?: string }) => {
    h.emits.push({ key: opts.key, payload: opts.payload, summary: opts.summary });
    const store = await import('./store');
    const fired = await store.fireAwaitsForKey({ eventKey: opts.key, payload: opts.payload });
    return { ok: true, key: opts.key, woken: fired.length, notified: [], msgId: null, waiters: fired.length };
  },
}));

const pw = await import('./predicate-watch');
const store = await import('./store');
const { createOrgTestDb } = await import('../../../test/_org-test-db');

let seq = 0;
/** Register the paired await FIRST (the GC invariant), then the watch row. */
async function seedWatch(opts: {
  once?: boolean;
  awaitOnce?: boolean;
  intervalSec?: number;
  op?: pw.PredicateOp;
  value?: unknown;
  path?: string;
}) {
  const id = globalThis.crypto.randomUUID();
  const eventKey = `predicate:${id}`;
  const subscriber = `su-pw-${++seq}`;
  const awaitRow = await store.registerAwait({
    subscriberId: subscriber,
    eventKey,
    once: opts.awaitOnce ?? opts.once ?? true,
  });
  const row = await pw.registerPredicateWatch({
    id,
    workspaceId: 'ws-pw-test',
    ownerId: subscriber,
    role: 'su',
    harnessSlug: null,
    eventKey,
    tool: 'fake:read',
    args: {},
    path: opts.path ?? 'wm',
    op: opts.op ?? 'gt',
    value: opts.value ?? 127,
    intervalSec: opts.intervalSec ?? 60,
    once: opts.once ?? true,
  });
  return { row, awaitRow, eventKey, subscriber };
}

async function backdate(id: string, seconds = 3600) {
  await h.sql`
    UPDATE harness_shared.predicate_watches
       SET last_polled_at = now() - make_interval(secs => ${seconds})
     WHERE id = ${id}
  `;
}

describe('predicate watches (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  afterEach(() => {
    pw.configurePredicateDispatch(null);
    h.emits = [];
  });

  it('registration stamps last_polled_at, so a fresh row is not due until its interval', async () => {
    const { row } = await seedWatch({ intervalSec: 60 });
    expect(row.active).toBe(true);
    expect(row.lastPolledAt).not.toBeNull();
    const due = await pw.claimDuePredicateWatches();
    expect(due.map((d) => d.id)).not.toContain(row.id);
  });

  it('claim-by-stamp: a backdated row is claimed exactly once per window', async () => {
    const { row } = await seedWatch({ intervalSec: 5 });
    await backdate(row.id);
    const first = await pw.claimDuePredicateWatches();
    expect(first.map((d) => d.id)).toContain(row.id);
    const second = await pw.claimDuePredicateWatches();
    expect(second.map((d) => d.id)).not.toContain(row.id);
  });

  it('once:true lifecycle — below threshold: no fire; cross: EDGE-fires, consumes the await, deactivates', async () => {
    const { row, eventKey } = await seedWatch({ once: true, op: 'gt', value: 127 });

    pw.configurePredicateDispatch(async () => ({ wm: 127 }));
    const below = await pw.evalPredicateWatch(row);
    expect(below).toMatchObject({ matched: false, fired: false, deactivated: false });
    expect(h.emits).toHaveLength(0);

    pw.configurePredicateDispatch(async () => ({ wm: 128 }));
    const crossed = await pw.evalPredicateWatch((await pw.getPredicateWatch(row.id))!);
    expect(crossed).toMatchObject({ matched: true, fired: true, deactivated: true });
    expect(h.emits).toHaveLength(1);
    expect(h.emits[0].key).toBe(eventKey);
    expect(h.emits[0].payload).toMatchObject({ observed: 128, predicate: { tool: 'fake:read', op: 'gt', value: 127 } });

    // The once-await was consumed by the fire; the row is inactive and never claimed again.
    expect(await store.listActiveAwaitsForKey(eventKey)).toHaveLength(0);
    const after = (await pw.getPredicateWatch(row.id))!;
    expect(after.active).toBe(false);
    expect(after.lastEval).toBe(true);
    await backdate(row.id);
    expect((await pw.claimDuePredicateWatches()).map((d) => d.id)).not.toContain(row.id);
  });

  it('once:false is edge-triggered — no re-fire while true; re-fires only on the next false→true cross', async () => {
    const { row } = await seedWatch({ once: false, awaitOnce: false, op: 'gte', value: 10 });

    pw.configurePredicateDispatch(async () => ({ wm: 12 }));
    const first = await pw.evalPredicateWatch(row);
    expect(first).toMatchObject({ matched: true, fired: true, deactivated: false });

    // Still true → NO second fire (lastEval already true).
    const still = await pw.evalPredicateWatch((await pw.getPredicateWatch(row.id))!);
    expect(still).toMatchObject({ matched: true, fired: false });
    expect(h.emits).toHaveLength(1);

    // Drop below, then re-cross → second fire; row stays active throughout.
    pw.configurePredicateDispatch(async () => ({ wm: 3 }));
    await pw.evalPredicateWatch((await pw.getPredicateWatch(row.id))!);
    pw.configurePredicateDispatch(async () => ({ wm: 11 }));
    const recross = await pw.evalPredicateWatch((await pw.getPredicateWatch(row.id))!);
    expect(recross).toMatchObject({ matched: true, fired: true });
    expect(h.emits).toHaveLength(2);
    expect((await pw.getPredicateWatch(row.id))!.active).toBe(true);
  });

  it('error ladder — errors accumulate; the 5th consecutive one deactivates AND emits predicateError', async () => {
    const { row, eventKey } = await seedWatch({ once: true });
    pw.configurePredicateDispatch(async () => {
      throw new Error('role gate: denied');
    });
    for (let i = 1; i <= pw.PREDICATE_MAX_CONSECUTIVE_ERRORS; i++) {
      const r = await pw.evalPredicateWatch((await pw.getPredicateWatch(row.id))!);
      expect(r.error).toMatch(/role gate/);
      const cur = (await pw.getPredicateWatch(row.id))!;
      expect(cur.consecutiveErrors).toBe(i);
      expect(cur.lastError).toMatch(/role gate/);
      expect(cur.active).toBe(i < pw.PREDICATE_MAX_CONSECUTIVE_ERRORS);
    }
    expect(h.emits).toHaveLength(1);
    expect(h.emits[0].key).toBe(eventKey);
    expect(h.emits[0].payload).toMatchObject({ predicateError: expect.stringContaining('role gate') });
  });

  it('a successful eval resets the error ladder', async () => {
    const { row } = await seedWatch({ once: true, op: 'gt', value: 999 });
    pw.configurePredicateDispatch(async () => {
      throw new Error('transient');
    });
    await pw.evalPredicateWatch(row);
    expect((await pw.getPredicateWatch(row.id))!.consecutiveErrors).toBe(1);
    pw.configurePredicateDispatch(async () => ({ wm: 1 }));
    await pw.evalPredicateWatch((await pw.getPredicateWatch(row.id))!);
    const cur = (await pw.getPredicateWatch(row.id))!;
    expect(cur.consecutiveErrors).toBe(0);
    expect(cur.lastError).toBeNull();
  });

  it('GC deactivates a row whose paired await was cancelled; a live standing await protects its row', async () => {
    const dead = await seedWatch({ once: true });
    const alive = await seedWatch({ once: false, awaitOnce: false });
    await store.cancelAwait({ awaitId: dead.awaitRow.id, subscriberId: dead.subscriber });

    const gc = await pw.gcOrphanedPredicateWatches();
    expect(gc).toBeGreaterThanOrEqual(1);
    expect((await pw.getPredicateWatch(dead.row.id))!.active).toBe(false);
    expect((await pw.getPredicateWatch(dead.row.id))!.lastError).toMatch(/gc:/);
    expect((await pw.getPredicateWatch(alive.row.id))!.active).toBe(true);
  });

  it('pollDuePredicateWatches — one tick GCs, claims the due batch, and fires crossed rows', async () => {
    const { row, eventKey } = await seedWatch({ once: true, op: 'gte', value: 128, intervalSec: 5 });
    await backdate(row.id);
    pw.configurePredicateDispatch(async () => ({ wm: 128 }));
    const tick = await pw.pollDuePredicateWatches();
    expect(tick.polled).toBeGreaterThanOrEqual(1);
    expect(tick.fired).toBeGreaterThanOrEqual(1);
    expect(h.emits.some((e) => e.key === eventKey)).toBe(true);
    expect((await pw.getPredicateWatch(row.id))!.active).toBe(false);
  });
});
