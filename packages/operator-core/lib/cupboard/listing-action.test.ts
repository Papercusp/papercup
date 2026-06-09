/**
 * The listing kind→action mapping (revive-cupboard-distribution-2026-06-04
 * D-005). `types.test.ts` covers the predicates around it (isHarnessListing,
 * groupListingsByKind, listingHiveRef) but NEVER asserts `listingAction`,
 * `isListingKind`, or `listingKindOf` directly — yet these three drive the
 * storefront's per-kind action button (Join / Fork / Install) and the
 * default-to-harness fallback for pre-004 rows. This pins them.
 *
 *   harness   → join
 *   blueprint → fork
 *   snapshot  → fork
 *   plugin    → install
 *   pack      → install   (migration 006 / tool-distribution-granularity D-001)
 *
 * Pure functions, no mocks.
 */
import { describe, it, expect } from 'vitest';
import {
  LISTING_KINDS,
  LISTING_ACTION_LABEL,
  isListingKind,
  listingAction,
  listingKindOf,
  type HarnessListing,
  type ListingKind,
} from './types';

function makeListing(over: Partial<HarnessListing> = {}): HarnessListing {
  return {
    id: 1,
    slug: 'papercup',
    title: 'Papercup',
    description: 'A test listing',
    harness_link: 'papercusp://harness?topic=' + '0'.repeat(64) + '&github=acme/widget&repo_id=1',
    github_repository_id: 1,
    github_repo: 'acme/widget',
    github_repo_must_be_public: true,
    published_by_github_user_id: 1,
    provisional_owner_github_user_id: 1,
    claim_status: 'unclaimed',
    claimed_at: null,
    last_permission_verified_at: null,
    superseded_by_harness_id: null,
    contributor_count_estimate: 1,
    last_activity_at: null,
    language: null,
    tags: [],
    created_at: 1716_000_000_000,
    updated_at: 1716_000_000_000,
    ...over,
  };
}

describe('listingAction (kind → consumer verb, D-005)', () => {
  it('harness → join', () => {
    expect(listingAction('harness')).toBe('join');
  });
  it('blueprint → fork', () => {
    expect(listingAction('blueprint')).toBe('fork');
  });
  // ('snapshot → fork' removed — the snapshot kind was retired by
  // retire-snapshots-instance-spec-2026-06-09 D-005.)
  it('plugin → install', () => {
    expect(listingAction('plugin')).toBe('install');
  });
  it('pack → install (a runtime-less code-tool pack installs like a plugin)', () => {
    expect(listingAction('pack')).toBe('install');
  });

  it('maps every declared kind to a labelled action (no kind falls through)', () => {
    for (const kind of LISTING_KINDS) {
      const action = listingAction(kind);
      expect(['join', 'fork', 'install']).toContain(action);
      // and the action has a human label for the button
      expect(typeof LISTING_ACTION_LABEL[action]).toBe('string');
      expect(LISTING_ACTION_LABEL[action].length).toBeGreaterThan(0);
    }
  });

  it('the label map is action-complete (Join/Fork/Install)', () => {
    expect(LISTING_ACTION_LABEL.join).toBe('Join');
    expect(LISTING_ACTION_LABEL.fork).toBe('Fork');
    expect(LISTING_ACTION_LABEL.install).toBe('Install');
  });
});

describe('isListingKind', () => {
  it('accepts each canonical kind', () => {
    for (const kind of LISTING_KINDS) {
      expect(isListingKind(kind)).toBe(true);
    }
  });

  it('rejects an unknown string', () => {
    expect(isListingKind('recipe')).toBe(false);
    expect(isListingKind('')).toBe(false);
    expect(isListingKind('HARNESS')).toBe(false); // case-sensitive
  });

  it('rejects non-string input', () => {
    expect(isListingKind(null)).toBe(false);
    expect(isListingKind(undefined)).toBe(false);
    expect(isListingKind(42)).toBe(false);
    expect(isListingKind({ kind: 'plugin' })).toBe(false);
  });
});

describe('listingKindOf (row → kind, defaulting to harness)', () => {
  it('reads an explicit valid listing_kind', () => {
    expect(listingKindOf(makeListing({ listing_kind: 'plugin' }))).toBe('plugin');
    expect(listingKindOf(makeListing({ listing_kind: 'pack' }))).toBe('pack');
    expect(listingKindOf(makeListing({ listing_kind: 'blueprint' }))).toBe('blueprint');
    expect(listingKindOf(makeListing({ listing_kind: 'harness' }))).toBe('harness');
    expect(listingKindOf(makeListing({ listing_kind: 'pack' }))).toBe('pack');
  });

  it('defaults an ABSENT listing_kind to harness (pre-004 / aspirational row)', () => {
    expect(listingKindOf(makeListing({ listing_kind: undefined }))).toBe('harness');
  });

  it('defaults an INVALID listing_kind to harness (forward-compat / corrupt row)', () => {
    expect(listingKindOf(makeListing({ listing_kind: 'recipe' as unknown as ListingKind }))).toBe('harness');
    expect(listingKindOf(makeListing({ listing_kind: '' as unknown as ListingKind }))).toBe('harness');
  });

  it('round-trips: listingAction(listingKindOf(row)) is join for a default/legacy row', () => {
    expect(listingAction(listingKindOf(makeListing({ listing_kind: undefined })))).toBe('join');
    expect(listingAction(listingKindOf(makeListing({ listing_kind: 'plugin' })))).toBe('install');
  });
});
