/**
 * Tests for defaultFire's fallback-spawn-recording path (WI-108):
 * when durableSpawnFire is unavailable (DBOS off or inside a step), the
 * fire-and-forget loopbackFetch now also records a durable spawned_agents row
 * so the launch is visible in fleet:tree instead of silently untracked.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Use vi.fn() directly inside factories — avoids the TDZ issue from referencing
// module-level vars inside hoisted vi.mock calls.
// Spread the real module so a lazy transitive import (curation-surface →
// operator-conversations → `generated`) the async tail may touch still resolves;
// only getOrgPg is overridden with the test handle.
vi.mock('@papercusp/db-org', async (importActual) => ({
  ...(await importActual<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(),
}));
vi.mock('../fleet/spawn-tree', () => ({ recordSpawn: vi.fn(), finishSpawn: vi.fn() }));
// Heartbeat the long-lived launch row (P-011 liveness fix) — the SPAWN_HEARTBEAT_INTERVAL_MS
// is kept SMALL here so the interval fires within the test (the real 60s never would).
// recordSpawnPid stamps the firing process's pid on the launch row so the P-033 reclaim
// liveness gate keeps the Queen alive without relying on this heartbeat (durable primary).
vi.mock('../fleet/spawn-reclaim', () => ({
  heartbeatSpawns: vi.fn(),
  recordSpawnPid: vi.fn(() => Promise.resolve()),
  SPAWN_HEARTBEAT_INTERVAL_MS: 10,
}));
vi.mock('../loopback-fetch', async (importActual) => ({
  ...(await importActual<typeof import('../loopback-fetch')>()),
  loopbackFetch: vi.fn(),
}));
// DBOS inactive → goes straight to fire-and-forget fallback.
vi.mock('../dbos/dbos-flags', () => ({ dbosOrchestratorActive: vi.fn(() => false) }));

import { getOrgPg } from '@papercusp/db-org';
import { recordSpawn, finishSpawn } from '../fleet/spawn-tree';
import { heartbeatSpawns } from '../fleet/spawn-reclaim';
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
const activeQueenRows: Array<{ spawn_id: string; harness_slug: string | null }> = [];
const mockSql = vi.fn(async (strings: TemplateStringsArray | string) => {
  const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
  if (text.includes('FROM harness_shared.spawned_agents')) return activeQueenRows;
  return [];
}) as unknown as ReturnType<typeof vi.fn> & { begin: (cb: (tx: typeof mockSql) => unknown) => unknown };
mockSql.begin = vi.fn(async (cb: (tx: typeof mockSql) => unknown) => cb(mockSql));

afterEach(() => {
  setLaunchBlueprintFire(null);
  setLaunchBlueprintResolver(null);
  resetLaunchBlueprintTriggerMap();
  activeQueenRows.length = 0;
  vi.clearAllMocks();
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockSql) => unknown) => cb(mockSql));
});

describe('defaultFire fallback — durable spawn row (WI-108)', () => {
  beforeEach(() => {
    vi.mocked(getOrgPg).mockReturnValue({ sql: mockSql } as unknown as ReturnType<typeof getOrgPg>);
    vi.mocked(recordSpawn).mockResolvedValue(undefined);
    vi.mocked(finishSpawn).mockResolvedValue(undefined);
    vi.mocked(loopbackFetch).mockResolvedValue(new Response('', { status: 200 }));
  });

  it('records a spawned_agents row with status=running before fetch', async () => {
    await fireLaunchBlueprint('cup', opts);

    expect(recordSpawn).toHaveBeenCalledOnce();
    const [sql, input] = vi.mocked(recordSpawn).mock.calls[0]!;
    expect(sql).toBe(mockSql);
    expect(input).toMatchObject({
      workspaceId: 'ws_test',
      harnessSlug: 'papercup',
      childRole: 'cup',
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
    await fireLaunchBlueprint('cup', { ...opts, parent: { spawnId: 's-parent-1', role: 'mug' } });

    expect(recordSpawn).toHaveBeenCalledOnce();
    const [, input] = vi.mocked(recordSpawn).mock.calls[0]!;
    expect(input).toMatchObject({ parentSpawnId: 's-parent-1', parentRole: 'mug' });
  });

  it('flips the row to done after fetch succeeds', async () => {
    await fireLaunchBlueprint('cup', opts);
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

    await fireLaunchBlueprint('cup', opts);
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

    await fireLaunchBlueprint('cup', opts);
    // fetch still went out
    expect(loopbackFetch).toHaveBeenCalledOnce();
    // finishSpawn NOT called (pg is null after the record failure)
    await Promise.resolve();
    expect(finishSpawn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it('skips a fallback Queen launch when the workspace already has an active Queen', async () => {
    activeQueenRows.push({ spawn_id: 's-live-queen', harness_slug: 'papercup' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const target = await fireLaunchBlueprint('coding', {
      ...opts,
      kickoff: 'overlapping wake',
      bodyExtra: { queenBrief: 'PRECOMPUTED' },
    });

    expect(target.role).toBe('mug');
    expect(target.spawn).toMatchObject({ spawnId: 's-live-queen', runId: null, durable: false });
    expect(recordSpawn).not.toHaveBeenCalled();
    expect(loopbackFetch).not.toHaveBeenCalled();
    expect(finishSpawn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped duplicate Queen launch'));
    warn.mockRestore();
  });

  it('threads the correct body fields (blueprintId extra, kickoff, timeoutMs) to the invoke route', async () => {
    await fireLaunchBlueprint('cup', { ...opts, kickoff: 'go', timeoutMs: 120_000, extra: ['FOO=bar'] });

    expect(loopbackFetch).toHaveBeenCalledOnce();
    const [, init] = vi.mocked(loopbackFetch).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.kickoff).toBe('go');
    expect(body.timeoutMs).toBe(120_000);
    expect(body.extra).toContain('BLUEPRINT_ID=cup');
    expect(body.extra).toContain('FOO=bar');
  });
});

/**
 * Heartbeat the long-lived launch row (P-011 liveness fix). `loopbackFetch` holds
 * the connection for the WHOLE worker run — a kind:'hive' Queen wake runs up to the
 * invoke route's 2700s ceiling, far past RECLAIM_STALE_MS (300s). Before this fix the
 * recorded row was never heartbeated, so the P-011 reclaim sweep (opportunistic inside
 * every admitSpawn) reaped a still-running Queen at ~310s ("spawn heartbeat stale > 300s
 * … launching operator host presumed dead"), killing orchestration mid-run (P-033 bench).
 */
describe('defaultFire fallback — heartbeats the launch row while the fetch is in flight (P-011)', () => {
  // Real timers (the SPAWN_HEARTBEAT_INTERVAL_MS mock is 10ms) — fake timers here pull a
  // lazy import chain into the partial @papercusp/db-org mock during microtask flushing.
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeEach(() => {
    vi.mocked(getOrgPg).mockReturnValue({ sql: mockSql } as unknown as ReturnType<typeof getOrgPg>);
    vi.mocked(recordSpawn).mockResolvedValue(undefined);
    vi.mocked(finishSpawn).mockResolvedValue(undefined);
    vi.mocked(heartbeatSpawns).mockResolvedValue(undefined);
  });

  it('beats the recorded spawnId on the heartbeat interval until the fetch settles', async () => {
    // A fetch that resolves only when we let it — so the row stays "in flight" while we tick.
    let resolveFetch!: (r: Response) => void;
    vi.mocked(loopbackFetch).mockReturnValue(new Promise<Response>((r) => { resolveFetch = r; }));

    await fireLaunchBlueprint('cup', { ...opts, kickoff: 'wake' });
    const recordedSpawnId = vi.mocked(recordSpawn).mock.calls[0]![1].spawnId;

    // Several heartbeat intervals while the worker (fetch) is still running.
    await tick(45);
    expect(heartbeatSpawns).toHaveBeenCalled();
    expect(vi.mocked(heartbeatSpawns).mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [sql, ids] of vi.mocked(heartbeatSpawns).mock.calls) {
      expect(sql).toBe(mockSql);
      expect(ids).toEqual([recordedSpawnId]);
    }

    // Worker finishes → the heartbeat stops and the row flips done.
    resolveFetch(new Response('', { status: 200 }));
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledOnce());
    const beatsAtFinish = vi.mocked(heartbeatSpawns).mock.calls.length;

    // No further beats after the fetch settled (the interval was cleared).
    await tick(45);
    expect(vi.mocked(heartbeatSpawns).mock.calls.length).toBe(beatsAtFinish);
  });

  it('stops heartbeating when the fetch fails too (no leak)', async () => {
    let rejectFetch!: (e: unknown) => void;
    vi.mocked(loopbackFetch).mockReturnValue(new Promise<Response>((_r, rej) => { rejectFetch = rej; }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await fireLaunchBlueprint('cup', opts);
    await tick(25);
    expect(heartbeatSpawns).toHaveBeenCalled();

    rejectFetch(new Error('loopback: ECONNREFUSED'));
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledOnce());
    const beatsAtFail = vi.mocked(heartbeatSpawns).mock.calls.length;
    await tick(45);
    expect(vi.mocked(heartbeatSpawns).mock.calls.length).toBe(beatsAtFail);
    warn.mockRestore();
  });

  it('does not heartbeat when the row was never recorded (pg null)', async () => {
    vi.mocked(recordSpawn).mockRejectedValue(new Error('pg down'));
    vi.mocked(loopbackFetch).mockResolvedValue(new Response('', { status: 200 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await fireLaunchBlueprint('cup', opts);
    await tick(45);
    expect(heartbeatSpawns).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
