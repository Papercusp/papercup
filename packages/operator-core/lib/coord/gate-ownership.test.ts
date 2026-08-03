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

describe('unownedCell vs unmeasuredCell', () => {
  it('unowned is a MEASURED no-object with no unknown attached', () => {
    expect(unownedCell('green-stall:x')).toEqual({
      eventKey: 'green-stall:x',
      workItem: null,
      claimState: 'no-object',
      unknown: null,
      takenBy: null,
      takenAt: null,
      expiresAt: null,
      holderSessionState: null,
      duplicates: [],
    });
  });

  // REGRESSION GUARD. P-004 shipped these as the SAME value, so an unreachable
  // store rendered as the reassuring "nobody owns this red — go file one".
  it('unmeasured is NOT no-object — a failed read never reads as an empty one', () => {
    const u = unmeasuredCell('green-stall:x', 'pg down');
    expect(u.claimState).toBeNull();
    expect(u.claimState).not.toBe('no-object');
    expect(u.unknown).toEqual({ code: 'resolver-failed', detail: 'pg down' });
  });
});

describe('ownershipContradicted (the P-005 falsifier verdict)', () => {
  it('fires when a HELD lease is contradicted by a dead holder', () => {
    const own = { ...toCellOwnership(mkObj({ claimState: 'held', takenBy: 'su-x' }), 'ended') };
    expect(ownershipContradicted(own)).toBe(true);
  });

  it('does NOT fire for a parked holder — parked is alive and will wake', () => {
    const own = { ...toCellOwnership(mkObj({ claimState: 'held', takenBy: 'su-x' }), 'parked') };
    expect(ownershipContradicted(own)).toBe(false);
  });

  it('does NOT fire when the oracle could not answer (null is no contradiction)', () => {
    const own = { ...toCellOwnership(mkObj({ claimState: 'held', takenBy: 'su-x' }), null) };
    expect(ownershipContradicted(own)).toBe(false);
  });

  it('does not fire for a lease that already expired — that is not a contradiction', () => {
    const own = { ...toCellOwnership(mkObj({ claimState: 'lease-expired', takenBy: 'su-x' }), 'ended') };
    expect(ownershipContradicted(own)).toBe(false);
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

  // A cell must ALWAYS render, but it must render UNMEASURED — never "no owner".
  it('degrades to UNMEASURED when the store is unreachable, never throws', async () => {
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () => {
        throw new Error('pg down');
      }) as never,
    });
    expect(own.claimState).toBeNull();
    expect(own.unknown?.code).toBe('resolver-failed');
    expect(own.eventKey).toBe('green-stall:papercusp');
  });

  it('resolves the holder liveness through the presence oracle when a holder exists', async () => {
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () =>
        new Map([['green-stall:papercusp', mkObj({ claimState: 'held', takenBy: 'su-dead' })]])) as never,
      resolveSessionStates: oracle('ended'),
    });
    expect(own.holderSessionState).toBe('ended');
    expect(ownershipContradicted(own)).toBe(true);
  });

  it('does NOT call the oracle when there is no holder to measure', async () => {
    let calls = 0;
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () =>
        new Map([['green-stall:papercusp', mkObj({ claimState: 'claimable', takenBy: null })]])) as never,
      resolveSessionStates: (async () => {
        calls += 1;
        return new Map();
      }) as never,
    });
    expect(calls).toBe(0);
    expect(own.holderSessionState).toBeNull();
  });

  // A failed falsifier leg must not invent liveness in EITHER direction: null
  // means "no contradiction established", never "the holder is alive".
  it('leaves holderSessionState null when the oracle throws, keeping the claim readable', async () => {
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () =>
        new Map([['green-stall:papercusp', mkObj({ claimState: 'held', takenBy: 'su-x' })]])) as never,
      resolveSessionStates: (async () => {
        throw new Error('oracle down');
      }) as never,
    });
    expect(own.claimState).toBe('held');
    expect(own.holderSessionState).toBeNull();
    expect(ownershipContradicted(own)).toBe(false);
  });
});
