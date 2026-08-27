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
  type AgentProductivitySweepDeps,
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
  const deps: Partial<AgentProductivitySweepDeps> = {
    flagEnabled: async () => true,
    now: () => NOW,
    graceMs: AGENT_PRODUCTIVITY_GRACE_MS,
    escalateWave: async (w) => {
      escalated.push(w);
    },
    ...over,
  };
  return { deps, escalated };
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
    expect(out).toEqual({ scanned: 0, present: 0, wedged: 0, unmeasured: 0, wavesEscalated: 0 });
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
    };

    const out = await runAgentProductivitySweepOnce(FAKE_SQL, deps);

    expect(out.wedged).toBe(2);
    expect(out.wavesEscalated).toBe(1);
    expect(escalated.map((w) => w.phase)).toEqual(['booted-never-worked']);
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
