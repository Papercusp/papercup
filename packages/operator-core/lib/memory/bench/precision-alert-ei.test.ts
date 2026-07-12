/**
 * precision-alert-ei.test.ts — the recall-canary EI binding (EI-10047). The
 * shared escalator factory's own behavior (dedup, VITEST gate, resolve-all)
 * is exhaustively pinned by escalation/episodic-ei.test.ts; this thin wrapper
 * test only pins THIS binding's config wiring: the stable title, body
 * content, and that file/resolve correctly delegate through injected deps —
 * mirroring the convention set by replication-stall-ei.ts's binding.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileRecallDropEi,
  resolveRecallDropEi,
  recallDropEiTitle,
  MEMORY_RECALL_CANARY_TOPIC,
  _resetRecallDropEiForTests,
  type RecallAlertEiDeps,
  type RecallAlertEpisode,
} from './precision-alert-ei';
import type { RecallDropEvaluation } from './precision-alert';

const EVAL_DROP: RecallDropEvaluation = {
  alert: true,
  reason: 'baseline-drop',
  baseline: 0.82,
  latest: 0.1,
  delta: 0.72,
};

const EVAL_OK: RecallDropEvaluation = {
  alert: false,
  reason: 'ok',
  baseline: 0.82,
  latest: 0.8,
  delta: 0.02,
};

function episode(over: Partial<RecallAlertEpisode> = {}): RecallAlertEpisode {
  return { workspaceId: 'ws-1', backend: 'hybrid', rowId: 42, evaluation: EVAL_DROP, ...over };
}

function fakeDeps(open: Array<{ id: string; title: string }>) {
  const created: Array<{ title: string; body: string; severity: string; topics: string[] }> = [];
  const resolved: Array<{ id: string; note: string }> = [];
  const deps: RecallAlertEiDeps = {
    listOpenByTopic: async () => open,
    create: async (input) => {
      created.push({ title: input.title, body: input.body, severity: input.severity, topics: input.topics });
      return { id: 'EI-999' };
    },
    resolve: async (id, note) => {
      resolved.push({ id, note });
    },
  };
  return { deps, created, resolved };
}

describe('precision-alert-ei (recall canary EI binding)', () => {
  afterEach(() => {
    _resetRecallDropEiForTests();
  });

  it('the stable title keys ONLY on workspace — no numeric values (so re-filing the same regression dedupes)', () => {
    const t1 = recallDropEiTitle({ workspaceId: 'ws-1' });
    const t2 = recallDropEiTitle({ workspaceId: 'ws-1' });
    expect(t1).toBe(t2);
    expect(t1).toContain('ws-1');
    expect(t1).not.toMatch(/0\.\d/); // no floating-point metric baked into the dedup key
  });

  it('different workspaces get different titles (no cross-workspace dedup collision)', () => {
    expect(recallDropEiTitle({ workspaceId: 'ws-1' })).not.toBe(recallDropEiTitle({ workspaceId: 'ws-2' }));
  });

  it('files with the memory-recall-canary topic, major severity, and a body carrying the metrics', async () => {
    const { deps, created } = fakeDeps([]);
    const id = await fileRecallDropEi(episode(), deps);
    expect(id).toBe('EI-999');
    expect(created).toHaveLength(1);
    expect(created[0]!.topics).toEqual(expect.arrayContaining([MEMORY_RECALL_CANARY_TOPIC, 'memory', 'observability']));
    expect(created[0]!.severity).toBe('major');
    expect(created[0]!.body).toContain('ws-1');
    expect(created[0]!.body).toContain('0.100'); // latest
    expect(created[0]!.body).toContain('0.820'); // baseline
  });

  it('dedupes against an already-open EI for the same workspace', async () => {
    const { deps, created } = fakeDeps([{ id: 'EI-1', title: recallDropEiTitle({ workspaceId: 'ws-1' }) }]);
    const id = await fileRecallDropEi(episode(), deps);
    expect(id).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('resolves the open EI with a recovery note carrying the healthy numbers', async () => {
    const { deps, resolved } = fakeDeps([{ id: 'EI-1', title: recallDropEiTitle({ workspaceId: 'ws-1' }) }]);
    const ids = await resolveRecallDropEi(episode({ evaluation: EVAL_OK }), deps);
    expect(ids).toEqual(['EI-1']);
    expect(resolved[0]!.note).toContain('0.800');
    expect(resolved[0]!.note).toContain('0.820');
  });

  it('resolve no-ops when nothing is open for this workspace', async () => {
    const { deps, resolved } = fakeDeps([]);
    const ids = await resolveRecallDropEi(episode({ evaluation: EVAL_OK }), deps);
    expect(ids).toEqual([]);
    expect(resolved).toHaveLength(0);
  });

  it('the VITEST gate refuses to file/resolve against real PG when no deps are injected', async () => {
    expect(await fileRecallDropEi(episode())).toBeNull();
    expect(await resolveRecallDropEi(episode({ evaluation: EVAL_OK }))).toEqual([]);
  });
});
