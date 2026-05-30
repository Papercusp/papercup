---
title: Design-spec migration — deferred fixes (2026-05-13)
slug: design-migration-deferred-2026-05-13
status: shipped
created: 2026-05-13
updated: 2026-05-30
owner: pandawamble@gmail.com
---

## Now

**State:** Companion to the full-app audit performed 2026-05-13 against `/docs/design`. The "safe-by-construction" subset shipped in the same session (see below). Everything else is parked here with the **risk** that prevented it from landing in the safe pass.

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# Design-spec migration — deferred fixes (2026-05-13)

Companion to the full-app audit performed 2026-05-13 against `/docs/design`. The "safe-by-construction" subset shipped in the same session (see below). Everything else is parked here with the **risk** that prevented it from landing in the safe pass.

Use this doc as the migration queue. Pick a section, resolve the listed risk, ship it, tick it off.

---

## What already shipped (do NOT redo)

### Wave 1 (initial safe pass)

- **`<ConfirmModal>` helper** at `app/harness/ConfirmModal.tsx` — canonical replacement for `window.confirm()` / `window.prompt()`. Supports `destructive`, async `onConfirm`, and `requireType="DELETE"` typed-confirmation gate.
- **`useConfirmDialog` hook** at `app/harness/useConfirmDialog.tsx` — imperative `confirm()` returning a Promise. Use this when an existing handler is shaped like `if (!confirm()) return; <work>`; preserves the async control flow as a one-line swap. (Caveat: the dialog closes as soon as the user clicks Confirm, like native — if you need the modal to stay open showing "Working…", use `<ConfirmModal>` directly with its async `onConfirm` prop.)
- **`<Popover>` wrapper** at `app/harness/Popover.tsx` — canonical anchored-dropdown primitive (header notifications, OracleDock picker, WorkspaceSwitcher, etc.). Defaults to non-focus-stealing on open.
- **Spec updated**: `content/docs/design/index.mdx` decision matrix + hard rules HR1/HR5 + examples table now reference `<Popover>` and `<ConfirmModal>`. `content/docs/design/libraries.mdx` has new sections for both.
- **`@radix-ui/react-popover@^1.1.15`** installed in `apps/operator/package.json`.
- **5 HR2 raw-checkbox swaps** (sites not inside RHF forms, no auto-save semantics):
  - `app/harness/HarnessSettingsPanel.tsx:622, 690`
  - `app/installed/plugins/[slug]/permissions/page.tsx:178`
  - `app/settings/omp/page.tsx:262`
  - `app/settings/user/page.tsx:350`
  - `app/editor-demo/page.tsx:67`
- **HR1 `MarketplaceList` install-confirm dialog** → `<Modal>`.

### Wave 4 (per-surface batches)

Surface-organized push through the rest of the code-ready batches.

- **Batch #1 — Top-level chrome** (header NotificationCenter + RecentActionsCenter → `<Popover>` via new `Popover` wrapper with `tooltipLabel` prop; OracleDock picker `role="dialog"` → `role="region"`; WorkspaceSwitcher onCreate → `usePromptDialog`; OperatorPanel ignore-reason → `usePromptDialog` with `allowEmpty`; OperatorPanel harness filter `<select>` → `<Select>`; BranchActionRunner → `<Modal>` with ESC/outside-click suppressed during run.) New helpers: `app/harness/PromptModal.tsx` + `app/harness/usePromptDialog.tsx`. CSS: `.notif-panel` positioning rules removed (Radix handles).
- **Batch #2 — `/harness/<slug>` dashboard + phases + prompts** (resetFeature, cleanupHarness, command-palette `Request checkpoint` 2-step prompt chain with validate + allowEmpty; PhaseTabs setup confirm + alert→toast; PromptsTab deleteOverride.)
- **Batch #3 — Proposals tab** (accept / bulk-accept / bulk-reject / replan; verified single-confirm-then-loop, no per-item loop bug after all.)
- **Batch #4 — Experts tab** (cancel + fork confirms; spawn-expert hand-rolled modal → `<Modal>`; size `<select>` → `<Select>`; archive-chat confirm.)
- **Batch #6 — `/installed/templates` list** (delete confirm with conditional published-snapshot warning; install/materialise prompt with slug validation.)
- **Batch #7 — `/installed/templates/<slug>/edit`** (worst non-settings page, ~1029 lines). Version picker `<select>` → `<Select>`; discard-changes confirm → `useConfirmDialog`; "Add new" button title → Tooltip; `AddFileDialog` hand-rolled overlay → `<Modal>`; both register-bound `<select>` (language, sensitivity) → `<Controller>` + `<Select>`; per-row auto-enable checkbox → `<Checkbox>`; per-row language + sensitivity selects → `<Select>` (Sensitivity `title=` now an `ariaLabel`). Kept per-row "Remove role/plugin/file" `title=` per soft-rule carve-out.
- **Batch #8 — `/installed/snapshots`** (delete confirm with conditional retract warning; publish prompt chain — slug → version, both validated; retract confirm.)
- **Batch #9 — `/marketplace/snapshots`** (instantiate name prompt with `allowEmpty`; publish confirm; delete confirm.)
- **Batch #10 — `/snapshots` (top-level)** (densest file; instantiate prompt with charset validation; publish confirm; **4-step retract prompt chain** — slug → action (validated against deprecate/withdraw/yank) → optional version → optional reason; delete confirm.)
- **Batch #11 — `/login`** (HR2 + HR3 swap to `<Checkbox>` + `<Select>`. Audit-doc note was wrong about RHF — `/login` is plain `useState`, no `<Controller>` needed.)
- **Batch #12 — `/settings/publishing`** (rotate-secret + delete-credentials confirms.)
- **Batch #13 — `/settings/plugins` + `ProvisionPanel`** (harness picker `<select>` → `<Select>`; renderInput boolean field native checkbox → `<Checkbox>`; renderInput enum field native select → `<Select>` (these are NOT register-bound — they're plain callbacks taking value/onChange from outer RHF setValue, so no Controller needed); 2× `<details>` → `<Collapsible.Root>`. Kept `title="publisher-specific" / "secret"` on info badges — informational annotations, not actions.)
- **Batch #15 — Spec carve-out doc edit** (`content/docs/design/gotchas.mdx` adds two new sections: content-disclosure `<details>` carve-out with the 7 approved sites + the tell, and floating-widget pattern carve-out for OperatorPanel + OracleDock.)

### Wave 3 (Tier-2 HR5 batch)

20 more `confirm()` sites migrated to `useConfirmDialog` (one-line swaps preserving the async control flow) + 1 native `alert()` → `toast.error()`. All sites verified to follow the `if (!confirm) return; <async work>; finally cleanup` pattern (no try/finally cleanup hazards between confirm and work).

- `app/harness/ArchitectInbox.tsx` ×2 — ThreadRow delete, ChatPane delete-thread
- `app/harness/ArchivesPanel.tsx` ×2 — archive-with-reset, restore-from-archive
- `app/harness/SnapshotsPanel.tsx` ×2 — restore-from-snapshot, delete-snapshot
- `app/harness/CollectionTab.tsx` — delete skill/override
- `app/harness/ScreenshotsPanel.tsx` — delete screenshot
- `app/harness/HooksPanel.tsx` — delete hook
- `app/harness/FeatureList.tsx` — batch delete (inline JSX onClick converted to async)
- `app/harness/FeatureEditor.tsx` — delete feature
- `app/harness/ChatPanel.tsx` — archive chat
- `app/harness/[slug]/projects/[id]/ProjectDetail.tsx` — regenerate spec
- `app/settings/api-keys/page.tsx` — clear API key
- `app/settings/mobile/page.tsx` — revoke device
- `app/settings/operator/page.tsx` — remove preference entry
- `app/settings/shortcuts/page.tsx` — reset all shortcuts
- `app/settings/user/memory/page.tsx` ×3 — delete one (with reason), forget-all (gated by `requireType="FORGET"`), re-embed
- `app/admin/_components/TableAdmin.tsx` — delete row (+ `alert()` → `toast.error()` on failure path)

### Wave 2 (continuation)

- **Tier-1 HR5 destructive confirms migrated to `useConfirmDialog`**:
  - `app/harness/HarnessDashboard.tsx` `PluginPanelCard.disable()` — plugin disable (per-harness)
  - `app/harness/HarnessDashboard.tsx` `stopHarness()` — SIGTERM (destructive)
  - `app/_components/WorkspaceSwitcher.tsx` `onSwitch` — workspace switch
  - `app/_components/WorkspaceSwitcher.tsx` `onDelete` — delete workspace, with `requireType={ws.name}` typed confirmation
  - `app/harness/SpecEditor.tsx` `revealEnv()` — `requireType="REVEAL"` typed confirmation for secrets disclosure
  - `app/_components/UpdateChip.tsx` `onInstall` — install update + restart
  - `app/installed/plugins/page.tsx` `update(slug)` — accept new capabilities (destructive)
  - `app/installed/plugins/page.tsx` `uninstall(slug)` — plugin removal
- **Tier-2 HR5 confirms migrated** (simple try/finally patterns, no loop/cleanup hazards):
  - `app/harness/TemplatesModal.tsx` `bootstrap()` — bootstrap-from-template; `destructive` flag flipped on `overwrite` mode
  - `app/harness/EscalationBanner.tsx` `clearWithoutResponse()` — clear escalation without note
  - `app/_components/NotificationCenter.tsx` `clearAll()` — clear notification history (destructive)
- **HR4 `title=` → `<Tooltip>` on non-list action buttons** (10 sites):
  - `app/_components/SupportAgentPanel.tsx:245` — Support button
  - `app/_components/RecentActionsCenter.tsx:111` — recent-actions bell
  - `app/_components/NotificationCenter.tsx:148, 163` — notifications bell + clear-all button
  - `app/_components/TutorialButton.tsx:22` — main tutorial button
  - `app/_components/voice/VoiceButton.tsx:268` — voice settings link
  - `app/_components/WorkspaceSwitcher.tsx:179` — main workspace trigger
  - `app/harness/HarnessDashboard.tsx:4187` — command palette open button
  - `app/harness/PlanReviewBanner.tsx:100` — dismiss button

### Items already structurally satisfied — no work needed

- **Theme CSS vars are already promoted to `:root`** in `apps/operator/app/globals.css` (`--bg-1..4`, `--surface`, `--fg-mute`, `--border`, `--accent*`). Portaled Radix content correctly inherits them. *Decision 11 from the risk audit is already satisfied.*
- **Tooltip provider is global** in `app/layout.tsx` (`<Tooltip.Provider delayDuration={150} skipDelayDuration={300}>`). Any `app/harness/Tooltip.tsx` usage works without per-route setup.

### False positives in original audit — no fix needed

- **`marketplace/[slug]/page.tsx:79, 113` duplicate `<h1>`** — the two `<h1>`s are in conditional branches (error fallback vs success path); only one renders per request. Memo C1 actually describes a *data-loading* bug ("This package isn't in the catalog" for installed templates), not a duplicate-h1 design issue. The real fix belongs in the `[slug]` route loader, not the audit queue.

---

## Pending user decisions (block migrations downstream)

These are *not* code work — they're calls the user needs to make before the next batch lands.

### ~~D1. `/dev/*` carve-out~~ — **REJECTED 2026-05-13**

User decision: `/dev/*` migrates like everything else. Once RichGrid gains print + copy fidelity (D4 resolution), the diagnostic-table needs are covered by the canonical primitives. No carve-out.

### D2. `<details>` content-disclosure carve-out

Four `<details>` sites are content-disclosure (prose), not interactive disclosure:
- `app/_components/WslOnboardingGate.tsx:201` (diagnostics dump)
- `app/support/page.tsx:160`
- `app/settings/api-keys/page.tsx:429`
- `app/settings/voice/page.tsx:964` (debug precedence matrix)
- `app/settings/user/memory/page.tsx:138`

Add a carve-out for these in the spec, OR migrate them all to `<Collapsible.Root>`.

### D3. `<Collapsible>` `hidden-until-found` semantics

When `<details>` migrates to Radix `<Collapsible.Root>`, the collapsed content becomes `display:none` and is invisible to browser Ctrl+F. For `/dev/_components/SessionsTab.tsx:592` (transcript bodies) and `/dev/_components/TablesTab.tsx:445, 457` (table-row expansions), Ctrl+F-across-collapsed is a real debug workflow.

Options:
- Accept the regression (Ctrl+F won't find collapsed content)
- Keep these as `<details>` (carve-out per D2)
- Wrap a custom `<HiddenUntilFound>` primitive in the wrapper

### ~~D4. `<table>` print + copy-paste fidelity~~ — **RESOLVED 2026-05-13**

`RichGrid` is being extended with a print-only `<table>` mirror (Pattern A) + `copy` event handler that writes both `text/plain` (TSV) and `text/html` (`<table>`) clipboard payloads. Both features land in Phase 3 of the deferred-backlog drain; no carve-out needed.

Originally-deferred sites (now scheduled for HR8 migration):
- `app/admin/_components/TableAdmin.tsx:168`
- `app/settings/plugin-runtime/RuntimeView.tsx` (3 tables)
- `app/installed/plugins/page.tsx:183`
- `app/installed/plugins/[slug]/permissions/page.tsx:144`
- `app/harness/IntelPanel.tsx` (4 tables)
- `app/harness/HarnessSettingsPanel.tsx`, `app/harness/PromptBudgetView.tsx`

Each table's print/copy expectations need to be checked before migration.

### D5. NVDA + iOS Safari validation post-Radix-Select

When `<select>` → `<Select>` lands on `/login`, `/settings/voice`, `/installed/templates/[slug]/edit`, the resulting forms must be tested in:
- NVDA + Firefox (Radix Select has known NVDA quirks with `aria-activedescendant`)
- iOS Safari (native `<select>` opens a giant scroll wheel — Radix renders a portaled listbox that's worse on touch)

If the mobile-Hono path is in scope for these forms, the Select migration is **not** strictly an improvement.

### ~~D6. Auto-save vs submit-driven on `/settings/voice` + `/settings/backups` + `/settings/mobile`~~ — **RESOLVED 2026-05-13**

Spec was wrong, not the code. HR7 has been revised to recognize **per-field auto-save settings pages** as a first-class peer of single-submit forms. `useDebouncedSave` is the canonical primitive. Test buttons read state vars directly — no `getValues()` indirection. See [`docs/design/libraries.mdx#form-patterns`](../content/docs/design/libraries.mdx).

Migration of these pages is now control-wrapper swaps only — state management is correct as-is.

---

## Deferred migrations

Grouped by hard rule, with the risk + the prerequisite that must be resolved before landing.

### HR1 — hand-rolled dialogs

| Site | Why deferred | Correct primitive |
|---|---|---|
| `app/_components/NotificationCenter.tsx:155` | Anchored dropdown, not centered dialog | `<Popover>` (use new wrapper) |
| `app/_components/RecentActionsCenter.tsx:117` | Same | `<Popover>` |
| `app/_components/OracleDock.tsx:1093, 1236` | Two anchored dropdowns | `<Popover>` |
| `app/_components/BranchActionRunner.tsx:159` | Non-dismissible status overlay; needs `closeOnEscape={false}` + `closeOnOutsideClick={false}` (Modal *minus* its escape hatches — arguably wrong primitive); risk: user can't dismiss if action hangs | `<Modal>` with escape hatches off, OR keep hand-rolled |
| `app/_components/OperatorPanel.tsx:1629` | Renders inside the OperatorDock which has its own dim layer — Modal adds a second dim layer; needs `overlayStyle={{ background: 'transparent' }}` | `<Modal>` with overlay suppressed |
| `app/_components/WslOnboardingGate.tsx:159` (the gate overlay itself) | This is a full-screen takeover at z:999999, AND it's the same component whose internal `alert()`/`confirm()` would need a Modal portal *above* z:999999. Needs the gate's z-index reduced to (say) 100 so ConfirmModal-from-inside renders above; OR keep gate as-is and migrate its alerts to a sibling ConfirmModal *outside* the gate's tree. **Bootstrap-order tweak (decision 13 from risk audit) actually means raising Modal z above gate z, OR lowering gate z below Modal z; the Toaster is already a sibling of the gate inside `<NuqsAdapter>` so toasts work today.** | Plan z-index strategy first |
| `app/installed/templates/[slug]/edit/page.tsx:534` | Full page is RHF-driven; modal is part of the form. Migration requires also handling HR2/HR3 inside it (5 selects + a checkbox + 5 titles). Worth doing as a single sweep. | `<Modal>` + full page rewrite |
| `app/settings/voice/page.tsx:986` | Part of the voice rewrite (see D6) | `<Modal>` + RHF migration |
| `app/harness/ExpertsPanel.tsx:624` | Has `aria-modal` set; needs scroll-lock and focus-trap analysis before swap | `<Modal>` |

### HR2 — raw checkboxes (deferred)

| Site | Why deferred |
|---|---|
| `app/_components/ForkCompletionForm.tsx:226` | RHF `register('acknowledgeAdvisories')` — needs `<Controller>` wrapper |
| `app/installed/templates/[slug]/edit/page.tsx:795` | RHF-driven page — needs `<Controller>` |
| `app/login/page.tsx:176` | RHF-driven (spec example) — needs `<Controller>` |
| `app/settings/backups/page.tsx:218, 251` | Auto-save semantics (see D6) |
| `app/settings/voice/page.tsx:556, 565, 578, 591` | Auto-save semantics (see D6) |
| `app/settings/plugins/page.tsx:329` | RHF-driven — needs `<Controller>` |
| `app/dev/_components/*` (8 sites) | `/dev` carve-out pending (D1) |

### HR3 — raw `<select>` (deferred)

| Site | Why deferred |
|---|---|
| `app/installed/templates/[slug]/edit/page.tsx:565, 573` (+3 inline) | RHF — needs `<Controller>` |
| `app/settings/backups/page.tsx:236` | Auto-save (D6) |
| `app/settings/voice/page.tsx` ×7 | Auto-save (D6) + iOS Safari validation (D5) |
| `app/settings/plugins/page.tsx:350` | RHF |
| `app/dev/_components/*` (4 sites) | `/dev` carve-out (D1) |
| `app/login/page.tsx:133` | RHF + NVDA validation (D5) |
| `app/harness/HarnessSettingsPanel.tsx:544`, `app/harness/ExpertsPanel.tsx:667` | Inside larger panels that need full-pass migration |
| `app/_components/OperatorPanel.tsx:1796` | Inside dock; needs portal z-stacking analysis |

### HR4 — `title=` on interactive elements (deferred)

**Non-list action buttons in chrome — DONE in Wave 2** (10 sites; see "What already shipped"). Remaining HR4 work below.

Risk recap: spec gotchas page explicitly warns about wrapping rows in Tooltip — mounts thousands of portals. Migration strategy for remaining sites:
- **Per-row repeats — KEEP `title=`** per spec soft-rule carve-out (verify each):
  - `ArchitectInbox.tsx:649, 659`, `SnapshotsPanel.tsx:320`, `HooksPanel.tsx:296, 305`, `brainstorm/MapView.tsx:321, 507, 516, 524`, `installed/templates/page.tsx:269, 312`, `installed/snapshots/page.tsx:228`, `dev/_components/SessionsTab.tsx:415`, `TelemetryTab.tsx:156`, `WorkspaceSwitcher.tsx:269, 278`
- **Annotations/badges — needs spec clarification** (D2-adjacent): `OperatorPanel.tsx:1992, 1995`, `settings/plugins/page.tsx:271, 274`, `settings/user/search/page.tsx:73`, `FeatureEditor.tsx:163`

**False positives in audit (do NOT migrate)** — these are component props named `title`, not DOM `title` attributes: anywhere `<Panel title="…">`, `<Section title="…">`, `<MarkdownPanel title="…">`, `<InboxSection title="…">`, `<Step title=…>`. `IconButton title=` is auto-wrapped to `<Tooltip>` per `primitives.tsx` — already compliant.

### HR5 — `window.alert/confirm/prompt` (deferred, biggest behavioral risk)

**Tier 1 destructive confirms — DONE in Wave 2** (8 sites). See "What already shipped". Pattern used: `useConfirmDialog` hook to preserve the `if (!await confirm()) return; <work>` async control flow as a one-line swap.

**Tier 2 simple-pattern confirms — DONE in Wave 2** (3 sites): `TemplatesModal.tsx`, `EscalationBanner.tsx`, `NotificationCenter.tsx clearAll`. All had clean try/finally cleanup separable from the confirm gate.

Remaining HR5 work after Wave 3:

**Tier 2 — confirm() inside async handlers** (need try/finally analysis before splitting):
- `app/harness/ProposalsPanel.tsx` ×4 (accept-many loops — see "loop-pattern risk" below)
- `app/harness/HarnessDashboard.tsx:3284, 3389` (reset/cleanup — check if any handler cleanup runs after confirm)
- `app/harness/PhaseTabs.tsx` ×3 (promote/demote/reset)
- `app/snapshots/page.tsx` ×4 confirm + 3 prompt sites — densest single file, mixed Tier 2/3
- `app/installed/snapshots/page.tsx` ×4 confirm + 1 prompt
- `app/marketplace/snapshots/page.tsx` ×3
- `app/harness/PromptsTab.tsx` ×1
- `app/settings/publishing/page.tsx` ×2
- `app/settings/voice/page.tsx` ×2 (deferred per D6)

**Tier 3 — prompt() with text capture** (needs Modal with form input, not just ConfirmModal):
- `app/harness/HarnessDashboard.tsx:3607, 3611` (checkpoint name + message — 2-step modal flow OR single modal with two fields)
- `app/_components/WorkspaceSwitcher.tsx:86` (workspace rename) — Note: `onCreate` already migrated to ConfirmModal-style flow in Wave 2 deletion path; rename still uses native prompt
- `app/_components/OperatorPanel.tsx:1207` (ignore reason)
- `app/snapshots/page.tsx` (×3 prompts inside the 7 calls above)
- `app/installed/snapshots/page.tsx` (rename)
- `app/installed/templates/[slug]/edit/page.tsx` (×1) — part of full-page rewrite

**Tier 4 — informational `alert()`** → `toast.error()` / `toast.success()`:
- `app/_components/WslOnboardingGate.tsx:107, 220, 274, 283, 288` (must come AFTER the gate z-index fix from HR1 deferral)
- `app/harness/HarnessDashboard.tsx` (any remaining `alert()` calls used to surface failures inline)
- All `alert()` calls in `app/dev/_components/BackupsTab.tsx` (defer pending D1)

**Loop-pattern risk** (must be refactored, not just swapped): handlers shaped like
```ts
selected.forEach(id => { if (confirm(`Delete ${id}?`)) doDelete(id); });
```
do NOT map to ConfirmModal one-to-one. Either bulk-confirm once ("Delete N items?") or rewrite as a sequential async chain. Sites: `ProposalsPanel.tsx` accept-many, `installed/snapshots/page.tsx` retract-many.

**`try/finally` risk**: `confirm()` inside an async function blocks the rest of the function until the user clicks. Splitting into onConfirm callback can strand cleanup logic that ran after `confirm()`. Audit each Tier-2 site for cleanup statements between the `confirm()` call and the function end before porting.

**Reliability risk**: native `confirm()` works even when React crashes (error boundary in scope). ConfirmModal renders via React. For SIGTERM specifically, consider keeping native `confirm()` as a fallback path, or wrap in a render-safety wrapper.

### HR6 — `<details>` (deferred)

| Site | Why deferred |
|---|---|
| `app/harness/LazyDetails.tsx` | **Spec amendment needed (D2 + D3)** — uses `<details>` for lazy mount; Radix Collapsible mounts eagerly. Update spec to allow. |
| `app/_components/OperatorPanel.tsx:2001` | Per-entry collapsible; large lists → Collapsible mounts everything eagerly. Verify perf before migrating |
| `app/_components/WslOnboardingGate.tsx:201` | Content disclosure (D2 carve-out candidate); also part of gate z-index work |
| `app/dev/_components/SessionsTab.tsx:592` | Lazy-mount transcripts + Ctrl+F (D1 + D3) |
| `app/dev/_components/TablesTab.tsx:445, 457` | Lazy-mount row expansions + Ctrl+F (D1 + D3) |
| `app/settings/voice/page.tsx:964` | Debug aid (D2 carve-out); part of voice rewrite |
| `app/settings/plugins/ProvisionPanel.tsx:155, 172` | Could migrate cleanly |
| `app/settings/api-keys/page.tsx:429` | Content disclosure (D2) |
| `app/settings/user/memory/page.tsx:138` | Content disclosure (D2) |
| `app/support/page.tsx:160` | Content disclosure (D2) |

### HR7 — `useState` chains in forms (deferred)

| Site | Why deferred |
|---|---|
| `app/settings/voice/page.tsx` | Auto-save + test-button semantics (D6); HR1+HR2+HR3+HR6+HR8 all bundled |
| `app/settings/backups/page.tsx` | Auto-save (D6) |
| `app/settings/mobile/page.tsx` | Auto-save (D6) |

### HR8 — raw `<table>` (deferred — biggest per-page effort)

All 17 sites deferred pending **D4 (print + copy-paste decision)**. Migration is column-definition rewrite, not a primitive swap — budget 0.5–1 day per page.

Order to migrate (when D4 is resolved):
1. `app/settings/plugin-runtime/RuntimeView.tsx` (3 tables; natural `RichGrid` — status pills)
2. `app/installed/plugins/[slug]/permissions/page.tsx:144` (harness × capability grid)
3. `app/installed/plugins/page.tsx:183`
4. `app/harness/IntelPanel.tsx` (4 tables)
5. `app/harness/HarnessSettingsPanel.tsx`, `app/harness/PromptBudgetView.tsx`
6. `app/admin/_components/TableAdmin.tsx:168`
7. `app/settings/voice/page.tsx` (×2 — part of voice rewrite)
8. `/dev/_components/*` (pending D1)

---

## Per-page memo items deferred (visual / UX, no hard-rule fix)

These are alive in the feedback memos but not represented in any HR violation. Need design pass, not primitive swap.

### `/installed/harnesses` (`harnesses-page-feedback.mdx`)
- C2 fold State column into name row → CSS grid template changes; may break column-width deep links
- C3 noisy Path column reduction
- C4 add "Add a new harness" primary action (introduces new form-control surface — use wrappers from day one)
- C9 add per-row "what's happening" preview
- C10 ARIA grid roles (or migrate to `RichGrid` which sets them)
- V2 Kind values: replace bare lowercase with badged labels (`app/installed/harnesses/page.tsx:52`)

### `/marketplace/*` (`marketplace-feedback.mdx`)
- C1 detail page broken — duplicate `<h1>` at `app/marketplace/[slug]/page.tsx:79, 113` (removing one changes heading hierarchy; verify deep-link anchors don't depend on it)
- C2 search ≠ on all tabs
- C3 stat counts contradict
- C4 heading repetition per tab
- C5 stats mix scopes (visible in `MarketplaceIndex`)
- C6 missing "what's new"/"featured" rail
- C7 no filter/sort controls
- C8 no update affordance on installed items
- C9 double-line tab labels noisy

### `/settings/*` (`settings-feedback.mdx`)
- C1 Flat list of 13 needs grouping (sidebar restructure)
- C2 Naming convention mixed (capitalization + concept-vs-feature)
- C3 No search across settings
- C4 Inconsistent Save patterns — directly tied to D6
- C9 Debug surfaces unlabeled (Plugin runtime, Meridian, Orchestrator)

### `/harness/<slug>` proposals tab (`proposals-tab-feedback.mdx`)
- R1 pending border subtle
- R2 dense status string
- R3 H2 in detail pane is the markdown's H1 (heading hierarchy)
- R4 auto-accept threshold not surfaced
- R5 empty state for Rejected 0

### `/harness/<slug>` feature/issue drawer (`feature-issue-drawer-feedback.mdx`)
- R1 9px severity/status chips (readability)
- R2 "current state" lifecycle button disabled
- R3 eyebrow chip text concatenates without spaces
- R4 "Feature detail" / "Issue detail" overline copy
- R5 chip color choices

### `/harness/<slug>` operator panel (`operator-panel-feedback.mdx`)
- N4 filters-active chip strip (missing — verify with browser)
- HUD ring animation philosophy (P1 originally killed the text strip; current animated reactor-core HUD arguably satisfies P1's "mood, not state" — confirm acceptable)

---

## Test-rewrite checklist (item 10)

Existing test surface for the audited routes is **minimal**:
- `e2e/home.spec.ts` — root `/` smoke. Not affected by any deferred migration.
- `e2e/voice-mode.spec.ts` — `/settings/voice`. **Will break when `/settings/voice` migrates to Radix Select** (currently uses semantic selectors, not native-`<select>` selectors, so the break is limited to the engine-list locator).
- `app/installed/snapshots/page.test.ts` — unit test for `bumpPatch` semver helper. Not affected.
- All `app/api/**/*.test.ts`, `lib/**/*.test.ts`, `test/*.integration.test.ts` — API/server-side; unaffected by UI primitive migrations.

**No Playwright dialog handlers (`page.on('dialog', …)`) found** — HR5 migrations won't break existing tests.

**No `page.selectOption()` calls found** — HR3 migrations won't break existing tests.

Practical test impact: just rewrite the engine-dropdown locator in `e2e/voice-mode.spec.ts` when voice migrates.

---

## Spec internal contradictions to resolve

- `<Tooltip>` decision-matrix entry covers buttons and labels; soft-rule carves out grid cells. **Informational badges** (`OperatorPanel.tsx:1992, 1995`, `settings/plugins/page.tsx:271, 274` — "publisher-specific", "secret") fall in neither bucket. Add a rule: "static informational badges → keep `title=`".
- HR5 says "never `window.confirm()`" but does not mandate a single helper. Now resolved — spec was updated 2026-05-13 to point at `<ConfirmModal>`.
- Decision matrix listed `Drawer.Root` for "side-slide drawer" but had no entry for "anchored dropdown panel". Now resolved — spec was updated 2026-05-13 to add `<Popover>`.

---

## 2026-05-13 followup — re-apply pass in worktree

**Background.** First pass of Waves 1–4 was made in-place on the main `papercup` checkout. A Paperclip agent then ran `git pull --rebase origin main` against that checkout (memory entry `feedback_paperclip_collision_race`), which discarded most of the uncommitted in-place edits. ~68 of ~80 migrated sites were reverted to their pre-migration state on disk.

**Recovery.** Re-applied everything in a separate worktree at `~/papercupai-workspace/papercup-design-migration/` on branch `design-migration-2026-05-13`. Commits (oldest → newest):

- `c44a9ea5` — helpers (ConfirmModal, Popover, PromptModal, useConfirmDialog, usePromptDialog) + Wave-4 survivors (EditTemplateClient, login, settings/plugins, settings/plugins/ProvisionPanel, settings/publishing) + gotchas.mdx carve-out + this doc.
- `04a1e688` — Wave-1 top-level chrome (Notifs, RecentActions, BranchActionRunner, Operator, Oracle picker semantic fix, WorkspaceSwitcher, Update, MarketplaceList, Support, Tutorial, Voice, HarnessSettings checkboxes, permissions checkbox, editor-demo cb, omp cb, user cb). `.notif-panel` CSS positioning removed (Radix Popover now handles placement).
- `d9bc8c2d` — Wave-2 harness chrome (HarnessDashboard reset/cleanup/SIGTERM/plugin-disable + 2-step checkpoint prompt, PhaseTabs, PlanReviewBanner, PromptsTab, SpecEditor reveal-.env typed confirm).
- `0a0295af` — Wave-3 Tier-2 harness panels (ArchitectInbox, ArchivesPanel, ChatPanel, CollectionTab confirm, EscalationBanner, FeatureEditor, FeatureList, HooksPanel, ScreenshotsPanel, SnapshotsPanel, TemplatesModal, ProjectDetail).
- `77bcb8ab` — Wave-3 settings + admin (shortcuts, mobile, operator, api-keys, user/memory ×3 incl. requireType="FORGET", admin/TableAdmin confirm + alert→toast, installed/plugins page ×2).
- `9d29ad8f` — Wave-4 surface push (ExpertsPanel modal+select+×3 confirm, ProposalsPanel ×4 confirm incl. replan typed-style, CollectionTab create-prompt, MarketplaceList uninstall, InstalledTemplatesClient delete + install-prompt, InstalledSnapshotsClient delete/retract + publish 2-step prompt, MarketplaceSnapshotsClient instantiate-prompt + publish + delete, SnapshotsClient densest file — 4-step retract prompt chain + publish + delete + instantiate).

Branch is on origin: `https://github.com/papercupai/papercup/pull/new/design-migration-2026-05-13`.

**Verification.** `npx tsc --noEmit` clean across the operator app (only the pre-existing `baseUrl` deprecation warning). Audit complete: zero `confirm(` / `alert(` / `prompt(` left in scope. The only remaining call sites are the four explicitly-deferred surfaces (WslOnboardingGate, `/dev/*`, `/settings/voice`, `operator-mock`).

**Lesson learned.** Whenever Paperclip is running in the same repo, work in a worktree on its own branch. The Paperclip collision-race memory entry will be amended to recommend this as the default.

---

## Where to start next session

Waves 1–4 shipped: ConfirmModal + Popover + PromptModal infra (with imperative `useConfirmDialog` + `usePromptDialog` hooks), HR2/HR3/HR4/HR5/HR6 swaps across **every** code-ready surface in the audit. The HR-fix backlog is essentially drained.

Next batches are either **design-judgment redesigns** or **blocked on user decisions** — not HR fixes:

**Design-judgment redesigns (need explicit direction):**

- **`/installed/harnesses` redesign** (harnesses-page-feedback C1–C10 + V2). Clear-cut pieces: fold State column into name, add "Add harness" primary action, badge bare `Kind` values, migrate to `RichGrid` for ARIA grid roles, add search input. Open pieces: filter/sort UX, per-row "what's happening" preview shape. Need user direction on the last two before starting.
- **`/marketplace` overview + per-tab redesign** (marketplace-feedback C2–C9). C1 is a data-loading bug (engineering), not design. C3 is also engineering (stat-count fix). The genuinely design pieces: C4 heading repetition cleanup, C5 unify stat scope, C6 "what's new" rail, C7 filter/sort controls, C8 update affordance on installed items, C9 simplify double-line tab labels. All need decisions on copy + layout direction.

**Blocked on user decisions (D1, D4, D6):**

- `/settings/voice` (worst-drift page — D6 auto-save semantics)
- `/settings/backups` (D6 auto-save)
- `/installed/plugins/<slug>/permissions` HR8 (D4 print/copy)
- `/admin` HR8 (D4)
- `/settings/plugin-runtime` HR8 (D4)
- `/harness/<slug>` Intel + Settings tab HR8 (D4)
- `/dev/*` (13 tabs — D1 dev carve-out)
- `WslOnboardingGate` alerts (needs z-index pre-work)

Do not start `/settings/voice` rewrite without resolving D6 first. Do not migrate `/dev/*` without resolving D1 first. Do not migrate the `WslOnboardingGate` alerts without first reducing the gate's z-index (or raising `<ConfirmModal>`'s portal z above 999999).

---

## Drain pass — 2026-05-14 (Phases 1–7 from `design-migration-deferred-2026-05-13.md`)

D1, D4, D6, WslOnboarding all resolved. Sequencing followed the dependency-graph plan; commits on `main`.

**Phase 1 — Spec revision (`b5ccab51`).** HR7 rewritten around the form-pattern decision tree (single-submit / per-field-auto-save / wizard) — none of D6 needed an RHF migration. New gotcha section + libraries section + decision-matrix row added.

**Phase 2 — `useDebouncedSave` (`f2ef034a`).** Canonical per-field auto-save hook in `app/harness/useDebouncedSave.tsx`. 8 vitest cases (skipFirst, coalescing, flush, lastSavedAt, onError, cancel-on-unmount, skipFirst:false). 300ms default debounce; `flush()` for Test-button-before-save flows.

**Phase 3 — RichGrid print + copy (`f144bb4` in `libs/papergrid`; `5fc76e00` operator).** `<table data-rg-print-mirror>` injected next to the virtualized grid, `@media print` swaps display. Ctrl+C handler writes `text/plain` (TSV) + `text/html` (`<table>`); Ctrl+A selects all rows. Helpers extracted to `copy-payloads.ts` (16 unit tests). Inline mode opted out (consumer owns the wrapper). New `ColumnDef` fields: `toCopyText`, `headerText`. New `RichGridProps`: `disablePrintMirror`, `printRows`, `disableCopySupport`.

**Phase 4 — D6 settings/voice + settings/backups (`d70ff463`).** Control-wrapper swaps only; state management untouched. Voice: HR1 leak-warning modal → `<Modal>`; HR2 ×4 output-behavior cb → `<Checkbox>`; HR3 ×10 → `<Select>` (engine, STT, TTS, ElevenLabs voice, privacy mode, agent language with `_auto` sentinel, wake-word engine, porcupine/openwakeword keywords, noise-suppression); HR5 ×2 → `useConfirmDialog`. Backups: 5 cb → `<Checkbox>`, cadence-minutes → `<Select>`. Radios kept native (no HR rule covers radios).

**Phase 5 — HR8 raw <table> → RichGrid.** Migrated (cumulative):
- `5b030bd1` Group A (3): PromptBudgetView, HarnessSettingsPanel telemetry, installed/plugins runtime status.
- `2b41e2a6` /settings/plugin-runtime ×3 (loaded plugins, registered actions, hook subscriptions) — `getRowBg` keeps the incomplete-action highlight.
- `ad289388` /admin TableAdmin (dynamic columns + Actions column).
- `3b732cff` /installed/plugins/<slug>/permissions matrix (capability × harness; per-harness `toCopyText` emits ✓/empty).
- `6755d437` /settings/voice ×2 (PerSlugVoiceTable + RoleVoicesTable; both with sentinel-mapped Select inside).
- `d543e530` IntelPanel ×4 (SpawnsTab + ArtifactsTab → RichGrid; GraphTab per-process symbols + definitions → CSS-grid div with `display:contents`, `role="list/listitem"`).

**Phase 7 — WslOnboardingGate (`f6a3406c`).** Gate `z-index` lowered 999999 → 60 (covers viewport via `position:fixed inset:0`; nothing else competes for the layer). Modal renders at z:100, toast at z:150. 2 `confirm()` + 3 `alert()` migrated: reset-runtime destructive, needs-elevation primary; finalize-failure + re-launch-failure + install-failure → `toast.error`. `Step` sub-component receives `askConfirm` as a prop (hook lives in the outer gate).

**Phase 6 — /dev controls.**
- `a4ea4756` 5 tabs (ApiTab, TelemetryTab, ProcessesTab, IpcTab, SessionsTab) — 6 raw checkboxes → `<Checkbox>`.
- `f317ad0b` SqlTab role select, BackupsTab snapshot-pick select, SchemaForm boolean checkbox.

**Phase 5+6 final pass — 2026-05-14 (cont.).**

All 12 `/dev` raw `<table>` migrated to `RichGrid`, plus the trailing HR3 selects in TablesTab + AuditTab. Per-file commits to dodge paperclip rebases:

  - `31639e4a` HarnessesTab (13 cols incl. ARIA + Verdict).
  - `274d04e0` AuditTab (6 cols + window <Select>).
  - `1a8ffdd3` TelemetryTab (8 cols incl. action button).
  - `91efb914` ProcessesTab (8 cols incl. kill-button via Modal).
  - `f9ef0fbb` PgTab (×2 — active queries + largest tables).
  - `a1a070f9` BackupsTab event log.
  - `5a8cbd25` SqlTab (dynamic columns from `result.columns` at runtime, plus role <Select>).
  - `5b40ac38` SessionsTab (×3 — top sessions with expandedRowKey + renderExpandedRow; inner tool-invocations and child-spawns).
  - `5a1a53e4` TablesTab (×2 — columns table + dynamic rows table; primary-key rows tinted via `getRowBg`; role + filter-col + filter-op selects → `<Select>`; FK/index `<details>` kept native as content-disclosure carve-out).

**HR-fix backlog drained.** App-wide scan: zero raw `<table>`, zero raw `<select>`, zero raw `<input type=checkbox>` outside of the wrapper-helper source files themselves.

**Still open (out of scope or intentional carve-out):**
- Two design-judgment redesigns: `/installed/harnesses` C1–C10, `/marketplace` C2–C9.
- StepAutoUpdate release-notes `<details>` — kept as content-disclosure carve-out per spec (`gotchas.mdx`).
