/**
 * origin-freshness — the PURE verdict (evaluateOriginFreshness / originFreshness). The DB/git
 * wiring (origin-freshness-watchdog.ts: tracking the origin-tip clock, alarming, escalation)
 * mirrors git-sync-stall-watchdog.ts's own scope split (that sibling's DB wiring is likewise
 * not separately unit-tested here — only its pure verdict is).
 *
 * Run: cd packages/operator-core && npx vitest run lib/release/origin-freshness.test.ts
 */
import { describe, it, expect } from 'vitest';
import { selectOriginWatermark } from './origin-freshness-watchdog';
import {
  evaluateOriginFreshness,
  isIntegratorStalledThisSweep,
  originFreshness,
  describeOriginFreshnessAlert,
  describeOriginFreshnessRecovery,
  DEFAULT_AHEAD_COUNT_MAX,
  DEFAULT_TIP_AGE_STALE_MS,
  type OriginFreshnessSnapshot,
} from './origin-freshness';

const H = 3_600_000;

describe('evaluateOriginFreshness', () => {
  it('nothing ahead (aheadCount 0) ⇒ ok, regardless of tip age', () => {
    const v = evaluateOriginFreshness({ aheadCount: 0, originTipAgeMs: 100 * H });
    expect(v.state).toBe('ok');
    expect(v.aheadCountStale).toBe(false);
    expect(v.tipAgeStale).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('aheadCount null (unknown / fresh seed) ⇒ ok', () => {
    const v = evaluateOriginFreshness({ aheadCount: null, originTipAgeMs: null });
    expect(v.state).toBe('ok');
  });

  it('negative aheadCount (defensive: local behind origin) ⇒ ok', () => {
    const v = evaluateOriginFreshness({ aheadCount: -1, originTipAgeMs: 100 * H });
    expect(v.state).toBe('ok');
  });

  it('ahead but young + small ⇒ ok (healthy backlog between ticks)', () => {
    const v = evaluateOriginFreshness({ aheadCount: 3, originTipAgeMs: 5 * 60_000 });
    expect(v.state).toBe('ok');
    expect(v.aheadCountStale).toBe(false);
    expect(v.tipAgeStale).toBe(false);
  });

  it('EI-13924: tip frozen >3h while local stayed ahead ⇒ stale (tipAgeStale)', () => {
    const v = evaluateOriginFreshness({ aheadCount: 25, originTipAgeMs: 3 * H + 60_000 });
    expect(v.state).toBe('stale');
    expect(v.tipAgeStale).toBe(true);
    expect(v.reason).toMatch(/not advanced/);
    expect(v.reason).toMatch(/25 commit/);
  });

  it('tip age exactly at the threshold is NOT yet stale (strictly greater-than)', () => {
    const v = evaluateOriginFreshness({ aheadCount: 5, originTipAgeMs: DEFAULT_TIP_AGE_STALE_MS });
    expect(v.tipAgeStale).toBe(false);
  });

  it('a big pile-up alarms on aheadCount alone, even with a fresh/unknown tip clock', () => {
    const v = evaluateOriginFreshness({ aheadCount: DEFAULT_AHEAD_COUNT_MAX, originTipAgeMs: null });
    expect(v.state).toBe('stale');
    expect(v.aheadCountStale).toBe(true);
    expect(v.tipAgeStale).toBe(false);
    expect(v.reason).toMatch(/backlog is piling up/);
  });

  it('aheadCount just under the max ⇒ not aheadCount-stale', () => {
    const v = evaluateOriginFreshness({ aheadCount: DEFAULT_AHEAD_COUNT_MAX - 1, originTipAgeMs: null });
    expect(v.aheadCountStale).toBe(false);
    expect(v.state).toBe('ok');
  });

  it('both signals firing ⇒ reason names both', () => {
    const v = evaluateOriginFreshness({ aheadCount: 999, originTipAgeMs: 10 * H });
    expect(v.state).toBe('stale');
    expect(v.aheadCountStale).toBe(true);
    expect(v.tipAgeStale).toBe(true);
    expect(v.reason).toMatch(/backlog is piling up/);
    expect(v.reason).toMatch(/origin looks frozen/);
  });

  it('thresholds are overridable', () => {
    const snap: OriginFreshnessSnapshot = { aheadCount: 5, originTipAgeMs: 10 * 60_000 };
    expect(evaluateOriginFreshness(snap, { aheadCountMax: 5 }).state).toBe('stale');
    expect(evaluateOriginFreshness(snap, { tipAgeStaleMs: 5 * 60_000 }).state).toBe('stale');
    expect(evaluateOriginFreshness(snap, { aheadCountMax: 100, tipAgeStaleMs: H }).state).toBe('ok');
  });
});

describe('originFreshness (the WI-5607-sketched thin alias)', () => {
  it('returns just the state string', () => {
    expect(originFreshness({ aheadCount: 0, originTipAgeMs: null })).toBe('ok');
    expect(originFreshness({ aheadCount: 25, originTipAgeMs: 4 * H })).toBe('stale');
  });
});

/**
 * WI-5738 — the detector-failure regression.
 *
 * The 2026-07-20 wedge ran for FIVE DAYS with this watchdog running the whole
 * time. Both of its signals were structurally pinned healthy because the
 * watchdog measured against `github_default_branch` (= `main`, the branch the
 * bridge INGESTS) instead of `refs/heads/staging` (the branch it EGRESSES).
 * main is fast-forwarded hourly by the release pipeline, so:
 *   - aheadCount stayed ~24, under the 50 threshold, and
 *   - the tracked tip never aged past ~1h, under the 3h threshold,
 * while the real egress target sat 358 commits and 5 days behind.
 *
 * The watchdog now measures against the egress watermark, AND alarms on the
 * publish leg's own explicit refusal — which had been recorded on every single
 * tick at metadata.own_head_publish.refused and raised nothing at all.
 */
describe('WI-5738 — a sustained publish refusal alarms on its own', () => {
  it('alarms on a sustained refusal even when BOTH inferred signals read healthy', () => {
    // The exact shape of the incident as the watchdog saw it.
    const v = evaluateOriginFreshness({
      aheadCount: 24, // < 50: measured against main, which the release pipeline keeps fresh
      originTipAgeMs: 60 * 60 * 1000, // 1h: main moved an hour ago, so "fresh"
      publishRefusedSweeps: 5,
      publishRefusalCode: 'total-over-cap',
    });
    expect(v.state).toBe('stale');
    expect(v.publishRefused).toBe(true);
    expect(v.aheadCountStale).toBe(false); // both inferred signals still read OK…
    expect(v.tipAgeStale).toBe(false); // …which is precisely why it went unseen
    expect(v.reason).toMatch(/REFUSED/);
    expect(v.reason).toMatch(/total-over-cap/);
  });

  it('alarms on a refusal even when there is nothing to push (ahead <= 0)', () => {
    // A refusal is a direct self-report, so it must not be swallowed by the
    // "nothing to push ⇒ definitionally healthy" early return.
    const v = evaluateOriginFreshness({
      aheadCount: 0,
      originTipAgeMs: null,
      publishRefusedSweeps: 4,
      publishRefusalCode: 'secrets',
    });
    expect(v.state).toBe('stale');
    expect(v.publishRefused).toBe(true);
  });

  it('debounces a transient refusal below the sweep threshold', () => {
    const v = evaluateOriginFreshness({
      aheadCount: 1,
      originTipAgeMs: 0,
      publishRefusedSweeps: 1,
      publishRefusalCode: 'error',
    });
    expect(v.state).toBe('ok');
    expect(v.publishRefused).toBe(false);
  });

  it('a healthy pot with no refusal is unaffected (no new false alarms)', () => {
    const v = evaluateOriginFreshness({
      aheadCount: 3,
      originTipAgeMs: 60_000,
      publishRefusedSweeps: 0,
      publishRefusalCode: null,
    });
    expect(v.state).toBe('ok');
    expect(v.publishRefused).toBe(false);
    expect(v.reason).toBeNull();
  });
});

/**
 * WI-6643 — the alarm must NAME THE CAUSE IT FIRED ON.
 *
 * WI-5738 (above) made a publish refusal alarm. It alarmed correctly — and then
 * announced itself with a hardcoded origin-behind summary. The live 2026-07-28
 * broadcast, verbatim:
 *
 *   summary: "origin freshness STALLED on papercusp (bridged) — GitHub origin is
 *             falling behind local; bridge divergence classifier reports clear."
 *   body:    "the p2p publish leg has REFUSED to publish for 4 consecutive sweeps
 *             (secrets) — nothing this device commits is reaching peers or origin"
 *
 * The summary is the only line an agent sees in coord:inbox, and the body's
 * "why it matters" then told the responder to inspect metadata.github_bridge and
 * the integrator lease — a bridge that was working perfectly. It cost ~25min
 * chasing a non-existent egress outage while the real cause (a secrets finding,
 * clearable with pot_git:secrets_exemptions) sat unaddressed.
 *
 * A detector that identifies the cause correctly and then MISNAMES it in the one
 * line humans read has not detected anything useful.
 */
describe('WI-6643 — the alarm is named after the cause that fired', () => {
  const refusal = evaluateOriginFreshness({
    // The exact incident shape: the guard refused for 4 sweeps on a secrets finding.
    aheadCount: 12,
    originTipAgeMs: 5 * H,
    publishRefusedSweeps: 4,
    publishRefusalCode: 'secrets',
  });

  it('a publish refusal does NOT announce itself as a GitHub/bridge problem', () => {
    const f = describeOriginFreshnessAlert(refusal, {
      slug: 'papercusp',
      potHomeSlug: 'papercusp',
      publishRefusalCode: 'secrets',
    });
    expect(f.cause).toBe('publish-refused');
    // The regression: the summary must state the refusal, not origin lag.
    expect(f.summary).toMatch(/REFUSED/);
    expect(f.summary).toMatch(/secrets/);
    expect(f.title).toMatch(/REFUSED/);
    // …and must NOT reproduce the misdirection that cost the 25min.
    expect(f.summary).not.toMatch(/GitHub origin is falling behind/);
    expect(f.whyItMatters).not.toMatch(/metadata\.github_bridge/);
    expect(f.whyItMatters).not.toMatch(/integrator lease|lock-authority/);
  });

  it('a secrets refusal names the lever that actually clears it', () => {
    const f = describeOriginFreshnessAlert(refusal, {
      slug: 'papercusp',
      publishRefusalCode: 'secrets',
    });
    expect(f.whyItMatters).toMatch(/pot_git:secrets_exemptions/);
    // The trap that makes this class expensive: the blob is already in history,
    // so editing the file does not clear it.
    expect(f.whyItMatters).toMatch(/already in history/);
    // And it must not invite blanket-exempting a REAL credential.
    expect(f.whyItMatters).toMatch(/false positive/);
    expect(f.whyItMatters).toMatch(/rotate/);
  });

  it('a refusal outranks the inferred signals when both are stale', () => {
    // Origin IS behind here (12 commits, 5h stale) — but only because the publish
    // leg is refusing. Reporting the symptom would bury the cause, which is
    // exactly the failure this fixes.
    expect(refusal.publishRefused).toBe(true);
    expect(refusal.tipAgeStale).toBe(true);
    const f = describeOriginFreshnessAlert(refusal, { slug: 'papercusp', publishRefusalCode: 'secrets' });
    expect(f.cause).toBe('publish-refused');
  });

  it('a genuine origin-behind stall keeps its original framing and runbook', () => {
    // No regression for the case the watchdog was originally built for.
    const v = evaluateOriginFreshness({ aheadCount: 80, originTipAgeMs: 5 * H, publishRefusedSweeps: 0 });
    const f = describeOriginFreshnessAlert(v, { slug: 'papercusp', potHomeSlug: 'papercusp' });
    expect(f.cause).toBe('origin-behind');
    expect(f.summary).toMatch(/GitHub origin is falling behind/);
    expect(f.whyItMatters).toMatch(/metadata\.github_bridge/);
    expect(f.summary).not.toMatch(/REFUSED/);
  });

  it('an unknown refusal code still reports a refusal, without inventing a lever', () => {
    const v = evaluateOriginFreshness({ aheadCount: 1, originTipAgeMs: 0, publishRefusedSweeps: 9 });
    const f = describeOriginFreshnessAlert(v, { slug: 'somepot', publishRefusalCode: null });
    expect(f.cause).toBe('publish-refused');
    expect(f.summary).toMatch(/REFUSED/);
    expect(f.whyItMatters).not.toMatch(/pot_git:secrets_exemptions/);
  });

  it('recovery is worded for the cause that had alarmed', () => {
    // The 2026-07-28 recovery said "GitHub origin has caught back up" when what
    // had actually happened was a secrets exemption landing.
    expect(describeOriginFreshnessRecovery('publish-refused', 'papercusp')).toMatch(/publish RECOVERED/);
    expect(describeOriginFreshnessRecovery('publish-refused', 'papercusp')).not.toMatch(/caught back up/);
    expect(describeOriginFreshnessRecovery('origin-behind', 'papercusp')).toMatch(/caught back up/);
  });
});

describe('WI-5738 — selectOriginWatermark: which signal the watchdog trusts', () => {
  const EGRESS = 'a'.repeat(40);
  const OBSERVED = 'b'.repeat(40);
  const MIRROR = 'c'.repeat(40);

  it('prefers the real egress head over everything else', () => {
    expect(
      selectOriginWatermark({ egressHead: EGRESS, lastObserved: OBSERVED, ingressMirror: MIRROR }),
    ).toBe(EGRESS);
  });

  /**
   * The regression that matters. `github_bridge` metadata is replaced wholesale
   * every tick, so a tick that egressed nothing used to blank `egress_head`. If
   * the watchdog then fell straight back to the ingress mirror, ONE quiet tick
   * silently restored the blindness this whole incident was about — the mirror
   * is fast-forwarded hourly by the release pipeline, so it reports healthy
   * regardless of egress and resets the staleness clock.
   */
  it('falls back to its OWN last observation, never to the ingress mirror, when the egress head is momentarily absent', () => {
    expect(
      selectOriginWatermark({ egressHead: null, lastObserved: OBSERVED, ingressMirror: MIRROR }),
    ).toBe(OBSERVED);
  });

  it('keeps the clock RUNNING on a vanished signal — the fallback equals the previous sha, so nothing re-dates the tip', () => {
    // originSha === prevOriginSha ⇒ the watchdog does NOT restart the tip clock,
    // so a genuine wedge keeps ageing toward an alarm instead of being reset.
    const prev = OBSERVED;
    const picked = selectOriginWatermark({ egressHead: null, lastObserved: prev, ingressMirror: MIRROR });
    expect(picked).toBe(prev);
  });

  it('uses the ingress mirror ONLY when egress has never once reported', () => {
    expect(
      selectOriginWatermark({ egressHead: null, lastObserved: null, ingressMirror: MIRROR }),
    ).toBe(MIRROR);
  });

  it('reports null when there is no signal at all (never observed) rather than inventing one', () => {
    expect(
      selectOriginWatermark({ egressHead: null, lastObserved: null, ingressMirror: null }),
    ).toBeNull();
  });
});

describe('EI-19442274898324113 — an INTEGRATOR stall must not disable its own detector', () => {
  /**
   * The regression this whole block exists for. An integrator stall freezes canonical, and
   * origin freezes BECAUSE canonical did — so aheadCount is exactly 0 and every inferred
   * signal is structurally silenced. Live on papercusp 2026-08-03: ~5.4h / 28 commits with
   * of_alerted false and of_stall_sweeps 0, while sibling pots alarmed correctly.
   *
   * This is the exact shape the first test in this file ('nothing ahead ⇒ ok, regardless of
   * tip age') asserts as CORRECT behaviour — and it still is, for a genuinely idle pot. The
   * distinguishing evidence is the integrator backlog, which an idle pot does not have.
   */
  it('alarms with ahead===0 AND an aged tip — the exact live-frozen shape that reported healthy', () => {
    const v = evaluateOriginFreshness({
      aheadCount: 0, // canonical and origin frozen at the SAME sha
      originTipAgeMs: 5.4 * H, // aged well past tipAgeStaleMs, and unread until now
      integratorBacklogSweeps: 4,
      integratorBacklogCommits: 28,
    });
    expect(v.state).toBe('stale');
    expect(v.integratorBacklog).toBe(true);
    // The inferred signals stay honestly false — they genuinely cannot see this.
    expect(v.aheadCountStale).toBe(false);
    expect(v.tipAgeStale).toBe(false);
    expect(v.reason).toMatch(/INTEGRATOR/);
    expect(v.reason).toMatch(/28 commit/);
  });

  it('does NOT regress the idle pot: ahead===0 with no integrator backlog is still ok', () => {
    const v = evaluateOriginFreshness({
      aheadCount: 0,
      originTipAgeMs: 100 * H,
      integratorBacklogSweeps: 0,
    });
    expect(v.state).toBe('ok');
    expect(v.integratorBacklog).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('treats unknown backlog (pre-upgrade metadata) as healthy rather than guessing', () => {
    for (const sweeps of [null, undefined]) {
      const v = evaluateOriginFreshness({
        aheadCount: 0,
        originTipAgeMs: 100 * H,
        integratorBacklogSweeps: sweeps,
      } as OriginFreshnessSnapshot);
      expect(v.state).toBe('ok');
      expect(v.integratorBacklog).toBe(false);
    }
  });

  it('debounces a transient backlog below the sweep threshold (a tick or two ahead is normal)', () => {
    const v = evaluateOriginFreshness({
      aheadCount: 0,
      originTipAgeMs: 0,
      integratorBacklogSweeps: 3,
      integratorBacklogCommits: 2,
    });
    expect(v.state).toBe('ok');
    expect(v.integratorBacklog).toBe(false);
  });

  it('threshold is overridable', () => {
    const snap: OriginFreshnessSnapshot = {
      aheadCount: 0,
      originTipAgeMs: 0,
      integratorBacklogSweeps: 2,
    };
    expect(evaluateOriginFreshness(snap).integratorBacklog).toBe(false);
    expect(
      evaluateOriginFreshness(snap, { integratorBacklogSweepsMax: 2 }).integratorBacklog,
    ).toBe(true);
  });

  it('also alarms on the ahead>0 path, so a partially-advancing pipeline is still caught', () => {
    const v = evaluateOriginFreshness({
      aheadCount: 5, // some egress progress, but the integrator is still behind
      originTipAgeMs: 0,
      integratorBacklogSweeps: 4,
      integratorBacklogCommits: 12,
    });
    expect(v.state).toBe('stale');
    expect(v.integratorBacklog).toBe(true);
    expect(v.reason).toMatch(/INTEGRATOR/);
  });

  it('names the INTEGRATOR, not the publish leg or the bridge — the WI-6643 misdirection rule', () => {
    const v = evaluateOriginFreshness({
      aheadCount: 0,
      originTipAgeMs: 5 * H,
      integratorBacklogSweeps: 4,
      integratorBacklogCommits: 28,
    });
    const f = describeOriginFreshnessAlert(v, {
      slug: 'papercusp',
      potHomeSlug: 'papercusp',
      integratorBacklogCommits: 28,
    });
    expect(f.cause).toBe('integrator-backlog');
    expect(f.title).toMatch(/INTEGRATOR/);
    expect(f.summary).toMatch(/28 commit/);
    // Must not send the responder to the leg that is actually healthy.
    expect(f.summary).toMatch(/do not go looking at own_head_publish/i);
    // Must name the field that actually diagnoses it.
    expect(f.whyItMatters).toMatch(/integrator_status/);
  });

  it('an upstream publish fault still outranks it — a consequence must never bury its cause', () => {
    const v = evaluateOriginFreshness({
      aheadCount: 0,
      originTipAgeMs: 0,
      publishRefusedSweeps: 5,
      publishRefusalCode: 'secrets',
      integratorBacklogSweeps: 9,
    });
    expect(v.publishRefused).toBe(true);
    expect(v.integratorBacklog).toBe(true);
    // Both are true, but the alarm is named after the UPSTREAM stage.
    expect(describeOriginFreshnessAlert(v, { slug: 'papercusp' }).cause).toBe('publish-refused');
    // ...and the body still reports both, so nothing is hidden.
    expect(v.reason).toMatch(/REFUSED/);
    expect(v.reason).toMatch(/INTEGRATOR/);
  });

  it('recovery credits the INTEGRATOR, not origin — often the only durable record of a self-healed stall', () => {
    const msg = describeOriginFreshnessRecovery('integrator-backlog', 'papercusp');
    expect(msg).toMatch(/INTEGRATOR RECOVERED/);
    expect(msg).toMatch(/canonical/);
  });
});

describe('EI-19442274898324113 — isIntegratorStalledThisSweep: backlog alone is NOT a stall', () => {
  /**
   * The false-alarm guard. Thresholding on a bare "namespace is ahead" would alarm on every
   * healthy busy pot: git-sync commits every ~3 min, the watchdog sweeps every 15, so the
   * instantaneous delta is nonzero almost always. Measured on papercusp minutes AFTER the
   * 2026-08-03 incident fully cleared (canonical == origin, pipeline healthy): namespace was
   * STILL 4 commits ahead. The stall condition needs canonical to have STOOD STILL too.
   */
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);

  it('a HEALTHY busy pot (backlog present, canonical advancing) is NOT a stall — the live 4-ahead reading', () => {
    expect(
      isIntegratorStalledThisSweep({ backlogCommits: 4, canonicalSha: SHA_B, prevCanonicalSha: SHA_A }),
    ).toBe(false);
  });

  it('backlog present AND canonical pinned since the last sweep IS a stall — the live frozen shape', () => {
    expect(
      isIntegratorStalledThisSweep({ backlogCommits: 28, canonicalSha: SHA_A, prevCanonicalSha: SHA_A }),
    ).toBe(true);
  });

  it('canonical pinned but NOTHING to integrate is not a stall (an idle pot is allowed to sit still)', () => {
    for (const backlog of [0, null]) {
      expect(
        isIntegratorStalledThisSweep({ backlogCommits: backlog, canonicalSha: SHA_A, prevCanonicalSha: SHA_A }),
      ).toBe(false);
    }
  });

  it('an unreadable canonical is never a stall — absent evidence must not manufacture an alarm', () => {
    expect(
      isIntegratorStalledThisSweep({ backlogCommits: 99, canonicalSha: null, prevCanonicalSha: SHA_A }),
    ).toBe(false);
  });

  it('the first-ever observation is never a stall — a detector must not alarm on its own cold start', () => {
    expect(
      isIntegratorStalledThisSweep({ backlogCommits: 99, canonicalSha: SHA_A, prevCanonicalSha: null }),
    ).toBe(false);
  });

  it('a sustained stall stays true across consecutive sweeps, so the sweep counter can accumulate', () => {
    // Four consecutive sweeps with canonical pinned — what the ~5.4h live stall looked like.
    for (let i = 0; i < 4; i += 1) {
      expect(
        isIntegratorStalledThisSweep({ backlogCommits: 28 + i, canonicalSha: SHA_A, prevCanonicalSha: SHA_A }),
      ).toBe(true);
    }
    // Then the integrator moves — the very next sweep is healthy, resetting the counter.
    expect(
      isIntegratorStalledThisSweep({ backlogCommits: 2, canonicalSha: SHA_B, prevCanonicalSha: SHA_A }),
    ).toBe(false);
  });
});

/**
 * EI-21517899493871930 — the alarm must not claim ORIGIN impact from a p2p-publish signal.
 *
 * The p2p publish leg and `git push origin` are separate egress paths, so a refusal is
 * evidence about PEERS and nothing else. The live broadcast asserted both:
 *
 *   "p2p publish REFUSED on papercusp (secrets) — the publish guard is refusing every tick,
 *    so nothing this device commits reaches peers or origin."
 *
 * Measured on `papercusp` (hiveGit.mode = 'bridged') at 2026-08-26T12:16:38Z, within a minute
 * of that alarm and right after an explicit fetch: origin was ONE commit / ~3 minutes behind
 * local — ordinary git-sync cadence. The overstatement induced two CRITICAL filings that were
 * retracted after 114s (WI-40760, whose title carries the same conflation verbatim) and 63s
 * (EI-21201399884691584).
 *
 * The cost runs BOTH ways, which is why softer wording would not have been enough: an agent
 * who trusts it escalates an egress emergency that is not happening, and an agent who has once
 * falsified it starts discounting the alarm wholesale — including the p2p half that is really
 * broken. So the origin clause is MEASURED from the numbers the watchdog already holds, and
 * when there is no measurement the alarm says exactly that instead of guessing wide.
 */
describe('EI-21517899493871930 — a p2p-publish alarm reports the origin leg it measured, never one it inferred', () => {
  const refusalOriginHealthy = evaluateOriginFreshness({
    // The incident shape: guard refusing, origin one commit behind and freshly advanced.
    aheadCount: 1,
    originTipAgeMs: 3 * 60_000,
    publishRefusedSweeps: 4,
    publishRefusalCode: 'secrets',
  });

  it('never claims origin is affected — not in the summary, the title, or the verdict reason', () => {
    const f = describeOriginFreshnessAlert(refusalOriginHealthy, {
      slug: 'papercusp',
      publishRefusalCode: 'secrets',
      aheadCount: 1,
      originTipAgeMs: 3 * 60_000,
    });
    // The exact retracted claim, in the two shapes it was written.
    expect(f.summary).not.toMatch(/reach(es)? peers or origin/);
    expect(f.summary).not.toMatch(/reaching peers or origin/);
    // The title said "reaching nobody", which reads as origin too.
    expect(f.title).not.toMatch(/reaching nobody/);
    // …and the verdict `reason` fed the body of the same broadcast.
    expect(refusalOriginHealthy.reason ?? '').not.toMatch(/peers or origin/);
    // Positive control: it still reports the peer leg, or this test would pass on an empty string.
    expect(f.summary).toMatch(/PEERS/);
    expect(f.cause).toBe('publish-refused');
  });

  it('reports origin as UNAFFECTED, with the measurement, when origin is measurably fine', () => {
    const f = describeOriginFreshnessAlert(refusalOriginHealthy, {
      slug: 'papercusp',
      publishRefusalCode: 'secrets',
      aheadCount: 1,
      originTipAgeMs: 3 * 60_000,
    });
    expect(f.summary).toMatch(/UNAFFECTED/);
    // The numbers, not an adjective — a reader must be able to check the claim.
    expect(f.summary).toMatch(/1 commit\(s\) ahead/);
    // Sub-hour ages render as minutes: `hrs()` alone would print "0h", which reads as unknown.
    expect(f.summary).toMatch(/3m ago/);
  });

  it('reports origin as ALSO behind, with the measurement, when it genuinely is', () => {
    const both = evaluateOriginFreshness({
      aheadCount: 80,
      originTipAgeMs: 5 * 60 * 60_000,
      publishRefusedSweeps: 4,
      publishRefusalCode: 'secrets',
    });
    const f = describeOriginFreshnessAlert(both, {
      slug: 'papercusp',
      publishRefusalCode: 'secrets',
      aheadCount: 80,
      originTipAgeMs: 5 * 60 * 60_000,
    });
    // Still named after the CAUSE (WI-6643), while stating the wider radius honestly.
    expect(f.cause).toBe('publish-refused');
    expect(f.summary).toMatch(/ALSO measurably behind/);
    expect(f.summary).toMatch(/80 commit\(s\) ahead/);
    expect(f.summary).toMatch(/5h ago/);
    expect(f.summary).not.toMatch(/UNAFFECTED/);
  });

  it('says the origin leg is UNMEASURED rather than falling back to "affected"', () => {
    // The p2p-only pot path: the watchdog passes nulls because there is no origin to read.
    const v = evaluateOriginFreshness({
      aheadCount: null,
      originTipAgeMs: null,
      publishRefusedSweeps: 5,
      publishRefusalCode: 'secrets',
    });
    const f = describeOriginFreshnessAlert(v, {
      slug: 'somepot',
      publishRefusalCode: 'secrets',
      aheadCount: null,
      originTipAgeMs: null,
    });
    expect(f.summary).toMatch(/NOT measured/);
    expect(f.summary).not.toMatch(/UNAFFECTED/);
    expect(f.summary).not.toMatch(/ALSO measurably behind/);
    // Guessing wide is the failure mode this branch exists to prevent.
    expect(f.summary).not.toMatch(/peers or origin/);
  });

  it('CONTROL: the same assertions FAIL the pre-fix broadcast, so a green here is not vacuous', () => {
    // The deliberately-wrong "implementation", kept permanently as a control (the repo's
    // prescribed falsifiability tier for a module you import — mutating the shared tree to
    // prove a guard bites is unsafe here, because git-sync sweeps the whole checkout).
    //
    // These two strings are the VERBATIM live output of the code this test guards against —
    // the 2026-08-26 broadcast summary and the 2026-07-28 body. If the regexes above were
    // no-ops (a typo, a pattern that can never match), they would pass on the broken text too
    // and the suite would report a fix that never landed. That is the exact failure shape this
    // whole plan keeps meeting: a confirmation signal reporting success for a condition it
    // cannot observe.
    const PRE_FIX_SUMMARY =
      'p2p publish REFUSED on papercusp (secrets) — the publish guard is refusing every tick, so nothing this ' +
      'device commits reaches peers or origin. This is NOT a bridge/egress fault.';
    const PRE_FIX_TITLE = "p2p publish REFUSED (secrets) — this device's commits are reaching nobody";
    const PRE_FIX_REASON =
      'the p2p publish leg has REFUSED to publish for 4 consecutive sweeps (secrets)' +
      ' — nothing this device commits is reaching peers or origin';

    expect(PRE_FIX_SUMMARY).toMatch(/reaches peers or origin/);
    expect(PRE_FIX_TITLE).toMatch(/reaching nobody/);
    expect(PRE_FIX_REASON).toMatch(/peers or origin/);
    // The pre-fix text carried no measurement at all — neither branch of the new clause.
    expect(PRE_FIX_SUMMARY).not.toMatch(/UNAFFECTED|ALSO measurably behind|NOT measured/);

    // Calibration: the SAME patterns, run against what the fixed code actually emits today,
    // must come out the other way — otherwise the control proves nothing about the subject.
    const live = describeOriginFreshnessAlert(refusalOriginHealthy, {
      slug: 'papercusp',
      publishRefusalCode: 'secrets',
      aheadCount: 1,
      originTipAgeMs: 3 * 60_000,
    });
    expect(live.summary).not.toMatch(/reaches peers or origin/);
    expect(live.title).not.toMatch(/reaching nobody/);
    expect(refusalOriginHealthy.reason ?? '').not.toMatch(/peers or origin/);
    expect(live.summary).toMatch(/UNAFFECTED/);
  });

  it('omitting the origin fields entirely is UNMEASURED, not silently "unaffected"', () => {
    // Fail-safe for any caller that has not been taught to pass the measurement:
    // absence of evidence must never render as evidence of absence.
    const f = describeOriginFreshnessAlert(refusalOriginHealthy, {
      slug: 'papercusp',
      publishRefusalCode: 'secrets',
    });
    expect(f.summary).toMatch(/NOT measured/);
    expect(f.summary).not.toMatch(/UNAFFECTED/);
  });
});
