/**
 * external-prerequisite-ports.test.ts — P-005 of
 * typed-external-prerequisite-attestations-for-release-gates-2026-08-15.
 *
 * Covers the concrete ports and the gate's derived READ. The SQL itself is proven
 * against real migrated Postgres in external-prerequisite-ports.integration.test.ts —
 * this file proves the parts a seam can reach: the row mapping, the lifecycle rules
 * D-002 fixed, and the derivation that replaced the removed scorecard push (D-003).
 */
import { describe, expect, it } from 'vitest';
import {
  allPrerequisitesSatisfied,
  createProbeRunnerPorts,
  readScopePrerequisiteReadiness,
  unsatisfiedPrerequisites,
  type ProbeRunnerPortDeps,
  type ResolvedScope,
} from './external-prerequisite-ports';
import type {
  ExternalPrerequisiteAttestation,
  ExternalPrerequisiteAttestationRow,
  ExternalPrerequisiteSpec,
} from './external-prerequisites';

const SCOPE = { harnessSlug: 'papercusp', workspaceId: 'ws-test' } as const;
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

function spec(overrides: Partial<ExternalPrerequisiteSpec> = {}): ExternalPrerequisiteSpec {
  return {
    key: 'stripe-webhook',
    capabilityKind: 'stripe-endpoint',
    requiredNames: ['STRIPE_WEBHOOK_SECRET'],
    target: { host: 'api.stripe.com' },
    probeRef: 'probe:stripe-endpoint',
    expirySec: 3600,
    owningWorkItem: 'WI-1',
    completionEvent: 'external-prerequisite:ready:stripe-webhook',
    ...overrides,
  };
}

function row(overrides: Partial<ExternalPrerequisiteAttestationRow> = {}): ExternalPrerequisiteAttestationRow {
  return {
    prerequisite_key: 'stripe-webhook',
    capability_kind: 'stripe-endpoint',
    present: true,
    binding: { endpointId: 'we_123' },
    observed_at: '2026-08-24T11:00:00.000Z',
    expires_at: '2026-08-24T13:00:00.000Z',
    provenance: 'probe',
    probe_ref: 'probe:stripe-endpoint',
    ...overrides,
  };
}

function attestation(
  overrides: Partial<ExternalPrerequisiteAttestation> = {},
): ExternalPrerequisiteAttestation {
  return {
    key: 'stripe-webhook',
    capabilityKind: 'stripe-endpoint',
    present: true,
    binding: { endpointId: 'we_123' },
    observedAt: '2026-08-24T11:00:00.000Z',
    expiresAt: '2026-08-24T13:00:00.000Z',
    provenance: 'probe',
    probeRef: 'probe:stripe-endpoint',
    ...overrides,
  };
}

describe('loadAttestation', () => {
  it('maps a stored row through rowToAttestation', async () => {
    const ports = createProbeRunnerPorts(SCOPE, { loadRow: async () => row() });
    await expect(ports.loadAttestation('stripe-webhook')).resolves.toEqual(attestation());
  });

  it('returns null for a missing row rather than a synthesised receipt', async () => {
    const ports = createProbeRunnerPorts(SCOPE, { loadRow: async () => null });
    await expect(ports.loadAttestation('stripe-webhook')).resolves.toBeNull();
  });

  it('returns null — never a partial — for an UNINTERPRETABLE row, so it reads as absent', async () => {
    // A capability kind outside EXTERNAL_CAPABILITY_KINDS. The dangerous alternative
    // is a partially-populated attestation, which downstream would read as a receipt.
    const ports = createProbeRunnerPorts(SCOPE, {
      loadRow: async () => row({ capability_kind: 'not-a-real-kind' }),
    });
    await expect(ports.loadAttestation('stripe-webhook')).resolves.toBeNull();
  });

  it('propagates a read failure instead of reporting "no attestation"', async () => {
    // D-002: a failed READ must not be indistinguishable from an observed absence.
    // The runner turns a thrown port into a recorded problem; swallowing here would
    // report a clean run that never happened.
    const ports = createProbeRunnerPorts(SCOPE, {
      loadRow: async () => {
        throw new Error('db down');
      },
    });
    await expect(ports.loadAttestation('stripe-webhook')).rejects.toThrow('db down');
  });
});

describe('saveAttestation', () => {
  it('maps through attestationToRow and writes exactly one row into the scope', async () => {
    const written: { scope: ResolvedScope; row: ExternalPrerequisiteAttestationRow }[] = [];
    const ports = createProbeRunnerPorts(SCOPE, {
      saveRow: async (scope, r) => {
        written.push({ scope, row: r });
      },
    });
    await ports.saveAttestation(attestation());
    expect(written).toHaveLength(1);
    expect(written[0].row).toEqual(row());
    expect(written[0].scope.harnessSlug).toBe('papercusp');
    expect(written[0].scope.workspaceId).toBe('ws-test');
  });

  it('propagates a write failure rather than reporting a receipt that does not exist', async () => {
    const ports = createProbeRunnerPorts(SCOPE, {
      saveRow: async () => {
        throw new Error('write rejected');
      },
    });
    await expect(ports.saveAttestation(attestation())).rejects.toThrow('write rejected');
  });
});

describe('emitEvent', () => {
  it('forwards key/summary/payload and stamps the scope source for attribution', async () => {
    const emitted: unknown[] = [];
    const ports = createProbeRunnerPorts(
      { ...SCOPE, source: 'my-gate' },
      { emit: async (o) => void emitted.push(o) },
    );
    await ports.emitEvent({ key: 'k', summary: 's', payload: { a: 1 } });
    expect(emitted).toEqual([
      { key: 'k', summary: 's', payload: { a: 1 }, source: 'my-gate', workspaceId: 'ws-test' },
    ]);
  });

  it('does not try to make the emit once-only — idempotence is the KEY\'s job (D-002)', async () => {
    // Emitting the SAME key twice reaches the bus twice; nothing here dedupes on a
    // written marker, because expiry is derived and no row is written on a lapse.
    const emitted: unknown[] = [];
    const ports = createProbeRunnerPorts(SCOPE, { emit: async (o) => void emitted.push(o) });
    await ports.emitEvent({ key: 'same', summary: 's', payload: {} });
    await ports.emitEvent({ key: 'same', summary: 's', payload: {} });
    expect(emitted).toHaveLength(2);
  });
});

describe('wakeLaneOwner', () => {
  it('resolves the work-item holder and notifies exactly that owner', async () => {
    const notified: { ownerId: string; workItem: string }[] = [];
    const ports = createProbeRunnerPorts(SCOPE, {
      resolveLaneOwner: async () => 'su-abc',
      notifyOwner: async (i) => void notified.push({ ownerId: i.ownerId, workItem: i.workItem }),
    });
    await ports.wakeLaneOwner({ owningWorkItem: 'WI-1', summary: 'wall moved' });
    expect(notified).toEqual([{ ownerId: 'su-abc', workItem: 'WI-1' }]);
  });

  it('SURFACES an unheld lane instead of silently skipping or broadcasting', async () => {
    const notified: unknown[] = [];
    const ports = createProbeRunnerPorts(SCOPE, {
      resolveLaneOwner: async () => null,
      notifyOwner: async (i) => void notified.push(i),
    });
    await expect(ports.wakeLaneOwner({ owningWorkItem: 'WI-1', summary: 's' })).rejects.toThrow(
      /no holder to wake/,
    );
    expect(notified).toEqual([]);
  });
});

describe('the removed scorecard port (D-003)', () => {
  it('is not part of the ports surface', () => {
    const ports = createProbeRunnerPorts(SCOPE, {});
    expect(Object.keys(ports).sort()).toEqual([
      'emitEvent',
      'loadAttestation',
      'saveAttestation',
      'wakeLaneOwner',
    ]);
    expect((ports as unknown as Record<string, unknown>).refreshScorecardCriterion).toBeUndefined();
  });
});

describe('readScopePrerequisiteReadiness — the gate PULLS a derived verdict', () => {
  const deps = (rows: ExternalPrerequisiteAttestationRow[]): Pick<ProbeRunnerPortDeps, 'loadRows'> => ({
    loadRows: async () => rows,
  });

  it('resolves a live receipt as ready/satisfied', async () => {
    const got = await readScopePrerequisiteReadiness(SCOPE, [spec()], {
      nowMs: NOW,
      deps: deps([row()]),
    });
    expect(got).toEqual([
      { key: 'stripe-webhook', readiness: expect.objectContaining({ state: 'ready' }), satisfied: true },
    ]);
  });

  it('resolves an UNPROBED prerequisite as absent — the gate fails closed, never skips', async () => {
    const got = await readScopePrerequisiteReadiness(SCOPE, [spec()], {
      nowMs: NOW,
      deps: deps([]),
    });
    expect(got[0].readiness).toEqual({ state: 'absent', reason: 'no-attestation' });
    expect(got[0].satisfied).toBe(false);
  });

  it('distinguishes a probe-observed absence from no receipt at all', async () => {
    const got = await readScopePrerequisiteReadiness(SCOPE, [spec()], {
      nowMs: NOW,
      deps: deps([row({ present: false })]),
    });
    expect(got[0].readiness).toEqual({ state: 'absent', reason: 'probe-reported-absent' });
  });

  it('goes STALE-PROOF: the same stored row reads ready before expiry and expired after, with NO write', async () => {
    // This is the whole point of D-003. Nothing re-states the verdict; the identical
    // row resolves differently purely because the evaluation instant moved.
    const stored = deps([row()]); // expires 13:00Z
    const before = await readScopePrerequisiteReadiness(SCOPE, [spec()], {
      nowMs: Date.parse('2026-08-24T12:59:59.000Z'),
      deps: stored,
    });
    const after = await readScopePrerequisiteReadiness(SCOPE, [spec()], {
      nowMs: Date.parse('2026-08-24T13:00:00.000Z'),
      deps: stored,
    });
    expect(before[0].satisfied).toBe(true);
    expect(after[0].readiness.state).toBe('expired');
    expect(after[0].satisfied).toBe(false);
  });

  it('evaluates every spec against ONE instant, so a scope cannot straddle a boundary', async () => {
    // Two prerequisites expiring at the same instant must agree. A per-spec clock read
    // could resolve the first as ready and the second as expired.
    const a = spec({ key: 'a' });
    const b = spec({ key: 'b' });
    const rows = [
      row({ prerequisite_key: 'a', expires_at: '2026-08-24T13:00:00.000Z' }),
      row({ prerequisite_key: 'b', expires_at: '2026-08-24T13:00:00.000Z' }),
    ];
    const got = await readScopePrerequisiteReadiness(SCOPE, [a, b], {
      nowMs: Date.parse('2026-08-24T13:00:00.000Z'),
      deps: deps(rows),
    });
    expect(got.map((g) => g.readiness.state)).toEqual(['expired', 'expired']);
  });

  it('preserves spec order and reports each key, including ones with no row', async () => {
    const got = await readScopePrerequisiteReadiness(
      SCOPE,
      [spec({ key: 'a' }), spec({ key: 'b' }), spec({ key: 'c' })],
      { nowMs: NOW, deps: deps([row({ prerequisite_key: 'b' })]) },
    );
    expect(got.map((g) => g.key)).toEqual(['a', 'b', 'c']);
    expect(got.map((g) => g.satisfied)).toEqual([false, true, false]);
  });

  it('does not query at all for an empty spec list', async () => {
    let called = 0;
    const got = await readScopePrerequisiteReadiness(SCOPE, [], {
      nowMs: NOW,
      deps: {
        loadRows: async () => {
          called += 1;
          return [];
        },
      },
    });
    expect(got).toEqual([]);
    expect(called).toBe(1); // the seam is consulted once with zero keys, never per-spec
  });
});

describe('scope predicates', () => {
  it('admits an empty scope — no declared wall is not the same as an unprobed one', () => {
    expect(allPrerequisitesSatisfied([])).toBe(true);
  });

  it('refuses the scope when ANY prerequisite is unsatisfied, and names which', async () => {
    const got = await readScopePrerequisiteReadiness(SCOPE, [spec({ key: 'a' }), spec({ key: 'b' })], {
      nowMs: NOW,
      deps: { loadRows: async () => [row({ prerequisite_key: 'a' })] },
    });
    expect(allPrerequisitesSatisfied(got)).toBe(false);
    expect(unsatisfiedPrerequisites(got).map((s) => s.key)).toEqual(['b']);
  });
});
