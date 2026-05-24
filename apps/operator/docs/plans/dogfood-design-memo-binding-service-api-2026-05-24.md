---
title: Papercusp dogfood — design memo — canonical binding service API
slug: dogfood-design-memo-binding-service-api-2026-05-24
status: accepted
accepted_at: 2026-05-24
accepted_by: avi@storewolf.com
created: 2026-05-24
updated: 2026-05-24
owner: avi@storewolf.com
---

# Design memo — canonical binding service API

> Third of three Phase 1b design memos. Sibling memos: `dogfood-design-memo-device-attestation-ux-2026-05-24.md`, `dogfood-design-memo-two-channel-binding-ux-2026-05-24.md`.

## Now

**State:** draft for review. Covers the API shape for the canonical shared-repo binding service (P-068) — the wire format, endpoint semantics, error shapes, permission-verification flow, and how Cupboard (Phase 9) extends the same service.

**Next action:** user reviews; on accept, gets promoted to D-decisions in Phase 1b plan + provides the contract Phase 9 Cupboard server (P-051a) implements against.

## Background

§5.1 of v5 specifies the binding-record shape and lookup/create rules. This memo turns that spec into a concrete API surface: function signatures the operator calls, HTTP endpoints the Cupboard server exposes, error shapes, GitHub-permission verification steps.

The service has two deployments:
- **Embedded in desktop operator** (P-068, Phase 1b): local cache + canonical-id resolver. Calls GitHub directly for resolution + permission checks.
- **Cupboard server** (P-051a/b, Phase 9): same service surface as a public HTTP API. Operators can `PAPERCUSP_CUPBOARD_URL` to point at a different instance (self-host).

The API shape must be the same in both deployments so Cupboard becomes a drop-in for the embedded service when public-listing semantics are needed.

## Design

### BindingRecord — the canonical type

```ts
type BindingRecord = {
  // Identity
  provider: 'github';                       // future: 'gitlab' | 'gitea' for PrHost expansion
  github_repository_id: number;             // GitHub's stable numeric repo id; canonical key
  github_full_name: string;                 // owner/name display string; refreshed on each resolve

  // Harness pointer
  harness_topic: string;                    // 32-byte hex Hyperswarm topic
  harness_slug: string;                     // canonical slug used in registry.json
  harness_link: string;                     // papercusp://harness?topic=<>&github=<>&repo_id=<>

  // Visibility
  privacy: 'shared-private' | 'shared-public';

  // Claim state
  claim_status: 'unclaimed' | 'claimed' | 'stale' | 'superseded';
  provisional_owner_github_user_id: number;
  claimed_by_github_user_ids: number[];     // verified maintainers/admins who have claimed

  // Lifecycle
  created_at: string;                       // ISO 8601
  claimed_at?: string;
  last_permission_verified_at?: string;     // null until first verification
  superseded_by_harness_topic?: string;     // points to the replacement when claim_status='superseded'
};
```

**Why `github_repository_id` (numeric) is canonical**: GitHub's owner/name renames; numeric ids do not. A binding keyed by `owner/name` becomes stale on rename. (Mirror of D-010's reasoning for branch names + D-028's for user profile routes.)

### Service surface — five operations

```ts
interface BindingService {
  /**
   * Resolve a pasted GitHub URL to a canonical record.
   * Network call to GitHub to get the numeric repo id; cached for 24h.
   * Returns null if the repo doesn't exist or is private to the caller.
   */
  resolveRepoBinding(githubUrl: string, actingUserToken: string): Promise<BindingRecord | null>;

  /**
   * Create an unclaimed binding for a GitHub repo that doesn't yet have one.
   * Caller becomes provisional_owner_github_user_id.
   * Throws BINDING_EXISTS if there's already an active binding for this repo.
   */
  createUnclaimedBinding(input: {
    githubUrl: string;
    actingUserToken: string;
    privacy: 'shared-private' | 'shared-public';
    harness_topic: string;
    harness_slug: string;
  }): Promise<BindingRecord>;

  /**
   * Claim an unclaimed (or stale) binding. Requires maintain/admin on the bound repo.
   * Throws CLAIM_PERMISSION_DENIED if caller's permission is insufficient.
   * Throws BINDING_NOT_CLAIMABLE if the binding is already claimed by everyone needed.
   */
  claimBinding(input: {
    binding_id: string;                     // composed of (provider, github_repository_id)
    actingUserToken: string;
  }): Promise<BindingRecord>;

  /**
   * Supersede an unclaimed binding with a new harness topic.
   * Requires admin on the bound repo (stricter than claim).
   * The old binding's claim_status flips to 'superseded' and points at the new one.
   * Throws SUPERSEDE_PERMISSION_DENIED if caller is maintain (not admin).
   */
  supersedeBinding(input: {
    old_binding_id: string;
    new_harness_topic: string;
    new_harness_slug: string;
    actingUserToken: string;
    reason: string;                         // human-readable, recorded on the old binding for audit
  }): Promise<{old: BindingRecord, new: BindingRecord}>;

  /**
   * Background daemon job (P-068f): re-verify every claimant's GitHub permission once per 24h.
   * On revocation of all claimants, flip claim_status to 'stale' and re-enable provisional-owner controls.
   * Returns the list of bindings whose status changed.
   */
  recheckClaimantPermissions(): Promise<Array<{binding_id: string, old_status: string, new_status: string}>>;
}
```

### Error shapes — structured + typed

```ts
type BindingServiceError =
  | { code: 'BINDING_EXISTS', binding: BindingRecord }            // createUnclaimed when one already exists
  | { code: 'BINDING_NOT_FOUND' }                                  // claim/supersede on missing binding
  | { code: 'BINDING_NOT_CLAIMABLE', reason: string }              // already claimed by needed parties
  | { code: 'CLAIM_PERMISSION_DENIED', actual: string, required: string }
  | { code: 'SUPERSEDE_PERMISSION_DENIED', actual: string, required: string }
  | { code: 'GITHUB_REPO_NOT_FOUND' }                              // resolve on a 404
  | { code: 'GITHUB_REPO_PRIVATE_NO_ACCESS' }                      // resolve on a private repo without caller's token having access
  | { code: 'GITHUB_API_RATE_LIMIT', retry_after_ms: number }
  | { code: 'GITHUB_API_DOWN', message: string };
```

Each error gets a clear UI mapping (the operator surfaces them via Phase 8 P-069 claim-CTA + Phase 5a P-029 share-wizard step 2).

### HTTP shape (Cupboard server surface — P-051a)

```
POST /api/binding/resolve
  body: { github_url: string }
  auth: Bearer <github-oauth-token>
  → 200 { binding: BindingRecord | null }
  → 404 { code: 'GITHUB_REPO_NOT_FOUND' }
  → 403 { code: 'GITHUB_REPO_PRIVATE_NO_ACCESS' }
  → 429 { code: 'GITHUB_API_RATE_LIMIT', retry_after_ms }

POST /api/binding/create
  body: { github_url, privacy, harness_topic, harness_slug }
  auth: Bearer <github-oauth-token>
  → 201 { binding: BindingRecord }
  → 409 { code: 'BINDING_EXISTS', binding }

POST /api/binding/claim
  body: { binding_id }
  auth: Bearer <github-oauth-token>
  → 200 { binding: BindingRecord }
  → 403 { code: 'CLAIM_PERMISSION_DENIED', actual, required: 'maintain or admin' }

POST /api/binding/supersede
  body: { old_binding_id, new_harness_topic, new_harness_slug, reason }
  auth: Bearer <github-oauth-token>
  → 200 { old, new }
  → 403 { code: 'SUPERSEDE_PERMISSION_DENIED', actual, required: 'admin' }

GET /api/binding/by-repo/:github_repository_id
  → 200 { binding: BindingRecord | null }                          // public read, no auth required for public listings
  → 404 only if the bound repo is private and caller has no access

GET /api/binding/listings?status=claimed&limit=50&offset=0
  → 200 { bindings: BindingRecord[], total }                       // public listings; Cupboard browse
```

### Permission verification flow

For `claimBinding` and `supersedeBinding`:

1. Service receives request with `actingUserToken` (GitHub OAuth bearer).
2. Service calls `GET https://api.github.com/repos/<owner>/<repo>/collaborators/<github_login>/permission` using the token.
3. Response gives `permission` ∈ `admin | maintain | write | triage | read | none`.
4. For claim: require `maintain` or `admin`. For supersede: require `admin`.
5. On success: write the row (or row update), return the updated binding.
6. On insufficient permission: return the typed error with `actual` permission so UI can explain what's missing.

**Why this works**: GitHub's permission API is the canonical source. The service doesn't maintain its own permission cache for this check — it's the live truth at claim-time. Cached re-verification (P-068f daemon) runs at 24h cadence; one-shot live check on the claim action.

**Rate limit consideration**: each claim attempt uses one GitHub API call. The 5000/hr authenticated limit gives 5000 claim attempts per token per hour — comfortable.

### Embedded vs Cupboard service — what differs

The embedded operator service implements all five operations against local PG (`shared_repo_binding_cache` LOCAL table from Phase 1a P-013a) + live GitHub calls. The Cupboard server implements them against its public PG.

The only public-listing-specific concern: `GET /api/binding/listings` is meaningful on Cupboard (browsable listings), not embedded (the user has 1 active workspace, not "browse all known bindings"). The embedded service can return an empty list for `listings` or simply not expose that endpoint.

`PAPERCUSP_CUPBOARD_URL` env switches the operator from "use embedded service" to "use remote service via HTTP." When set, all binding operations route through the Cupboard server; the embedded local cache becomes a read-through cache to avoid every operation hitting the network.

### Caching semantics

- `resolveRepoBinding` results cached for 24h keyed on `github_repository_id`.
- `BindingRecord` rows cached indefinitely until next state-change operation invalidates.
- Permission verifications cached for 24h per `(binding_id, github_user_id)` for the read path (display "I can claim" / "I can't claim"); NEVER cached for the write path (claim/supersede always re-verify live).

## Decisions (proposed)

### D-A — Service surface is the same in embedded + Cupboard deployments

The only meaningfully-different surface is `GET /api/binding/listings` — public-only. Other four ops behave identically locally vs remote.

### D-B — `github_repository_id` (numeric) is the canonical key

Owner/name is display + identifier-on-paste-time. Numeric id is what the binding hangs on, like branch names (D-010) and user profile routes (D-028).

### D-C — Live GitHub permission check at claim-time + 24h re-verification

No cache on the write path. Cache for read-display purposes only.

### D-D — Typed structured errors, not free-text

UI maps error codes to user-actionable copy. Free-text errors are for the implementer to log, not for the user to see.

### D-E — `supersedeBinding` requires admin (stricter than claim)

Supersede is destructive — orphans the previous unclaimed harness's contributors with a migration banner. Admin-only matches GitHub's permission model for destructive repo operations.

## Open questions

### Q-1 — Should `superseded_by_harness_topic` chain (supersede a superseded binding) or stop at depth 1?

Probably stop at depth 1 — chained supersedes are unlikely + chains make migration banners confusing. If admin wants to supersede a superseded one, they're effectively forking a third time; they can do that by claiming the current canonical binding and supersede it. Confirm before P-068 ships.

### Q-2 — What's the audit story for claim + supersede actions?

Suggested: each operation writes a row to a `binding_audit` table (LOCAL on embedded, public on Cupboard). Schema: `(binding_id, action, actor_github_user_id, ts, reason)`. Useful for "who claimed this and when" historical queries.

### Q-3 — Self-host migration story

If the dogfood team starts on `cupboard.papercusp.dev` and later wants to migrate to a self-hosted Cupboard, how do bindings transfer? Probably: `pg_dump` from the public instance + restore to the self-hosted instance; users repoint `PAPERCUSP_CUPBOARD_URL`. Document in Phase 9 P-051b's deployment docs.

## Cross-references

- `papercusp-dogfood-phase1b-oauth-clone-attestation-2026-05-24.md` — implements via P-068.
- `papercusp-dogfood-phase9-cupboard-discord-sync-2026-05-24.md` — extends via P-051a.
- v5 §5.1 (binding spec), §10 (Cupboard), D-026 (one binding per repo id), addendum 1 (claim/supersede authority).

## For the implementing agent

When P-068 implementation begins:
- This memo's interface becomes `apps/operator/lib/harness/binding-service.ts`.
- The error type becomes a shared union exported from `apps/operator/lib/harness/binding-types.ts`.
- The schema for `shared_repo_binding_cache` (Phase 1a P-013a) follows the `BindingRecord` shape verbatim — primary key `(provider, github_repository_id)`, columns map 1:1.
- When P-051a (Cupboard server) starts, copy the interface into `apps/operator-public/lib/binding-service.ts` and re-export with the HTTP-handler wiring.
- Convert this memo to `apps/operator/content/internal-docs/design/dogfood-binding-service-api.mdx` and promote D-A through D-E to Phase 1b's plan.
