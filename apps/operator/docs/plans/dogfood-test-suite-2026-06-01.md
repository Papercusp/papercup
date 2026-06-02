---
title: Test suite — shared-harness dogfood / collaborative substrate
slug: dogfood-test-suite-2026-06-01
status: active
created: 2026-06-02
updated: 2026-06-02
owner: aviynw3@gmail.com
---

# Test suite — shared-harness dogfood / collaborative substrate

## Now

**State:** COMPLETE. WS-0/1/5 delivered (~140 new tests, 21 files, all green + committed); WS-2/WS-3 verified already-covered (no redundant tests). WS-4 verified in-session via a dedicated Tauri shell on DISPLAY=:99 (reused existing :3055/:3070 — no collision; killed cleanly after, user's release app untouched): the `dogfood` domain renders AND is selectable in the live /adv Tests tab (page URL reached `testsTab=dogfood`), with dogfood section labels (PR lifecycle, Cupboard) in the DOM; a durable registry guard test locks the domain + its 12 sections so it can't silently regress. tools-md-sync green.

**Next:** None — suite shipped. Optional future follow-up (not started): a committed tauri-driver/automated browser-E2E spec for the full collab share/join flow once GitHub-OAuth + 2-peer fixtures exist (today that path needs real creds + a second peer, so it was verified at the render/nav level, not the full federation round-trip).

## Background

The "shared harness dogfood plan" is `papercusp-dogfood-v5-2026-05-23` (collaborative-at-the-core). Its cross-peer data layer was superseded 2026-06-01 by **Model B** (`papercusp-substrate-model-b-rewrite`/`-impl`, `papercusp-phase1b-bidirectional-federation`, `papercusp-substrate-revocation-v1`/`-v2`). The substrate + collaboration UI are largely built and broadly unit-tested.

Two structural findings drive this plan:
1. **The suite is invisible in the testing tab.** Neither `apps/operator/lib/testing-domains-registry.ts` nor `.harness/testing-domains.json` declares a dogfood/collaboration/substrate domain. ~80+ existing tests under `lib/sync/hyperbee/**`, `lib/identity/**`, `lib/orchestrator/**`, `lib/pr-host/**`, and the dogfood `lib/harness/*` helpers run in CI but cannot be browsed/run from `/adv → Tests` or `/admin/testing`.
2. **~30 built files have no test**, and several cross-cutting invariants from the plans (trust-tier no-cross-aggregation, LWW tie-break, binding state machine, revocation semantics) are not directly guarded.

## Testing system (how the /adv Tests tab works)

- `/adv/harnesses/<slug>` → **Tests tab** = `<HarnessTestsView>` — the same `<TestingShell>` as `/admin/testing`, but nav driven by the harness's own `.harness/testing-domains.json` (glob-walked against the worktree), plus a per-harness **Acceptance** (VAL) panel.
- Tests appear automatically when a file lands under a glob-matched path of a registered domain. Four canonical frameworks only: **Vitest** `*.test.ts`, **Playwright** `*.spec.ts` (`apps/operator/e2e/`), **Cargo**, **LLM scenarios**. No new `.mjs`/smoke scripts (CI-linted, P-038).
- PG-touching → `*.integration.test.ts` (testcontainers); browser → `*.spec.ts`.

## Scope

**In scope (built + live):** Model-B substrate (`lib/sync/hyperbee/**`), identity/two-channel binding + signing (`lib/identity/**`), revocation v1 (self-device) + v2 (contributor — built despite plan "HELD"), Phase 1a (workspace/classifier/clone/register), Phase 1b bidirectional federation, Phase 2 `completion_ref`, Phase 3 reactivity (`emit_change_notify` → `sync-sse`), orchestrator claim (`lib/orchestrator/**`), PR lifecycle (`lib/pr-host/**`), Cupboard public API (`apps/operator-public`), Discord webhook, sync-with-main, the shipped collaboration UI.

**Out of scope (not built — no code to test):** any Phase 5b/6/7/8/9 surface a recheck shows absent, the retired/flag-gated `templates`/`plugins`/`snapshots` marketplace tabs (CLAUDE.md V1-cut — Cupboard UI tests scoped to harness-listing + `cupboard-moderation` only).

## WS-0 — Surface the suite (do first)

Add a sectioned `dogfood` domain to `apps/operator/lib/testing-domains-registry.ts`, `.harness/testing-domains.json`, and the `TABS` list in `apps/operator-vite/src/components/admin/TestingClient.tsx`. Sections (glob existing + new): `substrate`, `identity-binding`, `federation`, `claim`, `pr-lifecycle`, `completion-ref`, `reactivity`, `revocation`, `cupboard`, `ui`, `routes`, `e2e`. Populate the Acceptance (VAL) panel with the north-star acceptances. Verify it renders in `/adv → Tests`.

## WS-1 — Fill built-but-untested gap files

Logic/security: `lib/identity/sign-with-device-key.test.ts` (Ed25519 PKCS8/SPKI round-trip; raw-32 base64 == binding `device_pubkey`; tamper→reject), `lib/identity/keychain.test.ts`, `lib/sync-sse.test.ts` (ring buffer + Last-Event-ID replay + 90s dedupe + camelCase bridge), `lib/sync/hyperbee/__tests__/corestore.test.ts`, `lib/harness/__tests__/join-steps.test.ts`, `lib/harness/__tests__/auto-rebase.test.ts` (conflict→escalation `{kind:'rebase_conflict'}` + stash `wip/…` + reset `in_queue`/clear `working_users`; `wip/*` never mirrored), `lib/harness/__tests__/wave-advance-sweep-live.test.ts`, `lib/integrations/outbound-webhook.test.ts` (5xx backoff×3; never blocks; logs `webhook_audit`), `lib/agent-tools/locks/__tests__/queue.test.ts`, `lib/ensure-schema-dogfood.integration.test.ts`.
MCP tools (+ `guidance.when` for `tools-md-sync`): `lib/agent-tools/substrate/{revoke-contributor,revoke-self-device}.test.ts`.
Routes: `routes/admin/__tests__/dogfood-substrate-{status,health,boot-history}.test.ts`, `routes/harness/__tests__/discord.test.ts`, `routes/users/__tests__/by-github-id.test.ts`.
UI (RTL): `JoinProgress`, `PrRow`, `ContributorBadge`, `ClaimStatusBadge`, `HarnessClaimHeader`, `PlanConflictModal`, `MarkdownEditor`.

## WS-2 — Lock the load-bearing invariants

Trust-tier no-cross-aggregation (D-030) + Cupboard tier-A-only; LWW tie-break property (later `ts`; `del`>`put`; per-field); schema-version ignore-and-toast (D-024); binding state machine (`pending`→`verified`; 24h→`unverified`; no-retry on `fail`); read-admission channel-2-only + no-collaborator-gate + forged-binding-refused; feature state machine (`current_worker` derived; branch-not-deleted-on-merge); `completion_ref` cache-only reads + divergence; canonical-binding uniqueness (`harnesses_active_repo_unique`).

## WS-3 — Integration / two-peer / federation

Extend `two-peer-swarm-bidi.test.ts`; add `federation-revocation.integration.test.ts` (admit→revoke[both paths]→reverify-drop→re-publish→re-admit, no blocklist); `two-identity-acceptance.integration.test.ts` (deterministic offline equivalent of the manual two-machine P-079).

## WS-4 — Playwright E2E + Tauri agent-e2e

`apps/operator/e2e/collab-{share,join,insights,prs}.spec.ts`; one Tauri agent-e2e acceptance walkthrough wired to the Acceptance panel (per `/internal/docs/testing/agent-e2e`).

## WS-5 — Cupboard public API (`apps/operator-public`)

`__tests__/{binding,reports,ratelimit,db}.test.ts` (active-binding uniqueness, private-repo auth-reveal, claim/supersede gates, 5/hr rate-limit). Cupboard UI tests scoped to harness-listing + `cupboard-moderation` only.

## Discipline

Four canonical frameworks only; re-verify each gap before writing; `npm run test:affected` + `tools-md-sync` green before "done"; `ensure-schema*` edits → `test:all:integration`. Integration tests are hermetic (testcontainers), independent of the native-PG box's migration lag.

## Decisions

### D-001 Scope = built + live only (2026-06-01)

No tests for unbuilt phases; deferred surfaces are surfaced explicitly, never silently dropped. Recheck confirmed 5b–9 mostly built, so coverage targets real code.

### D-002 One sectioned `dogfood` domain (2026-06-01)

A single new domain with sub-sections in both the admin registry and `.harness/testing-domains.json`, rather than splitting into substrate/collaboration/identity tabs or folding into `papercusp-su`/`transport`. Most discoverable; keeps the dogfood suite cohesive.

### D-003 All four layers in v1 (2026-06-01)

Unit + integration + invariant guards + two-peer integration + Playwright/agent-e2e + Cupboard public API. The user opted into full thoroughness.

### D-004 Cupboard UI tests exclude retired marketplace tabs (2026-06-01)

`templates`/`plugins`/`snapshots` are V1-cut/flag-gated (CLAUDE.md). Cupboard UI coverage is scoped to the harness-listing + `cupboard-moderation` routes; the exclusion is documented, not silent.

### D-005 — WS-2 + WS-3 invariants/flows were already covered — no redundant tests added
Date: 2026-06-02
During execution, the WS-2 invariants (LWW tie-break, read-admission no-collaborator-gate, schema-version ignore-and-toast, binding state machine, completion_ref cache/divergence, trust-tier no-cross-aggregation D-030) and WS-3 flows (two-peer federation, admit→revoke→reverify-drop→re-publish→re-admit-no-blocklist) were found to be comprehensively covered by EXISTING tests — notably `lib/harness/stat-tier-types.test.ts` (26 tests, the full D-030 honest-stats guard incl. sumWithinTier cross-tier refusal + Cupboard tier-A-only + zeroIfUnverified), `read-merge.test.ts`, `read-admission.test.ts`, `schema-version.test.ts`, `two-channel-verifier.test.ts` + `binding-verifier-types.test.ts`, `completion-ref-verifier.test.ts`, `revocation-enforcement.test.ts`, `reverify-admitted.test.ts` (explicit "pubkey NOT in revoked / re-admittable"), and `two-peer*.test.ts`. Per the "don't write redundant tests" discipline, no new WS-2/WS-3 files were added; the value delivered was (a) surfacing all of them under the new `dogfood` domain so they're browsable/runnable, and (b) verifying the coverage. The Explore-agent's initial gap report over-counted gaps because it only checked colocated `<name>.test.ts` and missed `__tests__/` siblings; every WS-1 gap was re-verified before writing.
