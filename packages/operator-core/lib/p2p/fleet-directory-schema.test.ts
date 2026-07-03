/**
 * fleet-directory-schema — pure unit tests (P-101 / D-006). The closed-schema
 * validator gates untrusted record input; the canonical-JSON + signed-bytes pair
 * is the single signing surface the author AND the remote projection share.
 */
import { describe, it, expect } from 'vitest';
import {
  coerceFleetDirectoryRecord,
  canonicalFleetRecordJson,
  fleetDirectorySignedBytes,
  parseFleetRecordJson,
  fleetDirFedKey,
  DEFAULT_FLEET_BILLING,
  FLEET_DIRECTORY_SIG_DOMAIN,
} from './fleet-directory-schema';

const minimal = {
  fleetSlug: 'my-fleet',
  ownerGithubUserId: 279242982,
  title: 'My fleet',
  description: 'A fleet',
  recordVersion: 1,
  archived: false,
};

describe('coerceFleetDirectoryRecord', () => {
  it('accepts a minimal record and populates every optional (stable canonical form)', () => {
    const r = coerceFleetDirectoryRecord(minimal);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.tags).toEqual([]);
    expect(r.record.publisherGithubUserIds).toEqual([]);
    expect(r.record.billingDefault).toBe(DEFAULT_FLEET_BILLING);
    expect(r.record.successorGithubUserId).toBeNull();
    expect(r.record.offerRateCapPerHour).toBeNull();
    expect(r.record.unclaimedOfferTtlSec).toBeNull();
  });

  it('is a CLOSED schema — unknown fields never survive into the signed record', () => {
    const r = coerceFleetDirectoryRecord({ ...minimal, sneaky: 'payload' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('sneaky' in r.record).toBe(false);
  });

  it('rejects malformed identity/security fields', () => {
    expect(coerceFleetDirectoryRecord({ ...minimal, fleetSlug: 'Bad_Slug' }).ok).toBe(false);
    expect(coerceFleetDirectoryRecord({ ...minimal, fleetSlug: '-lead' }).ok).toBe(false);
    expect(coerceFleetDirectoryRecord({ ...minimal, ownerGithubUserId: 'octocat' }).ok).toBe(false); // X9: no logins
    expect(coerceFleetDirectoryRecord({ ...minimal, ownerGithubUserId: 0 }).ok).toBe(false);
    expect(coerceFleetDirectoryRecord({ ...minimal, publisherGithubUserIds: [1, 1] }).ok).toBe(false);
    expect(coerceFleetDirectoryRecord({ ...minimal, publisherGithubUserIds: [1.5] }).ok).toBe(false);
    expect(coerceFleetDirectoryRecord({ ...minimal, recordVersion: 0 }).ok).toBe(false);
    expect(coerceFleetDirectoryRecord({ ...minimal, archived: 'no' }).ok).toBe(false);
    expect(coerceFleetDirectoryRecord({ ...minimal, offerRateCapPerHour: -1 }).ok).toBe(false);
    expect(coerceFleetDirectoryRecord({ ...minimal, unclaimedOfferTtlSec: 1.5 }).ok).toBe(false);
    expect(coerceFleetDirectoryRecord(null).ok).toBe(false);
    expect(coerceFleetDirectoryRecord([minimal]).ok).toBe(false);
  });
});

describe('canonical form + signed bytes', () => {
  it('canonical JSON is key-order independent (JCS-style)', () => {
    const a = coerceFleetDirectoryRecord(minimal);
    const b = coerceFleetDirectoryRecord({
      archived: false,
      recordVersion: 1,
      description: 'A fleet',
      title: 'My fleet',
      ownerGithubUserId: 279242982,
      fleetSlug: 'my-fleet',
    });
    if (!a.ok || !b.ok) throw new Error('coerce failed');
    expect(canonicalFleetRecordJson(a.record)).toBe(canonicalFleetRecordJson(b.record));
  });

  it('signed bytes bind domain + workspace + hive + version (anti-replay)', () => {
    const json = canonicalFleetRecordJson(coerceFleetDirectoryRecord(minimal).ok ? (coerceFleetDirectoryRecord(minimal) as { ok: true; record: never }).record : (undefined as never));
    const base = { workspaceId: 'ws-1', hiveHomeSlug: 'hive-a', recordVersion: 1, canonicalRecordJson: json };
    const bytes = fleetDirectorySignedBytes(base);
    expect(bytes.toString('utf8').startsWith(`${FLEET_DIRECTORY_SIG_DOMAIN}\n`)).toBe(true);
    expect(fleetDirectorySignedBytes({ ...base, workspaceId: 'ws-2' }).equals(bytes)).toBe(false);
    expect(fleetDirectorySignedBytes({ ...base, hiveHomeSlug: 'hive-b' }).equals(bytes)).toBe(false);
    expect(fleetDirectorySignedBytes({ ...base, recordVersion: 2 }).equals(bytes)).toBe(false);
  });

  it('parseFleetRecordJson round-trips canonical json and fails closed on junk', () => {
    const c = coerceFleetDirectoryRecord(minimal);
    if (!c.ok) throw new Error('coerce failed');
    const json = canonicalFleetRecordJson(c.record);
    expect(parseFleetRecordJson(json)).toEqual(c.record);
    expect(parseFleetRecordJson('not json')).toBeNull();
    expect(parseFleetRecordJson('{"fleetSlug":"x"}')).toBeNull();
    expect(parseFleetRecordJson(null)).toBeNull();
    expect(parseFleetRecordJson('')).toBeNull();
  });

  it('fleetDirFedKey mirrors the mig-476 generated column', () => {
    expect(fleetDirFedKey(42, 'my-fleet')).toBe('42/my-fleet');
  });
});
