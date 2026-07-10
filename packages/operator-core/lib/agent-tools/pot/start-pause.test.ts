/**
 * Unit tests for pot:start / pot:pause
 * (start-hive-wake-orchestration-2026-06-09 P-005 / P-013, D-005/D-006).
 *
 * Pin the control contract: what Start arms (started bit, ENSURE-mode default
 * subscriptions, wake-mode auto, an immediate floor-debounced wake) and what
 * Pause clears (started bit FIRST — the watchdog's disarm — then wake-mode
 * manual, then the pending time wake; optional cup drain).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const setPotStarted = vi.fn();
const setPotPlacementStarted = vi.fn();
const anyPotPlacementStarted = vi.fn();
vi.mock('../../pot/started', () => ({
  setPotStarted: (...a: unknown[]) => setPotStarted(...a),
  setPotPlacementStarted: (...a: unknown[]) => setPotPlacementStarted(...a),
  anyPotPlacementStarted: (...a: unknown[]) => anyPotPlacementStarted(...a),
}));

const isWorkspaceCoordinationOn = vi.fn();
vi.mock('../../workspace-brain-scope', () => ({
  isWorkspaceCoordinationOn: (...a: unknown[]) => isWorkspaceCoordinationOn(...a),
}));

const armDefaults = vi.fn();
vi.mock('../../pot/wake-defaults', () => ({
  armDefaultPotWakeSubscriptions: (...a: unknown[]) => armDefaults(...a),
}));

const setDefaultWakeMode = vi.fn();
vi.mock('../coordination/wake-mode', () => ({
  setDefaultWakeMode: (...a: unknown[]) => setDefaultWakeMode(...a),
}));

const requestUrgentPotWake = vi.fn();
vi.mock('../../pot/urgent-wake', () => ({
  requestUrgentPotWake: (...a: unknown[]) => requestUrgentPotWake(...a),
}));

const clearPotTimeWake = vi.fn();
vi.mock('../../pot/wake', () => ({
  clearPotTimeWake: (...a: unknown[]) => clearPotTimeWake(...a),
  resolvePotHomeSlug: (explicit?: string | null, ctxSlug?: string | null) =>
    explicit?.trim() || ctxSlug?.trim() || null,
}));

const sendMessage = vi.fn();
vi.mock('../coordination/messages', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test', ownerLabel: 'su · test' }),
}));

let cupRows: Array<{ session_owner: string | null }> = [];
const fakeSql = (strings: TemplateStringsArray | string[]): Promise<unknown[]> => {
  const text = Array.isArray(strings) ? strings.join('?') : String(strings);
  if (/spawned_agents/i.test(text)) return Promise.resolve(cupRows);
  return Promise.resolve([]);
};
// Partial mock: the wider import graph (agent-mcp bootstrap) needs the real
// `generated` schema exports — only the PG handle is faked.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getOrgPg: () => ({ sql: fakeSql }) };
});

import potStart from './start';
import potPause from './pause';

const ctx = { workspaceId: 'ws-1', isSuperuser: true } as never;
const call = async (tool: { args: unknown; handler: Function }, x: unknown) => {
  const parsed = (tool.args as { parse: (v: unknown) => unknown }).parse(x);
  const res = await tool.handler(parsed, ctx);
  return JSON.parse(res.content[0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  cupRows = [];
  armDefaults.mockResolvedValue({ rules: 3, added: 0 });
  requestUrgentPotWake.mockResolvedValue({ fired: true, coalesced: false });
  isWorkspaceCoordinationOn.mockResolvedValue(false);
  // Default: pausing THIS pot leaves none started → the workspace loop idles.
  anyPotPlacementStarted.mockResolvedValue(false);
});

describe('pot:start (P-005 / D-006)', () => {
  it('refuses without a resolvable home harness', async () => {
    const out = await call(potStart as never, {});
    expect(out.ok).toBe(false);
    expect(out.error).toBe('no_home_harness');
    expect(setPotStarted).not.toHaveBeenCalled();
  });

  it('persists started, ENSURE-arms the default subscriptions, sets wake-mode auto, wakes now', async () => {
    const out = await call(potStart as never, { harness: 'my-pot' });
    expect(out.ok).toBe(true);
    expect(out.started).toBe(true);
    expect(setPotStarted).toHaveBeenCalledWith('ws-1', 'my-pot', true);
    // ENSURE — never clobber the Mug's runtime tuning (P-002 / D-001).
    expect(armDefaults).toHaveBeenCalledWith('ws-1', { mode: 'ensure' });
    expect(setDefaultWakeMode).toHaveBeenCalledWith('auto');
    expect(requestUrgentPotWake).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'my-pot', workspaceId: 'ws-1' }),
    );
  });

  it('rejects a second started install when workspace coordination collapses wake state to one papercup', async () => {
    isWorkspaceCoordinationOn.mockResolvedValue(true);
    anyPotPlacementStarted.mockResolvedValue(true);

    const out = await call(potStart as never, { harness: 'bogus-install' });

    expect(out).toEqual({
      ok: false,
      error: 'workspace_install_conflict',
      message: 'Workspace coordination already has another started install; pause it before starting this install.',
      workspace: 'ws-1',
      harness: 'bogus-install',
    });
    expect(setPotPlacementStarted).not.toHaveBeenCalled();
    expect(setPotStarted).not.toHaveBeenCalled();
    expect(armDefaults).not.toHaveBeenCalled();
    expect(requestUrgentPotWake).not.toHaveBeenCalled();
  });
});

describe('pot:pause (P-005 / D-005 / P-013)', () => {
  it('flips started=false FIRST, then wake-mode manual, then clears the time wake', async () => {
    const out = await call(potPause as never, { harness: 'my-pot' });
    expect(out.ok).toBe(true);
    expect(out.started).toBe(false);
    expect(out.wakeMode).toBe('manual');
    // WI-3261: pot:pause marks the pause DELIBERATE so the paused-pot recovery
    // watchdog never mistakes an owner-initiated pause for a silent outage.
    expect(setPotStarted).toHaveBeenCalledWith('ws-1', 'my-pot', false, { deliberate: true });
    expect(setDefaultWakeMode).toHaveBeenCalledWith('manual');
    expect(clearPotTimeWake).toHaveBeenCalled();
    // Order (P-013): started=false before the wake clear, so no watchdog seam
    // can re-arm in between — Pause must not be undone by its own safety net.
    const startedOrder = setPotStarted.mock.invocationCallOrder[0];
    const clearOrder = clearPotTimeWake.mock.invocationCallOrder[0];
    expect(startedOrder).toBeLessThan(clearOrder);
    // Per-pot: the pot's OWN placement bit is cleared too — marked DELIBERATE
    // (WI-3309) so the paused-pot recovery sweep never reads an owner Stop as a
    // silent outage.
    expect(setPotPlacementStarted).toHaveBeenCalledWith('ws-1', 'my-pot', false, { deliberate: true });
  });

  it('per-pot: keeps the workspace Mug loop running when ANOTHER pot is still started', async () => {
    anyPotPlacementStarted.mockResolvedValue(true); // a sibling pot remains started
    const out = await call(potPause as never, { harness: 'my-pot' });
    expect(out.ok).toBe(true);
    expect(out.started).toBe(false); // THIS pot's placement is off…
    expect(out.workspaceLoopIdle).toBe(false); // …but the workspace loop stays up
    expect(out.wakeMode).toBe('auto');
    expect(setPotPlacementStarted).toHaveBeenCalledWith('ws-1', 'my-pot', false, { deliberate: true });
    // The workspace loop is NOT idled: papercup-off / wake-mode manual / time-wake clear all skipped.
    expect(setPotStarted).not.toHaveBeenCalled();
    expect(setDefaultWakeMode).not.toHaveBeenCalled();
    expect(clearPotTimeWake).not.toHaveBeenCalled();
  });

  it('does not drain cups by default', async () => {
    cupRows = [{ session_owner: 's-cup-1' }];
    const out = await call(potPause as never, { harness: 'my-pot' });
    expect(out.drainedCups).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('drainCups:true sends ONE graceful drain cue to every live cup', async () => {
    cupRows = [{ session_owner: 's-cup-1' }, { session_owner: 's-cup-2' }, { session_owner: 's-cup-1' }];
    const out = await call(potPause as never, { harness: 'my-pot', drainCups: true });
    expect(out.drainedCups).toEqual(['s-cup-1', 's-cup-2']); // deduped
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, msg] = sendMessage.mock.calls[0];
    expect(msg.to).toEqual(['s-cup-1', 's-cup-2']);
    expect(msg.summary).toMatch(/drain/i);
  });
});
