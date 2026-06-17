/**
 * cancel.test.ts — fleet:cancel processes_aborted aggregation (Gap 10).
 *
 * The durable subtree flip (cancelSubtree) is integration-tested via the nursery
 * rig. This unit locks the TOOL's second half — the local-process abort loop
 * (cancel.ts:54-62): for each cancelled node it calls abortLocalSpawn and counts
 * the trues into processes_aborted, and its try/catch SWALLOWS an
 * import/abort failure so the tool still returns ok:true.
 *
 *   • 3 cancelled nodes, abortLocalSpawn → true/false/true ⇒ processes_aborted===2;
 *   • the dynamic import of ../../fleet/operator-spawn REJECTS ⇒ ok:true,
 *     processes_aborted:0 (the durable half already landed; the abort is best-effort).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  identity: vi.fn(),
  cancelSubtree: vi.fn(),
  abortLocalSpawn: vi.fn(),
  getOrgPg: vi.fn(() => ({ sql: {} })),
}));

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: h.identity }));
vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
// Partial mock: keep `generated` (defineTool's bootstrap pulls it) but swap getOrgPg.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: h.getOrgPg,
}));
vi.mock('../../fleet/nursery', () => ({ cancelSubtree: h.cancelSubtree }));
// The tool dynamic-imports operator-spawn for abortLocalSpawn — mock the module so
// the import resolves to our spy (and one test makes it reject).
vi.mock('../../fleet/operator-spawn', () => ({ abortLocalSpawn: h.abortLocalSpawn }));

import cancelTool from './cancel';

const CTX = { workspaceId: 'default', role: 'operator' } as any;
const parse = (res: any) => JSON.parse(res.content[0].text);

const cancelled = (ids: string[]) => ids.map((spawnId) => ({ spawnId }));

function baseCancelResult(ids: string[]) {
  return {
    rootSpawnId: 'root',
    cancelled: cancelled(ids),
    alreadyTerminal: [],
    claimsReleased: 0,
    planClaimsReleased: 0,
    locks: { owners: [], filePathsReleased: 0, resourcesReleased: 0 },
    notified: [],
  };
}

beforeEach(() => {
  h.identity.mockReset().mockReturnValue({ ownerId: 'op-1', ownerLabel: 'Operator', workspaceId: 'default' });
  h.cancelSubtree.mockReset();
  h.abortLocalSpawn.mockReset();
  h.getOrgPg.mockReset().mockReturnValue({ sql: {} });
});

describe('fleet:cancel — processes_aborted aggregation (Gap 10)', () => {
  it('counts only the abortLocalSpawn trues across the cancelled subtree', async () => {
    h.cancelSubtree.mockResolvedValue(baseCancelResult(['s-a', 's-b', 's-c']));
    // true / false / true → exactly 2 live local handles signalled.
    h.abortLocalSpawn.mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValueOnce(true);

    const out = parse(await (cancelTool as any).handler({ spawn_id: 'root' }, CTX));

    expect(out.ok).toBe(true);
    expect(out.processes_aborted).toBe(2);
    expect(out.cancelled).toEqual(['s-a', 's-b', 's-c']);
    expect(h.abortLocalSpawn).toHaveBeenCalledTimes(3);
    expect(h.abortLocalSpawn.mock.calls.map((c) => c[0])).toEqual(['s-a', 's-b', 's-c']);
  });

  it('a failing dynamic import is swallowed: tool still returns ok:true, processes_aborted:0', async () => {
    h.cancelSubtree.mockResolvedValue(baseCancelResult(['s-a', 's-b']));
    // Force the `await import('../../fleet/operator-spawn')` to reject (mirrors a
    // host whose DBOS-pulling module fails to load) — the catch must swallow it.
    h.abortLocalSpawn.mockImplementation(() => {
      throw new Error('should not be reached — import already failed');
    });
    vi.doMock('../../fleet/operator-spawn', () => {
      throw new Error('operator-spawn import boom');
    });
    vi.resetModules();
    // Re-import the tool under the rejecting module mock.
    const { default: cancelToolFresh } = await import('./cancel');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = parse(await (cancelToolFresh as any).handler({ spawn_id: 'root' }, CTX));

    expect(out.ok).toBe(true);
    // The durable half (cancelled, claims_released, …) still rides the result.
    expect(out.cancelled).toEqual(['s-a', 's-b']);
    expect(out.processes_aborted).toBe(0);
    expect(warn).toHaveBeenCalledWith('[fleet:cancel] local process abort failed', expect.anything());
    warn.mockRestore();
    vi.doUnmock('../../fleet/operator-spawn');
    vi.resetModules();
  });
});
