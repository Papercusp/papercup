/**
 * supervise.test.ts — fleet:supervise tool projection + the bulk keyed-array
 * contract (Gap 11; bulk-endpoint-standardization-2026-06-21 P-006).
 *
 * The supervision ENGINE (restart-intensity governor, restart strategies, the
 * crash-loop → teardown + escalate decision) is integration-tested against real PG
 * in fleet/supervision.integration.test.ts. This unit locks the TOOL surface: it
 * resolves the actor/workspace, calls superviseCrash, and projects the
 * SuperviseResult into the per-item shape the supervisor reads — restart and
 * escalate actions both carry the right fields, inside the bulk envelope. n=1
 * `{ spawn_id }` returns the SAME { ok, results:[…], counts } as `{ spawn_ids:[…] }`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  identity: vi.fn(),
  superviseCrash: vi.fn(),
  getOrgPg: vi.fn(() => ({ sql: {} })),
}));

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: h.identity }));
vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: h.getOrgPg,
}));
vi.mock('../../fleet/supervision', () => ({ superviseCrash: h.superviseCrash }));

import superviseTool from './supervise';

const CTX = { workspaceId: 'default', role: 'operator' } as any;
const env = (res: any) => JSON.parse(res.content[0].text);
const one = (res: any) => env(res).results[0];

beforeEach(() => {
  h.identity.mockReset().mockReturnValue({ ownerId: 'curator', ownerLabel: 'Curator', workspaceId: 'default' });
  h.superviseCrash.mockReset();
  h.getOrgPg.mockReset().mockReturnValue({ sql: {} });
});

describe('fleet:supervise tool — result projection + bulk envelope (Gap 11 / P-006)', () => {
  it('n=1 { spawn_id } restart action: one keyed result with strategy, restart_count, to_restart', async () => {
    h.superviseCrash.mockResolvedValue({
      spawnId: 's-a',
      action: 'restart',
      intensity: { count: 2, maxRestarts: 3, windowSec: 600 },
      strategy: 'rest_for_one',
      toRestart: ['s-a', 's-b'],
      reason: 'restart (rest_for_one); attempt 2/3 in window',
    });

    const b = env(await (superviseTool as any).handler({ spawn_id: 's-a', reason: 'exit 1' }, CTX));

    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({
      ok: true,
      spawn_id: 's-a',
      action: 'restart',
      strategy: 'rest_for_one',
      restart_count: 2,
      to_restart: ['s-a', 's-b'],
      escalation_id: null,
    });
    // The handler forwards the resolved actor + workspace + crash reason to the engine.
    expect(h.superviseCrash).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId: 'default', spawnId: 's-a', reason: 'exit 1' }),
    );
  });

  it('escalate action: projects the escalation_id and a null restart_count when intensity is absent', async () => {
    h.superviseCrash.mockResolvedValue({
      spawnId: 's-root',
      action: 'escalate',
      intensity: { count: 4, maxRestarts: 3, windowSec: 600 },
      strategy: 'one_for_one',
      toRestart: [],
      escalationId: 'esc-7',
      reason: 'restart intensity exceeded — 4 restarts in 600s (> 3)',
    });

    const r = one(await (superviseTool as any).handler({ spawn_id: 's-root' }, CTX));

    expect(r).toMatchObject({
      ok: true,
      action: 'escalate',
      escalation_id: 'esc-7',
      restart_count: 4,
      to_restart: [],
    });
  });

  it('noop action (spawn not found): restart_count null, to_restart empty, escalation_id null', async () => {
    h.superviseCrash.mockResolvedValue({
      spawnId: 'ghost',
      action: 'noop',
      intensity: null,
      strategy: 'one_for_one',
      toRestart: [],
      reason: 'spawn not found',
    });

    const r = one(await (superviseTool as any).handler({ spawn_id: 'ghost' }, CTX));

    expect(r).toMatchObject({
      ok: true,
      action: 'noop',
      restart_count: null,
      to_restart: [],
      escalation_id: null,
    });
  });

  it('forwards max_restarts / window_sec overrides to the engine', async () => {
    h.superviseCrash.mockResolvedValue({
      spawnId: 's-a', action: 'restart', intensity: { count: 1, maxRestarts: 5, windowSec: 120 },
      strategy: 'one_for_one', toRestart: ['s-a'], reason: 'ok',
    });
    await (superviseTool as any).handler({ spawn_id: 's-a', max_restarts: 5, window_sec: 120 }, CTX);
    expect(h.superviseCrash).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxRestarts: 5, windowSec: 120 }),
    );
  });

  it('spawn_ids:[…] reports many crashes; one failing report fails ONLY itself', async () => {
    h.superviseCrash.mockImplementation(async (_sql: unknown, opts: { spawnId: string }) => {
      if (opts.spawnId === 'boom') throw new Error('supervise engine error');
      return {
        spawnId: opts.spawnId,
        action: 'restart',
        intensity: { count: 1, maxRestarts: 3, windowSec: 600 },
        strategy: 'one_for_one',
        toRestart: [opts.spawnId],
        reason: 'ok',
      };
    });

    const b = env(await (superviseTool as any).handler({ spawn_ids: ['s-a', 'boom', 's-b'] }, CTX));

    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r: any) => [r.spawn_id, r.ok])).toEqual([
      ['s-a', true],
      ['boom', false],
      ['s-b', true],
    ]);
    expect(b.results[1].error).toContain('supervise engine error');
  });
});
