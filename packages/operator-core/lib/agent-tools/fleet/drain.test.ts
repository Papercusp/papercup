/**
 * Unit tests for fleet:drain — the graceful slot-reclaim cue
 * (local-hive-orchestration-2026-06-06 P-051/P-070, D-006) + the bulk
 * keyed-array contract (bulk-endpoint-standardization-2026-06-21 P-006).
 *
 * The drain is a structured coord message, not a kill: these pin that the cue
 * goes to EXACTLY the addressed bee (never broadcast), carries the full
 * wind-down protocol (checkpoint → release locks → release claims → end turn)
 * with the bounded timeout, and preserves propose/dispose (the bee may defer).
 * Bulk: n=1 `{ bee_id }` returns the SAME { ok, results:[…], counts } as
 * `{ bee_ids:[…] }`, each result keyed by bee_id, ONE message per bee.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const sendMessage = vi.fn();
vi.mock('../coordination/messages', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 's-queen', ownerLabel: 'mug' }),
}));
// P-001 / D-001: the drain refuses OWNER-DIRECTED (responsive) targets. Drive-mode
// resolves from presence.agentRole via the real classifyOwnerDriveMode + the pure
// classifyAgentPane taxonomy — mock only the presence read so the REAL wiring runs
// (a roleless su- id short-circuits before this is even consulted).
vi.mock('../coordination/presence', () => ({ getPresence: vi.fn(async () => null) }));
// P-003: the drain cue is stamped with the drainer's authority, resolved from
// presence.agentRole/potSlug + fleet membership. Mock the fleet join so the unit
// test never reaches getOrgPg; the sender's kind comes from the getPresence mock.
vi.mock('../coordination/presence-fleet', () => ({ fetchPresenceFleet: vi.fn(async () => new Map()) }));

import drainTool from './drain';
import { getPresence } from '../coordination/presence';

const getPresenceM = vi.mocked(getPresence);

const ctx = { workspaceId: 'ws-1', isSuperuser: true } as never;
interface DrainBulkResult {
  ok: true;
  counts: { ok: number; failed: number };
  results: Array<{
    ok: boolean;
    bee_id: string;
    timeout_sec?: number;
    next?: string;
    error?: string;
    refused?: boolean;
    kind?: string;
    driveMode?: string;
  }>;
}
const env = async (x: unknown) => {
  const parsed = (drainTool.args as { parse: (v: unknown) => unknown }).parse(x);
  const res = (await drainTool.handler(parsed as never, ctx)) as { data: unknown };
  return res.data as DrainBulkResult;
};

beforeEach(() => {
  vi.clearAllMocks();
  getPresenceM.mockResolvedValue(null); // default: no presence row → bee/auto for non-su ids
  sendMessage.mockImplementation(async (_id: unknown, msg: { to: string[] }) => ({
    msg_id: `m-${msg.to[0]}`,
    ts: 'now',
    to: msg.to,
  }));
});

describe('fleet:drain (P-051 / D-006; bulk keyed-array P-006)', () => {
  it('n=1 { bee_id } sends the cue to EXACTLY that bee (single-target, never broadcast)', async () => {
    const b = await env({ bee_id: 's-bee-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, bee_id: 's-bee-1', timeout_sec: 120 });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, msg] = sendMessage.mock.calls[0] as [unknown, { to: string[] }];
    expect(msg.to).toEqual(['s-bee-1']);
  });

  it('the cue carries the full wind-down protocol + the bounded timeout', async () => {
    await env({ bee_id: 's-bee-1', timeout_sec: 90, reason: 'higher-priority work needs the slot' });
    const [, msg] = sendMessage.mock.calls[0] as [unknown, { summary: string; body: string }];
    expect(msg.summary).toMatch(/drain/i);
    expect(msg.body).toMatch(/[Cc]heckpoint/);
    expect(msg.body).toMatch(/locks/);
    expect(msg.body).toMatch(/work_items:release/);
    expect(msg.body).toContain('~90 seconds');
    expect(msg.body).toContain('higher-priority work needs the slot');
  });

  it('preserves propose/dispose — the bee may defer; the Queen monitors, not forces', async () => {
    const b = await env({ bee_id: 's-bee-1' });
    const [, msg] = sendMessage.mock.calls[0] as [unknown, { body: string }];
    expect(msg.body).toMatch(/defer/i); // the bee owns its timing
    expect(b.results[0].next).toMatch(/fleet:assignments/); // the Queen's monitor path
    expect(b.results[0].next).toMatch(/fleet:cancel/); // the escalation path on timeout
    expect(b.results[0].timeout_sec).toBe(120); // the default bound
  });

  it('bee_ids:[…] sends ONE cue per bee, each result keyed by bee_id', async () => {
    const b = await env({ bee_ids: ['s-bee-1', 's-bee-2'] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r) => r.bee_id)).toEqual(['s-bee-1', 's-bee-2']);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    // Each cue addressed its own bee — never a single broadcast.
    expect((sendMessage.mock.calls[0]![1] as { to: string[] }).to).toEqual(['s-bee-1']);
    expect((sendMessage.mock.calls[1]![1] as { to: string[] }).to).toEqual(['s-bee-2']);
  });

  it('one failing send fails ONLY that bee — batch survives (top-level ok:true)', async () => {
    sendMessage.mockImplementation(async (_id: unknown, msg: { to: string[] }) => {
      if (msg.to[0] === 's-bee-bad') throw new Error('send failed');
      return { msg_id: `m-${msg.to[0]}`, ts: 'now', to: msg.to };
    });
    const b = await env({ bee_ids: ['s-bee-1', 's-bee-bad', 's-bee-2'] });
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran every item.
    expect(b.ok).toBe(false);
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r) => [r.bee_id, r.ok])).toEqual([
      ['s-bee-1', true],
      ['s-bee-bad', false],
      ['s-bee-2', true],
    ]);
    expect(b.results[1].error).toContain('send failed');
  });

  // ── P-001 / D-001: owner-directed (responsive) targets are REFUSED, never drained ──
  it("refuses an su- fleet-leader target (never sends it a 'release your slot' cue)", async () => {
    const b = await env({ bee_id: 'su-173cbb09-c016-4d62-8806-70487830c24f' });
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, refused: true, kind: 'su', driveMode: 'responsive' });
    expect(b.results[0].error).toMatch(/owner-directed/);
    expect(b.results[0].error).toMatch(/cannot be drained/);
    // The cue was never sent — an su session holds no slot to release.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses sentinel/planner targets (resolved from presence agentRole)', async () => {
    // Only `agentRole` is read; a partial presence row cast is enough for the guard.
    getPresenceM.mockImplementation((async (id: string) =>
      id === 's-op' ? { ownerId: id, agentRole: 'operator' } : { ownerId: id, agentRole: 'planner' }) as typeof getPresence);
    const b = await env({ bee_ids: ['s-op', 's-pl'] });
    expect(b.counts).toEqual({ ok: 0, failed: 2 });
    expect(b.results.map((r) => [r.kind, r.driveMode])).toEqual([
      ['papercup', 'responsive'],
      ['planner', 'responsive'],
    ]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // ── P-003: the drain cue carries the drainer's authority + scope stamp ──
  it('stamps the drain cue with the drainer\'s authority (a Queen → hive-queen/hive-wide)', async () => {
    // Sender 's-queen' resolves to a queen-kind session with a known hive; the bee
    // target has no presence row (bee/auto → drainable).
    getPresenceM.mockImplementation((async (id: string) =>
      id === 's-queen' ? { ownerId: id, agentRole: 'mug', potSlug: 'papercusp' } : null) as typeof getPresence);
    const b = await env({ bee_id: 's-bee-1' });
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    const [, msg] = sendMessage.mock.calls[0] as [unknown, { extra?: Record<string, unknown> }];
    expect(msg.extra).toEqual({
      cueAuthority: { authority: 'hive-queen', authorityRef: 'papercusp', scope: 'hive-wide' },
    });
  });

  it('leaves the drain cue UNstamped when the drainer has no recognized authority (a bee sender)', async () => {
    // Default beforeEach: getPresence → null, so 's-queen' classifies as a plain bee
    // → no control authority → no stamp (never a self-asserted one).
    const b = await env({ bee_id: 's-bee-1' });
    expect(b.results[0].ok).toBe(true);
    const [, msg] = sendMessage.mock.calls[0] as [unknown, { extra?: unknown }];
    expect(msg.extra).toBeUndefined();
  });

  it('a mixed batch drains the bees and refuses ONLY the responsive session', async () => {
    const b = await env({ bee_ids: ['s-bee-1', 'su-leader', 's-bee-2'] });
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran every item.
    expect(b.ok).toBe(false);
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r) => [r.bee_id, r.ok])).toEqual([
      ['s-bee-1', true],
      ['su-leader', false],
      ['s-bee-2', true],
    ]);
    expect(b.results[1]).toMatchObject({ refused: true, kind: 'su' });
    // Exactly the two bees got a cue — never the leader.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const targets = sendMessage.mock.calls.map((c) => (c[1] as { to: string[] }).to[0]);
    expect(targets).toEqual(['s-bee-1', 's-bee-2']);
  });
});
