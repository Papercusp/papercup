import { describe, expect, it } from 'vitest';
import {
  BINDING_STATUSES,
  CONTRIBUTOR_ROW_SCHEMA_VERSION,
  activeDeviceCount,
  buildFreshContributorRow,
  contributesToStats,
  isContributorRow,
  isDeviceAttestationEntry,
  isPubkeyRevoked,
  type ContributorRow,
  type DeviceAttestationEntry,
} from './contributor-row-types';

function makeAttestation(over: Partial<DeviceAttestationEntry> = {}): DeviceAttestationEntry {
  return {
    device_pubkey: 'ed25519:AABBCC',
    gist_id: 'abc123',
    gist_url: 'https://gist.github.com/x/abc123',
    device_label: 'alice-laptop',
    created_at: 1716_000_000_000,
    signature_by_device: 'sig-base64',
    ...over,
  };
}

function makeRow(over: Partial<ContributorRow> = {}): ContributorRow {
  return {
    harness_slug: 'papercup',
    github_user_id: 12345,
    github_username: 'alice',
    display_name: 'Alice',
    avatar_url: 'https://avatars.githubusercontent.com/u/12345',
    device_attestations: [makeAttestation()],
    revoked_pubkeys: [],
    joined_at: 1716_000_000_000,
    last_seen_at: 1716_000_010_000,
    binding_status: 'verified',
    channel1_verified_at: 1716_000_000_500,
    channel2_verified_at: 1716_000_001_000,
    channel2_branch_ref: 'user/12345',
    binding_last_checked_at: 1716_000_010_000,
    schema_version: 1,
    ...over,
  };
}

describe('constants', () => {
  it('CONTRIBUTOR_ROW_SCHEMA_VERSION is 1', () => {
    expect(CONTRIBUTOR_ROW_SCHEMA_VERSION).toBe(1);
  });

  it('BINDING_STATUSES covers all 3 binding-verifier states', () => {
    expect([...BINDING_STATUSES]).toEqual(['verified', 'pending', 'unverified']);
  });
});

describe('isDeviceAttestationEntry', () => {
  it('accepts a well-formed entry', () => {
    expect(isDeviceAttestationEntry(makeAttestation())).toBe(true);
  });

  it('rejects empty required strings', () => {
    expect(isDeviceAttestationEntry(makeAttestation({ device_pubkey: '' }))).toBe(false);
    expect(isDeviceAttestationEntry(makeAttestation({ gist_id: '' }))).toBe(false);
    expect(isDeviceAttestationEntry(makeAttestation({ gist_url: '' }))).toBe(false);
    expect(isDeviceAttestationEntry(makeAttestation({ signature_by_device: '' }))).toBe(false);
  });

  it('accepts empty device_label (rare but allowed)', () => {
    expect(isDeviceAttestationEntry(makeAttestation({ device_label: '' }))).toBe(true);
  });

  it('rejects non-finite created_at', () => {
    expect(isDeviceAttestationEntry(makeAttestation({ created_at: Number.NaN }))).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(isDeviceAttestationEntry(null)).toBe(false);
    expect(isDeviceAttestationEntry('x')).toBe(false);
    expect(isDeviceAttestationEntry(42)).toBe(false);
  });
});

describe('isContributorRow', () => {
  it('accepts a well-formed row', () => {
    expect(isContributorRow(makeRow())).toBe(true);
  });

  it('accepts rows with null nullable fields', () => {
    expect(
      isContributorRow(
        makeRow({
          display_name: null,
          avatar_url: null,
          last_seen_at: null,
          channel1_verified_at: null,
          channel2_verified_at: null,
          channel2_branch_ref: null,
          binding_last_checked_at: null,
        }),
      ),
    ).toBe(true);
  });

  it('rejects non-positive github_user_id', () => {
    expect(isContributorRow(makeRow({ github_user_id: 0 }))).toBe(false);
    expect(isContributorRow(makeRow({ github_user_id: -1 }))).toBe(false);
    expect(isContributorRow(makeRow({ github_user_id: 1.5 }))).toBe(false);
  });

  it('rejects empty required strings', () => {
    expect(isContributorRow(makeRow({ harness_slug: '' }))).toBe(false);
    expect(isContributorRow(makeRow({ github_username: '' }))).toBe(false);
  });

  it('rejects unknown binding_status', () => {
    expect(
      isContributorRow({ ...makeRow(), binding_status: 'whatever' } as unknown),
    ).toBe(false);
  });

  it('rejects non-array device_attestations / revoked_pubkeys', () => {
    expect(
      isContributorRow({ ...makeRow(), device_attestations: 'no' } as unknown),
    ).toBe(false);
    expect(
      isContributorRow({ ...makeRow(), revoked_pubkeys: 'no' } as unknown),
    ).toBe(false);
  });

  it('rejects wrong schema_version', () => {
    expect(isContributorRow({ ...makeRow(), schema_version: 2 })).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(isContributorRow(null)).toBe(false);
    expect(isContributorRow('x')).toBe(false);
  });
});

describe('contributesToStats', () => {
  it('true for verified contributors', () => {
    expect(contributesToStats(makeRow({ binding_status: 'verified' }))).toBe(true);
  });

  it('false for pending + unverified', () => {
    expect(contributesToStats(makeRow({ binding_status: 'pending' }))).toBe(false);
    expect(contributesToStats(makeRow({ binding_status: 'unverified' }))).toBe(false);
  });
});

describe('isPubkeyRevoked', () => {
  it('true when pubkey is in revoked_pubkeys', () => {
    expect(
      isPubkeyRevoked(makeRow({ revoked_pubkeys: ['ed25519:BAD'] }), 'ed25519:BAD'),
    ).toBe(true);
  });

  it('false when not revoked', () => {
    expect(isPubkeyRevoked(makeRow(), 'ed25519:GOOD')).toBe(false);
  });
});

describe('activeDeviceCount', () => {
  it('counts non-revoked devices', () => {
    expect(
      activeDeviceCount(
        makeRow({
          device_attestations: [
            makeAttestation({ device_pubkey: 'ed25519:A' }),
            makeAttestation({ device_pubkey: 'ed25519:B' }),
            makeAttestation({ device_pubkey: 'ed25519:C' }),
          ],
          revoked_pubkeys: ['ed25519:B'],
        }),
      ),
    ).toBe(2);
  });

  it('returns 0 for empty attestations', () => {
    expect(activeDeviceCount(makeRow({ device_attestations: [], revoked_pubkeys: [] }))).toBe(0);
  });
});

describe('buildFreshContributorRow', () => {
  it('builds a row with binding_status=pending + initial attestation', () => {
    const row = buildFreshContributorRow({
      harness_slug: 'papercup',
      github_user_id: 12345,
      github_username: 'alice',
      initial_attestation: makeAttestation(),
      now: 1716_000_000_000,
    });
    expect(row.binding_status).toBe('pending');
    expect(row.device_attestations).toHaveLength(1);
    expect(row.revoked_pubkeys).toEqual([]);
    expect(row.joined_at).toBe(1716_000_000_000);
    expect(row.last_seen_at).toBe(1716_000_000_000);
    expect(row.schema_version).toBe(1);
  });

  it('round-trips through isContributorRow', () => {
    const row = buildFreshContributorRow({
      harness_slug: 'papercup',
      github_user_id: 12345,
      github_username: 'alice',
      initial_attestation: makeAttestation(),
      now: 1,
    });
    expect(isContributorRow(row)).toBe(true);
  });

  it('rejects malformed inputs', () => {
    expect(() =>
      buildFreshContributorRow({
        harness_slug: '',
        github_user_id: 1,
        github_username: 'a',
        initial_attestation: makeAttestation(),
        now: 1,
      }),
    ).toThrow(TypeError);
    expect(() =>
      buildFreshContributorRow({
        harness_slug: 'x',
        github_user_id: 0,
        github_username: 'a',
        initial_attestation: makeAttestation(),
        now: 1,
      }),
    ).toThrow(TypeError);
    expect(() =>
      buildFreshContributorRow({
        harness_slug: 'x',
        github_user_id: 1,
        github_username: '',
        initial_attestation: makeAttestation(),
        now: 1,
      }),
    ).toThrow(TypeError);
    expect(() =>
      buildFreshContributorRow({
        harness_slug: 'x',
        github_user_id: 1,
        github_username: 'a',
        initial_attestation: { ...makeAttestation(), device_pubkey: '' },
        now: 1,
      }),
    ).toThrow(TypeError);
  });
});
