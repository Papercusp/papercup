// @vitest-environment node
/**
 * psu-pty-host.test.ts — pure-logic unit tests for the managed-pty host
 * (turn-lifecycle-control Phase 3, P-012/P-013). The real-pty round-trip
 * (spawn → socket-inject → cleanup) lives in psu-pty-host.integration.test.ts.
 */
import { describe, it, expect } from 'vitest';
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
  fleetOscFromEnv,
  turnSubmitCrDelayForAgent,
  makeIdleGate,
  makeActivityTracker,
  makeAgentBusyGate,
  ACTIVITY_PERSIST_MS,
  PSU_PTY_DIR,
} from '../scripts/psu-pty-host.mjs';
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
    const d = decodeControl(encodeControl({ mode: 'raw', data: '' })); // Ctrl-C
    expect(d).toEqual({ mode: 'raw', data: '', gated: false });
    expect(controlBytes(d)).toBe('');
  });
  it('Esc force interrupt round-trips', () => {
    expect(controlBytes(decodeControl(encodeControl({ mode: 'raw', data: '' })))).toBe('');
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
  it('codex has no compaction → null (the host injects nothing)', () => {
    expect(compactCommandForAgent('codex', 'keep X')).toBeNull();
    expect(compactCommandForAgent(' CODEX ', 'keep X')).toBeNull();
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
});
