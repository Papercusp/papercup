# Eager-fetch refactor — implementation plan v2

## Problem

The operator dashboard exhibits visible click-delay on multiple interactions: clicking "steer" on a feature, opening the side panel, opening the edit modal, switching tabs in SpecEditor, picking a memory file, opening a brainstorm view. Each currently fires a REST round-trip on click/mount before content appears.

The application is local-only (PG → operator → browser, all loopback). Saving network bytes is not a goal; saving wall-clock click-delay is. Per-harness payload for the relevant data is well under 1 MB.

**CVR memory math:** dominant per-harness rows are `issues.md` (~150 KB), prompts (~30 KB), memory (~30 KB), per-feature notes (~50 KB total at 92 features). All `byHarness`-keyed Zero subscriptions stay under ~500 KB per active harness, well within Zero's working set on both client and server.

## Scope

**In scope:** convert lazy `fetch('/api/...')` calls in mounted components to live reads from Zero subscriptions.

**Out of scope:** server-side pagination, bloom-filter dedup, Typesense pipelines, refactoring background polling, per-page navigation loads.

## Architecture invariants

1. **Transport-agnostic consumer code.** UI reads via `useSyncQuery({queryName, args})`. Web → Zero WS, desktop → SSE.
2. **PG-canonical for state, file mirrors for substrate.** PG first, then mirror.
3. **One writer-side helper per table.** Writers always do PG upsert + `notifySyncInvalidate(...)`. The notify is a no-op on WS (zero-cache picks up logical replication), load-bearing on SSE.
4. **Workspace RLS stays on.** `harness_zero` has BYPASSRLS (this session); operator REST/SSE paths use `harness_admin` (BYPASSRLS); `harness_app` remains workspace-scoped.

## Phase plan

Order: **0 → 0d → 1 → 2 → 3.** Phase boundaries independently revertible.

---

### Phase 0 — register three Zero queries (Tier 2)

**Risk:** low. No new tables, no migrations, no backfill.

Three tables already exist in PG, are in the `zero_harness` publication, and have data — but no Zero query is registered against them. One Zero query per table fixes 7 consumers (final scope: 6 panels migrated; ManifestSpecEditor and OracleDock skipped — see commit history).

| Underlying table | Zero query (new) | Consumers fixed |
|---|---|---|
| `harness_shared.harness_text_artifacts` | `harnessTextArtifact.byHarness` | `MemoryBrowser`, `PromptsTab`, `OracleDock`, `HarnessDashboard` (issues.md ribbon) |
| `harness_shared.harness_project_files` | `harnessProjectFiles.byHarness` | `SpecEditor` (spec/agents/contract/config tabs) |
| `harness_shared.harness_brainstorm` | `harnessBrainstorm.byHarness` | `CanvasView`, `MapView`, `WriteView`, `ManifestSpecEditor` (parts) |

**Files:**

1. `libs/zero-harness/src/schema.ts` — add three table mappings.
2. `libs/zero-harness/src/queries.ts` — add three `byHarness` queries.
3. `apps/operator/lib/text-artifacts.ts` — rename notify event from `harnessTextArtifact.byHarnessAndPath` → `harnessTextArtifact.byHarness` (verified: only one writer at line 38, zero subscribers, safe to rename).
4. `apps/operator/app/api/_hono/harness.ts` (brainstorm + project-files writers) — confirm `notifySyncInvalidate` calls. Add if missing.
5. `apps/operator/app/harness/SpecEditor.tsx` — replace 5 sequential `Promise.all` REST fetches with subscriptions to project-files (spec/agents/contract/config) + text-artifacts (knowledge/mcp/supervisor-notes/claude-settings, post-Phase-0d).
6. `apps/operator/app/harness/PromptsTab.tsx` — replace per-role REST fetch with text-artifacts subscription, filter `relPath LIKE 'prompts/%'`.
7. `apps/operator/app/harness/MemoryBrowser.tsx` — replace per-file REST fetch with text-artifacts subscription, filter `relPath LIKE 'memory/%'`.
8. `apps/operator/app/harness/ManifestSpecEditor.tsx` — replace per-file REST fetch with subscription read.
9. `apps/operator/app/_components/OracleDock.tsx` — replace `/prompts` fetch with text-artifacts read (`prompts/%` filter).
10. `apps/operator/app/harness/brainstorm/CanvasView.tsx`, `MapView.tsx`, `WriteView.tsx` — replace `/brainstorm-canvas`, `/brainstorm-mindmap`, `/brainstorm` fetches with brainstorm-Zero subscription.
11. `apps/operator/app/harness/HarnessDashboard.tsx` — drop the `/issues?phase=` lazy fetch; read `issues.md` from text-artifacts subscription.

**Verification:** all 9 components render content same-frame on open; multi-tab consistency within ~50 ms via SSE invalidate; existing tests pass.

**Rollback:** revert the 11 file changes.

---

### Phase 0d — three disk-only routes into text-artifacts

**Risk:** medium. Touches substrate-side reads. PG becomes canonical, disk stays as mirror.

**Scope correction from v1:** supervisor-notes is already half-migrated (PUT/POST go through text-artifacts; only GET still reads disk). It becomes a one-line GET fix, not a migration.

**Files:**

1. `apps/operator/app/api/_hono/harness.ts` — for `/supervisor-notes` GET handler: replace `safeRead(supervisorPath(project)) ?? ''` with `(await loadTextArtifact(slug, 'supervisor-notes.md')) ?? safeRead(supervisorPath(project)) ?? ''` (PG-first with disk fallback, matching `/escalation` pattern).
2. New migration script `scripts/backfill-disk-files-into-text-artifacts.ts` — for each harness, read `<harness_dir>/knowledge.md`, `<harness_dir>/mcp.json`, `<project_path>/.claude/settings.json`. Idempotent guard: **skip if PG.updated_at >= file mtime, OR PG content is non-empty and file content byte-equals PG content** (never re-import when PG was written more recently).
3. `apps/operator/app/api/_hono/harness.ts` — switch `/knowledge`, `/mcp`, `/claude-settings` GET+PUT handlers to read/write via `loadTextArtifact`/`saveTextArtifact` with disk mirror.
4. `apps/operator/app/harness/SpecEditor.tsx` — drop the remaining 3 lazy fetches; consume from same text-artifacts subscription added in Phase 0.
5. **Memory correction:** edit `~/.claude/projects/-tmp/memory/project_un_hardcode_arc_complete.md` to mark which artifacts were originally PG-canonical via text-artifacts vs which were migrated in Phase 0d.

**Verification:** SpecEditor's full tab set renders content same-frame; worker reads disk file matching PG row.

**Rollback:** revert handler changes. Disk files remain authoritative for substrate.

---

### Phase 1 — feature-detail Zero queries (rewritten)

**Status (post-implementation):**
- ✅ **1.1 feature_notes** — shipped. Click steer → 0 fetches, panel renders with content. Original reported bug fixed.
- ⏸ **1.2 feature_debug_notes** — deferred. Backing table doesn't exist; debugger role writes disk only. Requires fs-watcher mirror infrastructure (~150 LOC across watcher + ensure-schema + Zero schema). Click delay on side panel debug section remains.
- ⏸ **1.3 feature_prs** — deferred. Substrate (worker) writes prs.json directly; would need substrate→operator HTTP migration to make PG canonical. Click delay on side panel PR section remains.
- ⏸ **1.4 feature_audit_consolidated** — deferred. Per-harness `feature_audit` tables exist; un-hardcode plan item #6 says "write directly to consolidated, drop per-harness from template" — substantial migration that should be done as its own un-hardcode increment, not piggy-backed on this refactor.
- ⏸ **1.5 FeatureTimelinePanel client-derivation** — deferred. Timeline draws from 4 sources; only 2 (status changes, agent runs) are already in eager Zero subscriptions. The other 2 (debug-notes, PRs) need 1.2 and 1.3 first. Doing 50% client-derivation now would leave a confusing partial UX.

**The above 4 items are user-visible click-delays but not the originally reported bug.** Each requires substantial infrastructure work beyond the consumer-side migration covered in this plan. They belong in a separate, focused PR rather than expanded scope here.

---

#### Original Phase 1 plan (kept for reference)

**Risk:** medium. Two new tables (debug-notes, prs) + one consolidated table (feature_audit) + one ALTER on existing table + client-side timeline derivation.

**Reviewer-driven corrections from v1:**
- `harness_feature_notes` already exists (Round 17 this session) with `(workspace_id, harness_slug, feature_id, content, updated_at)` and `apps/operator/lib/operator-notes.ts` writer. **Don't create a parallel `feature_notes` table.** Add a Zero query against the existing one.
- `feature_audit` migration matches the active un-hardcode-plan.md pattern: write directly to consolidated, drop per-harness audit from per-schema template, no triggers. Becomes item #6 of the explicit un-hardcode order.

| # | File:line | Endpoint | Fix |
|---|---|---|---|
| 1.1 | `OperatorNoteForm.tsx:48`, `FeaturePeekPanel.tsx:82` | `/features/<id>/notes` | Use **existing** `harness_feature_notes` table. New Zero query `featureNotes.byHarness`. Route writes through existing `appendOperatorNote` helper. |
| 1.2 | `FeaturePeekPanel.tsx:67` | `/debug-notes/<id>` | New table `harness_shared.feature_debug_notes` (single content blob per feature) + Zero query `featureDebugNotes.byHarness`. |
| 1.3 | `FeaturePeekPanel.tsx:58` | `/prs` | New table `harness_shared.feature_prs` (row-per-feature, structured columns) + Zero query `featurePrs.byHarness`. |
| 1.4 | `FeatureEditor.tsx:112` | `/features/<id>/audit` | New table `harness_shared.feature_audit_consolidated`; **direct writes** (no triggers); drop `feature_audit` from per-schema template; one-time backfill. Matches un-hardcode plan item #6. |
| 1.5 | `FeatureTimelinePanel.tsx:43` | `/features/<id>/timeline` | **No new endpoint.** Derive client-side from `agentRunsConsolidated.bySlug` + `featuresConsolidated.bySlug`. |

**Files:**

1. `libs/papercusp/libs/db/sql/0NN-feature-debug-notes.sql` — CREATE TABLE + RLS + GRANT + ALTER PUBLICATION.
2. `libs/papercusp/libs/db/sql/0NN+1-feature-prs.sql` — same.
3. `libs/papercusp/libs/db/sql/0NN+2-feature-audit-consolidated.sql` — CREATE TABLE + RLS + GRANT + ALTER PUBLICATION + UNION-INSERT backfill from existing per-harness `feature_audit` tables (one-time on migration apply).
4. Bin script update for `bin/scaffold-harness-schema.sh` — drop `feature_audit` from per-schema template (matches un-hardcode item #6 step 6).
5. `libs/zero-harness/src/schema.ts` — four table mappings (featureNotes mapping the **existing** table; featureDebugNotes, featurePrs, featureAuditConsolidated for the new ones).
6. `libs/zero-harness/src/queries.ts` — four `byHarness` queries.
7. `apps/operator/lib/feature-debug-notes-store.ts`, `feature-prs-store.ts` — two new writer helpers (PG upsert + disk mirror + notify).
8. `apps/operator/lib/feature-audit-store.ts` — direct writes to consolidated table (no per-harness intermediary); replaces the existing audit insertion code at the writer call sites.
9. `apps/operator/app/api/harness/[slug]/features/[id]/notes/route.ts` — POST routes through existing `appendOperatorNote` (no change to writer; only shape of GET removal needed since UI no longer calls GET).
10. `apps/operator/app/api/harness/[slug]/debug-notes/[id]/route.ts` — POST routes through new helper.
11. `apps/operator/app/api/harness/[slug]/prs/route.ts` — POST routes through new helper.
12. `scripts/backfill-feature-detail-stores.ts` — single script, three populations: walks `<projectDir>/.harness/notes/*.md`, `<projectDir>/.harness/debug-notes/*.md`, `<projectDir>/.harness/prs.json`. Idempotent guard: **skip when PG.updated_at >= file.mtime** OR (PG content non-empty AND file matches PG byte-equal).
13. `apps/operator/app/harness/HarnessDashboard.tsx` — four new `useSyncQuery` calls (notes, debug-notes, prs, audit); aggregate to `featureDetail = { notes, debugNotes, prs, audit }` prop.
14. `apps/operator/app/harness/OperatorNoteForm.tsx` — drop `useEffect(load)`, read from prop.
15. `apps/operator/app/harness/FeaturePeekPanel.tsx` — drop two `useEffect(fetch)`, read from props. Drop `'operator-notes:updated'` custom event.
16. `apps/operator/app/harness/FeatureEditor.tsx` — drop the `/audit` lazy fetch, read from prop.
17. `apps/operator/app/harness/FeatureTimelinePanel.tsx` — drop the `/timeline` fetch entirely. Derive timeline as `useMemo` from already-eager Zero data.

**Schema details:**

```sql
-- feature_debug_notes (single content blob per feature)
CREATE TABLE harness_shared.feature_debug_notes (
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  feature_id   text NOT NULL,
  content      text NOT NULL DEFAULT '',
  updated_ts   bigint NOT NULL,
  PRIMARY KEY (workspace_id, harness_slug, feature_id),
  CONSTRAINT fdn_workspace_nonempty CHECK (workspace_id <> '')
);

-- feature_prs (structured columns, row-per-feature)
CREATE TABLE harness_shared.feature_prs (
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  feature_id   text NOT NULL,
  pr_url       text NOT NULL,
  pr_state     text NOT NULL,         -- 'open' | 'closed' | 'merged'
  opened_ts    bigint NOT NULL,
  updated_ts   bigint NOT NULL,
  PRIMARY KEY (workspace_id, harness_slug, feature_id),
  CONSTRAINT fpr_workspace_nonempty CHECK (workspace_id <> '')
);

-- feature_audit_consolidated (matches un-hardcode plan item #6)
CREATE TABLE harness_shared.feature_audit_consolidated (
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  feature_id   text NOT NULL,
  ts           bigint NOT NULL,
  actor        text NOT NULL,
  action       text NOT NULL,
  details      jsonb,
  PRIMARY KEY (workspace_id, harness_slug, feature_id, ts, actor, action)
);
```

All tables: RLS policy mirroring `harness_features_consolidated`; GRANTs to `harness_app`/`harness_admin` (full CRUD), `harness_zero` (SELECT); added to `zero_harness` publication.

**Verification:** all five interactions render content same-frame; tab A → tab B updates within <100 ms; worker dispatch reads disk-mirrored note content; backfill is idempotent (re-run = zero changes); RLS smoke passes; existing harness contract test passes; **un-hardcode contract test still passes** (no per-harness `feature_audit` references in `libs/zero-harness/`).

---

### Phase 2 — per-list content enrichment (Tier 3a)

**Risk:** low.

**Prerequisite:** sample proposal sizes via `SELECT max(length(content)), avg(length(content)) FROM harness_shared.harness_proposals_shared`. If avg > 100 KB or max > 1 MB, defer to Phase 3 streaming.

**Files:**

1. `libs/zero-harness/src/schema.ts` — add `content` column to `proposalsShared` mapping.
2. `libs/zero-harness/src/queries.ts` — `proposalsShared.byHarness` query selects `content`.
3. `libs/zero-harness/src/schema.ts` — add expand-history field to `delegates` mapping.
4. `apps/operator/app/harness/ProposalsPanel.tsx` — drop `/proposals/<id>` lazy fetch.
5. `apps/operator/app/_components/DelegatesSection.tsx` — drop `/delegates?id=` expand fetch.

---

### Phase 3 — instant-paint + stream-on-click (Tier 4)

**Risk:** medium.

**Reviewer correction:** Reuse existing `/log/stream` endpoint (`harness.ts:1808`) with a per-runId filter rather than standing up `/agents/<runId>/stream`. Saves one endpoint to maintain.

**Files:**

1. `apps/operator/app/api/_hono/harness.ts` — extend `/log/stream` to accept `?runId=<...>` query param; filter the JSONL stream to events for that run only.
2. `apps/operator/app/api/harness/[slug]/agent-chats/[chatId]/stream/route.ts` (new) — SSE endpoint streaming chat history.
3. `apps/operator/app/api/harness/[slug]/hook-logs/[id]/stream/route.ts` (new) — SSE endpoint streaming hook log body.
4. `apps/operator/lib/use-streamed-detail.ts` — small consumer hook around `EventSource` exposing `{shell, body, done}`.
5. Consumer rewrites: `HarnessDashboard.tsx` (run pill click), `ChatPanel.tsx`, `PiTerminalsDock.tsx`, `HooksPanel.tsx`.

**Verification:** click any pill → metadata visible same-frame; transcript fills within ~50 ms; only one SSE stream open per active panel.

---

### Deferred to separate change

- `ExpertsPanel` lazy fetches — needs new `harness_experts` table; not covered.
- Dead-code cleanup in `libs/papercup-shared/`.
- Server-side pagination — threshold-triggered.
- Bloom-grid library — not adopted; wire-saving doesn't apply to localhost.

## Net file/LOC impact (revised)

| Phase | Files | LOC net |
|---|---|---|
| 0 | 11 | ~200 |
| 0d | 4 | ~80 (was 150 before supervisor-notes correction) |
| 1 | 13 | ~450 (was 600 before harness_feature_notes correction + un-hardcode alignment) |
| 2 | 5 | ~80 |
| 3 | 9 | ~400 (one fewer endpoint) |
| **Total** | **42** | **~1210** |

For 23 user-facing interactions fixed.

## Recommendation

Ship phases in order **0 → 0d → 1 → 2 → 3**. Each is independently revertible.
