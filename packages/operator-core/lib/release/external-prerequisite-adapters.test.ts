/**
 * Tests for the P-004 capability adapters (Stripe endpoint, Apple signing).
 *
 * Fixture-backed throughout: no test touches a real credential, reaches the
 * network, or reads process.env for a value. The env port is presence-only by
 * construction, so a fixture cannot even supply a secret to leak.
 *
 * The table at the bottom is the important one. Plan Decision D-002 ruling 1 binds
 * BOTH adapters to the same invariant — never report `absent` for something you
 * merely failed to determine — so it is asserted once, across both, rather than
 * being restated per adapter where one could quietly drift.
 */

import { describe, expect, it } from 'vitest';
import type { ExternalPrerequisiteSpec } from './external-prerequisites';
import {
  createProbeRegistry,
  runPrerequisiteProbe,
  type ExternalPrerequisiteProbe,
  type ProbeRunnerPorts,
} from './external-prerequisite-probe-runner';
import {
  createStripeEndpointProbe,
  type EnvPresenceReader,
  type StripeEndpointDescriptor,
} from './external-prerequisite-stripe-adapter';
import {
  createAppleSigningProbe,
  profileCoversBundleId,
  type AppleSigningDescriptor,
} from './external-prerequisite-apple-adapter';

const NOW = Date.parse('2026-08-23T12:00:00.000Z');

function stripeSpec(overrides: Partial<ExternalPrerequisiteSpec> = {}): ExternalPrerequisiteSpec {
  return {
    key: 'stripe-webhook',
    capabilityKind: 'stripe-endpoint',
    requiredNames: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    target: { host: 'api.stripe.com' },
    probeRef: 'probe:stripe-endpoint',
    expirySec: 3600,
    owningWorkItem: 'WI-41139',
    completionEvent: 'external-prerequisite:ready:stripe-webhook',
    ...overrides,
  };
}

function appleSpec(overrides: Partial<ExternalPrerequisiteSpec> = {}): ExternalPrerequisiteSpec {
  return {
    key: 'apple-signing',
    capabilityKind: 'apple-signing',
    requiredNames: [],
    target: { signingContext: 'com.example.app' },
    probeRef: 'probe:apple-signing',
    expirySec: 86_400,
    owningWorkItem: 'WI-41139',
    completionEvent: 'external-prerequisite:ready:apple-signing',
    ...overrides,
  };
}

const envAllPresent: EnvPresenceReader = { has: () => true };
const envNonePresent: EnvPresenceReader = { has: () => false };

function stripeDescriptor(
  overrides: Partial<StripeEndpointDescriptor> = {},
): StripeEndpointDescriptor {
  return {
    endpointId: 'we_123',
    status: 'enabled',
    apiVersion: '2026-01-01',
    enabledEvents: ['payment_intent.succeeded', 'charge.refunded'],
    ...overrides,
  };
}

function appleDescriptor(overrides: Partial<AppleSigningDescriptor> = {}): AppleSigningDescriptor {
  return {
    certificateSha256: 'a'.repeat(64),
    certificateNotAfter: new Date(NOW + 30 * 86_400_000).toISOString(),
    provisioningProfileName: 'Example App Distribution',
    provisioningProfileExpiresAt: new Date(NOW + 30 * 86_400_000).toISOString(),
    profileBundleId: 'com.example.app',
    ...overrides,
  };
}

describe('Stripe endpoint adapter', () => {
  it('reports a determinate absence when a required env NAME is not set', async () => {
    const probe = createStripeEndpointProbe({
      env: envNonePresent,
      source: { describeEndpoint: async () => stripeDescriptor() },
    });
    const outcome = await probe(stripeSpec());

    expect(outcome.status).toBe('absent');
    expect(outcome.status === 'absent' && outcome.detail).toMatch(/STRIPE_SECRET_KEY/);
  });

  it('does not need the binding source when env is missing — the local check is enough', async () => {
    let called = false;
    const probe = createStripeEndpointProbe({
      env: envNonePresent,
      source: {
        describeEndpoint: async () => {
          called = true;
          throw new Error('should not be reached');
        },
      },
    });
    expect((await probe(stripeSpec())).status).toBe('absent');
    expect(called).toBe(false);
  });

  it('reports present with allowlisted binding metadata', async () => {
    const probe = createStripeEndpointProbe({
      env: envAllPresent,
      source: { describeEndpoint: async () => stripeDescriptor() },
    });
    const outcome = await probe(stripeSpec());

    expect(outcome.status).toBe('present');
    expect(outcome.status === 'present' && outcome.binding).toEqual({
      endpointId: 'we_123',
      status: 'enabled',
      apiVersion: '2026-01-01',
      // The COUNT, not the event list.
      enabledEventCount: '2',
    });
  });

  it('NEVER copies an unexpected field out of the descriptor, even a secret-shaped one', async () => {
    const leaky = {
      ...stripeDescriptor(),
      webhookSecret: 'whsec_abcdefghijklmnop',
      liveKey: 'sk_live_ABCDEF123456',
    } as StripeEndpointDescriptor;

    const probe = createStripeEndpointProbe({
      env: envAllPresent,
      source: { describeEndpoint: async () => leaky },
    });
    const outcome = await probe(stripeSpec());

    expect(outcome.status).toBe('present');
    const binding = outcome.status === 'present' ? outcome.binding : {};
    expect(Object.keys(binding).sort()).toEqual([
      'apiVersion',
      'enabledEventCount',
      'endpointId',
      'status',
    ]);
    expect(JSON.stringify(binding)).not.toMatch(/whsec_|sk_live_/);
  });

  it('reports absent when no endpoint is bound', async () => {
    const probe = createStripeEndpointProbe({
      env: envAllPresent,
      source: { describeEndpoint: async () => null },
    });
    expect((await probe(stripeSpec())).status).toBe('absent');
  });

  it('reports absent when the endpoint exists but is disabled', async () => {
    const probe = createStripeEndpointProbe({
      env: envAllPresent,
      source: { describeEndpoint: async () => stripeDescriptor({ status: 'disabled' }) },
    });
    const outcome = await probe(stripeSpec());
    expect(outcome.status).toBe('absent');
    expect(outcome.status === 'absent' && outcome.detail).toMatch(/disabled/);
  });

  it('omits optional binding fields the descriptor does not carry', async () => {
    const probe = createStripeEndpointProbe({
      env: envAllPresent,
      source: {
        describeEndpoint: async () =>
          ({ endpointId: 'we_9', status: 'enabled' }) as StripeEndpointDescriptor,
      },
    });
    const outcome = await probe(stripeSpec());
    expect(outcome.status === 'present' && outcome.binding).toEqual({
      endpointId: 'we_9',
      status: 'enabled',
    });
  });
});

describe('Apple signing adapter', () => {
  const source = (d: AppleSigningDescriptor | null) => ({ describeSigningIdentity: async () => d });

  it('reports present with allowlisted binding metadata and no team identifier', async () => {
    const probe = createAppleSigningProbe({ source: source(appleDescriptor()), now: () => NOW });
    const outcome = await probe(appleSpec());

    expect(outcome.status).toBe('present');
    const binding = outcome.status === 'present' ? outcome.binding : {};
    expect(Object.keys(binding).sort()).toEqual([
      'bundleId',
      'certificateNotAfter',
      'certificateSha256',
      'provisioningProfileExpiresAt',
      'provisioningProfileName',
    ]);
    expect(JSON.stringify(binding)).not.toMatch(/teamId/i);
  });

  it('reports absent when no signing identity is installed', async () => {
    const probe = createAppleSigningProbe({ source: source(null), now: () => NOW });
    expect((await probe(appleSpec())).status).toBe('absent');
  });

  it('reports a determinate absence for an EXPIRED certificate', async () => {
    const probe = createAppleSigningProbe({
      source: source(
        appleDescriptor({ certificateNotAfter: new Date(NOW - 1000).toISOString() }),
      ),
      now: () => NOW,
    });
    const outcome = await probe(appleSpec());
    expect(outcome.status).toBe('absent');
    expect(outcome.status === 'absent' && outcome.detail).toMatch(/certificate expired/);
  });

  it('reports a determinate absence for an expired provisioning profile', async () => {
    const probe = createAppleSigningProbe({
      source: source(
        appleDescriptor({ provisioningProfileExpiresAt: new Date(NOW - 1).toISOString() }),
      ),
      now: () => NOW,
    });
    const outcome = await probe(appleSpec());
    expect(outcome.status).toBe('absent');
    expect(outcome.status === 'absent' && outcome.detail).toMatch(/profile expired/);
  });

  it('reports a determinate absence when the profile does not cover the bundle id', async () => {
    const probe = createAppleSigningProbe({
      source: source(appleDescriptor({ profileBundleId: 'com.other.app' })),
      now: () => NOW,
    });
    const outcome = await probe(appleSpec());
    expect(outcome.status).toBe('absent');
    expect(outcome.status === 'absent' && outcome.detail).toMatch(/does not cover/);
  });

  it('accepts a wildcard profile that covers the bundle id', async () => {
    const probe = createAppleSigningProbe({
      source: source(appleDescriptor({ profileBundleId: 'com.example.*' })),
      now: () => NOW,
    });
    expect((await probe(appleSpec())).status).toBe('present');
  });

  it('treats an UNPARSEABLE validity window as indeterminate, never as valid or expired', async () => {
    for (const bad of [
      { certificateNotAfter: 'not-a-date' },
      { provisioningProfileExpiresAt: '' },
    ]) {
      const probe = createAppleSigningProbe({
        source: source(appleDescriptor(bad)),
        now: () => NOW,
      });
      const outcome = await probe(appleSpec());
      expect(outcome.status).toBe('indeterminate');
    }
  });

  it('is indeterminate when the spec does not say what is being signed', async () => {
    const probe = createAppleSigningProbe({ source: source(appleDescriptor()), now: () => NOW });
    const outcome = await probe(appleSpec({ target: {} }));
    expect(outcome.status).toBe('indeterminate');
    expect(outcome.status === 'indeterminate' && outcome.reason).toMatch(/bundle id/);
  });
});

describe('profileCoversBundleId', () => {
  it('matches exactly, and wildcards only on a trailing .*', () => {
    expect(profileCoversBundleId('com.example.app', 'com.example.app')).toBe(true);
    expect(profileCoversBundleId('com.example.*', 'com.example.app')).toBe(true);
    expect(profileCoversBundleId('com.example.*', 'com.example.app.helper')).toBe(true);
  });

  it('does not over-match — the failure mode that would let an uncovered app read as ready', () => {
    expect(profileCoversBundleId('com.example.app', 'com.example.app2')).toBe(false);
    expect(profileCoversBundleId('com.example.*', 'com.example.')).toBe(false);
    expect(profileCoversBundleId('com.example.*', 'com.other.app')).toBe(false);
    // Not a general glob: a leading or interior wildcard is not honoured.
    expect(profileCoversBundleId('*.app', 'com.example.app')).toBe(false);
    expect(profileCoversBundleId('', 'com.example.app')).toBe(false);
    expect(profileCoversBundleId('com.example.app', '')).toBe(false);
  });
});

/**
 * D-002 ruling 1, asserted across BOTH adapters at once.
 *
 * Every row is a way of FAILING TO DETERMINE the answer. None may produce
 * `absent`, because `absent` is written as `present: false` — a durable claim that
 * the probe ran and observed the wall down.
 */
describe('no adapter reports an absence for something it merely failed to determine', () => {
  const boom = () => {
    throw new Error('unreachable');
  };

  const rows: { name: string; probe: ExternalPrerequisiteProbe; spec: ExternalPrerequisiteSpec }[] =
    [
      {
        name: 'stripe: binding source throws',
        probe: createStripeEndpointProbe({
          env: envAllPresent,
          source: { describeEndpoint: async () => boom() },
        }),
        spec: stripeSpec(),
      },
      {
        name: 'stripe: descriptor missing endpointId',
        probe: createStripeEndpointProbe({
          env: envAllPresent,
          source: { describeEndpoint: async () => ({}) as StripeEndpointDescriptor },
        }),
        spec: stripeSpec(),
      },
      {
        name: 'apple: signing source throws',
        probe: createAppleSigningProbe({
          source: { describeSigningIdentity: async () => boom() },
          now: () => NOW,
        }),
        spec: appleSpec(),
      },
      {
        name: 'apple: descriptor missing certificateSha256',
        probe: createAppleSigningProbe({
          source: { describeSigningIdentity: async () => ({}) as AppleSigningDescriptor },
          now: () => NOW,
        }),
        spec: appleSpec(),
      },
      {
        name: 'apple: unusable evaluation instant',
        probe: createAppleSigningProbe({
          source: { describeSigningIdentity: async () => appleDescriptor() },
          now: () => Number.NaN,
        }),
        spec: appleSpec(),
      },
    ];

  for (const row of rows) {
    it(`${row.name} -> indeterminate`, async () => {
      const outcome = await row.probe(row.spec);
      expect(outcome.status).toBe('indeterminate');
    });
  }

  it('and end-to-end through the runner, none of them writes a receipt', async () => {
    for (const row of rows) {
      const saved: unknown[] = [];
      const ports: ProbeRunnerPorts = {
        async loadAttestation() {
          return null;
        },
        async saveAttestation(a) {
          saved.push(a);
        },
        async emitEvent() {},
        async wakeLaneOwner() {},
      };
      const registry = createProbeRegistry({ [row.spec.probeRef]: row.probe });
      const res = await runPrerequisiteProbe(row.spec, registry, ports, { nowMs: NOW });

      expect(res.readiness.state).toBe('unknown');
      expect(res.satisfied).toBe(false);
      expect(res.attestationWritten).toBe(false);
      expect(saved).toEqual([]);
    }
  });
});

describe('adapters wired through the runner produce a usable receipt', () => {
  it('a present Stripe wall becomes a ready attestation with zero-secret binding', async () => {
    const saved: { binding: Record<string, string> }[] = [];
    const ports: ProbeRunnerPorts = {
      async loadAttestation() {
        return null;
      },
      async saveAttestation(a) {
        saved.push({ binding: { ...a.binding } });
      },
      async emitEvent() {},
      async wakeLaneOwner() {},
    };
    const probe = createStripeEndpointProbe({
      env: envAllPresent,
      source: { describeEndpoint: async () => stripeDescriptor() },
    });
    const res = await runPrerequisiteProbe(
      stripeSpec(),
      createProbeRegistry({ 'probe:stripe-endpoint': probe }),
      ports,
      { nowMs: NOW },
    );

    expect(res.readiness.state).toBe('ready');
    expect(res.transition).toBe('became-ready');
    expect(saved).toHaveLength(1);
    expect(saved[0].binding.endpointId).toBe('we_123');
  });

  it('an expired Apple certificate becomes a durable observed absence, not an unknown', async () => {
    const saved: { present: boolean }[] = [];
    const ports: ProbeRunnerPorts = {
      async loadAttestation() {
        return null;
      },
      async saveAttestation(a) {
        saved.push({ present: a.present });
      },
      async emitEvent() {},
      async wakeLaneOwner() {},
    };
    const probe = createAppleSigningProbe({
      source: {
        describeSigningIdentity: async () =>
          appleDescriptor({ certificateNotAfter: new Date(NOW - 1000).toISOString() }),
      },
      now: () => NOW,
    });
    const res = await runPrerequisiteProbe(
      appleSpec(),
      createProbeRegistry({ 'probe:apple-signing': probe }),
      ports,
      { nowMs: NOW },
    );

    // We DID determine the wall is down, so this one is written.
    expect(res.attestationWritten).toBe(true);
    expect(saved[0].present).toBe(false);
    expect(res.readiness).toEqual({ state: 'absent', reason: 'probe-reported-absent' });
  });
});
