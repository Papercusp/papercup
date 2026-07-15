/**
 * collision-matcher-io.test.ts — the P-004 collision-matcher live-leg WIRING
 * (ambient-semantic-push-2026-07-14): the mirror-push bridge + runCollisionTick's
 * read → fold → save → enqueue-BOTH-sides pipeline against MOCKED stores (no PG —
 * the end-to-end-vs-real-PG proof is the integration test). The hysteresis math
 * itself is covered by collision-hysteresis.test.ts; here we prove the live
 * plumbing: which rows get enqueued, to which owners, and the fail-soft contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mirrorCollisionPush, type CollisionEnteredNotice } from './collision-matcher-io';
import { collisionToPush, makePush } from './ambient-push';
import { buildCursor, type LexicalCursor } from './lexical-cursor';
import type { SessionCursorRow } from './session-cursor-store';
import type { EnqueuePushInput } from './push-delivery-store';
import type { SaveCollisionStateInput } from './collision-hysteresis-store';
import type { CollisionState } from './collision-hysteresis';

// A cursor row carrying a precomputed LexicalCursor the mocked rowToCursor returns
// (keeps the real inverted-index + overlap math in the loop, no DB).
type Row = SessionCursorRow & { __cursor: LexicalCursor };
function rowFor(sessionId: string, ownerId: string | null, note: string): Row {
  const cursor = buildCursor([note], { sessionId });
  return {
    session_id: sessionId,
    workspace_id: 'default',
    owner_id: ownerId,
    harness_slug: null,
    turn_ts: null,
    note_count: 1,
    term_count: cursor.terms.length,
    terms: cursor.terms,
    updated_at: new Date().toISOString(),
    __cursor: cursor,
  };
}

/** A carried state that is ONE above-enter tick away from the enter edge for
 *  `peer` (default enterDwell 3 ⇒ streak 2 → 3 enters on the next ≥-enter tick). */
function primedState(peer: string): CollisionState[] {
  return [{
    sessionId: peer,
    colliding: false,
    aboveEnterStreak: 2,
    belowExitStreak: 0,
    ticksSinceSeen: 0,
    lastScore: 1,
    lastSharedTerms: ['WI-9999'],
  }];
}

const NOTE = 'converging on WI-9999 in lexical-cursor.ts'; // shared → cosine 1.0

async function withMocks(opts: {
  selfRow?: Row | null;
  peerRows?: Row[];
  carry?: { tick: number; states: CollisionState[] };
  enqueueImpl?: () => Promise<number>;
}) {
  vi.resetModules();
  const enqueuePush = vi.fn<(input: EnqueuePushInput) => Promise<number>>(opts.enqueueImpl ?? (async () => 1));
  const saveCollisionState = vi.fn<(input: SaveCollisionStateInput) => Promise<void>>(async () => {});
  const loadCollisionState = vi.fn(async () => opts.carry ?? { tick: 0, states: [] as CollisionState[] });

  vi.doMock('./session-cursor-store', () => ({
    getSessionCursorRow: async () => opts.selfRow ?? null,
    recentSessionCursors: async () => opts.peerRows ?? [],
    rowToCursor: (row: Row) => row.__cursor,
  }));
  vi.doMock('./collision-hysteresis-store', () => ({
    loadCollisionState,
    saveCollisionState,
    pruneCollisionState: async () => 0,
  }));
  vi.doMock('./push-delivery-store', () => ({ enqueuePush }));

  const mod = await import('./collision-matcher-io');
  return { mod, enqueuePush, saveCollisionState, loadCollisionState };
}

describe('mirrorCollisionPush (pure)', () => {
  it('reverses a self→peer push into the peer→self push over the same shared terms', () => {
    const selfToPeer = collisionToPush({
      sessionId: 'su-peer',
      overlap: { score: 0.8, sharedTerms: [{ term: 'WI-9999' }, { term: 'cursor' }] },
    });
    const mirror = mirrorCollisionPush('su-self', selfToPeer);
    expect(mirror.handle.kind).toBe('session');
    expect(mirror.handle.ref).toBe('su-self'); // points back at self
    expect(mirror.sourceSessionId).toBe('su-self');
    expect(mirror.handle.query).toEqual(['WI-9999', 'cursor']); // same shared terms
    expect(mirror.score).toBe(0.8);
    expect(mirror.severity).toBe('critical'); // collision severity preserved
    expect(mirror.provenance).toBe('data-not-directive');
    expect(mirror.teaser).toContain('peer su-self converging');
  });

  it('tolerates a push with no query terms', () => {
    const p = makePush({ matcherKind: 'collision', handle: { kind: 'session', ref: 'su-peer', query: [] }, teaser: 't', score: 0.5 });
    const mirror = mirrorCollisionPush('su-self', p);
    expect(mirror.handle.ref).toBe('su-self');
    expect(mirror.handle.query).toEqual([]);
  });
});

describe('runCollisionTick — read → fold → save → enqueue both sides', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns ran:false and enqueues nothing when self has no cursor yet', async () => {
    const { mod, enqueuePush, saveCollisionState } = await withMocks({ selfRow: null });
    const r = await mod.runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });
    expect(r.ran).toBe(false);
    expect(enqueuePush).not.toHaveBeenCalled();
    expect(saveCollisionState).not.toHaveBeenCalled();
  });

  it('a single above-threshold tick from cold state does NOT enter (persists the streak, enqueues nothing)', async () => {
    const self = rowFor('su-self', 'own-self', NOTE);
    const peer = rowFor('su-peer', 'own-peer', NOTE);
    const { mod, enqueuePush, saveCollisionState } = await withMocks({ selfRow: self, peerRows: [peer] });
    const r = await mod.runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });
    expect(r.ran).toBe(true);
    expect(r.entered).toBe(0);
    expect(enqueuePush).not.toHaveBeenCalled();
    // streak persisted so a LATER tick can reach the enter edge.
    expect(saveCollisionState).toHaveBeenCalledTimes(1);
    expect(saveCollisionState.mock.calls[0]![0]).toMatchObject({ sessionId: 'su-self', tick: 1 });
  });

  it('on the ENTER edge, enqueues a push to BOTH sides (self→peer and peer→self)', async () => {
    const self = rowFor('su-self', 'own-self', NOTE);
    const peer = rowFor('su-peer', 'own-peer', NOTE);
    const { mod, enqueuePush, saveCollisionState } = await withMocks({
      selfRow: self,
      peerRows: [peer],
      carry: { tick: 9, states: primedState('su-peer') }, // streak 2 → 3 enters now
    });
    const r = await mod.runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });

    expect(r.entered).toBe(1);
    expect(r.enqueued).toBe(2);
    expect(enqueuePush).toHaveBeenCalledTimes(2);
    const calls = enqueuePush.mock.calls.map((c) => c[0]);
    // self's side: delivered to self's owner, handle points at the peer.
    const selfSide = calls.find((c) => c.targetOwnerId === 'own-self')!;
    expect(selfSide).toMatchObject({ targetOwnerId: 'own-self', targetSessionId: 'su-self', matcherKind: 'collision', handleRef: 'su-peer', sourceSessionId: 'su-peer' });
    expect(selfSide.handleQuery).toContain('WI-9999');
    // peer's side: delivered to the peer's owner, handle points back at self.
    const peerSide = calls.find((c) => c.targetOwnerId === 'own-peer')!;
    expect(peerSide).toMatchObject({ targetOwnerId: 'own-peer', targetSessionId: 'su-peer', matcherKind: 'collision', handleRef: 'su-self', sourceSessionId: 'su-self' });
    // next state saved at tick 10, peer now colliding.
    const saved = saveCollisionState.mock.calls[0]![0];
    expect(saved.tick).toBe(10);
    expect(saved.states.find((s) => s.sessionId === 'su-peer')!.colliding).toBe(true);
  });

  it('skips self side when self has no owner id (only the peer side enqueues)', async () => {
    const self = rowFor('su-self', null, NOTE);
    const peer = rowFor('su-peer', 'own-peer', NOTE);
    const { mod, enqueuePush } = await withMocks({
      selfRow: self,
      peerRows: [peer],
      carry: { tick: 0, states: primedState('su-peer') },
    });
    const r = await mod.runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: null });
    expect(r.enqueued).toBe(1);
    expect(enqueuePush).toHaveBeenCalledTimes(1);
    expect(enqueuePush.mock.calls[0]![0].targetOwnerId).toBe('own-peer');
  });

  it('skips the peer side when the peer has no owner id (only self side enqueues)', async () => {
    const self = rowFor('su-self', 'own-self', NOTE);
    const peer = rowFor('su-peer', null, NOTE);
    const { mod, enqueuePush } = await withMocks({
      selfRow: self,
      peerRows: [peer],
      carry: { tick: 0, states: primedState('su-peer') },
    });
    const r = await mod.runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });
    expect(r.enqueued).toBe(1);
    expect(enqueuePush).toHaveBeenCalledTimes(1);
    expect(enqueuePush.mock.calls[0]![0].targetOwnerId).toBe('own-self');
  });

  it('filters out a same-owner peer (a person\'s own other session is not a cross-agent collision)', async () => {
    const self = rowFor('su-self', 'own-shared', NOTE);
    const sameOwnerPeer = rowFor('su-peer', 'own-shared', NOTE); // SAME owner
    const { mod, enqueuePush } = await withMocks({
      selfRow: self,
      peerRows: [sameOwnerPeer],
      carry: { tick: 0, states: primedState('su-peer') },
    });
    const r = await mod.runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-shared' });
    // peer filtered from the index ⇒ no snapshot candidate ⇒ the primed streak
    // resets (peer unseen) and nothing enters/enqueues.
    expect(r.entered).toBe(0);
    expect(enqueuePush).not.toHaveBeenCalled();
  });

  it('fires the optional escalation hook on the enter edge (best-effort)', async () => {
    const self = rowFor('su-self', 'own-self', NOTE);
    const peer = rowFor('su-peer', 'own-peer', NOTE);
    const { mod } = await withMocks({
      selfRow: self,
      peerRows: [peer],
      carry: { tick: 0, states: primedState('su-peer') },
    });
    const onCollisionEntered = vi.fn<(n: CollisionEnteredNotice) => Promise<void>>(async () => {});
    await mod.runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self', onCollisionEntered });
    expect(onCollisionEntered).toHaveBeenCalledTimes(1);
    expect(onCollisionEntered.mock.calls[0]![0]).toMatchObject({ selfSessionId: 'su-self', peerSessionId: 'su-peer' });
  });

  it('boundedCollisionTick is fail-soft: an enqueue throw never breaks the turn', async () => {
    const self = rowFor('su-self', 'own-self', NOTE);
    const peer = rowFor('su-peer', 'own-peer', NOTE);
    const { mod } = await withMocks({
      selfRow: self,
      peerRows: [peer],
      carry: { tick: 0, states: primedState('su-peer') },
      enqueueImpl: async () => { throw new Error('pg down'); },
    });
    // runCollisionTick itself swallows a per-push enqueue throw (both sides skipped).
    const r = await mod.runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });
    expect(r.ran).toBe(true);
    expect(r.enqueued).toBe(0);
    // and the bounded wrapper degrades any deeper fault to the zero result.
    const b = await mod.boundedCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });
    expect(b.ran).toBe(true);
  });
});
