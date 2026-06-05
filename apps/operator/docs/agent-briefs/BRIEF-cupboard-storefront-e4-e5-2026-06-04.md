# BRIEF — Cupboard storefront: three listing kinds + trust posture (E4 + E5)

**Plan:** `harness-blueprint-distribution-2026-06-03` (read first: `plans:get { slug, harness:'all' }`).
Items **P-007, P-008** (E4), **P-009** (E5). Decisions **D-005, D-007, D-008 (reconciled to 1:N), D-009, D-012**.
**Coordinate with:** the **dogfood-federation / Cupboard owner** — the deployed CF Worker `apps/operator-public` is theirs; **D-005 says EXTEND it, don't fork, and don't unilaterally deploy.** Also **su-9e6b8** (carving `packages/operator-core` out of `apps/operator/**` + operator-vite — **ALL** of E4's operator-side is in their churn zone; hold edits until they signal stable / confirm moved paths).

## Goal
Extend the EXISTING deployed Cupboard into **one storefront with three listing kinds** — shared-harness → **join**, blueprint/snapshot → **fork**, plugin → **install** — keyed **project-centric (1:N)** per the reconciled D-008, and retire the dead `:3057`/marketplace wiring.

## Verified background (don't re-derive — corrects the plan's "two backends" framing)
- **Cupboard** = deployed **CF Worker + D1** at `cupboard.papercusp.com` (`apps/operator-public/`). D1 `harnesses` table (`migrations/001_init.sql`) keyed by `github_repository_id`, **no `listing_kind` column**. Routes: `/harnesses*`, `/reports`, `/admin/*`. Operator proxy: `apps/operator/lib/endpoint-route/routes/cupboard.ts`; publish: `routes/harness/cupboard-publish.ts` (`DEFAULT_CUPBOARD_URL = 'https://cupboard.papercusp.com'`, ~:43). UI: `apps/operator/app/cupboard/CupboardClient.tsx` (**harness cards only, join action**).
- ⚠ **`:3057` is the OLD MARKETPLACE server — a *separate* service from the Cupboard**, not a "second Cupboard backend." `PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057'` appears in `routes/marketplace/*` + `routes/templates/publish.ts` + `routes/snapshots/publish.ts`. `/v1/catalog` was **never implemented** (`routes/marketplace/catalog.ts` tries `/v1/catalog` → `/catalog` → bundled `FALLBACK_CATALOG`). The "single storefront" merge folds marketplace concepts **into the Cupboard** and **retires `:3057` + the dead `/v1/catalog` wiring**.
- `listing_kind` is **greenfield** (CF Worker D1 + operator client + UI). The **1:N reconciliation (D-008):** key listings by **PROJECT** (the papercupai project remote) with **N blueprint listings per project**, NOT 1:1 `github_repository_id`-per-harness. (See RFC `project-centric-harness-rethink-2026-06-04` D-001/D-008.)
- **FLAGS:** `TEMPLATES` = orphan (gates nothing); `SNAPSHOTS` gates snapshot routes; `MARKETPLACE` gates the legacy marketplace routes. **P-008 = flip `SNAPSHOTS` + `MARKETPLACE` on once reframed** — *coordinate the flip + the CF Worker deploy with the federation owner* (outward-facing; don't ship to the live shared service unilaterally).
- **E5 / D-007 / D-009:** trust v1 = **capability-gate + install-consent** on plugin install (existing model: `apps/operator/lib/plugin-host-runtime.ts` grants + `capabilities/invoke.ts` palette guard). Forking a blueprint pulls plugin code → the existing install-consent path covers it. **Producer-side** trust (collaborator push to the project remote) is **OUT OF SCOPE** (rethink/distributed-coordination plans own it — D-012).

## Scope (operator-side = yours; CF Worker + flags = reviewed handoff to the federation owner)
- **Operator-side (after su-9e6b8 carve settles):**
  - `listing_kind` in `apps/operator/lib/cupboard/types.ts`; `/api/cupboard/*` proxy forwards a `kind` param.
  - `CupboardClient.tsx`: kind filter (tabs/dropdown — put it in **nuqs** per `CLAUDE.md`, not `useState`) + per-kind action: harness→join, blueprint/snapshot→fork, plugin→install.
  - Retire the dead `:3057` / `/v1/catalog` / legacy-marketplace routes, folding their live bits into the Cupboard path.
- **CF Worker handoff (federation owner):** D1 `listing_kind` migration (`apps/operator-public/migrations/004_*`), route generalization (`/harnesses` → `/listings` or parallel kind-routes, project-keyed 1:N), publish accepts `listing_kind`. **Prepare as a reviewed PR/handoff; do not deploy.**
- **Flags handoff (federation owner):** the P-008 `SNAPSHOTS`/`MARKETPLACE` flip.
- **E5:** a capability-gate + install-consent test on the fork→install path; a short trust-posture doc (the existing plugin model covers v1).

## Testing
Vitest for the operator proxy + `cupboard/types` + the `apps/operator-public` worker (it already has tests); Playwright e2e in `apps/operator/e2e/` for the 3-kind UI; a capability-gate test on fork-install. Canonical homes only (see `CLAUDE.md` "four canonical frameworks").

## Done when
The Cupboard shows + filters three listing kinds, each with its correct action; the dead `:3057`/`/v1/catalog` wiring is gone; fork→install is capability-gated + consent-prompted; the CF Worker + flag changes are a reviewed handoff to the federation owner (not unilaterally deployed).

## Do NOT
fork `apps/operator-public` (extend it — D-005); unilaterally deploy the CF Worker or flip prod flags (federation owner's call); build producer-side project-remote trust (out of scope — D-012); put listing-kind / filter state in `useState` (use nuqs); edit `apps/operator` during su-9e6b8's carve without coordinating paths.
