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

/** The binding the fold is currently running with, for rows meant to be judged. */
const LIVE_BINDING = 'papercusp';

/** A log last advanced `hoursAgo` hours before NOW, under the LIVE binding. */
function log(
  keyHex: string,
  hoursAgo: number,
  position = 42,
  applyBinding: string | null = LIVE_BINDING,
): MergeCursorRow {
  return { logKeyHex: keyHex, position, updatedAtMs: NOW - hoursAgo * 60 * 60_000, applyBinding };
}

/**
 * THE CONTROL — deliberately wrong on purpose, permanently. It is the naive
 * reading: any stale log is a peer alarm, with no all-silent carve-out.
 *
 * It accepts the full option bag and IGNORES `ownLogKeyHex` / `applyBinding` /
 * `localActivityAgeMs` on purpose. That is not laziness — ignoring them IS the
 * pre-fix behaviour for all three properties this file guards (naive staleness,
 * apply_binding residue, and own-log-as-phantom-peer), so one control falsifies
 * every one of them. The property tests assert the real subject differs from it
 * exactly where it matters; if the subject ever regresses, those tests fail.
 */
function wrongJudge(
  rows: readonly MergeCursorRow[],
  opts: {
    silentAfterMs: number;
    nowMs: number;
    ownLogKeyHex?: string | null;
    localActivityAgeMs?: number | null;
  },
): string[] {
  return rows
    .filter((r) => opts.nowMs - r.updatedAtMs > opts.silentAfterMs)
    .map((r) => `peer ${r.logKeyHex} silent`);
}

describe('judgePeerFederationSilence — EI-20579195481991931', () => {
  it('reports a quiet peer while other logs keep advancing, and names it', () => {
    const rows = [log('aaaa111122223333', 48), log('bbbb', 0.1), log('cccc', 0.2)];
    const v = judgePeerFederationSilence(rows, { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });

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
    const v = judgePeerFederationSilence(rows, { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });

    expect(v.allSilent).toBe(true);
    expect(v.silent).toHaveLength(3);
    // ONE verdict about US — not three alarms about them.
    expect(v.breaches).toHaveLength(1);
    expect(v.breaches[0]).toContain('LOCAL FOLD SUSPECT');
    expect(v.breaches[0]).toContain("NOT the peers");
    expect(v.freshestAdvanceMs).toBe(48 * 60 * 60_000);

    // FALSIFIABILITY: the naive control emits one alarm per stale log here. The
    // subject must NOT — if these two ever agree, the discrimination is gone.
    const control = wrongJudge(rows, { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });
    expect(control).toHaveLength(3);
    expect(v.breaches.length).not.toBe(control.length);
  });

  it('CALIBRATION: subject and control agree on the ordinary some-silent case', () => {
    // Without this, the test above could pass simply because the subject never
    // reports anything — the controls must coincide where they should.
    const rows = [log('aaaa', 48), log('bbbb', 0.1)];
    const v = judgePeerFederationSilence(rows, { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });
    const control = wrongJudge(rows, { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });
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
      ownLogKeyHex: null,
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
      ownLogKeyHex: null,
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
      ownLogKeyHex: null,
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
      ownLogKeyHex: null,
      localActivityAgeMs: null,
    });
    expect(unknown.measured).toBe(true);
    expect(unknown.silent).toHaveLength(1);
    expect(unknown.breaches).toHaveLength(1);
  });

  it('treats NO remote logs as UNMEASURED, never as healthy', () => {
    const v = judgePeerFederationSilence([], { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });
    expect(v.measured).toBe(false);
    expect(v.unmeasuredReason).toBe('no-remote-logs');
    expect(v.totalLogs).toBe(0);
    expect(v.breaches).toEqual([]);
    expect(v.freshestAdvanceMs).toBeNull();
    // The distinction that matters: a caller must be able to tell this apart
    // from a genuinely clean scan, which also has zero breaches.
    const clean = judgePeerFederationSilence([log('aaaa', 0.1)], { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });
    expect(clean.breaches).toEqual([]);
    expect(clean.measured).toBe(true);
    expect(clean.unmeasuredReason).toBeNull();
    expect(v.measured).not.toBe(clean.measured);
  });

  it('stays quiet when every log is advancing', () => {
    const rows = [log('aaaa', 0.1), log('bbbb', 1), log('cccc', 5.9)];
    const v = judgePeerFederationSilence(rows, { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });
    expect(v.silent).toEqual([]);
    expect(v.allSilent).toBe(false);
    expect(v.breaches).toEqual([]);
    expect(v.measured).toBe(true);
  });

  it('is strict at the SLO boundary — exactly-at-SLO is not yet silent', () => {
    const exact: MergeCursorRow = {
      logKeyHex: 'aaaa',
      position: 1,
      updatedAtMs: NOW - SLO,
      applyBinding: LIVE_BINDING,
    };
    const over: MergeCursorRow = {
      logKeyHex: 'bbbb',
      position: 1,
      updatedAtMs: NOW - SLO - 1,
      applyBinding: LIVE_BINDING,
    };
    expect(judgePeerFederationSilence([exact], { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null }).silent).toEqual([]);
    expect(judgePeerFederationSilence([over], { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null }).silent).toHaveLength(1);
  });

  it('orders silent logs worst-first and carries the fold position as forensics', () => {
    const rows = [log('mid', 20, 7), log('worst', 90, 0), log('fresh', 0.1, 900)];
    const v = judgePeerFederationSilence(rows, { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });
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
    const future: MergeCursorRow = {
      logKeyHex: 'aaaa',
      position: 1,
      updatedAtMs: NOW + 60_000,
      applyBinding: LIVE_BINDING,
    };
    const v = judgePeerFederationSilence([future], { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });
    expect(v.freshestAdvanceMs).toBe(0);
    expect(v.silent).toEqual([]);
  });
});

/**
 * EI-20617273180156712 — the detector and the thing it watches must read the
 * SAME population.
 *
 * `pg-merge-cursor-store.load` selects with `apply_binding IS NOT DISTINCT FROM
 * <binding>`. This judge had no such predicate, so it judged rows the fold can
 * never load, never advance, and never clear. Migration 685 (applied 2026-07-27)
 * introduced the column; the 15 cursors written before it froze under NULL and
 * became permanently unreachable residue.
 *
 * `wrongJudge` above is the exact pre-fix behaviour for this property too — it
 * has no binding predicate — so it doubles as this block's permanent control.
 */
describe('judgePeerFederationSilence — EI-20617273180156712 (apply_binding residue)', () => {
  /** 15 pre-685 cursors, all frozen ~21.4d, none reachable by the fold. */
  const stranded = Array.from({ length: 15 }, (_, i) => log(`dead${i}`, 21.4 * 24, 5, null));
  /** 6 live-binding cursors: 5 genuinely over SLO, 1 still advancing. */
  const live = [
    log('slow0', 48),
    log('slow1', 50),
    log('slow2', 52),
    log('slow3', 54),
    log('slow4', 56),
    log('advancing', 0.1),
  ];

  it('judges ONLY the live-binding population — the measured 20-of-21 false major becomes 5 of 6', () => {
    const v = judgePeerFederationSilence([...stranded, ...live], { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });

    // The denominator is the population the fold actually maintains.
    expect(v.totalLogs).toBe(6);
    expect(v.strandedCursors).toBe(15);
    expect(v.liveApplyBinding).toBe(LIVE_BINDING);
    expect(v.silent).toHaveLength(5);
    expect(v.breaches[0]).toContain('5 of 6');
    // The fabricated headline must be gone in BOTH its parts: the count, and
    // the 21.4-day "oldest" that only ever came from a corpse.
    expect(v.breaches[0]).not.toContain('20 of 21');
    expect(v.silent.some((s) => s.logKeyHex.startsWith('dead'))).toBe(false);
    expect(v.silent[0]!.silentForMs).toBe(56 * 60 * 60_000);
  });

  it('FALSIFIABILITY: the no-predicate control still reports all 20 — the subject must not agree', () => {
    const rows = [...stranded, ...live];
    const control = wrongJudge(rows, { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });
    const v = judgePeerFederationSilence(rows, { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });

    // The control IS the defect: 15 corpses + 5 slow live logs.
    expect(control).toHaveLength(20);
    expect(v.silent.length).not.toBe(control.length);
    expect(v.silent).toHaveLength(5);
  });

  it('CALIBRATION: with no residue present the two agree, so the test above cannot pass vacuously', () => {
    const v = judgePeerFederationSilence(live, { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });
    const control = wrongJudge(live, { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });
    expect(v.silent).toHaveLength(5);
    expect(control).toHaveLength(5);
    expect(v.strandedCursors).toBe(0);
  });

  it('treats a NULL binding as a LEGITIMATE live value, not as residue', () => {
    // A non-hive harness folds with applyBinding=null for every row. Excluding
    // on truthiness rather than on disagreement would blind the detector
    // completely there — the opposite failure, and a silent one.
    const rows = [log('a', 48, 1, null), log('b', 50, 2, null), log('c', 0.1, 3, null)];
    const v = judgePeerFederationSilence(rows, { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });

    expect(v.liveApplyBinding).toBeNull();
    expect(v.totalLogs).toBe(3);
    expect(v.strandedCursors).toBe(0);
    expect(v.measured).toBe(true);
    expect(v.silent).toHaveLength(2);
  });

  it('reports residue rather than dropping it silently, and says what it is', () => {
    const v = judgePeerFederationSilence([...stranded, ...live], { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });
    // Excluded-and-invisible would just move the bug: nobody would ever learn
    // the rows need cleaning up.
    expect(v.breaches[0]).toContain('15 further cursor(s) ignored');
    expect(v.breaches[0]).toContain('schema residue, not peers');
  });

  it('computes allSilent over the JUDGED population, so residue cannot mask a real local-fold fault', () => {
    // Every live log silent + 15 corpses. Judging the union would make
    // allSilent false (21 rows, 20 silent) and emit peer alarms instead of the
    // one verdict that matters: our own fold is wedged.
    const allDead = live.map((r) => ({ ...r, updatedAtMs: NOW - 48 * 60 * 60_000 }));
    const v = judgePeerFederationSilence([...stranded, ...allDead], { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });

    expect(v.allSilent).toBe(true);
    expect(v.breaches).toHaveLength(1);
    expect(v.breaches[0]).toContain('LOCAL FOLD SUSPECT');
    expect(v.breaches[0]).toContain('all 6 remote log(s)');
    expect(v.breaches[0]).toContain('15 further cursor(s) ignored');
  });

  it('picks the live binding from the freshest row, so a rebind needs no code change', () => {
    // The binding is read from the data precisely so this judge cannot drift
    // out of agreement with the fold. A future rebind must therefore just work.
    const rows = [log('old0', 300, 1, 'papercusp'), log('old1', 320, 2, 'papercusp'), log('new', 0.1, 3, 'rebound')];
    const v = judgePeerFederationSilence(rows, { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: null });

    expect(v.liveApplyBinding).toBe('rebound');
    expect(v.totalLogs).toBe(1);
    expect(v.strandedCursors).toBe(2);
    expect(v.silent).toEqual([]);
  });
});

/**
 * THE OWN LOG IS NOT A PEER.
 *
 * `substrate_merge_cursor` holds a row for our OWN log alongside the remote
 * ones, and the module comment claimed "one row per REMOTE log" — so the judge
 * counted it as a peer. Our own row is re-stamped by our own writes, making it
 * an ETERNALLY-ADVANCING log: it permanently supplies the "positive control"
 * that licenses the per-peer reading, so the all-silent branch — the entire
 * point of the discrimination — could never fire on a host still writing.
 *
 * Measured 2026-08-16 on host A: ZERO remote logs admitted in all 95 booted
 * scopes, yet `papercusp` reported "5 of 6 remote log(s) silent ... while 1
 * log(s) keep advancing" (the 1 was us) instead of LOCAL FOLD SUSPECT, while
 * `hive-canary` — where our own log was ALSO stale, because we stopped writing
 * there — did reach the local verdict. One condition, two verdicts, neither
 * naming the cause.
 */
describe('judgePeerFederationSilence — own log is not a peer', () => {
  const OWN = 'own5b00878b7df0';

  /** The measured host-A `papercusp` shape: our own log + 5 silent remote logs. */
  const hostA = () => [
    log(OWN, 0), // us, advancing right now
    log('peer1e847ce7104b', 13.18),
    log('peerda0f8e3e99b0', 52.82),
    log('peeref7a81605440', 69.82),
    log('peerc47f6610fb0a', 82.61),
    log('peer3229ad4b3b99', 82.61),
  ];

  it('REPRODUCTION: the measured 5-of-6 false peer reading becomes LOCAL FOLD SUSPECT', () => {
    const v = judgePeerFederationSilence(hostA(), {
      silentAfterMs: SLO,
      nowMs: NOW,
      ownLogKeyHex: OWN,
    });

    // Five REMOTE logs — our own is not one of them.
    expect(v.totalLogs).toBe(5);
    expect(v.silent).toHaveLength(5);
    expect(v.silent.map((s) => s.logKeyHex)).not.toContain(OWN);
    expect(v.allSilent).toBe(true);
    expect(v.breaches).toHaveLength(1);
    expect(v.breaches[0]).toContain('LOCAL FOLD SUSPECT');
    // The exact false clauses that shipped, in the operator-facing text.
    expect(v.breaches[0]).not.toContain('5 of 6');
    expect(v.breaches[0]).not.toContain('keep advancing');
    // Our own liveness is still REPORTED — excluded from the peer verdict, not lost.
    expect(v.ownLogSilentForMs).toBe(0);
  });

  it('FALSIFIABILITY: counting the own log is what produced the old reading', () => {
    // Same rows, own log NOT identified: the judge must refuse rather than
    // reproduce the false 5-of-6. And the naive control — which ignores
    // ownLogKeyHex, i.e. IS the pre-fix behaviour — still alarms on 5 logs.
    const blind = judgePeerFederationSilence(hostA(), { silentAfterMs: SLO, nowMs: NOW });
    expect(blind.measured).toBe(false);
    expect(blind.unmeasuredReason).toBe('own-log-unknown');
    expect(blind.breaches).toEqual([]);

    const control = wrongJudge(hostA(), { silentAfterMs: SLO, nowMs: NOW, ownLogKeyHex: OWN });
    expect(control).toHaveLength(5);

    // The subject must NOT agree with the control's shape.
    const v = judgePeerFederationSilence(hostA(), {
      silentAfterMs: SLO,
      nowMs: NOW,
      ownLogKeyHex: OWN,
    });
    expect(v.breaches.length).not.toBe(control.length);
  });

  it('CALIBRATION: a genuinely advancing PEER still licenses the per-peer reading', () => {
    // Without this the test above could pass because the subject reports
    // LOCAL FOLD SUSPECT for everything. Add one live peer and the verdict must
    // swing back to the per-peer reading — with the own log out of BOTH counts.
    const rows = [...hostA(), log('peerLIVE', 0.1)];
    const v = judgePeerFederationSilence(rows, {
      silentAfterMs: SLO,
      nowMs: NOW,
      ownLogKeyHex: OWN,
    });
    expect(v.allSilent).toBe(false);
    expect(v.totalLogs).toBe(6); // 6 REMOTE logs, not 7 rows
    expect(v.breaches[0]).toContain('5 of 6');
    expect(v.breaches[0]).toContain('1 log(s) keep advancing');
    expect(v.breaches[0]).not.toContain('LOCAL FOLD SUSPECT');
  });

  it('reports OWN-LOG-ONLY as unmeasured — not healthy, and not a peer breach', () => {
    // The honest shape of "we have admitted no peers in this scope", which is
    // what host A actually was in every one of its 95 scopes. It must not read
    // as a clean bill of health, and must not manufacture a peer alarm.
    const v = judgePeerFederationSilence([log(OWN, 0)], {
      silentAfterMs: SLO,
      nowMs: NOW,
      ownLogKeyHex: OWN,
    });
    expect(v.measured).toBe(false);
    expect(v.unmeasuredReason).toBe('own-log-only');
    expect(v.totalLogs).toBe(0);
    expect(v.breaches).toEqual([]);
    expect(v.allSilent).toBe(false);
    expect(v.ownLogSilentForMs).toBe(0);
  });

  it('still reports our own STALE log when the scope holds nothing else', () => {
    // hive-canary's shape once the peers are excluded: we stopped writing there,
    // so our own cursor is stale too. That is a LOCAL reading, and dropping it
    // would hide the one fact distinguishing this from an active scope.
    const v = judgePeerFederationSilence([log(OWN, 13.41)], {
      silentAfterMs: SLO,
      nowMs: NOW,
      ownLogKeyHex: OWN,
    });
    expect(v.unmeasuredReason).toBe('own-log-only');
    expect(v.ownLogSilentForMs).toBe(13.41 * 60 * 60_000);
  });

  it('distinguishes "no own log here" (null) from "could not determine it" (undefined)', () => {
    // null is a determination — judge all rows as peers. undefined is ignorance —
    // refuse. Collapsing the two is how a failed lookup silently reinstates the
    // phantom peer this whole property exists to remove.
    const rows = [log('aaaa', 48), log('bbbb', 0.1)];
    const determined = judgePeerFederationSilence(rows, {
      silentAfterMs: SLO,
      nowMs: NOW,
      ownLogKeyHex: null,
    });
    expect(determined.measured).toBe(true);
    expect(determined.totalLogs).toBe(2);

    const ignorant = judgePeerFederationSilence(rows, { silentAfterMs: SLO, nowMs: NOW });
    expect(ignorant.measured).toBe(false);
    expect(ignorant.unmeasuredReason).toBe('own-log-unknown');
  });

  it('excludes the own log BEFORE the dormancy check, so a dormant scope is peer-only', () => {
    // Ordering matters: if the own log were still in the population here, a
    // dormant scope would report totalLogs one too high forever.
    const v = judgePeerFederationSilence(hostA(), {
      silentAfterMs: SLO,
      nowMs: NOW,
      ownLogKeyHex: OWN,
      localActivityAgeMs: 44 * 60 * 60_000,
    });
    expect(v.unmeasuredReason).toBe('scope-dormant');
    expect(v.totalLogs).toBe(5);
    expect(v.breaches).toEqual([]);
  });

  it('does not mistake a SUPERSEDED-binding own-log row for the live own log', () => {
    // Residue and own-log exclusion compose: the own log's stranded row is not
    // under the live binding, so it is residue — and the live population is
    // still peers-only.
    const rows = [log(OWN, 0), log('peerAAAA', 48), log(OWN, 500, 42, 'superseded-binding')];
    const v = judgePeerFederationSilence(rows, {
      silentAfterMs: SLO,
      nowMs: NOW,
      ownLogKeyHex: OWN,
    });
    expect(v.strandedCursors).toBe(1);
    expect(v.totalLogs).toBe(1);
    expect(v.silent.map((s) => s.logKeyHex)).toEqual(['peerAAAA']);
    expect(v.ownLogSilentForMs).toBe(0);
  });
});
