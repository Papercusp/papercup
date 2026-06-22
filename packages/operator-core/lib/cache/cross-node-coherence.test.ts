/**
 * cross-node-coherence.test.ts — caching-layer-tag-eca-2026-06-22 P-012.
 *
 * CROSS-NODE coherence: a change applied on one node must invalidate the dependent cache key
 * on another node. We model two "nodes" (two independent `Cache` instances, each with its own
 * L1) that SHARE one bumpable-generation store — the seam the host fills with a LISTEN/NOTIFY-fed,
 * PG-backed generation map. That shared store is what makes a tag bump on node A visible to a
 * read on node B: node B's entry was stamped with the pre-bump generation, so its next read sees
 * the higher current generation and rebuilds (lazy, no eager cross-node purge).
 *
 * The "remote/federated change applied locally" is modelled as: a change-stream event arrives,
 * the local handler maps it to the affected tag(s) and bumps them on the shared store. We assert
 * the dependent key is stale on the next read on the OTHER node, and that an UNRELATED tag's
 * entries stay fresh (the bump is scoped, not a global flush).
 */
import { describe, expect, it } from 'vitest';
import { Cache, InMemoryGenerationStore } from '@papercusp/cache';

const WS = 'fed-ws';

/**
 * A change-stream event as a remote node would emit it. The local handler turns it into the
 * tags to bump (here: the changed entity's id is its tag — the same convention the readiness
 * cache uses, where a node's id is a tag on every entry that depends on it).
 */
interface ChangeEvent {
  entityId: string;
}
function tagsForChange(ev: ChangeEvent): string[] {
  return [ev.entityId];
}

describe('P-012 cross-node coherence — shared generation store', () => {
  it('a change bumped on node A makes the dependent key stale on node B (next read rebuilds)', async () => {
    const shared = new InMemoryGenerationStore(); // the NOTIFY-fed / PG-backed seam, shared by both nodes
    const nodeA = new Cache({ generationStore: shared });
    const nodeB = new Cache({ generationStore: shared });

    // Both nodes warm the same logical entry (depends on entity "E"). Each has its OWN L1, so
    // the two builds are independent — but both stamp the generation from the shared store.
    let aBuilds = 0;
    let bBuilds = 0;
    const buildA = (): string => `A:v${++aBuilds}`;
    const buildB = (): string => `B:v${++bBuilds}`;
    expect(await nodeA.getOrSet(WS, 'view:E', buildA, { tags: ['E'] })).toBe('A:v1');
    expect(await nodeB.getOrSet(WS, 'view:E', buildB, { tags: ['E'] })).toBe('B:v1');

    // Both serve from L1 on a repeat read (no rebuild yet).
    expect(await nodeA.getOrSet(WS, 'view:E', buildA, { tags: ['E'] })).toBe('A:v1');
    expect(await nodeB.getOrSet(WS, 'view:E', buildB, { tags: ['E'] })).toBe('B:v1');
    expect(aBuilds).toBe(1);
    expect(bBuilds).toBe(1);

    // A remote/federated change to E arrives at node A's change-stream handler -> bump its tag.
    const ev: ChangeEvent = { entityId: 'E' };
    nodeA.invalidateByTags(WS, tagsForChange(ev));

    // Node B never saw the event directly — but it shares the generation store, so B's entry is
    // now stamped with a generation BELOW the current one and rebuilds on its next read.
    expect(await nodeB.getOrSet(WS, 'view:E', buildB, { tags: ['E'] })).toBe('B:v2');
    expect(bBuilds).toBe(2);
    // Node A likewise rebuilds (it issued the bump).
    expect(await nodeA.getOrSet(WS, 'view:E', buildA, { tags: ['E'] })).toBe('A:v2');
    expect(aBuilds).toBe(2);
  });

  it('the cross-node bump is SCOPED: an unrelated tag stays fresh on the other node', async () => {
    const shared = new InMemoryGenerationStore();
    const nodeA = new Cache({ generationStore: shared });
    const nodeB = new Cache({ generationStore: shared });

    let otherBuilds = 0;
    const buildOther = (): string => `other:v${++otherBuilds}`;
    await nodeB.getOrSet(WS, 'view:OTHER', buildOther, { tags: ['OTHER'] });

    // Change to E on node A.
    nodeA.invalidateByTags(WS, tagsForChange({ entityId: 'E' }));

    // Node B's unrelated entry (tag OTHER) is untouched.
    expect(await nodeB.getOrSet(WS, 'view:OTHER', buildOther, { tags: ['OTHER'] })).toBe('other:v1');
    expect(otherBuilds).toBe(1);
  });

  it('cross-node coherence respects workspace scoping (D-010): a bump in ws1 leaves ws2 fresh', async () => {
    const shared = new InMemoryGenerationStore();
    const nodeA = new Cache({ generationStore: shared });
    const nodeB = new Cache({ generationStore: shared });

    let ws2Builds = 0;
    const build2 = (): string => `ws2:v${++ws2Builds}`;
    await nodeB.getOrSet('ws2', 'view:E', build2, { tags: ['E'] });

    // Federated change to E in ws1 only.
    nodeA.invalidateByTags('ws1', tagsForChange({ entityId: 'E' }));

    // ws2's entry on node B is unaffected — generations are per (workspace, tag).
    expect(await nodeB.getOrSet('ws2', 'view:E', build2, { tags: ['E'] })).toBe('ws2:v1');
    expect(ws2Builds).toBe(1);
  });

  it('a bump that lands DURING node B’s in-flight build still marks the result stale (no masking)', async () => {
    const shared = new InMemoryGenerationStore();
    const nodeA = new Cache({ generationStore: shared });
    const nodeB = new Cache({ generationStore: shared });

    let resolveBuild!: (v: string) => void;
    const slow = new Promise<string>((res) => {
      resolveBuild = res;
    });
    let bBuilds = 0;
    // Node B starts building (generation snapshotted BEFORE the factory runs).
    const inflight = nodeB.getOrSet(
      WS,
      'view:E',
      () => {
        bBuilds++;
        return slow;
      },
      { tags: ['E'] },
    );

    // A federated change to E lands on node A while B is mid-build.
    nodeA.invalidateByTags(WS, tagsForChange({ entityId: 'E' }));
    resolveBuild('B:stale');
    expect(await inflight).toBe('B:stale');
    expect(bBuilds).toBe(1);

    // B's next read sees the bumped (shared) generation > its stamped one => rebuild, not masked.
    expect(await nodeB.getOrSet(WS, 'view:E', () => `B:fresh`, { tags: ['E'] })).toBe('B:fresh');
  });

  it('three nodes converge: one node’s change invalidates the same key on the other two', async () => {
    const shared = new InMemoryGenerationStore();
    const nodes = [0, 1, 2].map(() => new Cache({ generationStore: shared }));
    const builds = [0, 0, 0];
    const read = async (n: number, expected: string): Promise<void> => {
      const v = await nodes[n]!.getOrSet(WS, 'view:E', () => `n${n}:v${++builds[n]!}`, { tags: ['E'] });
      expect(v).toBe(expected);
    };
    await read(0, 'n0:v1');
    await read(1, 'n1:v1');
    await read(2, 'n2:v1');

    // Node 1 receives the federated change and bumps the shared tag.
    nodes[1]!.invalidateByTags(WS, tagsForChange({ entityId: 'E' }));

    // All three rebuild on their next read.
    await read(0, 'n0:v2');
    await read(1, 'n1:v2');
    await read(2, 'n2:v2');
  });
});
