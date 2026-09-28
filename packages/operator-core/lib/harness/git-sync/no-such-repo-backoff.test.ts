/**
 * Pure unit test (no git, no PG, no swarm) over the EI-15333 `no-such-repo`
 * dial-backoff policy now shared by BOTH git-sync dialing legs.
 *
 * The case that earns this file is `re-arms only for a pair actually dialed`:
 * arming off the failure stderr alone turns a bounded 30-minute backoff into
 * permanent suppression, because a backoff SKIP is itself reported as a failure
 * whose stderr names `no-such-repo`. That is a silent, self-sustaining bug —
 * nothing about the running system would look wrong — so it needs a guard that
 * fails loudly if the `dialed` gate is ever dropped.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  NO_SUCH_REPO_BACKOFF_MS,
  NO_SUCH_REPO_LIFT_CLOCK_SKEW_MS,
  __resetNoSuchRepoBackoffForTest,
  armNoSuchRepoBackoff,
  devicesToArmForNoSuchRepo,
  isNoSuchRepoBackoffActive,
  liftNoSuchRepoBackoffOnFreshAnnouncement,
  newestAnnouncementTsByDevice,
  noSuchRepoBackoffKey,
  noSuchRepoBackoffSecondsLeft,
} from './no-such-repo-backoff';

const REPO = 'gh-1223568103';
const PEER = 'Lm1ABoMRKVoo';
const OTHER = 'nWXvaGiAAAAA';

afterEach(() => {
  __resetNoSuchRepoBackoffForTest();
});

describe('noSuchRepoBackoffKey', () => {
  it('separates the same peer on different repos, and the same repo on different peers', () => {
    expect(noSuchRepoBackoffKey(REPO, PEER)).not.toBe(noSuchRepoBackoffKey(REPO, OTHER));
    expect(noSuchRepoBackoffKey(REPO, PEER)).not.toBe(noSuchRepoBackoffKey('gh-999', PEER));
  });
});

describe('the backoff window', () => {
  it('is inactive until armed, active inside the window, and expires', () => {
    const key = noSuchRepoBackoffKey(REPO, PEER);
    const t0 = 1_000_000;

    expect(isNoSuchRepoBackoffActive(key, t0)).toBe(false);

    armNoSuchRepoBackoff(key, t0);
    expect(isNoSuchRepoBackoffActive(key, t0)).toBe(true);
    expect(isNoSuchRepoBackoffActive(key, t0 + NO_SUCH_REPO_BACKOFF_MS - 1)).toBe(true);

    // Exactly at the deadline it is over: the next tick must be free to re-dial,
    // which is what makes this self-healing rather than a permanent block.
    expect(isNoSuchRepoBackoffActive(key, t0 + NO_SUCH_REPO_BACKOFF_MS)).toBe(false);
  });

  it('suppresses only the pair that refused', () => {
    const t0 = 1_000_000;
    armNoSuchRepoBackoff(noSuchRepoBackoffKey(REPO, PEER), t0);
    expect(isNoSuchRepoBackoffActive(noSuchRepoBackoffKey(REPO, OTHER), t0)).toBe(false);
    expect(isNoSuchRepoBackoffActive(noSuchRepoBackoffKey('gh-999', PEER), t0)).toBe(false);
  });

  it('reports the remaining seconds for the operator line, and 0 when unarmed', () => {
    const key = noSuchRepoBackoffKey(REPO, PEER);
    const t0 = 1_000_000;
    expect(noSuchRepoBackoffSecondsLeft(key, t0)).toBe(0);
    armNoSuchRepoBackoff(key, t0);
    expect(noSuchRepoBackoffSecondsLeft(key, t0)).toBe(NO_SUCH_REPO_BACKOFF_MS / 1000);
    expect(noSuchRepoBackoffSecondsLeft(key, t0 + NO_SUCH_REPO_BACKOFF_MS + 5_000)).toBe(0);
  });
});

describe('devicesToArmForNoSuchRepo', () => {
  it('arms a peer that was dialed and refused no-such-repo', () => {
    const armed = devicesToArmForNoSuchRepo(
      [{ device: PEER, stderr: 'duplex error: pot-git serve refused: no-such-repo' }],
      new Set([PEER]),
    );
    expect(armed).toEqual([PEER]);
  });

  it('does NOT arm a transient failure, even from a peer that was really dialed', () => {
    const armed = devicesToArmForNoSuchRepo(
      [
        { device: PEER, stderr: 'duplex error: serve channel closed' },
        { device: OTHER, stderr: '' },
      ],
      new Set([PEER, OTHER]),
    );
    expect(armed).toEqual([]);
  });

  /**
   * THE REASON THIS MODULE EXISTS AS A SEAM.
   *
   * A skipped dial is reported as a failure whose stderr NAMES `no-such-repo`
   * (it must — that is the diagnosis the operator reads). If arming keyed off
   * stderr alone, every tick would push the deadline to `now + WINDOW` off the
   * previous tick's own skip: the window would never expire, the pair would
   * never be retried, and a bounded backoff would have silently become a
   * permanent block. Nothing observable would look wrong.
   */
  it('does NOT re-arm from its own skip message — the window must be able to expire', () => {
    const skipMessage =
      `no-such-repo backoff: ${PEER.slice(0, 8)} definitively refused ${REPO}; next dial in 900s`;
    expect(skipMessage).toContain('no-such-repo');

    const armed = devicesToArmForNoSuchRepo(
      [{ device: PEER, stderr: skipMessage }],
      // Nothing was put on the wire this tick — the skip is what produced the
      // message being read back here.
      new Set(),
    );
    expect(armed).toEqual([]);
  });

  it('arms each refusing peer once, however many held announcements it failed', () => {
    // The stalled shape this fixes: one peer, a whole held fed-event backlog,
    // every row failing identically on every tick.
    const failures = Array.from({ length: 9 }, () => ({
      device: PEER,
      stderr: 'duplex error: pot-git serve refused: no-such-repo',
    }));
    expect(devicesToArmForNoSuchRepo(failures, new Set([PEER]))).toEqual([PEER]);
  });

  it('arms the refusing peer without touching an undialed one in the same batch', () => {
    const armed = devicesToArmForNoSuchRepo(
      [
        { device: PEER, stderr: 'pot-git serve refused: no-such-repo' },
        { device: OTHER, stderr: 'pot-git serve refused: no-such-repo' },
      ],
      new Set([PEER]),
    );
    expect(armed).toEqual([PEER]);
  });
});

/**
 * WI-10003594: the live P-505 Phase A shape. The drill quarantines the VM's
 * store, the tower learns `no-such-repo` about a second later and arms 30 min,
 * the VM re-bootstraps and announces the same repo_key about 3 min later — and
 * the tower must dial it on the next tick, not 27 minutes after the drill's
 * 20-minute verdict deadline has passed.
 */
describe('liftNoSuchRepoBackoffOnFreshAnnouncement', () => {
  const key = noSuchRepoBackoffKey(REPO, PEER);
  const armedAt = 1_790_000_000_000;

  it('lifts the window for a same-repo_key announcement made after the refusal', () => {
    armNoSuchRepoBackoff(key, armedAt);
    const announcedAt = armedAt + 150_000;
    const now = armedAt + 300_000;
    expect(isNoSuchRepoBackoffActive(key, now)).toBe(true);

    expect(liftNoSuchRepoBackoffOnFreshAnnouncement(key, announcedAt, now)).toEqual({
      armedAtMs: armedAt,
      announcedTsMs: announcedAt,
    });
    expect(isNoSuchRepoBackoffActive(key, now)).toBe(false);
  });

  it('does not lift for an announcement older than the refusal (the held-backlog storm)', () => {
    armNoSuchRepoBackoff(key, armedAt);
    const now = armedAt + 300_000;
    const stale = armedAt - NO_SUCH_REPO_LIFT_CLOCK_SKEW_MS - 1;
    expect(liftNoSuchRepoBackoffOnFreshAnnouncement(key, stale, now)).toBeNull();
    expect(isNoSuchRepoBackoffActive(key, now)).toBe(true);
  });

  it('tolerates a peer clock slightly behind ours', () => {
    armNoSuchRepoBackoff(key, armedAt);
    const now = armedAt + 300_000;
    const slightlyBehind = armedAt - NO_SUCH_REPO_LIFT_CLOCK_SKEW_MS + 1;
    expect(liftNoSuchRepoBackoffOnFreshAnnouncement(key, slightlyBehind, now)).not.toBeNull();
  });

  /**
   * THE EI-15333 GUARD FOR THIS CHANGE. If the peer really still lacks the store,
   * the lifted dial is refused and the window re-arms. The SAME announcement is
   * then re-driven every tick as a parked row; it must never lift again, or the
   * tower re-dials once per tick forever — the storm the backoff exists to stop.
   * This holds even when the peer's clock runs AHEAD of ours, which would keep
   * `ts > armedAt` true after every re-arm.
   */
  it('lets one announcement lift at most once, even after a re-arm and with a peer clock ahead', () => {
    armNoSuchRepoBackoff(key, armedAt);
    const aheadTs = armedAt + 2 * NO_SUCH_REPO_BACKOFF_MS; // peer clock far ahead
    expect(liftNoSuchRepoBackoffOnFreshAnnouncement(key, aheadTs, armedAt + 60_000)).not.toBeNull();

    // The lifted dial is refused again: re-arm.
    const rearmedAt = armedAt + 70_000;
    armNoSuchRepoBackoff(key, rearmedAt);
    for (let tick = 1; tick <= 6; tick++) {
      const now = rearmedAt + tick * 300_000 - 1;
      expect(liftNoSuchRepoBackoffOnFreshAnnouncement(key, aheadTs, now)).toBeNull();
      expect(isNoSuchRepoBackoffActive(key, now)).toBe(true);
    }

    // A genuinely NEW announcement may lift again (one more dial, never a storm).
    expect(liftNoSuchRepoBackoffOnFreshAnnouncement(key, aheadTs + 1, rearmedAt + 600_000)).not.toBeNull();
  });

  it('is a no-op when no window is armed, or it already expired', () => {
    expect(liftNoSuchRepoBackoffOnFreshAnnouncement(key, armedAt, armedAt)).toBeNull();
    armNoSuchRepoBackoff(key, armedAt);
    expect(
      liftNoSuchRepoBackoffOnFreshAnnouncement(key, armedAt + 1, armedAt + NO_SUCH_REPO_BACKOFF_MS),
    ).toBeNull();
  });

  it('only touches the pair it names', () => {
    const otherKey = noSuchRepoBackoffKey(REPO, OTHER);
    armNoSuchRepoBackoff(key, armedAt);
    armNoSuchRepoBackoff(otherKey, armedAt);
    liftNoSuchRepoBackoffOnFreshAnnouncement(key, armedAt + 1, armedAt + 1_000);
    expect(isNoSuchRepoBackoffActive(key, armedAt + 1_000)).toBe(false);
    expect(isNoSuchRepoBackoffActive(otherKey, armedAt + 1_000)).toBe(true);
  });

  it('rejects a non-finite ts', () => {
    armNoSuchRepoBackoff(key, armedAt);
    expect(liftNoSuchRepoBackoffOnFreshAnnouncement(key, Number.NaN, armedAt + 1_000)).toBeNull();
  });
});

describe('newestAnnouncementTsByDevice', () => {
  it('keeps the newest ts per device, counting only announcements that name this repo_key', () => {
    const newest = newestAnnouncementTsByDevice(
      [
        { device_pubkey: PEER, ts: 100, repo_key: REPO },
        { device_pubkey: PEER, ts: 300, repo_key: REPO },
        { device_pubkey: PEER, ts: 200, repo_key: REPO },
        { device_pubkey: PEER, ts: 900, repo_key: 'gh-999' }, // another store
        { device_pubkey: OTHER, ts: 950 }, // legacy v1: no repo_key, never lifts
      ],
      REPO,
    );
    expect([...newest.entries()]).toEqual([[PEER, 300]]);
  });
});
