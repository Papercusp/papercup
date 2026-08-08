/**
 * peer-dial-registry-lost-hello.test.ts — WI-5210.
 *
 * THE INCIDENT (P-303 Leg B, hello-world-3-pot rig, fence-25). Connection churn
 * left an ASYMMETRIC hello state: the VM received the tower's hello, but the
 * tower never received the VM's. `resolvePotGitPeerSocket` therefore returned
 * undefined on the tower, and every tower-side bootstrap/fetch tick failed
 * fail-soft ("no live dial path") for HOURS — one fetch direction dead until a
 * simultaneous pair restart.
 *
 * WHY THE ORIGINAL HEAL COULD NOT FIX IT. `healSweep` re-sent a hello only when
 * `!state.helloSent`. But a hello has NO ACK, so `helloSent` records that we
 * called `send()`, never that the peer received one — and fence-25 was a hello
 * SENT AND LOST. Both sides sat at `helloSent === true`, so every re-send path
 * skipped them permanently. The heal was written for the incident and gated on
 * the one flag that is true during it.
 *
 * The missing half of the condition is `!remoteDevicePubkey`: the peer's hello
 * being absent is the only positive evidence available that OURS may not have
 * landed.
 *
 * These tests pin the repair AND its termination bound — an unbounded "answer
 * every hello with a hello" would ping-pong two peers forever at receive speed.
 *
 * Run: npm run test:file -- packages/operator-core/lib/sync/pot-git/peer-dial-registry-lost-hello.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./serve-wiring', () => ({
  openHiveGitFetchDuplex: vi.fn((socket: unknown) => ({ destroyed: false, socket })),
}));

const { _testing } = await import('./peer-dial-registry');

const TOPIC = Buffer.alloc(32, 7);
const TOPIC_HEX = TOPIC.toString('hex');
const SELF_DEVICE = Buffer.alloc(32, 1).toString('base64');
const PEER_DEVICE = Buffer.alloc(32, 2).toString('base64');

/** A muxer stand-in: `healSweep` only reads `.stream.destroyed`. */
function makeMux(): { stream: { destroyed: boolean } } {
  return { stream: { destroyed: false } };
}

/**
 * An OPEN hello channel on `mux` for TOPIC, with identity already wired — the
 * post-handshake steady state. `sent` collects every hello that goes out.
 */
function wireOpenChannel(
  mux: object,
  opts: { helloSent: boolean; remoteDevicePubkey: string | null },
): { sent: Array<{ device_pubkey: string }> } {
  const sent: Array<{ device_pubkey: string }> = [];
  const state = _testing.newState();
  state.opened = true;
  state.selfDevicePubkeyBase64 = SELF_DEVICE;
  state.sign = () => Buffer.alloc(64, 3);
  state.hello = { send: (v: { device_pubkey: string }) => sent.push(v) };
  state.helloSent = opts.helloSent;
  state.remoteDevicePubkey = opts.remoteDevicePubkey;
  state.localSocket = { id: 'live-socket' };

  _testing.statesFor(mux).set(TOPIC_HEX, state);
  _testing.wiredTopics.set(TOPIC_HEX, TOPIC);
  _testing.dialConfigByMuxer.set(mux, {
    selfDevicePubkeyBase64: SELF_DEVICE,
    sign: () => Buffer.alloc(64, 3),
    socket: { id: 'live-socket' },
    topics: new Set([TOPIC_HEX]),
    retries: new Map(),
  });
  _testing.trackedMuxers.add(mux as never);
  return { sent };
}

/** The hello send signs asynchronously; let the microtask queue drain. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => {
  _testing.reset();
});

describe('WI-5210 — healSweep repairs a one-sided hello', () => {
  it('THE BUG: re-sends when our hello was SENT but the peer never answered', async () => {
    // Exactly fence-25 on the tower: we sent (so the old gate skipped us
    // forever) and their hello never arrived.
    const mux = makeMux();
    const { sent } = wireOpenChannel(mux, { helloSent: true, remoteDevicePubkey: null });

    _testing.healSweep();
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.device_pubkey).toBe(SELF_DEVICE);
  });

  it('still re-sends when our hello was NEVER sent (the original heal, not regressed)', async () => {
    const mux = makeMux();
    const { sent } = wireOpenChannel(mux, { helloSent: false, remoteDevicePubkey: null });

    _testing.healSweep();
    await settle();

    expect(sent).toHaveLength(1);
  });

  it('re-sends when ours never went out even though THEIRS arrived', async () => {
    // The other one-sided direction: their hello landed, ours never left.
    const mux = makeMux();
    const { sent } = wireOpenChannel(mux, { helloSent: false, remoteDevicePubkey: PEER_DEVICE });

    _testing.healSweep();
    await settle();

    expect(sent).toHaveLength(1);
  });

  it('TERMINATION: a completed handshake is left alone — no periodic hello traffic', async () => {
    const mux = makeMux();
    const { sent } = wireOpenChannel(mux, { helloSent: true, remoteDevicePubkey: PEER_DEVICE });

    _testing.healSweep();
    _testing.healSweep();
    _testing.healSweep();
    await settle();

    expect(sent).toHaveLength(0);
  });

  it('never sweeps a channel that is not open', async () => {
    const mux = makeMux();
    const { sent } = wireOpenChannel(mux, { helloSent: true, remoteDevicePubkey: null });
    _testing.statesFor(mux).get(TOPIC_HEX)!.opened = false;

    _testing.healSweep();
    await settle();

    expect(sent).toHaveLength(0);
  });

  it('drops a muxer whose stream has been destroyed instead of sweeping it forever', () => {
    const mux = makeMux();
    wireOpenChannel(mux, { helloSent: true, remoteDevicePubkey: null });
    mux.stream.destroyed = true;

    _testing.healSweep();

    expect(_testing.trackedMuxers.has(mux as never)).toBe(false);
  });
});

describe('WI-5210 — one in-flight hello per channel', () => {
  it('a re-send racing the send it retries does not emit two hellos', async () => {
    const mux = makeMux();
    const { sent } = wireOpenChannel(mux, { helloSent: true, remoteDevicePubkey: null });
    const state = _testing.statesFor(mux).get(TOPIC_HEX)!;
    // A signer that stays pending keeps the first send in flight.
    let release: (() => void) | undefined;
    state.sign = () =>
      new Promise<Buffer>((resolve) => {
        release = () => resolve(Buffer.alloc(64, 3));
      });

    _testing.healSweep();
    _testing.healSweep();
    _testing.healSweep();
    await settle();
    expect(sent).toHaveLength(0); // still signing

    release!();
    await settle();
    expect(sent).toHaveLength(1); // three sweeps, ONE hello
  });

  it('a FAILED send does not latch the channel shut — the next sweep retries it', async () => {
    // `helloSent` is set before the async sign resolves, so a throwing signer
    // used to leave the channel marked "sent" having emitted nothing, forever.
    const mux = makeMux();
    const { sent } = wireOpenChannel(mux, { helloSent: false, remoteDevicePubkey: null });
    const state = _testing.statesFor(mux).get(TOPIC_HEX)!;
    state.sign = () => {
      throw new Error('signer unavailable');
    };

    _testing.healSweep();
    await settle();
    expect(sent).toHaveLength(0);
    expect(state.helloSent).toBe(true); // latched, having sent nothing
    expect(state.helloInFlight).toBe(false); // but NOT stuck in-flight

    state.sign = () => Buffer.alloc(64, 3);
    _testing.healSweep();
    await settle();
    expect(sent).toHaveLength(1);
  });
});

/**
 * FALSIFIABILITY CONTROL — kept permanently, per the repo's "prove a guard can
 * fail" rule, and WITHOUT mutating the shared tree (the subject is a module we
 * import, so the deliberately-wrong implementation lives here instead).
 *
 * `oldSweepSkips` is the predicate `healSweep` used before this fix. The point
 * is not that it differs from the new one — it is that it CANNOT distinguish
 * the fence-25 state from a healthy one, so the tests above would report 0
 * sends against it and pass vacuously if the fix were reverted.
 */
const oldSweepSkips = (s: { opened: boolean; helloSent: boolean }): boolean =>
  !s.opened || s.helloSent;
const newSweepSkips = (s: {
  opened: boolean;
  helloSent: boolean;
  remoteDevicePubkey: string | null;
}): boolean => !s.opened || (s.helloSent && !!s.remoteDevicePubkey);

describe('WI-5210 — control: the OLD gate provably could not heal this incident', () => {
  const fence25 = { opened: true, helloSent: true, remoteDevicePubkey: null };
  const healthy = { opened: true, helloSent: true, remoteDevicePubkey: PEER_DEVICE };
  const neverSent = { opened: true, helloSent: false, remoteDevicePubkey: null };

  it('the OLD predicate skips the incident state — this is the bug, stated as a control', () => {
    expect(oldSweepSkips(fence25)).toBe(true);
  });

  it('the NEW predicate sweeps it', () => {
    expect(newSweepSkips(fence25)).toBe(false);
  });

  it('CALIBRATION: both agree on a healthy channel, so the control is not just "always differs"', () => {
    expect(oldSweepSkips(healthy)).toBe(true);
    expect(newSweepSkips(healthy)).toBe(true);
  });

  it('CALIBRATION: both agree on a never-sent channel — the new gate is strictly WIDER, not different', () => {
    expect(oldSweepSkips(neverSent)).toBe(false);
    expect(newSweepSkips(neverSent)).toBe(false);
  });

  it('the live code follows the NEW predicate, not the old one', async () => {
    // Ties the pure predicates above to the real sweep: same input, and the
    // module must behave the way `newSweepSkips` says.
    const mux = makeMux();
    const { sent } = wireOpenChannel(mux, {
      helloSent: fence25.helloSent,
      remoteDevicePubkey: fence25.remoteDevicePubkey,
    });
    _testing.healSweep();
    await settle();
    expect(sent.length > 0).toBe(!newSweepSkips(fence25));
  });
});

describe('WI-5210 — maybeSendHello latch semantics', () => {
  it('the first-send latch holds without `resend`', async () => {
    const mux = makeMux();
    const { sent } = wireOpenChannel(mux, { helloSent: true, remoteDevicePubkey: null });
    const state = _testing.statesFor(mux).get(TOPIC_HEX)!;

    _testing.maybeSendHello(state, TOPIC);
    await settle();

    expect(sent).toHaveLength(0);
  });

  it('`resend` is the ONLY thing that passes the latch', async () => {
    const mux = makeMux();
    const { sent } = wireOpenChannel(mux, { helloSent: true, remoteDevicePubkey: null });
    const state = _testing.statesFor(mux).get(TOPIC_HEX)!;

    _testing.maybeSendHello(state, TOPIC, { resend: true });
    await settle();

    expect(sent).toHaveLength(1);
  });

  it('sends nothing while identity is unknown, whatever the flags say', async () => {
    const mux = makeMux();
    const { sent } = wireOpenChannel(mux, { helloSent: false, remoteDevicePubkey: null });
    const state = _testing.statesFor(mux).get(TOPIC_HEX)!;
    state.selfDevicePubkeyBase64 = null;
    state.sign = null;

    _testing.maybeSendHello(state, TOPIC, { resend: true });
    await settle();

    expect(sent).toHaveLength(0);
  });
});
