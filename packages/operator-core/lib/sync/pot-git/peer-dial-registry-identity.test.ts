/**
 * P-203 Leg A live finding (two-machine rig, 2026-09-02): the pot-git hello
 * identity was seeded from the per-MUXER dial config, which every harness
 * sharing the connection overwrites in turn. The tower hosts harnesses under
 * TWO accounts, so its papercusp-topic hello went out as the aviynw device
 * (XPAsvso1) while its announcements were signed by the papercupai device
 * (IXfGu216). The VM filed the tower's socket under XPAsvso1, and every
 * VM→tower dial of IXfGu216 missed for 210+ minutes — while tower→VM worked,
 * because the VM hosts one identity.
 *
 * Two repairs, each with a control:
 *   1. the identity a topic's hello carries is the identity that WIRED THAT
 *      TOPIC, never "whoever wired the connection last" — exercised through a
 *      fake muxer whose `createChannel().open()` fires `onopen` synchronously,
 *      the exact ordering that latched the wrong hello on the rig;
 *   2. a hello that demonstrably went out under a different device than the
 *      channel's identity now is bypasses the first-send latch (register() and
 *      the heal sweep both re-send), while a matching or UNKNOWN sent-identity
 *      keeps the latch — the WI-5210 lost-hello contract is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./serve-wiring', () => ({
  openHiveGitFetchDuplex: vi.fn((socket: unknown) => ({ destroyed: false, socket })),
}));

const { _testing } = await import('./peer-dial-registry');

const TOPIC = Buffer.alloc(32, 9);
const TOPIC_HEX = TOPIC.toString('hex');
const OTHER_TOPIC = Buffer.alloc(32, 10);
const OTHER_TOPIC_HEX = OTHER_TOPIC.toString('hex');
/** The device that wired THIS topic (papercupai's IXfGu216 on the rig). */
const TOPIC_DEVICE = Buffer.alloc(32, 1).toString('base64');
/** A sibling harness's device that wired ANOTHER topic on the same connection
 *  last (aviynw's XPAsvso1 on the rig). */
const SIBLING_DEVICE = Buffer.alloc(32, 2).toString('base64');
const PEER_DEVICE = Buffer.alloc(32, 3).toString('base64');

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

/** A muxer whose channel opens SYNCHRONOUSLY inside `open()` — the peer's open
 *  was already pending, so protomux pairs on the spot. That is the ordering on
 *  the rig: `onopen` (and the first hello) ran inside `ensureChannel`, before
 *  `wireHiveGitDial`'s `register()` could apply the topic's own identity. */
function makeSyncOpenMux(): {
  mux: { stream: { destroyed: boolean }; createChannel: (o: { onopen: () => void }) => unknown };
  sent: Array<{ device_pubkey: string }>;
} {
  const sent: Array<{ device_pubkey: string }> = [];
  const mux = {
    stream: { destroyed: false },
    createChannel: (o: { onopen: () => void }) => ({
      addMessage: () => ({ send: (v: { device_pubkey: string }) => sent.push(v) }),
      open: () => o.onopen(),
    }),
  };
  return { mux, sent };
}

function seedMuxerConfig(mux: object, lastWirer: string, topics: string[]): void {
  _testing.dialConfigByMuxer.set(mux, {
    selfDevicePubkeyBase64: lastWirer,
    sign: () => Buffer.alloc(64, 4),
    socket: { id: 'live-socket' },
    topics: new Set(topics),
    retries: new Map(),
  });
}

beforeEach(() => {
  _testing.reset();
});

describe('per-topic hello identity (repair 1)', () => {
  it('a channel materialized under a stale muxer config still greets as the device that WIRED THE TOPIC', async () => {
    const { mux, sent } = makeSyncOpenMux();
    // The sibling harness wired its own topic LAST, so the muxer config now
    // says SIBLING_DEVICE — exactly the tower's state when the VM's open for
    // the papercusp topic paired.
    seedMuxerConfig(mux, SIBLING_DEVICE, [TOPIC_HEX, OTHER_TOPIC_HEX]);
    _testing.wiredTopics.set(TOPIC_HEX, TOPIC);
    _testing.wiredTopicIdentity.set(TOPIC_HEX, {
      selfDevicePubkeyBase64: TOPIC_DEVICE,
      sign: () => Buffer.alloc(64, 5),
    });

    const state = _testing.ensureChannel(mux as never, TOPIC);
    await settle();

    expect(state.opened).toBe(true);
    expect(sent.map((v) => v.device_pubkey)).toEqual([TOPIC_DEVICE]);
    expect(state.helloSentAs).toBe(TOPIC_DEVICE);
  });

  it('CONTROL: a topic this box never explicitly wired falls back to the muxer config (pre-fix behaviour, unchanged)', async () => {
    const { mux, sent } = makeSyncOpenMux();
    seedMuxerConfig(mux, SIBLING_DEVICE, [OTHER_TOPIC_HEX]);
    // No wiredTopicIdentity for OTHER_TOPIC — only the muxer-level gate admits it.
    const state = _testing.ensureChannel(mux as never, OTHER_TOPIC);
    await settle();
    expect(state.opened).toBe(true);
    expect(sent.map((v) => v.device_pubkey)).toEqual([SIBLING_DEVICE]);
  });

  it('a remote-chosen topic nobody here wired is still never signed for (the WI-5210 gate holds)', async () => {
    const { mux, sent } = makeSyncOpenMux();
    seedMuxerConfig(mux, SIBLING_DEVICE, [OTHER_TOPIC_HEX]);
    const foreign = Buffer.alloc(32, 11);
    const state = _testing.ensureChannel(mux as never, foreign);
    await settle();
    expect(state.opened).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe('stale sent-identity bypasses the first-send latch (repair 2)', () => {
  function openChannelThatGreetedAs(
    mux: object,
    greetedAs: string | null,
    nowSelf: string,
    remote: string | null,
  ): { state: ReturnType<typeof _testing.newState>; sent: Array<{ device_pubkey: string }> } {
    const sent: Array<{ device_pubkey: string }> = [];
    const state = _testing.newState();
    state.opened = true;
    state.selfDevicePubkeyBase64 = nowSelf;
    state.sign = () => Buffer.alloc(64, 6);
    state.hello = { send: (v: { device_pubkey: string }) => sent.push(v) };
    state.helloSent = true;
    state.helloSentAs = greetedAs;
    state.remoteDevicePubkey = remote;
    state.localSocket = { id: 'live-socket' };
    _testing.statesFor(mux).set(TOPIC_HEX, state);
    _testing.wiredTopics.set(TOPIC_HEX, TOPIC);
    _testing.trackedMuxers.add(mux as never);
    return { state, sent };
  }

  it('register() applying the topic identity after a wrong-device hello RE-SENDS under the right one', async () => {
    const mux = { stream: { destroyed: false } };
    const { state, sent } = openChannelThatGreetedAs(mux, SIBLING_DEVICE, TOPIC_DEVICE, PEER_DEVICE);
    // No `resend` flag — this is the plain register() call path.
    _testing.maybeSendHello(state, TOPIC);
    await settle();
    expect(sent.map((v) => v.device_pubkey)).toEqual([TOPIC_DEVICE]);
    expect(state.helloSentAs).toBe(TOPIC_DEVICE);
  });

  it('CONTROL: a hello already sent as the current identity keeps the latch (no duplicate)', async () => {
    const mux = { stream: { destroyed: false } };
    const { state, sent } = openChannelThatGreetedAs(mux, TOPIC_DEVICE, TOPIC_DEVICE, PEER_DEVICE);
    _testing.maybeSendHello(state, TOPIC);
    await settle();
    expect(sent).toEqual([]);
  });

  it('CONTROL: an UNKNOWN sent-identity (legacy state) is not evidence of a mismatch — latch holds', async () => {
    const mux = { stream: { destroyed: false } };
    const { state, sent } = openChannelThatGreetedAs(mux, null, TOPIC_DEVICE, PEER_DEVICE);
    _testing.maybeSendHello(state, TOPIC);
    await settle();
    expect(sent).toEqual([]);
  });

  it('healSweep corrects a channel whose seeded identity drifted from the topic wiring, even with the handshake "complete"', async () => {
    const mux = { stream: { destroyed: false } };
    // Seeded as the sibling, greeted as the sibling, peer answered — the
    // pre-fix sweep saw `helloSent && remoteDevicePubkey` and skipped forever.
    const { state, sent } = openChannelThatGreetedAs(mux, SIBLING_DEVICE, SIBLING_DEVICE, PEER_DEVICE);
    _testing.wiredTopicIdentity.set(TOPIC_HEX, {
      selfDevicePubkeyBase64: TOPIC_DEVICE,
      sign: () => Buffer.alloc(64, 7),
    });
    seedMuxerConfig(mux, SIBLING_DEVICE, [TOPIC_HEX]);
    _testing.healSweep();
    await settle();
    expect(state.selfDevicePubkeyBase64).toBe(TOPIC_DEVICE);
    expect(sent.map((v) => v.device_pubkey)).toEqual([TOPIC_DEVICE]);
  });

  it('CONTROL: healSweep leaves a healthy channel (right identity, peer known) alone', async () => {
    const mux = { stream: { destroyed: false } };
    const { sent } = openChannelThatGreetedAs(mux, TOPIC_DEVICE, TOPIC_DEVICE, PEER_DEVICE);
    _testing.wiredTopicIdentity.set(TOPIC_HEX, {
      selfDevicePubkeyBase64: TOPIC_DEVICE,
      sign: () => Buffer.alloc(64, 7),
    });
    seedMuxerConfig(mux, TOPIC_DEVICE, [TOPIC_HEX]);
    _testing.healSweep();
    await settle();
    expect(sent).toEqual([]);
  });
});

describe('onclose evicts every device the socket was registered under', () => {
  it('a peer that greeted twice (identity corrected mid-connection) leaves no dead entry behind', () => {
    let onclose: (() => void) | undefined;
    const socket = { id: 'live-socket' };
    const mux = {
      stream: { destroyed: false },
      createChannel: (o: { onopen: () => void; onclose: () => void }) => {
        onclose = o.onclose;
        return { addMessage: () => ({ send: () => {} }), open: () => o.onopen() };
      },
    };
    seedMuxerConfig(mux, TOPIC_DEVICE, [TOPIC_HEX]);
    _testing.wiredTopicIdentity.set(TOPIC_HEX, {
      selfDevicePubkeyBase64: TOPIC_DEVICE,
      sign: () => Buffer.alloc(64, 8),
    });
    // Override the config socket so the registry entries point at OUR object.
    _testing.dialConfigByMuxer.get(mux)!.socket = socket;
    const state = _testing.ensureChannel(mux as never, TOPIC);
    // Simulate two verified hellos on this one channel: first under the peer's
    // stale identity, then under its corrected one.
    const reg = _testing.registryByTopic.get(TOPIC_HEX) ?? new Map<string, unknown>();
    _testing.registryByTopic.set(TOPIC_HEX, reg);
    reg.set(SIBLING_DEVICE, socket);
    reg.set(PEER_DEVICE, socket);
    state.remoteDevicePubkey = PEER_DEVICE;
    // An unrelated live socket on the same topic must survive the eviction.
    const otherSocket = { id: 'other-socket' };
    reg.set(Buffer.alloc(32, 12).toString('base64'), otherSocket);

    onclose!();

    expect(reg.get(SIBLING_DEVICE)).toBeUndefined();
    expect(reg.get(PEER_DEVICE)).toBeUndefined();
    expect([...reg.values()]).toEqual([otherSocket]);
  });
});
