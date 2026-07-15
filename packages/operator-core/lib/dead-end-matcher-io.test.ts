/**
 * dead-end-matcher-io.test.ts — the P-006 dead-end matcher live-leg WIRING
 * (ambient-semantic-push-2026-07-14): the read → fold-facts → match →
 * queued-dedup → enqueue-to-SELF pipeline against MOCKED stores (no PG — the
 * end-to-end-vs-real-PG proof is the integration test). The match math itself is
 * covered by dead-end-matcher.test.ts; here we prove the live plumbing: that the
 * fresh cursor + the in-scope dead-end facts produce a self-directed warning row,
 * to the right owner, with the fact as its handle — and the two contracts that
 * keep it from becoming Clippy (owner gate + queued-ref dedup) and fail-soft.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCursor } from './lexical-cursor';
import { factsToDeadEnds } from './dead-end-matcher-io';
import type { EnqueuePushInput } from './push-delivery-store';
import type { AgentFact, FactSelector } from './agent-facts/store';

// A note whose keywords (a WI id, a path/symbol, domain terms) give the cursor
// strong, legible join keys — mirrors the pure-core test's fixture.
const WORK_NOTE = 'debugging psu-launcher.mjs restart loop under compaction — WI-4790 advisory lock';

/** Minimal agent_facts row the fold returns (factsToDeadEnds only reads key+body). */
function factRow(key: string, body: string): AgentFact {
  return { key, body } as unknown as AgentFact;
}

async function withMocks(opts: {
  selfCursorNote?: string | null; // null ⇒ no cursor row yet
  facts?: AgentFact[];
  queued?: Set<string>;
  enqueueImpl?: () => Promise<number>;
}) {
  vi.resetModules();
  const enqueuePush = vi.fn<(input: EnqueuePushInput) => Promise<number>>(opts.enqueueImpl ?? (async () => 1));
  const queuedRefs = vi.fn<(owner: string, kind: string) => Promise<Set<string>>>(
    async () => opts.queued ?? new Set<string>(),
  );
  const foldDeadEndFacts = vi.fn<(selectors: FactSelector[], o?: unknown) => Promise<AgentFact[]>>(
    async () => opts.facts ?? [],
  );

  const hasCursor = opts.selfCursorNote != null;
  const cursor = buildCursor(hasCursor ? [opts.selfCursorNote!] : []);

  vi.doMock('./session-cursor-store', () => ({
    getSessionCursorRow: async () => (hasCursor ? ({ session_id: 'su-self' } as unknown) : null),
    rowToCursor: () => cursor,
  }));
  vi.doMock('./agent-facts/store', () => ({ foldDeadEndFacts }));
  vi.doMock('./push-delivery-store', () => ({ enqueuePush, queuedRefs }));

  const mod = await import('./dead-end-matcher-io');
  return { mod, enqueuePush, queuedRefs, foldDeadEndFacts };
}

describe('factsToDeadEnds (pure)', () => {
  it('maps a fact row onto the matcher shape: key→ref, body→note, kind fact', () => {
    const out = factsToDeadEnds([factRow('dead-end:launcher-wedge', WORK_NOTE)]);
    expect(out).toEqual([{ ref: 'dead-end:launcher-wedge', note: WORK_NOTE, kind: 'fact' }]);
  });

  it('skips rows the matcher would drop anyway (blank body / missing key)', () => {
    const out = factsToDeadEnds([
      factRow('dead-end:ok', WORK_NOTE),
      factRow('dead-end:blank', '   '),
      factRow('', WORK_NOTE),
    ]);
    expect(out.map((d) => d.ref)).toEqual(['dead-end:ok']);
  });
});

describe('runDeadEndTick — read → fold → match → enqueue to self', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns ran:false and folds nothing when self has no cursor yet', async () => {
    const { mod, enqueuePush, foldDeadEndFacts } = await withMocks({ selfCursorNote: null });
    const r = await mod.runDeadEndTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });
    expect(r.ran).toBe(false);
    expect(foldDeadEndFacts).not.toHaveBeenCalled(); // early-out before the fold
    expect(enqueuePush).not.toHaveBeenCalled();
  });

  it('enqueues a self-directed WARNING push, handle → the fact, when the cursor overlaps a dead end', async () => {
    const { mod, enqueuePush, queuedRefs } = await withMocks({
      selfCursorNote: WORK_NOTE,
      facts: [factRow('dead-end:launcher-wedge', WORK_NOTE)], // identical note ⇒ overlap ~1
    });
    const r = await mod.runDeadEndTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });

    expect(r.ran).toBe(true);
    expect(r.matched).toBe(1);
    expect(r.enqueued).toBe(1);
    expect(queuedRefs).toHaveBeenCalledTimes(1);
    expect(enqueuePush).toHaveBeenCalledTimes(1);
    const call = enqueuePush.mock.calls[0]![0];
    expect(call).toMatchObject({
      targetOwnerId: 'own-self',
      targetSessionId: 'su-self',
      matcherKind: 'dead-end',
      severity: 'warning', // dead-end severity (drones DO see warnings, D-004)
      handleKind: 'fact',
      handleRef: 'dead-end:launcher-wedge',
      sourceSessionId: null, // self's own recorded fact, not a peer's
    });
    expect(call.handleQuery).toContain('WI-4790'); // the legible "why" rides the re-pull query
    expect(call.teaser).toContain('documented dead-end');
  });

  it('folds the dead-end facts across workspace + owner + harness scopes', async () => {
    const { mod, foldDeadEndFacts } = await withMocks({
      selfCursorNote: WORK_NOTE,
      facts: [factRow('dead-end:x', WORK_NOTE)],
    });
    await mod.runDeadEndTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self', harnessSlug: 'papercusp' });
    const selectors = foldDeadEndFacts.mock.calls[0]![0];
    expect(selectors.map((s) => s.scope).sort()).toEqual(['harness', 'owner', 'workspace']);
    expect(selectors.find((s) => s.scope === 'owner')!.scopeRef).toBe('own-self');
    expect(selectors.find((s) => s.scope === 'harness')!.scopeRef).toBe('papercusp');
  });

  it('does not re-enqueue a dead end already QUEUED for this owner (stateless-matcher dedup)', async () => {
    const { mod, enqueuePush } = await withMocks({
      selfCursorNote: WORK_NOTE,
      facts: [factRow('dead-end:launcher-wedge', WORK_NOTE)],
      queued: new Set(['dead-end:launcher-wedge']), // already awaiting delivery
    });
    const r = await mod.runDeadEndTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });
    expect(r.matched).toBe(1);
    expect(r.enqueued).toBe(0);
    expect(enqueuePush).not.toHaveBeenCalled();
  });

  it('skips the enqueue (and the queued-ref read) when self has no owner id', async () => {
    const { mod, enqueuePush, queuedRefs } = await withMocks({
      selfCursorNote: WORK_NOTE,
      facts: [factRow('dead-end:launcher-wedge', WORK_NOTE)],
    });
    const r = await mod.runDeadEndTick({ selfSessionId: 'su-self', selfOwnerId: null });
    expect(r.matched).toBe(1); // the match is still computed
    expect(r.enqueued).toBe(0);
    expect(queuedRefs).not.toHaveBeenCalled();
    expect(enqueuePush).not.toHaveBeenCalled();
  });

  it('matches nothing for a dead-end fact the cursor shares no terms with', async () => {
    const { mod, enqueuePush } = await withMocks({
      selfCursorNote: WORK_NOTE,
      facts: [factRow('dead-end:mac', 'rotate the mac build VM sudo password quarterly')],
    });
    const r = await mod.runDeadEndTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });
    expect(r.matched).toBe(0);
    expect(r.enqueued).toBe(0);
    expect(enqueuePush).not.toHaveBeenCalled();
  });

  it('is fail-soft: an enqueue throw never breaks the tick, and the bounded wrapper degrades', async () => {
    const { mod, enqueuePush } = await withMocks({
      selfCursorNote: WORK_NOTE,
      facts: [factRow('dead-end:launcher-wedge', WORK_NOTE)],
      enqueueImpl: async () => {
        throw new Error('pg down');
      },
    });
    const r = await mod.runDeadEndTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });
    expect(r.ran).toBe(true);
    expect(r.enqueued).toBe(0); // the throw was swallowed
    expect(enqueuePush).toHaveBeenCalledTimes(1);

    const b = await mod.boundedDeadEndTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });
    expect(b.ran).toBe(true);
  });
});
