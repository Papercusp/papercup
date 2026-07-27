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
import { describe, it, expect } from 'vitest';
import { _testing } from './serve-wiring';

const { SESSION_LEAK_WARN_AT, noteSessionHighWater, newChannelState } = _testing;

/** The detector reads only `.size` off the two session maps, so a plain filler
 *  object per slot is sufficient and keeps these cases free of socket plumbing. */
function withSessions(client: number, server: number): ReturnType<typeof newChannelState> {
  const state = newChannelState();
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
