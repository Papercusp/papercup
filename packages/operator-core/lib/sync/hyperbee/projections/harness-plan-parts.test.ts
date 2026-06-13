/**
 * Receive-side projection unit test (plan-federation-regrain P-006). In-memory
 * store + capturing recompose-sink + a flag stub — proves: a part op LWW-upserts
 * the part; the harness_plans recompose is FLAG-GATED (inert when OFF — the dark
 * guard); concurrent different-part ops merge into the recomposed content; a
 * malformed wire row is rejected.
 */
import { describe, it, expect } from 'vitest';
import { InMemoryPlanPartsStore } from '../../../plan-parts/store';
import { buildHarnessPlanPartsProjection, _testing, type PlanPartWireRow } from './harness-plan-parts';

function part(planSlug: string, partKey: string, body: string, overrides: Partial<PlanPartWireRow> = {}): PlanPartWireRow {
  return { harness_slug: 'h', plan_slug: planSlug, part_key: partKey, kind: 'item', body, ordinal: 0, tombstone: false, ...overrides };
}

function rig(flag: boolean) {
  const store = new InMemoryPlanPartsStore();
  const recomposed: Array<{ planSlug: string; content: string }> = [];
  const proj = buildHarnessPlanPartsProjection({
    workspaceId: 'ws',
    harnessSlug: 'h',
    store,
    isFlagOn: async () => flag,
    recomposeSink: async (planSlug, content) => { recomposed.push({ planSlug, content }); },
  });
  return { store, recomposed, proj };
}

describe('harness-plan-parts projection', () => {
  it('composeKey == plan_slug/part_key (matches part_fed_key)', () => {
    expect(_testing.composeKey(part('p1', 'item:P-001', 'x'))).toBe('p1/item:P-001');
  });

  it('rejects a malformed wire row', () => {
    expect(_testing.decodeValue({ plan_slug: 'p' })).toBeNull();
    expect(_testing.decodeValue(part('p', 'item:P-001', 'x'))).not.toBeNull();
  });

  it('FLAG OFF: upserts the part but does NOT recompose harness_plans (dark guard)', async () => {
    const { store, recomposed, proj } = rig(false);
    await proj.writeToPg(part('p1', 'item:P-001', 'a'), { authorPubkey: 'A', origin: 'remote', ts: 100 });
    expect((await store.getParts('p1')).get('item:P-001')?.text).toBe('a'); // part landed
    expect(recomposed).toEqual([]); // but harness_plans untouched
  });

  it('FLAG ON: recomposes harness_plans from merged parts; concurrent different parts both land', async () => {
    const { recomposed, proj } = rig(true);
    // Seed two parts so the recompose has structure.
    await proj.writeToPg(part('p1', 'section:now', '## Now\n\nbody'), { authorPubkey: 'seed', origin: 'remote', ts: 1 });
    await proj.writeToPg(part('p1', 'item:P-001', '- **P-001** `todo` one', { ordinal: 1 }), { authorPubkey: 'seed', origin: 'remote', ts: 1 });
    // Two concurrent edits to DIFFERENT parts (different keys).
    await proj.writeToPg(part('p1', 'item:P-001', '- **P-001** `done` ONE by A', { ordinal: 1 }), { authorPubkey: 'A', origin: 'remote', ts: 200 });
    await proj.writeToPg(part('p1', 'section:now', '## Now\n\nB EDIT'), { authorPubkey: 'B', origin: 'remote', ts: 201 });
    const last = recomposed.at(-1)!.content;
    expect(last).toContain('`done` ONE by A'); // A's part
    expect(last).toContain('B EDIT'); // B's part — both survive in the recompose
  });

  it('FLAG ON: same-key older op is dropped (LWW)', async () => {
    const { recomposed, proj } = rig(true);
    await proj.writeToPg(part('p1', 'item:P-001', 'new', { ordinal: 0 }), { authorPubkey: 'A', origin: 'remote', ts: 200 });
    await proj.writeToPg(part('p1', 'item:P-001', 'stale', { ordinal: 0 }), { authorPubkey: 'B', origin: 'remote', ts: 150 });
    expect(recomposed.at(-1)!.content).toContain('new');
    expect(recomposed.at(-1)!.content).not.toContain('stale');
  });

  it('drops a part for a foreign harness_slug', async () => {
    const { store, proj } = rig(true);
    await proj.writeToPg(part('p1', 'item:P-001', 'x', { harness_slug: 'other' }), { authorPubkey: 'A', origin: 'remote', ts: 100 });
    expect((await store.getParts('p1')).size).toBe(0);
  });
});
