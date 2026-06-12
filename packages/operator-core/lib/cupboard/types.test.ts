import { describe, expect, it } from 'vitest';
import {
  CLAIM_REQUIRED_PERMISSIONS,
  CUPBOARD_CLAIM_STATUSES,
  CUPBOARD_ERROR_KINDS,
  CUPBOARD_GITHUB_PERMISSIONS,
  CUPBOARD_SCHEMA_VERSION,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  PUBLISH_RATE_LIMIT_PER_HOUR,
  PUBLISH_RATE_LIMIT_WINDOW_MS,
  SUPERSEDE_REQUIRED_PERMISSIONS,
  canClaim,
  canRepublish,
  canSupersede,
  err,
  groupHarnessRowsByHive,
  groupListingsByKind,
  isHarnessListing,
  isHivePubkeyRef,
  isPubliclyVisible,
  listingHiveKey,
  listingHiveRef,
  ok,
  type CupboardError,
  type HarnessListing,
} from './types';

function makeListing(over: Partial<HarnessListing> = {}): HarnessListing {
  return {
    id: 1,
    slug: 'papercup',
    title: 'Papercup',
    description: 'A test harness',
    harness_link:
      'papercusp://harness?topic=' + '0'.repeat(64) + '&github=papercup-ai/papercup&repo_id=123',
    github_repository_id: 123,
    github_repo: 'papercup-ai/papercup',
    github_repo_must_be_public: true,
    published_by_github_user_id: 12345,
    provisional_owner_github_user_id: 12345,
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

describe('constants', () => {
  it('CUPBOARD_SCHEMA_VERSION is 1', () => {
    expect(CUPBOARD_SCHEMA_VERSION).toBe(1);
  });

  it('CUPBOARD_CLAIM_STATUSES matches v5 §10.2 CHECK', () => {
    expect([...CUPBOARD_CLAIM_STATUSES]).toEqual([
      'unclaimed',
      'claimed',
      'stale',
      'superseded',
    ]);
  });

  it('CUPBOARD_GITHUB_PERMISSIONS has the 5-rung ladder', () => {
    expect([...CUPBOARD_GITHUB_PERMISSIONS]).toEqual([
      'pull',
      'triage',
      'push',
      'maintain',
      'admin',
    ]);
  });

  it('CLAIM_REQUIRED_PERMISSIONS = maintain + admin per v5 §10.3', () => {
    expect(CLAIM_REQUIRED_PERMISSIONS.has('maintain')).toBe(true);
    expect(CLAIM_REQUIRED_PERMISSIONS.has('admin')).toBe(true);
    expect(CLAIM_REQUIRED_PERMISSIONS.has('push')).toBe(false);
    expect(CLAIM_REQUIRED_PERMISSIONS.has('pull')).toBe(false);
  });

  it('SUPERSEDE_REQUIRED_PERMISSIONS = admin only', () => {
    expect(SUPERSEDE_REQUIRED_PERMISSIONS.has('admin')).toBe(true);
    expect(SUPERSEDE_REQUIRED_PERMISSIONS.has('maintain')).toBe(false);
  });

  it('CUPBOARD_ERROR_KINDS enumerates all 11 wire errors', () => {
    expect(CUPBOARD_ERROR_KINDS.length).toBe(11);
    expect([...CUPBOARD_ERROR_KINDS]).toContain('conflict_repo_already_bound');
    expect([...CUPBOARD_ERROR_KINDS]).toContain('private_repo_not_publishable');
    expect([...CUPBOARD_ERROR_KINDS]).toContain('forbidden_insufficient_permission');
  });

  it('rate-limit constants match v5 §10.3 spec', () => {
    expect(PUBLISH_RATE_LIMIT_PER_HOUR).toBe(5);
    expect(PUBLISH_RATE_LIMIT_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  it('list-endpoint caps', () => {
    expect(LIST_DEFAULT_LIMIT).toBe(25);
    expect(LIST_MAX_LIMIT).toBe(100);
    expect(LIST_DEFAULT_LIMIT).toBeLessThanOrEqual(LIST_MAX_LIMIT);
  });
});

describe('ok / err', () => {
  it('ok wraps a data result', () => {
    const r = ok({ id: 1 });
    expect(r.ok).toBe(true);
    expect(r.ok && r.data).toEqual({ id: 1 });
  });

  it('err wraps an error result', () => {
    const e: CupboardError = { kind: 'not_found', message: 'gone' };
    const r = err(e);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toEqual(e);
  });
});

describe('isPubliclyVisible', () => {
  it('returns true for unclaimed + claimed', () => {
    expect(isPubliclyVisible(makeListing({ claim_status: 'unclaimed' }))).toBe(true);
    expect(isPubliclyVisible(makeListing({ claim_status: 'claimed' }))).toBe(true);
  });

  it('returns false for superseded + stale', () => {
    expect(isPubliclyVisible(makeListing({ claim_status: 'superseded' }))).toBe(false);
    expect(isPubliclyVisible(makeListing({ claim_status: 'stale' }))).toBe(false);
  });
});

describe('canClaim', () => {
  it('true for maintain + admin', () => {
    expect(canClaim('maintain')).toBe(true);
    expect(canClaim('admin')).toBe(true);
  });

  it('false for lower ladder', () => {
    expect(canClaim('push')).toBe(false);
    expect(canClaim('triage')).toBe(false);
    expect(canClaim('pull')).toBe(false);
  });
});

describe('canSupersede', () => {
  it('true only for admin', () => {
    expect(canSupersede('admin')).toBe(true);
    expect(canSupersede('maintain')).toBe(false);
    expect(canSupersede('push')).toBe(false);
  });
});

describe('canRepublish', () => {
  it('true for unclaimed + claimed', () => {
    expect(canRepublish(makeListing({ claim_status: 'unclaimed' }))).toBe(true);
    expect(canRepublish(makeListing({ claim_status: 'claimed' }))).toBe(true);
  });

  it('false for superseded + stale (need supersede first)', () => {
    expect(canRepublish(makeListing({ claim_status: 'superseded' }))).toBe(false);
    expect(canRepublish(makeListing({ claim_status: 'stale' }))).toBe(false);
  });
});

describe('isHarnessListing', () => {
  it('accepts a well-formed listing', () => {
    expect(isHarnessListing(makeListing())).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(isHarnessListing(null)).toBe(false);
    expect(isHarnessListing('not a listing')).toBe(false);
    expect(isHarnessListing(42)).toBe(false);
  });

  it('rejects missing/empty required strings', () => {
    expect(isHarnessListing(makeListing({ slug: '' }))).toBe(false);
    expect(isHarnessListing(makeListing({ harness_link: '' }))).toBe(false);
    expect(isHarnessListing(makeListing({ github_repo: '' }))).toBe(false);
  });

  it('rejects invalid claim_status', () => {
    expect(
      isHarnessListing({ ...makeListing(), claim_status: 'pending' }),
    ).toBe(false);
  });

  it('rejects non-positive github_repository_id', () => {
    expect(isHarnessListing(makeListing({ github_repository_id: 0 }))).toBe(false);
    expect(isHarnessListing(makeListing({ github_repository_id: -1 }))).toBe(false);
  });

  it('rejects non-integer id', () => {
    expect(isHarnessListing(makeListing({ id: 1.5 }))).toBe(false);
  });

  it('rejects negative contributor_count_estimate', () => {
    expect(isHarnessListing(makeListing({ contributor_count_estimate: -1 }))).toBe(false);
  });

  it('accepts null for nullable fields', () => {
    expect(
      isHarnessListing(
        makeListing({
          claimed_at: null,
          last_permission_verified_at: null,
          superseded_by_harness_id: null,
          last_activity_at: null,
          language: null,
        }),
      ),
    ).toBe(true);
  });

  it('rejects non-array tags', () => {
    expect(
      isHarnessListing({ ...makeListing(), tags: 'not-an-array' }),
    ).toBe(false);
  });

  it('accepts empty title/description (server-side validation may reject; types do not)', () => {
    // Empty title is unusual but not type-invalid — the predicate is
    // shape-only. Server-side validation rejects on POST.
    expect(isHarnessListing(makeListing({ title: '' }))).toBe(true);
    expect(isHarnessListing(makeListing({ description: '' }))).toBe(true);
  });

  it('rejects extra-typed fields that should be number→string conversion', () => {
    expect(
      isHarnessListing({ ...makeListing(), claimed_at: '2026-01-01' }),
    ).toBe(false);
    expect(
      isHarnessListing({ ...makeListing(), last_activity_at: '2026-01-01' }),
    ).toBe(false);
  });
});

describe('repo→Hive binding fields (migration 007 / hive-from-github-url D-004 HYBRID)', () => {
  // Raw 32-byte Ed25519 pubkey, base64 — the hive directory announce encoding.
  const HIVE_PUBKEY = 'A'.repeat(43) + '=';

  it('isHarnessListing accepts a listing WITH hive fields', () => {
    expect(
      isHarnessListing(makeListing({ hive_pubkey: HIVE_PUBKEY, hive_title: 'Demo Hive' })),
    ).toBe(true);
  });

  it('isHarnessListing accepts hive fields as null (worker rows without a hive)', () => {
    expect(isHarnessListing(makeListing({ hive_pubkey: null, hive_title: null }))).toBe(true);
  });

  it('isHarnessListing accepts hive fields ABSENT (pre-007 servers omit them)', () => {
    const l = makeListing();
    expect('hive_pubkey' in l).toBe(false);
    expect(isHarnessListing(l)).toBe(true);
  });

  it('isHarnessListing rejects non-string hive fields', () => {
    expect(isHarnessListing({ ...makeListing(), hive_pubkey: 42 })).toBe(false);
    expect(isHarnessListing({ ...makeListing(), hive_title: ['x'] })).toBe(false);
  });

  it('round-trips through JSON with hive fields intact (wire shape)', () => {
    const listing = makeListing({ hive_pubkey: HIVE_PUBKEY, hive_title: 'Demo Hive' });
    const parsed = JSON.parse(JSON.stringify(listing)) as unknown;
    expect(isHarnessListing(parsed)).toBe(true);
    const round = parsed as HarnessListing;
    expect(round.hive_pubkey).toBe(HIVE_PUBKEY);
    expect(round.hive_title).toBe('Demo Hive');
  });

  it('all member-repo rows of one hive share the pubkey (one row per member repo)', () => {
    const rows = [
      makeListing({ id: 1, github_repository_id: 100, hive_pubkey: HIVE_PUBKEY, hive_title: 'Demo Hive' }),
      makeListing({ id: 2, github_repository_id: 200, hive_pubkey: HIVE_PUBKEY, hive_title: 'Demo Hive' }),
    ];
    expect(rows.every(isHarnessListing)).toBe(true);
    expect(new Set(rows.map((r) => r.hive_pubkey)).size).toBe(1);
    expect(new Set(rows.map((r) => r.github_repository_id)).size).toBe(2);
  });
});

describe('listingHiveRef (per-Hive grouping key, D-005)', () => {
  it('prefers the explicit project_ref', () => {
    expect(listingHiveRef(makeListing({ project_ref: 'papercupai/demo' }))).toBe('papercupai/demo');
  });

  it('falls back to the repo slug when project_ref is absent (legacy row)', () => {
    expect(listingHiveRef(makeListing({ project_ref: undefined }))).toBe('papercup-ai/papercup');
  });

  it('falls back to the repo slug when project_ref is null', () => {
    expect(listingHiveRef(makeListing({ project_ref: null }))).toBe('papercup-ai/papercup');
  });

  it('derives the repo slug from worker owner/name fields when github_repo is absent', () => {
    expect(
      listingHiveRef(
        makeListing({ project_ref: null, github_repo: '', github_owner: 'acme', github_name: 'widget' }),
      ),
    ).toBe('acme/widget');
  });

  it("returns '' (ungroupable) when there is no project identity at all", () => {
    expect(
      listingHiveRef(makeListing({ project_ref: null, github_repo: '', github_owner: undefined, github_name: undefined })),
    ).toBe('');
  });
});

describe('groupListingsByKind (per-Hive rollup, D-005)', () => {
  it('groups by kind in canonical LISTING_KINDS order', () => {
    const groups = groupListingsByKind([
      makeListing({ id: 1, listing_kind: 'plugin' }),
      makeListing({ id: 2, listing_kind: 'harness' }),
      makeListing({ id: 3, listing_kind: 'tool-pack' }),
      makeListing({ id: 4, listing_kind: 'blueprint' }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['harness', 'blueprint', 'plugin', 'tool-pack']);
  });

  it('drops empty kinds', () => {
    const groups = groupListingsByKind([
      makeListing({ id: 1, listing_kind: 'blueprint' }),
      makeListing({ id: 2, listing_kind: 'tool-pack' }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['blueprint', 'tool-pack']);
  });

  it('keeps every listing within its kind group', () => {
    const groups = groupListingsByKind([
      makeListing({ id: 1, listing_kind: 'tool-pack' }),
      makeListing({ id: 2, listing_kind: 'tool-pack' }),
      makeListing({ id: 3, listing_kind: 'blueprint' }),
    ]);
    const packs = groups.find((g) => g.kind === 'tool-pack');
    expect(packs?.listings.map((l) => l.id)).toEqual([1, 2]);
  });

  it('treats an absent listing_kind as harness', () => {
    const groups = groupListingsByKind([makeListing({ id: 1, listing_kind: undefined })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('harness');
  });

  it('returns [] for no listings', () => {
    expect(groupListingsByKind([])).toEqual([]);
  });
});

describe('listingHiveKey + isHivePubkeyRef (hive-native rollup key, comb-hive-native-sharing P-001/P-002)', () => {
  const PUBKEY = 'A'.repeat(43) + '=';

  it('hive-bound rows key by hive_pubkey (member rows share it; project_ref does not exist on them)', () => {
    expect(listingHiveKey(makeListing({ hive_pubkey: PUBKEY }))).toBe(PUBKEY);
  });

  it('legacy rows fall back to listingHiveRef', () => {
    expect(listingHiveKey(makeListing({ project_ref: 'papercupai/demo' }))).toBe('papercupai/demo');
    expect(listingHiveKey(makeListing())).toBe('papercup-ai/papercup');
  });

  it('isHivePubkeyRef accepts the raw-32-byte base64 announce encoding only', () => {
    expect(isHivePubkeyRef(PUBKEY)).toBe(true);
    expect(isHivePubkeyRef('papercupai/demo')).toBe(false); // project ref
    expect(isHivePubkeyRef('owner/repo')).toBe(false); // repo slug
    expect(isHivePubkeyRef('')).toBe(false);
    expect(isHivePubkeyRef('A'.repeat(44))).toBe(false); // no pad ⇒ not 32 bytes
    expect(isHivePubkeyRef('A'.repeat(43))).toBe(false);
  });
});

describe('groupHarnessRowsByHive (hive-first browse, comb-hive-native-sharing P-002)', () => {
  const HIVE_A = 'A'.repeat(43) + '=';
  const HIVE_B = 'B'.repeat(43) + '=';

  it('folds member rows into one group per hive, carrying title + claim rollup', () => {
    const rows = [
      makeListing({ id: 1, hive_pubkey: HIVE_A, hive_title: 'Hive A', claim_status: 'claimed' }),
      makeListing({ id: 2, hive_pubkey: HIVE_A, github_repo: 'o/r2' }),
      makeListing({ id: 3, hive_pubkey: HIVE_B, hive_title: 'Hive B' }),
    ];
    const { hives, legacy } = groupHarnessRowsByHive(rows);
    expect(legacy).toEqual([]);
    expect(hives).toHaveLength(2);
    const a = hives.find((h) => h.hivePubkey === HIVE_A)!;
    expect(a.hiveTitle).toBe('Hive A');
    expect(a.members.map((m) => m.id)).toEqual([1, 2]);
    expect(a.claimedCount).toBe(1);
    expect(hives.find((h) => h.hivePubkey === HIVE_B)!.members).toHaveLength(1);
  });

  it('rows with no hive_pubkey are legacy (pre-hive) listings', () => {
    const rows = [makeListing({ id: 1 }), makeListing({ id: 2, hive_pubkey: HIVE_A })];
    const { hives, legacy } = groupHarnessRowsByHive(rows);
    expect(legacy.map((l) => l.id)).toEqual([1]);
    expect(hives).toHaveLength(1);
  });

  it('ignores non-harness rows (callers pre-split by kind)', () => {
    const rows = [makeListing({ listing_kind: 'blueprint', hive_pubkey: HIVE_A })];
    expect(groupHarnessRowsByHive(rows)).toEqual({ hives: [], legacy: [] });
  });

  it('first title wins when member rows disagree (announce stays authority)', () => {
    const rows = [
      makeListing({ id: 1, hive_pubkey: HIVE_A, hive_title: null }),
      makeListing({ id: 2, hive_pubkey: HIVE_A, hive_title: 'Late title' }),
    ];
    expect(groupHarnessRowsByHive(rows).hives[0].hiveTitle).toBe('Late title');
  });
});
