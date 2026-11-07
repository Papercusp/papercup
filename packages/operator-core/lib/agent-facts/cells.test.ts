/**
 * cells.test.ts — the facts-as-watermark-surface delta (P-008 (c), D-012, D-077).
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-facts/cells.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FACTS_CELL_SURFACE, factsCellDelta, factCellKey, readFactBodyCursor, stageFactBodyDelivery,
  factBodyOffer, stageNativeFactBodyDelivery, confirmNativeFactBodyDelivery } from './cells';
import type { AgentFact } from './store';
import { configureReadCursorStore, InMemoryReadCursorStore, resetReadCursorStore } from '../agent-tools/coordination/read-cursors';

/** A minimal fact carrying just the fields this pure delta reads. */
function fact(key: string, cellVersion: string | null): AgentFact {
  return {
    scope: 'workspace',
    scopeRef: null,
    key,
    body: `body of ${key}`,
    sourceRef: null,
    audienceScope: null,
    sourceProvenance: null,
    confidence: null,
    kind: null,
    dependsOn: [],
    claim: null,
    enforcement: null,
    createdBy: 'su-test',
    updatedAt: '2026-07-27T00:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    cellVersion,
  };
}

// Real HLCs as stamped by migration 693's trigger — fixed-width ts, counter,
// node id — which is what makes a plain string compare a total order.
const V1 = '001785153418713:00000:2764ac50e15ec6af';
const V2 = '001785153419999:00000:2764ac50e15ec6af';
const V3 = '001785153420000:00001:2764ac50e15ec6af';

describe('FACTS_CELL_SURFACE', () => {
  it('is a stable key — it is persisted in agents\' watermarks, so renaming it silently resets every cursor', () => {
    expect(FACTS_CELL_SURFACE).toBe('facts');
  });
});

describe('factsCellDelta — bootstrap', () => {
  it('reports NOTHING changed on a first read, but records the position', () => {
    // The load-bearing choice: "everything is newer than nothing" is true and
    // useless. A fresh agent already received current state from the fold.
    const out = factsCellDelta([fact('a', V1), fact('b', V2)], '');
    expect(out.bootstrap).toBe(true);
    expect(out.changed).toEqual([]);
    expect(out.nextCursor).toBe(V2); // max, so the NEXT fold reports real movement
  });

  it('treats undefined / null / whitespace cursors as bootstrap', () => {
    for (const c of [undefined, null, '   ']) {
      expect(factsCellDelta([fact('a', V1)], c).bootstrap).toBe(true);
    }
  });

  it('a bootstrap over an empty fold leaves the cursor empty', () => {
    expect(factsCellDelta([], '')).toEqual({ changed: [], nextCursor: '', bootstrap: true });
  });
});

describe('factsCellDelta — steady state', () => {
  it('reports only facts strictly newer than the cursor', () => {
    const out = factsCellDelta([fact('old', V1), fact('new', V3)], V2);
    expect(out.bootstrap).toBe(false);
    expect(out.changed.map((f) => f.key)).toEqual(['new']);
    expect(out.nextCursor).toBe(V3);
  });

  it('is exclusive at the boundary — a fact AT the cursor is already held', () => {
    const out = factsCellDelta([fact('same', V2)], V2);
    expect(out.changed).toEqual([]);
    expect(out.nextCursor).toBe(V2);
  });

  it('nothing newer → cursor stands still', () => {
    expect(factsCellDelta([fact('old', V1)], V3).nextCursor).toBe(V3);
  });

  it('NEVER moves the cursor backward, even if the fold only returns older facts', () => {
    // Cursor regression would re-report facts the agent already acted on.
    expect(factsCellDelta([fact('a', V1), fact('b', V1)], V3).nextCursor).toBe(V3);
  });
});

describe('factsCellDelta — unversioned rows (pre-migration-693)', () => {
  it('never reports an unversioned fact as changed', () => {
    // It carries no version to compare; inventing one would be the local
    // counter D-012 forbids.
    const out = factsCellDelta([fact('legacy', null), fact('fresh', V3)], V1);
    expect(out.changed.map((f) => f.key)).toEqual(['fresh']);
  });

  it('unversioned facts do not disturb the cursor', () => {
    expect(factsCellDelta([fact('legacy', null)], V2).nextCursor).toBe(V2);
    expect(factsCellDelta([fact('legacy', null)], '').nextCursor).toBe('');
  });

  it('tolerates an empty-string version as unversioned', () => {
    expect(factsCellDelta([fact('weird', '')], V1).changed).toEqual([]);
  });
});

describe('factsCellDelta — ordering', () => {
  it('orders by the HLC counter when the wall-clock component ties', () => {
    // Two writes in the same millisecond are separated by the counter — the
    // reason an HLC is used rather than a bare timestamp.
    const tie1 = '001785153420000:00000:2764ac50e15ec6af';
    const tie2 = '001785153420000:00001:2764ac50e15ec6af';
    expect(factsCellDelta([fact('later', tie2)], tie1).changed.map((f) => f.key)).toEqual(['later']);
    expect(factsCellDelta([fact('earlier', tie1)], tie2).changed).toEqual([]);
  });
});

describe('fact body delivery proof', () => {
  const owner = 'fact-reader';
  const body = (f: AgentFact) => ({ scope: f.scope, ref: f.scopeRef, key: f.key, cellVersion: f.cellVersion, body: f.body });
  beforeEach(() => configureReadCursorStore(new InMemoryReadCursorStore()));
  afterEach(() => resetReadCursorStore());

  async function baseline() {
    const f = fact('baseline', V1);
    expect(await stageFactBodyDelivery(owner, [f], [body(f)], 'baseline')).toBe(1);
    return (await readFactBodyCursor(owner, 'baseline'))!;
  }

  it('confirms only final native body manifests and preserves omitted same/older-HLC peers', async () => {
    await baseline();
    const a = fact('a', V3), tied = fact('tied', V3), older = fact('older', V2);
    const offers = [a, tied, older].map(f => factBodyOffer(f)!);
    await stageNativeFactBodyDelivery(owner, offers, 'native');
    const cursor = await confirmNativeFactBodyDelivery(owner, 'native', [offers[0]]);
    expect(factsCellDelta([a, tied, older], cursor).changed).toEqual([tied, older]);
    expect(JSON.stringify(cursor)).not.toContain('body of');
  });

  it.each(['missing', 'wrong', 'key-only', 'shortened', 'different-key', 'old-version'])(
    'retains the floor for an unsupported or mismatched native receipt: %s', async mode => {
      const previous = await baseline();
      const f = fact('new', V3), offer = factBodyOffer(f)!;
      await stageNativeFactBodyDelivery(owner, [offer], 'native');
      const manifest = mode === 'key-only' ? [] : [{ ...offer,
        ...(mode === 'shortened' ? { bodyBytes: offer.bodyBytes - 1 } : {}),
        ...(mode === 'different-key' ? { key: 'other' } : {}),
        ...(mode === 'old-version' ? { cellVersion: V2 } : {}),
      }];
      const token = mode === 'missing' ? null : mode === 'wrong' ? 'old' : 'native';
      expect(await confirmNativeFactBodyDelivery(owner, token, manifest)).toEqual(previous);
      expect(factsCellDelta([f], previous).changed).toEqual([f]);
    },
  );

  it('binds a complete quoted multiline body and retains the committed floor across a replaced offer', async () => {
    const a = fact('a', V2); a.body = 'full "body"\nwith unicode ☃';
    const first = factBodyOffer(a)!;
    expect(first.rendered.split('\n')).toHaveLength(1);
    expect(first.bodyBytes).toBe(Buffer.byteLength(first.rendered));
    await stageNativeFactBodyDelivery(owner, [first], 'first');
    await confirmNativeFactBodyDelivery(owner, 'first', [first]);
    await stageNativeFactBodyDelivery(owner, [factBodyOffer(fact('a', V3))!], 'lost');
    await stageNativeFactBodyDelivery(owner, [factBodyOffer(fact('b', V3))!], 'replacement');
    const cursor = await confirmNativeFactBodyDelivery(owner, 'lost', [first]);
    expect(cursor?.versions[factCellKey(a)]).toBe(V2);
    expect(factsCellDelta([fact('a', V3), fact('b', V3)], cursor).changed).toHaveLength(2);
  });

  it('keeps bootstrap silent until the first body receipt is confirmed', async () => {
    const f = fact('a', V1);
    await stageFactBodyDelivery(owner, [f], [body(f)], 'offer');
    expect(await readFactBodyCursor(owner)).toBeNull();
    expect(factsCellDelta([f], null).changed).toEqual([]);
    await stageFactBodyDelivery(owner, [f], [body(f)], 'retry');
    expect((await readFactBodyCursor(owner, 'retry'))?.versions[factCellKey(f)]).toBe(V1);
  });

  it.each([null, 'wrong', 'baseline'])('retains the committed floor for missing/wrong/old proof %s', async token => {
    const previous = await baseline();
    const f = fact('a', V3);
    await stageFactBodyDelivery(owner, [f], [body(f)], 'new');
    expect(await readFactBodyCursor(owner, token)).toEqual(previous);
    expect(factsCellDelta([f], previous).changed).toEqual([f]);
  });

  it('confirms only the exact subset, retaining same-HLC and older omitted siblings', async () => {
    await baseline();
    const delivered = fact('delivered', V3), tied = fact('tied', V3), older = fact('older', V2);
    const all = [delivered, tied, older];
    expect(await stageFactBodyDelivery(owner, all, [body(delivered)], 'subset')).toBe(1);
    const cursor = await readFactBodyCursor(owner, 'subset');
    expect(factsCellDelta(all, cursor).changed).toEqual([tied, older]);
  });

  it.each(['dropped', 'shortened', 'key-only', 'budget-omitted'])(
    'does not stage a body from %s output', async mode => {
      const previous = await baseline();
      const f = fact('a', V3);
      const rows = mode === 'shortened' ? [{ ...body(f), body: 'body' }]
        : mode === 'key-only' ? [{ scope: f.scope, ref: f.scopeRef, key: f.key }]
          : [];
      expect(await stageFactBodyDelivery(owner, [f], rows as ReturnType<typeof body>[], 'absent')).toBe(0);
      expect(await readFactBodyCursor(owner, 'absent')).toEqual(previous);
    },
  );

  it('replacing pending retains committed cells and rejects the old offer token', async () => {
    const initial = await baseline();
    const a = fact('a', V2), b = fact('b', V3);
    await stageFactBodyDelivery(owner, [a], [body(a)], 'old');
    await stageFactBodyDelivery(owner, [b], [body(b)], 'new');
    expect(await readFactBodyCursor(owner, 'old')).toEqual(initial);
    await stageFactBodyDelivery(owner, [b], [body(b)], 'retry');
    const cursor = await readFactBodyCursor(owner, 'retry');
    expect(cursor?.versions).toEqual({ ...initial.versions, [factCellKey(b)]: V3 });
    expect(factsCellDelta([a, b], cursor).changed).toEqual([a]);
  });

  it('does not confuse equal keys across scopes or infer identity from body text', async () => {
    await baseline();
    const a = fact('same', V3), scoped = { ...a, scope: 'owner' as const, scopeRef: owner };
    await stageFactBodyDelivery(owner, [a, scoped], [body(a)], 'scoped');
    expect(factsCellDelta([a, scoped], await readFactBodyCursor(owner, 'scoped')).changed).toEqual([scoped]);
    const twin = { ...a, key: 'different' };
    const { key: _key, cellVersion: _version, ...unbound } = body(a);
    expect(await stageFactBodyDelivery(owner, [a, twin], [unbound] as ReturnType<typeof body>[], 'unbound')).toBe(0);
    expect(await stageFactBodyDelivery(owner, [a, twin], [body(a)], 'bound')).toBe(1);
    expect(await stageFactBodyDelivery(owner, [a, twin], [body(a), body(twin)], 'both')).toBe(2);
  });

  it('rejects a truncated body whose text equals a different fact body', async () => {
    const previous = await baseline();
    const long = { ...fact('long', V3), body: 'prefix with more text' };
    const short = { ...fact('short', V2), body: 'prefix' };
    expect(await stageFactBodyDelivery(owner, [long, short], [{ ...body(long), body: short.body }], 'shortened')).toBe(0);
    expect(await readFactBodyCursor(owner, 'shortened')).toEqual(previous);
    expect(await stageFactBodyDelivery(owner, [short], [{ ...body(short), cellVersion: V3 }], 'wrong-version')).toBe(0);
  });
});
