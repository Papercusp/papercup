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
