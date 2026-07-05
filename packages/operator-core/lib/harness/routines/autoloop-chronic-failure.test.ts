import { describe, expect, it } from 'vitest';
import {
  selectChronicFailures,
  chronicErrorThreshold,
  staleWindowMs,
  isStaleWatermark,
  isLoopArmOwnerLoop,
  type AutoloopStateRow,
} from './autoloop-chronic-failure';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 3, 12, 0, 0); // 2026-07-03T12:00:00Z

describe('chronicErrorThreshold', () => {
  it('defaults to 6', () => {
    const prev = process.env.PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD;
    delete process.env.PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD;
    expect(chronicErrorThreshold()).toBe(6);
    if (prev !== undefined) process.env.PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD = prev;
  });
});

describe('selectChronicFailures', () => {
  function row(over: Partial<AutoloopStateRow>): AutoloopStateRow {
    return { harness_slug: 'papercusp', role: 'loop-su-x', consecutive_errors: 7, last_status: 'loop-stuck-backstop', routine_active: null, ...over };
  }

  it('breaches only rows at/over the threshold, highest streak first', () => {
    const rows = [row({ role: 'a', consecutive_errors: 6 }), row({ role: 'b', consecutive_errors: 9 }), row({ role: 'c', consecutive_errors: 5 })];
    expect(selectChronicFailures(rows, 6).map((r) => r.role)).toEqual(['b', 'a']);
  });

  it('threshold <= 0 disables the sweep entirely', () => {
    expect(selectChronicFailures([row({})], 0)).toEqual([]);
    expect(selectChronicFailures([row({})], -1)).toEqual([]);
  });

  it("EI-6760/6761/6762 real shape: a routine already auto-paused (active:false) is NOT re-escalated as a live chronic failure", () => {
    const rows = [row({ role: 'loop-su-0f81d996-9f81-4f13-b56f-2962aa7eedfa', consecutive_errors: 7, routine_active: false })];
    expect(selectChronicFailures(rows, 6)).toEqual([]);
  });

  it("EI-6753 real shape: an auto-terminated loop (last_status loop-terminal-unreachable, active:false) is NOT re-escalated as a live chronic failure", () => {
    // EI-6753 (loop-su-30633068…): the pinned su session died, so the reconcile
    // unreachable-terminal guard auto-paused the routine (active:false) recording
    // last_status 'loop-terminal-unreachable' at a high streak (19). Its stale-red
    // autoloop_state row must NOT re-file a chronic-failure ticket — the routine
    // engine already resolved the condition. Pins the exact real-world shape
    // (terminal-unreachable status + paused routine) the routine_active guard drops,
    // regardless of last_status text.
    const rows = [
      row({
        role: 'loop-su-30633068-a395-4c76-a1d7-7bc5c3c3095d',
        consecutive_errors: 19,
        last_status: 'loop-terminal-unreachable',
        routine_active: false,
      }),
    ];
    expect(selectChronicFailures(rows, 6)).toEqual([]);
  });

  it("EI-6753 defense-in-depth: even if the terminated routine row is GC'd (routine_active null) the frozen watermark is still suppressed by the staleness guard", () => {
    // If the auto-paused routine row is later reaped (leaving routine_active null →
    // fail-open on the routine_active axis), the row is a FROZEN watermark: it last
    // fired at termination and can never fire (or reset) again. The staleness guard
    // (EI-6765) must still suppress it so a reaped-routine terminal loop cannot
    // re-escalate in perpetuity.
    const rows = [
      row({
        role: 'loop-su-30633068-a395-4c76-a1d7-7bc5c3c3095d',
        consecutive_errors: 19,
        last_status: 'loop-terminal-unreachable',
        routine_active: null,
        last_fired_at: new Date(NOW - 7 * HOUR_MS).toISOString(), // last fired at termination, >6h stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it("EI-6769 boundary: a paused routine at EXACTLY the threshold (streak == threshold) is still skipped, not escalated", () => {
    // EI-6769 (loop-su-cea4c674…) was auto-filed at streak==6 (the exact threshold)
    // while its routine was already active:false, ~15min before the routine_active
    // skip-filter landed. Pin the threshold-boundary so a >= vs > slip can never
    // re-open that pre-fix escalation of an already-resolved (paused) condition.
    const rows = [row({ role: 'loop-su-cea4c674-d05a-49df-9748-62a6702753d3', consecutive_errors: 6, routine_active: false })];
    expect(selectChronicFailures(rows, 6)).toEqual([]);
  });

  it("EI-6730 real shape: a high-streak (36) stuck-backstop loop, routine paused AND >6h stale, is NOT re-escalated", () => {
    // EI-6730 (loop-su-1a5c2d41…): the pinned su session died, the loop climbed to
    // consecutive_errors=36 (last_status 'loop-stuck-backstop'), then the routine was
    // paused (active:false) and its last fire froze ~3 days ago. Both resolution guards
    // apply (routine_active:false AND a >6h-stale frozen watermark), so its stale-red
    // autoloop_state row must NOT re-file a chronic-failure ticket. Confirmed live via
    // hive_watchdog_fires: no autoloop-chronic fire for this row since the guards landed.
    // Pins the HIGHEST-streak real shape yet (existing pins cap at 19) so a future change
    // that gated the routine_active/stale guard below some streak ceiling would fail here.
    const rows = [
      row({
        role: 'loop-su-1a5c2d41-f3f2-483b-92a0-c86c6af002c8',
        harness_slug: '*',
        consecutive_errors: 36,
        last_status: 'loop-stuck-backstop',
        routine_active: false,
        last_fired_at: new Date(NOW - 3 * 24 * HOUR_MS).toISOString(), // ~3 days stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-6698 real shape: a loop:arm owner loop deactivated via a NON-terminal path (active:false, last_status still loop-stuck-backstop) at a record streak (175) is NOT re-escalated', () => {
    // EI-6698 (loop-su-5bd1ad27…@*): the pinned su session died; the loop stuck-backstopped
    // 175 consecutive times (10-min interval, ~29h) before its routine went active:false —
    // but via a NON-terminal path (metadata last_error_source: dbos-executor-reaper), so
    // next_fire_at stayed at the parked 'infinity' sentinel and last_status stayed
    // 'loop-stuck-backstop' rather than the WI-1399 terminal marker 'loop-terminal-unreachable'.
    // Every prior all-3-axes pin (EI-6718) carries the terminal marker; this one proves the
    // suppression is INDEPENDENT of last_status text — it hits the loop:arm-owner AND
    // routine_active:false AND staleness axes at once regardless of HOW the routine was paused.
    // Guards against a future change that (wrongly) gated the paused/loop-arm skip on the exact
    // terminal-marker string, which would re-open this record-streak escalation flood. Highest
    // real-world streak pin in the file (prior stuck-backstop max was 36).
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-5bd1ad27-2015-4f78-b2c6-c91f2a1d4ea2',
        consecutive_errors: 175,
        last_status: 'loop-stuck-backstop', // NON-terminal — routine deactivated by a different path
        routine_active: false,
        routine_target_owner_id: 'su-5bd1ad27-2015-4f78-b2c6-c91f2a1d4ea2',
        last_fired_at: new Date(NOW - 3 * 24 * HOUR_MS).toISOString(), // ~3 days stale frozen watermark
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-6694 real shape: a dead loop:arm owner loop, all three axes, at the HIGHEST real streak (220) is NOT re-escalated', () => {
    // EI-6694 (loop-su-9e3ca906-101d-4933-a3e1-3ab4034a4fce@*): the pinned su session ended
    // cleanly (exit 0) 2026-06-21; the loop then stuck-backstopped 220 consecutive times (5-min
    // interval) before its routine went active:false, its last fire freezing 2026-07-01 (~3 days
    // stale). All three exclusion axes apply at once — loop:arm OWNER loop (target_owner_id
    // non-null, its own dead-owner escalation), routine auto-paused (active:false), and a >6h-stale
    // frozen watermark. This is the HIGHEST real-world streak pinned in this file (prior max was
    // EI-6698 at 175), so it guards against a future change that (wrongly) gated any of the three
    // guards below some streak ceiling — which would re-open this exact escalation.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-9e3ca906-101d-4933-a3e1-3ab4034a4fce',
        consecutive_errors: 220,
        last_status: 'loop-stuck-backstop',
        routine_active: false,
        routine_target_owner_id: 'su-9e3ca906-101d-4933-a3e1-3ab4034a4fce',
        last_fired_at: new Date(NOW - 3 * 24 * HOUR_MS).toISOString(), // ~3 days stale frozen watermark
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-6692 real shape: a dead loop:arm owner loop reaped via a NON-terminal path, at the HIGHEST real streak (221), is NOT re-escalated', () => {
    // EI-6692 (loop-su-34db408d-fe89-4c3b-b6aa-c3e4651a5e0a@*): the pinned su session
    // (adv_sessions 6767, started 2026-06-24) died WITHOUT a clean end marker — ended_at
    // stayed NULL (a stale-active orphan, the dbos-executor-reaper non-terminal path from
    // EI-6698), so last_status stayed the non-terminal 'loop-stuck-backstop' rather than the
    // WI-1399 marker. The loop stuck-backstopped 221 consecutive times before its routine went
    // active:false, its last fire freezing 2026-07-01 (~3 days stale). All three exclusion axes
    // still apply — loop:arm OWNER loop (target_owner_id non-null), routine auto-paused
    // (active:false), AND a >6h-stale frozen watermark — so the collector reads only
    // autoloop_state + routines (never adv_sessions), and the NULL ended_at is irrelevant to
    // suppression. This is the HIGHEST real-world streak pinned in this file (prior max was
    // EI-6694 at 220) and re-confirms suppression is INDEPENDENT of both last_status text and
    // the owner-session end-marker state. Live proof it stays suppressed: hive_watchdog_fires
    // shows exactly ONE autoloop-chronic fire for this row (2026-07-02, the one that filed
    // EI-6692) and none since, despite the row still carrying 221 errors.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-34db408d-fe89-4c3b-b6aa-c3e4651a5e0a',
        consecutive_errors: 221,
        last_status: 'loop-stuck-backstop',
        routine_active: false,
        routine_target_owner_id: 'su-34db408d-fe89-4c3b-b6aa-c3e4651a5e0a',
        last_fired_at: new Date(NOW - 3 * 24 * HOUR_MS).toISOString(), // ~3 days stale frozen watermark
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-6690 real shape: a dead loop-role-* owner loop (role-* owner, not su-*) at the HIGHEST real streak (226) is NOT re-escalated', () => {
    // EI-6690 (loop-role-da950389-8866-4f33-bfd9-74db3e832f6c@*): the FIRST real-world
    // `loop-role-*` shape pinned in this file — every prior pin is a `loop-su-<uuid>` owner
    // loop whose routine.target_owner_id is `su-<uuid>`. This loop:arm loop is ROLE-owned:
    // role `loop-role-<uuid>`, routine target_owner_id `role-<uuid>` (prefix `role-`, not
    // `su-`). The pinned owner died; the loop stuck-backstopped 226 consecutive times before
    // its routine went active:false, its last fire freezing 2026-07-01 (~3 days stale). All
    // three exclusion axes apply — loop:arm OWNER loop (target_owner_id non-null), routine
    // auto-paused (active:false), AND a >6h-stale frozen watermark. Critically, this proves
    // `isLoopArmOwnerLoop` is PREFIX-AGNOSTIC — it keys on target_owner_id being non-null, NOT
    // on the `su-`/`role-` owner prefix — so a future change that (wrongly) gated the loop:arm
    // guard on the `su-` prefix would re-open this class. Also the HIGHEST real streak pinned
    // here (prior max was EI-6692 at 221). Live proof it stays suppressed: hive_watchdog_fires
    // shows exactly ONE autoloop-chronic fire for this row (2026-07-02, which filed EI-6690)
    // and none since, despite the row still carrying 226 errors.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-role-da950389-8866-4f33-bfd9-74db3e832f6c',
        consecutive_errors: 226,
        last_status: 'loop-stuck-backstop',
        routine_active: false,
        routine_target_owner_id: 'role-da950389-8866-4f33-bfd9-74db3e832f6c',
        last_fired_at: new Date(NOW - 3 * 24 * HOUR_MS).toISOString(), // ~3 days stale frozen watermark
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('a routine that is still active (armed, still trying+failing) IS escalated', () => {
    const rows = [row({ role: 'loop-su-still-live', consecutive_errors: 7, routine_active: true })];
    expect(selectChronicFailures(rows, 6)).toHaveLength(1);
  });

  it("EI-6727 real shape: a LIVE (routine active, recently fired) loop:arm owner loop is NOT escalated — pre-pause window", () => {
    // EI-6727 (loop-su-dad90f05…) and 27 siblings: a dead su session's loop:arm loop climbs
    // past the chronic threshold (6) and the sweep escalates it in the WINDOW before the
    // reconcile dead-owner guard circuit-opens (≥8) and pauses the routine. At escalation time
    // the row looks live (routine_active:true, recent fire) so neither the routine_active nor
    // the staleness guard catches it — only the target_owner_id marker (a loop:arm OWNER loop,
    // which has its OWN dead-owner escalation) does. Must NOT re-file a chronic-failure ticket.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-dad90f05-580b-4cb0-b81e-8cb951756c59',
        consecutive_errors: 7,
        last_status: 'loop-stuck-backstop',
        routine_active: true,
        routine_target_owner_id: 'su-dad90f05-580b-4cb0-b81e-8cb951756c59',
        last_fired_at: new Date(NOW - 60 * 1000).toISOString(), // fired 1min ago — not stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-6718 real shape: a dead loop:arm owner loop already auto-paused AND stale is NOT re-escalated', () => {
    // EI-6718 (loop-su-7e812a66…@*): a pre-fix chronic-failure ticket filed 2026-07-02, before
    // the EI-6727 loop:arm guard landed. The live row now hits ALL THREE exclusion axes at once —
    // the reconcile dead-owner guard has auto-paused the routine (active:false), it is a loop:arm
    // OWNER loop (target_owner_id non-null, with its own escalation), and its last fire is a stale
    // frozen watermark. Any one axis suffices; together they pin that this class stays suppressed.
    const rows = [
      row({
        harness_slug: '*',
        role: 'loop-su-7e812a66-7d3d-4f41-a73d-9f523209f666',
        consecutive_errors: 54,
        last_status: 'loop-terminal-unreachable',
        routine_active: false,
        routine_target_owner_id: 'su-7e812a66-7d3d-4f41-a73d-9f523209f666',
        last_fired_at: new Date(NOW - 30 * HOUR_MS).toISOString(), // last fired > staleness window ago
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-6727: a fixed SYSTEM role (no target_owner_id) still escalates — the suppression is loop:arm-only', () => {
    // Regression guard against over-suppression: gym-cycle/director/overwatch/scout-cycle are
    // witness-less fixed system roles with NO target_owner_id and no other escalation path —
    // they remain the sweep's whole point and MUST still escalate.
    const rows = [
      row({ role: 'gym-cycle', consecutive_errors: 8, routine_active: true, routine_target_owner_id: null }),
    ];
    expect(selectChronicFailures(rows, 6).map((r) => r.role)).toEqual(['gym-cycle']);
  });

  it('EI-6727: a loop:arm owner loop is dropped even at a very high streak while its routine is still active', () => {
    // Some dead loops reach streaks of 55+ before the reconcile tick pauses them (the guard
    // needs looksDeadOrStuck + a reconcile pass). A high streak must NOT re-open escalation of
    // a loop:arm owner loop — the guard owns its escalation regardless of streak.
    const rows = [
      row({
        role: 'loop-su-45001f87-6b30-43f6-b37f-1899adad537f',
        consecutive_errors: 58,
        routine_active: true,
        routine_target_owner_id: 'su-45001f87-6b30-43f6-b37f-1899adad537f',
        last_fired_at: new Date(NOW - 60 * 1000).toISOString(),
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('EI-6727 mixed batch: loop:arm owner loops drop, fixed system roles still breach in order', () => {
    const rows = [
      row({ role: 'gym-cycle', consecutive_errors: 10, routine_active: true, routine_target_owner_id: null }),
      row({ role: 'loop-su-a', consecutive_errors: 30, routine_active: true, routine_target_owner_id: 'su-a' }),
      row({ role: 'scout-cycle', consecutive_errors: 8, routine_active: null, routine_target_owner_id: null }),
      row({ role: 'loop-su-b', consecutive_errors: 99, routine_active: true, routine_target_owner_id: 'su-b' }),
    ];
    expect(selectChronicFailures(rows, 6).map((r) => r.role)).toEqual(['gym-cycle', 'scout-cycle']);
  });

  it('a role with NO matching routines row (routine_active: null — director/gym-cycle/overwatch/scout-cycle) fails OPEN and is still escalated', () => {
    const rows = [row({ role: 'gym-cycle', consecutive_errors: 8, routine_active: null })];
    expect(selectChronicFailures(rows, 6)).toHaveLength(1);
  });

  it('mixed batch: only the explicitly-paused row is dropped, the rest still breach in order', () => {
    const rows = [
      row({ role: 'live-high', consecutive_errors: 10, routine_active: true }),
      row({ role: 'paused', consecutive_errors: 9, routine_active: false }),
      row({ role: 'no-routine', consecutive_errors: 8, routine_active: null }),
    ];
    expect(selectChronicFailures(rows, 6).map((r) => r.role)).toEqual(['live-high', 'no-routine']);
  });

  it('EI-6765 real shape: an orphaned overwatch@papercup row (6 errors, last fired 8 days ago) is a frozen watermark, NOT escalated', () => {
    // The active overwatch loop moved to the `papercusp` home slug (which is `ok`),
    // leaving `papercup` frozen at 6 errors with a stale "180000ms" last_status. It
    // never fires again, so its streak can never reset — it must NOT re-escalate.
    const rows = [
      row({
        harness_slug: 'papercup',
        role: 'overwatch',
        consecutive_errors: 6,
        routine_active: null, // overwatch is a fixed system role — no matching routines row
        last_status: 'error: no complete scorecard within 180000ms launch deadline; backstop synthesized',
        last_fired_at: new Date(NOW - 8 * 24 * HOUR_MS).toISOString(), // 8 days stale
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toEqual([]);
  });

  it('a still-firing loop (last fired within the staleness window) IS escalated despite fail-open null routine', () => {
    const rows = [
      row({
        role: 'gym-cycle',
        consecutive_errors: 8,
        routine_active: null,
        last_fired_at: new Date(NOW - 30 * 60 * 1000).toISOString(), // 30min ago — well within window
      }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS })).toHaveLength(1);
  });

  it('null/absent last_fired_at fails OPEN — an unknown fire time never silently suppresses escalation', () => {
    const rows = [
      row({ role: 'null-fired', consecutive_errors: 7, last_fired_at: null }),
      row({ role: 'absent-fired', consecutive_errors: 7 }), // last_fired_at undefined
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 6 * HOUR_MS }).map((r) => r.role)).toEqual([
      'null-fired',
      'absent-fired',
    ]);
  });

  it('staleMs <= 0 disables the staleness guard entirely (fail-open — even an ancient row escalates)', () => {
    const rows = [
      row({ role: 'ancient', consecutive_errors: 9, last_fired_at: new Date(NOW - 100 * 24 * HOUR_MS).toISOString() }),
    ];
    expect(selectChronicFailures(rows, 6, { now: NOW, staleMs: 0 })).toHaveLength(1);
  });
});

describe('staleWindowMs', () => {
  it('defaults to 6 hours', () => {
    const prev = process.env.PAPERCUSP_AUTOLOOP_STALE_MS;
    delete process.env.PAPERCUSP_AUTOLOOP_STALE_MS;
    expect(staleWindowMs()).toBe(6 * HOUR_MS);
    if (prev !== undefined) process.env.PAPERCUSP_AUTOLOOP_STALE_MS = prev;
  });

  it('is env-overridable', () => {
    const prev = process.env.PAPERCUSP_AUTOLOOP_STALE_MS;
    process.env.PAPERCUSP_AUTOLOOP_STALE_MS = '90000';
    expect(staleWindowMs()).toBe(90000);
    if (prev !== undefined) process.env.PAPERCUSP_AUTOLOOP_STALE_MS = prev;
    else delete process.env.PAPERCUSP_AUTOLOOP_STALE_MS;
  });
});

describe('isStaleWatermark', () => {
  it('true when last fire is older than the window', () => {
    expect(isStaleWatermark({ last_fired_at: new Date(NOW - 7 * HOUR_MS).toISOString() }, NOW, 6 * HOUR_MS)).toBe(true);
  });
  it('false when last fire is within the window', () => {
    expect(isStaleWatermark({ last_fired_at: new Date(NOW - 5 * HOUR_MS).toISOString() }, NOW, 6 * HOUR_MS)).toBe(false);
  });
  it('accepts a Date as well as an ISO string', () => {
    expect(isStaleWatermark({ last_fired_at: new Date(NOW - 7 * HOUR_MS) }, NOW, 6 * HOUR_MS)).toBe(true);
  });
  it('fails OPEN (false) on null, undefined, or an unparseable value', () => {
    expect(isStaleWatermark({ last_fired_at: null }, NOW, 6 * HOUR_MS)).toBe(false);
    expect(isStaleWatermark({ last_fired_at: undefined }, NOW, 6 * HOUR_MS)).toBe(false);
    expect(isStaleWatermark({ last_fired_at: 'not-a-date' }, NOW, 6 * HOUR_MS)).toBe(false);
  });
  it('staleMs <= 0 disables (never stale)', () => {
    expect(isStaleWatermark({ last_fired_at: new Date(NOW - 100 * HOUR_MS).toISOString() }, NOW, 0)).toBe(false);
  });
});

describe('isLoopArmOwnerLoop (EI-6727)', () => {
  it('non-null, non-empty target_owner_id → loop:arm owner loop (true)', () => {
    expect(isLoopArmOwnerLoop({ routine_target_owner_id: 'su-dad90f05-580b-4cb0-b81e-8cb951756c59' })).toBe(true);
  });
  it('EI-6690: prefix-agnostic — a `role-<uuid>` owner (not `su-`) is still a loop:arm owner loop (true)', () => {
    // The guard keys on target_owner_id being present, NOT the owner prefix: a `loop-role-*`
    // loop is owned by `role-<uuid>`, and must be suppressed exactly like a `loop-su-*` loop.
    expect(isLoopArmOwnerLoop({ routine_target_owner_id: 'role-da950389-8866-4f33-bfd9-74db3e832f6c' })).toBe(true);
  });
  it('null / undefined / empty → fixed system role, fail-open (false)', () => {
    expect(isLoopArmOwnerLoop({ routine_target_owner_id: null })).toBe(false);
    expect(isLoopArmOwnerLoop({ routine_target_owner_id: undefined })).toBe(false);
    expect(isLoopArmOwnerLoop({ routine_target_owner_id: '' })).toBe(false);
  });
});
