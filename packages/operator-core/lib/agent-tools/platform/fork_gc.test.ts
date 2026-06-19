/**
 * fork_gc.test.ts — the platform:fork_gc HANDLER guards + delegation (the GC
 * itself, gcForksForUpstreams, is seam-injected + unit-tested in
 * lib/harness/fork-gc.test.ts). The two load-bearing guards:
 *   • ROOT-ONLY — a bee (source 'fleet-spawn') must be refused (it's the human's repo);
 *   • DRY-RUN BY DEFAULT — no confirm:true ⇒ the GC runs with dryRun:true (no delete).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/platform/fork_gc.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn() }));
vi.mock('../../harness/fork-gc', () => ({
  gcForksForUpstreams: vi.fn(),
  DEFAULT_FORK_RETENTION_MS: 2_592_000_000,
}));
vi.mock('../../hive/enable-platform-mode', () => ({
  PAPERCUSP_CANONICAL_REPO_URL: 'https://github.com/Papercusp/papercup.git',
}));

import { resolveAgentIdentity } from '../coordination/identity';
import { gcForksForUpstreams } from '../../harness/fork-gc';
const ident = vi.mocked(resolveAgentIdentity);
const gcM = vi.mocked(gcForksForUpstreams);
const tool = (await import('./fork_gc')).default;

type Out = { content: { text: string }[] };
const ctx = { workspaceId: 'ws-1', principal: { slug: 'avi', workspaceId: 'ws-1' } };
const call = (args: Record<string, unknown>) =>
  tool.handler({ reason: 'tidy forks for tests', ...args } as never, ctx as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  ident.mockReturnValue({ source: 'operator' } as never);
  gcM.mockResolvedValue({ evaluations: [], collected: [], wouldCollect: [], dryRun: true, errors: [] } as never);
});

describe('platform:fork_gc guards', () => {
  it('refuses a bee (fleet-spawn) — root-only — with no GC run', async () => {
    ident.mockReturnValue({ source: 'fleet-spawn' } as never);
    const b = body(await call({ confirm: true }));
    expect(b).toMatchObject({ ok: false, error: 'fork_gc_root_only' });
    expect(gcM).not.toHaveBeenCalled();
  });

  it('TEETH: defaults to a DRY RUN (no confirm ⇒ dryRun:true, never deletes)', async () => {
    await call({});
    expect(gcM).toHaveBeenCalledTimes(1);
    expect(gcM.mock.calls[0]![0]).toMatchObject({ dryRun: true });
  });

  it('confirm:true runs the destructive pass (dryRun:false)', async () => {
    await call({ confirm: true });
    expect(gcM.mock.calls[0]![0]).toMatchObject({ dryRun: false });
  });
});

describe('platform:fork_gc upstream resolution', () => {
  it('defaults to the canonical Papercusp repo when no upstreams given', async () => {
    await call({});
    expect(gcM.mock.calls[0]![0]!.upstreams).toEqual([{ owner: 'Papercusp', repo: 'papercup' }]);
  });

  it('passes explicit upstreams + retentionDays through', async () => {
    await call({ upstreams: [{ owner: 'X', repo: 'y' }], retentionDays: 7 });
    const arg = gcM.mock.calls[0]![0]!;
    expect(arg.upstreams).toEqual([{ owner: 'X', repo: 'y' }]);
    expect(arg.retentionMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('returns the GC report on success', async () => {
    gcM.mockResolvedValue({
      evaluations: [],
      collected: [],
      wouldCollect: ['alice/papercup'],
      dryRun: true,
      errors: [],
    } as never);
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: true, wouldCollect: ['alice/papercup'], dryRun: true });
  });
});
