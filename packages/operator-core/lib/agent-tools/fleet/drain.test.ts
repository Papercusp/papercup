/**
 * Unit tests for fleet:drain — the graceful slot-reclaim cue
 * (local-hive-orchestration-2026-06-06 P-051/P-070, D-006).
 *
 * The drain is a structured coord message, not a kill: these pin that the cue
 * goes to EXACTLY the addressed bee (never broadcast), carries the full
 * wind-down protocol (checkpoint → release locks → release claims → end turn)
 * with the bounded timeout, and preserves propose/dispose (the bee may defer).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const sendMessage = vi.fn();
vi.mock('../coordination/messages', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 's-queen', ownerLabel: 'queen' }),
}));

import drainTool from './drain';

const ctx = { workspaceId: 'ws-1', isSuperuser: true } as never;
const call = async (x: unknown) => {
  const parsed = (drainTool.args as { parse: (v: unknown) => unknown }).parse(x);
  const res = await drainTool.handler(parsed as never, ctx);
  return JSON.parse((res.content[0] as { text: string }).text);
};

beforeEach(() => {
  vi.clearAllMocks();
  sendMessage.mockResolvedValue({ msg_id: 'm-1', ts: 'now', to: ['s-bee-1'] });
});

describe('fleet:drain (P-051 / D-006)', () => {
  it('sends the drain cue to EXACTLY the addressed bee (single-target, never broadcast)', async () => {
    const out = await call({ bee_id: 's-bee-1' });
    expect(out.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, msg] = sendMessage.mock.calls[0] as [unknown, { to: string[] }];
    expect(msg.to).toEqual(['s-bee-1']);
  });

  it('the cue carries the full wind-down protocol + the bounded timeout', async () => {
    await call({ bee_id: 's-bee-1', timeout_sec: 90, reason: 'higher-priority work needs the slot' });
    const [, msg] = sendMessage.mock.calls[0] as [unknown, { summary: string; body: string }];
    expect(msg.summary).toMatch(/drain/i);
    expect(msg.body).toMatch(/[Cc]heckpoint/);
    expect(msg.body).toMatch(/locks/);
    expect(msg.body).toMatch(/work_items:release/);
    expect(msg.body).toContain('~90 seconds');
    expect(msg.body).toContain('higher-priority work needs the slot');
  });

  it('preserves propose/dispose — the bee may defer; the Queen monitors, not forces', async () => {
    const out = await call({ bee_id: 's-bee-1' });
    const [, msg] = sendMessage.mock.calls[0] as [unknown, { body: string }];
    expect(msg.body).toMatch(/defer/i); // the bee owns its timing
    expect(out.next).toMatch(/fleet:assignments/); // the Queen's monitor path
    expect(out.next).toMatch(/fleet:cancel/); // the escalation path on timeout
    expect(out.timeout_sec).toBe(120); // the default bound
  });
});
