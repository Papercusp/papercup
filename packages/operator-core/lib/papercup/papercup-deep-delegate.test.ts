import { describe, expect, it, vi } from 'vitest';
import {
  buildDeepBrief,
  DEEP_MAX_CONCURRENT,
  DEEP_TIMEOUT_MS,
  delegateDeep,
  type DeepDelegateDeps,
} from './papercup-deep-delegate';

const WS = 'ws-test';

function makeDeps(over: Partial<DeepDelegateDeps> = {}): {
  deps: DeepDelegateDeps;
  spies: {
    countOpenDelegations: ReturnType<typeof vi.fn>;
    createWorkItem: ReturnType<typeof vi.fn>;
    spawn: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
  };
} {
  const countOpenDelegations = vi.fn(async () => 0);
  const createWorkItem = vi.fn(async () => ({ id: 'WI-301', harness: 'papercup' }));
  const spawn = vi.fn(async () => ({ ok: true, spawnId: 's-deep' }));
  const log = vi.fn();
  const deps: DeepDelegateDeps = {
    countOpenDelegations,
    createWorkItem,
    spawn,
    log,
    ...over,
  };
  return { deps, spies: { countOpenDelegations, createWorkItem, spawn, log } };
}

describe('buildDeepBrief', () => {
  it('includes the question, work item id, and completion contract', () => {
    const brief = buildDeepBrief('WI-301', 'Which migration path is safer?', 'Prefer rollback safety.');
    expect(brief).toContain('QUESTION: Which migration path is safer?');
    expect(brief).toContain("work_items:complete { id: 'WI-301'");
    expect(brief).toContain('Prefer rollback safety.');
  });
});

describe('delegateDeep', () => {
  it('creates the durable work item and spawns the deep-analysis agent', async () => {
    const { deps, spies } = makeDeps();
    const out = await delegateDeep(
      {
        question: 'Which migration path is safer?',
        brief: 'Prefer rollback safety.',
        harness: 'papercup',
        workspaceId: WS,
      },
      deps,
    );

    expect(out).toEqual({ ok: true, workItemId: 'WI-301', spawnId: 's-deep', spawned: true });
    expect(spies.createWorkItem).toHaveBeenCalledTimes(1);
    expect(spies.createWorkItem.mock.calls[0][0]).toMatchObject({
      assignee: expect.stringMatching(/^s-\d+-[0-9a-f]{8}$/),
      title: 'Deep dive: Which migration path is safer?',
      harness: 'papercup',
      workspaceId: WS,
    });
    expect(spies.spawn).toHaveBeenCalledTimes(1);
    expect(spies.spawn.mock.calls[0][0]).toMatchObject({
      spawnId: spies.createWorkItem.mock.calls[0][0].assignee,
      workItemId: 'WI-301',
      harness: 'papercup',
      timeoutMs: DEEP_TIMEOUT_MS,
    });
    expect(spies.spawn.mock.calls[0][0].brief).toContain("work_items:complete { id: 'WI-301'");
  });

  it('rejects when the deep lane is already at capacity', async () => {
    const { deps, spies } = makeDeps({
      countOpenDelegations: vi.fn(async () => DEEP_MAX_CONCURRENT),
    });
    const out = await delegateDeep(
      {
        question: 'Why is the CPU spiking?',
        workspaceId: WS,
      },
      deps,
    );

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected capacity rejection');
    expect(out.error).toContain('at capacity');
    expect(spies.createWorkItem).not.toHaveBeenCalled();
    expect(spies.spawn).not.toHaveBeenCalled();
  });

  it('keeps the durable item when the spawn fails', async () => {
    const { deps, spies } = makeDeps({
      spawn: vi.fn(async () => ({ ok: false, error: 'spawn failed' })),
    });
    const out = await delegateDeep(
      {
        question: 'Compare the tradeoffs.',
        workspaceId: WS,
      },
      deps,
    );

    expect(out).toEqual({ ok: true, workItemId: 'WI-301', spawnId: null, spawned: false });
    expect(spies.createWorkItem).toHaveBeenCalledTimes(1);
    expect(spies.log).toHaveBeenCalledWith(expect.stringContaining('deep-delegate spawn failed for WI-301'));
  });

  it('fails when the durable work item could not be created', async () => {
    const { deps, spies } = makeDeps({
      createWorkItem: vi.fn(async () => null),
    });
    const out = await delegateDeep(
      {
        question: 'Compare the tradeoffs.',
        workspaceId: WS,
      },
      deps,
    );

    expect(out).toEqual({ ok: false, error: 'work_item create failed' });
    expect(spies.spawn).not.toHaveBeenCalled();
  });

  it('rejects an empty question', async () => {
    const { deps, spies } = makeDeps();
    const out = await delegateDeep(
      {
        question: '   ',
        workspaceId: WS,
      },
      deps,
    );

    expect(out).toEqual({ ok: false, error: 'empty question' });
    expect(spies.createWorkItem).not.toHaveBeenCalled();
    expect(spies.spawn).not.toHaveBeenCalled();
  });
});
