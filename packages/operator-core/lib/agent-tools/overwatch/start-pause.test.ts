/**
 * Unit tests for kettle:start / kettle:pause (overwatch-role-2026-06-15 B-07).
 *
 * Pin the control contract: what Start arms (started bit, cadence, a live wake
 * ONLY when the papercusp-overwatch flag is ON — else a loud warning + no wake)
 * and what Pause clears (started bit FIRST — the loop/watchdog disarm — then the
 * pending wake; optional drain of a live overwatch session).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const setOverwatchStarted = vi.fn();
const setOverwatchCadenceSec = vi.fn();
vi.mock('../../overwatch/control-state', () => ({
  setOverwatchStarted: (...a: unknown[]) => setOverwatchStarted(...a),
  setOverwatchCadenceSec: (...a: unknown[]) => setOverwatchCadenceSec(...a),
  clampOverwatchCadenceSec: (n: number) => n,
  DEFAULT_OVERWATCH_CADENCE_SEC: 600,
}));

const requestOverwatchWake = vi.fn();
const clearOverwatchWake = vi.fn();
vi.mock('../../overwatch/wake-bridge', () => ({
  requestOverwatchWake: (...a: unknown[]) => requestOverwatchWake(...a),
  clearOverwatchWake: (...a: unknown[]) => clearOverwatchWake(...a),
}));

vi.mock('../../hive/wake', () => ({
  resolvePotHomeSlug: (explicit?: string | null, ctxSlug?: string | null) =>
    explicit?.trim() || ctxSlug?.trim() || null,
}));

const getFlag = vi.fn();
vi.mock('@papercusp/flags/server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getFlag: (...a: unknown[]) => getFlag(...a) };
});

const notifySyncInvalidate = vi.fn();
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: (...a: unknown[]) => notifySyncInvalidate(...a) }));

const sendMessage = vi.fn();
vi.mock('../coordination/messages', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test', ownerLabel: 'su · test' }),
}));

let overwatchRows: Array<{ session_owner: string | null }> = [];
const fakeSql = (strings: TemplateStringsArray | string[]): Promise<unknown[]> => {
  const text = Array.isArray(strings) ? strings.join('?') : String(strings);
  if (/spawned_agents/i.test(text)) return Promise.resolve(overwatchRows);
  return Promise.resolve([]);
};
// Partial mock: the wider import graph (agent-mcp bootstrap) needs the real
// `generated` schema exports — only the PG handle is faked.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getOrgPg: () => ({ sql: fakeSql }) };
});

import overwatchStart from './start';
import overwatchPause from './pause';

const ctx = { workspaceId: 'ws-1', isSuperuser: true } as never;
const call = async (tool: { args: unknown; handler: Function }, x: unknown) => {
  const parsed = (tool.args as { parse: (v: unknown) => unknown }).parse(x);
  const res = await tool.handler(parsed, ctx);
  return JSON.parse(res.content[0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  overwatchRows = [];
  requestOverwatchWake.mockResolvedValue({ wired: true, result: { fired: true } });
  clearOverwatchWake.mockResolvedValue({ wired: true, result: { cleared: true } });
  getFlag.mockResolvedValue(true);
});

describe('kettle:start', () => {
  it('refuses without a resolvable home harness', async () => {
    const out = await call(overwatchStart as never, {});
    expect(out.ok).toBe(false);
    expect(out.error).toBe('no_home_harness');
    expect(setOverwatchStarted).not.toHaveBeenCalled();
  });

  it('persists started + cadence and wakes now when the flag is ON', async () => {
    const out = await call(overwatchStart as never, { harness: 'my-hive', cadenceSec: 300 });
    expect(out.ok).toBe(true);
    expect(out.started).toBe(true);
    expect(out.cadenceSec).toBe(300);
    expect(out.flagEnabled).toBe(true);
    expect(out.warning).toBeUndefined();
    expect(setOverwatchStarted).toHaveBeenCalledWith('ws-1', 'my-hive', true);
    expect(setOverwatchCadenceSec).toHaveBeenCalledWith('ws-1', 'my-hive', 300);
    expect(requestOverwatchWake).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'my-hive', workspaceId: 'ws-1' }),
    );
    expect(out.wake).toEqual({ wired: true, result: { fired: true } });
  });

  it('defaults the cadence to 600 when omitted', async () => {
    const out = await call(overwatchStart as never, { harness: 'my-hive' });
    expect(out.cadenceSec).toBe(600);
    expect(setOverwatchCadenceSec).toHaveBeenCalledWith('ws-1', 'my-hive', 600);
  });

  it('flag OFF → persists the bit + cadence (pre-armed) but does NOT wake, and warns', async () => {
    getFlag.mockResolvedValue(false);
    const out = await call(overwatchStart as never, { harness: 'my-hive' });
    expect(out.ok).toBe(true);
    expect(out.started).toBe(true);
    expect(out.flagEnabled).toBe(false);
    expect(out.warning).toMatch(/flag is OFF/i);
    // Still pre-armed — the bit/cadence persist so a later flag-flip takes effect.
    expect(setOverwatchStarted).toHaveBeenCalledWith('ws-1', 'my-hive', true);
    expect(setOverwatchCadenceSec).toHaveBeenCalledWith('ws-1', 'my-hive', 600);
    // …but no live wake fires while dark.
    expect(requestOverwatchWake).not.toHaveBeenCalled();
    expect(out.wake).toEqual({ wired: false, skipped: 'flag_off' });
  });
});

describe('kettle:pause', () => {
  it('flips started=false FIRST, then clears the pending wake', async () => {
    const out = await call(overwatchPause as never, { harness: 'my-hive' });
    expect(out.ok).toBe(true);
    expect(out.started).toBe(false);
    expect(setOverwatchStarted).toHaveBeenCalledWith('ws-1', 'my-hive', false);
    expect(clearOverwatchWake).toHaveBeenCalledWith({ harness: 'my-hive', workspaceId: 'ws-1' });
    expect(out.wakeCleared).toEqual({ wired: true, result: { cleared: true } });
    // Order: started=false before the wake clear, so nothing re-arms in between.
    const startedOrder = setOverwatchStarted.mock.invocationCallOrder[0];
    const clearOrder = clearOverwatchWake.mock.invocationCallOrder[0];
    expect(startedOrder).toBeLessThan(clearOrder);
  });

  it('does not drain by default', async () => {
    overwatchRows = [{ session_owner: 's-ow-1' }];
    const out = await call(overwatchPause as never, { harness: 'my-hive' });
    expect(out.drainedOverwatch).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('drain:true sends ONE graceful stop cue to every live overwatch session', async () => {
    overwatchRows = [{ session_owner: 's-ow-1' }, { session_owner: 's-ow-2' }, { session_owner: 's-ow-1' }];
    const out = await call(overwatchPause as never, { harness: 'my-hive', drain: true });
    expect(out.drainedOverwatch).toEqual(['s-ow-1', 's-ow-2']); // deduped
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, msg] = sendMessage.mock.calls[0];
    expect(msg.to).toEqual(['s-ow-1', 's-ow-2']);
    expect(msg.summary).toMatch(/stop cue/i);
  });
});
