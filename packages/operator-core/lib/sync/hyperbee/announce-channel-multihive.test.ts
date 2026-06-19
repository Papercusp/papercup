import { describe, expect, it } from 'vitest';
import {
  ANNOUNCE_PROTOCOL,
  createAnnounceChannel,
  openAnnounceChannel,
} from './swarm';
import type { SignedAnnounce } from './announce';

/**
 * A-002 regression demonstrator — a 2nd hive on one instance must NOT stall the
 * 1st hive's federation.
 *
 * The defect: swarm.ts opened ONE announce channel per muxer, keyed by the
 * protocol ALONE. With two local hives sharing the singleton swarm's muxer, the
 * 2nd hive's `createChannel({protocol})` collided on that protocol-only key and
 * returned `null` (protomux `unique` semantics) → its signed-announce exchange
 * was silently dropped → that hive's log was never admitted → ZERO apply, both
 * directions, while `peer_connected` + topic-equal still looked healthy. The
 * lazy-accept opts WeakMap was likewise keyed by muxer alone, so the 2nd hive
 * also OVERWROTE the 1st hive's announce opts (last-writer-wins).
 *
 * The fix discriminates the announce channel PER HIVE by its 32-byte topic id:
 * `createChannel`/`pair` are keyed by `(protocol, id)`, so distinct topics get
 * distinct channels + distinct lazy-accept notifiers on one muxer, and the
 * per-hive opts no longer collide.
 *
 * These tests use a FAITHFUL fake of protomux's (protocol, id)-keyed channel
 * uniqueness — mirroring protomux/index.js `toKey(protocol, id)` +
 * `createChannel({unique})`: a duplicate `(protocol, id)` returns null, distinct
 * ids open distinct channels. `open()` fires `onopen` synchronously (models a
 * paired remote) so `ourAnnounce` is sent. TEETH: reverting the per-hive `id`
 * in swarm.ts (back to the protocol-only key) flips both tests RED — verified.
 */

// Minimal valid-SHAPE SignedAnnounce. swarm.ts does NOT verify the frame
// (verification happens later in onAnnounce → read-admission); it only routes
// it. `log_core_key` is the per-hive discriminator we assert on.
function announce(logCoreKey: string): SignedAnnounce {
  return {
    device_pubkey: 'AAAA',
    github_user_id: 1,
    github_login: 'tester',
    attestation_gist_id: 'gist',
    log_core_key: logCoreKey,
    ts: 0,
    sig: 'sig',
  };
}

interface FakeChannel {
  opened: boolean;
  onopen?: () => void;
  onmessage?: (frame: SignedAnnounce) => void;
  addMessage(opts: {
    encoding: unknown;
    onmessage: (f: SignedAnnounce) => void;
  }): { send(value: SignedAnnounce): void };
  open(): void;
}

/**
 * Faithful-enough fake of a protomux muxer — only the `(protocol, id)`-keyed
 * `createChannel` / `pair` surface swarm.ts touches. `isProtomux` makes
 * `Protomux.from(socket)` return it when pinned at `socket.userData`.
 */
function makeFakeMux() {
  const toKey = (protocol: string, id?: Buffer | null): string =>
    protocol + '##' + (id ? Buffer.from(id).toString('hex') : '');
  const channels = new Map<string, FakeChannel>();
  const pairs = new Map<string, (id: Buffer | null) => void>();
  const sent: { key: string; value: SignedAnnounce }[] = [];
  const mux = {
    isProtomux: true as const,
    createChannel(opts: {
      protocol: string;
      id?: Buffer | null;
      onopen?: () => void;
    }): FakeChannel | null {
      const key = toKey(opts.protocol, opts.id ?? null);
      const existing = channels.get(key);
      if (existing && existing.opened) return null; // protomux `unique` default
      const ch: FakeChannel = {
        opened: false,
        onopen: opts.onopen,
        addMessage(m) {
          ch.onmessage = m.onmessage;
          return { send: (value) => sent.push({ key, value }) };
        },
        open() {
          ch.opened = true;
          ch.onopen?.(); // models a paired remote → fires ourAnnounce send
        },
      };
      channels.set(key, ch);
      return ch;
    },
    pair(
      opts: { protocol: string; id?: Buffer | null },
      notify: (id: Buffer | null) => void,
    ): void {
      pairs.set(toKey(opts.protocol, opts.id ?? null), notify);
    },
    // — test introspection —
    _sent: sent,
    _channels: channels,
    _pairs: pairs,
    _key: toKey,
  };
  return mux;
}

type FakeMux = ReturnType<typeof makeFakeMux>;
const asMux = (m: FakeMux) =>
  m as unknown as Parameters<typeof createAnnounceChannel>[0];

describe('A-002 — multi-hive announce-channel discrimination', () => {
  const t1 = Buffer.alloc(32, 1); // hive-1 topic
  const t2 = Buffer.alloc(32, 2); // hive-2 topic

  it('two hives on one muxer EACH open their announce channel + send their own announce', () => {
    const mux = makeFakeMux();
    createAnnounceChannel(asMux(mux), t1, { ourAnnounce: announce('hive1') });
    createAnnounceChannel(asMux(mux), t2, { ourAnnounce: announce('hive2') });

    const sentKeys = mux._sent.map((s) => s.value.log_core_key);
    // Pre-fix: hive2's createChannel collided on the protocol-only key, returned
    // null, and its announce was never sent → ['hive1'] only (RED here).
    expect(sentKeys).toContain('hive1');
    expect(sentKeys).toContain('hive2');
    // Distinct channels — one per hive topic.
    expect(mux._channels.size).toBe(2);
    expect(mux._channels.has(mux._key(ANNOUNCE_PROTOCOL, t1))).toBe(true);
    expect(mux._channels.has(mux._key(ANNOUNCE_PROTOCOL, t2))).toBe(true);
  });

  it('the SAME hive twice on one muxer is still de-duped (one channel, one announce)', () => {
    const mux = makeFakeMux();
    createAnnounceChannel(asMux(mux), t1, { ourAnnounce: announce('hive1') });
    createAnnounceChannel(asMux(mux), t1, { ourAnnounce: announce('hive1') });
    // Same (protocol, id) → the 2nd is the intended no-op duplicate.
    expect(mux._channels.size).toBe(1);
    expect(mux._sent.map((s) => s.value.log_core_key)).toEqual(['hive1']);
  });

  it('inbound announces route to the OWNING hive (no opts overwrite) via openAnnounceChannel', () => {
    const mux = makeFakeMux();
    // One shared socket whose userData is our fake mux (Protomux.from returns it).
    const socket = { userData: mux };
    const h1: string[] = [];
    const h2: string[] = [];
    openAnnounceChannel(socket, t1, {
      ourAnnounce: announce('hive1'),
      onAnnounce: (f) => {
        h1.push(f.log_core_key);
      },
    });
    openAnnounceChannel(socket, t2, {
      ourAnnounce: announce('hive2'),
      onAnnounce: (f) => {
        h2.push(f.log_core_key);
      },
    });

    const ch1 = mux._channels.get(mux._key(ANNOUNCE_PROTOCOL, t1));
    const ch2 = mux._channels.get(mux._key(ANNOUNCE_PROTOCOL, t2));
    // Pre-fix: ch2 is undefined (collided → null) AND ch1's onmessage routed to
    // hive2's onAnnounce (last-writer-wins opts overwrite) → cross-wired/dropped.
    expect(ch1).toBeDefined();
    expect(ch2).toBeDefined();

    ch1?.onmessage?.(announce('inbound-for-hive1'));
    ch2?.onmessage?.(announce('inbound-for-hive2'));

    expect(h1).toEqual(['inbound-for-hive1']);
    expect(h2).toEqual(['inbound-for-hive2']);

    // Each hive registered its OWN id-keyed lazy-accept pair-notifier.
    expect(mux._pairs.has(mux._key(ANNOUNCE_PROTOCOL, t1))).toBe(true);
    expect(mux._pairs.has(mux._key(ANNOUNCE_PROTOCOL, t2))).toBe(true);
  });
});
