/**
 * substrate-wake-wiring.test.ts — the adapter between the substrate-wake gossip
 * and the boot layer (P-012 slice B / WI-6071).
 *
 * The gossip itself is pinned by substrate-wake-gossip.test.ts and the boot-side
 * wake path by substrate-active-set-wiring.test.ts. This pins the seam between
 * them, whose load-bearing property is the ARM VERDICT: `arm` returns whether a
 * remote wake now covers the harness, and a caller that defers a federating
 * harness on a false verdict re-opens exactly the unheard-remote-push hole this
 * slice closes. So every path that cannot guarantee coverage must return false.
 *
 * Run: cd packages/operator-core && npx vitest run lib/sync/hyperbee/substrate-wake-wiring.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armSubstrateWakeKeepalive,
  mayDeferOnWakeVerdict,
  disarmSubstrateWakeKeepalive,
  announceSubstrateWakeActivity,
  substrateWakeKeepaliveStatus,
  closeSubstrateWakeKeepalive,
  _setSubstrateWakeGossipForTests,
  _resetSubstrateWakeWiringForTests,
} from './substrate-wake-wiring';
import type { SubstrateWakeGossipHandle } from './substrate-wake-gossip';
import { deriveSwarmTopic, type SwarmBinding } from './derive-swarm-topic';

const WS = 'ws-test';
const SLUG = 'hive-member';
const HIVE_PUBKEY = Buffer.alloc(32, 3).toString('base64');
const BINDING: SwarmBinding = { kind: 'hive', hive_pubkey: HIVE_PUBKEY };

/** A recording stand-in for the gossip family. */
function fakeGossip() {
  const watched = new Map<string, string>();
  const calls = { watch: [] as Array<{ key: string; topicHex: string }>, unwatch: [] as string[], announced: [] as string[], closed: 0 };
  const handle: SubstrateWakeGossipHandle = {
    watch(key, topic) {
      const topicHex = topic.toString('hex');
      watched.set(key, topicHex);
      calls.watch.push({ key, topicHex });
    },
    async unwatch(key) {
      watched.delete(key);
      calls.unwatch.push(key);
    },
    announceActivity(key) {
      calls.announced.push(key);
    },
    async close() {
      calls.closed += 1;
      watched.clear();
    },
    get watchedKeys() {
      return [...watched.keys()];
    },
    get topicCount() {
      return new Set(watched.values()).size;
    },
    topicHexFor: (key) => watched.get(key),
    openChannelCount: () => 0,
  };
  return { handle, calls, watched };
}

let g: ReturnType<typeof fakeGossip>;

beforeEach(() => {
  _resetSubstrateWakeWiringForTests();
  g = fakeGossip();
  _setSubstrateWakeGossipForTests(g.handle);
});

afterEach(() => {
  _resetSubstrateWakeWiringForTests();
  vi.restoreAllMocks();
});

describe('arm', () => {
  it('joins the topic derived from the harness binding, without booting anything', async () => {
    const verdict = await armSubstrateWakeKeepalive(WS, SLUG, {
      resolveSwarmBinding: () => BINDING,
    });
    expect(verdict).toBe('covered');
    expect(g.calls.watch).toHaveLength(1);
    expect(g.calls.watch[0].topicHex).toBe(deriveSwarmTopic(BINDING).toString('hex'));
  });

  it("returns 'not-needed' for a private / local-only harness (null binding) and watches nothing", async () => {
    // No topic, no peers — nothing to cover, and the outbox LISTEN already
    // handles its local writes. The verdict must still be false so a caller
    // never reads "armed" into it.
    const verdict = await armSubstrateWakeKeepalive(WS, SLUG, {
      resolveSwarmBinding: () => null,
    });
    expect(verdict).toBe('not-needed');
    expect(g.calls.watch).toHaveLength(0);
    expect(substrateWakeKeepaliveStatus().armed).toEqual([]);
  });

  it("returns 'uncovered', stays un-armed, and warns LOUDLY when the binding resolver throws", async () => {
    // The warn is the point: a federating harness left without remote-wake
    // coverage is the divergence risk, so it must never fail silently.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const verdict = await armSubstrateWakeKeepalive(WS, SLUG, {
      resolveSwarmBinding: () => {
        throw new Error('pg is down');
      },
    });
    expect(verdict).toBe('uncovered');
    expect(substrateWakeKeepaliveStatus().armed).toEqual([]);
    expect(g.calls.watch).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toMatch(/not covered by a remote wake/);
  });

  it("returns 'uncovered' when the binding is malformed enough that topic derivation throws", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const verdict = await armSubstrateWakeKeepalive(WS, SLUG, {
      resolveSwarmBinding: () => ({ kind: 'hive' }) as unknown as SwarmBinding,
    });
    expect(verdict).toBe('uncovered');
    expect(substrateWakeKeepaliveStatus().armed).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('awaits an async resolver', async () => {
    const verdict = await armSubstrateWakeKeepalive(WS, SLUG, {
      resolveSwarmBinding: async () => BINDING,
    });
    expect(verdict).toBe('covered');
  });

  it('the DEFER rule: only an uncovered federating harness must be booted', () => {
    // The regression this three-way verdict exists to prevent — a boolean here
    // either stops deferring private harnesses, or defers uncovered federating
    // ones. Both are wrong; pin the rule in one place.
    expect(mayDeferOnWakeVerdict('covered')).toBe(true);
    expect(mayDeferOnWakeVerdict('not-needed')).toBe(true);
    expect(mayDeferOnWakeVerdict('uncovered')).toBe(false);
  });

  it('is idempotent — re-arming the same harness does not double-register it', async () => {
    await armSubstrateWakeKeepalive(WS, SLUG, { resolveSwarmBinding: () => BINDING });
    await armSubstrateWakeKeepalive(WS, SLUG, { resolveSwarmBinding: () => BINDING });
    expect(substrateWakeKeepaliveStatus().armed).toEqual([
      { workspaceId: WS, harnessSlug: SLUG },
    ]);
    expect(g.handle.watchedKeys).toHaveLength(1);
  });

  it('two harnesses in the SAME hive share one topic', async () => {
    await armSubstrateWakeKeepalive(WS, 'a', { resolveSwarmBinding: () => BINDING });
    await armSubstrateWakeKeepalive(WS, 'b', { resolveSwarmBinding: () => BINDING });
    const status = substrateWakeKeepaliveStatus();
    expect(status.armed).toHaveLength(2);
    expect(status.topicCount).toBe(1);
  });

  it('keeps workspace+slug distinct rather than parsing a composite key back apart', async () => {
    // A slug containing the key separator must not collide with another harness.
    await armSubstrateWakeKeepalive(WS, 'a b', { resolveSwarmBinding: () => BINDING });
    await armSubstrateWakeKeepalive(`${WS} a`, 'b', { resolveSwarmBinding: () => BINDING });
    expect(substrateWakeKeepaliveStatus().armed).toHaveLength(2);
  });
});

describe('disarm', () => {
  it('leaves the topic once the real engine is resident', async () => {
    await armSubstrateWakeKeepalive(WS, SLUG, { resolveSwarmBinding: () => BINDING });
    await disarmSubstrateWakeKeepalive(WS, SLUG);
    expect(g.calls.unwatch).toHaveLength(1);
    expect(substrateWakeKeepaliveStatus().armed).toEqual([]);
  });

  it('is a no-op for a harness that was never armed', async () => {
    await disarmSubstrateWakeKeepalive(WS, 'never-armed');
    expect(g.calls.unwatch).toHaveLength(0);
  });

  it('is idempotent', async () => {
    await armSubstrateWakeKeepalive(WS, SLUG, { resolveSwarmBinding: () => BINDING });
    await disarmSubstrateWakeKeepalive(WS, SLUG);
    await disarmSubstrateWakeKeepalive(WS, SLUG);
    expect(g.calls.unwatch).toHaveLength(1);
  });

  it('survives a gossip that throws on unwatch, and still forgets the harness', async () => {
    await armSubstrateWakeKeepalive(WS, SLUG, { resolveSwarmBinding: () => BINDING });
    g.handle.unwatch = async () => {
      throw new Error('leave failed');
    };
    await expect(disarmSubstrateWakeKeepalive(WS, SLUG)).resolves.toBeUndefined();
    expect(substrateWakeKeepaliveStatus().armed).toEqual([]);
  });
});

describe('announce', () => {
  it('broadcasts on the armed harness key', async () => {
    await armSubstrateWakeKeepalive(WS, SLUG, { resolveSwarmBinding: () => BINDING });
    announceSubstrateWakeActivity(WS, SLUG);
    expect(g.calls.announced).toHaveLength(1);
  });

  it('is a silent no-op with no gossip started', async () => {
    _setSubstrateWakeGossipForTests(null);
    expect(() => announceSubstrateWakeActivity(WS, SLUG)).not.toThrow();
  });
});

describe('close', () => {
  it('tears down the family and clears the armed set, idempotently', async () => {
    await armSubstrateWakeKeepalive(WS, SLUG, { resolveSwarmBinding: () => BINDING });
    await closeSubstrateWakeKeepalive();
    expect(g.calls.closed).toBe(1);
    expect(substrateWakeKeepaliveStatus()).toEqual({ armed: [], topicCount: 0 });
    await expect(closeSubstrateWakeKeepalive()).resolves.toBeUndefined();
    expect(g.calls.closed).toBe(1);
  });
});
