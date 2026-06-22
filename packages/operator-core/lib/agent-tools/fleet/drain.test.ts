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
  resolveAgentIdentity: () => ({ ownerId: 's-queen', ownerLabel: 'queen' }),
}));

import drainTool from './drain';

const ctx = { workspaceId: 'ws-1', isSuperuser: true } as never;
const env = async (x: unknown) => {
  const parsed = (drainTool.args as { parse: (v: unknown) => unknown }).parse(x);
  const res = (await drainTool.handler(parsed as never, ctx)) as { data: unknown };
  return res.data;
};

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(b.results.map((r: any) => r.bee_id)).toEqual(['s-bee-1', 's-bee-2']);
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
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r: any) => [r.bee_id, r.ok])).toEqual([
      ['s-bee-1', true],
      ['s-bee-bad', false],
      ['s-bee-2', true],
    ]);
    expect(b.results[1].error).toContain('send failed');
  });
});
