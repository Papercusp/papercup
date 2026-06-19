/**
 * hive-epoch-content-ops.test.ts — pins the read-plane re-key op-SELECTION
 * (shared-hive-rekey-2026-06-19, capture-wire / su-7dcd8).
 *
 * Teeth: the exclude-set IS the contract. Flipping any infra tag to "encrypt"
 * would break a joiner's admission/key fetch (loud); dropping a content tag to
 * "plaintext" would silently leak post-boundary content to a removed peer (the
 * exact C-001 failure). Both are asserted here.
 */
import { describe, expect, it } from 'vitest';
import { REKEY_PLAINTEXT_TAGS, shouldEncryptOpForRekey } from './hive-epoch-content-ops';

// The admission/key/policy infra a peer must read in the clear (must NOT encrypt).
const INFRA_TAGS = [
  'hive-members',
  'hive-settings-by-key',
  'hive-policy',
  'hive-epoch-keys',
  'hive-reports',
  'hive-pending-joins',
] as const;

// The hive CONTENT tags a removed peer must NOT be able to read post-boundary
// (must encrypt). These are the non-infra values of TABLE_NAME_TO_TABLE_TAG
// (feature-issue-op-keys.ts) — kept in sync deliberately.
const CONTENT_TAGS = [
  'features-by-id',
  'issues',
  'engineer-issues',
  'plans-by-slug',
  'coord-conversations',
  'coord-messages',
  'coord-threads',
  'coord-thread-posts',
  'item-assignments',
  'usage',
] as const;

describe('hive-epoch op-selection (read-plane re-key)', () => {
  it('keeps every admission/key/policy infra tag PLAINTEXT (a joiner must read these)', () => {
    for (const tag of INFRA_TAGS) {
      expect(shouldEncryptOpForRekey(tag), `${tag} must stay plaintext`).toBe(false);
      expect(REKEY_PLAINTEXT_TAGS.has(tag)).toBe(true);
    }
  });

  it('ENCRYPTS every hive content tag (the read-cutoff surface)', () => {
    for (const tag of CONTENT_TAGS) {
      expect(shouldEncryptOpForRekey(tag), `${tag} must be encrypted`).toBe(true);
    }
  });

  it('fail-closed-to-security: an unknown / newly-added tag encrypts by default', () => {
    expect(shouldEncryptOpForRekey('some-future-content-tag')).toBe(true);
  });

  it('the plaintext exclude-set is exactly the known infra tags (no drift)', () => {
    expect([...REKEY_PLAINTEXT_TAGS].sort()).toEqual([...INFRA_TAGS].sort());
  });

  it('content and plaintext sets are disjoint', () => {
    for (const tag of CONTENT_TAGS) expect(REKEY_PLAINTEXT_TAGS.has(tag)).toBe(false);
  });
});
