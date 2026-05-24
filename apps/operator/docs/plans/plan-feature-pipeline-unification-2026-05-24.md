---
title: "Plan→Feature Pipeline Unification"
slug: plan-feature-pipeline-unification-2026-05-24
status: active
created: 2026-05-24
updated: 2026-05-24
owner: aviynw3@gmail.com
---

## Now

**State:** Draft — reviewed by second agent, corrected, not yet implemented.

**Next:** User approves D-001–D-005; agent starts Phase A (schema migration + promote write-back).

---
## Background

Three disconnected pipelines exist today:

### 1. The `plans:*` framework (new)
Plans live as markdown at `apps/operator/docs/plans/`. The `plans:promote` tool
(`apps/operator/lib/agent-tools/coordination/tools/promote.ts`) can batch-promote
plan items into harness features. However:
- Provenance is stored in unstructured JSONB metadata, not first-class columns
- `plans:promote` does **not** write back to the plan body (no "promoted" marker)
- Workers receive no plan context when executing a promoted feature

### 2. The legacy proposal pipeline
`invokeScoperBackground` writes `.harness/proposals/*.md` → synced to
`harness_shared.harness_proposals_shared` → shown in `ProposalsPanel` → user
manually promotes to features. This is the path novice users encounter. It uses
none of the plan infrastructure.

### 3. Features with no plan origin
Most existing features have no upstream plan record at all.

### The gap
The plan system was designed so that once a plan is ready, it feeds into the
feature queue and agents pick it up. That loop was never closed:
- No first-class plan→feature column link
- No promote write-back to the plan body
- Agents don't see plan context during execution
- Scoper ignores the plans framework entirely

This plan closes all three gaps.

---
## Goals

1. **First-class provenance**: promoted features carry `source_plan_slug` +
   `source_plan_item_ids` as indexed columns, not buried in JSONB.
2. **Promote write-back**: `plans:promote apply=true` stamps the plan body with
   a `## Promoted` block (item-level idempotent) and updates `## Now`.
3. **Agent context injection**: worker, validator, and reviewer roles receive
   the source plan's `## Now`, recent decisions, and item body automatically
   via the `extras` parameter to `assembleRolePrompt`.
4. **Bidirectional UI view**: plan items show their derived feature status;
   feature detail links back to the plan item.
5. **Scoper writes plans**: `invokeScoperBackground` gains a `plan` mode that
   produces a plan draft instead of a raw proposal file.
6. **Graceful migration**: existing features without a plan origin continue
   unchanged. The legacy proposals path stays alive during transition.

---
## Design

### §1 — Schema: first-class plan provenance

```sql
-- Migration NNN: promote plan provenance to first-class columns.
-- Table lives in harness_shared schema (confirmed: 001-shared.sql:63).
ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS source_plan_slug      TEXT,
  ADD COLUMN IF NOT EXISTS source_plan_item_ids  TEXT[];

CREATE INDEX IF NOT EXISTS hfc_source_plan_slug_idx
  ON harness_shared.harness_features_consolidated (source_plan_slug)
  WHERE source_plan_slug IS NOT NULL;

-- Backfill from existing JSONB metadata where present.
UPDATE harness_shared.harness_features_consolidated
SET
  source_plan_slug     = metadata_json->>'source_plan_slug',
  source_plan_item_ids = ARRAY(
    SELECT jsonb_array_elements_text(metadata_json->'source_plan_item_ids')
  )
WHERE metadata_json ? 'source_plan_slug'
  AND source_plan_slug IS NULL;

-- Backfill the ## Promoted block for any plan whose items were already
-- promoted before this migration (avoids lint errors on day one — see D-005).
-- Executed as a Node migration step, not raw SQL, because it requires
-- reading plan files from disk and calling plans:set-content.
-- See: scripts/migrations/backfill-plan-promoted-blocks.ts
```

`metadata_json` retains its values (no deletion). The new columns are the
query surface going forward.


### §2 — Promote write-back

When `plans:promote { apply: true }` runs it currently:
1. PUTs the new SPEC.md
2. POSTs features to `/features/import`
3. Marks `from_items` as `done` in the plan

**Added in this plan:**

4. Reads the current `## Promoted — <date>` block (if any) and extracts the
   feature IDs already listed. Appends only *new* feature IDs — idempotency is
   **item-level**, not block-level. This means a second call promoting [D,E]
   from a plan that already has [A,B,C] in the block correctly appends [D,E]
   without duplicating A/B/C.
5. Calls `plans:set-now` to update the state line with the number of features
   in-flight vs. passed vs. remaining.

Block format:
```markdown
## Promoted

<!-- plan-pipeline: do not edit this block manually -->
- [ ] F-001 — Title of feature A  <!-- P-001 -->
- [x] F-002 — Title of feature B  <!-- P-002 -->  ← checked when feature reaches `passed`
```

The `[x]` checkbox is updated by a Zero/IPC listener that watches feature
status changes (see §4).


### §3 — Agent context injection

**Actual injection point** (verified from codebase):

The function is `assembleRolePrompt` from
`@papercusp/orchestrator/role-prompt` (`libs/papercusp/packages/orchestrator/src/role-prompt-from-slug.ts`).
It accepts an `extras: string[]` array for runtime-context bullets and supports
appending blocks after the call returns (the same pattern used for `memorySection`
and `lockNotice` in the agent-chats route).

**New helper** at `apps/operator/lib/plan-context-for-feature.ts`
(NOT in `packages/agent-mcp` — that package must not have filesystem deps
into `apps/operator/docs/plans/`):

```ts
// apps/operator/lib/plan-context-for-feature.ts
export async function getPlanContextForFeature(
  db: Db,
  featureId: string,
  harnessSlug: string,
): Promise<string | null> {
  const row = await db.queryOne<{
    source_plan_slug: string | null;
    source_plan_item_ids: string[] | null;
  }>(sql`
    SELECT source_plan_slug, source_plan_item_ids
    FROM harness_shared.harness_features_consolidated
    WHERE id = ${featureId} AND harness_slug = ${harnessSlug}
  `);
  if (!row?.source_plan_slug) return null;
  const planMd = await readPlanFile(harnessSlug, row.source_plan_slug);
  if (!planMd) return null;
  return extractPlanContext(planMd, row.source_plan_item_ids ?? []);
}
```

`extractPlanContext` returns ≤1,500 tokens of: the `## Now` block, last 3
decisions, and the item body for each id in `source_plan_item_ids`.

**Callsites to update:**
- `apps/operator/lib/endpoint-route/routes/agent-chats/index.ts` — append the
  result after `assembleRolePrompt` returns, between `lockNotice` and
  `memorySection`, under a `## Source Plan Context` heading.
- Any autonomous spawn path that calls `assembleRolePrompt` with role
  `worker` / `validator` / `reviewer` (check `pm-dispatch.ts` and run.sh
  orchestrator paths) — pass plan context via `extras` or post-call append.


### §4 — Bidirectional UI view

**Current real-time mechanism**: IPC EventSource via `RootSyncProvider`
(NOT Zero — Zero is legacy per project history). Feature status changes
propagate via `IpcEventSource` → `RootSyncProvider` → component re-render.

**Plan side** (plan detail page):
- Each item in the `## Promoted` block becomes a live row showing the feature's
  current status badge. The component subscribes to feature status via the IPC
  EventSource path and updates the checkbox state when a feature reaches `passed`.
- Auto-summary line in `## Now`: `"3 features in-flight · 2 passed · 5 remaining"`
  — derived from `harness_shared.harness_features_consolidated` counts.

**Feature side** (feature detail page):
- If `source_plan_slug` is set, a `From plan` pill links to the plan detail page.
- The source item text is shown as a collapsible `Plan context` section.
- P-item: add a **"Promote to features"** button on the plan detail page so
  non-technical users can trigger `plans:promote` without MCP access (see D-005).

Both views need no new API routes — plan data is filesystem reads (plan detail)
and feature status comes from the existing `harness_features_consolidated` query.


### §5 — Scoper migration: from proposals to plan drafts

`invokeScoperBackground` gains a new mode flag `outputMode: 'plan' | 'proposal'`.

**`proposal` mode** (existing behaviour, unchanged):
- Writes `.harness/proposals/<slug>.md`
- Syncs to `harness_shared.harness_proposals_shared`
- Shows in ProposalsPanel as before

**`plan` mode** (new):
1. Scoper generates a structured plan using `plans:new` + `plans:add-item` calls
2. Plan is created with `status: draft`
3. ProposalsPanel is replaced by (or redirected to) the Plans list filtered to
   `status: draft`
4. User reviews, edits if needed, then clicks "Promote to features"

The plan text is generated in **one LLM call per natural section** (see §6).

The legacy path stays alive during transition. Retirement (Phase E) happens once
no new proposals have entered `harness_proposals_shared` for 5 consecutive days.

Note: `harness_proposals_shared` lives at `harness_shared.harness_proposals_shared`
(confirmed from `017-harness-shared-phase-and-proposal-cols.sql`). The per-harness
`harness_proposals` table was already retired prior to this plan.

### §6 — Scoper chunk-size guidance

**Per-harness config** (not a process-global env var — see D-004):
```json
// .harness/config.json
{
  "scoper": {
    "outputMode": "plan"
  }
}
```

**Cost model** (Sonnet 4.6):

| Strategy | Calls | Approx total tokens | Approx cost |
|---|---|---|---|
| All-at-once (10 items) | 1 | ~13K in / 3K out | ~$0.085 |
| Per-item chunked (10 items) | 10 | ~115K in / 3K out | ~$0.39 |
| Section-chunked (2×5 items) | 2 | ~27K in / 3K out | ~$0.13 |

With prompt caching: all-at-once ~$0.042, per-item ~$0.16, section-chunked ~$0.065.

**Decision (D-003):** Generate all-at-once for plans ≤15 items. Section-chunked
at natural phase breaks for larger plans (≤12 items per section). Per-item
generation is only for *writing* (`plans:add-item` API calls, not LLM calls).

---
## Phases

### Phase A — Schema + promote write-back (1–2 days)

- [ ] P-001 SQL migration: `ADD COLUMN source_plan_slug TEXT` + `source_plan_item_ids TEXT[]` on `harness_shared.harness_features_consolidated`; index; backfill from `metadata_json`
- [ ] P-002 Node backfill script `scripts/migrations/backfill-plan-promoted-blocks.ts`: for each plan that already has promoted features (detected via `source_plan_slug` backfill), write a `## Promoted` block to the plan file using `plans:set-content`
- [ ] P-003 Update `plans:promote` apply path to populate the new columns (not just `metadata_json`)
- [ ] P-004 Promote write-back: item-level idempotent — parse existing `## Promoted` block, diff against new feature IDs, append only new rows; call `plans:set-now` with counts
- [ ] P-005 `plans:lint` check: if plan has promoted items, `## Promoted` block must exist — emit **warning** (not error) for plans promoted before migration version; error only for plans promoted after
- [ ] P-006 Tests: promote round-trip; second promote appends new items without duplicating old ones; backfill script produces valid lint-passing plans

### Phase B — Agent context injection (1 day)

- [ ] P-007 Find all `assembleRolePrompt` callsites where role is `worker`, `validator`, or `reviewer` (confirmed: `agent-chats/index.ts`, `pm-dispatch.ts`, and any autonomous spawn paths)
- [ ] P-008 Implement `getPlanContextForFeature()` at `apps/operator/lib/plan-context-for-feature.ts` (§3 spec; reads from `harness_shared.harness_features_consolidated` + plan filesystem)
- [ ] P-009 Wire into each callsite: fetch plan context after `assembleRolePrompt`, append under `## Source Plan Context` heading (same pattern as `memorySection`)
- [ ] P-010 Add token-budget guard: truncate to ≤1,500 tokens with `[truncated]` marker
- [ ] P-011 Tests: prompt assembly includes plan context when `source_plan_slug` is set; absent when not; truncation fires at budget


### Phase C — Bidirectional UI (1–2 days)

- [ ] P-012 Plan detail: live feature-status badges on promoted items via IPC EventSource / RootSyncProvider (NOT Zero)
- [ ] P-013 Plan detail: `## Now` auto-summary line (in-flight / passed / remaining counts from `harness_features_consolidated`)
- [ ] P-014 **"Promote to features" button** on plan detail page — calls `plans:promote apply=true` for plans in `status: draft` or `status: active`; disabled with tooltip if plan has no un-promoted items
- [ ] P-015 Feature detail: `From plan` pill linking to plan detail page (shown when `source_plan_slug` is set)
- [ ] P-016 Feature detail: collapsible `Plan context` section showing source item text
- [ ] P-017 Tests: IPC update propagates to plan detail status badge within 2s; promote button triggers correct API call

### Phase D — Scoper migration (2–3 days)

- [ ] P-018 Add `outputMode: 'plan' | 'proposal'` to `invokeScoperBackground`; default `proposal` (no behaviour change)
- [ ] P-019 Implement `plan` mode: call `plans:new` for the draft; generate items all-at-once (or section-chunked per §6); write via `plans:add-item`
- [ ] P-020 Gate `plan` mode via per-harness config field `scoper.outputMode` (not a process-global env var)
- [ ] P-021 ProposalsPanel: when `outputMode: plan`, redirect to Plans list filtered to `status: draft`
- [ ] P-022 Tests: scoper plan mode produces a valid lint-passing draft plan; ProposalsPanel redirect works

### Phase E — Dogfood + legacy retirement (1 week soak)

- [ ] P-023 Run Phase D on the dogfood harness for 1 week; collect bugs
- [ ] P-024 Once no new rows enter `harness_shared.harness_proposals_shared` for 5 days, flip the dogfood harness config to `outputMode: plan` as default
- [ ] P-025 When all harnesses have migrated: rename `harness_shared.harness_proposals_shared` to `harness_shared._legacy_proposals_shared` (no drop — retains authored content)
- [ ] P-026 Remove ProposalsPanel from default tab set; keep behind `?legacy=1` for 30 days, then delete

**Critical path:** Phase A + B must land before the Phase 4 end-to-end dogfood run
(P-026 in `papercusp-dogfood-v5-2026-05-23.md`) so promoted features carry plan
context from day one. Phase C–E can run in parallel with dogfood Phase 5a.

---
## Decisions

### D-001 — First-class columns, not JSONB expansion

Promote plan provenance to `source_plan_slug TEXT` and `source_plan_item_ids TEXT[]`
on `harness_shared.harness_features_consolidated` rather than querying JSONB.

**Rationale:** JSONB lookup is non-indexable for equality filters. The bidirectional
UI and agent context injection both need efficient "all features for plan X" queries.
`metadata_json` is retained (no deletion); new columns are the query surface.

### D-002 — Promote write-back is mandatory and item-level idempotent

`plans:promote apply=true` always appends to the `## Promoted` block. Idempotency
is per-feature-ID: re-promoting the same feature ID is a no-op; promoting new
items [D,E] when [A,B,C] already exist correctly appends only the new rows.

**Rationale:** The plan body is the source of truth for what has been executed.
Block-level idempotency (skip if any block exists) would prevent incremental
promotions from the same plan, which is a valid use case.

### D-003 — All-at-once LLM generation ≤15 items; section-chunked above

See §6 cost table. The 15-item threshold balances output quality against cost.
Per-item LLM generation is never used — `plans:add-item` calls (PG writes) can
be per-item, but the upstream LLM call that produces the items is batched.

### D-004 — Scoper output mode is per-harness config, not process-global env var

`outputMode: 'plan' | 'proposal'` lives in `.harness/config.json` under a
`scoper` key. This allows the dogfood harness to test `plan` mode while other
harnesses remain on the legacy proposal path.

**Rationale:** A process-global `PAPERCUSP_SCOPER_PLAN_MODE` flag would flip all
harnesses simultaneously, preventing incremental rollout and parallel testing.

### D-005 — Lint rule for `## Promoted` is a warning, not an error, before migration

Plans promoted before this plan ships get backfilled by the Node migration script
(P-002). The lint rule emits a warning (not error) for plans that predate the
migration version, so CI doesn't break on day one.

### D-006 — "Promote to features" button ships in Phase C (no UX design gate)

A plain button on the plan detail page is sufficient for pre-alpha. Leaving it
as an open question with no P-item would mean it never ships; pre-alpha users
need a UI path to promote plans without MCP access.

---
## Review notes (2026-05-24)

A second agent reviewed v1 of this plan and identified four critical issues, all
corrected in this version:

| Issue | Resolution |
|---|---|
| `assembleFeaturePrompt` doesn't exist | Replaced with `assembleRolePrompt` from `@papercusp/orchestrator/role-prompt`; §3 now references the real callsites and the `extras`/post-call-append injection pattern |
| SQL migration missing `harness_shared.` prefix | All SQL now uses `harness_shared.harness_features_consolidated` explicitly |
| Phase C used Zero subscriptions (legacy) | §4 rewritten to use IPC EventSource via `RootSyncProvider` |
| Lint check would break existing plans on day one | P-002 adds backfill script; D-005 makes the lint rule a warning before migration version |

One reviewer point was incorrect: `harness_proposals_shared` **does** exist at
`harness_shared.harness_proposals_shared` (confirmed in
`017-harness-shared-phase-and-proposal-cols.sql:49`). The per-harness
`harness_proposals` table was already retired before this plan.

---

## Related Plans

- `papercusp-dogfood-v5-2026-05-23.md` — parent plan; this work is the Phase 4.5 gate
- `plans-harness-scoped-2026-05-24.md` — HYPERBEE-backed plans for shared harnesses (Q-1)
- `proxy-witness-pattern-2026-05-24.md` — spend verification infrastructure
