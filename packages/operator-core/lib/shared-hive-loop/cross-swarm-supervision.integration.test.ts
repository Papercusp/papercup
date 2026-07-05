/**
 * cross-swarm-supervision.integration.test.ts — shared-hive-loop-e2e-testing
 * P-010: the CROSS-SWARM SUPERVISION rung over the real DHT.
 *
 * The Queen on Swarm A supervises a bee homed on Swarm B — the three verbs the
 * item names, composed over the brief-11 composition rig (own PG per cell, own
 * Hypercore log per cell, REAL Hyperswarm on a local testnet DHT, the REAL CDC
 * chain + projections):
 *
 *   1. READS cross-swarm live-agent counts — the bee announces presence via the
 *      REAL federation P-008 publisher (`announceLocalPresence` →
 *      handle.append → peer-log → the REAL presence projection into A's
 *      shared_presence), and the Queen's cell counts it through the REAL
 *      production read path: `listFederatedPresence` → `assembleNetworkBoard`
 *      tier 3 (the network:board surface that shipped the "live-agent counts
 *      for peer Swarms" capability — hive-network-surface-2026-06-11; the
 *      original item text said "pot:status", which never grew agent counts).
 *      Staleness honesty: a peer past the staleness window stops counting.
 *   2. MESSAGES a remote bee — a directed coord `messages` row written on A
 *      federates through the mig-147 capture contract → CDC → B's
 *      coord-message projection, exactly once, origin='remote'.
 *   3. WAKES an idle remote session — the persisted wake intent (body.wake,
 *      EI-279 fixed 2026-06-11) fires B's inbox-wake fan on the fresh remote
 *      insert: once, and never again on re-converge. The fan's pump hop is
 *      unit-proven in inbox-wake tests and mocked here (same shape as the
 *      P-005 verb-lifecycle rig).
 *
 * The rung closes the loop: the bee acks BACK to the Queen over the same rail,
 * and the Queen's next read sees both the ack and the bee's updated intent —
 * supervision is a round-trip, not a broadcast.
 *
 * This was BLOCKED on Track A coord federation until 2026-06-11 (D-002 kept it
 * loud); its dependencies — federation P-008 presence-announce + the EI-279
 * cross-instance wake fan — both landed, so the rung composes only shipped,
 * production code paths.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootCompositionRig, type CompositionRig, type SwarmCell } from './composition-rig';
import { coordCellSetup, presenceCellSetup } from './federated-cell-setup';
import { buildCoordMessageProjection } from '../sync/hyperbee/projections/coord-message';
import { buildPresenceProjection } from '../sync/hyperbee/projections/presence';
import {
  announceLocalPresence,
  type LastAnnounce,
  type PresenceIdentity,
} from '../sync/hyperbee/presence-announce';
import { listFederatedPresence } from '../agent-tools/coordination/federated-presence';
import { assembleNetworkBoard } from '../network-board/build-board';

// EI-279: the coord-message projection's federated deliver-and-wake fan
// dynamically imports wakeRecipients — mock the pump hop (unit-proven in
// inbox-wake.test.ts) so this suite asserts the cross-instance TRIGGER.
vi.mock('../agent-tools/coordination/inbox-wake', () => ({
  wakeRecipients: vi.fn(async (recipients: readonly string[]) => ({
    targets: [...recipients],
    keys: [],
    woken: 1,
    staged: 0,
  })),
}));
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';

vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  const { currentCellSql } = await import('./cell-scope');
  return {
    ...actual,
    getOrgPg: () => {
      const sql = currentCellSql();
      if (!sql) throw new Error('getOrgPg outside cell scope — wrap the call in rig.runAsCell()');
      return { sql };
    },
  };
});

const WS = 'ws-shl-comp'; // the rig's default workspaceId
const HARNESS = 'shl';    // the rig's default harnessSlug

const QUEEN = 'queen-a';  // the supervising Queen, homed on cell A
const BEE = 'bee-b-1';    // the supervised bee, homed on cell B
const BEE_MACHINE = 'swarm-b-box';
const STALE_MS = 60_000;

let rig: CompositionRig;

beforeAll(async () => {
  rig = await bootCompositionRig({
    extraCellSetup: async (sql) => {
      await coordCellSetup(sql);
      await presenceCellSetup(sql);
    },
    extraProjections: (popts) => [
      buildCoordMessageProjection(popts) as never,
      buildPresenceProjection(popts) as never,
    ],
  });
}, 180_000);

afterAll(async () => {
  await rig?.close();
});

/** Append a coord row in the production row shape (the 147 capture contract). */
async function appendCoord(cell: SwarmCell, opts: {
  surface: string; msgId: string; writer: string;
  body?: Record<string, unknown>;
}): Promise<void> {
  await cell.sql`
    INSERT INTO harness_shared.coord_event_log
      (workspace_id, surface, writer_key, msg_id, body, harness_slug, origin)
    VALUES (${WS}, ${opts.surface}, ${opts.writer}, ${opts.msgId},
      ${JSON.stringify(opts.body ?? { msg_id: opts.msgId, summary: opts.msgId })}::text::jsonb,
      ${HARNESS}, 'local')
  `;
}

interface LogRow {
  msg_id: string; writer_key: string | null; origin: string; body: Record<string, unknown>;
}

async function coordRows(cell: SwarmCell, surface: string): Promise<LogRow[]> {
  return cell.sql<LogRow[]>`
    SELECT msg_id, writer_key, origin, body
    FROM harness_shared.coord_event_log
    WHERE surface = ${surface} AND workspace_id = ${WS}
    ORDER BY id`;
}

/**
 * Presence announces are DIRECT log appends (no outbox leg), so converge()'s
 * drain-based fixed point can hold before the peer's merge has seen the new
 * block — real swarm replication needs a beat. Re-drive converge until the
 * read settles (bounded), mirroring converge()'s own retry shape.
 */
async function convergeUntil<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  for (let pass = 0; pass < 20; pass++) {
    const conv = await rig.converge();
    expect(conv.fixedPoint).toBe(true);
    const got = await read();
    if (got != null) return got;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`convergeUntil: ${label} never settled`);
}

/** The Queen's cross-swarm roster read — the REAL production read path run
 *  against HER OWN cell's PG (listFederatedPresence → board tier 3). */
async function queenRosterRead(cell: SwarmCell, nowMs: number) {
  const peers = await rig.runAsCell(cell, () =>
    listFederatedPresence({ workspaceId: WS, harnessSlug: HARNESS, staleMs: STALE_MS, now: () => nowMs }),
  );
  const board = assembleNetworkBoard({
    homeSlug: null,
    hives: [],
    liveAgentsBySlug: new Map(),
    federatedPeers: peers,
    discovered: [],
    grantsByPeer: new Map(),
  });
  return { peers, tier3: board.filter((r) => r.tier === 3) };
}

describe('P-010 — cross-swarm supervision: the Queen on A supervises a bee on B over the real DHT', () => {
  let announceMs: number;
  let lastAnnounce: LastAnnounce;
  const beeIdentity = (): PresenceIdentity => ({
    githubUserId: rig.cells.b.githubUserId,
    machineLabel: BEE_MACHINE,
    devicePubkey: rig.cells.b.announcePubkey,
  });

  it('leg 1 — the bee announces on B via the real P-008 publisher; the Queen COUNTS it on A (board tier 3), and the count is staleness-honest', async () => {
    const { a, b } = rig.cells;
    announceMs = Date.now();

    // The bee's presence announce — the REAL publisher over B's OWN log.
    const res = await announceLocalPresence(
      beeIdentity(),
      { intent: `${BEE} idle — awaiting the Queen's brief`, currentView: null, harnessSlug: HARNESS },
      { append: (op) => b.handle.append(op), prev: null, now: () => announceMs, hiveSlug: rig.hiveSlug },
    );
    expect(res.announced).toBe(true);
    lastAnnounce = res.last!;

    // The Queen reads HER OWN cell's PG — the bee federated in.
    const fresh = await convergeUntil(async () => {
      const view = await queenRosterRead(a, announceMs + 1_000);
      return view.peers.length > 0 ? view : null;
    }, 'bee presence on the Queen cell');
    expect(fresh.peers).toHaveLength(1);
    const peer = fresh.peers[0];
    expect(peer.ownerId).toBe(`fed:${b.githubUserId}@${BEE_MACHINE}`);
    expect(peer.stale).toBe(false);
    expect(peer.devicePubkey).toBe(b.announcePubkey); // substrate-verified identity
    expect(peer.intent).toBe(`${BEE} idle — awaiting the Queen's brief`);

    // Board tier 3: one peer-Swarm device, ONE live agent — the count the item names.
    expect(fresh.tier3).toHaveLength(1);
    expect(fresh.tier3[0].key).toBe(b.announcePubkey);
    expect(fresh.tier3[0].liveAgents).toBe(1);
    expect(fresh.tier3[0].focus).toBe(`${BEE} idle — awaiting the Queen's brief`);
    expect(fresh.tier3[0].watchOwners).toEqual([`fed:${b.githubUserId}@${BEE_MACHINE}`]);

    // Staleness honesty: past the window the device still LISTS (the Queen can
    // see a quiet Swarm) but contributes NO live agents.
    const stale = await queenRosterRead(a, announceMs + STALE_MS + 1_000);
    expect(stale.peers[0].stale).toBe(true);
    expect(stale.tier3).toHaveLength(1);
    expect(stale.tier3[0].liveAgents).toBeUndefined();
    expect(stale.tier3[0].watchOwners).toBeUndefined();
    expect(stale.tier3[0].lastSeen).toBe(new Date(announceMs).toISOString());
  }, 120_000);

  it('legs 2+3 — the Queen messages the remote bee with a wake intent: delivered exactly once, the EI-279 fan wakes the idle session on B, and the bee acks back', async () => {
    const { a, b } = rig.cells;
    vi.mocked(wakeRecipients).mockClear();

    // ── Leg 2: the Queen's directed brief, coord:send {wake:true}-shaped. ──
    await appendCoord(a, {
      surface: 'messages', msgId: 'sup-brief-1', writer: QUEEN,
      body: {
        msg_id: 'sup-brief-1', from: QUEEN, to: [BEE], wake: true,
        summary: 'take WI-1 — steered to top priority',
      },
    });
    let conv = await rig.converge();
    expect(conv.fixedPoint).toBe(true);

    // Delivered on B exactly once, origin=remote.
    const briefs = (await coordRows(b, 'messages')).filter((r) => r.msg_id === 'sup-brief-1');
    expect(briefs).toHaveLength(1);
    expect(briefs[0].origin).toBe('remote');
    expect(briefs[0].body.to).toEqual([BEE]);

    // The idle remote session WAKES: the fan fired on B's apply, exactly once,
    // addressed to the bee.
    expect(wakeRecipients).toHaveBeenCalledExactlyOnceWith([BEE], {
      summary: 'take WI-1 — steered to top priority',
      source: QUEEN,
      workspaceId: WS,
    });

    // Re-converge (at-least-once re-apply) → no duplicate delivery, no re-wake.
    conv = await rig.converge();
    expect(conv.fixedPoint).toBe(true);
    expect((await coordRows(b, 'messages')).filter((r) => r.msg_id === 'sup-brief-1')).toHaveLength(1);
    expect(wakeRecipients).toHaveBeenCalledTimes(1);

    // ── Leg 3: the woken bee acks BACK to the Queen (no wake — she's live). ──
    await appendCoord(b, {
      surface: 'messages', msgId: 'sup-ack-1', writer: BEE,
      body: { msg_id: 'sup-ack-1', kind: 'ack', from: BEE, to: [QUEEN], ref: 'sup-brief-1', summary: 'claimed WI-1' },
    });
    conv = await rig.converge();
    expect(conv.fixedPoint).toBe(true);

    const acks = (await coordRows(a, 'messages')).filter((r) => r.msg_id === 'sup-ack-1');
    expect(acks).toHaveLength(1);
    expect(acks[0].origin).toBe('remote');
    expect(acks[0].body.ref).toBe('sup-brief-1');
    // No wake intent on the ack ⇒ the fan stayed quiet.
    expect(wakeRecipients).toHaveBeenCalledTimes(1);
  }, 120_000);

  it('leg 1 continued — the supervision view TRACKS the bee: an intent change re-announces and the Queen reads the new focus (LWW overwrite)', async () => {
    const { a, b } = rig.cells;
    const t2 = announceMs + 5_000;

    // State change ⇒ the cadence rule fires even inside the refresh window.
    const res = await announceLocalPresence(
      beeIdentity(),
      { intent: `${BEE} working WI-1`, currentView: 'work-item:WI-1', harnessSlug: HARNESS },
      { append: (op) => b.handle.append(op), prev: lastAnnounce, now: () => t2, hiveSlug: rig.hiveSlug },
    );
    expect(res.announced).toBe(true);

    // Still ONE roster row (LWW overwrite, not a second agent) — new focus.
    const view = await convergeUntil(async () => {
      const v = await queenRosterRead(a, t2 + 1_000);
      return v.peers[0]?.intent === `${BEE} working WI-1` ? v : null;
    }, 'the bee intent change on the Queen cell');
    expect(view.peers).toHaveLength(1);
    expect(view.peers[0].intent).toBe(`${BEE} working WI-1`);
    expect(view.peers[0].currentView).toBe('work-item:WI-1');
    expect(view.tier3[0].liveAgents).toBe(1);
    expect(view.tier3[0].focus).toBe(`${BEE} working WI-1`);

    // The supervision rail's full evidence on the QUEEN's cell: presence row +
    // the ack — one Swarm's PG holds the whole cross-swarm supervision view.
    const presenceRows = await a.sql<Array<{ device_pubkey: string; hive_slug: string | null }>>`
      SELECT device_pubkey, hive_slug FROM harness_shared.shared_presence
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
    expect(presenceRows).toHaveLength(1);
    expect(presenceRows[0].device_pubkey).toBe(b.announcePubkey);
    expect(presenceRows[0].hive_slug).toBe(rig.hiveSlug); // the P-008 Hive scoping rode along
  }, 120_000);
});
