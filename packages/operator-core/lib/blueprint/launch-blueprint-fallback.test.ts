/**
 * Tests for defaultFire's fallback-spawn-recording path (WI-108):
 * when durableSpawnFire is unavailable (DBOS off or inside a step), the
 * fire-and-forget loopbackFetch now also records a durable spawned_agents row
 * so the launch is visible in fleet:tree instead of silently untracked.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Use vi.fn() directly inside factories — avoids the TDZ issue from referencing
// module-level vars inside hoisted vi.mock calls.
vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));
vi.mock('../fleet/spawn-tree', () => ({ recordSpawn: vi.fn(), finishSpawn: vi.fn() }));
vi.mock('../loopback-fetch', async (importActual) => ({
  ...(await importActual<typeof import('../loopback-fetch')>()),
  loopbackFetch: vi.fn(),
}));
// DBOS inactive → goes straight to fire-and-forget fallback.
vi.mock('../dbos/dbos-flags', () => ({ dbosOrchestratorActive: vi.fn(() => false) }));

import { getOrgPg } from '@papercusp/db-org';
import { recordSpawn, finishSpawn } from '../fleet/spawn-tree';
import { loopbackFetch } from '../loopback-fetch';
import {
  fireLaunchBlueprint,
  setLaunchBlueprintFire,
  setLaunchBlueprintResolver,
  resetLaunchBlueprintTriggerMap,
} from './launch-blueprint';

const opts = { installSlug: 'papercup', workspaceId: 'ws_test' };
// Stable mock sql handle — same object every getOrgPg() call so finishSpawn
// gets the same reference that recordSpawn got.
const mockSql = { _tag: 'mockSql' } as unknown;

afterEach(() => {
  setLaunchBlueprintFire(null);
  setLaunchBlueprintResolver(null);
  resetLaunchBlueprintTriggerMap();
  vi.clearAllMocks();
});

describe('defaultFire fallback — durable spawn row (WI-108)', () => {
  beforeEach(() => {
    vi.mocked(getOrgPg).mockReturnValue({ sql: mockSql } as ReturnType<typeof getOrgPg>);
    vi.mocked(recordSpawn).mockResolvedValue(undefined);
    vi.mocked(finishSpawn).mockResolvedValue(undefined);
    vi.mocked(loopbackFetch).mockResolvedValue(new Response('', { status: 200 }));
  });

  it('records a spawned_agents row with status=running before fetch', async () => {
    await fireLaunchBlueprint('bee', opts);

    expect(recordSpawn).toHaveBeenCalledOnce();
    const [sql, input] = vi.mocked(recordSpawn).mock.calls[0]!;
    expect(sql).toBe(mockSql);
    expect(input).toMatchObject({
      workspaceId: 'ws_test',
      harnessSlug: 'papercup',
      childRole: 'bee',
      status: 'running',
      // parent_role is NOT NULL in spawned_agents — a parentless launch records
      // 'operator' (a NULL here failed the insert and untracked EVERY fallback
      // launch; learning-system-audit-improvements-2026-06-09 D-010).
      parentRole: 'operator',
      parentSpawnId: null,
    });
    expect(typeof input.spawnId).toBe('string');
    expect(input.spawnId).toMatch(/^s-\d+-[0-9a-f]{8}$/);
    expect(typeof input.runId).toBe('string');
    expect(input.runId).toMatch(/^launch-\d+-[0-9a-f]{6}$/);
  });

  it('records the launching parent lineage when the launch carries one', async () => {
    await fireLaunchBlueprint('bee', { ...opts, parent: { spawnId: 's-parent-1', role: 'queen' } });

    expect(recordSpawn).toHaveBeenCalledOnce();
    const [, input] = vi.mocked(recordSpawn).mock.calls[0]!;
    expect(input).toMatchObject({ parentSpawnId: 's-parent-1', parentRole: 'queen' });
  });

  it('flips the row to done after fetch succeeds', async () => {
    await fireLaunchBlueprint('bee', opts);
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledOnce());

    const [sql, input] = vi.mocked(finishSpawn).mock.calls[0]!;
    expect(sql).toBe(mockSql);
    expect(input).toMatchObject({ workspaceId: 'ws_test', status: 'done' });
    // spawnId on finish must match what was recorded
    const recordedSpawnId = vi.mocked(recordSpawn).mock.calls[0]![1].spawnId;
    expect(input.spawnId).toBe(recordedSpawnId);
  });

  it('flips the row to failed after fetch throws', async () => {
    const fetchErr = new Error('loopback: ECONNREFUSED');
    vi.mocked(loopbackFetch).mockRejectedValue(fetchErr);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await fireLaunchBlueprint('bee', opts);
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledOnce());

    const [, input] = vi.mocked(finishSpawn).mock.calls[0]!;
    expect(input).toMatchObject({
      workspaceId: 'ws_test',
      status: 'failed',
      errorMessage: fetchErr.message,
    });
    warn.mockRestore();
  });

  it('still fires loopbackFetch even when recordSpawn throws (best-effort tracking)', async () => {
    vi.mocked(recordSpawn).mockRejectedValue(new Error('pg down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await fireLaunchBlueprint('bee', opts);
    // fetch still went out
    expect(loopbackFetch).toHaveBeenCalledOnce();
    // finishSpawn NOT called (pg is null after the record failure)
    await Promise.resolve();
    expect(finishSpawn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it('threads the correct body fields (blueprintId extra, kickoff, timeoutMs) to the invoke route', async () => {
    await fireLaunchBlueprint('bee', { ...opts, kickoff: 'go', timeoutMs: 120_000, extra: ['FOO=bar'] });

    expect(loopbackFetch).toHaveBeenCalledOnce();
    const [, init] = vi.mocked(loopbackFetch).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.kickoff).toBe('go');
    expect(body.timeoutMs).toBe(120_000);
    expect(body.extra).toContain('BLUEPRINT_ID=bee');
    expect(body.extra).toContain('FOO=bar');
  });
});
