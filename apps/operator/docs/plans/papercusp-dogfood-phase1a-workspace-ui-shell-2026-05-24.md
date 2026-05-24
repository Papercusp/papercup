---
title: Papercusp dogfood — Phase 1a (workspace + create-harness UI shell + classifier)
slug: papercusp-dogfood-phase1a-workspace-ui-shell-2026-05-24
status: draft
created: 2026-05-24
updated: 2026-05-24
owner: avi@storewolf.com
---

# Papercusp dogfood — Phase 1a (workspace + create-harness UI shell + classifier)

## Now

**State:** **draft execution plan**. Phase 1a backend now COMPLETE as of 2026-05-24 overnight loop. Done: P-006 (sentinel), P-007 (classifier), **P-013 ALL** (incl. shared_repo_binding_cache via `8ed90e57`), **P-010 ALL** — init-local-dir helper (`init-local-dir.ts` + 20 tests, prior commit) + route wiring on POST /harness/projects (`3caa50ca`, Entry 1 discriminator added; existing Entry 2 + Entry 3 untouched). Remaining: **P-012 (the 4-entry picker UI) only**.

**Next:** P-012 — design memo first (Q-1) since it's the first user-visible surface of the dogfood arc. Three entries are wired backend-side (Entry 1 / Entry 2 / Entry 3 all functional via POST /harness/projects); Entry 4 stays placeholder until Phase 1b P-009 lands. Implementation gates on user's UX call.

## Background

This execution plan implements `## Phase 1a — Workspace + create-harness UI shell + classifier [M]` from v5 (~line 1190). Phase 1a is the **first end-user-visible deliverable** of the dogfood arc. After Phase 1a ships, a user can create a private harness from one of three entry points (new local dir / existing local repo / and the create-harness picker shell exists to expose Entry 2 + Entry 4 when those land in Phase 1b).

Phase 1a deliberately **does not** include OAuth, GitHub-clone, device attestation, or any P2P primitives — those are Phase 1b. Phase 1a's deliverable is purely the workspace + private-harness side, the dogfood substrate that the team can use immediately to start running v5's own development queue (per Phase 4 — the dogfood loop kicks off at the end of Phase 1a + Phase 2 + Phase 3).

**Gate:** Phase 1a depends on Phase 0 passing (the named substrate gate). At the time of writing, Phase 0 is partial — Linux smoke passes, macOS/Windows/Tauri-bundle pending. **Do not begin remaining P-010/P-012 work until Phase 0 has a recorded `GATE: PASS` decision** in `papercusp-dogfood-phase0-spike-2026-05-24.md`. The existing in-tree work for P-006/P-007/P-013 happened ahead of the formal gate as scoped exploration; it doesn't commit Phase 1a's user-visible surfaces.

## Phase tasks

### P-006 — Create the `papercusp-workspace` sentinel [S] — ✅ DONE

v5 one-liner: *"Create the `papercusp-workspace` (literal name) — sentinel workspace for dogfooding papercup itself. Schema-only; UI binds later."*

**Status:** ✅ DONE in commit `805a2e70` + boot-path wiring in `0fdbdbe0` (P-014).
- Constant + helper: `apps/operator/lib/harness/papercusp-workspace.ts` (`PAPERCUSP_WORKSPACE_ID`, `ensurePapercuspWorkspace()`).
- Tests: `apps/operator/lib/harness/papercusp-workspace.test.ts` (6/6 pass).
- Boot integration: `apps/operator/instrumentation-node.ts` calls `ensurePapercuspWorkspace()` on startup.
- Verified live: `scripts/run-dogfood-bootstrap.ts` confirms registry.json has 6 workspaces with sentinel present.

**Decision rule:** PASS. Nothing else to do.

---

### P-007 — Five-rule classifier [S] — ✅ DONE

v5 one-liner: *"Implement §2 five-rule classifier as `apps/operator/lib/harness/classify-tree.ts`. Tests for all five cases against papercup's actual `libs/` (9 sub + 7 plain = 16 dirs total)."*

**Status:** ✅ DONE in commit `4725cf93`.
- Implementation: `apps/operator/lib/harness/classify-tree.ts`.
- Tests: `apps/operator/lib/harness/classify-tree.test.ts` (14/14 pass including real-papercup integration test against the live `libs/` dir).
- Insight documented at `/internal/docs/agent-insights/harness-tree-classifier` (commit `603f172f`).

**Decision rule:** PASS. Nothing else to do.

---

### P-013 — PG schema for new dogfood tables [S] — 🟡 PARTIAL

v5 one-liner: *"Register harness rows in `harness_registry` with `entry_kind` + `state` columns. Also adds the new `feature_queue`, `contributors`, `feature_claims`, `pr_reviewer_settings` (augmented), `pr_check_status_cache`, `known_schema_versions`, `auto_review_audit`, `claim_audit`, `webhook_audit`, and `shared_repo_binding_cache` tables."*

**Status:** 🟡 PARTIAL — 10 of 11 ensure-functions done in commit `556b37d7`; `shared_repo_binding_cache` outstanding.

**What's done:**
- New sibling file `apps/operator/lib/ensure-schema-dogfood.ts` (kept separate from the 1860-line `ensure-schema.ts` to avoid mass-edit hazards).
- 10 `ensureXxxTable()` functions: idempotent `CREATE TABLE IF NOT EXISTS`, globalThis-pinned flags so re-imports don't re-run DDL.
- `wireDogfoodTriggers()` helper attaches `emit_change_notify` to `DOGFOOD_REACTIVE_TABLES` for P-019 reactivity.
- Later additions: `EXISTING_HYPERBEE_REACTIVE_TABLES` (P-019 part 2, `59611dde`) + `contributorUsageEvents` / `insightsFirstVisit` (addendum 3, `98ff062a`).

**Remaining sub-acceptance:**
- **P-013a — `shared_repo_binding_cache` table** — pending. Blocked by Phase 1b P-068 design (the schema follows the binding-record shape in v5 §5.1). When P-068 spec is finalized, add the corresponding `ensureSharedRepoBindingCacheTable()` to `ensure-schema-dogfood.ts` using the same pattern as the other 10 tables.

**Decision rule:** P-013 reaches PASS when P-013a lands. P-013 does not block Phase 1a's user-visible surface (P-010, P-012); it blocks Phase 1b's binding service (P-068). Track but don't gate on it.

---

### P-010 — Entry 1 + Entry 3 backend handlers [M] — 🔴 NOT STARTED

v5 one-liner: *"Entry 1 (new local non-git dir) + Entry 3 (existing local repo): UI shell + backend `{kind: 'local_init'}` and `{kind: 'local_existing'}` handlers. Entry 3 reuses existing `POST /api/harness/projects` path-validation; Entry 1 wraps `mkdir` + `git init` + Entry 3. **Entry 3 does NOT require GitHub auth.**"*

**Expansion.** Two handler shapes against the existing route. Entry 3 is path-validation + scaffold (route already does this for `{slug, path}`). Entry 1 is the same plus `mkdir -p <parentDir>/<folderName> && git -C <path> init`, then delegate to Entry 3's path.

**Files:**
- `apps/operator/app/api/harness/projects/route.ts` — existing route; extend the POST handler's discriminated-union to accept `{kind: 'local_init', slug, parentDir, folderName}` and `{kind: 'local_existing', slug, path}`. The existing `{slug, path}` shape is the same as Entry 3 and stays backward-compatible.
- `apps/operator/lib/harness/init-local-dir.ts` (new) — `initLocalHarnessDir({parentDir, folderName}): Promise<{path: string}>`. Validates parentDir exists + is writable + folderName is not path-traversal-shaped; creates the dir; runs `git init` via `execFile` (shell-less, same hardening as `clone-github.ts`); returns the absolute path. Idempotent: if the dir already exists with a `.git/`, returns the path unchanged.
- `apps/operator/lib/harness/init-local-dir.test.ts` (new) — covers: clean init, idempotent re-init, parentDir-missing rejection, folderName-traversal rejection, path-already-exists-as-file rejection, git binary missing.

**Sub-acceptances:**
- **P-010a — Entry 3 handler** (existing local repo). The existing `{slug, path}` shape already works. Add explicit `{kind: 'local_existing', slug, path}` shape for symmetry with Entry 1; keep the legacy shape as an alias. Acceptance: POSTing `{kind: 'local_existing', slug: 'foo', path: '/tmp/some-existing-repo'}` to the route returns 201 with the harness registered, identical to the legacy shape's behavior. Tests in `apps/operator/lib/endpoint-route/__tests__/` (find the existing harness-projects test file and extend).
- **P-010b — Entry 1 handler** (new local non-git dir). POSTing `{kind: 'local_init', slug: 'foo', parentDir: '/tmp', folderName: 'foo-test'}` creates `/tmp/foo-test/.git/`, scaffolds the harness, and returns 201. Acceptance: 12 unit tests covering the matrix in `init-local-dir.test.ts`. Integration test: against a tmp dir on the test host, the full flow produces a valid harness in `registry.json`.
- **P-010c — Error shape consistency** — both shapes return the same structured error codes as Entry 2's `clone-github.ts`: `invalid_url|invalid_path|dest_exists|git_missing|unknown` mapped to HTTP 400/409/500/502. The error shape is consistent across all four create-harness entries so the UI in P-012 can handle them uniformly.

**Decision rule:** P-010 passes when P-010a + P-010b + P-010c all pass. Entry 3 was effectively done before (the legacy `{slug, path}` route); the new work is mostly Entry 1 + the symmetric handler shape + error-shape unification.

---

### P-012 — Create-harness UI shell [M] — 🔴 NOT STARTED

v5 one-liner: *"Create-harness UI shell: 4-entry picker, per-entry forms, progress UI for clone/init, error handling. Uses vditor for description input."*

**Expansion.** This is the first user-visible surface of the dogfood arc. The picker exposes 4 mutually-exclusive entry buttons. Each opens its per-entry form. Only Entry 1 + Entry 3 work end-to-end after Phase 1a; Entry 2 + Entry 4 show "Coming in Phase 1b" placeholders that link to that phase's plan. After Phase 1b ships, the placeholders become live.

**Files:**
- `apps/operator/app/harness/CreateHarnessPicker.tsx` (new) — the 4-entry button surface. Existing harness-UI components (look in `apps/operator/app/harness/*.tsx`) for the component-style reference (ChromeShell, Button, Checkbox, etc.).
- `apps/operator/app/harness/CreateHarnessForm.tsx` (new) — per-entry forms behind the picker. Discriminated-union internal state on `kind`; renders one of `EntryNewLocalForm` / `EntryExistingLocalForm` / `EntryGithubUrlForm` (placeholder) / `EntryHarnessLinkForm` (placeholder).
- `apps/operator/app/harness/EntryNewLocalForm.tsx` (new) — folder-name input + parent-dir picker + description (vditor). Calls `/api/harness/projects` with `{kind: 'local_init', ...}`.
- `apps/operator/app/harness/EntryExistingLocalForm.tsx` (new) — path picker + description. Calls `/api/harness/projects` with `{kind: 'local_existing', ...}`.
- `apps/operator/app/harness/EntryGithubUrlForm.tsx` (new, placeholder) — disabled-state UI with "Available after Phase 1b ships GitHub auth + clone". Link out to the Phase 1b plan doc.
- `apps/operator/app/harness/EntryHarnessLinkForm.tsx` (new, placeholder) — same pattern as the GitHub URL placeholder.
- `apps/operator/app/harness/CreateHarnessProgress.tsx` (new) — progress UI for clone/init operations. For Phase 1a, only init progress is real (local mkdir + git init is fast — sub-second). Phase 1b expands this for clone latency.
- Tests in `apps/operator/app/harness/__tests__/` — render tests for the picker + each form; integration test against a mocked `/api/harness/projects` for each entry path.

**Sub-acceptances:**
- **P-012a — Picker shell renders** — the 4-entry picker mounts, shows 4 distinct entry buttons with the v5 §3 labels (`New local directory`, `Existing local repo`, `GitHub URL (Phase 1b)`, `Harness link (Phase 1b)`), is keyboard-navigable, and matches the design memo for the surface (see Q-1).
- **P-012b — Entry 1 form happy path** — picker → form → submit → harness appears in user's harness list. Sub-second from form submit to harness card visible.
- **P-012c — Entry 3 form happy path** — same as P-012b but for existing local repo.
- **P-012d — Error display** — each error code from P-010c renders an actionable error message on the form (not a raw stack). Specifically: `dest_exists` shows "A directory with that name already exists. Choose a different name or pick a different parent directory."; `invalid_path` shows the path that was rejected and why.
- **P-012e — Placeholder forms link out** — Entry 2 and Entry 4 buttons render but submit-disabled, with a visible "Phase 1b" badge and a doc link to `papercusp-dogfood-phase1b-oauth-clone-attestation-2026-05-24.md` (which doesn't exist yet — Phase 1b's execution plan slug to be confirmed when written).

**Decision rule:** P-012 passes when P-012a-e all pass. The placeholder forms (P-012e) are explicit incomplete-by-design; they're the visible hint to users that more entry paths are coming.

---

## Decisions

(No execution-time decisions yet. Sub-design questions go in `## Open questions` below; pull them up here as `D-NNN` when settled.)

## Named fallback rollout

Phase 1a does not have a substrate-failure-class fallback like Phase 0's HYPERBEE→GIT collapse. The closest failure mode is "the create-harness UI shell turns out to be wrong for what users need." Mitigations:

- The picker + per-entry forms are isolated React components with a stable backend contract (the existing `/api/harness/projects` route). UI redesigns post-shipping are scoped changes; no schema migration required.
- The `{kind: 'local_init', ...}` and `{kind: 'local_existing', ...}` shapes are additive; the legacy `{slug, path}` continues to work, so a UI rollback to the existing harness-creation flow (whatever it is today) is one-PR-away.

No formal named fallback section is needed for Phase 1a.

## Cross-references

- **`papercusp-dogfood-v5-2026-05-23.md`** — parent plan. Specifically `## Phase 1a` (~line 1190), `### §1 — Workspace, harness, sub-harness` (~line 207), `### §2 — Submodule/worktree five-rule classifier` (~line 230), `### §3 — Create-harness UI (4 entries)` (~line 246).
- **`papercusp-dogfood-phase0-spike-2026-05-24.md`** — the prior phase's execution plan. **Must show `GATE: PASS`** before P-010 and P-012 work begins.
- **`apps/operator/lib/harness/`** — existing in-tree work: `papercusp-workspace.ts`, `classify-tree.ts`, `clone-github.ts` (from Phase 1b P-008, already DONE), `register-papercup.ts`.
- **`apps/operator/lib/ensure-schema-dogfood.ts`** — the dogfood schema sibling file; P-013a (the outstanding `shared_repo_binding_cache`) lands here.
- **`apps/operator/app/api/harness/projects/route.ts`** — the route P-010 extends.
- **D-006** in v5 — "Phases (staging/testing/production) retired for shared harnesses." Phase 1a only creates private harnesses, so the phases system is in scope here; phases retirement starts in Phase 5a.

## Open questions

### Q-1 — Does P-012's picker UI need a design phase before implementing?

The 4-entry picker is the first user-visible surface of the dogfood arc. It's also the gateway to the entire collaboration flow. Worth a brief design discussion (single design memo at `apps/operator/content/internal-docs/design/dogfood-create-harness-picker.mdx`) before implementing, or is the v5 §3 spec sufficient? My lean: a design memo. The surface is high-leverage and visual + interaction patterns matter. ~1 day of design before ~3 days of implementation is cheaper than the inverse.

### Q-2 — When does the dogfood loop actually start running on papercup?

v5's Phase 4 says "Single-engineer dogfood (papercup as `state: private`)" — that's the trigger to start using Papercusp to run Papercusp's own queue. Phase 1a + Phase 2 (completion_ref) + Phase 3 (reactivity) are technically enough substrate for single-engineer dogfood to begin. Decide: does Phase 4 start as soon as those three phases ship (parallel with Phase 5+), or does Phase 4 wait for Phase 5+'s shared-harness substrate? My lean: start Phase 4 as soon as 1a/2/3 ship. The whole point of the dogfood arc is to find issues by using it; waiting until shared-harness is built delays that signal.

### Q-3 — The placeholder forms (P-012e) link to a phase plan doc that doesn't exist yet. Naming convention?

Suggested slug: `papercusp-dogfood-phase1b-oauth-clone-attestation-2026-05-24.md`. Same date stamp as the others in the cohort (all carved on 2026-05-24); descriptive name. Confirm before P-012e ships.

## For the next agent (Phase 1b OR Phase 2)

The natural next phase after 1a is **Phase 1b** (OAuth + clone + device attestation). However, Phase 1b is **L-sized** (vs Phase 1a's M) and Phase 2 is M-sized. Two scheduling options:

**Option A — Phase 1b next.** Sequential. Phase 1b's deliverable (Entry 2 + Entry 4 + device attestation) lights up the placeholder forms in P-012e and completes the create-harness UX. After Phase 1b, the create-harness surface is feature-complete for the non-shared flows.

**Option B — Phase 2 next, Phase 1b in parallel.** Phase 2 (`completion_ref` + status verification, M-sized) is fully independent of Phase 1b — it touches `harness_features_consolidated` and the background verifier daemon, neither of which depend on OAuth or clone. Running both in parallel cuts the critical path by ~M.

My lean: **Option B**. The two phases don't touch the same files; parallelism is safe; the dogfood loop benefits from Phase 2 landing as soon as possible (Phase 4's first dogfood feature needs `completion_ref` to verify "is this PR actually merged?").

Whichever phase runs next:

- The user's create-harness flow at the end of Phase 1a is private-harness-only. Phase 1b unlocks GitHub URL + harness-link entries. The placeholder forms in P-012e make that handoff visible.
- The `shared_repo_binding_cache` schema gap (P-013a) is Phase 1b's prerequisite — close it as part of Phase 1b's P-068 work.
- The classifier (P-007) is in-tree and tested; sub-harness walking can run against it from any phase that needs it (Phase 5a's `feature_queue` rollups care about this).
- The `papercusp-workspace` sentinel exists and is ready for Phase 4 to register the papercup repo into it (per Phase 4 P-024).
