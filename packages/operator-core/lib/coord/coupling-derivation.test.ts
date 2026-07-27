/**
 * coupling-derivation.test.ts — P-013's derived half (scoping ruling D-078).
 */
import { describe, expect, it } from 'vitest';

import { deriveCouplingsFromRoster } from './coupling-derivation';
import { resolveCoupledPeers } from './couplings';

const row = (o: Partial<Record<string, unknown>> & { ownerId: string }) => o;

describe('deriveCouplingsFromRoster', () => {
  it('couples peers in the same fleet, naming the fleet', () => {
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', fleetSlug: 'alpha' }),
      row({ ownerId: 'su-peer', fleetSlug: 'alpha' }),
      row({ ownerId: 'su-other', fleetSlug: 'beta' }),
    ]);
    expect(derived).toEqual([{ ownerId: 'su-peer', because: 'same fleet (alpha)' }]);
  });

  it('does NOT couple two agents that merely both have no fleet', () => {
    // A null fleet is an absence, not a shared property. Treating it as a signal
    // would couple every unfleeted agent to every other one — the block would be
    // noise on exactly the surface it is meant to make legible.
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', fleetSlug: null }),
      row({ ownerId: 'su-peer', fleetSlug: null }),
      row({ ownerId: 'su-blank', fleetSlug: '  ' }),
    ]);
    expect(derived).toEqual([]);
  });

  it('couples peers holding an overlapping file, naming it', () => {
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', currentFiles: ['a.ts', 'b.ts'] }),
      row({ ownerId: 'su-peer', currentFiles: ['b.ts', 'c.ts'] }),
      row({ ownerId: 'su-far', currentFiles: ['z.ts'] }),
    ]);
    expect(derived).toEqual([{ ownerId: 'su-peer', because: 'both working in b.ts' }]);
  });

  it('bounds how many overlapping files it names and summarises the rest', () => {
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', currentFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }),
      row({ ownerId: 'su-peer', currentFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }),
    ]);
    expect(derived).toEqual([
      { ownerId: 'su-peer', because: 'both working in a.ts, b.ts (+2 more shared files)' },
    ]);
  });

  it('couples peers parked on the SAME awaited event', () => {
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', awaitingEventKey: 'fleet:x:gate' }),
      row({ ownerId: 'su-peer', awaitingEventKey: 'fleet:x:gate' }),
      row({ ownerId: 'su-other', awaitingEventKey: 'fleet:y:gate' }),
    ]);
    expect(derived).toEqual([{ ownerId: 'su-peer', because: 'both awaiting fleet:x:gate' }]);
  });

  it('emits EVERY signal a peer trips, in a fixed order', () => {
    // The reason the derived channel carries reasons at all (D-078 (a)): the
    // interesting answer is that a peer is coupled three ways, not one.
    const derived = deriveCouplingsFromRoster('su-me', [
      row({
        ownerId: 'su-me',
        fleetSlug: 'alpha',
        currentFiles: ['x.ts'],
        awaitingEventKey: 'gate:1',
      }),
      row({
        ownerId: 'su-peer',
        fleetSlug: 'alpha',
        currentFiles: ['x.ts'],
        awaitingEventKey: 'gate:1',
      }),
    ]);
    expect(derived.map((d) => d.because)).toEqual([
      'same fleet (alpha)',
      'both working in x.ts',
      'both awaiting gate:1',
    ]);
  });

  it('never couples the caller to itself', () => {
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', fleetSlug: 'alpha', currentFiles: ['x.ts'] }),
    ]);
    expect(derived).toEqual([]);
  });

  it('returns empty when the caller has no row of its own', () => {
    // Nothing to compare against — a scope question, not a coupling question.
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-peer', fleetSlug: 'alpha' }),
    ]);
    expect(derived).toEqual([]);
  });

  it('is TOTAL over malformed rows — a bad row is skipped, never thrown on', () => {
    // A throwing derivation would take down coord:presence itself, which is far
    // worse than a missing expanded[] entry.
    expect(() =>
      deriveCouplingsFromRoster('su-me', [
        null,
        undefined,
        42,
        'nonsense',
        { ownerId: '' },
        { ownerId: 'su-me', fleetSlug: 'alpha', currentFiles: 'not-an-array' },
        { ownerId: 'su-peer', fleetSlug: 'alpha', currentFiles: [null, 7, 'x.ts'] },
      ]),
    ).not.toThrow();
    const derived = deriveCouplingsFromRoster('su-me', [
      { ownerId: 'su-me', fleetSlug: 'alpha', currentFiles: 'not-an-array' },
      { ownerId: 'su-peer', fleetSlug: 'alpha', currentFiles: [null, 7, 'x.ts'] },
    ]);
    expect(derived).toEqual([{ ownerId: 'su-peer', because: 'same fleet (alpha)' }]);
  });

  it('deduplicates a repeated ownerId — first row wins', () => {
    const derived = deriveCouplingsFromRoster('su-me', [
      row({ ownerId: 'su-me', fleetSlug: 'alpha' }),
      row({ ownerId: 'su-peer', fleetSlug: 'alpha' }),
      row({ ownerId: 'su-peer', fleetSlug: 'alpha' }),
    ]);
    expect(derived).toEqual([{ ownerId: 'su-peer', because: 'same fleet (alpha)' }]);
  });
});

describe('deriveCouplingsFromRoster ∘ resolveCoupledPeers — the union contract', () => {
  it('feeds the union so signals accumulate into one derivedBecause', () => {
    const rows = [
      row({ ownerId: 'su-me', fleetSlug: 'alpha', currentFiles: ['x.ts'] }),
      row({ ownerId: 'su-peer', fleetSlug: 'alpha', currentFiles: ['x.ts'] }),
    ];
    const peers = resolveCoupledPeers('su-me', deriveCouplingsFromRoster('su-me', rows), []);
    expect(peers).toEqual([
      {
        ownerId: 'su-peer',
        source: 'derived',
        derivedBecause: 'same fleet (alpha); both working in x.ts',
      },
    ]);
  });

  it('SUPPRESSION STILL WINS over a live derivation — the D-061 R4 property', () => {
    // The reason the derivation feeds the union instead of bypassing it. The
    // shared fleet is still real and this re-fires on every read, so if
    // suppression lost here the peer would silently return next tick and the
    // agent would rightly conclude decoupling is broken.
    const rows = [
      row({ ownerId: 'su-me', fleetSlug: 'alpha' }),
      row({ ownerId: 'su-peer', fleetSlug: 'alpha' }),
    ];
    const peers = resolveCoupledPeers('su-me', deriveCouplingsFromRoster('su-me', rows), [
      {
        agentA: 'su-me',
        agentB: 'su-peer',
        state: 'suppressed',
        declaredBy: 'su-me',
        reason: null,
        createdAt: '2026-07-27T00:00:00Z',
        updatedAt: '2026-07-27T00:00:00Z',
        expiresAt: null,
      },
    ]);
    expect(peers).toEqual([]);
  });
});
