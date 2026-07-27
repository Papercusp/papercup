/**
 * cells.test.ts — the facts-as-watermark-surface delta (P-008 (c), D-012, D-077).
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-facts/cells.test.ts
 */
import { describe, expect, it } from 'vitest';
import { FACTS_CELL_SURFACE, factsCellDelta } from './cells';
import type { AgentFact } from './store';

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
