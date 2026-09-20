/**
 * cancel.test.ts — fleet:cancel processes_aborted aggregation + the bulk
 * keyed-array contract (Gap 10; bulk-endpoint-standardization-2026-06-21 P-006).
 *
 * The durable subtree flip (cancelSubtree) is integration-tested via the nursery
 * rig. This unit locks the TOOL's second half — the local-process abort loop:
 * for each cancelled node it calls abortLocalSpawn and counts the trues into
 * processes_aborted, and a failing dynamic import is swallowed so the tool still
 * returns ok:true. Plus the bulk envelope: n=1 `{ spawn_id }` returns the SAME
 * { ok, results:[…], counts } as `{ spawn_ids:[…] }`, keyed by spawn_id.
 *
 *   • 3 cancelled nodes, abortLocalSpawn → true/false/true ⇒ processes_aborted===2;
 *   • the dynamic import of ../../fleet/operator-spawn REJECTS ⇒ the item still
 *     resolves ok:true, processes_aborted:0 (the durable half landed);
 *   • spawn_ids:[…] cancels many, one failing root fails only itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  identity: vi.fn(),
  cancelSubtree: vi.fn(),
  abortLocalSpawn: vi.fn(),
  killTask: vi.fn(),
  sql: vi.fn(),
  getOrgPg: vi.fn(),
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
vi.mock('../../task-manager/control', () => ({ killTask: h.killTask }));
// The tool dynamic-imports operator-spawn for abortLocalSpawn — mock the module so
// the import resolves to our spy (and one test makes it reject).
vi.mock('../../fleet/operator-spawn', () => ({ abortLocalSpawn: h.abortLocalSpawn }));

import cancelTool from './cancel';

const CTX = { workspaceId: 'default', role: 'operator' } as any;
const env = (res: any) => (res.data);

const cancelled = (ids: string[]) => ids.map((spawnId) => ({ spawnId }));

function baseCancelResult(root: string, ids: string[]) {
  return {
    rootSpawnId: root,
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
  h.killTask.mockReset();
  h.sql.mockReset().mockImplementation(async (strings: TemplateStringsArray, _workspaceId: string, spawnId: string) =>
    strings.join(' ').includes('harness_shared.task_ledger') ? [] : [{ spawn_id: spawnId }],
  );
  h.getOrgPg.mockReset().mockReturnValue({ sql: h.sql });
});

describe('fleet:cancel — bulk envelope + processes_aborted aggregation (Gap 10 / P-006)', () => {
  it('n=1 { spawn_id } returns one keyed result; counts only abortLocalSpawn trues', async () => {
    h.cancelSubtree.mockResolvedValue(baseCancelResult('root', ['s-a', 's-b', 's-c']));
    // true / false / true → exactly 2 live local handles signalled.
    h.abortLocalSpawn.mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValueOnce(true);

    const b = env(await (cancelTool as any).handler({ spawn_id: 'root' }, CTX));

    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    const r = b.results[0];
    expect(r.ok).toBe(true);
    expect(r.spawn_id).toBe('root');
    expect(r.processes_aborted).toBe(2);
    expect(r.cancelled).toEqual(['s-a', 's-b', 's-c']);
    expect(h.abortLocalSpawn).toHaveBeenCalledTimes(3);
    expect(h.abortLocalSpawn.mock.calls.map((c) => c[0])).toEqual(['s-a', 's-b', 's-c']);
  });

  it('spawn_ids:[…] cancels many subtrees, each result keyed by spawn_id', async () => {
    h.cancelSubtree.mockImplementation(async (_sql: unknown, opts: { rootSpawnId: string }) =>
      baseCancelResult(opts.rootSpawnId, [`${opts.rootSpawnId}-child`]),
    );
    h.abortLocalSpawn.mockReturnValue(false);

    const b = env(await (cancelTool as any).handler({ spawn_ids: ['root-a', 'root-b'] }, CTX));

    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: any) => r.spawn_id)).toEqual(['root-a', 'root-b']);
    expect(b.results[0].cancelled).toEqual(['root-a-child']);
  });

  it('terminates a correlated durable task scope when no local abort handle exists', async () => {
    h.cancelSubtree.mockResolvedValue(baseCancelResult('root', ['s-fixer']));
    h.abortLocalSpawn.mockReturnValue(false);
    h.sql.mockImplementation(async (strings: TemplateStringsArray, _workspaceId: string, spawnId: string) =>
      strings.join(' ').includes('harness_shared.task_ledger')
        ? [{ task_id: 'task-fixer', spawn_id: 's-fixer' }]
        : [{ spawn_id: spawnId }],
    );
    h.killTask.mockResolvedValue({ ok: true, taskId: 'task-fixer', action: 'kill' });

    const b = env(await (cancelTool as any).handler({ spawn_id: 'root' }, CTX));

    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    expect(b.results[0]).toMatchObject({
      ok: true,
      processes_aborted: 1,
      task_scopes_aborted: 1,
    });
    expect(h.killTask).toHaveBeenCalledWith('task-fixer', {
      signal: 'SIGTERM',
      includeSubtree: true,
      escalateAfterMs: 5_000,
      reapTerminalResidue: true,
    });
  });

  it('fails loudly when a correlated durable task scope cannot be terminated', async () => {
    h.cancelSubtree.mockResolvedValue(baseCancelResult('root', ['s-fixer']));
    h.abortLocalSpawn.mockReturnValue(false);
    h.sql.mockImplementation(async (strings: TemplateStringsArray, _workspaceId: string, spawnId: string) =>
      strings.join(' ').includes('harness_shared.task_ledger')
        ? [{ task_id: 'task-fixer', spawn_id: 's-fixer' }]
        : [{ spawn_id: spawnId }],
    );
    h.killTask.mockResolvedValue({
      ok: false,
      taskId: 'task-fixer',
      action: 'kill',
      error: 'incomplete',
      detail: 'scope still holds children',
    });

    const b = env(await (cancelTool as any).handler({ spawn_id: 'root' }, CTX));

    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({
      ok: false,
      processes_aborted: 0,
      task_scopes_aborted: 0,
      error: expect.stringContaining('could not be terminated'),
      process_abort_failures: [
        {
          taskId: 'task-fixer',
          spawnId: 's-fixer',
          error: 'incomplete',
          detail: 'scope still holds children',
        },
      ],
    });
  });

  it('one failing root fails ONLY itself — batch survives (top-level ok:true)', async () => {
    h.cancelSubtree.mockImplementation(async (_sql: unknown, opts: { rootSpawnId: string }) => {
      if (opts.rootSpawnId === 'boom') throw new Error('subtree not found');
      return baseCancelResult(opts.rootSpawnId, []);
    });
    h.abortLocalSpawn.mockReturnValue(false);

    const b = env(await (cancelTool as any).handler({ spawn_ids: ['root-a', 'boom', 'root-b'] }, CTX));

    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran every item.
    expect(b.ok).toBe(false);
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r: any) => [r.spawn_id, r.ok])).toEqual([
      ['root-a', true],
      ['boom', false],
      ['root-b', true],
    ]);
    expect(b.results[1].error).toContain('subtree not found');
  });

  it('refuses a non-nursery owner/session id loudly instead of reporting an empty successful cancel', async () => {
    h.sql.mockImplementation(async (strings: TemplateStringsArray, _workspaceId: string, spawnId: string) =>
      strings.join(' ').includes('harness_shared.task_ledger')
        ? []
        : spawnId === 'su-omp-hook-session'
          ? []
          : [{ spawn_id: spawnId }],
    );
    h.cancelSubtree.mockResolvedValue(baseCancelResult('real-spawn', ['real-spawn']));
    h.abortLocalSpawn.mockReturnValue(false);

    const b = env(await (cancelTool as any).handler({ spawn_ids: ['su-omp-hook-session', 'real-spawn'] }, CTX));

    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    expect(b.ok).toBe(false);
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results.map((r: any) => [r.spawn_id, r.ok])).toEqual([
      ['su-omp-hook-session', false],
      ['real-spawn', true],
    ]);
    expect(b.results[0]).toMatchObject({ refused: true });
    expect(b.results[0].error).toContain('not a nursery spawn');
    expect(b.results[0].error).toContain('owner-directed OMP/static session');
    expect(h.cancelSubtree).toHaveBeenCalledTimes(1);
    expect(h.cancelSubtree.mock.calls[0]![1]).toMatchObject({ rootSpawnId: 'real-spawn' });
  });

  it('a failing dynamic import is swallowed: items still ok:true, processes_aborted:0', async () => {
    h.cancelSubtree.mockResolvedValue(baseCancelResult('root', ['s-a', 's-b']));
    h.abortLocalSpawn.mockImplementation(() => {
      throw new Error('should not be reached — import already failed');
    });
    vi.doMock('../../fleet/operator-spawn', () => {
      throw new Error('operator-spawn import boom');
    });
    vi.resetModules();
    const { default: cancelToolFresh } = await import('./cancel');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = env(await (cancelToolFresh as any).handler({ spawn_id: 'root' }, CTX));

    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    const r = b.results[0];
    expect(r.ok).toBe(true);
    expect(r.cancelled).toEqual(['s-a', 's-b']);
    expect(r.processes_aborted).toBe(0);
    expect(warn).toHaveBeenCalledWith('[fleet:cancel] local process abort failed', expect.anything());
    warn.mockRestore();
    vi.doUnmock('../../fleet/operator-spawn');
    vi.resetModules();
  });
});
