import { describe, it, expect, vi } from 'vitest';
import {
  gatherFleetSignals,
  escalationKind,
  dedupById,
  type FleetReaders,
} from './fleet-signals';
import type { FleetSignal } from './salience-policy';

const EMPTY: FleetReaders = {
  escalations: async () => [],
  blocked: async () => [],
  decisions: async () => [],
  completions: async () => [],
  progress: async () => [],
};

function readers(over: Partial<FleetReaders>): FleetReaders {
  return { ...EMPTY, ...over };
}

describe('escalationKind — severity split', () => {
  it('blocker → blocker, question → decision, else → escalation', () => {
    expect(escalationKind('blocker')).toBe('blocker');
    expect(escalationKind('question')).toBe('decision');
    expect(escalationKind('advisory')).toBe('escalation');
    expect(escalationKind(undefined)).toBe('escalation');
  });
});

describe('gatherFleetSignals — normalization', () => {
  it('splits escalations by severity into the right kinds, with a drill-in ref', async () => {
    const signals = await gatherFleetSignals(
      readers({
        escalations: async () => [
          { msgId: 'e1', severity: 'blocker', summary: 'build is wedged', ts: '2026-06-04T03:00:00Z' },
          { msgId: 'e2', severity: 'question', summary: 'which API?', ts: '2026-06-04T02:00:00Z' },
          { msgId: 'e3', severity: 'advisory', summary: 'fyi: slow', ts: '2026-06-04T01:00:00Z' },
        ],
      }),
    );
    const byId = new Map(signals.map((s) => [s.id, s]));
    expect(byId.get('escalation:e1')!.kind).toBe('blocker');
    expect(byId.get('escalation:e2')!.kind).toBe('decision');
    expect(byId.get('escalation:e3')!.kind).toBe('escalation');
    expect(byId.get('escalation:e1')!.ref).toBe('escalation:e1');
    expect(byId.get('escalation:e1')!.severity).toBe('blocker');
  });

  it('maps blocked items → blocker kind with the reason as detail', async () => {
    const signals = await gatherFleetSignals(
      readers({
        blocked: async () => [{ ref: 'plan#P-003', title: 'plan#P-003', reason: 'blocked by 2', harness: 'restart' }],
      }),
    );
    expect(signals[0]).toMatchObject({ id: 'blocked:plan#P-003', kind: 'blocker', detail: 'blocked by 2', harness: 'restart' });
    expect(signals[0].ref).toBe('wi:plan#P-003');
  });

  it('carries completion provenance (userRequested) through', async () => {
    const signals = await gatherFleetSignals(
      readers({
        completions: async () => [
          { workItemId: 'h#F-1', title: 'shipped F-1', userRequested: true, ts: '2026-06-04T00:00:00Z' },
          { workItemId: 'h#F-2', title: 'internal F-2', userRequested: false, ts: '2026-06-04T00:00:00Z' },
        ],
      }),
    );
    const byId = new Map(signals.map((s) => [s.id, s]));
    expect(byId.get('completion:h#F-1')!.userRequested).toBe(true);
    expect(byId.get('completion:h#F-2')!.userRequested).toBe(false);
  });

  it('maps decisions + progress', async () => {
    const signals = await gatherFleetSignals(
      readers({
        decisions: async () => [{ id: 'review:h#F-9', title: 'review F-9', ts: '2026-06-04T00:00:00Z', ref: 'wi:h#F-9' }],
        progress: async () => [{ id: 'plan-event:x', title: 'F-3 → validating', ts: '2026-06-04T00:00:00Z' }],
      }),
    );
    const kinds = new Map(signals.map((s) => [s.id, s.kind]));
    expect(kinds.get('decision:review:h#F-9')).toBe('decision');
    expect(kinds.get('progress:plan-event:x')).toBe('progress');
  });

  it('a throwing reader degrades to [] and never kills the gather', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const signals = await gatherFleetSignals(
      readers({
        escalations: async () => {
          throw new Error('coord down');
        },
        completions: async () => [{ workItemId: 'h#F-1', title: 'ok', userRequested: true, ts: '2026-06-04T00:00:00Z' }],
      }),
    );
    // The completion still came through despite escalations throwing.
    expect(signals.map((s) => s.id)).toContain('completion:h#F-1');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('sorts newest-first by ts', async () => {
    const signals = await gatherFleetSignals(
      readers({
        progress: async () => [
          { id: 'a', title: 'older', ts: '2026-06-04T01:00:00Z' },
          { id: 'b', title: 'newer', ts: '2026-06-04T05:00:00Z' },
        ],
      }),
    );
    expect(signals[0].id).toBe('progress:b');
  });
});

describe('dedupById', () => {
  it('keeps first occurrence of a duplicate id', () => {
    const xs: FleetSignal[] = [
      { id: 'x', kind: 'progress', title: 'first', ts: '1' },
      { id: 'x', kind: 'progress', title: 'second', ts: '2' },
      { id: 'y', kind: 'progress', title: 'y', ts: '3' },
    ];
    const out = dedupById(xs);
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.id === 'x')!.title).toBe('first');
  });
});
