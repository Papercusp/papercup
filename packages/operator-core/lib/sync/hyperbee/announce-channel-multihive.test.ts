import { describe, expect, it } from 'vitest';
import { ANNOUNCE_PROTOCOL, openAnnounceChannel } from './swarm';
import type { SignedAnnounce } from './announce';

/**
 * Announce-channel multi-harness demonstrator — covers BOTH:
 *
 * A-002 (different-topic hives on one instance): two HIVES sharing one muxer
 * must each get their own announce channel (discriminated by topic id), else the
 * 2nd hive's createChannel collides (→ null) and it never federates. Fixed by
 * keying the channel id + per-topic state by the 32-byte topic.
 *
 * A-003 (a′) (same-topic multi-harness): an instance may run MORE THAN ONE local
 * harness on the SAME hive topic (a hive's MEMBER harness + its HIVE-HOME harness,
 * so hive_members/hive_settings federate). They share ONE (protocol, topic)
 * channel, but it must carry EVERY local log's announce — pre-(a′) the 2nd
 * harness's createChannel collided on the same topic id (→ null) so its log was
 * never announced → the joiner never admitted it → hive_members/settings stalled.
 * Fixed by accumulating all local harnesses' announces per topic and flushing
 * each over the one channel.
 *
 * Faithful fake of protomux's (protocol, id)-keyed channel uniqueness (mirrors
 * protomux/index.js `toKey` + `createChannel({unique})`): a duplicate
 * (protocol, id) returns null; distinct ids open distinct channels. `open()`
 * fires `onopen` synchronously (models a paired remote). `Protomux.from(socket)`
 * returns the fake when pinned at `socket.userData` (isProtomux).
 *
 * TEETH: reverting the per-hive `id` flips the A-002 cases RED; reverting the
 * multi-log accumulation (1 announce per topic) flips the (a′) case RED — both
 * verified by neuter→run→restore.
 */

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

function makeFakeMux(fakeOpts: { firstCreateReturnsNull?: boolean } = {}) {
  const toKey = (protocol: string, id?: Buffer | null): string =>
    protocol + '##' + (id ? Buffer.from(id).toString('hex') : '');
  const channels = new Map<string, FakeChannel>();
  const pairs = new Map<string, (id: Buffer | null) => void>();
  const createAttempts = new Map<string, number>();
  const sent: { key: string; value: SignedAnnounce }[] = [];
  const mux = {
    isProtomux: true as const,
    createChannel(opts: {
      protocol: string;
      id?: Buffer | null;
      onopen?: () => void;
    }): FakeChannel | null {
      const key = toKey(opts.protocol, opts.id ?? null);
      const attempts = createAttempts.get(key) ?? 0;
      createAttempts.set(key, attempts + 1);
      if (fakeOpts.firstCreateReturnsNull && attempts === 0) return null;
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
          ch.onopen?.();
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
    _sent: sent,
    _channels: channels,
    _pairs: pairs,
    _notifyProtocolOpen(id: Buffer): void {
      pairs.get(toKey(ANNOUNCE_PROTOCOL, null))?.(id);
    },
    _key: toKey,
  };
  return mux;
}

describe('announce channel — A-002 (multi-hive) + A-003 (a′) multi-harness-per-topic', () => {
  const t1 = Buffer.alloc(32, 1);
  const t2 = Buffer.alloc(32, 2);

  it('A-002: two hives (different topics) on one muxer EACH open their channel + send their own announce', () => {
    const mux = makeFakeMux();
    const socket = { userData: mux };
    openAnnounceChannel(socket, t1, { ourAnnounce: announce('hive1') });
    openAnnounceChannel(socket, t2, { ourAnnounce: announce('hive2') });

    const sentKeys = mux._sent.map((s) => s.value.log_core_key);
    // Pre-A-002: hive2's createChannel collided on the protocol-only key → null →
    // hive2's announce never sent → ['hive1'] only.
    expect(sentKeys).toContain('hive1');
    expect(sentKeys).toContain('hive2');
    expect(mux._channels.size).toBe(2); // one channel per topic
    expect(mux._channels.has(mux._key(ANNOUNCE_PROTOCOL, t1))).toBe(true);
    expect(mux._channels.has(mux._key(ANNOUNCE_PROTOCOL, t2))).toBe(true);
  });

  it('A-002: inbound announces route to the OWNING hive (no opts overwrite)', () => {
    const mux = makeFakeMux();
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
    expect(ch1).toBeDefined();
    expect(ch2).toBeDefined();

    ch1?.onmessage?.(announce('inbound-for-hive1'));
    ch2?.onmessage?.(announce('inbound-for-hive2'));

    expect(h1).toEqual(['inbound-for-hive1']);
    expect(h2).toEqual(['inbound-for-hive2']);
    expect(mux._pairs.has(mux._key(ANNOUNCE_PROTOCOL, null))).toBe(true);
  });

  it('the SAME harness re-registered on one topic is de-duped (one channel, one announce)', () => {
    const mux = makeFakeMux();
    const socket = { userData: mux };
    openAnnounceChannel(socket, t1, { ourAnnounce: announce('hive1') });
    openAnnounceChannel(socket, t1, { ourAnnounce: announce('hive1') });
    expect(mux._channels.size).toBe(1);
    // sentKeys dedups by log_core_key → exactly one send.
    expect(mux._sent.map((s) => s.value.log_core_key)).toEqual(['hive1']);
  });

  it('A-003 (a′): TWO harnesses on the SAME topic both get announced on ONE channel', () => {
    const mux = makeFakeMux();
    const socket = { userData: mux };
    const memberInbound: string[] = [];
    // harness 1 — the MEMBER: announces its log + admits inbound.
    openAnnounceChannel(socket, t1, {
      ourAnnounce: announce('member-log'),
      onAnnounce: (f) => {
        memberInbound.push(f.log_core_key);
      },
    });
    // harness 2 — the HIVE-HOME, on the SAME topic: send-only (no onAnnounce).
    openAnnounceChannel(socket, t1, { ourAnnounce: announce('home-log') });

    const sentKeys = mux._sent.map((s) => s.value.log_core_key);
    // Pre-(a′): home-log's createChannel collided (same topic id → null) so the
    // hive-home log was NEVER announced → ['member-log'] only. With (a′): both.
    expect(sentKeys).toContain('member-log');
    expect(sentKeys).toContain('home-log');
    // ONE channel carries BOTH logs' announces (same (protocol, topic)).
    expect(mux._channels.size).toBe(1);

    // An inbound announce is delivered to the member (the admitting harness); the
    // send-only hive-home registered no onAnnounce so it never mis-admits.
    const ch = mux._channels.get(mux._key(ANNOUNCE_PROTOCOL, t1));
    ch?.onmessage?.(announce('remote-member'));
    expect(memberInbound).toEqual(['remote-member']);
  });

  it('lazy-accepts a late remote open through the protocol-level pair notifier', () => {
    const mux = makeFakeMux({ firstCreateReturnsNull: true });
    const socket = { userData: mux };

    openAnnounceChannel(socket, t1, { ourAnnounce: announce('late-accepted-log') });
    expect(mux._sent.map((s) => s.value.log_core_key)).toEqual([]);

    mux._notifyProtocolOpen(t1);

    expect(mux._sent.map((s) => s.value.log_core_key)).toEqual(['late-accepted-log']);
    expect(mux._channels.has(mux._key(ANNOUNCE_PROTOCOL, t1))).toBe(true);
  });
});
