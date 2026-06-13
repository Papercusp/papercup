---
name: ei-397-cross-harness-search-fix
description: Fix for plans:search scope resolution bug (EI-397) where exact slugs from harness-scoped agents returned zero hits
metadata:
  type: feedback
---

**Fixed: plans:search now resolves exact plan slugs across harnesses for scoped agents**

When a harness-scoped agent searched for an exact plan slug (e.g., `P-001`), the search would return zero hits if the plan existed in a different harness (e.g., Papercusp). Root cause: the scoped search query filtered by `harness_slug = <agent's harness>` only.

**Fix applied:**
1. Detect if query looks like an exact slug (`VALID_PLAN_SLUG.test(args.query)` + short length <50)
2. If scoped search returns zero hits AND query is slug-like AND not already cross-harness scoped
3. Retry search with `harnessSlug = HARNESS_ALL` (cross-harness)
4. If cross-harness search finds results, return them with a `crossHarnessHit` flag in metadata/response

**File:** `packages/operator-core/lib/agent-tools/plans/search.ts`
- Added imports: `VALID_PLAN_SLUG`, `HARNESS_ALL`, `isAllHarnessSentinel`
- Lines 125-157: slug detection + cross-harness fallback logic
- Lines 241, 253: surface the cross-harness hit in metadata + response JSON

**Why:** Over 30 days, 274 distinct harness-scoped agent spawns got zero hits for valid slugs in Papercusp's plans. Harness scoping is correct (agents should see their own harness plans by default), but exact slug lookups should resolve cross-harness (analogous to how `plans:get` works).

**How to apply:** No breaking changes. Existing behavior preserved (scoped search first). Cross-harness fallback is transparent—if an agent explicitly passes `harness: 'all'`, the fallback is skipped (line 146 guard).
