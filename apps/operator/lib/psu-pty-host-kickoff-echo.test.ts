/**
 * WI-10005331: the pre-submit Codex kickoff echo proof must accept a marker that lost
 * only its leading bytes, the same loss the post-submit native-transcript proof already
 * accepts (WI-10002745). Measured 2026-10-02: Codex resolver su-df88c37b echoed 49 of 50
 * marker characters with the tail visible; the exact proof waited ~557s and the host
 * dropped the kickoff, failing inbox-resolve run bulk-bf4040d6 with every item undecided.
 */
import { describe, expect, it } from 'vitest';

import { composerEchoMarkerHeadLoss, waitForPtyTextEcho } from '../scripts/psu-pty-host.mjs';

const MARKER = '⟦turn-origin:launch-kickoff nonce:87d062bd294b2da8⟧';
const CHROME = '› ';

describe('composerEchoMarkerHeadLoss', () => {
  it('returns null when the exact marker echoed (the exact proof owns that case)', () => {
    expect(composerEchoMarkerHeadLoss(MARKER, `${CHROME}${MARKER}`)).toBeNull();
  });

  it('counts the lost head when a suffix sits after composer chrome', () => {
    expect(composerEchoMarkerHeadLoss(MARKER, `${CHROME}${MARKER.slice(1)}`)).toBe(1);
    expect(composerEchoMarkerHeadLoss(MARKER, `${CHROME}${MARKER.slice(20)}`)).toBe(20);
  });

  it('rejects a marker that lost a MIDDLE byte: that is not head loss', () => {
    const middleLost = MARKER.slice(0, 10) + MARKER.slice(11);
    expect(composerEchoMarkerHeadLoss(MARKER, `${CHROME}${middleLost}`)).toBeNull();
  });

  it('rejects a suffix shorter than 8 nonce characters plus the closing bracket', () => {
    const shortest = MARKER.slice(-9); // 8 nonce chars + ⟧
    expect(composerEchoMarkerHeadLoss(MARKER, `${CHROME}${shortest}`)).toBe(MARKER.length - 9);
    expect(composerEchoMarkerHeadLoss(MARKER, `${CHROME}${shortest.slice(1)}`)).toBeNull();
  });

  it('rejects another nonce and a non-marker expectation', () => {
    expect(composerEchoMarkerHeadLoss(MARKER, `${CHROME}cd294b2da8⟧`)).toBeNull();
    expect(composerEchoMarkerHeadLoss('plain kickoff text', 'lain kickoff text')).toBeNull();
  });
});

describe('waitForPtyTextEcho (WI-10005331)', () => {
  it('confirms an exact echo without a head-loss count', async () => {
    const proof = await waitForPtyTextEcho({ read: () => `${CHROME}${MARKER}`, text: MARKER, timeoutMs: 500, pollMs: 5 });
    expect(proof.echoed).toBe(true);
    expect(proof.markerHeadLost).toBeUndefined();
  });

  it('confirms a head-lost echo after the grace window instead of waiting out the budget', async () => {
    const started = Date.now();
    const proof = await waitForPtyTextEcho({
      read: () => `${CHROME}${MARKER.slice(1)}`,
      text: MARKER,
      timeoutMs: 10_000,
      pollMs: 5,
      headLossGraceMs: 40,
    });
    expect(proof).toMatchObject({ echoed: true, markerHeadLost: 1, observedChars: CHROME.length + MARKER.length - 1, markerTailSeen: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('lets an exact echo that completes inside the grace window win over head loss', async () => {
    let reads = 0;
    const proof = await waitForPtyTextEcho({
      read: () => (++reads < 3 ? `${CHROME}${MARKER.slice(1)}` : `${CHROME}${MARKER}`),
      text: MARKER,
      timeoutMs: 2_000,
      pollMs: 5,
      headLossGraceMs: 1_000,
    });
    expect(proof.echoed).toBe(true);
    expect(proof.markerHeadLost).toBeUndefined();
  });

  it('still times out on a middle-byte loss and reports the visible tail as evidence', async () => {
    const middleLost = MARKER.slice(0, 10) + MARKER.slice(11);
    const proof = await waitForPtyTextEcho({
      read: () => `${CHROME}${middleLost}`,
      text: MARKER,
      timeoutMs: 120,
      pollMs: 5,
      headLossGraceMs: 20,
    });
    expect(proof).toMatchObject({ echoed: false, reason: 'timeout', markerTailSeen: true });
    expect(proof.visibleTail).toBe(`${CHROME}${middleLost}`.slice(-80));
  });
});
