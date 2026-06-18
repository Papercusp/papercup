/**
 * hive:set-steering + hive:get-steering handler tests
 * (queen-steering-panel-2026-06-15 B-01 / C-1).
 *
 * The owner-steering store is round-tripped against PG via owner-steering's own
 * unit suite (hive-settings-store mocked there); THIS file pins the tool-handler
 * orchestration: the patch fan-out, the workspace/hive resolution, the Queen wake
 * on a write, and the no-home-harness + failure surfaces — store + wake mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OWNER_STEERING, type OwnerSteering } from '../../owner-steering';

const setOwnerSteering = vi.fn<(ws: string, hive: string, patch: unknown) => Promise<OwnerSteering>>();
const getOwnerSteering = vi.fn<(ws: string, hive: string) => Promise<OwnerSteering>>();
const requestUrgentHiveWake = vi.fn(async () => ({ fired: true, coalesced: false }));
const resolveHiveHomeSlug = vi.fn<(explicit?: string | null, ctx?: string | null) => string | null>();
const notifySyncInvalidate = vi.fn(async () => {});

vi.mock('../../owner-steering', async (orig) => ({
  ...(await orig<typeof import('../../owner-steering')>()),
  setOwnerSteering: (...a: [string, string, unknown]) => setOwnerSteering(...a),
  getOwnerSteering: (...a: [string, string]) => getOwnerSteering(...a),
}));
vi.mock('../../hive/urgent-wake', () => ({ requestUrgentHiveWake: (...a: unknown[]) => requestUrgentHiveWake(...(a as [])) }));
vi.mock('../../hive/wake', () => ({ resolveHiveHomeSlug: (...a: [string?, string?]) => resolveHiveHomeSlug(...a) }));
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
  resolveHiveHomeSlug.mockImplementation((explicit) => explicit ?? null);
  setOwnerSteering.mockResolvedValue(DEFAULT_OWNER_STEERING);
  getOwnerSteering.mockResolvedValue(DEFAULT_OWNER_STEERING);
  requestUrgentHiveWake.mockResolvedValue({ fired: true, coalesced: false });
});
afterEach(() => vi.clearAllMocks());

describe('hive:set-steering', () => {
  it('writes the provided fields, refreshes the panel, and WAKES the Queen', async () => {
    const next: OwnerSteering = { directive: 'focus', eligiblePlans: ['p1'], eligibleHives: [], pauseNewWork: false, pausedUntil: null };
    setOwnerSteering.mockResolvedValueOnce(next);
    const res = parse(await setTool.handler({ hive: 'acme', directive: 'focus', eligiblePlans: ['p1'] }, ctx()));

    expect(setOwnerSteering).toHaveBeenCalledWith('ws-active', 'acme', { directive: 'focus', eligiblePlans: ['p1'] });
    expect(requestUrgentHiveWake).toHaveBeenCalledWith(expect.objectContaining({ harness: 'acme', workspaceId: 'ws-active' }));
    expect(res).toMatchObject({ ok: true, hive: 'acme', steering: next, queenWoken: true });
    // notifySyncInvalidate is fire-and-forget (void dynamic import) — it lands on a
    // later microtask, after the handler returns; poll for it.
    await vi.waitFor(() => expect(notifySyncInvalidate).toHaveBeenCalledWith('hive.steering', {}));
  });

  it('passes only the supplied fields (omitted are not in the patch)', async () => {
    await setTool.handler({ hive: 'acme', pauseNewWork: true }, ctx());
    expect(setOwnerSteering).toHaveBeenCalledWith('ws-active', 'acme', { pauseNewWork: true });
  });

  it('clear:true forwards a clear patch', async () => {
    await setTool.handler({ hive: 'acme', clear: true }, ctx());
    expect(setOwnerSteering).toHaveBeenCalledWith('ws-active', 'acme', { clear: true });
  });

  it('forwards eligibleHives (the placement scope, B-04 round-2)', async () => {
    await setTool.handler({ hive: 'acme', eligibleHives: ['hive-a', 'hive-b'] }, ctx());
    expect(setOwnerSteering).toHaveBeenCalledWith('ws-active', 'acme', { eligibleHives: ['hive-a', 'hive-b'] });
  });

  it('forwards the throttle knobs (P-006/P-009) into the patch', async () => {
    await setTool.handler(
      {
        hive: 'acme',
        cadenceFloorSec: 420,
        maxBees: 5,
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
    await setTool.handler({ hive: 'acme', pauseNewWork: true, workspace: 'ws-other' }, ctx());
    expect(setOwnerSteering).toHaveBeenCalledWith('ws-other', 'acme', { pauseNewWork: true });
  });

  it('no resolvable hive → ok:false no_home_harness (no write, no wake)', async () => {
    const res = parse(await setTool.handler({ directive: 'x' }, ctx()));
    expect(res).toMatchObject({ ok: false, error: 'no_home_harness' });
    expect(setOwnerSteering).not.toHaveBeenCalled();
    expect(requestUrgentHiveWake).not.toHaveBeenCalled();
  });

  it('a store failure (e.g. hive not found) surfaces ok:false with the reason', async () => {
    setOwnerSteering.mockRejectedValueOnce(new Error("no Hive 'ghost' in workspace 'ws-active'"));
    const res = parse(await setTool.handler({ hive: 'ghost', directive: 'x' }, ctx()));
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/no Hive/);
  });
});

describe('hive:get-steering', () => {
  it('reads the current steering for the hive', async () => {
    const cur: OwnerSteering = { directive: 'd', eligiblePlans: ['p'], eligibleHives: ['hive-a'], pauseNewWork: true, pausedUntil: null };
    getOwnerSteering.mockResolvedValueOnce(cur);
    const res = parse(await getTool.handler({ hive: 'acme' }, ctx()));
    expect(getOwnerSteering).toHaveBeenCalledWith('ws-active', 'acme');
    expect(res).toMatchObject({ ok: true, hive: 'acme', steering: cur });
  });

  it('no resolvable hive → ok:false no_home_harness', async () => {
    const res = parse(await getTool.handler({}, ctx()));
    expect(res).toMatchObject({ ok: false, error: 'no_home_harness' });
  });
});
