/**
 * fleet-monitors-peer-silence.test.ts — EI-20579195481991931.
 *
 * `scanOutboxHealth` is host-local by construction: it reads only THIS host's
 * `substrate_outbox`, so a PEER that stops federating is invisible to it.
 * Measured 2026-08-16: peer machine B sat 100% undrained (5,832 rows, oldest
 * 48h) while host A read 0 undrained and filed nothing.
 *
 * `judgePeerFederationSilence` is the verdict layer of the replacement signal
 * (per-remote-log fold progress from `substrate_merge_cursor`). It is pure, so
 * the interesting property is testable without PG — and the interesting property
 * is NOT "does it notice a stale log". It is the discrimination:
 *
 *   SOME logs silent  ⇒ those PEERS went quiet (the still-advancing logs are the
 *                       positive control that licenses that reading).
 *   EVERY log silent  ⇒ the control is GONE, so the reading is WITHDRAWN and we
 *                       blame our own fold instead of emitting N peer alarms.
 *
 * `wrongJudge` below is a permanent deliberately-wrong control implementing the
 * obvious version (every stale log is a peer alarm). It stays in the file so the
 * discrimination property is demonstrably falsifiable — no tree mutation needed.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { judgePeerFederationSilence, scanPeerFederationSilence, type MergeCursorRow } from './fleet-monitors';

const NOW = 1_700_000_000_000;
const SLO = 6 * 60 * 60_000; // 6h

/** A log last advanced `hoursAgo` hours before NOW. */
function log(keyHex: string, hoursAgo: number, position = 42): MergeCursorRow {
  return { logKeyHex: keyHex, position, updatedAtMs: NOW - hoursAgo * 60 * 60_000 };
}

/**
 * THE CONTROL — deliberately wrong on purpose, permanently. It is the naive
 * reading: any stale log is a peer alarm, with no all-silent carve-out. The
 * property tests below assert the real subject differs from it exactly where it
 * matters; if the subject ever regresses to this behaviour, those tests fail.
 */
function wrongJudge(rows: readonly MergeCursorRow[], opts: { silentAfterMs: number; nowMs: number }): string[] {
  return rows
    .filter((r) => opts.nowMs - r.updatedAtMs > opts.silentAfterMs)
    .map((r) => `peer ${r.logKeyHex} silent`);
}

describe('judgePeerFederationSilence — EI-20579195481991931', () => {
  it('reports a quiet peer while other logs keep advancing, and names it', () => {
    const rows = [log('aaaa111122223333', 48), log('bbbb', 0.1), log('cccc', 0.2)];
    const v = judgePeerFederationSilence(rows, { silentAfterMs: SLO, nowMs: NOW });

    expect(v.measured).toBe(true);
    expect(v.totalLogs).toBe(3);
    expect(v.allSilent).toBe(false);
    expect(v.silent).toHaveLength(1);
    expect(v.silent[0]!.logKeyHex).toBe('aaaa111122223333');
    expect(v.silent[0]!.silentForMs).toBe(48 * 60 * 60_000);
    expect(v.breaches).toHaveLength(1);
    expect(v.breaches[0]).toContain('1 of 3');
    // The still-advancing logs are cited — that is the positive control the
    // per-peer reading rests on, so it belongs in the operator-facing text.
    expect(v.breaches[0]).toContain('2 log(s) keep advancing');
    expect(v.breaches[0]).not.toContain('LOCAL FOLD SUSPECT');
  });

  it('WITHDRAWS the per-peer reading when EVERY log is silent and blames the local fold instead', () => {
    const rows = [log('aaaa', 48), log('bbbb', 50), log('cccc', 72)];
    const v = judgePeerFederationSilence(rows, { silentAfterMs: SLO, nowMs: NOW });

    expect(v.allSilent).toBe(true);
    expect(v.silent).toHaveLength(3);
    // ONE verdict about US — not three alarms about them.
    expect(v.breaches).toHaveLength(1);
    expect(v.breaches[0]).toContain('LOCAL FOLD SUSPECT');
    expect(v.breaches[0]).toContain("NOT the peers");
    expect(v.freshestAdvanceMs).toBe(48 * 60 * 60_000);

    // FALSIFIABILITY: the naive control emits one alarm per stale log here. The
    // subject must NOT — if these two ever agree, the discrimination is gone.
    const control = wrongJudge(rows, { silentAfterMs: SLO, nowMs: NOW });
    expect(control).toHaveLength(3);
    expect(v.breaches.length).not.toBe(control.length);
  });

  it('CALIBRATION: subject and control agree on the ordinary some-silent case', () => {
    // Without this, the test above could pass simply because the subject never
    // reports anything — the controls must coincide where they should.
    const rows = [log('aaaa', 48), log('bbbb', 0.1)];
    const v = judgePeerFederationSilence(rows, { silentAfterMs: SLO, nowMs: NOW });
    const control = wrongJudge(rows, { silentAfterMs: SLO, nowMs: NOW });
    expect(v.silent.map((s) => s.logKeyHex)).toEqual(['aaaa']);
    expect(control).toHaveLength(1);
  });

  it('does NOT accuse peers (or our fold) in a scope WE stopped writing to', () => {
    // The real shape this prevents, measured on host A: harness `sheets` held
    // 75/75 logs silent while our own newest write was ~44h old. Without the
    // dormancy control that is a permanent "LOCAL FOLD SUSPECT" major bug about
    // a harness nobody uses, in a dedup bucket that never closes.
    const rows = [log('aaaa', 100), log('bbbb', 120), log('cccc', 140)];
    const dormant = judgePeerFederationSilence(rows, {
      silentAfterMs: SLO,
      nowMs: NOW,
      localActivityAgeMs: 44 * 60 * 60_000,
    });
    expect(dormant.measured).toBe(false);
    expect(dormant.unmeasuredReason).toBe('scope-dormant');
    expect(dormant.breaches).toEqual([]);
    expect(dormant.allSilent).toBe(false);

    // CONTROL: the identical rows in a scope we ARE still writing to must fire.
    // Same logs, same clock — only our own liveness differs, which is exactly
    // the variable the gate is supposed to key on.
    const live = judgePeerFederationSilence(rows, {
      silentAfterMs: SLO,
      nowMs: NOW,
      localActivityAgeMs: 60_000,
    });
    expect(live.measured).toBe(true);
    expect(live.breaches).toHaveLength(1);
    expect(live.breaches[0]).toContain('LOCAL FOLD SUSPECT');
  });

  it('treats "we never wrote here at all" (Infinity) as dormant, not as unknown', () => {
    // The scan passes Infinity when the scope has NO local writes whatsoever.
    // Measured on host A, the null-means-judge reading filed ~10 false majors
    // for scopes we never joined (`sheets` 75/75 silent, `papercup` 984h).
    const rows = [log('aaaa', 100), log('bbbb', 984)];
    const v = judgePeerFederationSilence(rows, {
      silentAfterMs: SLO,
      nowMs: NOW,
      localActivityAgeMs: Number.POSITIVE_INFINITY,
    });
    expect(v.measured).toBe(false);
    expect(v.unmeasuredReason).toBe('scope-dormant');
    expect(v.breaches).toEqual([]);
  });

  it('judges normally when our own activity is unknown rather than silently skipping', () => {
    // null must mean "no dormancy evidence, so judge", NOT "assume dormant" —
    // the latter would re-open the exact blind spot this whole scan closes.
    const rows = [log('aaaa', 48), log('bbbb', 0.1)];
    const unknown = judgePeerFederationSilence(rows, {
      silentAfterMs: SLO,
      nowMs: NOW,
      localActivityAgeMs: null,
    });
    expect(unknown.measured).toBe(true);
    expect(unknown.silent).toHaveLength(1);
    expect(unknown.breaches).toHaveLength(1);
  });

  it('treats NO remote logs as UNMEASURED, never as healthy', () => {
    const v = judgePeerFederationSilence([], { silentAfterMs: SLO, nowMs: NOW });
    expect(v.measured).toBe(false);
    expect(v.unmeasuredReason).toBe('no-remote-logs');
    expect(v.totalLogs).toBe(0);
    expect(v.breaches).toEqual([]);
    expect(v.freshestAdvanceMs).toBeNull();
    // The distinction that matters: a caller must be able to tell this apart
    // from a genuinely clean scan, which also has zero breaches.
    const clean = judgePeerFederationSilence([log('aaaa', 0.1)], { silentAfterMs: SLO, nowMs: NOW });
    expect(clean.breaches).toEqual([]);
    expect(clean.measured).toBe(true);
    expect(clean.unmeasuredReason).toBeNull();
    expect(v.measured).not.toBe(clean.measured);
  });

  it('stays quiet when every log is advancing', () => {
    const rows = [log('aaaa', 0.1), log('bbbb', 1), log('cccc', 5.9)];
    const v = judgePeerFederationSilence(rows, { silentAfterMs: SLO, nowMs: NOW });
    expect(v.silent).toEqual([]);
    expect(v.allSilent).toBe(false);
    expect(v.breaches).toEqual([]);
    expect(v.measured).toBe(true);
  });

  it('is strict at the SLO boundary — exactly-at-SLO is not yet silent', () => {
    const exact: MergeCursorRow = { logKeyHex: 'aaaa', position: 1, updatedAtMs: NOW - SLO };
    const over: MergeCursorRow = { logKeyHex: 'bbbb', position: 1, updatedAtMs: NOW - SLO - 1 };
    expect(judgePeerFederationSilence([exact], { silentAfterMs: SLO, nowMs: NOW }).silent).toEqual([]);
    expect(judgePeerFederationSilence([over], { silentAfterMs: SLO, nowMs: NOW }).silent).toHaveLength(1);
  });

  it('orders silent logs worst-first and carries the fold position as forensics', () => {
    const rows = [log('mid', 20, 7), log('worst', 90, 0), log('fresh', 0.1, 900)];
    const v = judgePeerFederationSilence(rows, { silentAfterMs: SLO, nowMs: NOW });
    expect(v.silent.map((s) => s.logKeyHex)).toEqual(['worst', 'mid']);
    // position 0 = we never folded anything from that log at all — a materially
    // different story from "it advanced, then stopped", so it must survive.
    expect(v.silent[0]!.position).toBe(0);
    expect(v.silent[1]!.position).toBe(7);
  });

  it('degrades to UNMEASURED — never throwing, never "healthy" — when the scan itself fails', async () => {
    // This leg was added to a pass whose OTHER scans already worked, and the
    // caller wraps the whole pass in one try/catch: a throw here would silently
    // take outbox-health, double-completion and the orphan sweep down with it.
    // Caught for real — the composition rig's sliced schema lacked
    // substrate_merge_cursor and killed the entire pass with 42P01.
    const boom = (() => {
      throw new Error('relation "harness_shared.substrate_merge_cursor" does not exist');
    }) as unknown as postgres.Sql;

    const v = await scanPeerFederationSilence(boom, {
      workspaceId: 'ws',
      harness: 'h',
      silentAfterMs: SLO,
      nowMs: NOW,
    });

    expect(v.measured).toBe(false);
    expect(v.unmeasuredReason).toBe('scan-failed');
    expect(v.scanError).toContain('substrate_merge_cursor');
    // Degrades to UNMEASURED, which is NOT the same as a clean scan — the whole
    // point is that a broken instrument must never read as a healthy one.
    expect(v.breaches).toEqual([]);
    expect(v.allSilent).toBe(false);
  });

  it('never reports a negative age when a peer clock runs ahead of ours', () => {
    const future: MergeCursorRow = { logKeyHex: 'aaaa', position: 1, updatedAtMs: NOW + 60_000 };
    const v = judgePeerFederationSilence([future], { silentAfterMs: SLO, nowMs: NOW });
    expect(v.freshestAdvanceMs).toBe(0);
    expect(v.silent).toEqual([]);
  });
});
