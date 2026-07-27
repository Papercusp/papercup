/**
 * serve-wiring.test.ts — unit coverage for EI-18765930091826096's session-leak
 * DETECTOR (`noteSessionHighWater`).
 *
 * WHY A UNIT SIBLING rather than more cases in serve-wiring.integration.test.ts:
 * the detector is pure decision logic over two map sizes, and the property that
 * matters most — that it stays SILENT in healthy operation and reports ONCE per
 * new high-water rather than per session — is about what it does NOT emit. That
 * is awkward to pin down through a real socket + real `git upload-pack`, where
 * session counts are timing-dependent; here every count is exact and chosen.
 *
 * WHY THESE ASSERT ON `sessionWarnHighWater` AND NOT ON THE LOG LINE: `potGitLog`
 * is a deliberate no-op under vitest (the repo runs `vitest-fail-on-console`, so
 * an unconditional diagnostic would fail every suite touching this path), which
 * makes the warn itself unobservable in-process. The high-water is written on
 * the SAME branch that emits the warn, so asserting the bookkeeping IS asserting
 * the detector fired. Confirmed non-vacuous: stubbing `noteSessionHighWater` to a
 * no-op fails the "fires" and "new high-water" cases below.
 */
import { describe, it, expect, vi } from 'vitest';

// WI-6364: the superseded-store lookup reads the harness registry. PARTIAL mock
// (importOriginal) is mandatory — serve-wiring's transitive imports touch other
// exports of this module at import time, and vitest throws on ANY missing key
// with an error naming an unrelated module.
const { loadRegistryMock } = vi.hoisted(() => ({ loadRegistryMock: vi.fn() }));
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadHarnessRegistry: loadRegistryMock,
}));

import {
  _testing,
  resolveServeAdmission,
  DEFAULT_MAX_CONCURRENT_SERVES_PER_REPO,
  type InFlightServe,
} from './serve-wiring';

const { SESSION_LEAK_WARN_AT, noteSessionHighWater, newChannelState, formatRefusalTarget } = _testing;

/** The detector reads only `.size` off the two session maps, so a plain filler
 *  object per slot is sufficient and keeps these cases free of socket plumbing. */
function withSessions(client: number, server: number): ReturnType<typeof newChannelState> {
  // topic/mux are carried only so a refusal can name its own lookup key; the
  // leak detector reads neither, so any placeholder keeps these cases honest.
  const state = newChannelState('00'.repeat(32), null);
  for (let i = 0; i < client; i++) state.clientSessions.set(i, {} as never);
  for (let i = 0; i < server; i++) state.serverSessions.set(i, {} as never);
  return state;
}

describe('pot-git session-leak detector (EI-18765930091826096 recurrence guard)', () => {
  it('the threshold sits above healthy operation (sessions are per-fetch, so healthy is 0-1)', () => {
    // Guards the constant itself: a threshold at 0/1 would fire on every normal
    // fetch and train readers to ignore the line — the failure mode that makes a
    // detector worse than none.
    expect(SESSION_LEAK_WARN_AT).toBeGreaterThan(1);
  });

  it('stays SILENT below the threshold — a healthy peer never emits this line', () => {
    const state = withSessions(SESSION_LEAK_WARN_AT - 1, 0);
    expect(noteSessionHighWater(state)).toBe(false);
    expect(state.sessionWarnHighWater).toBe(0);
  });

  it('fires once the live session total reaches the threshold', () => {
    const state = withSessions(SESSION_LEAK_WARN_AT, 0);
    expect(noteSessionHighWater(state)).toBe(true);
    expect(state.sessionWarnHighWater).toBe(SESSION_LEAK_WARN_AT);
  });

  it('counts BOTH directions — a leak on the serving side is just as real', () => {
    // Splitting the same total across client+server must still trip it: the
    // incident leaked client sessions, but abandoned rungs also strand the
    // serving side's `git upload-pack`.
    const client = Math.floor(SESSION_LEAK_WARN_AT / 2);
    const state = withSessions(client, SESSION_LEAK_WARN_AT - client);
    expect(noteSessionHighWater(state)).toBe(true);
    expect(state.sessionWarnHighWater).toBe(SESSION_LEAK_WARN_AT);
  });

  it('does NOT re-report at the same level — a sustained leak cannot become the storm', () => {
    // Asserts the EMISSION DECISION, not the high-water value: the value is
    // identical whether a repeat call warned or stayed quiet, so a value-only
    // assertion here passes against a detector that warns every single time.
    const state = withSessions(SESSION_LEAK_WARN_AT, 0);
    expect(noteSessionHighWater(state)).toBe(true);
    // Re-registering at an unchanged count (the shape a steady leak produces
    // while it plateaus) must emit nothing further.
    expect(noteSessionHighWater(state)).toBe(false);
    expect(noteSessionHighWater(state)).toBe(false);
  });

  it('reports again only on a NEW high-water — which is the signal that it is still climbing', () => {
    const state = withSessions(SESSION_LEAK_WARN_AT, 0);
    expect(noteSessionHighWater(state)).toBe(true);
    state.clientSessions.set(999, {} as never);
    expect(noteSessionHighWater(state)).toBe(true);
    expect(state.sessionWarnHighWater).toBe(SESSION_LEAK_WARN_AT + 1);
  });

  it('stays quiet when sessions DRAIN and re-climb below the previous peak (the fix working)', () => {
    // This is the post-fix shape: counts rise under load and fall back as fetches
    // settle. Re-reporting every oscillation would make a HEALTHY peer noisy and
    // bury a real climb.
    const state = withSessions(SESSION_LEAK_WARN_AT + 4, 0);
    expect(noteSessionHighWater(state)).toBe(true);
    const peak = state.sessionWarnHighWater;
    state.clientSessions.clear();
    expect(noteSessionHighWater(state)).toBe(false);
    for (let i = 0; i < SESSION_LEAK_WARN_AT + 1; i++) state.clientSessions.set(i, {} as never);
    expect(noteSessionHighWater(state)).toBe(false);
    expect(state.sessionWarnHighWater).toBe(peak);
  });
});

/**
 * EI-18776567787336109 — the per-fetch duplex must honour protomux's flow
 * control.
 *
 * THE BUG: `_write` called its callback unconditionally, so node was always
 * told "that write landed, send more" no matter how backed up the muxer's
 * stream was. A warm fetch (100-650 ms) never notices; a multi-GB cold join
 * shovels the entire pack into the connection as fast as upload-pack can
 * produce it, because nothing upstream can apply the brakes.
 *
 * protomux reports the pressure both ways — `send()` returns the muxer's
 * `drained` flag, and a channel gets an `ondrain` callback — so honouring it is
 * what makes this duplex a properly flow-controlled stream: the deferred write
 * callback pauses `child.stdout` through the existing pipe.
 */
describe('FrameDuplex backpressure (EI-18776567787336109)', () => {
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

  it('PARKS the write callback while the wire is backed up, and resumes on drain', async () => {
    const resumes: Array<() => void> = [];
    let sent = 0;
    const d = new _testing.FrameDuplex(
      () => {
        sent++;
        return false; // protomux: "stream is full, stop writing"
      },
      () => {},
      (resume) => resumes.push(resume),
    );

    let writeDone = false;
    d.write(Buffer.from('pack-bytes'), () => {
      writeDone = true;
    });
    await tick();

    // The bytes went out, but the write is NOT acknowledged — that unacknowledged
    // callback is the entire braking mechanism.
    expect(sent).toBe(1);
    expect(writeDone).toBe(false);
    expect(resumes).toHaveLength(1);

    // The channel drains -> the parked write completes.
    for (const r of resumes.splice(0)) r();
    await tick();
    expect(writeDone).toBe(true);
  });

  it('does NOT park when the wire reports it is drained', async () => {
    const resumes: Array<() => void> = [];
    const d = new _testing.FrameDuplex(
      () => true, // protomux: "plenty of room"
      () => {},
      (resume) => resumes.push(resume),
    );

    let writeDone = false;
    d.write(Buffer.from('x'), () => {
      writeDone = true;
    });
    await tick();

    expect(writeDone).toBe(true);
    expect(resumes).toHaveLength(0);
  });
});

/**
 * WI-6364 (fix C) — the serve path must REFUSE a store it has abandoned rather
 * than answer a fetch out of it.
 *
 * The VERDICT is pure and tested in repo-identity.test.ts. What only this side
 * can cover is the wiring around it: which registry entries are even eligible,
 * and the fail-open contract. Both matter more than they look — a too-wide
 * entry set lets an unrelated pot's abandoned alias refuse a healthy fetch, and
 * a fail-CLOSED registry error would take the whole serve plane down on a
 * diagnostic improvement.
 */
describe('WI-6364: the serve path\'s superseded-store lookup', () => {
  const { resolveSupersededRepoKey } = _testing;

  /** The live tower shape: the pot home (re-keyed to gh-<id> on 2026-07-20,
   *  stranding `papercusp.git`), a member repo under the SAME pot directory,
   *  and an unrelated pot that has its own abandoned alias. */
  const REGISTRY = {
    projects: [
      { slug: 'papercusp', self_repo: true, github_repository_id: 1223568103 },
      { slug: 'hive-canary', hive_slug: 'papercusp' },
      { slug: 'other-pot', self_repo: true, github_repository_id: 999 },
    ],
  };

  it('THE LIVE REPRO: the pot home\'s abandoned alias is refused, naming the canonical key', async () => {
    loadRegistryMock.mockResolvedValue(REGISTRY);
    await expect(resolveSupersededRepoKey('papercusp', 'papercusp')).resolves.toEqual({
      requested: 'papercusp',
      canonical: 'gh-1223568103',
      entrySlug: 'papercusp',
    });
  });

  it('serves the canonical key, and serves a member repo sharing the pot directory', async () => {
    loadRegistryMock.mockResolvedValue(REGISTRY);
    await expect(resolveSupersededRepoKey('papercusp', 'gh-1223568103')).resolves.toBeNull();
    await expect(resolveSupersededRepoKey('papercusp', 'hive-canary')).resolves.toBeNull();
  });

  it('SCOPING: another pot\'s abandoned alias can never refuse a fetch here', async () => {
    // `other-pot` is a superseded alias — but of a pot whose stores do not live
    // under this potHomeSlug. A registry-wide scan would refuse this.
    loadRegistryMock.mockResolvedValue(REGISTRY);
    await expect(resolveSupersededRepoKey('papercusp', 'other-pot')).resolves.toBeNull();
  });

  it('a pot with no registry entries at all yields no verdict', async () => {
    loadRegistryMock.mockResolvedValue(REGISTRY);
    await expect(resolveSupersededRepoKey('unknown-pot', 'papercusp')).resolves.toBeNull();
  });

  it('FAILS OPEN: an unreadable registry never refuses — a diagnostic must not take the serve plane down', async () => {
    loadRegistryMock.mockRejectedValue(new Error('registry unreadable'));
    await expect(resolveSupersededRepoKey('papercusp', 'papercusp')).resolves.toBeNull();
  });
});

describe('serve-refusal diagnosability (a refusal must name its own lookup key)', () => {
  const REQUESTED = 'd85dc18c0bac0c9a'.repeat(4); // 64 hex
  const OTHER = '0edc4b5f618f81b3'.repeat(4);

  // The regression this guards is not a crash — it is a refusal that cannot be
  // acted on. `not-serving` is decided by a (muxer, topic) lookup, so dropping
  // the topic from the line makes the reason unfalsifiable from logs; that is
  // what stalled the live rig<->tower papercusp diagnosis.
  it('names the topic the refusal is about', () => {
    expect(formatRefusalTarget('not-serving', REQUESTED, [])).toContain(`topic=${REQUESTED.slice(0, 16)}`);
    // every reason carries the topic, not only not-serving
    expect(formatRefusalTarget('no-such-repo', REQUESTED, [])).toContain(`topic=${REQUESTED.slice(0, 16)}`);
  });

  it('DISTINGUISHES the two shapes of not-serving: an unwired muxer vs a channel-id mismatch', () => {
    // (1) nothing wired on this muxer at all
    expect(formatRefusalTarget('not-serving', REQUESTED, [])).toContain('serveTopics=<none>');
    // (2) this muxer DOES serve — just not the requested topic. Distinct from
    // (1), and the pair is what identifies a dialer/server channel-id mismatch.
    const mismatch = formatRefusalTarget('not-serving', REQUESTED, [OTHER]);
    expect(mismatch).toContain(`serveTopics=${OTHER.slice(0, 16)}`);
    expect(mismatch).not.toContain('<none>');
  });

  it('reports an unreadable registration set as distinct from an empty one', () => {
    // Collapsing these would let a broken probe read as a confident "nothing
    // is wired here" — the diagnosis and the fix differ.
    expect(formatRefusalTarget('not-serving', REQUESTED, null)).toContain('serveTopics=<unreadable>');
  });

  it('omits serveTopics for reasons that do not depend on it', () => {
    // no-such-repo already proves serve WAS registered, so the set is noise.
    expect(formatRefusalTarget('no-such-repo', REQUESTED, [OTHER])).not.toContain('serveTopics');
  });

  it('survives a state with no topic rather than printing a misleading empty key', () => {
    expect(formatRefusalTarget('not-serving', '', [])).toContain('topic=<unknown>');
  });
});

describe('EI-18802104888674071: serve reachability across a shared peer connection', () => {
  const { resolveServeRegistration } = _testing;
  const cfgA = { potHomeSlug: 'papercusp', workspaceId: 'ws-1' };
  const cfgB = { potHomeSlug: 'hello-world-3-pot', workspaceId: 'ws-1' };
  const OWN_SOCKET = { tag: 'wired-here' };
  const LIVE_SOCKET = { tag: 'this-muxers-live-connection' };

  // THE LIVE REPRO. Two pots share one peer connection; whichever pot's swarm
  // handled it is the only one `wireHiveGitServe` ran for, but `mux.pair` is
  // registered at PROTOCOL scope so the OTHER pot's channel still materializes
  // here. Before this fix that channel refused `not-serving` for the life of
  // the connection — observed on the rig as
  // `topic=d85dc18c…(papercusp) serveTopics=0edc4b5f…(hello-world-3-pot)`.
  it('serves a pot wired on ANOTHER muxer, using THIS connection for identity', () => {
    const got = resolveServeRegistration(undefined, cfgA, LIVE_SOCKET);
    expect(got?.serverConfig).toBe(cfgA);
    // Identity MUST come from the live connection. Carrying the socket stored
    // at the original registration would authenticate this peer as a different
    // one — the failure mode that makes widening the lookup dangerous at all.
    expect(got?.socket).toBe(LIVE_SOCKET);
  });

  it('prefers this muxer\'s OWN registration over the process-wide one', () => {
    const got = resolveServeRegistration({ serverConfig: cfgB, socket: OWN_SOCKET }, cfgA, LIVE_SOCKET);
    expect(got?.serverConfig).toBe(cfgB);
    expect(got?.socket).toBe(OWN_SOCKET);
  });

  // The boundary that keeps this from being a privilege leak: the fallback is
  // keyed by the SAME topicHex, never "any config on this muxer". A pot this
  // box never wired serve for stays unserved.
  it('REFUSES a topic this box never wired serve for anywhere', () => {
    expect(resolveServeRegistration(undefined, undefined, LIVE_SOCKET)).toBeNull();
  });

  it('REFUSES when the peer on this connection cannot be identified', () => {
    // No socket ⇒ resolvePeerDevicePubkey has nothing to authenticate against.
    // Adopting the config anyway would serve an unauthenticated peer.
    expect(resolveServeRegistration(undefined, cfgA, undefined)).toBeNull();
  });
});

// ─── EI-18802033487678337: bounded per-repo serve concurrency ───────────
//
// WHY A PURE UNIT: the rule this guards is a LIVE-TOPOLOGY property (how many
// `pack-objects` processes one repo can be made to run at once), and the
// surrounding path needs a Protomux, a real bare repo, and a spawned
// upload-pack. The decision itself is pure, so it is asserted here where every
// input is exact — the same split that made `resolveServeRegistration`
// testable.
//
// WHAT THIS IS PROTECTING (live tower, 2026-07-27): 3+ concurrent
// `git pack-objects` on one 4.1G repo, 1.0-1.7GB RSS and 40-126% CPU each,
// spawned ~15s apart, with serves logging 120-566s against a requester whose
// ceiling is 120s. Contention pushed every serve past that ceiling, the
// requester re-dialled, and each re-dial added another process — a loop that
// amplifies rather than settles.
describe('resolveServeAdmission (EI-18802033487678337)', () => {
  const REPO = '/pot-git/papercusp/papercusp.git';
  const OTHER = '/pot-git/papercusp/other.git';
  const chanA = { c: 'A' };
  const chanB = { c: 'B' };
  const chanC = { c: 'C' };
  const serve = (channel: object, repoPath: string, sessionId: number): InFlightServe => ({
    channel,
    repoPath,
    repoKey: 'papercusp',
    sessionId,
    startedAt: 0,
  });

  it('admits freely when the repo is idle', () => {
    const got = resolveServeAdmission({ repoPath: REPO, channel: chanA, inFlight: [] });
    expect(got.admit).toBe(true);
    expect(got.supersede).toEqual([]);
  });

  // Rule 1 — the orphan reaper. A requester drives at most one fetch of a given
  // repo per channel at a time (the deepen ladder's rungs are strictly
  // sequential), so a SECOND live request for the same repo on the same channel
  // proves the first will never be read again.
  it('SUPERSEDES an in-flight serve of the same repo on the same channel', () => {
    const stale = serve(chanA, REPO, 1);
    const got = resolveServeAdmission({ repoPath: REPO, channel: chanA, inFlight: [stale] });
    expect(got.admit).toBe(true);
    expect(got.supersede).toEqual([stale]);
  });

  // The boundary that keeps rule 1 from being a cross-peer kill: a DIFFERENT
  // channel is a different peer connection, whose fetch is live and must not be
  // torn down by someone else's request.
  it("never supersedes another CHANNEL's serve of the same repo", () => {
    const other = serve(chanB, REPO, 1);
    const got = resolveServeAdmission({ repoPath: REPO, channel: chanA, inFlight: [other] });
    expect(got.admit).toBe(true);
    expect(got.supersede).toEqual([]);
  });

  // ...and the same-channel rule is scoped to the same REPO: a peer fetching
  // two different repos concurrently is legitimate.
  it("never supersedes the same channel's serve of a DIFFERENT repo", () => {
    const other = serve(chanA, OTHER, 1);
    const got = resolveServeAdmission({ repoPath: REPO, channel: chanA, inFlight: [other] });
    expect(got.admit).toBe(true);
    expect(got.supersede).toEqual([]);
  });

  // Rule 2 — the cap. It bounds cost when the peers are genuinely distinct (so
  // rule 1 can never fire), the regime a supersede rule alone cannot reach.
  it('REFUSES busy at the cap across distinct channels', () => {
    const got = resolveServeAdmission({
      repoPath: REPO,
      channel: chanC,
      inFlight: [serve(chanA, REPO, 1), serve(chanB, REPO, 1)],
      cap: 2,
    });
    expect(got.admit).toBe(false);
    expect(got.refuseReason).toBe('busy');
  });

  // The cap DISCOUNTS what this same request supersedes — otherwise a single
  // re-dialling peer would refuse itself busy forever off its own abandoned
  // serves, which is the original bug wearing the fix's clothes.
  it('does not count a serve it is superseding against the cap', () => {
    const mine = serve(chanA, REPO, 1);
    const got = resolveServeAdmission({
      repoPath: REPO,
      channel: chanA,
      inFlight: [mine, serve(chanB, REPO, 1)],
      cap: 2,
    });
    expect(got.admit).toBe(true);
    expect(got.supersede).toEqual([mine]);
  });

  // The cap is keyed on the repo PATH, because the contended resource is that
  // repo's object store and this box's CPU/RAM — an unrelated repo's serves
  // must not consume it.
  it('scopes the cap to the repo path, not the process', () => {
    const got = resolveServeAdmission({
      repoPath: REPO,
      channel: chanC,
      inFlight: [serve(chanA, OTHER, 1), serve(chanB, OTHER, 1)],
      cap: 2,
    });
    expect(got.admit).toBe(true);
  });

  it('defaults the cap to DEFAULT_MAX_CONCURRENT_SERVES_PER_REPO', () => {
    const inFlight = Array.from({ length: DEFAULT_MAX_CONCURRENT_SERVES_PER_REPO }, (_, i) =>
      serve({ c: i }, REPO, 1),
    );
    expect(resolveServeAdmission({ repoPath: REPO, channel: chanC, inFlight }).admit).toBe(false);
    expect(
      resolveServeAdmission({ repoPath: REPO, channel: chanC, inFlight: inFlight.slice(1) }).admit,
    ).toBe(true);
  });
});
