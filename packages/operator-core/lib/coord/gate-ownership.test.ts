/**
 * Unit tests for the PURE surface of gate-ownership.ts (P-004 /
 * `gate-ownership-condition-singleton-2026-08-03`).
 *
 * The read path is exercised through an injected `findConditionObjects`, so this
 * suite needs no database — the parts worth pinning are the event-key choice and
 * the fail-soft behavior, both of which are silent-failure-shaped if they rot.
 */
import { describe, it, expect } from 'vitest';
import {
  gateStallConditionKey,
  toCellOwnership,
  unownedCell,
  unmeasuredCell,
  ownershipContradicted,
  readGateOwnership,
} from './gate-ownership';
import type { ConditionObject } from './condition-object';

/** An injected presence oracle returning one verdict for one owner. */
function oracle(sessionState: string) {
  return (async (subjects: readonly { ownerId: string }[]) =>
    new Map(subjects.map((s) => [s.ownerId, { ownerId: s.ownerId, sessionState }]))) as never;
}

function mkObj(over: Partial<ConditionObject> = {}): ConditionObject {
  return {
    conditionKey: 'green-stall:papercusp',
    workItem: 'WI-1234',
    title: 'green-checkpoint STALLED',
    claimState: 'claimable',
    takenBy: null,
    takenAt: null,
    expiresAt: null,
    duplicates: [],
    ...over,
  };
}

describe('gateStallConditionKey', () => {
  // REGRESSION GUARD (D-012). `green-stall:` and `main-behind-staging:` both read
  // as "the pipeline is stalled" in English and are declared MUTUAL FALSIFIERS —
  // pointing the gate cell at the wrong one attaches ownership to the other cell's
  // incident, which no type would catch.
  it('is the green-checkpoint stall key, NOT the main-behind-staging key', () => {
    expect(gateStallConditionKey('papercusp')).toBe('green-stall:papercusp');
    expect(gateStallConditionKey('papercusp')).not.toContain('main-behind');
  });

  it('is slug-suffixed, so a non-default harness gets its own key', () => {
    expect(gateStallConditionKey('oddsmith')).toBe('green-stall:oddsmith');
  });
});

describe('toCellOwnership', () => {
  it('renames conditionKey to eventKey and carries the lease through', () => {
    const own = toCellOwnership(
      mkObj({ claimState: 'held', takenBy: 'su-abc', takenAt: 'T1', expiresAt: 'T2' }),
    );
    expect(own).toEqual({
      eventKey: 'green-stall:papercusp',
      workItem: 'WI-1234',
      claimState: 'held',
      unknown: null,
      takenBy: 'su-abc',
      takenAt: 'T1',
      expiresAt: 'T2',
      holderSessionState: null,
      duplicates: [],
    });
  });

  // The distinction that earns the enum: both states have a non-null takenBy, so a
  // caller null-testing takenBy reports a dead agent's abandoned lease as live
  // ownership — which suppresses the next agent from picking the work up.
  it('distinguishes held from lease-expired even though BOTH have a takenBy', () => {
    const held = toCellOwnership(mkObj({ claimState: 'held', takenBy: 'su-abc' }));
    const expired = toCellOwnership(mkObj({ claimState: 'lease-expired', takenBy: 'su-abc' }));
    expect(held.takenBy).toBe(expired.takenBy);
    expect(held.claimState).not.toBe(expired.claimState);
  });

  it('surfaces duplicates rather than hiding them behind the canonical row', () => {
    expect(toCellOwnership(mkObj({ duplicates: ['WI-2', 'WI-3'] })).duplicates).toEqual(['WI-2', 'WI-3']);
  });
});

describe('unownedCell', () => {
  it('is no-object with every lease field null', () => {
    expect(unownedCell('green-stall:x')).toEqual({
      eventKey: 'green-stall:x',
      workItem: null,
      claimState: 'no-object',
      takenBy: null,
      takenAt: null,
      expiresAt: null,
      duplicates: [],
    });
  });
});

describe('readGateOwnership', () => {
  it('resolves the harness key and projects the found object', async () => {
    const seen: string[][] = [];
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async (keys: readonly string[]) => {
        seen.push([...keys]);
        return new Map([['green-stall:papercusp', mkObj({ claimState: 'held', takenBy: 'su-x' })]]);
      }) as never,
    });
    expect(seen).toEqual([['green-stall:papercusp']]);
    expect(own.claimState).toBe('held');
    expect(own.eventKey).toBe('green-stall:papercusp');
  });

  it('returns no-object when the key resolves to nothing', async () => {
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () => new Map()) as never,
    });
    expect(own.claimState).toBe('no-object');
    expect(own.workItem).toBeNull();
  });

  // A cell must ALWAYS render. A throwing resolver must degrade to "no owner",
  // never propagate into the pipeline-position read.
  it('fails soft to no-object when the store is unreachable, never throws', async () => {
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () => {
        throw new Error('pg down');
      }) as never,
    });
    expect(own).toEqual(unownedCell('green-stall:papercusp'));
  });

  it('still names the eventKey when it cannot resolve ownership', async () => {
    const own = await readGateOwnership({
      harness: 'oddsmith',
      findConditionObjects: (async () => {
        throw new Error('pg down');
      }) as never,
    });
    // The key is knowable without the store — losing it would make a degraded read
    // indistinguishable from "this cell has no incident concept at all".
    expect(own.eventKey).toBe('green-stall:oddsmith');
  });
});
