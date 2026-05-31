---
title: "Promote policy + staged/generative waves (fine-grained plan→feature control)"
slug: promote-policy-and-waves-2026-05-30
status: active
created: 2026-05-30
updated: 2026-05-30
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

**Next:** Phase D — the deterministic wave-advance: pure drain/blocked helpers (`lib/harness/waves.ts`) +
wiring the autoloop/director to promote the next wave when the current one drains.

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

- **P-008** `todo` Pure helpers in `lib/harness/waves.ts`: `isWaveDrained(features, wave)` (no non-terminal),
  `currentWave(plan)` / `nextWave(policy, cursor)`, `isWaveBlocked(features, wave)` (`failing>0 &&
  inProgress===0`). 100% unit tests.
- **P-009** `todo` Wire the drain-advance into the autoloop/director: each tick, for each `started` plan with a
  `## Promote` policy, if `current_wave` is drained and a next wave exists → promote it (P-006) + bump
  `current_wave`. Idempotent (cursor guard). Document where it sits relative to the director invoke.
- **P-010** `todo` Tests: drain → advance, failing feature → no advance (hard-block), cursor idempotency,
  generative next-wave triggers expansion.

## Phase E — blocked-wave detection + surfacing (reuse scanner/issues)

- **P-011** `todo` Per-`(plan, wave)` readers: extend `harness-readers.ts` to compute wave-scoped
  `{total, passed, failing, inProgress, blocked}` + the `not_stuck`/blocked signal per wave.
- **P-012** `todo` Deterministic issue raise: blocked-wave (`isWaveBlocked`) and `attempt_count >= N` (N
  configurable, default 3) → create/update a `harness_issues` row (`harness-issues.ts`) keyed by
  `(plan, wave[, feature])` so the **operator scanner** surfaces it (dedup by id). Today's stuck-detection is
  time-based (">7d") / the 3-consecutive alert is voice-only — this adds the feature-attempt + wave path.
- **P-013** `todo` Per-wave progress on the started plan: extend the promote-status line
  (`upsertPromoteStatusLine` in `promote.ts`) to render per-wave counts; surface the same in the harness UI
  (plan detail).

## Phase F — promote agent + first dogfood

- **P-014** `todo` Promote-agent persona/role: "read the plan's `## Promote` policy and execute it via
  `plans:promote` per wave; for generative waves, source the runtime set." Lives under `apps/operator/prompts/`
  + wired so `plans:launch` can target it.
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
