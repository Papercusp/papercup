/**
 * Unit coverage for evaluateMcpDark — the pure "is this bee working MCP-dark?" verdict. The five
 * gates (grace · predates-restart · alive · generating · no-MCP-since-restart) each get a positive
 * and a negative case; the DB wiring (checkMcpDark) is integration-covered. Clock + restartAt are
 * injected so no real time is involved.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateMcpDark,
  evaluateInteractiveMcpDark,
  planInteractiveHeal,
  markHealSent,
  healedWakeText,
  type McpDarkSnapshot,
  type InteractiveDarkSnapshot,
} from './mcp-dark-watchdog';

const RESTART = 1_000_000_000_000; // fixed operator-boot epoch ms
const M = 60_000;
const NOW = RESTART + 30 * M; // 30 min after the restart — well past the 5-min grace

/** A snapshot that IS dark: started before restart, alive, generating, no MCP since restart. */
function darkSnapshot(over: Partial<McpDarkSnapshot> = {}): McpDarkSnapshot {
  return {
    ownerId: 'role-abc123',
    startedMs: RESTART - 20 * M, // existed before the restart
    supervisorHeartbeatMs: NOW - 1 * M, // supervisor beat 1 min ago ⇒ alive
    lastOutputMs: NOW - 1 * M, // generating output 1 min ago
    presenceHeartbeatMs: RESTART - 5 * M, // last MCP call was BEFORE the restart
    ...over,
  };
}

describe('evaluateMcpDark', () => {
  it('flags a bee that is alive + generating but has made no MCP call since the restart', () => {
    const v = evaluateMcpDark(darkSnapshot(), RESTART, NOW);
    expect(v.dark).toBe(true);
    expect(v.reason).toContain('working tool-less (dark)');
  });

  it('treats a NULL presence row (never handshook MCP) as dark', () => {
    const v = evaluateMcpDark(darkSnapshot({ presenceHeartbeatMs: null }), RESTART, NOW);
    expect(v.dark).toBe(true);
    expect(v.reason).toContain('never');
  });

  it('does NOT flag within the grace window (client may still be reconnecting)', () => {
    const soon = RESTART + 2 * M; // 2 min in — under the 5-min grace
    expect(evaluateMcpDark(darkSnapshot(), RESTART, soon).dark).toBe(false);
  });

  it('does NOT flag a bee spawned AFTER the restart (just booting, not a failed reconnect)', () => {
    expect(evaluateMcpDark(darkSnapshot({ startedMs: RESTART + 1 * M }), RESTART, NOW).dark).toBe(false);
  });

  it('does NOT flag a bee with no started_at recorded', () => {
    expect(evaluateMcpDark(darkSnapshot({ startedMs: null }), RESTART, NOW).dark).toBe(false);
  });

  it('does NOT flag when the supervisor beat is stale (process likely gone, not dark)', () => {
    expect(evaluateMcpDark(darkSnapshot({ supervisorHeartbeatMs: NOW - 10 * M }), RESTART, NOW).dark).toBe(false);
    expect(evaluateMcpDark(darkSnapshot({ supervisorHeartbeatMs: null }), RESTART, NOW).dark).toBe(false);
  });

  it('does NOT flag an idle bee (no recent output — not a live turn needing tools)', () => {
    expect(evaluateMcpDark(darkSnapshot({ lastOutputMs: NOW - 10 * M }), RESTART, NOW).dark).toBe(false);
    expect(evaluateMcpDark(darkSnapshot({ lastOutputMs: null }), RESTART, NOW).dark).toBe(false);
  });

  it('does NOT flag a bee that HAS reconnected (presence heartbeat advanced past the restart)', () => {
    expect(evaluateMcpDark(darkSnapshot({ presenceHeartbeatMs: RESTART + 3 * M }), RESTART, NOW).dark).toBe(false);
  });

  it('respects custom thresholds (tighter grace flips a borderline case to dark)', () => {
    const soon = RESTART + 2 * M;
    // default 5-min grace ⇒ not dark; a 1-min grace ⇒ dark (all other gates hold).
    expect(evaluateMcpDark(darkSnapshot(), RESTART, soon, { graceMs: 1 * M }).dark).toBe(true);
  });
});

// ═══ Interactive-session sweep (mcp-transport-resilience P-005, 2026-07-13) ═══

const INOW = 2_000_000_000_000;

/** A snapshot that IS dark under the armed-loop clause: host old, loop armed
 *  (600s), presence beat 45 min stale (> max(3×600s, 20m) = 30m). Mirrors the
 *  su-39f07 incident shape. */
function interactiveDark(over: Partial<InteractiveDarkSnapshot> = {}): InteractiveDarkSnapshot {
  return {
    ownerId: 'su-39f07',
    hostStartedMs: INOW - 6 * 60 * M,
    hostLastActivityMs: INOW - 1 * M,
    presenceHeartbeatMs: INOW - 45 * M,
    loopActive: true,
    loopIntervalSec: 600,
    ...over,
  };
}

describe('evaluateInteractiveMcpDark (P-005 — NOT pinned to operator restart)', () => {
  it('detects the su-39f07 shape: armed loop + presence beat past 3× interval', () => {
    const v = evaluateInteractiveMcpDark(interactiveDark(), INOW);
    expect(v.dark).toBe(true);
    expect(v.reason).toContain('ARMED loop');
  });

  it('grace: a young host is never dark (session may not have tool-called yet)', () => {
    const v = evaluateInteractiveMcpDark(interactiveDark({ hostStartedMs: INOW - 5 * M }), INOW);
    expect(v.dark).toBe(false);
  });

  it('armed loop within cadence is healthy (beat 10m stale, threshold 30m)', () => {
    const v = evaluateInteractiveMcpDark(interactiveDark({ presenceHeartbeatMs: INOW - 10 * M }), INOW);
    expect(v.dark).toBe(false);
  });

  it('a LONG loop interval raises the threshold (3× interval beats the floor)', () => {
    // interval 30 min ⇒ threshold 90 min; a 45-min-stale beat is fine.
    const v = evaluateInteractiveMcpDark(
      interactiveDark({ loopIntervalSec: 1800, presenceHeartbeatMs: INOW - 45 * M }),
      INOW,
    );
    expect(v.dark).toBe(false);
  });

  it('no loop: dark only when the pty is IN USE and the beat is very stale', () => {
    const base = interactiveDark({ loopActive: false, loopIntervalSec: null });
    // in use (pty 1m ago) + beat 45m stale > 30m ⇒ dark
    expect(evaluateInteractiveMcpDark(base, INOW).dark).toBe(true);
    // idle session (pty 20m ago) ⇒ never dark, however stale the beat
    expect(
      evaluateInteractiveMcpDark({ ...base, hostLastActivityMs: INOW - 20 * M }, INOW).dark,
    ).toBe(false);
    // in use but beat only 20m stale ⇒ not dark
    expect(
      evaluateInteractiveMcpDark({ ...base, presenceHeartbeatMs: INOW - 20 * M }, INOW).dark,
    ).toBe(false);
  });

  it('presence NEVER seen: staleness measured from host start', () => {
    const v = evaluateInteractiveMcpDark(interactiveDark({ presenceHeartbeatMs: null }), INOW);
    expect(v.dark).toBe(true);
  });
});

describe('planInteractiveHeal (the cross-pass heal ladder — tri-state verdicts, 2026-07-14 false-heal fix)', () => {
  it('dark → heal, heal, then notify ONCE, then none', () => {
    const state = new Map();
    const dark = [{ ownerId: 'su-x', dark: true }];
    expect(planInteractiveHeal(state, dark, INOW)).toEqual([{ ownerId: 'su-x', action: 'heal' }]);
    expect(planInteractiveHeal(state, dark, INOW + 5 * M)).toEqual([{ ownerId: 'su-x', action: 'heal' }]);
    expect(planInteractiveHeal(state, dark, INOW + 10 * M)).toEqual([{ ownerId: 'su-x', action: 'notify' }]);
    expect(planInteractiveHeal(state, dark, INOW + 15 * M)).toEqual([{ ownerId: 'su-x', action: 'none' }]);
  });

  it('RECOVERED (fresh beat) after a SENT attempt → announce-healed exactly once, state cleared', () => {
    const state = new Map();
    planInteractiveHeal(state, [{ ownerId: 'su-x', dark: true }], INOW);
    markHealSent(state, 'su-x'); // the executor confirmed the envelope landed
    expect(planInteractiveHeal(state, [{ ownerId: 'su-x', dark: false, recovered: true }], INOW + 5 * M)).toEqual([
      { ownerId: 'su-x', action: 'announce-healed' },
    ]);
    // next pass: nothing on record ⇒ none
    expect(planInteractiveHeal(state, [{ ownerId: 'su-x', dark: false, recovered: true }], INOW + 10 * M)).toEqual([
      { ownerId: 'su-x', action: 'none' },
    ]);
  });

  it('LIVE REGRESSION su-39f07 2026-07-14: ¬dark alone is INDETERMINATE — never an announce, state held', () => {
    // The deployed first cut announced "healed" when the dark verdict merely
    // flipped (session went idle / presence row absent). recovered:false must
    // hold everything.
    const state = new Map();
    planInteractiveHeal(state, [{ ownerId: 'su-x', dark: true }], INOW);
    markHealSent(state, 'su-x');
    expect(planInteractiveHeal(state, [{ ownerId: 'su-x', dark: false, recovered: false }], INOW + 5 * M)).toEqual([
      { ownerId: 'su-x', action: 'none' },
    ]);
    expect(state.has('su-x')).toBe(true); // state HELD, not cleared
    // …and when it goes dark again (su-5651d flip-flop shape), the ladder resumes
    // where it left off instead of announcing.
    expect(planInteractiveHeal(state, [{ ownerId: 'su-x', dark: true }], INOW + 10 * M)).toEqual([
      { ownerId: 'su-x', action: 'heal' },
    ]);
  });

  it('LIVE REGRESSION no-cap heals 2026-07-14: recovery with NO sent envelope clears silently — no announce', () => {
    // Both live hosts predated the macro (no-cap): nothing was ever injected, so
    // a later genuine recovery (owner ran /mcp) must NOT claim "the macro healed you".
    const state = new Map();
    planInteractiveHeal(state, [{ ownerId: 'su-x', dark: true }], INOW); // attempt recorded, but never sent
    expect(planInteractiveHeal(state, [{ ownerId: 'su-x', dark: false, recovered: true }], INOW + 5 * M)).toEqual([
      { ownerId: 'su-x', action: 'none' },
    ]);
    expect(state.has('su-x')).toBe(false); // cleared — a fresh incident starts a fresh ladder
  });

  it('never-dark owners never act (no announce without a recorded attempt)', () => {
    const state = new Map();
    expect(planInteractiveHeal(state, [{ ownerId: 'su-y', dark: false }], INOW)).toEqual([
      { ownerId: 'su-y', action: 'none' },
    ]);
    expect(planInteractiveHeal(state, [{ ownerId: 'su-y', dark: false, recovered: true }], INOW)).toEqual([
      { ownerId: 'su-y', action: 'none' },
    ]);
  });

  it('the attempt window rolls: old attempts age out and healing resumes', () => {
    const state = new Map();
    const dark = [{ ownerId: 'su-x', dark: true }];
    planInteractiveHeal(state, dark, INOW);
    planInteractiveHeal(state, dark, INOW + 1 * M);
    // 2h later: both attempts aged out of the 1h window ⇒ heal again
    expect(planInteractiveHeal(state, dark, INOW + 120 * M)).toEqual([{ ownerId: 'su-x', action: 'heal' }]);
  });
});

describe('healedWakeText', () => {
  it('tells the healed session to re-arm its loop and re-park state', () => {
    const text = healedWakeText('su-x', 45);
    expect(text).toContain('loop:status');
    expect(text).toContain('re-park');
    expect(text).toContain('~45m');
  });
});
