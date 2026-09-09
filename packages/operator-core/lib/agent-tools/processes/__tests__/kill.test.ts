/**
 * processes:kill — Tier 1 principal-bound tool that calls killProcess(), now a
 * bulk keyed-array tool (bulk-endpoint-standardization-2026-06-21 P-006).
 *
 * Tests stub the lib function to verify the tool projects each result correctly
 * (keyed by pid) and threads the principal slug + workspace into the call. n=1
 * `{ pid }` returns the SAME { ok, results:[…], counts } envelope as `{ pids:[…] }`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function parseEnvelope(result: { data?: any; content?: Array<{ text: string }> }): {
  ok: boolean;
  results: any[];
  counts: { ok: number; failed: number };
} {
  return result.data ?? JSON.parse(result.content![0].text);
}

const MAKE_PRINCIPAL_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    principal: {
      kind: 'system',
      slug: 'system:dev-page',
      workspaceId: 'default',
      capabilities: new Set(['processes:kill']),
      authMethod: 'process-internal',
      trust: 'trusted',
    },
    tx: null,
    ...over,
  }) as never;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../process-kill');
  vi.doUnmock('../../../task-manager/control');
});

// ── P-012 / D-009: the guidance must not advertise reach the tool lacks ──
//
// killProcess() only signals kinds in KILLABLE; anything else alive comes back
// `unsupported_kind`. The old guidance said "stop the runaway harness", which
// is precisely the vitest/tsc/gate case it CANNOT kill — and the three error
// codes mean three different things an agent must not conflate (a live process
// reported absent was EI-18698120633403217).
describe('processes:kill guidance matches what it can actually do', () => {
  it('enumerates exactly the KILLABLE kinds', async () => {
    const { default: tool } = await import('../kill');
    const { KILLABLE } = await import('../../../process-kill');
    const when = tool.guidance?.when ?? '';
    for (const kind of KILLABLE) {
      expect(when).toContain(kind);
    }
    // Protected-but-visible kinds must not read as killable.
    expect(when).not.toMatch(/paperclip|\bnext\b/);
  });

  it('does not advertise killing build/test jobs, and says where they go instead', async () => {
    const { default: tool } = await import('../kill');
    const notWhen = tool.guidance?.notWhen ?? '';
    expect(tool.guidance?.when ?? '').not.toMatch(/runaway harness/i);
    expect(notWhen).toMatch(/vitest|tsc|build/i);
    expect(notWhen).toContain('capability:bash');
  });

  it('routes canonical Hono hosts to the guarded restart control, not bare PID kill', async () => {
    const { default: tool } = await import('../kill');
    const description = tool.description ?? '';
    const notWhen = tool.guidance?.notWhen ?? '';
    expect(description).toContain('run.sh | omp | claude | codex');
    expect(description).toContain('exact argv[0]');
    expect(description).toContain('hono-host.ts');
    expect(notWhen).toContain('hono-host.ts');
    expect(notWhen).toContain('dev:restart');
    expect(notWhen).toContain('desktop-dev');
  });

  it('distinguishes the three failure modes in its returns doc', async () => {
    const { default: tool } = await import('../kill');
    const returns = tool.guidance?.returns ?? '';
    for (const code of ['pid_not_found', 'unsupported_kind', 'protected_kind']) {
      expect(returns).toContain(code);
    }
    // The specific false claim this replaced: absent vs. merely-invisible.
    expect(returns).toContain('EI-18698120633403217');
    expect(returns).toContain('termination is still pending');
    expect(returns).toContain('no retry');
    expect(returns).toContain('bounded `systemctl stop` fallback');
    expect(returns).toContain('only if that fallback and its re-probe still leave survivors');
    expect(returns).toContain('Explicit SIGKILL never invokes `stop`');
  });
});

describe('processes:kill (bulk keyed-array, P-006)', () => {
  it('runs independent task IDs concurrently within a bounded pool and preserves input order', async () => {
    let active = 0;
    let peak = 0;
    const killTask = vi.fn(async (taskId: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true as const, taskId, action: 'kill' };
    });
    vi.doMock('../../../task-manager/control', () => ({ killTask, killScopeUnit: vi.fn() }));
    const processKillModule = await import('../kill');
    const { default: tool, PROCESS_KILL_MAX_CONCURRENCY } = processKillModule;
    const taskIds = ['task-a', 'task-b', 'task-c', 'task-d', 'task-e', 'task-f'];

    const b = parseEnvelope((await tool.handler({ taskIds }, MAKE_PRINCIPAL_CTX())) as never);

    expect(peak).toBe(PROCESS_KILL_MAX_CONCURRENCY);
    expect(b.results.map((result) => result.taskId)).toEqual(taskIds);
    expect(b.counts).toEqual({ ok: taskIds.length, failed: 0 });
  });

  it('n=1 { pid }: passes pid + signal + actor + workspace through; one keyed result', async () => {
    const mock = vi.fn(async () => ({ ok: true, pid: 1234, kind: 'omp', signal: 'SIGTERM' }));
    vi.doMock('../../../process-kill', () => ({ killProcess: mock }));
    const { default: tool } = await import('../kill');
    const b = parseEnvelope((await tool.handler({ pid: 1234, signal: 'SIGTERM' }, MAKE_PRINCIPAL_CTX())) as never);
    expect(mock).toHaveBeenCalledWith({
      pid: 1234,
      signal: 'SIGTERM',
      actorSlug: 'system:dev-page',
      workspaceId: 'default',
    });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toEqual({ ok: true, pid: 1234, kind: 'omp', signal: 'SIGTERM' });
  });

  it("forwards a killProcess failure as that item's { ok:false, pid, error } (batch ok:true)", async () => {
    vi.doMock('../../../process-kill', () => ({
      killProcess: vi.fn(async () => ({
        ok: false,
        pid: 1234,
        kind: 'paperclip',
        error: 'protected_kind',
        detail: "kind 'paperclip' is in the protected list",
      })),
    }));
    const { default: tool } = await import('../kill');
    const b = parseEnvelope((await tool.handler({ pid: 1234 }, MAKE_PRINCIPAL_CTX())) as never);
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, pid: 1234, error: 'protected_kind' });
  });

  it('omitting signal lets killProcess default to SIGTERM', async () => {
    const mock = vi.fn(async () => ({ ok: true, pid: 1, kind: 'omp', signal: 'SIGTERM' }));
    vi.doMock('../../../process-kill', () => ({ killProcess: mock }));
    const { default: tool } = await import('../kill');
    await tool.handler({ pid: 1 }, MAKE_PRINCIPAL_CTX());
    expect(mock).toHaveBeenCalledWith({
      pid: 1,
      signal: undefined,
      actorSlug: 'system:dev-page',
      workspaceId: 'default',
    });
  });

  it('pids:[…] signals many, each result keyed by pid; one protected pid fails only itself', async () => {
    vi.doMock('../../../process-kill', () => ({
      killProcess: vi.fn(async ({ pid }: { pid: number }) =>
        pid === 99
          ? { ok: false, pid, kind: 'paperclip', error: 'protected_kind' }
          : { ok: true, pid, kind: 'omp', signal: 'SIGTERM' },
      ),
    }));
    const { default: tool } = await import('../kill');
    const b = parseEnvelope((await tool.handler({ pids: [10, 99, 20] }, MAKE_PRINCIPAL_CTX())) as never);
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r) => [r.pid, r.ok])).toEqual([
      [10, true],
      [99, false],
      [20, true],
    ]);
    expect(b.results[1].error).toBe('protected_kind');
  });

  it('accepts a live unaccounted scopeUnit and returns a keyed verified result', async () => {
    const mock = vi.fn(async (scopeUnit: string, opts: { signal?: string; escalateAfterMs?: number }) => ({
      ok: true,
      scopeUnit,
      action: 'kill',
      detail: `scope ${scopeUnit} verified empty`,
      opts,
    }));
    vi.doMock('../../../task-manager/control', () => ({ killTask: vi.fn(), killScopeUnit: mock }));
    const { default: tool } = await import('../kill');
    const b = parseEnvelope(
      (await tool.handler({ scopeUnit: 'pc-orphan123.scope', signal: 'SIGKILL' }, MAKE_PRINCIPAL_CTX())) as never,
    );
    expect(mock).toHaveBeenCalledWith('pc-orphan123.scope', {
      signal: 'SIGKILL',
      escalateAfterMs: undefined,
    });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, scopeUnit: 'pc-orphan123.scope' });
  });
});
