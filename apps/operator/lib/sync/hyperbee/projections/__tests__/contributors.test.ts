/**
 * Contributors projection — pure-helper tests.
 *
 * The PG writers are covered by the broader integration suite
 * (`apps/operator/lib/llm-testing/...`). Here we exercise the
 * decoder + key composer in isolation, plus the projection-shape
 * registration contract.
 */

import { describe, expect, it } from 'vitest';
import { buildContributorsProjection, _testing } from '../contributors';
import type { ContributorRow } from '../../../../harness/contributor-row-types';

function row(): ContributorRow {
  return {
    harness_slug: 'sheets',
    github_user_id: 12345,
    github_username: 'alice',
    display_name: 'Alice',
    avatar_url: 'https://avatars.githubusercontent.com/u/12345',
    device_attestations: [],
    revoked_pubkeys: [],
    joined_at: 1700000000000,
    last_seen_at: 1700001000000,
    binding_status: 'verified',
    channel1_verified_at: 1700000500000,
    channel2_verified_at: 1700000800000,
    channel2_branch_ref: 'user/12345',
    binding_last_checked_at: 1700001000000,
    schema_version: 1,
  };
}

describe('contributors projection', () => {
  describe('composeKey', () => {
    it('returns the github_user_id as a string', () => {
      expect(_testing.composeKey(row())).toBe('12345');
    });
  });

  describe('decodeValue', () => {
    it('returns the row when shape is valid', () => {
      const r = row();
      expect(_testing.decodeValue(r)).toEqual(r);
    });

    it('returns null for malformed input', () => {
      expect(_testing.decodeValue({})).toBeNull();
      expect(_testing.decodeValue(null)).toBeNull();
      expect(_testing.decodeValue('not an object')).toBeNull();
    });

    it('returns null when device_attestations is not an array', () => {
      const bad = { ...row(), device_attestations: 'wrong' };
      expect(_testing.decodeValue(bad)).toBeNull();
    });

    it('returns null when binding_status is unknown', () => {
      const bad = { ...row(), binding_status: 'unknown-state' };
      expect(_testing.decodeValue(bad)).toBeNull();
    });

    it('returns null when github_user_id is non-integer', () => {
      const bad = { ...row(), github_user_id: 12.5 };
      expect(_testing.decodeValue(bad)).toBeNull();
    });
  });

  describe('buildContributorsProjection', () => {
    it('exposes the tableTag matching hyperbee-key-types', () => {
      const p = buildContributorsProjection({ workspaceId: 'w1', harnessSlug: 'sheets' });
      expect(p.tableTag).toBe('contributors');
    });

    it('returns the same composeKey closure', () => {
      const p = buildContributorsProjection({ workspaceId: 'w1', harnessSlug: 'sheets' });
      expect(p.composeKey(row())).toBe('12345');
    });

    it('returns the same decodeValue closure', () => {
      const p = buildContributorsProjection({ workspaceId: 'w1', harnessSlug: 'sheets' });
      expect(p.decodeValue(row())).toEqual(row());
      expect(p.decodeValue({})).toBeNull();
    });
  });
});
