Portal HUD Decisions — WI-2147274, 2026-09-06

The live portal failure is a client/backend version mismatch. The native popup sends `plans.attention` with `{ ownerAgentId, limit: 100, offset: 0 }`. The portal host preserves those query parameters when forwarding to the operator. The release operator observed during diagnosis (build `6e898b6cf8`) rejected `ownerAgentId` as an unrecognized argument. Its sync resolver then reduced the structured validation error to `plans:attention → 400`, surfaced as HTTP 500.

The functional owner-scoping fix already exists in canonical staging: `packages/operator-core/lib/agent-tools/plans/attention.ts` declares `ownerAgentId` and filters before pagination, with counts recomputed for that owner. Replaying the exact request against staging returned HTTP 200. Removing the owner filter would reintroduce incomplete results from filtering a shared first page, so that contract remains intact.

This pass changed the existing Plans read dispatcher to preserve the HTTP tool dispatcher's `error.message`, while retaining legacy string errors and the verb/status fallback for malformed errors. It added a regression test that failed with the old opaque message and passed with the correction, plus a test that the actual attention tool accepts and preserves the popup's exact query arguments and rejects a blank owner. No new service, query, or compatibility fallback was introduced.

Verification:

- Five focused suites passed: 191 tests, zero skipped. They cover the read dispatcher, real attention schema/cache, owner filtering before pagination, paged attention hooks, and SessionChatModal. Log: `/tmp/wi-2147274-tests.log`. Run began at 01:40:54Z on HEAD `840fa61fe1` with the local changes applied; this is local validation, not a release-gate verdict.
- Scoped TypeScript check passed for all three changed files. Log: `/tmp/wi-2147274-types.log`.
- Actual staging queries for two sampled owners each returned one decision, every returned item matched the requested owner, and an intentionally nonexistent owner returned no items.
- An isolated portal preview at `127.0.0.1:3981` used the existing immutable portal UI with its operator origin set to staging `:3170`. Its real popup rendered one Decisions card, with the exact owner-scoped request visible in browser resources. The final 1440×900 screenshot was opened and inspected: [Decisions rendered](decisions-staging-verified-2026-09-06.png).
- One intermediate refresh encountered HTTP 502 `operator_unreachable` from staging, affecting both Decisions and session loading. The card recovered automatically, and both preview and staging then returned HTTP 200. Cause remains unconfirmed; this separate availability observation is recorded on the work item. The earlier error image is preserved as [temporary upstream failure](decisions-staging-unavailable-2026-09-06.png). It is not positive acceptance evidence.
- The preview did not send or resolve any agent decision. Its task `0mtp5d6k0e4uv151yuf` was stopped through staging `processes:kill`, which verified the scope empty. The first failed preview task's exact cgroup was independently confirmed absent. The live portal configuration was unchanged.

Changed files: `packages/operator-core/lib/agent-tools/plans/read-dispatch.ts`, `read-dispatch.test.ts`, and `attention.cache.test.ts` in the same directory.

Shipment remains pending. The release gate was held by a live agent on WI-212675 when inspected; the diagnosis was sent once to that owner, and this session stood down from live gate operations. WI-2147274 stays open for final verification after the corrected backend is promoted and deployed. This report does not claim that live :3081 Decisions loading is repaired. The continuous portal design iteration continues under WI-2146962.
