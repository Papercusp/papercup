import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_CAPABILITY_KINDS,
  type ExternalPrerequisiteAttestation,
  type ExternalPrerequisiteAttestationRow,
  type ExternalPrerequisiteSpec,
  type PrerequisiteReadiness,
  assertZeroSecretSpec,
  attestationToRow,
  buildAttestation,
  findSecretShapedValues,
  isPrerequisiteSatisfied,
  resolvePrerequisiteReadiness,
  rowToAttestation,
} from './external-prerequisites';

/**
 * Credential-shaped FIXTURES are assembled at runtime, never written as literals.
 *
 * This is not cosmetic. A literal `ghp_…`/`sk_live_…` in a tree file trips the
 * repo secrets-guard on write, and — worse — the pot-git PUBLISH guard, whose
 * baseline never advances past a refused range: the blob is re-scanned and
 * re-refused on every later tick, and deleting the file afterwards does not remove
 * it from history. Splitting the prefix keeps the bytes on disk clean while the
 * assembled value the guard-under-test sees is byte-identical to the real thing.
 */
const FIXTURE = {
  stripeSecret: ['sk', 'live', '51HxAbCdEfGhIjKlMnOpQrStUv'].join('_'),
  stripeRestricted: ['rk', 'test', '51HxAbCdEfGhIjKlMnOpQrStUv'].join('_'),
  githubToken: 'gh' + 'p' + '_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  slackToken: 'xox' + 'b' + '-123456789012-abcdefghijkl',
  awsKeyId: 'AKIA' + 'IOSFODNN7EXAMPLE',
  pemPrivateKey: '-----BEGIN RSA ' + 'PRIVATE KEY' + '-----\nMIIEpAIBAAKC\n',
  jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9.ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0.abc',
} as const;

const OBSERVED = '2026-08-23T12:00:00.000Z';
const OBSERVED_MS = Date.parse(OBSERVED);
const HOUR_SEC = 3600;

function ready(overrides: Partial<ExternalPrerequisiteAttestation> = {}): ExternalPrerequisiteAttestation {
  return {
    ...buildAttestation({
      key: 'stripe-webhook',
      capabilityKind: 'stripe-endpoint',
      present: true,
      binding: { webhook_endpoint_id: 'we_1QxAbC', livemode: 'true' },
      observedAt: OBSERVED,
      expirySec: HOUR_SEC,
      provenance: 'probe',
      probeRef: 'probes/stripe/endpoint-binding',
    }),
    ...overrides,
  };
}

describe('resolvePrerequisiteReadiness — an absence must never read as ready', () => {
  it('reports absent (no-attestation) when nothing has been observed', () => {
    const r = resolvePrerequisiteReadiness(null, OBSERVED_MS);
    expect(r).toEqual({ state: 'absent', reason: 'no-attestation' });
    expect(isPrerequisiteSatisfied(r)).toBe(false);
  });

  it('distinguishes a probe that RAN and found the wall down from no probe at all', () => {
    const r = resolvePrerequisiteReadiness(ready({ present: false }), OBSERVED_MS);
    expect(r).toEqual({ state: 'absent', reason: 'probe-reported-absent' });
    expect(isPrerequisiteSatisfied(r)).toBe(false);
  });

  it('is ready strictly before expiry', () => {
    const r = resolvePrerequisiteReadiness(ready(), OBSERVED_MS + (HOUR_SEC - 1) * 1000);
    expect(r.state).toBe('ready');
    expect(isPrerequisiteSatisfied(r)).toBe(true);
  });

  it('treats the expiry boundary as SPENT, not still-ready', () => {
    const r = resolvePrerequisiteReadiness(ready(), OBSERVED_MS + HOUR_SEC * 1000);
    expect(r.state).toBe('expired');
    expect(isPrerequisiteSatisfied(r)).toBe(false);
  });

  it('reports expired (not absent) after expiry, so an operator can tell lapsed from never-present', () => {
    const r = resolvePrerequisiteReadiness(ready(), OBSERVED_MS + 10 * HOUR_SEC * 1000);
    expect(r.state).toBe('expired');
    if (r.state === 'expired') expect(r.expiredAt).toBe(new Date(OBSERVED_MS + HOUR_SEC * 1000).toISOString());
    expect(isPrerequisiteSatisfied(r)).toBe(false);
  });

  it('an UNPARSEABLE expiry is unknown — never "never expires"', () => {
    const r = resolvePrerequisiteReadiness(ready({ expiresAt: 'whenever' }), OBSERVED_MS);
    expect(r.state).toBe('unknown');
    expect(isPrerequisiteSatisfied(r)).toBe(false);
  });

  it('an unusable evaluation instant is unknown, not ready', () => {
    const r = resolvePrerequisiteReadiness(ready(), Number.NaN);
    expect(r.state).toBe('unknown');
    expect(isPrerequisiteSatisfied(r)).toBe(false);
  });
});

describe('isPrerequisiteSatisfied — exactly one state admits', () => {
  it('admits ready and refuses every other state', () => {
    const all: PrerequisiteReadiness[] = [
      { state: 'ready', expiresAt: OBSERVED, attestation: ready() },
      { state: 'absent', reason: 'no-attestation' },
      { state: 'absent', reason: 'probe-reported-absent' },
      { state: 'expired', expiredAt: OBSERVED, attestation: ready() },
      { state: 'unknown', reason: 'anything' },
    ];
    expect(all.filter(isPrerequisiteSatisfied).map((r) => r.state)).toEqual(['ready']);
  });
});

describe('zero-secret invariant', () => {
  // CALIBRATION CONTROL. Without this, a guard that rejected EVERYTHING would pass
  // every "it throws" assertion below and look perfectly healthy. This asserts the
  // guard still admits the legitimate metadata the store exists to hold.
  it('CONTROL: admits genuine fingerprint/binding metadata', () => {
    expect(
      findSecretShapedValues({
        cert_sha256: 'a3f1'.repeat(16), // 64-char hex digest
        bundle_id: 'com.papercusp.desktop',
        webhook_endpoint_id: 'we_1QxAbC',
        team_id: 'AB12CD34EF',
        livemode: 'true',
      }),
    ).toEqual([]);
  });

  it.each([
    ['stripe secret key', FIXTURE.stripeSecret],
    ['stripe restricted key', FIXTURE.stripeRestricted],
    ['github token', FIXTURE.githubToken],
    ['slack token', FIXTURE.slackToken],
    ['aws access key id', FIXTURE.awsKeyId],
    ['pem private key', FIXTURE.pemPrivateKey],
    ['jwt', FIXTURE.jwt],
  ])('flags a %s in binding', (_label, value) => {
    expect(findSecretShapedValues({ leaked: value })).toHaveLength(1);
  });

  it('flags an oversized value even when it matches no known issuer', () => {
    expect(findSecretShapedValues({ blob: 'z'.repeat(200) })).toEqual([{ field: 'blob', reason: 'oversized-value' }]);
  });

  it('never echoes the offending VALUE back (that would copy the secret into logs)', () => {
    const findings = findSecretShapedValues({ leaked: FIXTURE.stripeSecret });
    expect(JSON.stringify(findings)).not.toContain(FIXTURE.stripeSecret);
  });

  it('buildAttestation REFUSES to construct an attestation carrying a credential', () => {
    expect(() =>
      buildAttestation({
        key: 'stripe-webhook',
        capabilityKind: 'stripe-endpoint',
        present: true,
        binding: { api_key: FIXTURE.stripeSecret },
        observedAt: OBSERVED,
        expirySec: HOUR_SEC,
        provenance: 'probe',
        probeRef: 'p',
      }),
    ).toThrow(/credential-shaped binding values/);
  });

  it('assertZeroSecretSpec catches a VALUE pasted where a NAME belongs', () => {
    const spec: ExternalPrerequisiteSpec = {
      key: 'stripe',
      capabilityKind: 'stripe-endpoint',
      requiredNames: ['STRIPE_SECRET_KEY', FIXTURE.stripeSecret],
      target: { host: 'api.stripe.com' },
      probeRef: 'p',
      expirySec: HOUR_SEC,
      owningWorkItem: 'WI-41115',
      completionEvent: 'release:prereq:stripe:ready',
    };
    expect(() => assertZeroSecretSpec(spec)).toThrow(/NAMES and SCOPES, never values/);
  });

  it('CONTROL: a spec declaring only names passes', () => {
    const spec: ExternalPrerequisiteSpec = {
      key: 'stripe',
      capabilityKind: 'stripe-endpoint',
      requiredNames: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
      target: { host: 'api.stripe.com' },
      probeRef: 'p',
      expirySec: HOUR_SEC,
      owningWorkItem: 'WI-41115',
      completionEvent: 'release:prereq:stripe:ready',
    };
    expect(() => assertZeroSecretSpec(spec)).not.toThrow();
  });
});

describe('buildAttestation', () => {
  it('derives expiresAt from observedAt + expirySec', () => {
    expect(ready().expiresAt).toBe(new Date(OBSERVED_MS + HOUR_SEC * 1000).toISOString());
  });

  it('refuses a non-positive expiry rather than minting an already-dead receipt', () => {
    expect(() =>
      buildAttestation({
        key: 'k',
        capabilityKind: 'apple-signing',
        present: true,
        binding: {},
        observedAt: OBSERVED,
        expirySec: 0,
        provenance: 'probe',
        probeRef: 'p',
      }),
    ).toThrow(/positive expirySec/);
  });

  it('refuses an unparseable observedAt', () => {
    expect(() =>
      buildAttestation({
        key: 'k',
        capabilityKind: 'apple-signing',
        present: true,
        binding: {},
        observedAt: 'not-a-date',
        expirySec: HOUR_SEC,
        provenance: 'probe',
        probeRef: 'p',
      }),
    ).toThrow(/unparseable observedAt/);
  });

  it('copies binding rather than aliasing the caller’s object', () => {
    const binding: Record<string, string> = { bundle_id: 'com.papercusp.desktop' };
    const a = buildAttestation({
      key: 'apple',
      capabilityKind: 'apple-signing',
      present: true,
      binding,
      observedAt: OBSERVED,
      expirySec: HOUR_SEC,
      provenance: 'probe',
      probeRef: 'p',
    });
    binding.bundle_id = 'com.evil.swap';
    expect(a.binding.bundle_id).toBe('com.papercusp.desktop');
  });
});

describe('storage mapping — the SQL and the type must not drift', () => {
  it('round-trips through the row shape without loss', () => {
    const a = ready();
    expect(rowToAttestation(attestationToRow(a))).toEqual(a);
  });

  it('emits exactly the migration-928 column set', () => {
    expect(Object.keys(attestationToRow(ready())).sort()).toEqual(
      [
        'binding',
        'capability_kind',
        'expires_at',
        'observed_at',
        'present',
        'probe_ref',
        'prerequisite_key',
        'provenance',
      ].sort(),
    );
  });

  it.each([
    ['unknown capability kind', { capability_kind: 'not-a-kind' }],
    ['unknown provenance', { provenance: 'hearsay' }],
    ['unparseable observed_at', { observed_at: 'nope' }],
    ['unparseable expires_at', { expires_at: 'nope' }],
    ['missing key', { prerequisite_key: '' }],
    ['non-boolean present', { present: 'yes' as unknown as boolean }],
  ])('returns null (never a partial receipt) for a row with %s', (_label, patch) => {
    const row: ExternalPrerequisiteAttestationRow = { ...attestationToRow(ready()), ...patch };
    expect(rowToAttestation(row)).toBeNull();
  });

  it('a malformed row therefore reads as ABSENT downstream, not as a receipt', () => {
    const row: ExternalPrerequisiteAttestationRow = {
      ...attestationToRow(ready()),
      capability_kind: 'not-a-kind',
    };
    const r = resolvePrerequisiteReadiness(rowToAttestation(row), OBSERVED_MS);
    expect(r).toEqual({ state: 'absent', reason: 'no-attestation' });
    expect(isPrerequisiteSatisfied(r)).toBe(false);
  });
});

describe('capability kinds', () => {
  it('ships the two adapters P-004 declares', () => {
    expect([...EXTERNAL_CAPABILITY_KINDS]).toEqual(['stripe-endpoint', 'apple-signing']);
  });
});
