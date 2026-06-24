/**
 * durable-spawn.test.ts — the reusable durable-spawn wrapper (P-010).
 *
 * DBOS is mocked: registerWorkflow returns the impl, WorkflowQueue is a real class
 * (it's `new`'d at import), startWorkflow is a spy we can make succeed or throw. We
 * assert the degrade-safe contract: `durableSpawnFire` returns true when it
 * enqueues a dedup-keyed durable workflow, and false (never throws) when DBOS is
 * off OR when the enqueue fails (e.g. called from inside another step) — so the
 * caller falls back to fire-and-forget.
 *
 * The spies + the DBOS-on flag live in `vi.hoisted` because the `vi.mock` factories
 * are hoisted above top-level declarations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  startWorkflow: vi.fn((_wf: unknown, _opts: unknown) => (_input: unknown) => Promise.resolve()),
  loopbackFetch: vi.fn(async (): Promise<{ ok: boolean; status: number; text?: () => Promise<string> }> => ({ ok: true, status: 200 })),
  recordSpawn: vi.fn(async (_sql: unknown, _input: Record<string, unknown>) => {}),
  finishSpawn: vi.fn(async (_sql: unknown, _input: Record<string, unknown>) => {}),
  state: { dbosOn: true },
  // P-006: deterministic gateway-throttle corroboration (a real probe would reach the live :8788
  // gateway and make these tests flake). false ⇒ a no-turn death classifies infra_loss (legacy);
  // flip to true to exercise the capacity_shed path.
  gatewayThrottled: { value: false },
}));

vi.mock('@dbos-inc/dbos-sdk', () => {
  class WorkflowQueue {
    constructor(public name: string, public opts?: unknown) {}
  }
  return {
    WorkflowQueue,
    DBOS: {
      runStep: (fn: () => unknown) => fn(),
      registerWorkflow: (impl: unknown) => impl,
      startWorkflow: h.startWorkflow,
    },
  };
});
vi.mock('./dbos-flags', () => ({ dbosOrchestratorActive: () => h.state.dbosOn }));
vi.mock('../loopback-fetch', () => ({ loopbackFetch: h.loopbackFetch }));
vi.mock('../fleet/spawn-tree', () => ({ recordSpawn: h.recordSpawn, finishSpawn: h.finishSpawn }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: {} }) }));
// P-006: the gateway-throttle probe is mocked so the capacity_shed vs infra_loss classification is
// deterministic (the real gatewayWholesaleThrottled would fetch the live :8788 gateway → flaky).
vi.mock('../inference-gateway/observability', () => ({
  gatewayWholesaleThrottled: vi.fn(async () => h.gatewayThrottled.value),
}));

import { durableSpawnFire, durableSpawnFireImpl, startDurableSpawns, isPermanentSpawnStatus } from './durable-spawn';

const INPUT = {
  url: 'http://x/api/harness/h/invoke?role=worker',
  body: { kickoff: 'go' },
  idempotencyKey: 'k1',
  label: 'h/worker',
};

beforeEach(() => {
  h.state.dbosOn = true;
  h.startWorkflow.mockReset();
  h.startWorkflow.mockImplementation((_wf, _opts) => (_input) => Promise.resolve());
  h.recordSpawn.mockClear();
  h.finishSpawn.mockClear();
  h.loopbackFetch.mockReset();
  h.loopbackFetch.mockImplementation(async () => ({ ok: true, status: 200 }));
  h.gatewayThrottled.value = false; // default: gateway healthy ⇒ a no-turn death is infra_loss
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('durableSpawnFire (P-010)', () => {
  it('returns false + does NOT enqueue when DBOS is off (caller fire-and-forgets)', async () => {
    h.state.dbosOn = false;
    const r = await durableSpawnFire(INPUT);
    expect(r).toBe(false);
    expect(h.startWorkflow).not.toHaveBeenCalled();
  });

  it('enqueues a dedup-keyed durable workflow + returns true when DBOS is on', async () => {
    const r = await durableSpawnFire(INPUT);
    expect(r).toBe(true);
    expect(h.startWorkflow).toHaveBeenCalledTimes(1);
    const opts = h.startWorkflow.mock.calls[0][1] as {
      workflowID: string;
      enqueueOptions: { deduplicationID: string };
    };
    expect(opts.workflowID).toBe('durable-spawn:k1');
    expect(opts.enqueueOptions.deduplicationID).toBe('durable-spawn:k1');
  });

  it('returns false (never throws) when the enqueue fails — e.g. called from inside a step', async () => {
    h.startWorkflow.mockImplementation(() => {
      throw new Error('cannot start a child workflow from inside a step');
    });
    await expect(durableSpawnFire(INPUT)).resolves.toBe(false);
  });
});

describe('startDurableSpawns (EI-403-A — the workflow-layer drain seam)', () => {
  const REQ2 = { url: 'http://x/api/harness/h/invoke?role=worker', body: { kickoff: 'b' }, idempotencyKey: 'k2', label: 'h/worker' };

  it('no-ops (0/0, no enqueue) on undefined or empty', async () => {
    expect(await startDurableSpawns(undefined)).toEqual({ enqueued: 0, total: 0 });
    expect(await startDurableSpawns([])).toEqual({ enqueued: 0, total: 0 });
    expect(h.startWorkflow).not.toHaveBeenCalled();
  });

  it('enqueues every request once and reports enqueued===total when DBOS is on', async () => {
    const res = await startDurableSpawns([INPUT, REQ2]);
    expect(res).toEqual({ enqueued: 2, total: 2 });
    expect(h.startWorkflow).toHaveBeenCalledTimes(2);
    const ids = h.startWorkflow.mock.calls.map((c) => (c[1] as { workflowID: string }).workflowID);
    expect(ids).toEqual(['durable-spawn:k1', 'durable-spawn:k2']);
  });

  it('tolerates declined fires (DBOS off ⇒ enqueued 0, total N, never throws)', async () => {
    h.state.dbosOn = false;
    const res = await startDurableSpawns([INPUT, REQ2]);
    expect(res).toEqual({ enqueued: 0, total: 2 });
    expect(h.startWorkflow).not.toHaveBeenCalled();
  });

  it('a single failed enqueue does not block the rest (partial enqueue count)', async () => {
    h.startWorkflow
      .mockImplementationOnce(() => {
        throw new Error('enqueue blip');
      })
      .mockImplementation((_wf, _opts) => (_input) => Promise.resolve());
    const res = await startDurableSpawns([INPUT, REQ2]);
    expect(res).toEqual({ enqueued: 1, total: 2 });
    expect(h.startWorkflow).toHaveBeenCalledTimes(2);
  });
});

// EI-403 round-2: the durable path used to write NO spawned_agents row, so the
// implement worker ran invisibly to fleet:tree (round 1's fire-and-forget fallback
// DID record it, via WI-108). The workflow body now records/finishes the row when a
// caller opts in via `spawnRecord` — these guard that behaviour AND its opt-in shape
// (hive launches, which record their own rows, must NOT double-count → omit it).
describe('durableSpawnFireImpl — fleet:tree visibility (EI-403 round-2)', () => {
  const IMPL = {
    url: 'http://x/api/harness/h/invoke?role=worker',
    body: { kickoff: 'go' },
    idempotencyKey: 'implement:EI-9:2',
    label: 'h/worker',
  };

  it('records a spawned_agents row (stable id) then finishes it `done` when spawnRecord is set', async () => {
    await durableSpawnFireImpl({
      ...IMPL,
      spawnRecord: { workspaceId: 'ws', harnessSlug: 'h', childRole: 'worker', itemId: 'EI-9' },
    });
    expect(h.recordSpawn).toHaveBeenCalledTimes(1);
    const rec = h.recordSpawn.mock.calls[0][1];
    // Stable spawn_id = the durable workflow id → idempotent across retry/recovery.
    expect(rec.spawnId).toBe('durable-spawn:implement:EI-9:2');
    expect(rec.runId).toBe('implement:EI-9:2');
    expect(rec.childRole).toBe('worker');
    expect(rec.parentRole).toBe('operator'); // parentless system launch
    expect(rec.itemId).toBe('EI-9');
    expect(rec.status).toBe('running');
    // The fire still happened.
    expect(h.loopbackFetch).toHaveBeenCalledTimes(1);
    // Closed out `done`.
    expect(h.finishSpawn).toHaveBeenCalledTimes(1);
    const fin = h.finishSpawn.mock.calls[0][1];
    expect(fin.spawnId).toBe('durable-spawn:implement:EI-9:2');
    expect(fin.status).toBe('done');
  });

  it('does NOT record when spawnRecord is omitted (hive launches own their rows)', async () => {
    await durableSpawnFireImpl(IMPL);
    expect(h.recordSpawn).not.toHaveBeenCalled();
    expect(h.finishSpawn).not.toHaveBeenCalled();
    expect(h.loopbackFetch).toHaveBeenCalledTimes(1);
  });

  it('marks the spawn `failed` (and rethrows) when the fire exhausts retries', async () => {
    h.loopbackFetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(
      durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'worker' } }),
    ).rejects.toThrow(/HTTP 503/);
    expect(h.recordSpawn).toHaveBeenCalledTimes(1);
    expect(h.finishSpawn).toHaveBeenCalledTimes(1);
    expect(h.finishSpawn.mock.calls[0][1].status).toBe('failed');
  });

  it('a recordSpawn failure never aborts the fire (best-effort bookkeeping)', async () => {
    h.recordSpawn.mockRejectedValueOnce(new Error('pg down'));
    await expect(
      durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'worker' } }),
    ).resolves.toBeUndefined();
    expect(h.loopbackFetch).toHaveBeenCalledTimes(1); // fired anyway
  });

  // D-007/D-010 fail-loud: HTTP 200 but the agent never produced a turn (host dead/unstable)
  // must be recorded `failed` (infra_loss marker), NOT silently `done`.
  const okBody = (b: Record<string, unknown>) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(b),
  });

  it('records `failed` + infra_loss when the fire returns 200 but the invoke body reports ok:false', async () => {
    h.loopbackFetch.mockResolvedValue(okBody({ ok: false, exitCode: 1, agentOutput: '', timedOut: false }));
    await expect(
      durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'queen' } }),
    ).resolves.toBeUndefined(); // infra_loss does NOT throw (no DBOS recovery storm)
    expect(h.loopbackFetch).toHaveBeenCalledTimes(1); // and does NOT retry the fire
    const fin = h.finishSpawn.mock.calls[0][1];
    expect(fin.status).toBe('failed');
    expect(String(fin.errorMessage)).toContain('infra_loss');
  });

  it('records `failed` + capacity_shed (RETRYABLE → THROWS) when a clean mid-turn exit-1 coincides with a wholesale-throttled gateway (P-006)', async () => {
    h.gatewayThrottled.value = true; // the gateway pool was all-throttled at death
    h.loopbackFetch.mockResolvedValue(okBody({ ok: false, exitCode: 1, agentOutput: 'partial turn', timedOut: false, stderr: '' }));
    // capacity_shed THROWS so the step-retry re-fires through the paced gateway — NOT a terminal phantom host death.
    await expect(
      durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'queen' } }),
    ).rejects.toThrow(/capacity_shed/);
    const fin = h.finishSpawn.mock.calls[0][1];
    expect(fin.status).toBe('failed');
    expect(String(fin.errorMessage)).toContain('capacity_shed');
    expect(String(fin.errorMessage)).not.toContain('host dead');
  });

  it('records `failed` + infra_loss (NOT capacity_shed) for a clean mid-turn exit-1 when the gateway is HEALTHY', async () => {
    h.gatewayThrottled.value = false; // gateway not throttled ⇒ a real host loss, terminal
    h.loopbackFetch.mockResolvedValue(okBody({ ok: false, exitCode: 1, agentOutput: 'partial turn', timedOut: false, stderr: '' }));
    await expect(
      durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'queen' } }),
    ).resolves.toBeUndefined(); // infra_loss does NOT throw
    expect(String(h.finishSpawn.mock.calls[0][1].errorMessage)).toContain('infra_loss');
  });

  it('records `failed` + infra_loss when 200 + ok:true but agentOutput is empty (0-token wake)', async () => {
    h.loopbackFetch.mockResolvedValue(okBody({ ok: true, exitCode: 0, agentOutput: '   ', timedOut: false }));
    await durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'queen' } });
    const fin = h.finishSpawn.mock.calls[0][1];
    expect(fin.status).toBe('failed');
    expect(String(fin.errorMessage)).toContain('infra_loss');
  });

  it('keeps `done` when the agent actually ran (ok:true + non-empty output) — no false positive', async () => {
    h.loopbackFetch.mockResolvedValue(okBody({ ok: true, exitCode: 0, agentOutput: 'DONE\nplaced 5 items', timedOut: false }));
    await durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'queen' } });
    expect(h.finishSpawn.mock.calls[0][1].status).toBe('done');
  });

  it('keeps `done` when the body is unparseable/unreadable (never flip on uncertainty)', async () => {
    h.loopbackFetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'not json' });
    await durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'queen' } });
    expect(h.finishSpawn.mock.calls[0][1].status).toBe('done');
  });
});

// A deleted harness 404s its /invoke route forever. The fire used to treat any
// non-2xx as transient → 3 step-retries AND a workflow ERROR that DBOS recovery
// re-ran (maxRecoveryAttempts), amplifying one dead-harness spawn into perpetual
// `→ HTTP 404` log spam on green. A 404/410 (target gone) is now terminal-but-
// not-thrown: the step succeeds (no retry, no recovery) and the workflow ends.
describe('durableSpawnFireImpl — permanent (target-gone) vs transient fire failure', () => {
  const IMPL = {
    url: 'http://x/api/harness/deleted-harness/invoke?role=queen',
    body: { kickoff: 'go' },
    idempotencyKey: 'q1',
    label: 'deleted-harness/queen',
  };

  it.each([404, 410])(
    'a %i (spawn target gone) does NOT throw — so DBOS recovery is not triggered — and warns once',
    async (status) => {
      h.loopbackFetch.mockResolvedValue({ ok: false, status });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(durableSpawnFireImpl(IMPL)).resolves.toBeUndefined();
      expect(h.loopbackFetch).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`HTTP ${status} (permanent`));
    },
  );

  it('a permanent failure marks the fleet:tree row `failed` (not `done`) without throwing', async () => {
    h.loopbackFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(
      durableSpawnFireImpl({ ...IMPL, spawnRecord: { workspaceId: 'ws', childRole: 'queen' } }),
    ).resolves.toBeUndefined();
    expect(h.finishSpawn).toHaveBeenCalledTimes(1);
    const fin = h.finishSpawn.mock.calls[0][1] as { status: string; errorMessage: string };
    expect(fin.status).toBe('failed');
    expect(String(fin.errorMessage)).toContain('permanent');
  });

  it.each([500, 502, 503, 429])(
    'a transient %i still THROWS (→ step-retry + DBOS recovery), unchanged',
    async (status) => {
      h.loopbackFetch.mockResolvedValue({ ok: false, status });
      await expect(durableSpawnFireImpl(IMPL)).rejects.toThrow(new RegExp(`HTTP ${status}`));
    },
  );

  it('captures the response body into the THROWN error for a transient failure (self-diagnosing)', async () => {
    h.loopbackFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '{"error":"gateway paused"}',
    });
    await expect(durableSpawnFireImpl(IMPL)).rejects.toThrow(
      /HTTP 503 — \{"error":"gateway paused"\}/,
    );
  });

  it('captures the response body into the permanent WARNING for a deterministic 4xx (self-diagnosing)', async () => {
    h.loopbackFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"unknown_workspace"}',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(durableSpawnFireImpl(IMPL)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 400 — {"error":"unknown_workspace"}'),
    );
  });
});

describe('isPermanentSpawnStatus (D1/WI-262 — deterministic 4xx are not retried)', () => {
  it('treats deterministic client/target errors as permanent (no retry storm)', () => {
    expect(isPermanentSpawnStatus(400)).toBe(true);  // unknown_workspace ("*") on durable replay
    expect(isPermanentSpawnStatus(404)).toBe(true);  // harness deleted
    expect(isPermanentSpawnStatus(410)).toBe(true);  // gone
    expect(isPermanentSpawnStatus(422)).toBe(true);  // unprocessable payload
  });
  it('keeps genuinely transient statuses retryable', () => {
    expect(isPermanentSpawnStatus(408)).toBe(false); // request timeout
    expect(isPermanentSpawnStatus(429)).toBe(false); // rate-limit / gateway pacing
    expect(isPermanentSpawnStatus(500)).toBe(false); // server error
    expect(isPermanentSpawnStatus(503)).toBe(false); // pacing pause / restart
  });
});
