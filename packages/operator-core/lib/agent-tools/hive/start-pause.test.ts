/**
 * Unit tests for pot:start / pot:pause
 * (start-hive-wake-orchestration-2026-06-09 P-005 / P-013, D-005/D-006).
 *
 * Pin the control contract: what Start arms (started bit, ENSURE-mode default
 * subscriptions, wake-mode auto, an immediate floor-debounced wake) and what
 * Pause clears (started bit FIRST — the watchdog's disarm — then wake-mode
 * manual, then the pending time wake; optional bee drain).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const setHiveStarted = vi.fn();
const setHivePlacementStarted = vi.fn();
const anyHivePlacementStarted = vi.fn();
vi.mock('../../hive/started', () => ({
  setHiveStarted: (...a: unknown[]) => setHiveStarted(...a),
  setHivePlacementStarted: (...a: unknown[]) => setHivePlacementStarted(...a),
  anyHivePlacementStarted: (...a: unknown[]) => anyHivePlacementStarted(...a),
}));

const armDefaults = vi.fn();
vi.mock('../../hive/wake-defaults', () => ({
  armDefaultHiveWakeSubscriptions: (...a: unknown[]) => armDefaults(...a),
}));

const setDefaultWakeMode = vi.fn();
vi.mock('../coordination/wake-mode', () => ({
  setDefaultWakeMode: (...a: unknown[]) => setDefaultWakeMode(...a),
}));

const requestUrgentHiveWake = vi.fn();
vi.mock('../../hive/urgent-wake', () => ({
  requestUrgentHiveWake: (...a: unknown[]) => requestUrgentHiveWake(...a),
}));

const clearHiveTimeWake = vi.fn();
vi.mock('../../hive/wake', () => ({
  clearHiveTimeWake: (...a: unknown[]) => clearHiveTimeWake(...a),
  resolveHiveHomeSlug: (explicit?: string | null, ctxSlug?: string | null) =>
    explicit?.trim() || ctxSlug?.trim() || null,
}));

const sendMessage = vi.fn();
vi.mock('../coordination/messages', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test', ownerLabel: 'su · test' }),
}));

let beeRows: Array<{ session_owner: string | null }> = [];
const fakeSql = (strings: TemplateStringsArray | string[]): Promise<unknown[]> => {
  const text = Array.isArray(strings) ? strings.join('?') : String(strings);
  if (/spawned_agents/i.test(text)) return Promise.resolve(beeRows);
  return Promise.resolve([]);
};
// Partial mock: the wider import graph (agent-mcp bootstrap) needs the real
// `generated` schema exports — only the PG handle is faked.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getOrgPg: () => ({ sql: fakeSql }) };
});

import hiveStart from './start';
import hivePause from './pause';

const ctx = { workspaceId: 'ws-1', isSuperuser: true } as never;
const call = async (tool: { args: unknown; handler: Function }, x: unknown) => {
  const parsed = (tool.args as { parse: (v: unknown) => unknown }).parse(x);
  const res = await tool.handler(parsed, ctx);
  return JSON.parse(res.content[0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  beeRows = [];
  armDefaults.mockResolvedValue({ rules: 3, added: 0 });
  requestUrgentHiveWake.mockResolvedValue({ fired: true, coalesced: false });
  // Default: pausing THIS hive leaves none started → the workspace loop idles.
  anyHivePlacementStarted.mockResolvedValue(false);
});

describe('pot:start (P-005 / D-006)', () => {
  it('refuses without a resolvable home harness', async () => {
    const out = await call(hiveStart as never, {});
    expect(out.ok).toBe(false);
    expect(out.error).toBe('no_home_harness');
    expect(setHiveStarted).not.toHaveBeenCalled();
  });

  it('persists started, ENSURE-arms the default subscriptions, sets wake-mode auto, wakes now', async () => {
    const out = await call(hiveStart as never, { harness: 'my-hive' });
    expect(out.ok).toBe(true);
    expect(out.started).toBe(true);
    expect(setHiveStarted).toHaveBeenCalledWith('ws-1', 'my-hive', true);
    // ENSURE — never clobber the Queen's runtime tuning (P-002 / D-001).
    expect(armDefaults).toHaveBeenCalledWith('ws-1', { mode: 'ensure' });
    expect(setDefaultWakeMode).toHaveBeenCalledWith('auto');
    expect(requestUrgentHiveWake).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'my-hive', workspaceId: 'ws-1' }),
    );
  });
});

describe('pot:pause (P-005 / D-005 / P-013)', () => {
  it('flips started=false FIRST, then wake-mode manual, then clears the time wake', async () => {
    const out = await call(hivePause as never, { harness: 'my-hive' });
    expect(out.ok).toBe(true);
    expect(out.started).toBe(false);
    expect(out.wakeMode).toBe('manual');
    // WI-3261: pot:pause marks the pause DELIBERATE so the paused-hive recovery
    // watchdog never mistakes an owner-initiated pause for a silent outage.
    expect(setHiveStarted).toHaveBeenCalledWith('ws-1', 'my-hive', false, { deliberate: true });
    expect(setDefaultWakeMode).toHaveBeenCalledWith('manual');
    expect(clearHiveTimeWake).toHaveBeenCalled();
    // Order (P-013): started=false before the wake clear, so no watchdog seam
    // can re-arm in between — Pause must not be undone by its own safety net.
    const startedOrder = setHiveStarted.mock.invocationCallOrder[0];
    const clearOrder = clearHiveTimeWake.mock.invocationCallOrder[0];
    expect(startedOrder).toBeLessThan(clearOrder);
    // Per-hive: the hive's OWN placement bit is cleared too — marked DELIBERATE
    // (WI-3309) so the paused-hive recovery sweep never reads an owner Stop as a
    // silent outage.
    expect(setHivePlacementStarted).toHaveBeenCalledWith('ws-1', 'my-hive', false, { deliberate: true });
  });

  it('per-hive: keeps the workspace Queen loop running when ANOTHER hive is still started', async () => {
    anyHivePlacementStarted.mockResolvedValue(true); // a sibling hive remains started
    const out = await call(hivePause as never, { harness: 'my-hive' });
    expect(out.ok).toBe(true);
    expect(out.started).toBe(false); // THIS hive's placement is off…
    expect(out.workspaceLoopIdle).toBe(false); // …but the workspace loop stays up
    expect(out.wakeMode).toBe('auto');
    expect(setHivePlacementStarted).toHaveBeenCalledWith('ws-1', 'my-hive', false, { deliberate: true });
    // The workspace loop is NOT idled: sentinel-off / wake-mode manual / time-wake clear all skipped.
    expect(setHiveStarted).not.toHaveBeenCalled();
    expect(setDefaultWakeMode).not.toHaveBeenCalled();
    expect(clearHiveTimeWake).not.toHaveBeenCalled();
  });

  it('does not drain bees by default', async () => {
    beeRows = [{ session_owner: 's-bee-1' }];
    const out = await call(hivePause as never, { harness: 'my-hive' });
    expect(out.drainedBees).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('drainBees:true sends ONE graceful drain cue to every live bee', async () => {
    beeRows = [{ session_owner: 's-bee-1' }, { session_owner: 's-bee-2' }, { session_owner: 's-bee-1' }];
    const out = await call(hivePause as never, { harness: 'my-hive', drainBees: true });
    expect(out.drainedBees).toEqual(['s-bee-1', 's-bee-2']); // deduped
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, msg] = sendMessage.mock.calls[0];
    expect(msg.to).toEqual(['s-bee-1', 's-bee-2']);
    expect(msg.summary).toMatch(/drain/i);
  });
});
