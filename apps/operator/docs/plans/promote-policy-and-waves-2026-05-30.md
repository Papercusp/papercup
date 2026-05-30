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

**State:** Just created. The design is settled (see Background/Design); first implementation step is the
`## Promote` policy parser (Phase A). First real dogfood is the `restart` harness's
`universal-schema-2026-05-30` plan (in the Restart repo, §9a) — which is blocked on this mechanism.

**Next:** P-001 — define + parse the `## Promote` policy block in the plan parser.

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

- **P-001** `todo` Define the `## Promote` policy schema (zod) + parse the block in the plan parser
  (`apps/operator/lib/agent-tools/plans/parser.ts`) → `parsed.promote`: `{ target_harness?, defaults?,
  waves: Array<{ id, blocked_by?, features?: StaticFeature[], generate?: { for_each, feature_template } }> }`.
  StaticFeature = `{ title, from_items?, acceptance?, body?, assigned_role?, blocked_by?, order? }`. Tolerate
  absence (no `## Promote` → `parsed.promote = null`); never throw on a malformed block (collect lint warnings).
- **P-002** `todo` Parser unit tests: static-only wave, generative wave, blocked_by chains, malformed block →
  warning not throw, no-block → null. Plus a `plans:lint` rule that validates a present `## Promote` block.

## Phase B — feature wave tag + cursor (schema)

- **P-003** `todo` Migration in `libs/papercusp/libs/db/sql/<NNN>-promote-waves.sql`: add `wave TEXT NULL` to
  the per-harness `harness_features` (+ consolidated mirror via the existing trigger — confirm
  `001-shared.sql` copies it or extend), and `current_wave TEXT NULL` to `harness_shared.harness_plan_status`
  (the 086 table). Named `$body$` dollar-quotes in any DO blocks. Apply via embedded-pg migration runner.
- **P-004** `todo` `ensure-schema` + readers awareness of `wave` / `current_wave`; back-compat (null wave =
  un-waved feature, treated as wave `default`).

## Phase C — extend `plans:promote` (payload + policy execution)

- **P-005** `todo` Extend the import payload + `/api/harness/<slug>/features/import` handler to accept optional
  per-feature `wave`, `assigned_role`, `agent_hint`, `blocked_by`, `order`; persist to `wave` column +
  `metadata`. Extend `plans:promote` args (`promote.ts`) to carry them.
- **P-006** `todo` Policy-driven promote mode: `plans:promote { slug, wave }` reads `parsed.promote`, resolves
  the named wave — static → build `features[]` from the listed defs; generative → expand `for_each` against a
  provided/queried runtime set (e.g. the universal type axis) into `features[]` via the template — then runs
  the existing apply path (import + assertions + mark + write-back), stamping `wave` + the cursor.
- **P-007** `todo` Tests: static-wave promote, generative-wave expansion (mock runtime set), payload fields
  round-trip, idempotent re-promote (no dup features).

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
