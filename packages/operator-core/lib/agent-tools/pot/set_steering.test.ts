/**
 * pot:set-steering + pot:get-steering handler tests
 * (queen-steering-panel-2026-06-15 B-01 / C-1).
 *
 * The owner-steering store is round-tripped against PG via owner-steering's own
 * unit suite (hive-settings-store mocked there); THIS file pins the tool-handler
 * orchestration: the patch fan-out, the workspace/pot resolution, the Mug wake
 * on a write, and the no-home-harness + failure surfaces — store + wake mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OWNER_STEERING, type OwnerSteering } from '../../owner-steering';

const setOwnerSteering = vi.fn<(ws: string, pot: string, patch: unknown) => Promise<OwnerSteering>>();
const getOwnerSteering = vi.fn<(ws: string, pot: string) => Promise<OwnerSteering>>();
const requestUrgentPotWake = vi.fn(async () => ({ fired: true, coalesced: false }));
const resolvePotHomeSlug = vi.fn<(explicit?: string | null, ctx?: string | null) => string | null>();
const notifySyncInvalidate = vi.fn(async () => {});

vi.mock('../../owner-steering', async (orig) => ({
  ...(await orig<typeof import('../../owner-steering')>()),
  setOwnerSteering: (...a: [string, string, unknown]) => setOwnerSteering(...a),
  getOwnerSteering: (...a: [string, string]) => getOwnerSteering(...a),
}));
vi.mock('../../pot/urgent-wake', () => ({ requestUrgentPotWake: (...a: unknown[]) => requestUrgentPotWake(...(a as [])) }));
vi.mock('../../pot/wake', () => ({ resolvePotHomeSlug: (...a: [string?, string?]) => resolvePotHomeSlug(...a) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: (...a: unknown[]) => notifySyncInvalidate(...(a as [])) }));

import setSteeringTool from './set_steering';
import getSteeringTool from './get_steering';

type Tool = { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };
const setTool = setSteeringTool as unknown as Tool;
const getTool = getSteeringTool as unknown as Tool;
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> => JSON.parse(r.content[0].text);
const ctx = (): never => ({}) as never;

beforeEach(() => {
  vi.clearAllMocks();
  resolvePotHomeSlug.mockImplementation((explicit) => explicit ?? null);
  setOwnerSteering.mockResolvedValue(DEFAULT_OWNER_STEERING);
  getOwnerSteering.mockResolvedValue(DEFAULT_OWNER_STEERING);
  requestUrgentPotWake.mockResolvedValue({ fired: true, coalesced: false });
});
afterEach(() => vi.clearAllMocks());

describe('pot:set-steering', () => {
  it('writes the provided fields, refreshes the panel, and WAKES the Mug', async () => {
    const next: OwnerSteering = { directive: 'focus', eligiblePlans: ['p1'], eligibleHives: [], includeUnplannedWork: true, pauseNewWork: false, pausedUntil: null };
    setOwnerSteering.mockResolvedValueOnce(next);
    const res = parse(await setTool.handler({ pot: 'acme', directive: 'focus', eligiblePlans: ['p1'] }, ctx()));

    expect(setOwnerSteering).toHaveBeenCalledWith('ws-active', 'acme', { directive: 'focus', eligiblePlans: ['p1'] });
    expect(requestUrgentPotWake).toHaveBeenCalledWith(expect.objectContaining({ harness: 'acme', workspaceId: 'ws-active' }));
    expect(res).toMatchObject({ ok: true, pot: 'acme', steering: next, mugWoken: true });
    // notifySyncInvalidate is fire-and-forget (void dynamic import) — it lands on a
    // later microtask, after the handler returns; poll for it.
    await vi.waitFor(() => expect(notifySyncInvalidate).toHaveBeenCalledWith('pot.steering', {}));
  });

  it('passes only the supplied fields (omitted are not in the patch)', async () => {
    await setTool.handler({ pot: 'acme', pauseNewWork: true }, ctx());
    expect(setOwnerSteering).toHaveBeenCalledWith('ws-active', 'acme', { pauseNewWork: true });
  });

  it('clear:true forwards a clear patch', async () => {
    await setTool.handler({ pot: 'acme', clear: true }, ctx());
    expect(setOwnerSteering).toHaveBeenCalledWith('ws-active', 'acme', { clear: true });
  });

  it('forwards eligiblePots (the placement scope, B-04 round-2)', async () => {
    await setTool.handler({ pot: 'acme', eligiblePots: ['pot-a', 'pot-b'] }, ctx());
    expect(setOwnerSteering).toHaveBeenCalledWith('ws-active', 'acme', { eligibleHives: ['pot-a', 'pot-b'] });
  });

  it('forwards the throttle knobs (P-006/P-009) into the patch', async () => {
    await setTool.handler(
      {
        pot: 'acme',
        cadenceFloorSec: 420,
        maxCups: 5,
        idleActivities: { gym: false },
        autoScaleOut: false,
        decomposition: 'serial',
      },
      ctx(),
    );
    expect(setOwnerSteering).toHaveBeenCalledWith('ws-active', 'acme', {
      cadenceFloorSec: 420,
      maxBees: 5,
      idleActivities: { gym: false },
      autoScaleOut: false,
      decomposition: 'serial',
    });
  });

  it('honors an explicit workspace override', async () => {
    await setTool.handler({ pot: 'acme', pauseNewWork: true, workspace: 'ws-other' }, ctx());
    expect(setOwnerSteering).toHaveBeenCalledWith('ws-other', 'acme', { pauseNewWork: true });
  });

  it('no resolvable pot → ok:false no_home_harness (no write, no wake)', async () => {
    const res = parse(await setTool.handler({ directive: 'x' }, ctx()));
    expect(res).toMatchObject({ ok: false, error: 'no_home_harness' });
    expect(setOwnerSteering).not.toHaveBeenCalled();
    expect(requestUrgentPotWake).not.toHaveBeenCalled();
  });

  it('a store failure (e.g. pot not found) surfaces ok:false with the reason', async () => {
    setOwnerSteering.mockRejectedValueOnce(new Error("no Pot 'ghost' in workspace 'ws-active'"));
    const res = parse(await setTool.handler({ pot: 'ghost', directive: 'x' }, ctx()));
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/no Pot/);
  });
});

describe('pot:get-steering', () => {
  it('reads the current steering for the pot', async () => {
    const cur: OwnerSteering = { directive: 'd', eligiblePlans: ['p'], eligibleHives: ['pot-a'], includeUnplannedWork: true, pauseNewWork: true, pausedUntil: null };
    getOwnerSteering.mockResolvedValueOnce(cur);
    const res = parse(await getTool.handler({ pot: 'acme' }, ctx()));
    expect(getOwnerSteering).toHaveBeenCalledWith('ws-active', 'acme');
    expect(res).toMatchObject({ ok: true, pot: 'acme', steering: cur });
  });

  it('no resolvable pot → ok:false no_home_harness', async () => {
    const res = parse(await getTool.handler({}, ctx()));
    expect(res).toMatchObject({ ok: false, error: 'no_home_harness' });
  });
});
