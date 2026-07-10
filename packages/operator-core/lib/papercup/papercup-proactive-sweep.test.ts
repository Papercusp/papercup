/**
 * Unit tests for the server-side Sentinel proactive sweep engine.
 *
 * The engine is pure + fully dependency-injected, so these tests pass FAKE deps
 * directly — no module mocks. They pin the load-bearing safety contract:
 *
 *   - GATED OFF (FLAGS.PAPERCUP_PROACTIVE default off) ⇒ NO proactive fire, and
 *     none of the work deps (gather / scan / speak / push) are even consulted —
 *     PROVING live behavior is byte-for-byte unchanged by default.
 *   - GATED ON + an anomaly ⇒ EXACTLY ONE throttled utterance (the broadcast/speak
 *     dep is called once; a second tick inside the throttle window is suppressed).
 *   - DND / pause / over-budget / proactive-ticks-off each SUPPRESS the sweep.
 *   - The SINGLE-OWNER guard (ownsVoiceLease=false) blocks the sweep so it never
 *     double-fires alongside a browser provider / a second host.
 *   - Voice-OFF (no live session) routes a SALIENT alert via attention-push +
 *     hindsight; a non-salient status stays quiet.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runSentinelProactiveSweep,
  resetSentinelSweepThrottle,
  sentinelSweepThrottleMs,
  type SentinelSweepDeps,
  type SentinelSweepState,
  type SentinelFleetStatus,
} from './papercup-proactive-sweep';

/** A fleet status with a salient (critical) item by default. */
const SALIENT: SentinelFleetStatus = {
  context: '## Live system status\n- queen-dark (critical)',
  salient: true,
  headline: 'Queen is dark.',
};
const QUIET: SentinelFleetStatus = {
  context: '## Live system status\n(all quiet)',
  salient: false,
  headline: null,
};

/** All gates pass; Sentinel speaks "all good" and a live session exists. */
function makeDeps(over: Partial<SentinelSweepDeps> = {}): {
  deps: SentinelSweepDeps;
  spies: {
    flagEnabled: ReturnType<typeof vi.fn>;
    isSilenced: ReturnType<typeof vi.fn>;
    isPaused: ReturnType<typeof vi.fn>;
    proactiveTicksEnabled: ReturnType<typeof vi.fn>;
    overBudget: ReturnType<typeof vi.fn>;
    gatherFleetStatus: ReturnType<typeof vi.fn>;
    runSentinelScan: ReturnType<typeof vi.fn>;
    speakIntoSession: ReturnType<typeof vi.fn>;
    pushAttention: ReturnType<typeof vi.fn>;
    notifyHindsight: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    flagEnabled: vi.fn(async () => true),
    isSilenced: vi.fn(async () => false),
    isPaused: vi.fn(async () => false),
    proactiveTicksEnabled: vi.fn(async () => true),
    overBudget: vi.fn(async () => false),
    gatherFleetStatus: vi.fn(async () => SALIENT),
    runSentinelScan: vi.fn(async () => 'Heads up — the queen went dark.'),
    speakIntoSession: vi.fn(async () => true),
    pushAttention: vi.fn(async () => {}),
    notifyHindsight: vi.fn(async () => {}),
  };
  const deps: SentinelSweepDeps = {
    flagEnabled: spies.flagEnabled,
    isSilenced: spies.isSilenced,
    isPaused: spies.isPaused,
    proactiveTicksEnabled: spies.proactiveTicksEnabled,
    overBudget: spies.overBudget,
    gatherFleetStatus: spies.gatherFleetStatus,
    runSentinelScan: spies.runSentinelScan,
    speakIntoSession: spies.speakIntoSession,
    pushAttention: spies.pushAttention,
    notifyHindsight: spies.notifyHindsight,
    now: () => 1_000_000,
    log: () => {},
    ...over,
  };
  return { deps, spies };
}

const LIVE: SentinelSweepState = { sessionLive: true, ownsVoiceLease: true, humanFacingRole: 'papercup' };
const VOICE_OFF: SentinelSweepState = { sessionLive: false, ownsVoiceLease: true, humanFacingRole: 'papercup' };

beforeEach(() => {
  resetSentinelSweepThrottle();
});

describe('runSentinelProactiveSweep — GATED OFF proves live behavior unchanged', () => {
  it('flag OFF ⇒ no fire AND none of the work deps are consulted', async () => {
    const { deps, spies } = makeDeps({ flagEnabled: vi.fn(async () => false) });
    const r = await runSentinelProactiveSweep(LIVE, deps);
    expect(r).toEqual({ fired: false, gate: 'flag-off' });
    // The whole point: when dark, the sweep does NOTHING but read the flag.
    expect(spies.gatherFleetStatus).not.toHaveBeenCalled();
    expect(spies.runSentinelScan).not.toHaveBeenCalled();
    expect(spies.speakIntoSession).not.toHaveBeenCalled();
    expect(spies.pushAttention).not.toHaveBeenCalled();
    expect(spies.notifyHindsight).not.toHaveBeenCalled();
  });

  it('persona is operator (not sentinel) ⇒ no fire', async () => {
    const { deps, spies } = makeDeps();
    const r = await runSentinelProactiveSweep({ ...LIVE, humanFacingRole: 'operator' }, deps);
    expect(r).toEqual({ fired: false, gate: 'not-sentinel' });
    expect(spies.speakIntoSession).not.toHaveBeenCalled();
  });
});

describe('runSentinelProactiveSweep — GATED ON fires exactly one throttled utterance', () => {
  it('flag ON + sentinel + live session ⇒ speaks once into the session', async () => {
    const { deps, spies } = makeDeps();
    const r = await runSentinelProactiveSweep(LIVE, deps);
    expect(r).toEqual({ fired: true, via: 'voice', text: 'Heads up — the queen went dark.' });
    expect(spies.speakIntoSession).toHaveBeenCalledTimes(1);
    expect(spies.speakIntoSession).toHaveBeenCalledWith('Heads up — the queen went dark.');
  });

  it('a second tick INSIDE the throttle window is suppressed (exactly one utterance)', async () => {
    let t = 1_000_000;
    const { deps, spies } = makeDeps({ now: () => t });
    const first = await runSentinelProactiveSweep(LIVE, deps);
    expect(first.fired).toBe(true);
    // Advance less than the throttle window.
    t += sentinelSweepThrottleMs() - 1;
    const second = await runSentinelProactiveSweep(LIVE, deps);
    expect(second).toEqual({ fired: false, gate: 'throttled' });
    expect(spies.speakIntoSession).toHaveBeenCalledTimes(1);
  });

  it('a tick PAST the throttle window may fire again', async () => {
    let t = 1_000_000;
    const { deps, spies } = makeDeps({ now: () => t });
    await runSentinelProactiveSweep(LIVE, deps);
    t += sentinelSweepThrottleMs() + 1;
    const r = await runSentinelProactiveSweep(LIVE, deps);
    expect(r.fired).toBe(true);
    expect(spies.speakIntoSession).toHaveBeenCalledTimes(2);
  });

  it('Sentinel chose silence (empty <say>) ⇒ no fire AND the throttle is NOT consumed', async () => {
    let t = 1_000_000;
    const { deps, spies } = makeDeps({ now: () => t, runSentinelScan: vi.fn(async () => null) });
    const silent = await runSentinelProactiveSweep(LIVE, deps);
    expect(silent).toEqual({ fired: false, gate: 'silent' });
    expect(spies.speakIntoSession).not.toHaveBeenCalled();
    // A silent tick must not burn the cooldown — the next salient moment can speak.
    t += 1;
    deps.runSentinelScan = vi.fn(async () => 'Now there is something.');
    const r = await runSentinelProactiveSweep(LIVE, deps);
    expect(r.fired).toBe(true);
  });
});

describe('runSentinelProactiveSweep — DND / pause / budget / proactive-ticks suppress', () => {
  it('DND (silenceVoice) ⇒ suppressed', async () => {
    const { deps } = makeDeps({ isSilenced: vi.fn(async () => true) });
    expect(await runSentinelProactiveSweep(LIVE, deps)).toEqual({ fired: false, gate: 'dnd' });
  });

  it('operator paused ⇒ suppressed', async () => {
    const { deps } = makeDeps({ isPaused: vi.fn(async () => true) });
    expect(await runSentinelProactiveSweep(LIVE, deps)).toEqual({ fired: false, gate: 'paused' });
  });

  it('proactiveTicksEnabled off ⇒ suppressed', async () => {
    const { deps } = makeDeps({ proactiveTicksEnabled: vi.fn(async () => false) });
    expect(await runSentinelProactiveSweep(LIVE, deps)).toEqual({ fired: false, gate: 'proactive-ticks-off' });
  });

  it('over the daily budget ⇒ suppressed', async () => {
    const { deps } = makeDeps({ overBudget: vi.fn(async () => true) });
    expect(await runSentinelProactiveSweep(LIVE, deps)).toEqual({ fired: false, gate: 'over-budget' });
  });
});

describe('runSentinelProactiveSweep — single-owner guard blocks double-fire', () => {
  it('not the voice-lease owner ⇒ suppressed (never double-fires alongside a browser provider / 2nd host)', async () => {
    const { deps, spies } = makeDeps();
    const r = await runSentinelProactiveSweep({ ...LIVE, ownsVoiceLease: false }, deps);
    expect(r).toEqual({ fired: false, gate: 'not-lease-owner' });
    // Checked before any PG / brain read — a non-owner host is a pure no-op.
    expect(spies.isSilenced).not.toHaveBeenCalled();
    expect(spies.gatherFleetStatus).not.toHaveBeenCalled();
    expect(spies.speakIntoSession).not.toHaveBeenCalled();
  });
});

describe('runSentinelProactiveSweep — voice-OFF routes to attention-push + hindsight', () => {
  it('no live session + a SALIENT status ⇒ pushAttention + notifyHindsight (not speakIntoSession)', async () => {
    const { deps, spies } = makeDeps();
    const r = await runSentinelProactiveSweep(VOICE_OFF, deps);
    expect(r).toEqual({ fired: true, via: 'attention', headline: 'Queen is dark.' });
    expect(spies.pushAttention).toHaveBeenCalledTimes(1);
    expect(spies.pushAttention).toHaveBeenCalledWith('Queen is dark.');
    expect(spies.notifyHindsight).toHaveBeenCalledTimes(1);
    expect(spies.notifyHindsight).toHaveBeenCalledWith('Queen is dark.');
    expect(spies.speakIntoSession).not.toHaveBeenCalled();
    // The voice-OFF path never runs the spoken converse scan.
    expect(spies.runSentinelScan).not.toHaveBeenCalled();
  });

  it('no live session + a NON-salient status ⇒ stays quiet (no push, no throttle consumed)', async () => {
    let t = 1_000_000;
    const { deps, spies } = makeDeps({ now: () => t, gatherFleetStatus: vi.fn(async () => QUIET) });
    const quiet = await runSentinelProactiveSweep(VOICE_OFF, deps);
    expect(quiet).toEqual({ fired: false, gate: 'no-session-not-salient' });
    expect(spies.pushAttention).not.toHaveBeenCalled();
    expect(spies.notifyHindsight).not.toHaveBeenCalled();
    // Throttle not consumed → the next salient moment fires immediately.
    t += 1;
    deps.gatherFleetStatus = vi.fn(async () => SALIENT);
    const r = await runSentinelProactiveSweep(VOICE_OFF, deps);
    expect(r.fired).toBe(true);
  });

  it('voice-OFF push throttles like the voice path (one alert per window)', async () => {
    let t = 1_000_000;
    const { deps, spies } = makeDeps({ now: () => t });
    await runSentinelProactiveSweep(VOICE_OFF, deps);
    t += sentinelSweepThrottleMs() - 1;
    const second = await runSentinelProactiveSweep(VOICE_OFF, deps);
    expect(second).toEqual({ fired: false, gate: 'throttled' });
    expect(spies.pushAttention).toHaveBeenCalledTimes(1);
  });
});
