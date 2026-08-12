import { describe, it, expect } from 'vitest';
import type { CarryBrief } from './carry-brief';
import {
  STALE_CHECKPOINT_WARN_MS,
  staleCheckpointWarnings,
  detectFlushTripwires,
  decideFlushGate,
  renderFlushRefusal,
} from './enforcement-gate';

const NOW = 1_800_000_000_000;

function brief(over: Partial<CarryBrief> = {}): CarryBrief {
  return {
    ownerId: 'su-test',
    loop: null,
    heldItems: [],
    directives: [],
    directivesTotalOpen: 0,
    walls: [],
    facts: [],
    awaits: [],
    fleet: null,
    ...over,
  };
}

function held(over: Partial<CarryBrief['heldItems'][number]> = {}): CarryBrief['heldItems'][number] {
  return { id: 'WI-1', title: 't', body: null, harness: 'papercusp', checkpoint: 'ok', checkpointUpdatedAtMs: NOW, ...over };
}

describe('staleCheckpointWarnings', () => {
  it('flags a missing checkpoint', () => {
    const w = staleCheckpointWarnings(brief({ heldItems: [held({ id: 'WI-9', checkpoint: null })] }), NOW);
    expect(w).toEqual([{ id: 'WI-9', title: 't', reason: 'missing' }]);
  });

  it('flags a checkpoint older than the stale window, with age minutes', () => {
    const old = NOW - (STALE_CHECKPOINT_WARN_MS + 5 * 60_000);
    const w = staleCheckpointWarnings(brief({ heldItems: [held({ checkpointUpdatedAtMs: old })] }), NOW);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ id: 'WI-1', reason: 'stale', ageMinutes: 20 });
  });

  it('does not flag a fresh checkpoint', () => {
    expect(staleCheckpointWarnings(brief({ heldItems: [held()] }), NOW)).toEqual([]);
  });

  it('returns [] for a null brief', () => {
    expect(staleCheckpointWarnings(null, NOW)).toEqual([]);
  });
});

describe('detectFlushTripwires', () => {
  it('is empty on a clean brief', () => {
    expect(detectFlushTripwires(brief({ heldItems: [held()] }), NOW)).toEqual([]);
  });

  it('emits missing- and stale-checkpoint tripwires', () => {
    const old = NOW - 2 * STALE_CHECKPOINT_WARN_MS;
    const t = detectFlushTripwires(
      brief({ heldItems: [held({ id: 'WI-A', checkpoint: null }), held({ id: 'WI-B', checkpointUpdatedAtMs: old })] }),
      NOW,
    );
    expect(t.map((x) => x.kind).sort()).toEqual(['missing-checkpoint', 'stale-checkpoint']);
    expect(t.find((x) => x.kind === 'missing-checkpoint')?.subject).toBe('WI-A');
  });

  it('emits armed-loop-no-carry-note when a COLD loop is active with no note', () => {
    const t = detectFlushTripwires(
      brief({ loop: { harness: 'papercusp', active: true, intervalSec: 60, carry: 'cold', goal: null, carryNote: '  ', carryNoteUpdatedAtMs: null } }),
      NOW,
    );
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: 'armed-loop-no-carry-note', subject: 'papercusp' });
  });

  it('does NOT flag an armed COLD loop that HAS a carry-note', () => {
    const t = detectFlushTripwires(
      brief({ loop: { harness: 'papercusp', active: true, intervalSec: 60, carry: 'cold', goal: null, carryNote: '## Next\ngo', carryNoteUpdatedAtMs: NOW } }),
      NOW,
    );
    expect(t).toEqual([]);
  });

  it('does NOT flag an armed WARM loop with no carry-note', () => {
    const t = detectFlushTripwires(
      brief({ loop: { harness: 'papercusp', active: true, intervalSec: 60, carry: 'warm', goal: null, carryNote: null, carryNoteUpdatedAtMs: null } }),
      NOW,
    );
    expect(t).toEqual([]);
  });

  it('does NOT flag an INACTIVE loop with no note', () => {
    const t = detectFlushTripwires(
      brief({ loop: { harness: 'papercusp', active: false, intervalSec: null, goal: null, carryNote: null, carryNoteUpdatedAtMs: null } }),
      NOW,
    );
    expect(t).toEqual([]);
  });
});

describe('decideFlushGate', () => {
  const tw = [{ kind: 'missing-checkpoint' as const, subject: 'WI-1', detail: 'x' }];
  it('clears when there are no tripwires', () => {
    expect(decideFlushGate({ tripwires: [], alreadyRefused: false })).toBe('clear');
    expect(decideFlushGate({ tripwires: [], alreadyRefused: true })).toBe('clear');
  });
  it('refuses on the first encounter with tripwires', () => {
    expect(decideFlushGate({ tripwires: tw, alreadyRefused: false })).toBe('refuse');
  });
  it('escalates to mechanical-fallback when already refused and still not flushed', () => {
    expect(decideFlushGate({ tripwires: tw, alreadyRefused: true })).toBe('mechanical-fallback');
  });
});

describe('renderFlushRefusal', () => {
  it('names the exact flush command per tripwire kind and the escape', () => {
    const text = renderFlushRefusal('compaction', [
      { kind: 'missing-checkpoint', subject: 'WI-1', detail: 'x' },
      { kind: 'stale-checkpoint', subject: 'WI-2', detail: 'x', ageMinutes: 40 },
      { kind: 'armed-loop-no-carry-note', subject: 'papercusp', detail: 'x' },
    ]);
    expect(text).toContain('Compaction is HELD');
    expect(text).toContain('work_items:checkpoint');
    expect(text).toContain('WI-1');
    expect(text).toContain('WI-2 (40m old)');
    expect(text).toContain('loop:checkpoint');
    expect(text).toContain('mechanical fallback');
  });

  it('labels the handoff boundary', () => {
    expect(renderFlushRefusal('handoff', [{ kind: 'missing-checkpoint', subject: 'WI-1', detail: 'x' }])).toContain(
      'This handoff is HELD',
    );
  });
});
