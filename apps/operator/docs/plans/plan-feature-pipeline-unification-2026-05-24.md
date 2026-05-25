---
title: "Plan→Feature Pipeline Unification (v2)"
slug: plan-feature-pipeline-unification-2026-05-24
status: active
created: 2026-05-24
updated: 2026-05-24
owner: aviynw3@gmail.com
---

## Now

**State:** Phases A–F complete (P-001–P-031). P-032 soak **started 2026-05-25**: `scoper.outputMode: 'plan'` enabled in `sheets-clone/.harness/config.json`. Waiting for 1 week of live scoper proposal runs before flipping the default and retiring the legacy path (P-033–P-038).

**Next:** P-033–P-038 are blocked on the P-032 soak completing (~2026-06-01). Human review required: check `sheets-clone/.harness/proposals/` is empty (no new files) and that plan drafts appear in ProposalsPanel with `source: scoper` after the next scoper proposal run.

---
## Background

### The current state (verified from code)

Two pipelines today, both ending at the same feature queue:

**Path A — `plans:promote`** (`apps/operator/lib/agent-tools/coordination/tools/promote.ts`):
- Atomic: PUTs SPEC.md (adds `[SC-NNN]` criteria with `<!-- promoted from plans/<slug> -->` comments) + POSTs `/features/import` (creates F-AUTO-* with `metadata.source_plan` + `metadata.from_plan_items` + `metadata.covers`) + marks plan items done
- Scoper never involved
- Used by agents; no UI surface

**Path B — Proposals → SPEC → MODE=replan**:
- Scoper `MODE=proposal` writes `.harness/proposals/*.md`
- File watcher syncs to `harness_shared.harness_proposals_shared`
- ProposalsPanel shows cards with Accept/Reject
- Accept handler appends bullets to SPEC.md + auto-fires `invokeScoperBackground(project, 'replan')`
- `MODE=replan` reads SPEC, diffs against existing features, creates new F-* rows. Honors `metadata.covers` to skip already-covered criteria (the integration point with Path A)
- Used by novice users; no plan ever exists

### The gaps

1. **Plan-derived features lose their plan context.** Workers/validators/reviewers don't see `## Now`, decisions, or item body during execution.
2. **No promote write-back.** The plan body doesn't reflect which features shipped from it.
3. **No bidirectional UI.** Plan detail doesn't show feature status; feature surfaces don't link back to plan.
4. **Novice users have no way to file a custom proposal.** ProposalsPanel only has Accept/Reject/Replan-now — no "New" button. They can wait for the scoper to think of their idea, or jump to the brainstorm tab.
5. **Two pipelines, two audit trails, two surfaces to evolve.** Adding cost estimation / agent hints / blocked-by would have to land twice.

### The direction (D-006 + D-007)

Unify everything on the plan format. Proposals become a thin UI layer over draft plans. Two user tiers:

- **Advanced users**: open a terminal, work with agents directly. Write plans manually or via MCP, then `plans:promote`.
- **Novice users**: click "New" in the proposals panel → architect chat → answer a few clarifying questions → architect writes a plan draft → user clicks Accept → one-click `plans:promote`.

Both produce plans. Both flow through `plans:promote`. Both get plan-context-aware agents. One audit trail, one surface to evolve.

---
## Goals

1. **One structured surface**: all human-initiated and scoper-initiated work originates as a plan (status `draft` → `active` → `shipped`).
2. **Proposals panel becomes UI on draft plans** — same name (D-009), different storage.
3. **Novice user flow**: single prompt → architect chat → architect writes plan draft → one-click accept (D-006) → features land.
4. **Agent-initiated flow**: scoper `MODE=proposal` writes plan drafts (not `.harness/proposals/*.md`).
5. **Plan-derived features carry plan context** to all 4 prompt-assembly paths.
6. **Bidirectional UI** via `useSyncQuery('featuresConsolidated.bySlug')`.
7. **Legacy retirement**: `.harness/proposals/*.md` + `harness_proposals_shared` deprecated once empty.

---

## Design

### §1 — Provenance: use existing JSONB, add an index

**No new columns.** `plans:promote` already writes provenance to `metadata` JSONB on per-harness `harness_<slug>.harness_features`:
- `metadata.source_plan` (string) — the plan slug
- `metadata.from_plan_items` (string[]) — the P-NNN ids covered
- `metadata.covers` (string[]) — the SC-NNN ids in SPEC.md

This data is already synced to `harness_shared.harness_features_consolidated` via the trigger at `001-shared.sql:93`. The trigger copies `metadata` as-is — no schema changes needed.

```sql
-- Migration NNN: index for plan-provenance queries.
CREATE INDEX IF NOT EXISTS hfc_source_plan_idx
  ON harness_shared.harness_features_consolidated USING GIN (metadata jsonb_path_ops);

-- Optional expression index for the hot path (faster than GIN for equality):
CREATE INDEX IF NOT EXISTS hfc_source_plan_expr_idx
  ON harness_shared.harness_features_consolidated ((metadata->>'source_plan'))
  WHERE metadata ? 'source_plan';
```

The expression index makes `WHERE metadata->>'source_plan' = $1` fast. The GIN index supports more general JSONB queries (key existence, containment) for future needs.

**No trigger update needed**, no per-harness schema update, no backfill of new columns. The data is already correctly stored — we just need to query it.


### §2 — Promote write-back

When `plans:promote { apply: true }` succeeds, append a `## Promoted` block to the plan body listing each F-AUTO-* feature with its source P-NNN.

**Item-level idempotency** (D-002): the writer parses the existing block, extracts feature IDs already listed, and appends only new rows. Re-promoting the same items is a no-op. Promoting `[D,E]` from a plan that already has `[A,B,C]` in the block correctly appends `[D,E]` without touching the originals.

Format:
```markdown
## Promoted

<!-- plan-pipeline: do not edit this block manually -->
- [ ] F-AUTO-XXX — Title of feature A  <!-- P-001 -->
- [x] F-AUTO-YYY — Title of feature B  <!-- P-002 -->  ← flips when feature reaches `passed`
```

The `[x]` checkbox is updated reactively (§4) by the plan detail page; the block itself is owned by the promote write-back path.

Also calls `plans:set-now` to refresh the state line with counts:
> "3 features in-flight · 2 passed · 5 remaining"

### §3 — Agent context injection (4 prompt-assembly paths)

Verified callsites (v1's "wire into assembleFeaturePrompt" was wrong — that function doesn't exist):

| Path | Entry point | Mechanism |
|---|---|---|
| Chat (operator UI, agent-chats) | `apps/operator/lib/endpoint-route/routes/agent-chats/index.ts:233` | `assembleRolePrompt` + post-call append |
| PM dispatch | `apps/operator/lib/pm-dispatch.ts:256` | `assembleRolePrompt` + extras |
| Bash autonomous spawn | `libs/papercusp/packages/harness/run.sh:1197` (`invoke()`) | inline bash assembly; opt-in TS via `PAPERCUSP_USE_TS_PROMPT_ASSEMBLY=1` shells to `assemble-prompt.ts` |
| TS orchestrator | `libs/papercusp/packages/orchestrator/src/invoke.ts:480` | calls `buildPrompt({ extras, featureHistory, substrateContext, ... })` |

**New helper** at `apps/operator/lib/plan-context-for-feature.ts` (NOT in `packages/agent-mcp` — that package must remain transport-agnostic without filesystem coupling to `apps/operator/docs/plans/`):

```ts
export async function getPlanContextForFeature(
  db: Db,
  featureId: string,
  harnessSlug: string,
): Promise<string | null> {
  const row = await db.queryOne<{
    metadata: { source_plan?: string; from_plan_items?: string[] } | null;
  }>(sql`
    SELECT metadata
    FROM harness_shared.harness_features_consolidated
    WHERE feature_id = ${featureId} AND harness_slug = ${harnessSlug}
  `);
  const planSlug = row?.metadata?.source_plan;
  const itemIds = row?.metadata?.from_plan_items ?? [];
  if (!planSlug) return null;
  const planMd = await readPlanFile(harnessSlug, planSlug);
  if (!planMd) return null;
  return extractPlanContext(planMd, itemIds); // ≤1500 tokens
}
```

`extractPlanContext` returns: `## Now` block + last 3 decisions + item body for each id. Truncates with `[truncated]` marker at the budget.

**Wiring per path:**

- **Chat**: append result between `lockNotice` and `memorySection` under a `## Source Plan Context` heading (mirrors how `memorySection` is appended today).
- **PM dispatch**: same pattern after `assembleRolePrompt` returns.
- **TS orchestrator**: add `planContext?: string` to `BuildPromptInput` (parallel to `featureHistory` + `substrateContext`); fetch in `invoke.ts` before calling `buildPrompt`; concatenate at the end so it doesn't invalidate the cacheable preamble.
- **Bash invoke**: extend `assemble-prompt.ts` CLI to accept `--plan-context-file <path>` so the bash side can pass a pre-fetched file. For the legacy bash-inline path (default when `PAPERCUSP_USE_TS_PROMPT_ASSEMBLY=0`), shell out to a small CLI `get-plan-context-for-feature` that prints the block to stdout; `run.sh` cats it into the prompt assembly.


### §4 — Bidirectional UI via useSyncQuery

**Verified mechanism** (v1's "IPC EventSource" was one layer too low): components use `useSyncQuery` from `@restart/sync`. Confirmed at `apps/operator/app/harness/HarnessDashboard.tsx:3223`:

```ts
const { data: zeroFeatureRows, loading } = useSyncQuery<FeatureRow>({
  queryName: 'featuresConsolidated.bySlug',
  args: { harnessSlug: activeSlug },
  enabled: !!activeSlug,
});
```

The IPC transport is plumbed under `RootSyncProvider`; component code uses `useSyncQuery` directly.

**Plan detail page** (`apps/operator/app/admin/plans/PlanDetail.tsx`):
- Subscribe to `featuresConsolidated.bySlug` for the plan's harness
- Filter to features where `metadata.source_plan === <this plan's slug>`
- For each F-AUTO-* row in the `## Promoted` block, render the live status badge
- Auto-summary line: counts derived from the filtered rows

**Feature-side UI**: features render inline in `apps/operator/app/harness/HarnessDashboard.tsx` + `apps/operator/app/harness/FeatureList.tsx` (no `FeatureDetail.tsx` exists — v1 invented it). Add a `From plan: <slug>` pill in the feature row metadata when `metadata.source_plan` is set; clicking navigates to the plan detail page.

**Promote button** (D-006): on the plan detail page, a single "Promote to features" button calls `plans:promote` directly with the plan's items. One-click, no review intermediate.

### §5 — Architect: `promote:plan` action + clarifying-question guidance

The architect role today supports three action blocks (`apps/operator/lib/agent-tools/architect/prompts.ts:164`):
```
promote:feature  → create todo feature in harness_features
promote:spec     → insert into SPEC.md under ## Brainstormed
promote:issue    → file as issue in issues.json
```

**Add a fourth:** `promote:plan`. Format:
````
```promote:plan
title: <Plan title>
slug-hint: <kebab-case suggestion, server may append date>

## Now
state: …
next: …

## Phases

### Phase 1 — …

- P-001 <item text>
- P-002 <item text>

## Decisions

### D-001 — <decision title>

<body>
```
````

The architect emits this block when it has enough context to write a complete plan. The action handler:
1. Calls `plans:new { slug, title }` (server allocates date suffix if not present)
2. Calls `plans:set-now { state, next }`
3. For each item, calls `plans:add-item { phase, text }`
4. For each decision, calls `plans:add-decision { title, body }`
5. Plan is created with `status: draft`; appears as a proposal card in the panel.

**Architect persona update** (`apps/operator/prompts/architect.persona.md` — verify exact path during implementation):

> When a novice user gives you a one-line idea for new work, your job is to work with them so you can create a fully detailed plan they can ship. Keep in mind they're a novice — don't present them with technical details. Ask questions in plain language about what they want, who it's for, and what "done" looks like. Once you have enough to fill out a plan, emit a `promote:plan` block. Show them what you wrote in plain prose before they commit; let them say "looks good" or "actually change X" without having to learn the plan format.

No question-count guidance (D-008) — the architect uses judgment based on how specific the initial prompt is.


### §6 — ProposalsPanel rewrite

Name stays "Proposals" (D-009). Underlying storage flips from `harness_proposals_shared` to plans list filtered by `status: draft`.

**Reads:**
- Subscribe to a new sync-query `plansDrafts.bySlug` (returns plans where `status: draft` for the harness)
- Each row carries: plan slug, title, `## Now.state` summary, item count, source (`user` | `scoper`), created/updated timestamps

**UI:**
- Cards mirror today's proposal-card layout: title, short summary, source tag pill ("you" vs "scoper"), Accept / Reject / Edit / Dismiss buttons
- **New "New" button** at the top of the panel (the missing piece) — opens an architect chat modal pre-seeded with "user wants to file a new proposal for <harness>"
- Editing a card navigates to `/admin/plans/<slug>` (the existing plan detail page)
- Dismissing is non-destructive (hides locally); Reject sets `plans:set-frontmatter status=dropped`

**Accept = one-click `plans:promote`** (D-006):
- Confirmation modal: "Promote <N> items to features?" + Cancel/Confirm
- On Confirm: call `plans:promote { slug, harness_slug, features: <derived from plan items>, apply: true }`
- Features derived from items: each `P-NNN` item becomes a feature with title = item text, body = item details if present, `from_items: [P-NNN]`, acceptance bullets pulled from the plan if structured that way
- Toast on completion: "Promoted N features. Worker will pick up shortly."

**Backwards compat during migration:**
- During Phase F soak, also subscribe to legacy `harness_proposals_shared` and merge results
- Once Phase G ships, drop the legacy query

### §7 — Scoper `MODE=proposal` rewrite

Today: `MODE=proposal` writes `.harness/proposals/<id>.md`. After Phase F it writes a plan draft via `plans:*` MCP calls.

**Trigger conditions unchanged:**
- Scheduled (`autoloop` ticker)
- Triggered post-`DONE` event from worker
- User clicks "replan now" button in proposals panel

**Output flow (new):**
1. Scoper assesses SPEC + features + recent validator findings (same as today)
2. For each gap it identifies, generates a plan draft:
   - `plans:new { slug: 'scoper-proposal-<topic>-<date>', title }` — `status: draft`
   - `plans:set-now { state, next }`
   - `plans:add-item` per scoped item
   - `plans:add-decision` for any non-obvious choice it made while drafting
3. Plan appears in the panel with `source: scoper` tag

**Per-harness config gate** (D-004) — initial rollout is opt-in:
```json
// .harness/config.json
{
  "scoper": {
    "outputMode": "plan"  // or "proposal" (default, legacy)
  }
}
```

Default stays `proposal` until Phase F soaks; flip to `plan` after.

**`MODE=replan` unchanged** — already correctly honors `metadata.covers` to avoid duplicating plan-promoted features. The integration point that exists today keeps working.

### §8 — Legacy retirement

- File watcher (`apps/operator/lib/harness-fs-watcher.ts:7`) keeps syncing `.harness/proposals/*.md` → `harness_shared.harness_proposals_shared` during Phase F soak (handles any in-flight proposals when the flag flips)
- After 5+ days no new proposal files: deprecate watcher path
- Rename table `harness_proposals_shared` → `_legacy_proposals` (no drop — pre-alpha but proposal text may be referenced elsewhere)
- ProposalsPanel drops the legacy query subscription

---
## Phases

### Phase A — Schema index + promote write-back (1–2 days)

- [x] P-001 Migration: GIN index on `harness_shared.harness_features_consolidated.metadata` + expression index on `metadata->>'source_plan'`
- [x] P-002 Promote write-back: parse existing `## Promoted` block, item-level idempotent append, bump `## Now` with counts
- [x] P-003 Backfill script `scripts/migrations/backfill-plan-promoted-blocks.ts`: for each plan that already promoted features (detected via `metadata.source_plan` query), append `## Promoted` block using `plans:set-content`
- [x] P-004 `plans:lint` check: if features point at the plan but block is missing, emit **warning** for plans dated before migration; **error** for plans dated after (D-005)
- [x] P-005 Tests: promote round-trip; second promote appends incrementally; backfill produces lint-passing plans

### Phase B — Agent context injection across 4 paths (2 days)

- [x] P-006 `getPlanContextForFeature()` at `apps/operator/lib/plan-context-for-feature.ts`
- [x] P-007 Wire chat path: `agent-chats/index.ts` injects planContextSection between lockNotice and memorySection
- [x] P-008 Wire PM dispatch: `getPlanContextsForFeatures()` in `plan-context-for-feature.ts`; injected in `pm-dispatch.ts` after `assembleRolePrompt`; deduplicates by plan slug, 4000-char budget
- [x] P-009 Wire TS orchestrator: `planContext?: string` added to `BuildPromptInput`; step 8.10 in `invoke.ts` fetches via HTTP from operator; passed to `buildPrompt`
- [x] P-010 Wire bash invoke: `assemble-prompt.ts` accepts `--plan-context-file`; `get-plan-context.ts` CLI created; `run.sh` fetches and injects for worker/validator/reviewer
- [x] P-011 Token-budget guard: 6000-char truncation already in `getPlanContextForFeature` (satisfied)
- [x] P-012 Tests: 12/12 operator plan-context-for-feature tests (commit `5573bf07`)

### Phase C — Bidirectional UI (2 days)

- [x] P-013 Plan detail (`apps/operator/app/admin/plans/PlanDetail.tsx`): subscribe to `featuresConsolidated.byPlanSlug`, render live status badges on `## Promoted` block rows via `decoratePromotedBlock` in `plan-renderers.ts`
- [x] P-014 Plan detail: `NowHero` shows feature-count summary ("N features: M in-flight · K passed · …") from `promotedFeatures` via `buildFeatureSummary()`
- [x] P-015 Feature surfaces (`apps/operator/app/harness/FeatureList.tsx`): `↗ plan` pill on feature rows where `sourcePlanSlug` is set; links to `/adv/plans?slug=…`
- [x] P-016 Promote button on plan detail (calls `plans:promote` directly with derived features list)
- [x] P-017 Tests: status change on a promoted feature propagates to plan detail badge within 2s


### Phase D — Architect: `promote:plan` action + clarifying-question guidance (2 days)

- [x] P-018 Add `promote:plan` action block to architect prompt template (`apps/operator/lib/agent-tools/architect/prompts.ts`)
- [x] P-019 Implement action handler: `plan-block-handler.ts` — parses block, calls plans:new → set-now → add-item × N → add-decision × N; no rollback needed (plan stays draft on partial failure)
- [x] P-020 Update architect tools (`apps/operator/prompts/architect.tools.md`): clarifying-question guidance per D-008; "Create a plan from user conversation" workflow
- [x] P-021 Tests: 13/13 parsePlanBlock + applyPlanBlock tests in `plan-block-handler.test.ts`

### Phase E — ProposalsPanel rewrite (2–3 days)

- [x] P-022 New sync-query `plansDrafts.bySlug` returning plans where `status: draft`, with item count + source tag
- [x] P-023 ProposalsPanel reads from `plansDrafts.bySlug` (initially merged with `harness_proposals_shared` during transition)
- [x] P-024 Source-tag pill on each card ("you" vs "scoper")
- [x] P-025 **New "New" button** at top of panel — opens architect chat modal pre-seeded with proposal-creation context
- [x] P-026 Edit button navigates to `/adv/plans?slug=<slug>` (plan detail page)
- [x] P-027 Accept button = confirm modal → `fetchPlan` → derive features from items → `promoteToHarness({ apply: true })`
- [x] P-028 Reject button = `rejectDraftPlan(slug)` → CAS set-content flipping `status: draft` → `status: superseded`
- [x] P-029 Tests: New flow end-to-end (click New → architect chat → emit promote:plan → card appears → Accept → features land)

### Phase F — Scoper `MODE=proposal` → plan output (2 days + 1 week soak)

- [x] P-030 Scoper persona/tools update: emit plan drafts via `plans:*` MCP when `outputMode: 'plan'`
- [x] P-031 Per-harness config gate: `.harness/config.json` → `scoper.outputMode` (default `proposal`, opt-in `plan`)
- [~] P-032 Run end-to-end on the dogfood harness for 1 week with `outputMode: 'plan'`; collect bugs — **soak started 2026-05-25 on sheets-clone**; complete ~2026-06-01
- [ ] P-033 Once stable, flip default to `plan`

### Phase G — Legacy retirement (after Phase F soak)

- [ ] P-034 Verify no new proposal files entered `harness_proposals_shared` for 5 consecutive days
- [ ] P-035 Deprecate the watcher path in `harness-fs-watcher.ts` for `.harness/proposals/*.md`
- [ ] P-036 Rename `harness_proposals_shared` → `_legacy_proposals` (no drop; pre-alpha but readable history matters)
- [ ] P-037 ProposalsPanel drops the legacy query subscription
- [ ] P-038 Remove `.harness/proposals/` from watcher's tracked paths

**Critical path:** Phase A + B must land before any `papercusp-dogfood-v5` end-to-end run that exercises plan-derived features (P-026 in the dogfood plan). Phases C–G can run in parallel with dogfood Phase 5a.

---
## Decisions

### D-001 — Use existing JSONB `metadata` + indexes, no new columns

`plans:promote` already writes `metadata.source_plan` / `metadata.from_plan_items` / `metadata.covers` to per-harness `harness_features.metadata` (JSONB). The trigger at `001-shared.sql:93` syncs `metadata` as-is to consolidated. Add a GIN index + an expression index; no schema migration, no trigger update, no backfill of column values.

**Why this beats v1's "add columns" approach:** v1 named the wrong column (`metadata_json` doesn't exist — actual column is `metadata`) and wrong metadata keys (`source_plan_slug` / `source_plan_item_ids` — actual keys are `source_plan` / `from_plan_items`). Even if those names were right, adding columns to consolidated requires also adding them to per-harness `harness_features` AND updating the trigger to copy them — three coordinated changes for data that's already correctly stored. JSONB + indexes is the minimum-coordination solution.

### D-002 — Promote write-back is mandatory and item-level idempotent

`plans:promote apply=true` always appends to `## Promoted`. Re-promoting same items is a no-op; promoting new items appends without touching old rows.

### D-003 — Plan context flows into all 4 prompt-assembly paths

Chat, PM dispatch, TS orchestrator, bash invoke (legacy + opt-in TS). v1 named only one non-existent `assembleFeaturePrompt`. Four paths exist in code today; each gets the appropriate hook.

### D-004 — Scoper output mode is per-harness config

`.harness/config.json` → `scoper.outputMode: 'plan' | 'proposal'`. Avoids a process-global env flag flipping all harnesses at once during transition.

### D-005 — `plans:lint` rule for `## Promoted` is warning before migration, error after

Pre-existing plans get backfilled by P-003. The lint rule checks plan's `created:` frontmatter vs. migration version; older plans emit a warning, newer plans an error. CI doesn't break on day one.

### D-006 — Accept = one-click `plans:promote` (Option A)

Confirmed by user: no review intermediate. Confirmation modal only ("Promote N items?" + Cancel/Confirm). Settings preference for "skip confirmation" deferred — not in this plan.

### D-007 — Architect role drives novice proposal creation

Architect already serves both `architect:chat` and `brainstorm:chat` (`apps/operator/lib/agent-tools/architect/chat.ts:1-2`). Reuse for novice proposal authoring rather than adding a new role.

### D-008 — Clarifying-question guidance has no question-count

Persona text: "work with the user so you can create a fully detailed plan; keep in mind they're a novice — don't present them with technical details." Question count left to architect's judgment based on initial-prompt specificity.

### D-009 — Keep the name "Proposals"

Panel name doesn't change. Underlying storage switches from `harness_proposals_shared` to draft plans. Source-tag pill ("you" vs "scoper") distinguishes origin.

### D-010 — Hard unification (Option 3), not Option 1 (keep separate)

After audit revealed the proposal pipeline is structurally a poorer version of plans (no decisions, no `## Now`, no item dependencies, no revision history, no agent context injection), converging on the plan format is the better target. Pre-alpha policy makes today the right time — the longer we wait the more code accrues around the duplication.

---
## Code-audit corrections (v1 → v2)

The first draft had 8 inaccuracies that would have caused implementation failures or wasted work. All corrected here:

| # | v1 claim | v2 correction (code evidence) |
|---|---|---|
| 1 | Column is `metadata_json` | Column is `metadata` (`001-shared.sql:72`) |
| 2 | Metadata keys are `source_plan_slug` + `source_plan_item_ids` | Actual keys are `source_plan` + `from_plan_items` + `covers` (`promote.ts:317-327`) |
| 3 | `WHERE id = ${featureId}` | Column is `feature_id`, PK is `(harness_slug, feature_id)` (`002-per-harness-template.sql:6-36`) |
| 4 | Add columns to consolidated | Consolidated is trigger-maintained from per-harness `harness_features` (`001-shared.sql:93-122`) — adding columns requires coordinating both tables AND the trigger. Use JSONB indexes instead. |
| 5 | Phase D = scoper "plan mode" replacing proposals | `MODE=replan` already auto-creates features from SPEC and honors `metadata.covers` from plans:promote-imported features (`scoper.md:65,205,219`). The real unification is making proposals = draft plans, not making scoper write plans. |
| 6 | "Wire into `assembleFeaturePrompt`" | That function doesn't exist. 4 prompt-assembly paths exist in code: agent-chats, pm-dispatch, run.sh bash inline, TS orchestrator's `buildPrompt`. Each gets its own hook (P-007–P-010). |
| 7 | "Subscribe via IPC EventSource" | Components use `useSyncQuery` from `@restart/sync` (`HarnessDashboard.tsx:3223`). IPC EventSource is one transport layer below. |
| 8 | `PlanDetail.tsx` + `FeatureDetail.tsx` exist as named | `PlanDetail.tsx` exists at `apps/operator/app/admin/plans/`. `FeatureDetail.tsx` does NOT exist — features render inline in `HarnessDashboard.tsx` + `FeatureList.tsx`. |

One reviewer point in the v1 review was incorrect: `harness_shared.harness_proposals_shared` DOES exist (confirmed `017-harness-shared-phase-and-proposal-cols.sql:49`). Per-harness `harness_proposals` was retired earlier.

---

## Related Plans

- `papercusp-dogfood-v5-2026-05-23.md` — parent plan; this is its Phase 4.5 gate
- `plans-harness-scoped-2026-05-24.md` — HYPERBEE-backed plans for shared harnesses (downstream)
- `proxy-witness-pattern-2026-05-24.md` — spend verification infrastructure (unrelated)
