/**
 * peer-dial-registry-redial-tail.test.ts — WI-5210, fix-intent leg (1).
 *
 * THE INCIDENT (P-303 Leg B, hello-world-3-pot rig, fence-25). A channel-open
 * rejected during a connection-churn window was never retried again for the
 * life of the connection, so one fetch direction stayed dead for HOURS.
 *
 * WHY THE FAST LADDER CANNOT COVER IT. `maybeScheduleRedial` retries on
 * REDIAL_DELAYS_MS = [5s, 20s, 60s] and then gives up permanently — a ~85s
 * budget. The WI-3496 drill MEASURED a ~100s skew between the two machines'
 * swarm wirings, so the ladder expires BEFORE the race it exists to cover
 * typically resolves. Reconnects are rare (EI-13317), so "gave up" means
 * "dead until a simultaneous pair restart".
 *
 * WHAT ACTUALLY CLOSES THE GAP. Leg (1) is NOT implemented by uncapping the
 * ladder — it is `healSweep` clause (a): every 60s, re-dial any EXPLICITLY
 * wired topic that currently has no channel state. The never-opened close
 * evicts that state (peer-dial-registry.ts onclose), so the sweep sees the
 * topic as channel-less and dials again, forever, for as long as the stream
 * lives and the topic stays wired. That is the uncapped steady-state tail.
 *
 * WHY THIS FILE EXISTS. The sibling suite (peer-dial-registry-lost-hello)
 * covers legs (2)/(3) — the hello RE-SEND arm — thoroughly. Clause (a), the
 * RE-DIAL arm, had no coverage at all, and every one of its preconditions is
 * silent when broken: it is fail-soft, logs only under dbg, and its failure
 * mode is precisely fence-25 (quiet, one-directional, hours long). Dropping
 * the onclose eviction, or the `wiredTopics` seeding, would restore the
 * original bug with no test turning red.
 *
 * Run: npm run test:file -- packages/operator-core/lib/sync/pot-git/peer-dial-registry-redial-tail.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./serve-wiring', () => ({
  openHiveGitFetchDuplex: vi.fn((socket: unknown) => ({ destroyed: false, socket })),
}));

const { _testing } = await import('./peer-dial-registry');

const TOPIC = Buffer.alloc(32, 7);
const TOPIC_HEX = TOPIC.toString('hex');
const OTHER_TOPIC_HEX = Buffer.alloc(32, 9).toString('hex');
const SELF_DEVICE = Buffer.alloc(32, 1).toString('base64');

/**
 * A muxer stand-in. Clause (a) reaches real `ensureChannel`, so this records
 * dials at the protomux seam — `createChannel` — rather than stubbing the
 * function under test.
 */
function makeMux(): {
  stream: { destroyed: boolean };
  dials: string[];
  /** `onclose` of the most recently created channel — lets a test drive the
   *  REAL never-opened close instead of simulating its effect. */
  lastOnClose: (() => void) | null;
  createChannel: (opts: { id: Buffer; onclose?: () => void }) => unknown;
} {
  const dials: string[] = [];
  const mux = {
    stream: { destroyed: false },
    dials,
    lastOnClose: null as (() => void) | null,
    createChannel(opts: { id: Buffer; onclose?: () => void }) {
      dials.push(opts.id.toString('hex'));
      mux.lastOnClose = opts.onclose ?? null;
      return { addMessage: () => ({ send: () => {} }), open: () => {} };
    },
  };
  return mux;
}

/**
 * The post-eviction steady state this tail exists for: the topic is wired on
 * this muxer, and there is NO channel state — the fast ladder already gave up.
 */
function wireTopicWithNoChannel(
  mux: object,
  opts: { cfgTopics?: string[]; seedWiredTopic?: boolean } = {},
): void {
  if (opts.seedWiredTopic ?? true) _testing.wiredTopics.set(TOPIC_HEX, TOPIC);
  _testing.dialConfigByMuxer.set(mux, {
    selfDevicePubkeyBase64: SELF_DEVICE,
    sign: () => Buffer.alloc(64, 3),
    socket: { id: 'live-socket' },
    topics: new Set(opts.cfgTopics ?? [TOPIC_HEX]),
    retries: new Map(),
  } as never);
  _testing.trackedMuxers.add(mux as never);
}

/** One 60s sweep tick whose re-dial is rejected again: the channel closes
 *  without ever opening, which evicts the state (onclose) and returns us to
 *  the same channel-less steady state the next tick observes. */
function tickWithRejectedDial(mux: object): void {
  _testing.healSweep();
  _testing.statesFor(mux).delete(TOPIC_HEX);
}

beforeEach(() => {
  _testing.reset();
});

afterEach(() => {
  // `ensureChannel` arms the managed heal-sweep interval; reset() stops it so a
  // live timer cannot outlive the suite.
  _testing.reset();
});

describe('WI-5210 leg (1) — healSweep re-dials a topic whose fast ladder exhausted', () => {
  it('THE PROPERTY: a wired topic with no channel state gets re-dialled', () => {
    const mux = makeMux();
    wireTopicWithNoChannel(mux);

    _testing.healSweep();

    expect(mux.dials).toEqual([TOPIC_HEX]);
  });

  it('UNCAPPED: still dialling on tick 6, long past the 3-attempt (~85s) ladder', () => {
    // The ladder's whole budget is ~85s against a MEASURED ~100s skew, so the
    // tail is the only thing standing between a churn-window rejection and a
    // connection-lifetime outage. Six ticks ~= 6min of steady healing.
    const mux = makeMux();
    wireTopicWithNoChannel(mux);

    for (let tick = 0; tick < 6; tick += 1) tickWithRejectedDial(mux);

    expect(mux.dials).toHaveLength(6);
    expect(new Set(mux.dials)).toEqual(new Set([TOPIC_HEX]));
  });

  it('TERMINATION: a topic that already HAS a channel is left alone — no 60s dial churn', () => {
    const mux = makeMux();
    wireTopicWithNoChannel(mux);

    _testing.healSweep();
    expect(mux.dials).toHaveLength(1); // dialled once...

    _testing.healSweep();
    _testing.healSweep();
    expect(mux.dials).toHaveLength(1); // ...and never again while the state stands.
  });

  it('drops a muxer whose stream is destroyed instead of dialling it forever', () => {
    const mux = makeMux();
    wireTopicWithNoChannel(mux);
    mux.stream.destroyed = true;

    _testing.healSweep();

    expect(mux.dials).toEqual([]);
    expect(_testing.trackedMuxers.has(mux as never)).toBe(false);
  });
});

describe('WI-5210 leg (1) — the eviction the tail keys on, through real code', () => {
  // The tests above hand-delete the state to model a rejected open. That models
  // the effect rather than exercising it, so on their own they would stay GREEN
  // if the onclose eviction were ever dropped — and the tail would be dead.
  // These two drive the real close handler instead.

  it('a never-opened close EVICTS the channel state', () => {
    const mux = makeMux();
    wireTopicWithNoChannel(mux);

    _testing.healSweep();
    expect(_testing.statesFor(mux).has(TOPIC_HEX)).toBe(true);

    mux.lastOnClose?.(); // the remote protomux-rejected our open

    expect(_testing.statesFor(mux).has(TOPIC_HEX)).toBe(false);
  });

  it('END TO END: rejected open → real onclose → next sweep re-dials, with no simulated eviction', () => {
    const mux = makeMux();
    wireTopicWithNoChannel(mux);

    for (let tick = 0; tick < 4; tick += 1) {
      _testing.healSweep();
      mux.lastOnClose?.();
    }

    expect(mux.dials).toHaveLength(4);
  });
});

describe('WI-5210 leg (1) — the tail never widens the topic gate', () => {
  it('never dials a topic THIS connection did not wire', () => {
    // A remote can open a channel with an arbitrary id; the sweep must only
    // ever re-dial topics this box explicitly wired on this muxer.
    const mux = makeMux();
    wireTopicWithNoChannel(mux, { cfgTopics: [OTHER_TOPIC_HEX] });

    _testing.healSweep();

    expect(mux.dials).toEqual([]);
  });

  it('CALIBRATION: the same setup DOES dial once the topic is wired — the guard above is not vacuous', () => {
    const mux = makeMux();
    wireTopicWithNoChannel(mux, { cfgTopics: [TOPIC_HEX] });

    _testing.healSweep();

    expect(mux.dials).toEqual([TOPIC_HEX]);
  });

  it('skips a wired topic whose bytes are unknown rather than fabricating them', () => {
    // Clause (a) dials with the RECORDED topic bytes; without them it must
    // `continue`, never reconstruct an id it cannot vouch for.
    const mux = makeMux();
    wireTopicWithNoChannel(mux, { seedWiredTopic: false });

    _testing.healSweep();

    expect(mux.dials).toEqual([]);
  });
});
