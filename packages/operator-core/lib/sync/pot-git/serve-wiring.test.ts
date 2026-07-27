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

import { _testing } from './serve-wiring';

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
    expect(formatRefusalTarget('not-serving', REQUESTED, [])).toContain('wiredTopics=<none>');
    // (2) this muxer DOES serve — just not the requested topic. Distinct from
    // (1), and the pair is what identifies a dialer/server channel-id mismatch.
    const mismatch = formatRefusalTarget('not-serving', REQUESTED, [OTHER]);
    expect(mismatch).toContain(`wiredTopics=${OTHER.slice(0, 16)}`);
    expect(mismatch).not.toContain('<none>');
  });

  it('reports an unreadable registration set as distinct from an empty one', () => {
    // Collapsing these would let a broken probe read as a confident "nothing
    // is wired here" — the diagnosis and the fix differ.
    expect(formatRefusalTarget('not-serving', REQUESTED, null)).toContain('wiredTopics=<unreadable>');
  });

  it('omits wiredTopics for reasons that do not depend on it', () => {
    // no-such-repo already proves serve WAS registered, so the set is noise.
    expect(formatRefusalTarget('no-such-repo', REQUESTED, [OTHER])).not.toContain('wiredTopics');
  });

  it('survives a state with no topic rather than printing a misleading empty key', () => {
    expect(formatRefusalTarget('not-serving', '', [])).toContain('topic=<unknown>');
  });
});
