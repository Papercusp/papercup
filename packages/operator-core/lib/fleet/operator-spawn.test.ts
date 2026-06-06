/**
 * fleet/operator-spawn — unit coverage for the operator→agent nursery spawn
 * engine (Brief 4, agent-briefs-2026-06-05): harness/role/cap validation,
 * durable record/finish bookkeeping, the single-harness default, and the
 * failed-attempt rows that replace the old silent-drop dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));
vi.mock('@papercusp/agent-mcp', () => ({
  AGENT_ROLES: ['scoper', 'worker', 'validator', 'reviewer', 'operator', 'bee'],
}));
vi.mock('../harness-core', () => ({ resolveProject: vi.fn() }));
vi.mock('../harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));
vi.mock('../dbos/orchestrator-runner', () => ({ spawnInvokeOnce: vi.fn() }));
vi.mock('./spawn-tree', () => ({ recordSpawn: vi.fn(), finishSpawn: vi.fn() }));
vi.mock('../rate-limit-config', () => ({
  getCachedRateLimitConfig: () => ({ maxSimultaneousAgents: 16, concurrencyFloor: 1 }),
}));
vi.mock('./spawn-reclaim', () => ({
  heartbeatSpawns: vi.fn(async () => {}),
  reclaimOrphanedSpawns: vi.fn(async () => ({ reclaimed: 0, spawnIds: [] })),
  SPAWN_HEARTBEAT_INTERVAL_MS: 60_000,
}));

import { getOrgPg } from '@papercusp/db-org';
import { resolveProject } from '../harness-core';
import { loadHarnessRegistry } from '../harness-registry';
import { spawnInvokeOnce } from '../dbos/orchestrator-runner';
import { recordSpawn, finishSpawn } from './spawn-tree';
import { spawnAgentInHarness, abortLocalSpawn, spawnConcurrencyCeiling } from './operator-spawn';

// `/tmp` exists on disk, so the project-dir existence check passes without fixtures.
const PROJECT = { slug: 'demo', path: '/tmp', hasState: true, hasSpec: false };

let runningCount = 0;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  runningCount = 0;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // sql is used only by countRunning — a template-tag fn returning the count.
  const sql = vi.fn(async () => [{ n: String(runningCount) }]);
  vi.mocked(getOrgPg).mockReturnValue({ sql } as never);
  vi.mocked(resolveProject).mockResolvedValue(PROJECT as never);
  vi.mocked(loadHarnessRegistry).mockResolvedValue({ projects: [PROJECT] } as never);
  vi.mocked(spawnInvokeOnce).mockResolvedValue({ output: 'done!', exitCode: 0, stderr: '' });
  vi.mocked(recordSpawn).mockResolvedValue(undefined);
  vi.mocked(finishSpawn).mockResolvedValue(undefined);
});
afterEach(() => {
  errorSpy.mockRestore();
  vi.clearAllMocks();
});

/** Let the fire-and-forget completion chain settle. */
const flush = () => new Promise<void>((r) => setImmediate(r));

describe('spawnAgentInHarness — happy path', () => {
  it('resolves the harness, records the nursery row, launches, and finishes done', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1',
      harness: 'demo',
      role: 'validator',
      featureId: 'F-1',
      parentSpawnId: 'op-turn-1',
    });
    expect(res.ok).toBe(true);
    expect(res.spawnId).toMatch(/^s-\d+-/);
    expect(res.harness).toBe('demo');
    expect(res.projectDir).toBe('/tmp');

    // Durable record BEFORE the child launches, with lineage + ownership.
    expect(recordSpawn).toHaveBeenCalledTimes(1);
    const rec = vi.mocked(recordSpawn).mock.calls[0][1];
    expect(rec).toMatchObject({
      workspaceId: 'ws-1',
      harnessSlug: 'demo',
      childRole: 'validator',
      parentSpawnId: 'op-turn-1',
      parentRole: 'operator',
      featureId: 'F-1',
      status: 'running',
    });
    expect(rec.sessionOwner).toBe(rec.spawnId);

    // The child launches in the harness's REAL project dir with the registry
    // slug pinned in env (schema resolution) + the feature extra.
    expect(spawnInvokeOnce).toHaveBeenCalledTimes(1);
    const [dir, role, extras, env] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(dir).toBe('/tmp');
    expect(role).toBe('validator');
    expect(extras).toContain('FEATURE_ID=F-1');
    expect(env.HARNESS_SLUG).toBe('demo');
    expect(env.PAPERCUSP_WORKSPACE_ID).toBe('ws-1');

    await flush();
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId,
      status: 'done',
      exitCode: 0,
      outputTail: 'done!',
    }));
  });

  it('a non-zero child exit finishes the row failed with the stderr tail', async () => {
    vi.mocked(spawnInvokeOnce).mockResolvedValue({ output: '', exitCode: 1, stderr: 'boom' });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'validator' });
    expect(res.ok).toBe(true);
    await flush();
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId,
      status: 'failed',
      exitCode: 1,
      errorMessage: 'boom',
    }));
  });
});

describe('abortLocalSpawn — fleet:cancel actually stops the child (EI-40)', () => {
  it('passes an AbortSignal to spawnInvokeOnce and abortLocalSpawn fires it', async () => {
    // Hold the child open so the spawn stays "live" (registered in the abort map)
    // until we abort it. Capture the signal handed to spawnInvokeOnce.
    let captured: AbortSignal | undefined;
    let resolveChild: (v: { output: string; exitCode: number; stderr: string }) => void;
    vi.mocked(spawnInvokeOnce).mockImplementation(((
      _d: string, _r: string, _e: string[], _env: Record<string, string>, opts?: { signal?: AbortSignal },
    ) => {
      captured = opts?.signal;
      return new Promise((res) => { resolveChild = res; });
    }) as never);

    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper' });
    expect(res.ok).toBe(true);
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);

    // The live spawn is locally tracked → abortLocalSpawn finds + signals it.
    expect(abortLocalSpawn(res.spawnId!)).toBe(true);
    expect(captured!.aborted).toBe(true);

    // Let the (now-aborted) child settle so the finally-cleanup runs.
    resolveChild!({ output: '', exitCode: 1, stderr: 'aborted (fleet:cancel)' });
    await flush();

    // The completion records 'cancelled' (abort was the cause), and the handle is
    // removed from the registry → a second abort is a no-op.
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId, status: 'cancelled',
    }));
    expect(abortLocalSpawn(res.spawnId!)).toBe(false);
  });

  it('abortLocalSpawn returns false for an unknown / already-finished spawn', async () => {
    expect(abortLocalSpawn('s-nonexistent')).toBe(false);
    // A spawn that finished normally is de-registered → not abortable.
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper' });
    await flush();
    expect(abortLocalSpawn(res.spawnId!)).toBe(false);
  });
});

describe('spawnAgentInHarness — harness resolution', () => {
  it('defaults to the single registered harness when none is named', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', role: 'scoper' });
    expect(res.ok).toBe(true);
    expect(res.harness).toBe('demo');
  });

  it('rejects when no harness is named and several are registered', async () => {
    vi.mocked(loadHarnessRegistry).mockResolvedValue({
      projects: [PROJECT, { ...PROJECT, slug: 'other' }],
    } as never);
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', role: 'scoper' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('2 are registered');
    expect(res.error).toContain('demo');
    expect(spawnInvokeOnce).not.toHaveBeenCalled();
  });

  it('rejects an unregistered harness, naming the registered ones, and records the failed attempt', async () => {
    vi.mocked(resolveProject).mockResolvedValue(null as never);
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'nope', role: 'scoper' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('"nope" is not a registered project');
    expect(res.error).toContain('demo');
    // The rejection is DURABLE — a failed nursery row, not a dropped warn.
    expect(recordSpawn).toHaveBeenCalledTimes(1);
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: 'failed',
      errorMessage: expect.stringContaining('nope'),
    }));
    expect(spawnInvokeOnce).not.toHaveBeenCalled();
  });
});

describe('spawnAgentInHarness — role + cap validation', () => {
  it('rejects an unknown role before touching the registry', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'wizard' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('unknown role "wizard"');
    expect(spawnInvokeOnce).not.toHaveBeenCalled();
  });

  it('accepts a plugin-namespaced role (contains a colon)', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'myplugin:gardener' });
    expect(res.ok).toBe(true);
  });

  it('rejects worker without a chunk', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'worker' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('requires a chunk');
  });

  it('accepts worker with a chunk and passes CHUNK_ID through', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'worker', chunkId: 'F-1.c2',
    });
    expect(res.ok).toBe(true);
    const [, , extras] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(extras).toContain('CHUNK_ID=F-1.c2');
  });

  it('accepts the generic `bee` role WITHOUT a chunk (no pipeline guard — local-hive P-011)', async () => {
    // The flip-to-real-path criterion: fleet:spawn { role:'bee' } must pass
    // admission with no chunkId (unlike `worker`, which is chunk-coupled).
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'bee' });
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
    const [, role] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(role).toBe('bee');
  });

  it('threads the Queen brief into the child env as QUEEN_BRIEF (P-060 — the real delivery channel, not `extras`)', async () => {
    // P-060: the brief reaches the bee via extraEnv.QUEEN_BRIEF (which buildInvokeOnce
    // sets on the child env, and invoke-once's buildPrompt renders as `## Queen brief`),
    // NOT as a generic `extras` positional. Assert the real channel.
    const brief = 'watch for the migration race; this connects to bee-2; priority: unblock CI';
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'bee', brief,
    });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(env.QUEEN_BRIEF).toBe(brief);
  });

  it('threads the operator `s-…` spawnId into the child env as PAPERCUSP_SPAWN_ID (THE UMBILICAL — bee coord identity)', async () => {
    // The voice-gap fix: the durable s-… spawnId is the child's stable coord owner.
    // It rides extraEnv.PAPERCUSP_SPAWN_ID so invoke()/spawn-mcp bakes it as the signed
    // MCP URL's client= param → resolveAgentIdentity attributes the bee's coord writes
    // to it instead of throwing "no attributable identity".
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'bee' });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(env.PAPERCUSP_SPAWN_ID).toBe(res.spawnId);
    expect(env.PAPERCUSP_SPAWN_ID).toMatch(/^s-\d+-/);
  });

  it('rejects when the workspace is at the running-spawn ceiling', async () => {
    const ceiling = spawnConcurrencyCeiling();
    runningCount = ceiling;
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain(`ceiling ${ceiling}`);
    expect(spawnInvokeOnce).not.toHaveBeenCalled();
  });
});
