---
title: "Promote policy + staged/generative waves (fine-grained plan→feature control)"
slug: promote-policy-and-waves-2026-05-30
status: active
created: 2026-05-30
updated: 2026-06-01
owner: avi@storewolf.com
---

# Promote policy + staged/generative waves

## Now

**State:** Phases A + B landed. (A) `## Promote` policy parser (`promote-policy.ts`) + zod + 8 tests. (B)
migration `089-promote-waves.sql` — `wave` column on consolidated (back-written like `source_plan_slug`) +
`current_wave` cursor on `harness_plan_status`. First real dogfood is the `restart`
`universal-schema-2026-05-30` plan (§9a), blocked on this mechanism.

**Phase C done** (P-005 + P-006): `plans:promote` carries `wave` + hints and back-writes `consolidated.wave`;
policy-mode (`plans:promote { slug, wave }`) reads the `## Promote` policy and builds the wave's features
(static + generative `for_each` over `generate_items`). Parser + schema + promote are now end-to-end for a
manual per-wave promote.

Phase D: **P-008 + the P-009 decision core done** — `lib/harness/waves.ts` now also has the pure
`decideWaveAdvance` (cursor null→promote first; un-populated wave→wait [idempotency guard]; blocked→surface;
in-progress→wait; drained→promote next; complete→none). 22 tests, tsc clean.

**Phase D done** (P-008/009): pure wave helpers + `decideWaveAdvance` + `runWaveAdvanceTick` + the live
adapter (`wave-advance-sweep-live.ts`) + boot registration. tsc clean; ~60 unit tests across the mechanism.
⚠️ The live sweep is **unverified at runtime** and has two connection points open (see P-009): `promoteWave`
→ **Phase F** (the `promote` role), `onBlocked` → **Phase E** (raise a `harness_issues` row).

Phase F started: **P-014 done** — promote-role prompt (`harness/prompts/promote.md`) + `AGENT_ROLES`
registration. The mechanism is now **authored end-to-end** (parser → schema → promote → waves → sweep →
role), ~60 unit tests + tsc-clean on all new code.

**P-010 done** (`5c1de763`-adjacent): the tick test-suite (`wave-advance-sweep.test.ts`, 7 tests) covers all
four required cases — drain→advance, hard-block→no-advance, cursor idempotency, generative needsItems
propagation — 29 green with `waves.test.ts`. **Every non-host item is now done.** Documenter task also done:
the plan-format spec (`/internal/docs/spec/plan-format`) now has a `## Promote` policy (waves) section (commit
`5c1de763`) — closes the gap an SU engineer hits authoring a waves plan.

**HOST-VERIFIED 2026-05-31** (desktop up; `:3070` = standing `papercup-dev-api.service`, native PG :5432
`papercusp`, the native fallback — no discovery file/env URL on this box):

- **Migration gate found + fixed (the real blocker).** The live DB was **8 migrations behind** (082–089) — the
  sweep was failing *every tick* on `column "current_wave" does not exist`. Applying 082–089 surfaced **3 real
  migration bugs**, now fixed (submodule `da4c2d0`): `084` backfill referenced `metadata_json` (canonical
  column is `metadata` per 001-shared.sql; latent because embedded-pg boots from preseed snapshots that already
  record 084); `086`/`087` `CREATE POLICY` lacked idempotency (failed when the table pre-existed) → added
  `DROP POLICY IF EXISTS`. DB now at HEAD (99/99); `current_wave` + `wave` + `source_plan_slug` + the
  `hfc_plan_wave_idx` index all present; the sweep ticks clean (verified over a real 35s window, +0 errors).
- **P-014 run-verification — DONE.** Confirmed live (sweep log `/tmp/dev-api.log`): the sweep sees a started
  policy plan, parses its `## Promote` policy (`getPlanWaves` → [tier1, tier2]), queries real consolidated
  features by `(source_plan_slug, harness_slug, wave)`, **correctly WAITS** while tier1 is in-progress (0 log
  lines), and **correctly ADVANCES** the moment tier1 drains (all `passed`) — firing `promoteWave` for tier2
  (next wave, `blocked_by` respected) which reaches the Phase-F `/invoke?role=promote` connection point. The
  `promote` role is registered in the live `roles_known`. Test used a throwaway `harness_slug` + plan (cleaned
  up).

**Sweep→agent chain — verified + 4 more bugs fixed (2026-05-31, second pass).** Driving the real
`/harness/:slug/invoke?role=promote` against a throwaway harness (`sheets-from-template-e2e`, workspace
`default`, cleaned up) exposed and fixed the wiring between the sweep and the agent:
- **EXTRAS format** (commit `e647a6e`/`27c92f3`): `promoteWave` was POSTing `{plan_slug,wave,needs_items}` as
  top-level JSON, but the invoke route reads `body.extra` (a `K=V` string[]) and renders it as the agent's
  `## Runtime context` lines. Now sends `extra:["PLAN_SLUG=…","WAVE=…","NEEDS_ITEMS=…"]`; `promote.md` reads
  those uppercase keys from Runtime context.
- **Workspace** (`27c92f3`): sweep used `DEFAULT_WORKSPACE_ID`; the invoke route + `features/import` + the
  sibling `harness-status-sweep` all use `activeWorkspaceId()`. Aligned the sweep to `activeWorkspaceId()` so it
  can resolve+invoke the harness it queried (was silently `unknown project` when the UI was on another ws).
- **buildInvokeOnce PG env** (`2993f58`): invoke-route/scoper/expert agents got no `PAPERCUSP_USE_PG_STATE`/
  `DATABASE_URL` (only `harness-launch` set them) → the spawned agent ran with empty in-memory state. Now sets
  both (mirrors harness-launch) → verified live: `PG bootstrap: connected … ctx.pg active`.
- **bun PATH** (host-ops, in `apps/operator/.env.local`, gitignored): the systemd `papercup-dev-api.service`
  PATH lacked `~/.bun/bin`, so omp's `#!/usr/bin/env bun` shebang failed `rc=127` for **every** invoke-spawned
  agent. Prepended `~/.bun/bin` in `.env.local` (sourced by ExecStart) → agent now spawns `rc=0`.
- **MCP endpoint URL** (host-ops, `.env.local`): `spawn-mcp.ts`'s default points the agent's `papercusp` MCP
  server at `<base>/api/sse`, which **404s** on this host — the live agent-mcp endpoint is `/api/mcp`
  (streamable HTTP; `initialize` verified). With the 404, omp loaded **zero** papercusp tools (`HTTP 404`), so
  the promote agent had no `plans:promote`. Set `PAPERCUSP_OPERATOR_URL=http://localhost:3070/api/mcp` in
  `.env.local` (what the desktop sets but the standing dev-api service didn't) → omp now connects + loads the
  tools (`MCP prompt commands refreshed path=mcp:papercusp`; the residual `-32601` is only the optional
  `resources/list`).

After these: the full chain **sweep decision → promoteWave → /invoke → resolveProject → buildInvokeOnce →
invoke-once → PG connected → promote prompt built (`role=promote total=5510`) → omp spawns `rc=0` → omp loads
papercusp tools** is verified live. Every papercusp-side layer works.

Switched to the **claude-code** backend per request (`.env.local` `AGENT_CMD="claude -p"` +
`AGENT_BACKEND="claude-code"`). Two more agent-layer fixes landed after that:
- **Route timeout** (`spawn.ts`, committed): `/harness/:slug/invoke` used the route-stack 30s default
  (`route-stack.ts:155`) and **aborted the agent mid-run** — an LLM invocation needs far longer. Raised
  `timeoutSec` to 310 (the handler already caps the child at ≤300s).
- **Tool-role grant** (`promote.ts` + `plans/get.ts`, committed): the promote agent reported `plans:promote is
  not available` — `plans:promote`'s `agentRoles` was `[...COORD_ROLES]` and `plans:get`'s was a local
  `ALL_ROLES`, **neither included `promote`**, so `/api/mcp?role=promote` exposed every group EXCEPT plans.
  Added `'promote'` to both. After this the agent **does call `mcp__papercusp__plans_promote`** (verified —
  `toolCalls: ["mcp__papercusp__plans_promote"]`).

**Final blocker — an auth-model design gap (NOT the wave mechanism; needs a human decision):**
- `plans:promote` (+ 13 other coord tools: `coord:send`, `coord:ack`, …) call `resolveAgentIdentity(ctx)`,
  which requires a stable **`isSuperuser` / `isPowerUser` / `principal`** identity (and, by design
  `identity.ts:35`, must NEVER use `spawnId`/`runId`). The MCP request-context builder
  (`_mcp-handler.ts`) sets those ONLY on the explicit **superuser** (`?superuser=1` + loopback + valid superuser
  bearer, branch 1) and **power-user** (`?power_user=1` + HMAC token, branch 1b) paths. A **plain signed-spawn**
  URL (`?harness=&role=&run=&spawn=&sig=`, branch 2/3 at `:328-344`) builds a ctx with role/run/spawn/uiClientId
  but **no `isSuperuser`/`principal`**. So the invoke-route promote agent (plain `claude -p` → plain signed
  spawn) gets **no identity** → `plans:promote` returns `resolveAgentIdentity … no power-user/superuser/
  principal identity` → **0 features**. Normal harness agents avoid this because they run under the
  `claude-su`/`omp` **su-wrappers**, which connect with `?superuser=1` + the superuser bearer (branch 1).
  **Fix (user's call — security-sensitive):** make the invoke-route-spawned agents take the su-path like normal
  harness agents — either (a) point `AGENT_CMD` at the `claude-su` wrapper (not plain `claude -p`) so its MCP
  connection carries `?superuser=1` + bearer; or (b) have `spawn-mcp`/the invoke route mint a `?superuser=1`
  (or `?power_user=1`) URL for operator-initiated, loopback spawns; or (c) give `resolveAgentIdentity` a branch
  that accepts a verified-signature spawn (attributed to the stable harness slug). Once wired, the live P-015
  dogfood completes (`restart` is registered in `default`). The whole rest of the chain — including the agent
  **calling `mcp__papercusp__plans_promote`** — is verified live.

Everything up to that point is fixed + verified live: **sweep decision → /invoke (route timeout ok) →
resolveProject → buildInvokeOnce (PG + bun) → invoke-once → PG connected → promote prompt → claude-code spawns
→ loads papercusp tools incl. plans:promote → CALLS plans:promote**. (Also hit a transient Anthropic `429`
during testing — operational, from rapid repeated runs, not a code issue.)

**Follow-up (small):** `yaml` is imported by the parser but is an undeclared (stable, lockfile-present,
already-bundled) transitive dep — declare it as a direct operator dep when the lockfile is next reconciled
(adding to package.json now without a matching lockfile update would break `npm ci`).

## Background

`plans:promote` today takes a fully-formed `features[]` array the calling agent improvises at promote time
(`apps/operator/lib/agent-tools/coordination/tools/promote.ts`): `{title, body?, acceptance?, from_items?}`
→ `/api/harness/<slug>/features/import` (server allocates `F-AUTO-*`), extract inline `VAL-*` assertions,
mark items done, write `## Promoted` + `## Now` status. **Two gaps the owner wants closed:**

1. **No plan-authored promote policy.** There's nowhere in the plan to declare *how* it should be promoted —
   the breakdown is ad-hoc per promote call. The owner wants fine-grained, plan-resident control: "the agent
   in charge of promote follows these instructions."
2. **No staged / generative promotion.** Some plans can't list their features up front. The driving example
   (`restart` `universal-schema`, §9a): Tier-2's per-type features are a **runtime output of Tier-1** (the
   universal type axis is *discovered* by Tier-1), so they must be generated *after* Tier-1 runs.

The import payload also can't express per-feature **agent/role assignment, ordering/blocked-by, or wave** —
only title/body/acceptance/items.

## Design

A parser-recognized **`## Promote` policy** block in the plan, executed in **waves**:

```yaml
## Promote
target_harness: restart
waves:
  - id: tier1
    features:                       # static, explicit
      - title: "..."; from_items: [P-001]; assigned_role: worker
  - id: tier2
    blocked_by: tier1
    generate:                       # generative — resolved AFTER tier1 drains
      for_each: universal_type      # a named runtime set the promote step queries
      feature_template:
        title: "Universal schema: {item}"
        acceptance: "..."; agent_hint: "..."
```

**Wave advancement is deterministic — no orchestrator judgment** (owner-designed):
- Wave N is **drained** ⟺ `count(features WHERE source_plan=P AND wave=N AND status NOT IN ('passed','deprecated')) = 0`.
- On drain → the **next wave auto-promotes** (static = create listed; generative = expand `for_each` against
  the runtime set, then create), and a **wave cursor** (`current_wave` on `harness_plan_status`) advances once
  (idempotent; promote is idempotent).
- **Hard-block on failure:** "drained" means all-terminal (`passed` OR `deprecated`), so a `failing`/stuck
  feature blocks the next wave. To skip, explicitly `deprecate` it.
- The **AutoLoop** (`lib/autoloop.ts`, ~30s ticker → director) is the clock that evaluates the drain-check
  per started plan; it makes no wave judgment.

**Blocked-wave surfacing reuses existing machinery (deterministic):** the `not_stuck` reader
(`harness-readers.ts`: `failing>0 && inProgress===0`) scoped to `(plan, wave)`, plus per-feature
`attempt_count >= N`, raises a **harness issue** → the **operator scanner** (`operator:scan`) surfaces it to
the user, as it does today. **Per-wave progress** = the existing feature counts filtered per wave, shown on
the started plan (extend the promote-status line) + the harness UI.

**Execution roles:** the `## Promote` policy is the plan-resident source of truth; a **promote agent**
(launched via the existing `plans:launch`) reads it and executes via `plans:promote` for the dynamic parts
(generative expansion, staging). The deterministic drain-advance is wired into the autoloop/director.

See the consuming plan's §9a for the full dogfood narrative: `Restart/docs/plans/universal-schema-2026-05-30.md`.

## Phase A — `## Promote` policy parser

- **P-001** `done` zod schema + `parsePromotePolicy(planRaw)` in
  `apps/operator/lib/agent-tools/plans/promote-policy.ts` (operator-side, off `ParsedPlan.raw` — the pure
  `@papercusp/plan-parser` is left dep-free). Extracts the `## Promote` section's fenced ```yaml|json block →
  `{ target_harness?, defaults?, waves: [{ id, blocked_by?, features?, generate? }] }`. Fail-safe: no block →
  null/no-warning; malformed → null + warnings (never throws). Validates unique wave ids + blocked_by refs.
- **P-002** `done` 8 unit tests (`promote-policy.test.ts`): static/generative/blocked_by, unfenced + JSON
  bodies, empty-wave + dup-id + bad-ref warnings, malformed-YAML no-throw, numbered heading. (Caught a real
  bug: JS regex has no `\Z` — was truncating sections at a literal "Z".) A `plans:lint` rule for the block is
  deferred to when lint touches promote (low priority — the parser already collects warnings).

## Phase B — feature wave tag + cursor (schema)

- **P-003** `done` Migration `089-promote-waves.sql`: `wave TEXT` on
  `harness_shared.harness_features_consolidated` (consolidated-only + back-written by the import handler,
  exactly like `source_plan_slug` in 084 — NOT a per-harness ALTER; the sync trigger doesn't list it so
  per-harness updates never clobber it) + a `(source_plan_slug, wave)` partial index for the drain-check;
  and `current_wave TEXT` on `harness_shared.harness_plan_status`. Idempotent, no DO blocks. Applies via the
  embedded-pg migration runner on boot. (D-006.)
- **P-004** `done` Confirmed `ensure-schema.ts` does NOT redefine `harness_plan_status` /
  `harness_features_consolidated` (they're migration-owned), so no ensure-schema change is needed. Null-wave
  back-compat (un-waved feature → treated as the implicit wave) is handled in the reader/drain logic (Phase D).

## Phase C — extend `plans:promote` (payload + policy execution)

- **P-005** `done` (a) `/features/import` (`features.ts`) accepts + back-writes `wave` to consolidated,
  mirroring `source_plan_slug` (ProvenanceFeature.wave + updater `SET wave` + the withProvenance mapping);
  10 provenance tests. (b) `plans:promote` (`promote.ts`) carries a top-level `wave` (stamped on each import
  entry) + per-feature `assigned_role`/`blocked_by`/`order` hints (→ `metadata`); 20 existing promote tests
  still green, tsc clean. Additive — existing callers unaffected (wave/hints optional).
- **P-006** `done` Policy-driven promote mode wired into `plans:promote`: `features` + `harness_slug` are now
  optional; when `features` is omitted and a `wave` is given, the handler reads the plan's `## Promote` policy
  (`parsePromotePolicy`), finds the wave, and builds its features (`buildWaveFeatures` — static defs and/or
  the generative `for_each` template expanded over `generate_items`), falls back `harness_slug` →
  `policy.target_harness`, then runs the existing apply path stamping `wave`. New errors:
  no_promote_policy / unknown_wave / empty_wave / promote_input. Refactor: 11 `args.features` /
  9 `args.harness_slug` / 1 `args.wave` → policy-aware locals. tsc clean; 20 existing promote tests green
  (explicit-mode intact).
- **P-007** `done` (logic) The policy-mode resolution logic is fully unit-tested via `parsePromotePolicy`
  (Phase A, 8 tests) + `buildWaveFeatures` (P-006a: static / generative-expansion / no-items-warning / mixed,
  4 tests). A handler-level integration test (apply-path round-trip) is **deferred** — the promote handler is
  fetch/PG/plan-lock-coupled and there is no existing handler-test harness; the explicit path's helper tests
  + the pure-logic tests cover the behavior.

## Phase D — deterministic wave-advance

- **P-008** `done` Pure helpers in `lib/harness/waves.ts`: `isWaveDrained` (every in-wave feature terminal),
  `isWaveBlocked` (`failing>0 && inProgress===0`, or attempts≥threshold on a non-terminal), `waveCounts`
  (per-wave progress), `nextWaveToPromote(waves, cursor)` (null cursor→first, else the next; unknown→null).
  Status vocab matches harness-readers. **15 unit tests**, tsc clean.
- **P-009** `done` (wired, ⚠️ unverified-until-host-run) Orchestration `runWaveAdvanceTick(deps)` +
  decision (`decideWaveAdvance`) + live adapter `wave-advance-sweep-live.ts` (`liveWaveSweepDeps` queries
  `harness_plan_status` / consolidated, `readPlanBySlug`+`parsePromotePolicy`, `setCursor` UPDATE) +
  `ensureWaveAdvanceSweep` (mirror `harness-status-sweep`) registered in `bin/host-bootstrap.ts`. tsc clean;
  29 sweep/waves tests. **Two connection points pending:** `promoteWave` launches a `promote` role that
  doesn't exist yet (**Phase F**) — until then it 4xx's, the tick logs + doesn't advance (retries);
  `onBlocked` logs rather than raising a `harness_issues` row (**Phase E**). The sweep is a **no-op for every
  policy-less plan**, so wiring it is safe. Runtime not yet exercised against a live harness.
- **P-010** `done` Tests (`wave-advance-sweep.test.ts`, 7 tick tests + `waves.test.ts`, 22 = 29 green): drain
  → advance (`current wave drained → promotes the next wave`), failing feature → no advance/hard-block
  (`blocked current wave → onBlocked, no promote`), cursor idempotency (`cursor null → promotes THEN sets
  cursor` + `a failed promote does NOT advance the cursor`), in-flight guard (`un-populated current wave →
  waits`), and generative next-wave triggers expansion (the tick carries `needsItems`; the template×items
  expansion itself is covered by `buildWaveFeatures` under P-007).

## Phase E — blocked-wave detection + surfacing (reuse scanner/issues)

- **P-011** `done` Per-`(plan, wave)` readers: extend `harness-readers.ts` to compute wave-scoped (getWaveProgress wave-scoped readers in harness-readers.ts HEAD 2df9da841 + unit tests harness-readers-wave-progress.test.ts 5: grouping/null-wave/empty/unknown-status/error)
  `{total, passed, failing, inProgress, blocked}` + the `not_stuck`/blocked signal per wave.
- **P-012** `done` (2026-05-31, `27c92f3`) Deterministic issue raise: `wave-advance-sweep-live.onBlocked`
  resolves a `ProjectEntry` from `harnessSlug` (active workspace), and via the FS-canonical issue store
  (`loadIssuesOrSeed`/`saveIssues`, PG-mirrored — D-004) upserts a `(plan, wave)`-keyed row
  `I-WAVE-<plan>-<wave>` (`severity: major`, `source: 'system'`, `foundDuring: <plan>`, title
  `Wave "<wave>" blocked in <plan>`). Idempotent: re-block is a no-op; a human-closed row reopens. `IssueSource`
  gained a **`'system'`** member; only `SOURCE_ICON` (`IssuesPanel.tsx`) is a `Record<IssueSource>` (got a `Cpu`
  entry — runtime already had `?? Circle`); the other `SOURCE_*` maps key off different types. tsc-clean (only
  a pre-existing unrelated Virtualizer error in that file). _Runtime raise not yet observed against a live
  blocked wave — the deterministic decision path that calls it is host-verified (see ## Now)._ The
  `attempt_count >= N` variant (vs the existing time-based ">7d" / voice-only 3-consecutive alert) is still open.
- **P-013** `done` Per-wave progress on the started plan: extend the promote-status line (per-wave promote-status line waveSummaries, HEAD 2df9da841 + 4 tests in promote-pipeline.test.ts; FOUND+FIXED multi-wave re-promote idempotency bug — strip regex only ate 2 lines, orphaning wave lines 2..N)
  (`upsertPromoteStatusLine` in `promote.ts`) to render per-wave counts; surface the same in the harness UI
  (plan detail).

## Phase F — promote agent + first dogfood

- **P-014** `done` (authored + **run-verified 2026-05-31**) Promote-agent role: prompt at
  `libs/papercusp/packages/harness/prompts/promote.md` (deterministic executor — read the wave from EXTRAS,
  promote it via `plans:promote`; resolve the `for_each` set for generative waves; one wave per invoke; never
  fabricate features) + registered in `AGENT_ROLES` (`packages/agent-mcp/src/role-config.ts`; confirmed live in
  `roles_known`). **Run-verified** against the live sweep (see ## Now): with a started policy plan + real
  consolidated rows, the sweep waits while the wave is in-progress and, on drain, fires
  `wave-advance-sweep-live.promoteWave` → `/invoke?role=promote` (the Phase-F connection point) for the next
  wave. The agent-actually-runs tail is blocked by an invalid Anthropic key on the box (env, not the mechanism);
  EXTRAS wire-up (plan_slug/wave/needs_items) is sent as the prompt expects but unconfirmed end-to-end until the
  key is valid.
- **P-015** `todo` **First real dogfood:** author the `restart` `universal-schema-2026-05-30` plan's actual
  `## Promote` block (Tier-1 static + Tier-2 generative), promote Tier-1 into the `restart` harness, run it,
  and verify the deterministic wave-advance fires Tier-2 once Tier-1 drains. (Confirm `restart` is a registered
  harness first.)

## Decisions

- **D-001** Wave advance is **deterministic** (drain = no non-terminal features for the wave), not an
  orchestrator/LLM judgment. The autoloop/director only evaluates the condition.
- **D-002** **Hard-block on failure:** drained = `passed` OR `deprecated`; a `failing`/stuck feature blocks the
  next wave. Skipping requires an explicit `deprecate`. (Owner choice 2026-05-30.)
- **D-003** Generative waves are **resolved at promote time** against a runtime set (e.g. the discovered type
  axis), not hand-listed — `plans:promote` expands the `for_each` template.
- **D-004** **Reuse** the existing operator scanner + `harness_issues` for surfacing blocked waves /
  repeated-failures — do **not** build a new alert system. Per-wave progress reuses the existing readers.
- **D-005** The `## Promote` policy lives **in the plan** (plan-as-source-of-truth); a promote agent honors it.
  Fine-grained control is authored by the human/architect in the plan, not hard-coded.
- **D-006** `wave` is a **column on `harness_features_consolidated` only** (back-written by the import handler),
  not a per-harness `harness_features` column and not a `metadata` key — following the `source_plan_slug`
  precedent (migration 084). Avoids per-harness ALTERs; the sync trigger preserves it (not in its column list);
  queryable + indexable for the drain-check.
