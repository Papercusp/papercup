/**
 * agent-productivity-watchdog — the widened present-but-unproductive sweep.
 *
 * The load-bearing assertion here is the CORRELATED WAVE: 22 wedged sessions
 * must produce one report per phase, not 22 reports. Everything else in this
 * module is suppression, and the suppression cases are drawn from the real
 * failure shapes (a degraded oracle, an unmeasured subject, a parked session
 * with no self-wake).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';

import {
  runAgentProductivitySweepOnce,
  type AgentPresenceCandidate,
  type AgentCallCensus,
  type AgentWedgeWave,
  type AgentIdeateSilenceWave,
  type AgentProductivitySweepDeps,
  IDEATE_PASS_GRACE_MS,
} from './agent-productivity-watchdog';
import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import { AGENT_PRODUCTIVITY_GRACE_MS } from '../agent-wedge';

const NOW = 1_800_000_000_000;
const PAST_GRACE = NOW - (AGENT_PRODUCTIVITY_GRACE_MS + 60_000);
const FAKE_SQL = {} as Sql;

function candidate(over: Partial<AgentPresenceCandidate> & { ownerId: string }): AgentPresenceCandidate {
  return {
    ownerLabel: `su · ${over.ownerId}`,
    workspaceId: 'papercusp-workspace',
    agentRole: 'su',
    fleetSlug: null,
    source: 'omp-hook-session',
    host: null,
    pid: null,
    heartbeatAt: new Date(NOW - 30_000).toISOString(),
    startedAtMs: PAST_GRACE,
    ...over,
  };
}

/** A verdict the alive predicate accepts: parked WITH a self-wake source. */
function aliveVerdict(ownerId: string): LivenessVerdict {
  return {
    ownerId,
    sessionState: 'parked',
    wakeable: true,
    liveTurn: false,
    selfWake: 'loop',
  } as unknown as LivenessVerdict;
}

function harness(over: Partial<AgentProductivitySweepDeps> = {}) {
  const escalated: AgentWedgeWave[] = [];
  const ideateEscalated: AgentIdeateSilenceWave[] = [];
  const deps: Partial<AgentProductivitySweepDeps> = {
    flagEnabled: async () => true,
    now: () => NOW,
    graceMs: AGENT_PRODUCTIVITY_GRACE_MS,
    ideateGraceMs: IDEATE_PASS_GRACE_MS,
    escalateWave: async (w) => {
      escalated.push(w);
    },
    // The cadence leg is INERT by default: no candidate carries an ideate
    // registration, so every wedge-leg test below keeps exactly the meaning it
    // had before the leg existed — which is what makes them a regression signal
    // for it rather than a rewritten baseline.
    readIdeateRegistrations: async () => new Map(),
    readIdeatePasses: async () => new Map(),
    escalateIdeateWave: async (w) => {
      ideateEscalated.push(w);
    },
    ...over,
  };
  return { deps, escalated, ideateEscalated };
}

describe('runAgentProductivitySweepOnce', () => {
  // THE design claim. One cause, one report.
  it('collapses many wedged sessions into ONE wave per phase, not one alarm each', async () => {
    const candidates = Array.from({ length: 22 }, (_, i) =>
      candidate({
        ownerId: `su-${i}`,
        // Half in one fleet, half in another — fleet is a breakdown INSIDE the
        // wave, never a reason to split the report.
        fleetSlug: i % 2 === 0 ? 'fleet-a' : 'fleet-b',
      }),
    );
    const census = new Map<string, AgentCallCensus>(
      candidates.map((c) => [c.ownerId, { agentOriginCalls: 0, anyOriginCalls: 3 }]),
    );
    const { deps, escalated } = harness({
      readCandidates: async () => candidates,
      resolveLiveness: async (cs) => new Map(cs.map((c) => [c.ownerId, aliveVerdict(c.ownerId)])),
      readProductivity: async () => census,
    });

    const out = await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(out.wedged).toBe(22);
    expect(out.wavesEscalated).toBe(1);
    expect(escalated).toHaveLength(1);
    expect(escalated[0].phase).toBe('booted-never-worked');
    expect(escalated[0].victims).toHaveLength(22);
    expect(new Set(escalated[0].victims.map((v) => v.fleetSlug))).toEqual(
      new Set(['fleet-a', 'fleet-b']),
    );
  });

  // Two phases mean two unrelated repairs, so they must not share a report.
  it('splits waves by phase, because the two phases have different repairs', async () => {
    const candidates = [
      candidate({ ownerId: 'never-booted-1' }),
      candidate({ ownerId: 'never-booted-2' }),
      candidate({ ownerId: 'booted-1' }),
    ];
    const census = new Map<string, AgentCallCensus>([
      ['never-booted-1', { agentOriginCalls: 0, anyOriginCalls: 0 }],
      ['never-booted-2', { agentOriginCalls: 0, anyOriginCalls: 0 }],
      ['booted-1', { agentOriginCalls: 0, anyOriginCalls: 4 }],
    ]);
    const { deps, escalated } = harness({
      readCandidates: async () => candidates,
      resolveLiveness: async (cs) => new Map(cs.map((c) => [c.ownerId, aliveVerdict(c.ownerId)])),
      readProductivity: async () => census,
    });

    await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(escalated).toHaveLength(2);
    const byPhase = Object.fromEntries(escalated.map((w) => [w.phase, w.victims.length]));
    expect(byPhase).toEqual({ 'never-booted': 2, 'booted-never-worked': 1 });
  });

  // A degraded oracle fetch omits entries. Reading omission as presence would
  // alarm on every agent at once, off one transient DB hiccup.
  it('suppresses a candidate the oracle returned NO verdict for', async () => {
    const { deps, escalated } = harness({
      readCandidates: async () => [candidate({ ownerId: 'unresolved' })],
      resolveLiveness: async () => new Map(),
      readProductivity: async () =>
        new Map([['unresolved', { agentOriginCalls: 0, anyOriginCalls: 0 }]]),
    });

    const out = await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(out.present).toBe(0);
    expect(out.wedged).toBe(0);
    expect(escalated).toHaveLength(0);
  });

  it.each([
    ['ended', { sessionState: 'ended', selfWake: 'loop' }],
    ['parked with no self-wake', { sessionState: 'parked', selfWake: 'none' }],
  ])('does not count a %s session as present', async (_label, verdictOver) => {
    const { deps, escalated } = harness({
      readCandidates: async () => [candidate({ ownerId: 'gone' })],
      resolveLiveness: async () =>
        new Map([['gone', { ownerId: 'gone', wakeable: false, liveTurn: false, ...verdictOver } as unknown as LivenessVerdict]]),
      readProductivity: async () => new Map([['gone', { agentOriginCalls: 0, anyOriginCalls: 0 }]]),
    });

    const out = await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(out.present).toBe(0);
    expect(escalated).toHaveLength(0);
  });

  // An unmeasured subject is not a healthy one — but it is not reportable either.
  it('counts an unmeasured subject as unmeasured and never escalates it', async () => {
    const { deps, escalated } = harness({
      readCandidates: async () => [candidate({ ownerId: 'no-census' })],
      resolveLiveness: async (cs) => new Map(cs.map((c) => [c.ownerId, aliveVerdict(c.ownerId)])),
      readProductivity: async () => new Map(),
    });

    const out = await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(out.present).toBe(1);
    expect(out.unmeasured).toBe(1);
    expect(out.wedged).toBe(0);
    expect(escalated).toHaveLength(0);
  });

  it('never reports an agent that has produced agent-origin work', async () => {
    const { deps, escalated } = harness({
      readCandidates: async () => [candidate({ ownerId: 'working' })],
      resolveLiveness: async (cs) => new Map(cs.map((c) => [c.ownerId, aliveVerdict(c.ownerId)])),
      readProductivity: async () =>
        new Map([['working', { agentOriginCalls: 1, anyOriginCalls: 9 }]]),
    });

    const out = await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(out.present).toBe(1);
    expect(out.wedged).toBe(0);
    expect(escalated).toHaveLength(0);
  });

  it('holds fire on a session still inside the grace window', async () => {
    const { deps, escalated } = harness({
      readCandidates: async () => [candidate({ ownerId: 'fresh', startedAtMs: NOW - 60_000 })],
      resolveLiveness: async (cs) => new Map(cs.map((c) => [c.ownerId, aliveVerdict(c.ownerId)])),
      readProductivity: async () => new Map([['fresh', { agentOriginCalls: 0, anyOriginCalls: 2 }]]),
    });

    expect((await runAgentProductivitySweepOnce(FAKE_SQL, deps)).wedged).toBe(0);
    expect(escalated).toHaveLength(0);
  });

  it('no-ops entirely when the flag is off, without reading candidates', async () => {
    const readCandidates = vi.fn(async () => [candidate({ ownerId: 'x' })]);
    const { deps, escalated } = harness({ flagEnabled: async () => false, readCandidates });

    const out = await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(readCandidates).not.toHaveBeenCalled();
    expect(out).toEqual({
      scanned: 0,
      present: 0,
      wedged: 0,
      unmeasured: 0,
      wavesEscalated: 0,
      ideateSilent: 0,
      ideateSuppressedAsWedged: 0,
      ideateWavesEscalated: 0,
    });
    expect(escalated).toHaveLength(0);
  });

  // One bad group must not cost the rest of the batch; the escalation-side dedup
  // makes the next tick's retry idempotent.
  it('keeps escalating other waves when one escalate throws', async () => {
    const candidates = [
      candidate({ ownerId: 'nb' }),
      candidate({ ownerId: 'bnw' }),
    ];
    const escalated: AgentWedgeWave[] = [];
    const deps: Partial<AgentProductivitySweepDeps> = {
      flagEnabled: async () => true,
      now: () => NOW,
      graceMs: AGENT_PRODUCTIVITY_GRACE_MS,
      readCandidates: async () => candidates,
      resolveLiveness: async (cs) => new Map(cs.map((c) => [c.ownerId, aliveVerdict(c.ownerId)])),
      readProductivity: async () =>
        new Map([
          ['nb', { agentOriginCalls: 0, anyOriginCalls: 0 }],
          ['bnw', { agentOriginCalls: 0, anyOriginCalls: 5 }],
        ]),
      escalateWave: async (w) => {
        if (w.phase === 'never-booted') throw new Error('escalation surface down');
        escalated.push(w);
      },
      readIdeateRegistrations: async () => new Map(),
      readIdeatePasses: async () => new Map(),
      escalateIdeateWave: async () => {},
    };

    // The swallow is deliberate, so assert it rather than tolerate it: a silent
    // catch and a catch that reports are very different things to operate.
    // ⚠ Snapshot the calls BEFORE mockRestore — in Vitest mockRestore is
    // mockReset + restore, so it wipes mock.calls and the assertion would read 0.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let out: Awaited<ReturnType<typeof runAgentProductivitySweepOnce>>;
    let warnCalls: unknown[][];
    try {
      out = await runAgentProductivitySweepOnce(FAKE_SQL, deps);
      warnCalls = warn.mock.calls.map((c) => [...c]);
    } finally {
      warn.mockRestore();
    }

    expect(out.wedged).toBe(2);
    expect(out.wavesEscalated).toBe(1);
    expect(escalated.map((w) => w.phase)).toEqual(['booted-never-worked']);
    expect(warnCalls).toHaveLength(1);
    expect(String(warnCalls[0][0])).toContain('escalation surface down');
  });

  it('carries the evidence a reader needs onto each victim', async () => {
    const { deps, escalated } = harness({
      readCandidates: async () => [
        candidate({ ownerId: 'su-e90d5', fleetSlug: 'nonp2p-bug-drain', startedAtMs: NOW - 18 * 3_600_000 }),
      ],
      resolveLiveness: async (cs) => new Map(cs.map((c) => [c.ownerId, aliveVerdict(c.ownerId)])),
      readProductivity: async () =>
        new Map([['su-e90d5', { agentOriginCalls: 0, anyOriginCalls: 0 }]]),
    });

    await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(escalated[0].victims[0]).toMatchObject({
      ownerId: 'su-e90d5',
      fleetSlug: 'nonp2p-bug-drain',
      sessionState: 'parked',
      agentOriginCalls: 0,
      anyOriginCalls: 0,
    });
    expect(escalated[0].victims[0].presentForMs).toBeGreaterThan(17 * 3_600_000);
  });
});

/**
 * The cadence leg: same population, same instrument, a different predicate.
 * The wedge leg asks "is this agent producing ANY work?"; this asks "is it
 * producing the work its MODE obliges?"
 */
describe('runAgentProductivitySweepOnce — ideate cadence leg', () => {
  const REGISTERED_LONG_AGO = NOW - (IDEATE_PASS_GRACE_MS + 60_000);

  /** Registered past the grace, by a launcher rather than the agent itself. */
  function ideateReg(over: Partial<{ setAtMs: number; setBy: string; ownerDirected: boolean }> = {}) {
    return {
      setAtMs: REGISTERED_LONG_AGO,
      setBy: 'pc-admin-coord-ui',
      ownerDirected: false,
      ...over,
    };
  }

  // THE case from WI-42436: 251 agent-origin calls across 52 tools, zero
  // ideation. Busy is not the same as doing what the mode obliges, and every
  // count-based surface reads healthy for exactly this agent.
  it('reports an agent that is working normally but has never recorded a pass', async () => {
    const { deps, ideateEscalated, escalated } = harness({
      readCandidates: async () => [candidate({ ownerId: 'busy' })],
      resolveLiveness: async (cs) => new Map(cs.map((c) => [c.ownerId, aliveVerdict(c.ownerId)])),
      readProductivity: async () =>
        new Map([['busy', { agentOriginCalls: 251, anyOriginCalls: 260 }]]),
      readIdeateRegistrations: async () => new Map([['busy', ideateReg()]]),
      readIdeatePasses: async () => new Map(),
    });

    const out = await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(out.ideateSilent).toBe(1);
    expect(out.ideateSuppressedAsWedged).toBe(0);
    expect(out.ideateWavesEscalated).toBe(1);
    // Not wedged — it is working. The two legs must not be confused.
    expect(out.wedged).toBe(0);
    expect(escalated).toHaveLength(0);
    expect(ideateEscalated[0].victims[0]).toMatchObject({
      ownerId: 'busy',
      agentOriginCalls: 251,
      lastPassAtMs: null,
      setBy: 'pc-admin-coord-ui',
      ownerDirected: false,
    });
  });

  // Measured 2026-08-27: 13 of 13 ideate-silent sessions had ZERO agent-origin
  // calls. Their silence is explained by the wedge, which already reports them —
  // so this leg must stay quiet AND must not report a clean zero.
  it('suppresses ideate silence the wedge already explains, but still counts it', async () => {
    const { deps, ideateEscalated, escalated } = harness({
      readCandidates: async () => [candidate({ ownerId: 'wedged' })],
      resolveLiveness: async (cs) => new Map(cs.map((c) => [c.ownerId, aliveVerdict(c.ownerId)])),
      readProductivity: async () =>
        new Map([['wedged', { agentOriginCalls: 0, anyOriginCalls: 4 }]]),
      readIdeateRegistrations: async () => new Map([['wedged', ideateReg()]]),
      readIdeatePasses: async () => new Map(),
    });

    const out = await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(out.ideateSilent).toBe(1);
    expect(out.ideateSuppressedAsWedged).toBe(1);
    // No SECOND alarm for a session the wedge wave already carries...
    expect(out.ideateWavesEscalated).toBe(0);
    expect(ideateEscalated).toHaveLength(0);
    // ...and the wedge leg still reports it exactly once.
    expect(escalated).toHaveLength(1);
  });

  // The obligation starts when the mode is set: a pass from a previous
  // registration must not discharge the current one.
  it('does not let a pass recorded BEFORE registration discharge the obligation', async () => {
    const { deps, ideateEscalated } = harness({
      readCandidates: async () => [candidate({ ownerId: 'stale' })],
      resolveLiveness: async (cs) => new Map(cs.map((c) => [c.ownerId, aliveVerdict(c.ownerId)])),
      readProductivity: async () =>
        new Map([['stale', { agentOriginCalls: 40, anyOriginCalls: 44 }]]),
      readIdeateRegistrations: async () => new Map([['stale', ideateReg()]]),
      readIdeatePasses: async () => new Map([['stale', REGISTERED_LONG_AGO - 60_000]]),
    });

    const out = await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(out.ideateSilent).toBe(1);
    expect(ideateEscalated[0].victims[0].lastPassAtMs).toBe(REGISTERED_LONG_AGO - 60_000);
  });

  it('stays silent once a pass is recorded after registration', async () => {
    const { deps, ideateEscalated } = harness({
      readCandidates: async () => [candidate({ ownerId: 'good' })],
      resolveLiveness: async (cs) => new Map(cs.map((c) => [c.ownerId, aliveVerdict(c.ownerId)])),
      readProductivity: async () =>
        new Map([['good', { agentOriginCalls: 40, anyOriginCalls: 44 }]]),
      readIdeateRegistrations: async () => new Map([['good', ideateReg()]]),
      readIdeatePasses: async () => new Map([['good', REGISTERED_LONG_AGO + 60_000]]),
    });

    const out = await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(out.ideateSilent).toBe(0);
    expect(ideateEscalated).toHaveLength(0);
  });

  // A pass is owed at task boundaries, not on a clock — the grace catches
  // NEVER, not LATE.
  it('holds fire on a registration still inside the ideate grace', async () => {
    const { deps, ideateEscalated } = harness({
      readCandidates: async () => [candidate({ ownerId: 'fresh' })],
      resolveLiveness: async (cs) => new Map(cs.map((c) => [c.ownerId, aliveVerdict(c.ownerId)])),
      readProductivity: async () =>
        new Map([['fresh', { agentOriginCalls: 12, anyOriginCalls: 15 }]]),
      readIdeateRegistrations: async () =>
        new Map([['fresh', ideateReg({ setAtMs: NOW - 60_000 })]]),
      readIdeatePasses: async () => new Map(),
    });

    const out = await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(out.ideateSilent).toBe(0);
    expect(ideateEscalated).toHaveLength(0);
  });

  // The same correlation claim the wedge leg makes: the registrations come from
  // a LAUNCHER, so N nags would be N copies of one launcher's decision.
  it('collapses many silent sessions into ONE wave per workspace', async () => {
    const candidates = Array.from({ length: 9 }, (_, i) => candidate({ ownerId: `su-${i}` }));
    const { deps, ideateEscalated } = harness({
      readCandidates: async () => candidates,
      resolveLiveness: async (cs) => new Map(cs.map((c) => [c.ownerId, aliveVerdict(c.ownerId)])),
      readProductivity: async () =>
        new Map(candidates.map((c) => [c.ownerId, { agentOriginCalls: 30, anyOriginCalls: 33 }])),
      readIdeateRegistrations: async () =>
        new Map(candidates.map((c) => [c.ownerId, ideateReg()])),
      readIdeatePasses: async () => new Map(),
    });

    const out = await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(out.ideateSilent).toBe(9);
    expect(out.ideateWavesEscalated).toBe(1);
    expect(ideateEscalated).toHaveLength(1);
    expect(ideateEscalated[0].victims).toHaveLength(9);
  });

  // An agent that never had the mode is not a subject of this leg at all.
  it('ignores an unregistered agent entirely', async () => {
    const { deps, ideateEscalated } = harness({
      readCandidates: async () => [candidate({ ownerId: 'plain' })],
      resolveLiveness: async (cs) => new Map(cs.map((c) => [c.ownerId, aliveVerdict(c.ownerId)])),
      readProductivity: async () =>
        new Map([['plain', { agentOriginCalls: 99, anyOriginCalls: 120 }]]),
      readIdeateRegistrations: async () => new Map(),
      readIdeatePasses: async () => new Map(),
    });

    const out = await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(out.ideateSilent).toBe(0);
    expect(ideateEscalated).toHaveLength(0);
  });
});
