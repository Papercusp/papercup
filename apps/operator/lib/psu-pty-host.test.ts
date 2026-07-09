// @vitest-environment node
/**
 * psu-pty-host.test.ts — pure-logic unit tests for the managed-pty host
 * (turn-lifecycle-control Phase 3, P-012/P-013). The real-pty round-trip
 * (spawn → socket-inject → cleanup) lives in psu-pty-host.integration.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  sanitizeKey,
  socketPathFor,
  metaPathFor,
  encodeControl,
  decodeControl,
  controlBytes,
  controlWrites,
  controlWritesForAgent,
  contextClearCommandForAgent,
  clearSettleMs,
  resetWritesForAgent,
  compactCommandForAgent,
  compactStartMs,
  compactBusyCapMs,
  submitVerifyQuietMs,
  fireSessionCompactedEvent,
  SESSION_COMPACTED_EMIT_ENTRY,
  fleetOscFromEnv,
  turnSubmitCrDelayForAgent,
  makeIdleGate,
  makeActivityTracker,
  makeAgentBusyGate,
  makeSubmitVerifier,
  turnCoalesceKey,
  renderCoalescedTurn,
  makeTurnCoalescer,
  makeInjectMutex,
  ACTIVITY_PERSIST_MS,
  PSU_PTY_DIR,
  pidLooksLikePsuHost,
  findLiveHostFor,
} from '../scripts/psu-pty-host.mjs';
import * as nodeFs from 'node:fs';
import { oscRecolorSequence, COLOR_SCHEMES } from '@papercusp/operator-core/lib/console-color-schemes';
import { buildConsoleOneliner } from '@papercusp/operator-core/lib/console-spawn';

describe('sanitizeKey', () => {
  it('passes SID-shaped ids through unchanged', () => {
    expect(sanitizeKey('su-a4bf457e-6f4a-4ee1-8682-8da0749c701b')).toBe(
      'su-a4bf457e-6f4a-4ee1-8682-8da0749c701b',
    );
  });
  it('escapes path-traversal + separators (no escaping the dir)', () => {
    expect(sanitizeKey('su/../../etc/passwd')).toBe('su_.._.._etc_passwd');
    expect(sanitizeKey('a b\tc')).toBe('a_b_c');
  });
  it('bounds length + tolerates empty/undefined', () => {
    expect(sanitizeKey('x'.repeat(500)).length).toBe(200);
    expect(sanitizeKey('')).toBe('unknown');
    // @ts-expect-error exercising the undefined path
    expect(sanitizeKey(undefined)).toBe('unknown');
  });
});

describe('socketPathFor / metaPathFor', () => {
  it('derive sibling .sock / .json paths under PSU_PTY_DIR', () => {
    expect(socketPathFor('su-x')).toBe(`${PSU_PTY_DIR}/su-x.sock`);
    expect(metaPathFor('su-x')).toBe(`${PSU_PTY_DIR}/su-x.json`);
  });
});

describe('control wire protocol (v1)', () => {
  it('turn envelope → idle-gated, CR-terminated turn', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'hello' }));
    expect(d).toEqual({ mode: 'turn', data: 'hello', gated: true });
    expect(controlBytes(d)).toBe('hello\r');
  });
  it('raw envelope → immediate, verbatim bytes (force interrupt)', () => {
    const d = decodeControl(encodeControl({ mode: 'raw', data: '\x03' })); // Ctrl-C
    expect(d).toEqual({ mode: 'raw', data: '\x03', gated: false });
    expect(controlBytes(d)).toBe('\x03');
  });
  it('Esc force interrupt round-trips', () => {
    expect(controlBytes(decodeControl(encodeControl({ mode: 'raw', data: '\x1b' })))).toBe('\x1b');
  });
  it('osc envelope → immediate, verbatim recolor bytes (terminal display, not the agent)', () => {
    const osc = '\x1b]11;#581c87\x07';
    const d = decodeControl(encodeControl({ mode: 'osc', data: osc }));
    expect(d).toEqual({ mode: 'osc', data: osc, gated: false });
  });
  it('reset (RESET-CONTEXT) envelope → GATED cold verb carrying the fresh-context carry-note', () => {
    // su-cold-auto-mode P-004a: gated:true so the host defers it to a settled turn
    // (P-006 clean-boundary), exactly like a wake turn — never fired mid-turn.
    const d = decodeControl(encodeControl({ mode: 'reset', data: 'carry-note body' }));
    expect(d).toEqual({ mode: 'reset', data: 'carry-note body', gated: true });
  });
  it('recycle envelope → GATED cold verb carrying the fresh-context carry-note', () => {
    const d = decodeControl(encodeControl({ mode: 'recycle', data: 'carry-note body' }));
    expect(d).toEqual({ mode: 'recycle', data: 'carry-note body', gated: true });
  });
  it('reset/recycle with no data → gated verb with an empty carry (bare reset)', () => {
    expect(decodeControl(encodeControl({ mode: 'reset' }))).toEqual({ mode: 'reset', data: '', gated: true });
    expect(decodeControl(encodeControl({ mode: 'recycle' }))).toEqual({ mode: 'recycle', data: '', gated: true });
  });
  it('compact envelope → GATED verb carrying the carry-note (data) + the /compact focus (WI-1804)', () => {
    // The operator's injectIntoHost sends focus as a distinct envelope field; decode it back.
    const d = decodeControl(JSON.stringify({ v: 1, mode: 'compact', data: 'continue here', focus: 'keep identity' }));
    expect(d).toEqual({ mode: 'compact', data: 'continue here', focus: 'keep identity', gated: true });
  });
  it('compact with no data/focus → gated verb with empty carry + empty focus (bare compact)', () => {
    expect(decodeControl(JSON.stringify({ v: 1, mode: 'compact' }))).toEqual({
      mode: 'compact',
      data: '',
      focus: '',
      gated: true,
    });
  });
  it('a non-envelope payload is a legacy idle-gated turn (psupty back-compat)', () => {
    const d = decodeControl('just some text');
    expect(d).toEqual({ mode: 'turn', data: 'just some text', gated: true });
    expect(controlBytes(d)).toBe('just some text\r');
  });
  it('an unknown/garbage JSON object falls back to a legacy turn', () => {
    const d = decodeControl('{"v":2,"mode":"weird"}');
    expect(d.mode).toBe('turn');
    expect(d.gated).toBe(true);
  });
});

describe('controlWrites — a turn submits via a SEPARATE delayed CR (paste-detector fix)', () => {
  it('a turn is TWO steps: the text now, then the submit CR after a delay', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'wake-turn' }));
    expect(controlWrites(d, 150)).toEqual([
      { data: 'wake-turn', delayMs: 0 },
      { data: '\r', delayMs: 150 },
    ]);
    // The CR is its OWN step — never concatenated onto the text (which the TUI's
    // paste detector would swallow as a literal newline → unsubmitted turn).
    const steps = controlWrites(d, 150);
    expect(steps[0].data).not.toContain('\r');
    expect(steps[1]).toEqual({ data: '\r', delayMs: 150 });
  });
  it('a raw (force-interrupt) message is ONE immediate verbatim write — no CR appended', () => {
    const ctrlC = decodeControl(encodeControl({ mode: 'raw', data: '\x03' }));
    expect(controlWrites(ctrlC)).toEqual([{ data: '\x03', delayMs: 0 }]);
  });
  it('an osc (recolor) message is ONE immediate verbatim write — no CR, no gate', () => {
    const d = decodeControl(encodeControl({ mode: 'osc', data: '\x1b]11;#166534\x07' }));
    expect(controlWrites(d)).toEqual([{ data: '\x1b]11;#166534\x07', delayMs: 0 }]);
  });
  it('the total bytes still match controlBytes (text + CR), just delivered in two writes', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'hello' }));
    expect(controlWrites(d).map((s) => s.data).join('')).toBe(controlBytes(d));
  });
});

describe('turnSubmitCrDelayForAgent', () => {
  it('keeps Claude/OMP on the existing submit delay', () => {
    expect(turnSubmitCrDelayForAgent('claude', {})).toBe(150);
    expect(turnSubmitCrDelayForAgent('omp', {})).toBe(150);
    expect(turnSubmitCrDelayForAgent('', {})).toBe(150);
  });
  it('uses a longer Codex settle so injected coord turns submit after paste handling clears', () => {
    expect(turnSubmitCrDelayForAgent('codex', {})).toBe(500);
    expect(turnSubmitCrDelayForAgent(' CODEX ', {})).toBe(500);
  });
  it('allows a Codex-specific override without changing Claude', () => {
    const env = {
      PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '175',
      PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '650',
    };
    expect(turnSubmitCrDelayForAgent('codex', env)).toBe(650);
    expect(turnSubmitCrDelayForAgent('claude', env)).toBe(175);
  });
  it('ignores invalid delay overrides', () => {
    const env = {
      PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: 'nope',
      PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '-1',
    };
    expect(turnSubmitCrDelayForAgent('codex', env)).toBe(500);
    expect(turnSubmitCrDelayForAgent('claude', env)).toBe(150);
  });
});

describe('controlWritesForAgent', () => {
  it('keeps Claude turns on the normal two-step paste-safe write plan', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'wake-turn' }));
    expect(controlWritesForAgent(d, 'claude', {})).toEqual([
      { data: 'wake-turn', delayMs: 0 },
      { data: '\r', delayMs: 150 },
    ]);
  });
  it('adds a Codex-only redundant delayed submit CR for text left in the compose box', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'wake-turn' }));
    expect(controlWritesForAgent(d, 'codex', {})).toEqual([
      { data: 'wake-turn', delayMs: 0 },
      { data: '\r', delayMs: 500 },
      { data: '\r', delayMs: 300 },
    ]);
  });
  it('lets Codex submit and resubmit delays be tuned independently', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'wake-turn' }));
    const env = {
      PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '800',
      PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS: '450',
    };
    expect(controlWritesForAgent(d, 'codex', env)).toEqual([
      { data: 'wake-turn', delayMs: 0 },
      { data: '\r', delayMs: 800 },
      { data: '\r', delayMs: 450 },
    ]);
  });
  it('does not add submit bytes to raw control messages for any backend', () => {
    const d = decodeControl(encodeControl({ mode: 'raw', data: '\x03' }));
    expect(controlWritesForAgent(d, 'codex', {})).toEqual([{ data: '\x03', delayMs: 0 }]);
  });
  it('does not add submit bytes to osc (recolor) messages for any backend', () => {
    const d = decodeControl(encodeControl({ mode: 'osc', data: '\x1b]11;#000000\x07' }));
    expect(controlWritesForAgent(d, 'codex', {})).toEqual([{ data: '\x1b]11;#000000\x07', delayMs: 0 }]);
  });
});

// su-cold-auto-mode P-004a: RESET-CONTEXT drops the grown transcript in place
// (keep the process + MCP warm) then opens the fresh context on the carry-note.
// The write plan = the backend's context-clear command, then the carry as a
// normal paste-safe turn whose first keystroke waits for the clear to settle.
describe('contextClearCommandForAgent (RESET-CONTEXT clear command)', () => {
  it('Claude / OMP clear in place with /clear (process + MCP stay warm)', () => {
    expect(contextClearCommandForAgent('claude')).toBe('/clear');
    expect(contextClearCommandForAgent('omp')).toBe('/clear');
    expect(contextClearCommandForAgent('')).toBe('/clear');
    // @ts-expect-error exercising the undefined path
    expect(contextClearCommandForAgent(undefined)).toBe('/clear');
  });
  it('Codex starts a fresh conversation with /new', () => {
    expect(contextClearCommandForAgent('codex')).toBe('/new');
    expect(contextClearCommandForAgent(' CODEX ')).toBe('/new');
  });
});

describe('compactCommandForAgent (WI-1804 post-compaction auto-continuation)', () => {
  it('Claude / OMP / default → /compact with the focus appended', () => {
    expect(compactCommandForAgent('claude', 'keep the plan items')).toBe('/compact keep the plan items');
    expect(compactCommandForAgent('omp', 'keep X')).toBe('/compact keep X');
    expect(compactCommandForAgent('', 'keep X')).toBe('/compact keep X');
    expect(compactCommandForAgent(undefined, 'keep X')).toBe('/compact keep X');
  });
  it('a bare /compact when focus is empty/whitespace/undefined', () => {
    expect(compactCommandForAgent('claude', '')).toBe('/compact');
    expect(compactCommandForAgent('claude', '   ')).toBe('/compact');
    expect(compactCommandForAgent('claude', undefined)).toBe('/compact');
  });
  it('codex → a BARE /compact (native command exists but takes no focus argument)', () => {
    // Until 2026-07-05 codex mapped to null, silently no-op'ing the watchdog
    // force-compact rung + session:request-compaction for codex sessions.
    expect(compactCommandForAgent('codex', 'keep X')).toBe('/compact');
    expect(compactCommandForAgent(' CODEX ', 'keep X')).toBe('/compact');
    expect(compactCommandForAgent('codex', undefined)).toBe('/compact');
  });
});

describe('compactStartMs (WI-1804 compaction START delay)', () => {
  it('defaults to 2000ms; env override wins; a bad override falls back', () => {
    expect(compactStartMs({})).toBe(2000);
    expect(compactStartMs({ PAPERCUSP_PSU_PTY_COMPACT_START_MS: '3500' })).toBe(3500);
    expect(compactStartMs({ PAPERCUSP_PSU_PTY_COMPACT_START_MS: 'nope' })).toBe(2000);
    expect(compactStartMs({ PAPERCUSP_PSU_PTY_COMPACT_START_MS: '-5' })).toBe(2000);
  });
});

describe('compactBusyCapMs (WI-1872 (1) — dedicated compaction completion budget)', () => {
  it('defaults to 600000ms (10min); env override wins; a bad override falls back', () => {
    expect(compactBusyCapMs({})).toBe(600_000);
    expect(compactBusyCapMs({ PAPERCUSP_PSU_PTY_COMPACT_BUSY_CAP_MS: '900000' })).toBe(900_000);
    expect(compactBusyCapMs({ PAPERCUSP_PSU_PTY_COMPACT_BUSY_CAP_MS: 'nope' })).toBe(600_000);
    expect(compactBusyCapMs({ PAPERCUSP_PSU_PTY_COMPACT_BUSY_CAP_MS: '-5' })).toBe(600_000);
  });
});

describe('submitVerifyQuietMs (WI-2975 — decoupled from OUTPUT_QUIET_MS)', () => {
  it('defaults to 6000ms; env override wins; a bad override falls back', () => {
    expect(submitVerifyQuietMs({})).toBe(6_000);
    expect(submitVerifyQuietMs({ PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '9000' })).toBe(9_000);
    expect(submitVerifyQuietMs({ PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: 'nope' })).toBe(6_000);
    expect(submitVerifyQuietMs({ PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '-5' })).toBe(6_000);
  });

  it('is a DIFFERENT default than the busy-gate\'s OUTPUT_QUIET_MS (1500ms) — the WI-2975 fix is precisely that these no longer share one value', () => {
    expect(submitVerifyQuietMs({})).not.toBe(1_500);
    expect(submitVerifyQuietMs({})).toBeGreaterThan(1_500);
  });
});

describe('fireSessionCompactedEvent (event-await P-103 — the detached emit bridge)', () => {
  const okChild = () => ({ on: () => {}, unref: () => {} });

  it('spawns the detached tsx emit CLI with owner + focus as argv when the entry exists', () => {
    const spawnFn = vi.fn(() => okChild());
    const child = fireSessionCompactedEvent('su-94b69', 'keep the plan', {
      spawnFn,
      existsFn: () => true,
      entry: '/x/emit-session-compacted.ts',
    });
    expect(child).not.toBeNull();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe('npx');
    expect(args).toEqual(['tsx', '/x/emit-session-compacted.ts', 'su-94b69', 'keep the plan']);
    // detached + fully silenced so a spawn failure can never touch the live session
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('is a NO-OP (never spawns) until the CLI entry exists — safe to ship the wire before the CLI', () => {
    const spawnFn = vi.fn(() => okChild());
    const out = fireSessionCompactedEvent('su-94b69', 'f', { spawnFn, existsFn: () => false });
    expect(out).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('no-ops on a missing ownerId (never emit an unkeyed event)', () => {
    const spawnFn = vi.fn(() => okChild());
    expect(fireSessionCompactedEvent('', 'f', { spawnFn, existsFn: () => true })).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('coerces a null/undefined focus to an empty-string argv (never passes "undefined")', () => {
    const spawnFn = vi.fn(() => okChild());
    fireSessionCompactedEvent('su-x', undefined, { spawnFn, existsFn: () => true, entry: '/e.ts' });
    expect(spawnFn.mock.calls[0][1]).toEqual(['tsx', '/e.ts', 'su-x', '']);
  });

  it('FAIL-SOFT: a spawn that throws is swallowed (returns null, never propagates into the session)', () => {
    const spawnFn = vi.fn(() => {
      throw new Error('npx not found');
    });
    expect(() => fireSessionCompactedEvent('su-x', 'f', { spawnFn, existsFn: () => true, entry: '/e.ts' })).not.toThrow();
    expect(fireSessionCompactedEvent('su-x', 'f', { spawnFn, existsFn: () => true, entry: '/e.ts' })).toBeNull();
  });

  it('the default emit-CLI entry is a sibling .ts of the host script', () => {
    expect(SESSION_COMPACTED_EMIT_ENTRY).toMatch(/scripts[/\\]emit-session-compacted\.ts$/);
  });
});

describe('clearSettleMs (RESET-CONTEXT repaint budget)', () => {
  it('defaults to 1500ms and honours a session-env override', () => {
    expect(clearSettleMs({})).toBe(1500);
    expect(clearSettleMs({ PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS: '800' })).toBe(800);
  });
  it('ignores an invalid override', () => {
    expect(clearSettleMs({ PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS: 'nope' })).toBe(1500);
    expect(clearSettleMs({ PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS: '-5' })).toBe(1500);
  });
});

describe('resetWritesForAgent (RESET-CONTEXT write plan)', () => {
  it('Claude: /clear + submit, then the carry turn after the settle', () => {
    const d = decodeControl(encodeControl({ mode: 'reset', data: 'CARRY' }));
    expect(resetWritesForAgent(d, 'claude', {})).toEqual([
      { data: '/clear', delayMs: 0 }, // type the clear command
      { data: '\r', delayMs: 150 }, //   submit it (claude CR delay)
      { data: 'CARRY', delayMs: 1500 }, // carry text — waits for the clear to repaint
      { data: '\r', delayMs: 150 }, //   submit the carry turn
    ]);
  });
  it('routes through controlWritesForAgent (reset dispatches to the reset plan)', () => {
    const d = decodeControl(encodeControl({ mode: 'reset', data: 'CARRY' }));
    expect(controlWritesForAgent(d, 'claude', {})).toEqual(resetWritesForAgent(d, 'claude', {}));
  });
  it('Codex: /new clear + the codex double-submit carry turn', () => {
    const d = decodeControl(encodeControl({ mode: 'reset', data: 'CARRY' }));
    expect(resetWritesForAgent(d, 'codex', {})).toEqual([
      { data: '/new', delayMs: 0 },
      { data: '\r', delayMs: 500 }, // codex submit delay
      { data: 'CARRY', delayMs: 1500 }, // carry text after the settle
      { data: '\r', delayMs: 500 }, // codex submit
      { data: '\r', delayMs: 300 }, // codex redundant resubmit
    ]);
  });
  it('an empty carry ⇒ a bare clear (no opening turn)', () => {
    const d = decodeControl(encodeControl({ mode: 'reset', data: '' }));
    expect(resetWritesForAgent(d, 'claude', {})).toEqual([
      { data: '/clear', delayMs: 0 },
      { data: '\r', delayMs: 150 },
    ]);
  });
  it('honours a custom clear-settle override', () => {
    const d = decodeControl(encodeControl({ mode: 'reset', data: 'CARRY' }));
    const steps = resetWritesForAgent(d, 'claude', { PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS: '600' });
    expect(steps[2]).toEqual({ data: 'CARRY', delayMs: 600 });
  });
});

describe('fleetOscFromEnv (launch-time fleet recolor)', () => {
  it('builds OSC 10/11/12 from the PAPERCUSP_FLEET_* env vars (matches oscRecolorSequence)', () => {
    expect(
      fleetOscFromEnv({
        PAPERCUSP_FLEET_BG: '#581c87',
        PAPERCUSP_FLEET_FG: '#f5e8ff',
        PAPERCUSP_FLEET_CURSOR: '#d8b4fe',
      }),
    ).toBe('\x1b]10;#f5e8ff\x07\x1b]11;#581c87\x07\x1b]12;#d8b4fe\x07');
  });
  it('returns null when no fleet bg is set — the no-fleet session keeps its profile default', () => {
    expect(fleetOscFromEnv({})).toBeNull();
    expect(fleetOscFromEnv({ PAPERCUSP_FLEET_FG: '#ffffff' })).toBeNull();
  });
  it('bg alone is enough; fg + cursor are optional', () => {
    expect(fleetOscFromEnv({ PAPERCUSP_FLEET_BG: '#166534' })).toBe('\x1b]11;#166534\x07');
  });
});

// fleet-recolor-and-color-hardening P-003: the OSC 10/11/12 recolor bytes are
// hand-written in THREE places that the source comments say must stay "in
// lockstep" — console-color-schemes.oscRecolorSequence (operator-core raw bytes),
// psu-pty-host.fleetOscFromEnv (this file's inline copy), and console-spawn's
// shell prelude (the bee / capability:terminal path, reached via
// buildConsoleOneliner). This guard fails the moment any of the three drifts on
// an OSC number or a color value, for ANY catalog scheme.
describe('OSC emitter drift guard (the 3 fleet-color emitters must agree)', () => {
  // Extract every OSC 10/11/12 color directive ("]1N;#rrggbb") from a string —
  // works on the raw-byte sequences AND the shell `printf '\033]1N;#rrggbb\007'`
  // form. Returns { '10': fg, '11': bg, '12': cursor }.
  function oscColorMap(s: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of s.matchAll(/\]1([012]);(#[0-9a-fA-F]{6})/g)) out[`1${m[1]}`] = m[2].toLowerCase();
    return out;
  }

  it('all three emitters produce the same OSC 10/11/12 colors for every catalog scheme', () => {
    for (const s of COLOR_SCHEMES) {
      const expected = { '10': s.fg, '11': s.bg, '12': s.cursor };
      // 1. operator-core raw bytes (the canonical recolor sequence)
      expect(oscColorMap(oscRecolorSequence(s))).toEqual(expected);
      // 2. psu-pty-host's inline copy from env — MUST be byte-identical to #1
      expect(
        fleetOscFromEnv({
          PAPERCUSP_FLEET_BG: s.bg,
          PAPERCUSP_FLEET_FG: s.fg,
          PAPERCUSP_FLEET_CURSOR: s.cursor,
        }),
      ).toBe(oscRecolorSequence(s));
      // 3. the console-spawn shell prelude (bee / capability:terminal window)
      const oneliner = buildConsoleOneliner('/x', {}, 'true', {
        mode: 'console',
        planSlug: null,
        label: null,
        scheme: s,
      });
      expect(oscColorMap(oneliner)).toEqual(expected);
    }
  });
});

describe('makeIdleGate (P-013 mid-keystroke safety)', () => {
  it('is idle immediately when nothing was ever typed', () => {
    const g = makeIdleGate({ idleMs: 100, now: () => 1000 });
    expect(g.remainingIdleMs(1000)).toBe(0);
  });
  it('reports the remaining wait right after a keystroke, then idle', () => {
    let t = 1000;
    const g = makeIdleGate({ idleMs: 100, now: () => t });
    g.touch(); // typed at t=1000
    expect(g.remainingIdleMs(1000)).toBe(100); // must wait the full window
    expect(g.remainingIdleMs(1050)).toBe(50); // halfway
    expect(g.remainingIdleMs(1100)).toBe(0); // window elapsed → idle
    expect(g.remainingIdleMs(1200)).toBe(0); // stays idle
  });
  it('waitIdle resolves immediately when already idle', async () => {
    const g = makeIdleGate({ idleMs: 50, capMs: 1000 });
    const r = await g.waitIdle();
    expect(r.deferred).toBe(false);
  });
  it('waitIdle defers a write while typing continues, bounded by capMs', async () => {
    // Tiny idle window + tiny cap: never goes idle (we keep "typing" via a clock
    // that always advances less than idleMs since the last touch) → cap fires.
    let t = 0;
    const g = makeIdleGate({ idleMs: 1_000_000, capMs: 30, now: () => (t += 10) });
    const r = await g.waitIdle();
    expect(r.deferred).toBe(true);
    expect(r.reason).toBe('idle-cap');
  });
});

/**
 * makeActivityTracker (liveness-hardening P-006/P-007): the output-side
 * sibling of makeIdleGate. lastOutputAt fresh = the agent is emitting RIGHT
 * NOW (a generating TUI repaints constantly); lastActivityAt = max(in, out).
 * Annotate-only (plan D-002) — display/triage, never claim release.
 */
describe('makeActivityTracker (P-006 mid-turn activity)', () => {
  it('starts with null activity (never seen)', () => {
    const a = makeActivityTracker({ now: () => 123 });
    expect(a.snapshot()).toEqual({ lastInputAt: null, lastOutputAt: null, lastActivityAt: null });
  });

  it('tracks input and output independently; lastActivityAt is the max', () => {
    let t = 100;
    const a = makeActivityTracker({ now: () => t });
    a.touchInput();
    t = 250;
    a.touchOutput();
    expect(a.snapshot()).toEqual({ lastInputAt: 100, lastOutputAt: 250, lastActivityAt: 250 });
    t = 400;
    a.touchInput();
    expect(a.snapshot().lastActivityAt).toBe(400);
    expect(a.snapshot().lastOutputAt).toBe(250);
  });

  it('output alone marks the session active (the heads-down generating case)', () => {
    let t = 7;
    const a = makeActivityTracker({ now: () => t });
    a.touchOutput();
    expect(a.snapshot()).toEqual({ lastInputAt: null, lastOutputAt: 7, lastActivityAt: 7 });
  });

  it('persist cadence is coarse (≥5s) so the pty bridge never becomes an fs hot loop', () => {
    expect(ACTIVITY_PERSIST_MS).toBeGreaterThanOrEqual(5_000);
  });
});

/**
 * makeAgentBusyGate (coord-wake-mid-turn-2026-06-30): the mid-turn inject gate —
 * the OUTPUT-side sibling of makeIdleGate. A wake `turn` (text + CR) written into
 * a TUI that is still GENERATING wedges the turn (needs ESC) — the multi-recipient
 * `coord:send {wake:'required'}` broadcast hang. This gate holds the inject until
 * the agent is back at its prompt (its pty output has been quiet for quietMs), and
 * DROPS the live inject if the agent stays busy past capMs (the durable inbox
 * message stands for the next turn). The pty output stream is the mid-turn signal.
 */
describe('makeAgentBusyGate (mid-turn inject safety)', () => {
  it('quietForMs reports how long the agent output has been quiet', () => {
    let lastOut = 1000;
    const g = makeAgentBusyGate({ lastOutputAt: () => lastOut, now: () => lastOut });
    expect(g.quietForMs(1000)).toBe(0); // just emitted
    expect(g.quietForMs(1300)).toBe(300); // 300ms of quiet since
  });

  it('treats "never emitted" (lastOutputAt 0) as quiet/at-prompt', () => {
    // A fresh idle session that has produced no output yet is at its prompt —
    // quietForMs is the full epoch, far past any quietMs, so a wake injects now.
    const g = makeAgentBusyGate({ lastOutputAt: () => 0, now: () => 5000, quietMs: 100 });
    expect(g.quietForMs()).toBe(5000);
  });

  it('waitAtPrompt resolves immediately (not deferred) when output is already quiet', async () => {
    // Output last seen at t=0, clock at t=5000, quiet window 100 → 5000ms of quiet
    // ≫ 100 → inject now, no deferral.
    const g = makeAgentBusyGate({ lastOutputAt: () => 0, now: () => 5000, quietMs: 100, capMs: 1000 });
    const r = await g.waitAtPrompt();
    expect(r.deferred).toBe(false);
  });

  it('waitAtPrompt DEFERS (drops the live inject) when the agent stays busy past capMs', async () => {
    // The agent is perpetually "emitting" (lastOutputAt tracks the advancing clock,
    // so quietForMs stays ~0 < quietMs) → it never reaches the prompt → cap fires.
    // Mirrors the makeIdleGate cap test: an advancing clock + the real min-10ms
    // setTimeout pace the loop to the deadline. This is the anti-wedge guarantee —
    // a busy turn is NEVER written into; the wake falls back to the durable inbox.
    let t = 0;
    const g = makeAgentBusyGate({
      lastOutputAt: () => t, // last output is always "now" → never quiet
      quietMs: 1_000_000,
      capMs: 30,
      now: () => (t += 10),
    });
    const r = await g.waitAtPrompt();
    expect(r.deferred).toBe(true);
    expect(r.reason).toBe('agent-busy');
  });

  // WI-1872 (1): the compaction completion-wait needs a DIFFERENT (generous)
  // cap than the gate's own construction-time capMs (sized for a wake turn) —
  // waitAtPrompt(overrideCapMs) lets one gate instance serve both budgets.
  // (Small millisecond scale throughout, mirroring the existing DEFERS test
  // above — the fake `now()` advances in fixed 10ms ticks per call, and each
  // loop iteration's setTimeout is a REAL wait sized off the FAKE deadline
  // delta, so a large capMs here would balloon into a very slow real test.)
  it('waitAtPrompt(overrideCapMs) uses the override instead of the gate\'s own capMs', async () => {
    let t = 0;
    const g = makeAgentBusyGate({
      lastOutputAt: () => t, // perpetually busy
      quietMs: 1_000_000,
      capMs: 20, // the gate's OWN (small) cap — must be ignored here
      now: () => (t += 10),
    });
    const r = await g.waitAtPrompt(80); // a larger override
    expect(r.deferred).toBe(true);
    expect(r.reason).toBe('agent-busy');
    expect(t).toBeGreaterThanOrEqual(80); // ran the OVERRIDE budget, not the 20ms one
  });

  it('waitAtPrompt() with no override still uses the gate\'s own capMs (back-compat)', async () => {
    let t = 0;
    const g = makeAgentBusyGate({
      lastOutputAt: () => t,
      quietMs: 1_000_000,
      capMs: 20,
      now: () => (t += 10),
    });
    const r = await g.waitAtPrompt();
    expect(r.deferred).toBe(true);
    expect(t).toBeLessThan(80); // stayed close to the small 20ms cap, not the 80ms override
  });

  // WI-1872 (2): the START-RACE fix — waitUntilBusy resolves the moment output
  // goes busy, instead of a blind fixed delay that can race a slow-to-emit
  // compaction summarizer.
  describe('waitUntilBusy (WI-1872 (2) — bounded wait for the agent to go busy)', () => {
    it('resolves { started:true } as soon as output is observed busy', async () => {
      let t = 0;
      let busyAt = 50; // output goes busy at t=50
      const g = makeAgentBusyGate({
        lastOutputAt: () => (t >= busyAt ? t : 0),
        quietMs: 5, // "busy" = quiet-for < 5ms
        now: () => (t += 10),
      });
      const r = await g.waitUntilBusy(1000);
      expect(r.started).toBe(true);
      expect(t).toBeGreaterThanOrEqual(busyAt);
    });

    it('falls back to { started:false } after capMs when busy is never observed', async () => {
      let t = 0;
      const g = makeAgentBusyGate({
        lastOutputAt: () => 0, // never emits — always reads as quiet/at-prompt
        quietMs: 5,
        now: () => (t += 10),
      });
      const r = await g.waitUntilBusy(30);
      expect(r.started).toBe(false);
    });
  });
});

/**
 * makeSubmitVerifier (WI-2930): the POST-submit sibling of makeAgentBusyGate. An
 * injected submit's CR can be swallowed (paste-settle race; a compact/reset carry
 * typed into a briefly-locked TUI) — the turn text then sits staged in the
 * composer and the session parks until a human presses Enter (the ~6h Snippets
 * stall). The verifier polls output activity after the final CR and writes one
 * bare resubmit CR at each QUIET observation — a bare CR on an empty idle
 * composer is a no-op, so redundant resubmits are harmless.
 */
describe('makeSubmitVerifier (WI-2930 verify-and-resubmit)', () => {
  /** Deterministic rig: `sleep` ADVANCES the fake clock; output/input are
   *  functions of the current fake time. CRs record the time they were sent. */
  function rig({
    output,
    input,
    pollMs = 100,
    polls = 4,
    maxResubmits = 3,
    quietMs = 50,
    writeCr,
  }: {
    output: (t: number) => number;
    input?: (t: number) => number;
    pollMs?: number;
    polls?: number;
    maxResubmits?: number;
    quietMs?: number;
    writeCr?: () => void;
  }) {
    let t = 0;
    const crs: number[] = [];
    const resubmitCalls: number[] = [];
    const v = makeSubmitVerifier({
      lastOutputAt: () => output(t),
      lastInputAt: input ? () => input(t) : undefined,
      writeCr: writeCr ?? (() => crs.push(t)),
      quietMs,
      pollMs,
      polls,
      maxResubmits,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      onResubmit: (n: number) => resubmitCalls.push(n),
    });
    return { v, crs, resubmitCalls };
  }

  it('a submitted turn (output flowing at every poll) needs no resubmit', async () => {
    // The turn is running: last output always "just now".
    const { v, crs } = rig({ output: (t) => t });
    const r = await v.verify();
    expect(r).toEqual({ polls: 4, resubmits: 0, aborted: null });
    expect(crs).toEqual([]);
  });

  it('a swallowed CR (output stays quiet) is resubmitted, capped at maxResubmits', async () => {
    // Nothing ever starts: output frozen at 0 → every poll observes quiet.
    const { v, crs, resubmitCalls } = rig({ output: () => 0, polls: 6, maxResubmits: 3 });
    const r = await v.verify();
    expect(r.resubmits).toBe(3);
    expect(r.aborted).toBeNull();
    expect(crs).toHaveLength(3);
    expect(resubmitCalls).toEqual([1, 2, 3]);
  });

  it('stops resubmitting once a resubmit takes (output starts flowing)', async () => {
    // Quiet at poll 1 (t=100) → one CR; from t=150 the turn is running.
    const { v, crs } = rig({ output: (t) => (t >= 150 ? t : 0) });
    const r = await v.verify();
    expect(r.resubmits).toBe(1);
    expect(crs).toEqual([100]);
  });

  it('covers the compact trap: busy residual output first, THEN the quiet reveal', async () => {
    // Residual compaction output until t=250 (looks "submitted"), then quiet —
    // the staged carry is only revealed late; the verifier still catches it
    // because it never early-exits on a busy observation.
    const { v, crs } = rig({ output: (t) => (t <= 250 ? t : 250), polls: 6 });
    const r = await v.verify();
    // polls at t=100..200 busy; from t=300 on, quiet grows past quietMs → CRs.
    expect(r.resubmits).toBeGreaterThan(0);
    expect(crs[0]).toBeGreaterThan(250);
  });

  it('aborts (and stops writing) the moment a HUMAN keystroke lands mid-window', async () => {
    // Quiet throughout, but the human types at t=150 — the verifier must never
    // fight a human who is editing the staged line.
    const { v, crs } = rig({ output: () => 0, input: (t) => (t >= 150 ? t : 0), polls: 6 });
    const r = await v.verify();
    expect(r.aborted).toBe('human-input');
    expect(crs).toEqual([100]); // the one pre-abort resubmit only
  });

  it('WI-2975: an ordinary silent "thinking" gap spanning a poll boundary no longer misfires at the new, decoupled default quietMs — but WOULD have under the old (reused OUTPUT_QUIET_MS=1500) default', async () => {
    // Production-realistic pollMs (5000ms, the real SUBMIT_VERIFY_POLL_MS default).
    // The submitted turn genuinely starts, but produces no output at all for the
    // first 5.5s (a normal thinking/network-latency gap that straddles the first
    // 5s poll) before flowing continuously from then on.
    const output = (t: number) => (t >= 5_500 ? t : 0);

    // OLD behavior (bug): reusing the busy-gate's short 1500ms threshold reads
    // that ordinary gap as "nothing happened" at the first poll and resubmits.
    const old = rig({ output, pollMs: 5_000, polls: 3, quietMs: 1_500 });
    const rOld = await old.v.verify();
    expect(rOld.resubmits).toBeGreaterThan(0);

    // NEW behavior (fixed): the verifier's own, larger, decoupled quiet bar
    // (matching the new SUBMIT_VERIFY_QUIET_MS default of 6000ms) recognizes the
    // same gap as ordinary turn latency — zero spurious resubmits.
    const fresh = rig({ output, pollMs: 5_000, polls: 3, quietMs: 6_000 });
    const rNew = await fresh.v.verify();
    expect(rNew.resubmits).toBe(0);
    expect(fresh.crs).toEqual([]);
  });

  it('a writeCr throw (child exited mid-verify) never rejects', async () => {
    const { v } = rig({
      output: () => 0,
      writeCr: () => {
        throw new Error('child gone');
      },
    });
    await expect(v.verify()).resolves.toMatchObject({ aborted: null });
  });
});

describe('same-source turn coalescing (compaction-continuity-hardening P-001a)', () => {
  const wake = (n: number) =>
    `🔁 Loop wake (every ~120s after each turn settles). You are continuing toward: goal G\n\ndetails for wake #${n}`;

  describe('turnCoalesceKey', () => {
    it('keys on the first non-empty line — stable across wakes of the same loop', () => {
      expect(turnCoalesceKey(wake(1))).toBe(turnCoalesceKey(wake(9)));
      expect(turnCoalesceKey('\n\n  first real line\nrest')).toBe('first real line');
    });
    it('distinct sources get distinct keys', () => {
      expect(turnCoalesceKey(wake(1))).not.toBe(turnCoalesceKey('owner: please check the deploy'));
    });
    it('caps the key and tolerates empty/undefined', () => {
      expect(turnCoalesceKey('x'.repeat(1000)).length).toBe(300);
      expect(turnCoalesceKey('')).toBe('');
      expect(turnCoalesceKey(undefined)).toBe('');
    });
  });

  describe('renderCoalescedTurn', () => {
    it('folded=0 → the text verbatim (the common single-wake path is byte-identical)', () => {
      expect(renderCoalescedTurn('text', 0)).toBe('text');
    });
    it('folded>0 → ONE annotated delivery telling the agent not to treat them as separate wakes', () => {
      const out = renderCoalescedTurn('text', 8);
      expect(out).toContain('text');
      expect(out).toContain('8 duplicate queued wakes were coalesced');
      expect(out).toContain('treat this as a single wake');
    });
  });

  describe('makeTurnCoalescer', () => {
    it('first arrival becomes the waiter; later same-key arrivals FOLD (newest text wins)', () => {
      const c = makeTurnCoalescer();
      expect(c.admit('k', wake(1))).toBe(false); // waiter
      expect(c.admit('k', wake(2))).toBe(true); // folded
      expect(c.admit('k', wake(3))).toBe(true); // folded
      const claimed = c.claim('k');
      expect(claimed).toEqual({ data: wake(3), folded: 2 });
      expect(c.size()).toBe(0);
    });

    it('different keys wait independently (no cross-source folding)', () => {
      const c = makeTurnCoalescer();
      expect(c.admit('a', 'A1')).toBe(false);
      expect(c.admit('b', 'B1')).toBe(false);
      expect(c.claim('a')).toEqual({ data: 'A1', folded: 0 });
      expect(c.claim('b')).toEqual({ data: 'B1', folded: 0 });
    });

    it('claim clears the slot: a later arrival starts a FRESH cycle (no folding into a dead waiter)', () => {
      const c = makeTurnCoalescer();
      c.admit('k', wake(1));
      c.claim('k'); // delivery (or defer/error) cleared it
      expect(c.admit('k', wake(2))).toBe(false); // new waiter, not folded
    });

    it('claim is idempotent — the error-path double-claim is a safe no-op', () => {
      const c = makeTurnCoalescer();
      c.admit('k', wake(1));
      expect(c.claim('k')).not.toBeNull();
      expect(c.claim('k')).toBeNull();
    });

    it('the measured 9× scenario: 9 stacked wakes → ONE delivery annotated with 8 folds', () => {
      const c = makeTurnCoalescer();
      const key = turnCoalesceKey(wake(1));
      expect(c.admit(key, wake(1))).toBe(false);
      for (let n = 2; n <= 9; n++) expect(c.admit(key, wake(n))).toBe(true);
      const claimed = c.claim(key)!;
      const delivered = renderCoalescedTurn(claimed.data, claimed.folded);
      expect(claimed.folded).toBe(8);
      expect(delivered).toContain('details for wake #9'); // newest wins
      expect(delivered).toContain('8 duplicate queued wakes were coalesced');
    });
  });
});

/**
 * makeInjectMutex (EI-8822): serializes the GATED-inject critical section within a
 * host so two injects freed at the same clean boundary — a coord wake `turn` and a
 * session:request-compaction `/compact` — can never both pass the at-prompt gate
 * and interleave their bytes into one pty input line (which concatenates the
 * second's text after the first, so the CLI reads "<wake…>/compact <focus>" as
 * prose, not a command, and the compaction silently never runs).
 */
describe('makeInjectMutex (EI-8822 — gated-inject serialization)', () => {
  it('the second acquirer does NOT enter its critical section until the first releases', async () => {
    const m = makeInjectMutex();
    const events: string[] = [];

    const r1 = await m.acquire(); // holder 1 has the lock
    events.push('1:enter');

    // Holder 2 tries to acquire while holder 1 still holds it.
    let entered2 = false;
    const p2 = m.acquire().then((r2) => {
      entered2 = true;
      events.push('2:enter');
      return r2;
    });

    // Let any pending microtasks flush — holder 2 must STILL be blocked.
    await Promise.resolve();
    await Promise.resolve();
    expect(entered2).toBe(false);
    expect(events).toEqual(['1:enter']);

    events.push('1:release');
    r1(); // free the lock → holder 2 unblocks
    const r2 = await p2;
    expect(entered2).toBe(true);
    r2();
    // The critical sections never overlapped: 1 fully done before 2 began.
    expect(events).toEqual(['1:enter', '1:release', '2:enter']);
  });

  it('the two gated injects (a wake turn + a /compact) run write-sequences that never interleave', async () => {
    // Model the exact race: both injects are released at the same clean boundary
    // and each writes its bytes as a short sequence. Without the mutex, the two
    // sequences interleave into one line ("<wake>/compact"); with it, one whole
    // sequence completes before the other starts.
    const m = makeInjectMutex();
    const line: string[] = [];
    // A gated inject writes its text, yields (a paste-settle delay), then its CR.
    const gatedInject = async (label: string, text: string) => {
      const release = await m.acquire();
      try {
        line.push(`${label}:${text}`);
        await Promise.resolve(); // the delay between text and submit CR
        await Promise.resolve();
        line.push(`${label}:CR`);
      } finally {
        release();
      }
    };
    // Fire both "at the same time" (same clean boundary).
    await Promise.all([gatedInject('wake', 'do X'), gatedInject('compact', '/compact focus')]);
    // Each inject's text and CR are adjacent — never split by the other's write.
    const wakeText = line.indexOf('wake:do X');
    const wakeCr = line.indexOf('wake:CR');
    const compactText = line.indexOf('compact:/compact focus');
    const compactCr = line.indexOf('compact:CR');
    expect(wakeCr).toBe(wakeText + 1); // wake text immediately followed by its CR
    expect(compactCr).toBe(compactText + 1); // compact text immediately followed by its CR
    // And one whole inject completes before the other begins (no interleave).
    const wakeFirst = wakeText < compactText;
    expect(line).toEqual(
      wakeFirst
        ? ['wake:do X', 'wake:CR', 'compact:/compact focus', 'compact:CR']
        : ['compact:/compact focus', 'compact:CR', 'wake:do X', 'wake:CR'],
    );
  });

  it('preserves FIFO order across three waiters', async () => {
    const m = makeInjectMutex();
    const order: number[] = [];
    const run = async (n: number) => {
      const release = await m.acquire();
      order.push(n);
      await Promise.resolve();
      release();
    };
    // Enqueue in order; each acquire() chains onto the prior tail (FIFO).
    const p1 = run(1);
    const p2 = run(2);
    const p3 = run(3);
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('a throwing critical section still releases the lock (the finally contract) — the queue never wedges', async () => {
    const m = makeInjectMutex();
    const order: string[] = [];
    // Holder 1 throws AFTER acquiring but releases in its finally (as the handler does).
    const p1 = (async () => {
      const release = await m.acquire();
      try {
        order.push('1');
        throw new Error('inject blew up (child exited mid-inject)');
      } finally {
        release();
      }
    })();
    await expect(p1).rejects.toThrow('inject blew up');
    // The next inject must still be able to acquire — no permanent wedge.
    const release2 = await m.acquire();
    order.push('2');
    release2();
    expect(order).toEqual(['1', '2']);
  });
});

describe('WI-3455 — pidLooksLikePsuHost (host-side identity check, mirrors psu-pty-discovery)', () => {
  it('accepts a psu-launcher / psu-pty-host cmdline, rejects unrelated processes', () => {
    expect(pidLooksLikePsuHost(123, () => 'node /x/scripts/psu-launcher.mjs --resume abc')).toBe(true);
    expect(pidLooksLikePsuHost(123, () => 'node /x/scripts/psu-pty-host.mjs')).toBe(true);
    expect(pidLooksLikePsuHost(123, () => 'nginx: worker process')).toBe(false);
    expect(pidLooksLikePsuHost(0, () => 'node psu-launcher.mjs')).toBe(false);
  });
  it('an unreadable cmdline rejects on Linux (pid vanished/zombie), fails open only without /proc', () => {
    const hasProc = nodeFs.existsSync('/proc');
    expect(pidLooksLikePsuHost(123, () => null)).toBe(!hasProc);
  });
});

describe('WI-3455 — findLiveHostFor (the launcher resume-of-live guard read)', () => {
  const fs = nodeFs;
  const mkOwner = () => `su-flhf-utest-${process.pid}-${Math.floor(performance.now() * 1000)}`;
  const writeMetaFile = (ownerId: string, meta: Record<string, unknown>) => {
    fs.mkdirSync(PSU_PTY_DIR, { recursive: true });
    fs.writeFileSync(metaPathFor(ownerId), JSON.stringify(meta));
  };
  const cleanup = (ownerId: string) => {
    for (const p of [metaPathFor(ownerId), socketPathFor(ownerId)]) {
      try { fs.unlinkSync(p); } catch { /* absent is fine */ }
    }
  };

  it('returns the meta for a live, identity-verified host whose sock exists', () => {
    const ownerId = mkOwner();
    try {
      fs.writeFileSync(socketPathFor(ownerId), ''); // stand-in for the bound node
      writeMetaFile(ownerId, { ownerId, pid: process.pid, sock: socketPathFor(ownerId) });
      const hit = findLiveHostFor(ownerId, { verifyIdentity: () => true });
      expect(hit?.pid).toBe(process.pid);
    } finally { cleanup(ownerId); }
  });

  it('returns null on: missing file, recorded-owner mismatch, dead pid, failed identity, missing sock', () => {
    const ownerId = mkOwner();
    try {
      expect(findLiveHostFor(ownerId)).toBeNull(); // no file

      fs.writeFileSync(socketPathFor(ownerId), '');
      writeMetaFile(ownerId, { ownerId: 'su-someone-else', pid: process.pid, sock: socketPathFor(ownerId) });
      expect(findLiveHostFor(ownerId, { verifyIdentity: () => true })).toBeNull(); // EI-151 mismatch

      writeMetaFile(ownerId, { ownerId, pid: 999_999_999, sock: socketPathFor(ownerId) });
      expect(findLiveHostFor(ownerId, { verifyIdentity: () => true })).toBeNull(); // dead pid

      writeMetaFile(ownerId, { ownerId, pid: process.pid, sock: socketPathFor(ownerId) });
      expect(findLiveHostFor(ownerId, { verifyIdentity: () => false })).toBeNull(); // not a psu host

      fs.unlinkSync(socketPathFor(ownerId));
      expect(findLiveHostFor(ownerId, { verifyIdentity: () => true })).toBeNull(); // sock gone
    } finally { cleanup(ownerId); }
  });
});
