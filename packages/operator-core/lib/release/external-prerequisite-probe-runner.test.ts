/**
 * Tests for the P-003 probe runner.
 *
 * The centre of gravity here is NOT "does a happy probe write a row" — it is the
 * set of paths that must NOT write one. An indeterminate probe recorded as
 * `present: false` is a durable false claim that later transitions are computed
 * against, so each failure mode gets its own test rather than being folded into
 * a single "unhappy path" case.
 */

import { describe, expect, it } from 'vitest';
import type {
  ExternalPrerequisiteAttestation,
  ExternalPrerequisiteSpec,
  PrerequisiteReadiness,
} from './external-prerequisites';
import {
  classifyTransition,
  createProbeRegistry,
  lapseEventKey,
  runPrerequisiteProbe,
  runPrerequisiteProbes,
  sweepLapsedPrerequisites,
  type ProbeOutcome,
  type ProbeRunnerPorts,
} from './external-prerequisite-probe-runner';

const NOW = Date.parse('2026-08-23T12:00:00.000Z');

function spec(overrides: Partial<ExternalPrerequisiteSpec> = {}): ExternalPrerequisiteSpec {
  return {
    key: 'stripe-webhook',
    capabilityKind: 'stripe-endpoint',
    requiredNames: ['STRIPE_SECRET_KEY'],
    target: { host: 'api.stripe.com' },
    probeRef: 'probe:stripe-endpoint',
    expirySec: 3600,
    owningWorkItem: 'WI-41122',
    completionEvent: 'external-prerequisite:ready:stripe-webhook',
    ...overrides,
  };
}

interface Recorded {
  saved: ExternalPrerequisiteAttestation[];
  emitted: { key: string; summary: string; payload: Record<string, unknown> }[];
  wakes: { owningWorkItem: string; summary: string }[];
  refreshes: { prerequisiteKey: string; satisfied: boolean; readiness: PrerequisiteReadiness }[];
}

function makePorts(
  opts: {
    stored?: ExternalPrerequisiteAttestation | null;
    failLoad?: boolean;
    failSave?: boolean;
    failEmit?: boolean;
  } = {},
): { ports: ProbeRunnerPorts; rec: Recorded } {
  const rec: Recorded = { saved: [], emitted: [], wakes: [], refreshes: [] };
  const ports: ProbeRunnerPorts = {
    async loadAttestation() {
      if (opts.failLoad) throw new Error('db down');
      return opts.stored ?? null;
    },
    async saveAttestation(a) {
      if (opts.failSave) throw new Error('write rejected');
      rec.saved.push(a);
    },
    async emitEvent(e) {
      if (opts.failEmit) throw new Error('bus down');
      rec.emitted.push({ key: e.key, summary: e.summary, payload: { ...e.payload } });
    },
    async wakeLaneOwner(w) {
      rec.wakes.push(w);
    },
    async refreshScorecardCriterion(r) {
      rec.refreshes.push({
        prerequisiteKey: r.prerequisiteKey,
        satisfied: r.satisfied,
        readiness: r.readiness,
      });
    },
  };
  return { ports, rec };
}

function registryReturning(outcome: ProbeOutcome | (() => Promise<ProbeOutcome> | ProbeOutcome)) {
  return createProbeRegistry({
    'probe:stripe-endpoint': typeof outcome === 'function' ? outcome : () => outcome,
  });
}

/** A live receipt observed 10 minutes ago with a 1h expiry. */
function readyAttestation(): ExternalPrerequisiteAttestation {
  return {
    key: 'stripe-webhook',
    capabilityKind: 'stripe-endpoint',
    present: true,
    binding: { endpointId: 'we_123' },
    observedAt: new Date(NOW - 600_000).toISOString(),
    expiresAt: new Date(NOW + 3_000_000).toISOString(),
    provenance: 'probe',
    probeRef: 'probe:stripe-endpoint',
  };
}

/** A receipt whose expiry has already passed. */
function expiredAttestation(): ExternalPrerequisiteAttestation {
  return {
    ...readyAttestation(),
    observedAt: new Date(NOW - 7_200_000).toISOString(),
    expiresAt: new Date(NOW - 3_600_000).toISOString(),
  };
}

describe('runPrerequisiteProbe — a present wall', () => {
  it('writes a receipt, reads ready, and fires the declared completion event', async () => {
    const { ports, rec } = makePorts();
    const res = await runPrerequisiteProbe(
      spec(),
      registryReturning({ status: 'present', binding: { endpointId: 'we_123' } }),
      ports,
      { nowMs: NOW },
    );

    expect(res.readiness.state).toBe('ready');
    expect(res.satisfied).toBe(true);
    expect(res.transition).toBe('became-ready');
    expect(res.attestationWritten).toBe(true);
    expect(rec.saved).toHaveLength(1);
    expect(rec.saved[0].present).toBe(true);
    expect(rec.saved[0].binding).toEqual({ endpointId: 'we_123' });
    expect(rec.emitted.map((e) => e.key)).toEqual(['external-prerequisite:ready:stripe-webhook']);
    expect(rec.wakes).toHaveLength(1);
  });

  it('derives expiresAt from the spec expirySec against the injected instant', async () => {
    const { ports, rec } = makePorts();
    await runPrerequisiteProbe(
      spec({ expirySec: 60 }),
      registryReturning({ status: 'present', binding: {} }),
      ports,
      { nowMs: NOW },
    );
    expect(rec.saved[0].expiresAt).toBe(new Date(NOW + 60_000).toISOString());
  });

  it('treats a recovery (expired -> ready) as became-ready so blocked lanes are woken', async () => {
    const { ports, rec } = makePorts({ stored: expiredAttestation() });
    const res = await runPrerequisiteProbe(
      spec(),
      registryReturning({ status: 'present', binding: {} }),
      ports,
      { nowMs: NOW },
    );
    expect(res.previous.state).toBe('expired');
    expect(res.transition).toBe('became-ready');
    expect(rec.emitted[0].key).toBe('external-prerequisite:ready:stripe-webhook');
  });
});

describe('runPrerequisiteProbe — an OBSERVED absence is durable', () => {
  it('writes present:false when the probe ran and found the wall down', async () => {
    const { ports, rec } = makePorts();
    const res = await runPrerequisiteProbe(spec(), registryReturning({ status: 'absent' }), ports, {
      nowMs: NOW,
    });

    expect(res.attestationWritten).toBe(true);
    expect(rec.saved[0].present).toBe(false);
    expect(res.readiness).toEqual({ state: 'absent', reason: 'probe-reported-absent' });
    expect(res.satisfied).toBe(false);
  });

  it('classifies ready -> observed-down as a regression, not a lapse', async () => {
    const { ports, rec } = makePorts({ stored: readyAttestation() });
    const res = await runPrerequisiteProbe(spec(), registryReturning({ status: 'absent' }), ports, {
      nowMs: NOW,
    });
    expect(res.transition).toBe('regressed');
    expect(rec.emitted[0].key).toContain('external-prerequisite:regressed:stripe-webhook');
  });
});

describe('runPrerequisiteProbe — an INDETERMINATE probe must never become an observed absence', () => {
  const cases: { name: string; outcome: ProbeOutcome | (() => never) }[] = [
    {
      name: 'the adapter reports indeterminate',
      outcome: { status: 'indeterminate', reason: 'network unreachable' },
    },
    {
      name: 'the adapter throws',
      outcome: () => {
        throw new Error('boom');
      },
    },
  ];

  for (const c of cases) {
    it(`writes NOTHING and reads unknown when ${c.name}`, async () => {
      const { ports, rec } = makePorts();
      const res = await runPrerequisiteProbe(spec(), registryReturning(c.outcome as never), ports, {
        nowMs: NOW,
      });

      expect(res.readiness.state).toBe('unknown');
      expect(res.satisfied).toBe(false);
      expect(res.attestationWritten).toBe(false);
      // The invariant: no durable claim that the wall was observed down.
      expect(rec.saved).toEqual([]);
      expect(rec.emitted).toEqual([]);
    });
  }

  it('writes NOTHING when the probe hangs past its deadline', async () => {
    const { ports, rec } = makePorts();
    const res = await runPrerequisiteProbe(
      spec(),
      registryReturning(() => new Promise<ProbeOutcome>(() => {})),
      ports,
      { nowMs: NOW, timeoutMs: 10 },
    );
    expect(res.readiness.state).toBe('unknown');
    expect(res.problem).toMatch(/timed out/);
    expect(rec.saved).toEqual([]);
  });

  it('writes NOTHING when the probeRef is unregistered — an unwired probe is not an absent wall', async () => {
    const { ports, rec } = makePorts();
    const res = await runPrerequisiteProbe(spec(), createProbeRegistry({}), ports, { nowMs: NOW });

    expect(res.readiness.state).toBe('unknown');
    expect(res.problem).toMatch(/no probe registered/);
    expect(rec.saved).toEqual([]);
  });

  it('treats an adapter returning an unrecognized shape as indeterminate, not absent', async () => {
    const { ports, rec } = makePorts();
    for (const bad of [undefined, null, { status: 'weird' }]) {
      const res = await runPrerequisiteProbe(
        spec(),
        registryReturning(() => bad as never),
        ports,
        { nowMs: NOW },
      );
      expect(res.readiness.state).toBe('unknown');
      expect(res.attestationWritten).toBe(false);
    }
    expect(rec.saved).toEqual([]);
  });
});

describe('runPrerequisiteProbe — failing closed on infrastructure failure', () => {
  it('does not report ready when the receipt failed to persist', async () => {
    const { ports, rec } = makePorts({ failSave: true });
    const res = await runPrerequisiteProbe(
      spec(),
      registryReturning({ status: 'present', binding: {} }),
      ports,
      { nowMs: NOW },
    );

    // The probe DID observe a live wall, but the receipt did not land — claiming
    // ready off an unpersisted value is the silent widening this guards.
    expect(res.readiness.state).toBe('unknown');
    expect(res.satisfied).toBe(false);
    expect(res.attestationWritten).toBe(false);
    expect(res.problem).toMatch(/saveAttestation failed/);
    expect(rec.emitted).toEqual([]);
  });

  it('reports unknown (not absent) when the prior receipt cannot be loaded', async () => {
    const { ports } = makePorts({ failLoad: true });
    const res = await runPrerequisiteProbe(
      spec(),
      registryReturning({ status: 'present', binding: {} }),
      ports,
      { nowMs: NOW },
    );
    expect(res.previous.state).toBe('unknown');
    expect(res.readiness.state).toBe('ready');
  });

  it('keeps the durable write when the event bus fails', async () => {
    const { ports, rec } = makePorts({ failEmit: true });
    const res = await runPrerequisiteProbe(
      spec(),
      registryReturning({ status: 'present', binding: {} }),
      ports,
      { nowMs: NOW },
    );

    expect(res.attestationWritten).toBe(true);
    expect(rec.saved).toHaveLength(1);
    expect(res.problem).toMatch(/emitEvent failed/);
    // A failed announcement must not be reported as a clean run.
    expect(res.readiness.state).toBe('ready');
  });

  it('refuses a credential-shaped binding and stores nothing', async () => {
    const { ports, rec } = makePorts();
    const res = await runPrerequisiteProbe(
      spec(),
      registryReturning({ status: 'present', binding: { leaked: 'sk_live_ABCDEF123456' } }),
      ports,
      { nowMs: NOW },
    );

    expect(res.attestationWritten).toBe(false);
    expect(res.readiness.state).toBe('unknown');
    expect(res.problem).toMatch(/credential-shaped/);
    expect(rec.saved).toEqual([]);
  });
});

describe('the scorecard criterion is refreshed on EVERY run', () => {
  it('refreshes even when nothing transitioned, so the criterion cannot go stale', async () => {
    const { ports, rec } = makePorts({ stored: readyAttestation() });
    const res = await runPrerequisiteProbe(
      spec(),
      registryReturning({ status: 'present', binding: {} }),
      ports,
      { nowMs: NOW },
    );
    expect(res.transition).toBe('none');
    expect(rec.emitted).toEqual([]);
    expect(rec.refreshes).toHaveLength(1);
    expect(rec.refreshes[0].satisfied).toBe(true);
  });

  it('refreshes with satisfied:false on an indeterminate run', async () => {
    const { ports, rec } = makePorts();
    await runPrerequisiteProbe(
      spec(),
      registryReturning({ status: 'indeterminate', reason: 'nope' }),
      ports,
      { nowMs: NOW },
    );
    expect(rec.refreshes).toHaveLength(1);
    expect(rec.refreshes[0].satisfied).toBe(false);
  });
});

describe('classifyTransition', () => {
  const ready: PrerequisiteReadiness = {
    state: 'ready',
    expiresAt: 'x',
    attestation: readyAttestation(),
  };
  const absent: PrerequisiteReadiness = { state: 'absent', reason: 'no-attestation' };
  const expired: PrerequisiteReadiness = {
    state: 'expired',
    expiredAt: 'x',
    attestation: expiredAttestation(),
  };
  const unknown: PrerequisiteReadiness = { state: 'unknown', reason: 'x' };

  it('maps the lifecycle edges', () => {
    expect(classifyTransition(absent, ready)).toBe('became-ready');
    expect(classifyTransition(expired, ready)).toBe('became-ready');
    expect(classifyTransition(unknown, ready)).toBe('became-ready');
    expect(classifyTransition(ready, expired)).toBe('lapsed');
    expect(classifyTransition(ready, absent)).toBe('regressed');
    expect(classifyTransition(ready, ready)).toBe('none');
    expect(classifyTransition(absent, absent)).toBe('none');
    // Losing determinacy is not an announceable edge — it is a measurement gap.
    expect(classifyTransition(ready, unknown)).toBe('none');
  });
});

describe('sweepLapsedPrerequisites — the staleness half', () => {
  it('announces a lapse for a receipt whose expiry has passed', async () => {
    const { ports, rec } = makePorts({ stored: expiredAttestation() });
    const lapses = await sweepLapsedPrerequisites([spec()], ports, { nowMs: NOW });

    expect(lapses).toHaveLength(1);
    expect(lapses[0].announced).toBe(true);
    expect(rec.emitted).toHaveLength(1);
    expect(rec.emitted[0].key).toBe(lapseEventKey(spec(), expiredAttestation().expiresAt));
    expect(rec.wakes).toHaveLength(1);
  });

  it('is idempotent by key construction, so a repeated sweep cannot re-announce', async () => {
    const { ports, rec } = makePorts({ stored: expiredAttestation() });
    await sweepLapsedPrerequisites([spec()], ports, { nowMs: NOW });
    await sweepLapsedPrerequisites([spec()], ports, { nowMs: NOW + 60_000 });

    expect(rec.emitted).toHaveLength(2);
    // Same lapse -> byte-identical key, which the event layer's latch collapses.
    expect(rec.emitted[0].key).toBe(rec.emitted[1].key);
  });

  it('gives a NEW lapse a different key, so a genuine re-lapse still fires', async () => {
    const first = expiredAttestation();
    const second = { ...first, expiresAt: new Date(NOW - 60_000).toISOString() };
    expect(lapseEventKey(spec(), first.expiresAt)).not.toBe(lapseEventKey(spec(), second.expiresAt));
  });

  it('ignores receipts that are still live or already absent', async () => {
    const live = makePorts({ stored: readyAttestation() });
    expect(await sweepLapsedPrerequisites([spec()], live.ports, { nowMs: NOW })).toEqual([]);
    expect(live.rec.emitted).toEqual([]);

    const none = makePorts({ stored: null });
    expect(await sweepLapsedPrerequisites([spec()], none.ports, { nowMs: NOW })).toEqual([]);
    expect(none.rec.emitted).toEqual([]);
  });

  it('does not mutate the stored receipt — expiry is derived, not written', async () => {
    const { ports, rec } = makePorts({ stored: expiredAttestation() });
    await sweepLapsedPrerequisites([spec()], ports, { nowMs: NOW });
    expect(rec.saved).toEqual([]);
  });
});

describe('runPrerequisiteProbes — scope isolation', () => {
  it('measures every spec even when one probe fails', async () => {
    const { ports, rec } = makePorts();
    const registry = createProbeRegistry({
      'probe:ok': () => ({ status: 'present', binding: {} }),
      'probe:bad': () => {
        throw new Error('kaboom');
      },
    });
    const specs = [
      spec({ key: 'a', probeRef: 'probe:bad' }),
      spec({ key: 'b', probeRef: 'probe:ok' }),
      spec({ key: 'c', probeRef: 'probe:ok' }),
    ];

    const results = await runPrerequisiteProbes(specs, registry, ports, { nowMs: NOW });

    expect(results.map((r) => r.key)).toEqual(['a', 'b', 'c']);
    expect(results[0].satisfied).toBe(false);
    expect(results[1].satisfied).toBe(true);
    expect(results[2].satisfied).toBe(true);
    // A truncated view must never be reported as a complete one.
    expect(rec.saved.map((s) => s.key)).toEqual(['b', 'c']);
  });
});
