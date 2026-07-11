// @vitest-environment node
/**
 * compose.integration.test.ts — composed threshold-tree event awaits, end-to-end
 * against REAL Postgres (composable-event-awaits-2026-07-11 P-005).
 *
 * The unit half (compose-spec.test.ts) proves the pure grammar; THIS file proves the
 * STORE+ENGINE the design's correctness actually rests on, by driving the real entry
 * points an emitter/sweeper calls — `registerComposedAwait`, `emitAwaitedEvent`,
 * `sweepOnce` — against a migration-572 schema (createOrgTestDb applies every migration,
 * so this also implicitly proves 572 applies cleanly). The behaviours a fake-sql unit
 * test cannot show:
 *
 *  1. concurrent emits racing a tree → EXACTLY ONE root wake (the atomic bumpNode
 *     trip is the whole design's exactly-once keystone), both across two branches and
 *     across N identical emits of one leaf key;
 *  2. `all` (k=n) trips only on the LAST member; a `some{require:2}` on the SECOND;
 *  3. born-satisfied seeding via the EI-9270 announcement latch — a fully-satisfied
 *     root returns `already_satisfied` writing NO rows; a partially-satisfied root
 *     registers with its counter pre-SEEDED so it trips one emit early;
 *  4. void-on-root-fire — once a root trips, zero live (unfired, uncancelled) leaves
 *     OR interior nodes survive for that tree, so no straggler ever wakes again;
 *  5. timeout — a root past its deadline with timeout_behavior='wake' delivers ONE
 *     partial-state wake (payload.fired = what fired, payload.pending = the rest);
 *     an 'expire' root lapses silently (no delivery) but still voids the tree.
 *
 * The wake DELIVERY is asserted on the durable `event_wake_deliveries` row (count +
 * payload) rather than on wake EXECUTION — the executor's liveness ladder has its own
 * matrix; here the claim is "the engine queues the right one wake with the right
 * payload". Those rows are pump-invariant (the pump only settles status, never payload),
 * so the setImmediate pump kick that emit/sweep fire can't perturb the assertions.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-composed-iso' }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => h.ws,
  backgroundWorkspaceIds: () => [h.ws],
}));

const store = await import('./store');
const engine = await import('./engine');
const compose = await import('./compose');
const { createOrgTestDb } = await import('../../../test/_org-test-db');
import type { ComposedSpec } from './compose-spec';

describe('composed threshold-tree awaits — store+engine end-to-end (real PG)', () => {
  let db: OrgTestDb;
  let sql: postgres.Sql;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  // The engine narrates every wake/pump via console.warn (engine.ts `log`) — expected
  // operational noise under the integration config's fail-on-console default.
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // Drain any wake deliveries the emit/sweep kicked (setImmediate) so a straggler pump
  // never fires mid-next-test. Best-effort: a handle-less composed anchor degrades to a
  // no-op inbox/drop, which is fine — assertions already ran on the durable rows above.
  afterEach(async () => {
    await engine.pumpWakeDeliveries(h.ws).catch(() => {});
  });

  const uid = (): string => `su-${Math.random().toString(36).slice(2, 10)}`;
  const emit = (key: string, payload?: unknown): Promise<unknown> =>
    engine.emitAwaitedEvent({ key, payload, workspaceId: h.ws });

  /** The wake deliveries queued against a tree's anchor row (the composed wake surface). */
  async function anchorDeliveries(anchorAwaitId: number): Promise<Array<{ payload: any }>> {
    return sql`
      SELECT payload FROM harness_shared.event_wake_deliveries
       WHERE await_id = ${anchorAwaitId} ORDER BY id
    ` as unknown as Promise<Array<{ payload: any }>>;
  }

  /** Live (unfired, uncancelled) composed LEAF rows still able to fire for a tree. */
  async function liveLeafCount(rootId: number): Promise<number> {
    const r = await sql`
      SELECT count(*)::int AS n FROM harness_shared.event_awaits
       WHERE root_id = ${rootId} AND node_id IS NOT NULL
         AND fired_at IS NULL AND cancelled_at IS NULL
    `;
    return Number(r[0].n);
  }

  /** Live (unfired, uncancelled) INTERIOR nodes still able to trip for a tree. */
  async function liveInteriorNodeCount(rootId: number): Promise<number> {
    const r = await sql`
      SELECT count(*)::int AS n FROM harness_shared.event_await_nodes
       WHERE root_id = ${rootId} AND parent_id IS NOT NULL
         AND fired_at IS NULL AND cancelled_at IS NULL
    `;
    return Number(r[0].n);
  }

  function reg(spec: ComposedSpec, extra: Partial<Parameters<typeof compose.registerComposedAwait>[0]> = {}) {
    return compose.registerComposedAwait({ subscriberId: uid(), spec, ...extra });
  }

  // ── 1. concurrent race → exactly one wake ────────────────────────────────────

  it('two branches raced concurrently trip an `any` root EXACTLY ONCE (one wake, not two)', async () => {
    const r = await reg({ any: [{ event: 'race:a' }, { event: 'race:b' }] });
    if (!r.registered) throw new Error('expected registration');

    // Fire BOTH branches truly concurrently. Both leaves are still live, so both claim
    // and both propagate to the root — but the atomic bumpNode trip (required_count 1)
    // crosses the threshold once; the loser's bump no-ops on the `fired_at IS NULL` guard.
    await Promise.all([emit('race:a'), emit('race:b')]);

    const deliveries = await anchorDeliveries(r.anchorAwaitId);
    expect(deliveries).toHaveLength(1); // ← the keystone: one root trip, one wake
    expect(deliveries[0].payload).toMatchObject({ composed: true, satisfied: true, reason: 'event' });
    // And the whole tree is consumed — no straggler leaf can wake again.
    expect(await liveLeafCount(r.rootId)).toBe(0);
  });

  it('N concurrent emits of ONE leaf key wake once (leaf exactly-once → one root trip)', async () => {
    const r = await reg({ any: [{ event: 'race:solo' }] });
    if (!r.registered) throw new Error('expected registration');

    await Promise.all([emit('race:solo'), emit('race:solo'), emit('race:solo'), emit('race:solo')]);

    const deliveries = await anchorDeliveries(r.anchorAwaitId);
    expect(deliveries).toHaveLength(1); // only one emit claims the one-shot leaf
  });

  // ── 2. thresholds: `all` on the last member, `some` on the k-th ──────────────

  it('`all` (k=n) stays silent until the LAST member, then trips once', async () => {
    const r = await reg({ all: [{ event: 'all:a' }, { event: 'all:b' }, { event: 'all:c' }] });
    if (!r.registered) throw new Error('expected registration');

    await emit('all:a');
    expect(await anchorDeliveries(r.anchorAwaitId)).toHaveLength(0); // 1/3
    await emit('all:b');
    expect(await anchorDeliveries(r.anchorAwaitId)).toHaveLength(0); // 2/3
    await emit('all:c');

    const deliveries = await anchorDeliveries(r.anchorAwaitId); // 3/3 → trip
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].payload.satisfied).toBe(true);
    expect((deliveries[0].payload.fired as Array<{ event: string }>).map((f) => f.event).sort()).toEqual([
      'all:a',
      'all:b',
      'all:c',
    ]);
  });

  it('`some { require: 2 }` trips on the SECOND qualifying member, not the first', async () => {
    const r = await reg({ some: { require: 2, of: [{ event: 'some:a' }, { event: 'some:b' }, { event: 'some:c' }] } });
    if (!r.registered) throw new Error('expected registration');

    await emit('some:a');
    expect(await anchorDeliveries(r.anchorAwaitId)).toHaveLength(0); // 1/2
    await emit('some:b');

    const deliveries = await anchorDeliveries(r.anchorAwaitId); // 2/2 → trip
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].payload.satisfied).toBe(true);
    // The third, still-unfired leaf is voided by the trip — a later `some:c` wakes no one.
    expect(await liveLeafCount(r.rootId)).toBe(0);
    await emit('some:c');
    expect(await anchorDeliveries(r.anchorAwaitId)).toHaveLength(1); // still one, never a second wake
  });

  // ── 3. born-satisfied seeding via the EI-9270 announcement latch ─────────────

  it('a fully born-satisfied root returns already_satisfied and writes NO rows', async () => {
    // Latch an announced gate: register the announcement, then a real emit stamps its
    // fired_at (the EI-9270 latch a late registrant retro-detects).
    await store.registerAnnouncement({ subscriberId: uid(), eventKey: 'born:latched', scopeKind: 'global' });
    await emit('born:latched');

    const subscriberId = uid();
    const res = await compose.registerComposedAwait({ subscriberId, spec: { any: [{ event: 'born:latched' }] } });

    expect(res.registered).toBe(false);
    if (res.registered) throw new Error('unreachable');
    expect(res.alreadySatisfied).toBe(true);
    expect(res.fired.map((f) => f.event)).toEqual(['born:latched']);

    // Nothing persisted: no nodes, no composed leaves, no anchor for this subscriber.
    const nodes = await sql`SELECT count(*)::int AS n FROM harness_shared.event_await_nodes WHERE subscriber_id = ${subscriberId}`;
    const leaves = await sql`SELECT count(*)::int AS n FROM harness_shared.event_awaits WHERE subscriber_id = ${subscriberId} AND root_id IS NOT NULL`;
    expect(Number(nodes[0].n)).toBe(0);
    expect(Number(leaves[0].n)).toBe(0);
  });

  it('a PARTIALLY born-satisfied root registers with its counter pre-seeded, tripping one emit early', async () => {
    await store.registerAnnouncement({ subscriberId: uid(), eventKey: 'seed:latched', scopeKind: 'global' });
    await emit('seed:latched');

    // all-of-2 where ONE leaf is already latched: seed=1, required=2 → NOT born-satisfied,
    // so it registers, but with fired_count pre-seeded to 1 and the satisfied leaf PRUNED
    // (represented only by the seed). A plain all-of-2 needs two emits (see the `all` test);
    // this one trips on its single remaining emit — the proof the seed carried.
    const r = await reg({ all: [{ event: 'seed:latched' }, { event: 'seed:plain' }] });
    if (!r.registered) throw new Error('expected registration');
    expect(await liveLeafCount(r.rootId)).toBe(1); // only the un-latched leaf is a live row

    await emit('seed:plain'); // fired_count 1(seed) → 2 == required → trip
    expect(await anchorDeliveries(r.anchorAwaitId)).toHaveLength(1);
  });

  // ── 4. void-on-root-fire (incl. interior nodes of a nested tree) ─────────────

  it('a root trip voids EVERY unfired descendant — leaves and interior nodes alike', async () => {
    // any[ leaf, all[leaf, leaf] ]: firing the top-level leaf trips the root (require 1)
    // while the nested `all` node and its two leaves are all still unfired.
    const r = await reg({ any: [{ event: 'void:x' }, { all: [{ event: 'void:y' }, { event: 'void:z' }] }] });
    if (!r.registered) throw new Error('expected registration');
    expect(r.depth).toBe(3);
    expect(await liveInteriorNodeCount(r.rootId)).toBe(1); // the nested `all` node

    await emit('void:x'); // root trips immediately

    expect(await anchorDeliveries(r.anchorAwaitId)).toHaveLength(1);
    // Nothing left alive anywhere in the tree: the pending leaves, the nested node, AND
    // the anchor row are all voided, so no survivor can ever fire again.
    expect(await liveLeafCount(r.rootId)).toBe(0);
    expect(await liveInteriorNodeCount(r.rootId)).toBe(0);
    const root = await sql`SELECT fired_at FROM harness_shared.event_await_nodes WHERE id = ${r.rootId}`;
    expect(root[0].fired_at).not.toBeNull();
    // The formerly-pending leaves are inert: emitting them now wakes no one.
    await emit('void:y');
    await emit('void:z');
    expect(await anchorDeliveries(r.anchorAwaitId)).toHaveLength(1);
  });

  // ── 5. timeout: partial-state wake vs. silent expire ─────────────────────────

  it('a `wake` root past its deadline delivers ONE partial-state timeout wake', async () => {
    const r = await reg({ all: [{ event: 'to:a' }, { event: 'to:b' }] }, { timeoutSec: 300, timeoutBehavior: 'wake' });
    if (!r.registered) throw new Error('expected registration');

    await emit('to:a', { note: 'first-in' }); // partial: a fired, b pending, root still live
    expect(await anchorDeliveries(r.anchorAwaitId)).toHaveLength(0);

    // Force the deadline into the past, then run the sweeper (its claimDueComposedRoots
    // atomically stamps fired_at, then fires the partial-state timeout wake + voids the tree).
    await sql`UPDATE harness_shared.event_await_nodes SET expires_ts = now() - interval '1 minute' WHERE id = ${r.rootId}`;
    await engine.sweepOnce(h.ws);

    const deliveries = await anchorDeliveries(r.anchorAwaitId);
    expect(deliveries).toHaveLength(1);
    const p = deliveries[0].payload;
    expect(p).toMatchObject({ composed: true, satisfied: false, reason: 'timeout' });
    expect((p.fired as Array<{ event: string }>).map((f) => f.event)).toEqual(['to:a']); // what fired
    expect(p.pending).toEqual(['to:b']); // what didn't
    expect(await liveLeafCount(r.rootId)).toBe(0); // tree voided by the timeout fire
  });

  it("an `expire` root past its deadline lapses SILENTLY (no wake) but still voids the tree", async () => {
    const r = await reg({ all: [{ event: 'ex:a' }, { event: 'ex:b' }] }, { timeoutSec: 300, timeoutBehavior: 'expire' });
    if (!r.registered) throw new Error('expected registration');

    await sql`UPDATE harness_shared.event_await_nodes SET expires_ts = now() - interval '1 minute' WHERE id = ${r.rootId}`;
    await engine.sweepOnce(h.ws);

    expect(await anchorDeliveries(r.anchorAwaitId)).toHaveLength(0); // silent — no wake queued
    // …but the tree is consumed: the root is claimed (fired_at) and its leaves are voided.
    const root = await sql`SELECT fired_at FROM harness_shared.event_await_nodes WHERE id = ${r.rootId}`;
    expect(root[0].fired_at).not.toBeNull();
    expect(await liveLeafCount(r.rootId)).toBe(0);
  });
});
