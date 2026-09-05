import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PINNING_POLICY,
  distributionEventDigest,
  distributionEventSigningBytes,
  distributionManifestDigest,
  distributionStreamId,
  evaluatePinHealth,
  isAuthoritativeSource,
  isSourceExpired,
  reduceDistributionEvents,
  resolveDistributionSources,
  unsignedDistributionEvent,
  validateDistributionEvent,
  validateDistributionManifest,
  yankOutcome,
  type ArtifactDistributionManifest,
  type DistributionEvent,
  type DistributionSource,
} from './artifact-distribution';
import type { CupboardReleaseManifest } from '../cupboard/listing-manifest';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;

const release = (overrides: Partial<CupboardReleaseManifest> = {}): CupboardReleaseManifest => ({
  schemaVersion: 1,
  listingKind: 'plugin',
  listingRef: 'demo',
  releaseVersion: '1.0.0',
  contentHash: HASH_A,
  signature: 'release-sig',
  dependencies: ['node>=25'],
  compatibility: { runtime: 'papercusp>=1' },
  permissions: ['network:read'],
  capabilities: ['tool:invoke'],
  license: 'MIT',
  publisher: { githubUserId: 42, login: 'avi' },
  reviewStatus: 'approved',
  ...overrides,
});

const manifest = (overrides: Partial<ArtifactDistributionManifest> = {}): ArtifactDistributionManifest => ({
  schemaVersion: 1,
  release: release(),
  rootHash: HASH_A,
  totalSizeBytes: 300,
  chunks: [
    { index: 0, contentHash: HASH_B, sizeBytes: 100 },
    { index: 1, contentHash: HASH_C, sizeBytes: 200 },
  ],
  visibility: 'public',
  encryption: null,
  pinning: DEFAULT_PINNING_POLICY,
  signature: 'manifest-sig',
  ...overrides,
});

const privateManifest = (): ArtifactDistributionManifest =>
  manifest({
    rootHash: HASH_B,
    visibility: 'private',
    encryption: { scheme: 'aes-256-gcm', keyVersion: 1, ciphertextHash: HASH_B, wrappedKeyIds: ['wk-1'] },
  });

const source = (overrides: Partial<DistributionSource> = {}): DistributionSource => ({
  sourceId: 'src-1',
  class: 'peer',
  providerId: 'libp2p',
  locator: 'opaque-locator',
  advertisedAtMs: 1_000,
  expiresAtMs: null,
  ...overrides,
});

const event = (overrides: Partial<DistributionEvent> = {}): DistributionEvent => ({
  eventId: 'evt-1',
  streamId: 'dist:plugin:demo@1.0.0',
  kind: 'release-published',
  version: 1,
  issuer: 'publisher-1',
  sequence: 0,
  occurredAtMs: 1_000,
  idempotencyKey: 'idem-1',
  payload: { manifest: manifest() },
  signature: 'sig',
  ...overrides,
});

/** The canonical happy-path log: publish, two peers, one pin. */
const publishedLog = (): DistributionEvent[] => [
  event(),
  event({ eventId: 'evt-2', kind: 'peer-advertised', sequence: 1, idempotencyKey: 'idem-2', payload: { source: source() } }),
  event({
    eventId: 'evt-3',
    kind: 'pin-committed',
    sequence: 2,
    idempotencyKey: 'idem-3',
    payload: { source: source({ sourceId: 'src-2', class: 'pinner', providerId: 'r2', advertisedAtMs: 1_500 }) },
  }),
];

describe('P2P artifact distribution — manifest', () => {
  it('canonicalizes the signed manifest and derives a deterministic stream id', () => {
    expect(distributionManifestDigest(manifest())).toMatch(/^[0-9a-f]{64}$/);
    expect(distributionStreamId(release())).toBe('dist:plugin:demo@1.0.0');
    expect(distributionStreamId(release())).toBe(distributionStreamId(release({ contentHash: HASH_C })));
  });

  it('accepts a well-formed public manifest and its embedded release metadata', () => {
    const result = validateDistributionManifest(manifest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // version/dependency/permission metadata is reused from P-006, never restated.
    expect(result.manifest.release.dependencies).toEqual(['node>=25']);
    expect(result.manifest.release.permissions).toEqual(['network:read']);
    expect(result.manifest.release.releaseVersion).toBe('1.0.0');
  });

  it('rejects chunk sets that do not add up to the declared size or are out of order', () => {
    expect(validateDistributionManifest(manifest({ totalSizeBytes: 999 }))).toMatchObject({ ok: false, code: 'chunk-size-mismatch' });
    expect(
      validateDistributionManifest(
        manifest({ chunks: [{ index: 1, contentHash: HASH_B, sizeBytes: 300 }] }),
      ),
    ).toMatchObject({ ok: false, code: 'invalid-chunks' });
    expect(validateDistributionManifest(manifest({ chunks: [] }))).toMatchObject({ ok: false, code: 'invalid-chunks' });
  });

  it('binds a public rootHash to the release content hash', () => {
    expect(validateDistributionManifest(manifest({ rootHash: HASH_C }))).toMatchObject({ ok: false, code: 'encryption-mismatch' });
    expect(validateDistributionManifest(manifest({ rootHash: 'sha256:nope' }))).toMatchObject({ ok: false, code: 'invalid-hash' });
  });

  it('requires a private listing to distribute ciphertext, not the plaintext hash', () => {
    expect(validateDistributionManifest(privateManifest()).ok).toBe(true);
    // A private listing whose rootHash is the plaintext hash would leak that the
    // published bytes are unencrypted.
    expect(
      validateDistributionManifest(
        manifest({ visibility: 'private', encryption: { scheme: 'aes-256-gcm', keyVersion: 1, ciphertextHash: HASH_A, wrappedKeyIds: ['wk-1'] } }),
      ),
    ).toMatchObject({ ok: false, code: 'encryption-mismatch' });
    expect(validateDistributionManifest(manifest({ visibility: 'private' }))).toMatchObject({ ok: false, code: 'encryption-mismatch' });
    expect(validateDistributionManifest(manifest({ encryption: privateManifest().encryption }))).toMatchObject({ ok: false, code: 'encryption-mismatch' });
  });

  it('rejects an invalid embedded release manifest, policy, or missing signature', () => {
    expect(validateDistributionManifest(manifest({ release: release({ publisher: { githubUserId: 0 } }) }))).toMatchObject({ ok: false, code: 'invalid-release' });
    expect(validateDistributionManifest(manifest({ pinning: { ...DEFAULT_PINNING_POLICY, minReplicas: 0 } }))).toMatchObject({ ok: false, code: 'invalid-policy' });
    expect(validateDistributionManifest(manifest({ signature: '' }))).toMatchObject({ ok: false, code: 'missing-signature' });
    expect(validateDistributionManifest({ schemaVersion: 2 })).toMatchObject({ ok: false, code: 'unsupported-version' });
  });
});

describe('P2P artifact distribution — event log', () => {
  it('validates the signed envelope and produces canonical signing bytes', () => {
    const e = event();
    expect(distributionEventSigningBytes(unsignedDistributionEvent(e))).toBeInstanceOf(Buffer);
    expect(distributionEventDigest(unsignedDistributionEvent(e))).toMatch(/^[0-9a-f]{64}$/);
    expect(validateDistributionEvent(e)).toEqual({ ok: true, event: e });
    expect(validateDistributionEvent({ ...e, kind: 'not-a-kind' })).toMatchObject({ ok: false, code: 'invalid-kind' });
    expect(validateDistributionEvent({ ...e, signature: '' })).toMatchObject({ ok: false, code: 'missing-signature' });
  });

  it('deduplicates exact retries and quarantines conflicting facts instead of merging them', () => {
    const same = event();
    const sequenceConflict = event({ eventId: 'evt-2', idempotencyKey: 'idem-2' });
    const idempotencyConflict = event({ eventId: 'evt-3', sequence: 1 });
    const result = reduceDistributionEvents([same, same, sequenceConflict, idempotencyConflict]);
    expect(result.duplicates).toEqual(['evt-1']);
    expect(result.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'sequence-conflict' }), expect.objectContaining({ reason: 'idempotency-conflict' })]),
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.states).toHaveLength(0);
  });

  it('converges on the same state regardless of arrival order (offline peer replication)', () => {
    const log = publishedLog();
    const forward = reduceDistributionEvents(log);
    const shuffled = reduceDistributionEvents([log[2], log[0], log[1]]);
    expect(shuffled.states).toEqual(forward.states);
    expect(forward.states[0].sources.map((s) => s.sourceId)).toEqual(['src-1', 'src-2']);
    expect(forward.states[0].pins).toEqual(['src-2']);
    expect(forward.states[0].lastSequence).toBe(2);
  });

  it('drops malformed payloads and unknown-source withdrawals without corrupting state', () => {
    const result = reduceDistributionEvents([
      ...publishedLog(),
      event({ eventId: 'evt-4', kind: 'peer-advertised', sequence: 3, idempotencyKey: 'idem-4', payload: { source: { sourceId: 'bad' } } }),
      event({ eventId: 'evt-5', kind: 'peer-withdrawn', sequence: 4, idempotencyKey: 'idem-5', payload: { sourceId: 'never-seen' } }),
      event({ eventId: 'evt-6', kind: 'cache-mirrored', sequence: 5, idempotencyKey: 'idem-6', payload: { source: source({ sourceId: 'src-3', class: 'peer' }) } }),
    ]);
    expect(result.ignored).toEqual([
      { eventId: 'evt-4', reason: 'malformed-payload' },
      { eventId: 'evt-5', reason: 'unknown-source' },
      { eventId: 'evt-6', reason: 'malformed-payload' },
    ]);
    expect(result.states[0].sources.map((s) => s.sourceId)).toEqual(['src-1', 'src-2']);
  });

  it('withdraws peers and releases pins', () => {
    const result = reduceDistributionEvents([
      ...publishedLog(),
      event({ eventId: 'evt-4', kind: 'pin-released', sequence: 3, idempotencyKey: 'idem-4', payload: { sourceId: 'src-2' } }),
      event({ eventId: 'evt-5', kind: 'peer-withdrawn', sequence: 4, idempotencyKey: 'idem-5', payload: { sourceId: 'src-1' } }),
    ]);
    expect(result.states[0].pins).toEqual([]);
    expect(result.states[0].sources.map((s) => s.sourceId)).toEqual(['src-2']);
  });

  it('rotates key versions forward only and records revocations', () => {
    const base = [
      event({ payload: { manifest: privateManifest() } }),
      event({ eventId: 'evt-2', kind: 'key-rotated', sequence: 1, idempotencyKey: 'idem-2', payload: { keyVersion: 2 } }),
      event({ eventId: 'evt-3', kind: 'key-rotated', sequence: 2, idempotencyKey: 'idem-3', payload: { keyVersion: 1 } }),
      event({ eventId: 'evt-4', kind: 'revoked', sequence: 3, idempotencyKey: 'idem-4', payload: { keyVersion: 1 } }),
    ];
    const result = reduceDistributionEvents(base);
    expect(result.states[0].keyVersion).toBe(2);
    expect(result.states[0].revokedKeyVersions).toEqual([1]);
    expect(result.ignored).toEqual([{ eventId: 'evt-3', reason: 'malformed-payload' }]);
  });
});

describe('P2P artifact distribution — yank and revoke are immutable', () => {
  it('stops official delivery and refuses every later re-advertisement', () => {
    const result = reduceDistributionEvents([
      ...publishedLog(),
      event({ eventId: 'evt-4', kind: 'yanked', sequence: 3, idempotencyKey: 'idem-4', payload: { reason: 'malicious dependency' } }),
      event({ eventId: 'evt-5', kind: 'peer-advertised', sequence: 4, idempotencyKey: 'idem-5', payload: { source: source({ sourceId: 'src-9' }) } }),
      event({ eventId: 'evt-6', kind: 'release-published', sequence: 5, idempotencyKey: 'idem-6', payload: { manifest: manifest() } }),
    ]);
    const state = result.states[0];
    expect(state.yankedAtMs).toBe(1_000);
    expect(state.yankReason).toBe('malicious dependency');
    expect(state.sources.map((s) => s.sourceId)).toEqual(['src-1', 'src-2']);
    expect(result.ignored).toEqual([
      { eventId: 'evt-5', reason: 'immutable-yank' },
      { eventId: 'evt-6', reason: 'immutable-yank' },
    ]);
    expect(resolveDistributionSources(state, { nowMs: 2_000 })).toMatchObject({ deliverable: false, reason: 'yanked' });
  });

  it('still admits a key revocation after a yank, so a private release can be locked down further', () => {
    const result = reduceDistributionEvents([
      event({ payload: { manifest: privateManifest() } }),
      event({ eventId: 'evt-2', kind: 'yanked', sequence: 1, idempotencyKey: 'idem-2', payload: {} }),
      event({ eventId: 'evt-3', kind: 'revoked', sequence: 2, idempotencyKey: 'idem-3', payload: { keyVersion: 1 } }),
    ]);
    expect(result.states[0].revokedKeyVersions).toEqual([1]);
    expect(result.ignored).toEqual([]);
  });

  it('reports honestly that copied public bytes cannot be recalled, and retains for in-flight installs', () => {
    const publicYank = reduceDistributionEvents([...publishedLog(), event({ eventId: 'evt-4', kind: 'yanked', sequence: 3, idempotencyKey: 'idem-4', payload: { reason: 'r' } })]).states[0];
    expect(yankOutcome(publicYank)).toEqual({
      yanked: true,
      officialDeliveryStopped: true,
      retainUntilMs: 1_000 + DEFAULT_PINNING_POLICY.yankRetentionMs,
      publicCopiesUnrecallable: true,
      reason: 'r',
    });

    const privateYank = reduceDistributionEvents([
      event({ payload: { manifest: privateManifest() } }),
      event({ eventId: 'evt-2', kind: 'yanked', sequence: 1, idempotencyKey: 'idem-2', payload: {} }),
    ]).states[0];
    expect(yankOutcome(privateYank)).toMatchObject({ publicCopiesUnrecallable: false, reason: null });

    expect(yankOutcome(reduceDistributionEvents(publishedLog()).states[0])).toMatchObject({ yanked: false, retainUntilMs: null });
  });

  it('keeps the first yank when a second one arrives', () => {
    const result = reduceDistributionEvents([
      ...publishedLog(),
      event({ eventId: 'evt-4', kind: 'yanked', sequence: 3, idempotencyKey: 'idem-4', occurredAtMs: 5_000, payload: { reason: 'first' } }),
      event({ eventId: 'evt-5', kind: 'yanked', sequence: 4, idempotencyKey: 'idem-5', occurredAtMs: 9_000, payload: { reason: 'second' } }),
    ]);
    expect(result.states[0]).toMatchObject({ yankedAtMs: 5_000, yankReason: 'first' });
  });
});

describe('P2P artifact distribution — resolution, pinning and provider neutrality', () => {
  const state = () => reduceDistributionEvents(publishedLog()).states[0];

  it('orders sources by class, never by locator shape (D-025 provider neutrality)', () => {
    const withCache = reduceDistributionEvents([
      ...publishedLog(),
      event({
        eventId: 'evt-4',
        kind: 'cache-mirrored',
        sequence: 3,
        idempotencyKey: 'idem-4',
        payload: { source: source({ sourceId: 'src-cdn', class: 'cache', providerId: 'cdn', advertisedAtMs: 2_000 }) },
      }),
      event({
        eventId: 'evt-5',
        kind: 'peer-advertised',
        sequence: 4,
        idempotencyKey: 'idem-5',
        payload: { source: source({ sourceId: 'src-origin', class: 'origin', providerId: 'r2', advertisedAtMs: 2_000 }) },
      }),
    ]).states[0];
    const resolution = resolveDistributionSources(withCache, { nowMs: 3_000 });
    expect(resolution.deliverable).toBe(true);
    expect(resolution.sources.map((s) => s.sourceId)).toEqual(['src-2', 'src-1', 'src-origin', 'src-cdn']);
    // A CDN mirror accelerates; it never counts as an authoritative replica.
    expect(resolution.sources.filter(isAuthoritativeSource).map((s) => s.sourceId)).toEqual(['src-2', 'src-1', 'src-origin']);
    expect(evaluatePinHealth(withCache, 3_000)).toEqual({ replicas: 3, minReplicas: 2, healthy: true, deficit: 0 });
  });

  it('reports a pin deficit when authoritative replicas fall below the policy', () => {
    const single = reduceDistributionEvents([
      event(),
      event({ eventId: 'evt-2', kind: 'cache-mirrored', sequence: 1, idempotencyKey: 'idem-2', payload: { source: source({ sourceId: 'src-cdn', class: 'cache' }) } }),
    ]).states[0];
    expect(evaluatePinHealth(single, 2_000)).toEqual({ replicas: 0, minReplicas: 2, healthy: false, deficit: 2 });
  });

  it('expires stale advertisements by self-declared expiry and by policy TTL', () => {
    const policy = DEFAULT_PINNING_POLICY;
    expect(isSourceExpired(source({ expiresAtMs: 5_000 }), policy, 4_999)).toBe(false);
    expect(isSourceExpired(source({ expiresAtMs: 5_000 }), policy, 5_000)).toBe(true);
    expect(isSourceExpired(source(), policy, 1_000 + policy.advertisementTtlMs)).toBe(true);
    // src-1 advertised at 1_000 and src-2 at 1_500, so each ages out on its own clock.
    expect(resolveDistributionSources(state(), { nowMs: 1_000 + policy.advertisementTtlMs }).sources.map((s) => s.sourceId)).toEqual(['src-2']);
    expect(resolveDistributionSources(state(), { nowMs: 1_500 + policy.advertisementTtlMs })).toMatchObject({ deliverable: false, reason: 'no-sources' });
  });

  it('serves an offline client only from what it already pins', () => {
    expect(resolveDistributionSources(state(), { nowMs: 2_000, offline: true })).toMatchObject({
      deliverable: true,
      reason: 'ok',
    });
    expect(resolveDistributionSources(state(), { nowMs: 2_000, offline: true }).sources.map((s) => s.sourceId)).toEqual(['src-2']);

    const unpinned = reduceDistributionEvents(publishedLog().slice(0, 2)).states[0];
    expect(resolveDistributionSources(unpinned, { nowMs: 2_000, offline: true })).toMatchObject({ deliverable: false, reason: 'offline-no-pin' });
  });

  it('refuses delivery to a revoked entitlement key version', () => {
    const revoked = reduceDistributionEvents([
      event({ payload: { manifest: privateManifest() } }),
      event({ eventId: 'evt-2', kind: 'pin-committed', sequence: 1, idempotencyKey: 'idem-2', payload: { source: source({ sourceId: 'src-2', class: 'pinner' }) } }),
      event({ eventId: 'evt-3', kind: 'revoked', sequence: 2, idempotencyKey: 'idem-3', payload: { keyVersion: 1 } }),
    ]).states[0];
    expect(resolveDistributionSources(revoked, { nowMs: 2_000, keyVersion: 1 })).toMatchObject({ deliverable: false, reason: 'key-revoked' });
    expect(resolveDistributionSources(revoked, { nowMs: 2_000, keyVersion: 2 })).toMatchObject({ deliverable: true, reason: 'ok' });
  });

  it('refuses delivery for a stream with sources but no published manifest', () => {
    const noManifest = reduceDistributionEvents([
      event({ eventId: 'evt-2', kind: 'peer-advertised', sequence: 1, idempotencyKey: 'idem-2', payload: { source: source() } }),
    ]).states[0];
    expect(resolveDistributionSources(noManifest, { nowMs: 2_000 })).toMatchObject({ deliverable: false, reason: 'no-manifest' });
  });
});
