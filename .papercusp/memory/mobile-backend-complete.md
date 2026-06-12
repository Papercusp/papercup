---
name: mobile-backend-d002-d004-complete
description: Mobile P0 backend (WI-14) — all device routes implemented, tested, verified complete
metadata:
  type: project
---

# Mobile P0 Backend (WI-14) — Status: COMPLETE

**Date verified:** 2026-06-12  
**Plan:** mobile-apps-revival-redesign-2026-06-05  
**Decisions covered:** D-001.2 (contract repair), D-002 (three device routes), D-004 (push send)

## What was done

### Three device-JWT-gated routes (D-002)
All implemented in `packages/operator-core/lib/endpoint-route/routes/device/`:

1. **device/operator-converse** — Bridge shared operator conversation
   - File: operator-converse.ts
   - Endpoints: GET /device/operator/conversation, GET /turns, POST /converse (SSE)
   - Behavior: Real chat thread shared with desktop + TUI
   - Tests: 3 passing

2. **device/plans** — Plans/items browsing + status updates
   - File: plans.ts
   - Endpoints: GET /device/plans, GET /plans/:slug, POST /plans/:slug/items/:itemId/status
   - Behavior: "All Pots" multi-harness support, dispatches plans:set-status for locking
   - Tests: 4 passing

3. **device/attention** — Work-items-native inbox feed
   - File: attention.ts
   - Endpoints: GET /device/attention
   - Behavior: Attention groups + work-items layer, deep-link target for push
   - Tests: 2 passing

### Push registration + dispatch (D-001.2 / D-004)
- **push.ts** — POST /device/push/register (upsert device token)
  - Stores in harness_shared.mobile_push_tokens
  - Tests: 1 passing
- **device-push-dispatcher.ts** — APNs/FCM dispatcher
  - Called by attention-notify on escalations/smoke-fails/plan-reviews
  - Supports push routing kinds (intervention, plan-review, smoke-fail, operator-suggestion)

## Pattern used
All routes use `defineTool`-authored pattern (confirmed in code + tests).

## Integration status
- ✅ Routes imported in lib/endpoint-route/routes/index.ts
- ✅ All routes in ALL_ROUTES export
- ✅ Device auth enforcement (DEVICE_AUTH gate)
- ✅ CORS enabled
- ✅ 12 unit tests pass (device-revival-routes.test.ts)
- ✅ Smoke tested on :3170 staging (403 auth errors = routes properly wired)

## Important notes
- **Plan status:** The plan shows COMPLETE on both platforms (iOS sim E2E green, Android converse fold done, two real bugs fixed en route)
- **APNs credentials:** Deferred per D-007 (owner decision 2026-06-10) — simulated delivery verified, real cloud push blocked until mobile re-enters roadmap
- **Previous holder:** Agent s-1781274768964-d77bc9c0 died at ~10:39Z 2026-06-12; all code was already committed (work was actually complete before re-placement)

## Next steps (if any)
None for the backend. iOS agent (su-98576d04) handles client-side D-001 contract repair. APNs credentials await owner enroll decision.
