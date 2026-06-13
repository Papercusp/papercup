/**
 * The two-peer merge GATE (plan-federation-regrain-2026-06-13 P-004): two
 * independent PlanPartsStores in one process (each = one machine's PG, sharing
 * NOTHING) prove that concurrent edits to DIFFERENT plan parts MERGE — the exact
 * case the live whole-document LWW silently clobbers today.
 */
import { describe, it, expect } from 'vitest';
import { InMemoryPlanPartsStore } from './store';
import { capturePlanParts, applyRemotePlanParts } from './federation';

const BASE = `---
title: Shared plan
slug: shared-2026-06-13
status: active
---

# Shared plan

## Now

**State:** baseline.

## Phase 1 — Work

- **P-001** \`todo\` first item.
- **P-002** \`todo\` second item.

## Decisions

### D-001 — A decision
Date: 2026-06-13
body.
`;

/** Sync two fresh stores to a shared baseline (A captures it, B applies A's ops). */
async function syncedPeers() {
  const A = new InMemoryPlanPartsStore();
  const B = new InMemoryPlanPartsStore();
  const seed = await capturePlanParts(A, 'shared-2026-06-13', BASE, 100, 'seed');
  await applyRemotePlanParts(B, 'shared-2026-06-13', seed);
  return { A, B };
}

describe('plan-parts federation — the two-peer merge gate', () => {
  it('concurrent edits to DIFFERENT items BOTH survive (the anti-clobber proof)', async () => {
    const { A, B } = await syncedPeers();
    const slug = 'shared-2026-06-13';

    // Peer A edits P-001 (ts 200); peer B concurrently edits P-002 (ts 201).
    const aEdit = BASE.replace('`todo` first item.', '`done` FIRST by A.');
    const bEdit = BASE.replace('`todo` second item.', '`wip` SECOND by B.');
    const opsA = await capturePlanParts(A, slug, aEdit, 200, 'A');
    const opsB = await capturePlanParts(B, slug, bEdit, 201, 'B');

    // Each captured ONLY its own changed item (not the whole doc).
    expect(opsA.map((o) => o.key)).toEqual(['item:P-001']);
    expect(opsB.map((o) => o.key)).toEqual(['item:P-002']);

    // Cross-apply (the federation exchange).
    const aFinal = await applyRemotePlanParts(A, slug, opsB);
    const bFinal = await applyRemotePlanParts(B, slug, opsA);

    // BOTH edits present on BOTH peers — whole-doc LWW would have lost one.
    for (const final of [aFinal, bFinal]) {
      expect(final).toContain('`done` FIRST by A.');
      expect(final).toContain('`wip` SECOND by B.');
      expect(final).toContain('### D-001 — A decision'); // untouched parts intact
    }
    // The peers CONVERGE byte-identically.
    expect(aFinal).toBe(bFinal);
  });

  it('converges regardless of apply order (commutative)', async () => {
    const slug = 'shared-2026-06-13';
    // Derive the two single-part ops from a throwaway pair at baseline.
    const src = await syncedPeers();
    const opsA = await capturePlanParts(src.A, slug, BASE.replace('`todo` first item.', '`done` A.'), 200, 'A');
    const opsB = await capturePlanParts(src.B, slug, BASE.replace('`todo` second item.', '`wip` B.'), 201, 'B');

    // Fresh baseline peer: apply A then B.
    const p1 = await syncedPeers();
    await applyRemotePlanParts(p1.A, slug, opsA);
    const r1 = await applyRemotePlanParts(p1.A, slug, opsB);

    // Fresh baseline peer: apply B then A.
    const p2 = await syncedPeers();
    await applyRemotePlanParts(p2.A, slug, opsB);
    const r2 = await applyRemotePlanParts(p2.A, slug, opsA);

    expect(r1).toBe(r2);
    expect(r1).toContain('`done` A.');
    expect(r1).toContain('`wip` B.');
  });

  it('same-item concurrent edit → LWW by fedTs (higher wins, deterministically)', async () => {
    const { A, B } = await syncedPeers();
    const slug = 'shared-2026-06-13';
    const aEdit = BASE.replace('`todo` first item.', '`done` A wins (ts 300).');
    const bEdit = BASE.replace('`todo` first item.', '`wip` B older (ts 250).');
    const opsA = await capturePlanParts(A, slug, aEdit, 300, 'A');
    const opsB = await capturePlanParts(B, slug, bEdit, 250, 'B');

    const aFinal = await applyRemotePlanParts(A, slug, opsB); // older B → dropped
    const bFinal = await applyRemotePlanParts(B, slug, opsA); // newer A → wins
    expect(aFinal).toContain('`done` A wins (ts 300).');
    expect(bFinal).toContain('`done` A wins (ts 300).');
    expect(aFinal).toBe(bFinal);
  });

  it('a removed item tombstones across peers', async () => {
    const { A, B } = await syncedPeers();
    const slug = 'shared-2026-06-13';
    const removed = BASE.replace('- **P-002** `todo` second item.\n', '');
    const ops = await capturePlanParts(A, slug, removed, 300, 'A');
    expect(ops.some((o) => o.key === 'item:P-002' && o.tombstone)).toBe(true);
    const bFinal = await applyRemotePlanParts(B, slug, ops);
    expect(bFinal).not.toContain('second item.');
    expect(bFinal).toContain('first item.'); // sibling intact
  });
});
