# HANDOFF — Cupboard CF Worker + flag flip (E4 / P-007 + P-008)

**To:** the dogfood-federation / Cupboard owner (the deployed CF Worker
`apps/operator-public` @ `cupboard.papercusp.com` is yours).
**From:** su-8e292 (E4/E5 of `harness-blueprint-distribution-2026-06-03`).
**Status:** prepared + tested locally; **NOT deployed, NO prod flags flipped** —
that's your call (D-005, D-012). This doc is the reviewed handoff.

The operator-side of E4/E5 (proxy, types, UI, marketplace retirement, E5) lands
in the papercup repo separately; this doc is **only** the two outward-facing
pieces: the CF Worker change and the flag flip.

---

## ⟳ UPDATE 2026-06-04 (post-completion) — the whole `revive-cupboard-distribution` plan landed

This handoff originally covered only **E4** (mig 004 + the flag flip). Since then
the companion plan **`revive-cupboard-distribution-2026-06-04`** completed the
snapshot + plugin facets and retired `:3057` — so the **deploy + flag deltas
below supersede §1/§2** where they differ. Integration-verified GREEN by su-2bf2b
(foundation author): CF worker **110 tests + tsc clean**; operator cupboard
surface **110 tests** (11 files); P4 **15** + consent **6** + dep-gate **5**;
retirement barrel integrity clean (0 dangling imports); `libs/flags` tsc clean.

**Two additions to the deploy (still your call — do not let me):**

1. **Migration `005_snapshot_tarball_blob.sql`** — adds the snapshot-tarball blob
   pointer columns (`tarball_r2_key` / `tarball_content_hash` / `tarball_bytes`)
   so a `kind=snapshot` listing references its `.tar.gz` in R2. Apply **after 004**:
   ```bash
   wrangler d1 execute papercusp-cupboard --remote --file migrations/005_snapshot_tarball_blob.sql
   ```
2. **R2 bucket** (new binding `SNAPSHOTS` in `wrangler.toml`) — snapshot tarballs
   live here, content-addressed at `snapshots/<sha256>.tar.gz`, served by the new
   `PUT/GET /blobs/snapshots/:sha` routes (`src/routes/blobs.ts`). Create it
   **once before deploy**:
   ```bash
   wrangler r2 bucket create papercusp-cupboard-snapshots
   ```
   (Binds by name — nothing to paste into `wrangler.toml`; the binding is already declared.)

**Flag delta (supersedes §2):** the `MARKETPLACE` + `TEMPLATES` keys are **now
DELETED from `libs/flags/src/types.ts` + `FLAG_DEFAULTS`** (the retirement landed,
not just "leave off") — so there is **nothing to flip off**; just **delete their
PostHog definitions** if present. `SNAPSHOTS` now **defaults `true` in code**
(`FLAG_DEFAULTS`), so a fresh/offline operator already has it on; the only action
left is to **mirror `papercusp-snapshots`=ON in PostHog** so live evaluation agrees.

**Net remaining outward action:** create the R2 bucket → `wrangler d1 execute … 004 + 005`
→ `npm run deploy` → set `papercusp-snapshots`=ON in PostHog. Everything else (operator
proxy, types, UI, retirement, snapshot/plugin bridges, P4 rollup) is landed + verified in-repo.

---

## 1. CF Worker changes (`apps/operator-public/`)

The Cupboard becomes **one storefront with three listing kinds** (D-005), keyed
**project-centric 1:N** (D-008). All changes are committed to the tree (git-sync);
review the diff under `apps/operator-public/`.

### What changed
- **Migration `migrations/004_listing_kinds_project_centric.sql`** — adds
  `listing_kind` (`harness`|`blueprint`|`snapshot`|`plugin`, default `harness`)
  + `project_ref` + `listing_ref`; makes `topic_hex` nullable (only harness needs
  it); **drops the 1:1 `UNIQUE(github_repository_id)`** and replaces it with
  kind-aware partial unique indexes:
  - `harnesses_active_harness_repo_unique` — one active harness listing per repo
    (preserves the old binding/dedup invariant, for `kind='harness'` only);
  - `harnesses_active_listing_unique` — N distinct non-harness listings per
    project, unique by `(github_repository_id, listing_kind, listing_ref)`.
  It's a **one-shot SQLite table rebuild** (12-step); existing rows are preserved
  verbatim and defaulted to `kind='harness'`. `reports.harness_id` FK stays valid
  (ids unchanged).
- **`src/routes/listings.ts`** (new, replaces `routes/harnesses.ts`) — the
  generalized surface. Registers `/listings*` (kind-aware) AND `/harnesses*`
  (the same handlers pinned to `kind='harness'` — the back-compat view the
  deployed desktop client + operator proxy use today).
- **`src/db.ts`** — row/insert types carry the new columns; `listHarnesses`
  takes a `kind`/`project_ref` filter; `getHarnessByGithubRepoId` is now
  harness-scoped; new `getActiveListingByRefs` for non-harness dedup.
- **`src/routes/index.ts`** — mounts `listingsRoute()`.
- **README + `derivePublisherPermission`** moved to `listings.ts`; tests updated.

### Endpoints (new canonical + back-compat)
- `GET /listings?kind=&project=&q=&claim=&cursor=&limit=` · `GET /listings/:id`
- `POST /listings` — body `listing_kind` (default `harness`), `project_ref`,
  `listing_ref` (required for non-harness), `topic_hex` (required for harness)
- `DELETE /listings/:id` · `POST /listings/:id/claim`
- `/harnesses*` — back-compat = `/listings` pinned to `kind='harness'`. Droppable
  once the operator proxy is fully cut over (see §3); it carries no behavior the
  generalized surface doesn't.

### Test + typecheck status (verified locally)
```
cd apps/operator-public
npx vitest run     # 100 passed (9 files) — incl. new listings.test.ts (3-kind + 1:N)
npx tsc --noEmit   # exit 0 (clean; fixed 3 pre-existing reports.test.ts json casts)
```

### Deploy (your step — do not let me)
The schema migrations apply in order; **004 exactly once**:
```bash
cd apps/operator-public
wrangler d1 execute papercusp-cupboard --remote --file migrations/002_add_publisher_permission.sql   # if not already applied
wrangler d1 execute papercusp-cupboard --remote --file migrations/003_add_publisher_attestation.sql   # if not already applied
wrangler d1 execute papercusp-cupboard --remote --file migrations/004_listing_kinds_project_centric.sql
npm run deploy
```
**Deploy ordering is safe either way** — the operator proxy now calls `/listings`
with a transitional `404 → /harnesses` fallback, so a not-yet-deployed worker
still serves harness listings, and a deployed worker immediately serves all
kinds. No lockstep required.

---

## 2. P-008 flag flip — RECONCILED recommendation

The plan (P-008) said "flip `SNAPSHOTS` + `MARKETPLACE` on." **Codebase reality
changes the `MARKETPLACE` half** — flagged here rather than followed blindly:

`libs/flags/src/types.ts` has **no `CUPBOARD` flag** — the Cupboard ships ungated
in V1 (nav + `/cupboard` are live). The three listing kinds therefore need **no
new flag**. So:

| Flag | Recommendation | Why |
|------|----------------|-----|
| `papercusp-snapshots` | **flip ON** | Snapshots become the Cupboard's `kind=snapshot` fork-source. The snapshot capture/instantiate surface it gates must be on for snapshot listings to work end-to-end. |
| `papercusp-marketplace` | **leave OFF — do NOT flip on; retire the key** | It gates the **legacy marketplace** routes + the "Marketplace" nav item, which E4 **retires** (the dead `:3057` / `/v1/catalog` wiring). Plugin distribution moves to the **ungated Cupboard** (`kind=plugin`). Flipping it on would only re-expose retired surface. |
| `papercusp-templates` | **leave OFF (orphan)** | Gates nothing live (only admin labels). |

**Follow-up (your call, not done here):** once the legacy marketplace routes are
deleted, the `MARKETPLACE` and `TEMPLATES` flag keys are orphans — removing them
touches `libs/flags/src/types.ts` + the PostHog definitions. Reasonable to delete
in the same pass; left out of this handoff because it's a flags-lib + PostHog
change, not Cupboard-specific.

**How to flip (your step):** the in-app `/admin/features` page → `POST
/api/flags/set` (round-trips through PostHog + the SSE flag-bus). Do not edit
JSON / hit PostHog directly (per `CLAUDE.md`).

---

## 3. What's already done on the operator side (FYI, not your action)
- `lib/cupboard/types.ts` — `listing_kind` + the listing-kind vocabulary.
- `lib/endpoint-route/routes/cupboard.ts` — proxy targets `/listings?kind=` with
  the `404 → /harnesses` fallback above.
- (Landing after the in-flight `operator-core` carve: `CupboardClient.tsx` kind
  filter + per-kind actions; the marketplace/`:3057` route retirement;
  `cupboard-publish.ts` `listing_kind` on publish.)
- E5 trust posture: `apps/operator-docs/.../security/distribution-trust.mdx` +
  `packages/plugin-loader/src/fork-install-consent.test.ts` (capability-gate +
  install-consent on the fork→install path).

## 4. Explicitly NOT done (yours / out of scope)
- **No `wrangler deploy`** and **no prod D1 migrate** — §1 is yours to run.
- **No prod flag flip** — §2 is a recommendation.
- **Producer-side trust** (collaborator push to the project remote) — out of
  scope (D-012; owned by the rethink / distributed-coordination plans).
