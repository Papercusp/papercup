/**
 * presence hive_slug data-model carry (shared-hive-federation-2026-06-08
 * P-008/P-009): the presence row + the announce builders carry the harness's
 * home Hive slug so the per-Hive lock authority can scope by Hive
 * (lockAuthorityForHive's `WHERE hive_slug=?`, mig 187). The PUBLISHER wiring
 * (resolving potHomeSlugForHarness at the announce loop) is separate; this
 * covers the additive, back-compat data-model carry only.
 */
import { describe, expect, it } from 'vitest';
import { buildPresenceAnnounceRow, buildPresenceAnnounceOp, type PresenceIdentity, type PresenceState } from '../presence-announce';
import { isSharedPresenceRow, type SharedPresenceRow } from '../projections/presence';

const identity: PresenceIdentity = { githubUserId: 42, machineLabel: 'laptop', devicePubkey: 'pk-abc' };
const state: PresenceState = { intent: 'reviewing', currentView: '/adv', harnessSlug: 'acme-rd' };

describe('buildPresenceAnnounceRow — hive_slug carry', () => {
  it('defaults hive_slug to null when no potSlug is passed (non-Hive / unwired)', () => {
    const row = buildPresenceAnnounceRow(identity, state, 1_000);
    expect(row.hive_slug).toBeNull();
    expect(row.harness_slug).toBe('acme-rd');
  });

  it('stamps the resolved hive home slug when passed', () => {
    const row = buildPresenceAnnounceRow(identity, state, 1_000, 'acme');
    expect(row.hive_slug).toBe('acme');
  });

  it('threads hive_slug through buildPresenceAnnounceOp into the op value', () => {
    const op = buildPresenceAnnounceOp(identity, state, 1_000, 'acme');
    expect(op.table).toBe('presence');
    expect((op.value as SharedPresenceRow).hive_slug).toBe('acme');
    // The op value is a valid presence row.
    expect(isSharedPresenceRow(op.value)).toBe(true);
  });
});

describe('isSharedPresenceRow — hive_slug tolerance (back-compat)', () => {
  const base: Record<string, unknown> = {
    harness_slug: 'acme-rd',
    github_user_id: 42,
    machine_label: 'laptop',
    device_pubkey: 'pk-abc',
    intent: null,
    current_view: null,
    last_seen_at: 1_000,
    schema_version: 1,
  };

  it('accepts a row WITHOUT hive_slug (pre-P-008 peer-log rows)', () => {
    expect(isSharedPresenceRow(base)).toBe(true);
  });

  it('accepts hive_slug = null (non-Hive harness)', () => {
    expect(isSharedPresenceRow({ ...base, hive_slug: null })).toBe(true);
  });

  it('accepts hive_slug as a string (Hive member)', () => {
    expect(isSharedPresenceRow({ ...base, hive_slug: 'acme' })).toBe(true);
  });

  it('rejects a non-string, non-null hive_slug', () => {
    expect(isSharedPresenceRow({ ...base, hive_slug: 123 })).toBe(false);
  });
});
