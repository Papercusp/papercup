/**
 * The listing→action mapping (revive-cupboard-distribution-2026-06-04 D-005,
 * reframed by comb-retire-per-harness-sharing-2026-06-11 D-001/D-003).
 * `types.test.ts` covers the predicates around it (isHarnessListing,
 * groupListingsByKind, listingHiveRef) but never asserts `listingActionFor`,
 * `isListingKind`, or `listingKindOf` directly — yet these drive the
 * storefront's per-listing action button and the default-to-harness fallback
 * for pre-004 rows. This pins them.
 *
 *   harness + hive_pubkey → view-hive   (the repo→Hive lookup row, mig 007)
 *   harness, no hive      → null        (legacy row — per-harness join retired)
 *   blueprint             → fork
 *   plugin                → install
 *   pack                  → install     (migration 006 / tool-distribution-granularity D-001)
 *
 * Pure functions, no mocks.
 */
import { describe, it, expect } from 'vitest';
import {
  LISTING_KINDS,
  LISTING_ACTION_LABEL,
  isListingKind,
  listingActionFor,
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

describe('listingActionFor (row → consumer verb, comb-retire D-001/D-003)', () => {
  it('hive-bound harness row → view-hive (the repo→Hive lookup index)', () => {
    expect(
      listingActionFor(makeListing({ listing_kind: 'harness', hive_pubkey: 'A'.repeat(43) + '=' })),
    ).toBe('view-hive');
  });
  it('legacy harness row (no hive_pubkey) → null (per-harness join is retired)', () => {
    expect(listingActionFor(makeListing({ listing_kind: 'harness' }))).toBeNull();
    expect(listingActionFor(makeListing({ listing_kind: 'harness', hive_pubkey: null }))).toBeNull();
  });
  it('blueprint → fork', () => {
    expect(listingActionFor(makeListing({ listing_kind: 'blueprint' }))).toBe('fork');
  });
  it('plugin → install', () => {
    expect(listingActionFor(makeListing({ listing_kind: 'plugin' }))).toBe('install');
  });
  it('pack → install (a runtime-less code-tool pack installs like a plugin)', () => {
    expect(listingActionFor(makeListing({ listing_kind: 'pack' }))).toBe('install');
  });

  it('maps every declared kind to a labelled action or null (no kind falls through)', () => {
    for (const kind of LISTING_KINDS) {
      const action = listingActionFor(makeListing({ listing_kind: kind, hive_pubkey: 'k' }));
      expect(['view-hive', 'fork', 'install']).toContain(action);
      // and the action has a human label for the button
      expect(typeof LISTING_ACTION_LABEL[action!]).toBe('string');
      expect(LISTING_ACTION_LABEL[action!].length).toBeGreaterThan(0);
    }
  });

  it('the label map is action-complete (View Hive/Fork/Install)', () => {
    expect(LISTING_ACTION_LABEL['view-hive']).toBe('View Hive');
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
  });

  it('defaults an ABSENT listing_kind to harness (pre-004 / aspirational row)', () => {
    expect(listingKindOf(makeListing({ listing_kind: undefined }))).toBe('harness');
  });

  it('defaults an INVALID listing_kind to harness (forward-compat / corrupt row)', () => {
    expect(listingKindOf(makeListing({ listing_kind: 'recipe' as unknown as ListingKind }))).toBe('harness');
    expect(listingKindOf(makeListing({ listing_kind: '' as unknown as ListingKind }))).toBe('harness');
  });

  it('round-trips: a default/legacy row resolves kind harness and has NO primary action', () => {
    expect(listingActionFor(makeListing({ listing_kind: undefined }))).toBeNull();
    expect(listingActionFor(makeListing({ listing_kind: 'plugin' }))).toBe('install');
  });
});
