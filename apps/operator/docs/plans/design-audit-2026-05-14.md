---
title: Design-spec audit — operator app — 2026-05-14
slug: design-audit-2026-05-14
status: shipped
created: 2026-05-14
updated: 2026-05-30
owner: pandawamble@gmail.com
---

## Now

**State:** Audit of `apps/operator/app/` against the **Design** section of the internal docs (`/internal/docs/design`, `/internal/docs/design/libraries`, `/internal/docs/design/gotchas`). Goal: find violations only — no fixes in this pass.

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# Design-spec audit — operator app — 2026-05-14

Audit of `apps/operator/app/` against the **Design** section of the internal
docs (`/internal/docs/design`, `/internal/docs/design/libraries`,
`/internal/docs/design/gotchas`). Goal: find violations only — no fixes in
this pass.

## TL;DR

The harness UI is very clean — the multi-phase migration mostly held. Real
violations cluster in three places: **`app/dev/` admin tabs** (5 native
`<select>`s, several bespoke-styled inputs), **`app/admin/testing/`** (one
native checkbox), and **`app/installed/templates/[slug]/edit/`** (a local
`inputStyleSmall` style object that overrides the baseline and contains a
typo). Plus a handful of edge cases (mock pages, one HR1 boundary case,
two HR4 borderline `title=` calls).

## About the settings page the user linked

`localhost:3055/harness?ws=default&slug=sheets&panel=settings` renders
`app/harness/HarnessSettingsPanel.tsx`. It imports `Select` from
`./Select` and `Checkbox` from `./Checkbox`; its many `<input>` and
`<textarea>` elements are *unwrapped* and inherit the canonical look from
the global `:where(input, textarea)` baseline in `app/globals.css`
(L27203–27260). It uses native `<button>` which inherits the
canonical button baseline (L27289+). **This is the canonical input/select
look.**

The Design spec already specifies this:

- `design/index.mdx` "Decision matrix" row for text inputs:
  *"native `<input>` (styled via global baseline) **OR** `<TextInput>`
  for leading/trailing slots"*
- `design/index.mdx` HR3: *"Never write `<select>` with `<option>` for
  harness UI. Use `<Select>`."*
- `design/libraries.mdx` has a dedicated section
  **"Native `<input>` + `<textarea>` (styled via globals.css baseline)"**
  with the rationale and exclusion list, plus a parallel section on
  **`<Button>` wrapper + native baseline**.

So **2a is already satisfied** — the spec mandates it. A small tightening
is worth doing (proposed at the bottom of this report) to *forbid* inline
input style overrides that deviate from the baseline, which is the
mechanism most violations below use to drift away from the canonical look.

---

## Violations by rule

### HR3 — Native `<select>` in tsx (must use `<Select>`)

| File | Line | Notes |
|---|---|---|
| `app/dev/_components/SchemaForm.tsx` | 90 | Schema-driven form picker |
| `app/dev/_components/SessionsTab.tsx` | 174 | Session filter |
| `app/dev/_components/ProcessesTab.tsx` | 262 | Process filter |
| `app/dev/_components/TelemetryTab.tsx` | 88 | Telemetry filter |
| `app/dev/_components/ApiTab.tsx` | 305 | API request body picker |

All five are inside the `/dev` debug surface. They're still in-scope for
HR3 — there is no "dev pages excluded" carve-out in the spec, and these
pages are surfaced to users via the harness Dev tab.

### HR2 — Native `<input type="checkbox">` in tsx (must use `<Checkbox>`)

| File | Line | Notes |
|---|---|---|
| `app/admin/testing/_components/AIExploreTab.tsx` | 239 | `Headless` toggle |

The single offender. Everywhere else either uses the wrapper or is a
markdown-rendered task list (allowed carve-out).

### Native `<input type="radio">` (no wrapper exists; assess case-by-case)

The spec deliberately does **not** ship a `<RadioGroup>` wrapper —
libraries.mdx documents native radios with the `accent-color: var(--accent)`
baseline as the carve-out for ~5 sites. Three of four hits are inside
*spec-approved* sites:

| File | Line | Spec status |
|---|---|---|
| `app/settings/backups/page.tsx` | 230 | ✅ approved carve-out (cadence picker) |
| `app/settings/backups/page.tsx` | 278 | ✅ approved carve-out (retention picker) |
| `app/_components/SetupWizard/StepAutoUpdate.tsx` | 98 | ✅ approved carve-out (channel selector) |
| `app/settings/agent/page.tsx` | 200 | ⚠️ **not in approved list** — `backend` radio (claude-code / omp / auto) |

The agent-backend radio isn't in the approved-sites list. Either add it to
the carve-out list in `libraries.mdx`, or migrate to `<Select>`. (My
recommendation in the plan below: leave native + add to carve-out — the
visual is fine, it's just an unlisted site.)

### HR1 — Hand-rolled `role="dialog"` / `aria-modal="true"`

| File | Line | Verdict |
|---|---|---|
| `app/harness/Popover.tsx` | 94 | ✅ wrapper itself, intentional |
| `app/harness/FeaturePeekPanel.tsx` | 208 | ✅ inside `<Drawer.Content>` (vaul) — Drawer drives semantics; the manual `aria-modal` is redundant but not a violation |
| `app/harness/issues/IssueDetail.tsx` | 88 | ✅ same — inside vaul Drawer |

No real violations. (Could optionally remove the redundant `aria-modal`
attributes from the two vaul sites for tidiness, but vaul already sets it
internally.)

### HR4 — Native `title=` on action elements (must use `<Tooltip>`)

| File | Line | Notes |
|---|---|---|
| `app/operator-mock/page.tsx` | 355 | mock-page button — `title="Papercup settings"` |
| `app/operator-mock/page.tsx` | 358 | mock-page button — `title="Close (Esc)"` |

Both inside the operator design-mock page (`/operator-mock`). It's not
production UI but it *is* used as a reference for the real OperatorPanel
visual, so the mock leaking native `title=` is worth fixing.

### HR5 — `window.alert` / `window.confirm` / `window.prompt`

| File | Line | Notes |
|---|---|---|
| `app/operator-mock/page.tsx` | 355 | `alert('mock — opens /settings/operator')` |

All other hits are inside the `Confirm/PromptModal` wrappers (helpers that
*replace* the natives) or doc comments. Just the one mock-page violation.

### HR6 — Native `<details>` in tsx (interactive vs content-disclosure)

The gotchas page lists an explicit allow-list of content-disclosure
`<details>` sites. Cross-referencing the grep hits:

✅ **Approved by gotchas:** `app/_components/WslOnboardingGate.tsx`,
`app/support/page.tsx`, `app/settings/api-keys/page.tsx`,
`app/settings/user/memory/page.tsx`, `app/settings/voice/page.tsx`,
`app/_components/LazyDetails.tsx`.

✅ **Content-disclosure (prose / JSON dump):**
- `app/harness/dock/PinnedIssuePanel.tsx` (172, 222) — JSON notes + Section
  body. Content disclosure, compliant.
- `app/harness/dock/PinnedFeaturePanel.tsx` (182, 207) — JSON metadata +
  notes. Content disclosure, compliant.
- `app/harness/dock/sample-panels.tsx` (43) — sample panel demo. OK.
- `app/dev/_components/SessionsTab.tsx` (555) — transcript dump.
- `app/dev/_components/TablesTab.tsx` (458, 470) — table-row JSON dumps.
- `app/admin/testing/_components/LlmTab.tsx` (557, 567, 586) — LLM
  request/response dump. Content disclosure.
- `app/_components/SetupWizard/StepAutoUpdate.tsx` (164) — release notes
  prose. Content disclosure.

All compliant — these are exactly the case the gotchas carve-out
describes ("prose / diagnostic dumps / debug help text"). The dock
sites probably want to be added to the explicit allow-list in
`gotchas.mdx` so the next agent doesn't second-guess them.

### HR8 — Hand-rolled `<table>` for tabular data

None found. Clean.

### Off-baseline input styling (the "look" violations the user asked about)

These inputs *don't* use a wrapper, but they apply inline `style=` that
overrides the baseline and produces a different look than the
`/settings/*` canonical:

| File | Line | What |
|---|---|---|
| `app/installed/templates/[slug]/edit/EditTemplateClient.tsx` | 577 | `<input style={inputStyleSmall}>` — uses `var(--bg-3))` (note the **stray `)`** — that's a typo, value resolves to invalid CSS), `border-radius: 3` (baseline is 4), and `--bg-3` instead of baseline `--bg-2` |
| `app/installed/templates/[slug]/edit/EditTemplateClient.tsx` | 622 | `<textarea style={{ ...inputStyleSmall, ... }}>` — same drift, plus `padding: '6px 8px'` (matches `TextArea` wrapper, but coming from the bespoke style object) |
| `app/installed/templates/[slug]/edit/EditTemplateClient.tsx` | 589, 609 | `<Select triggerStyle={{ ...inputStyleSmall, ... }}>` — passes the bad style object through to Select's trigger; same `var(--bg-3))` typo |

The `inputStyleSmall` object (L641–645) is the root cause. It predates
the baseline migration. **Highest-priority style violation** because (a)
the typo is a real visual bug, (b) it sits on a user-facing edit page,
(c) replacing it with the wrappers is a one-line change.

A spot-check of all other `<input style=`/`<textarea style=` in `app/`
turned up only this file with non-trivial background/border overrides —
nothing else in the operator app drifts from the baseline visually.

### Off-baseline form widgets in dev tabs

The `<input>` elements in `app/dev/_components/*` (IpcTab, TablesTab,
ProcessesTab, ApiTab, WorkspacePicker) are mostly **unwrapped natives
that DO inherit the baseline** — those are compliant. The selects flagged
above (HR3) are the real violations there.

---

## Recommended fix batches (for the next pass)

### Batch 1 — Canonical-input drift fix (highest leverage, smallest blast)
- `app/installed/templates/[slug]/edit/EditTemplateClient.tsx`
  - Delete `inputStyleSmall` (L641–645).
  - Replace L577 `<input style={inputStyleSmall}>` with `<TextInput>`.
  - Replace L622 `<textarea style={{...}}>` with `<TextArea>`.
  - For L589 / L609 `<Select triggerStyle={inputStyleSmall}>`, drop
    `triggerStyle` — let Select use its own default styling.
- Acceptance: visually identical *except* the `var(--bg-3))` typo is gone
  and the page matches `/settings/*` styling.

### Batch 2 — HR3 native `<select>` → `<Select>` migration in `/dev`
Five files, one pattern repeated. All inside `app/dev/_components/`.
- `SchemaForm.tsx:90`
- `SessionsTab.tsx:174`
- `ProcessesTab.tsx:262`
- `TelemetryTab.tsx:88`
- `ApiTab.tsx:305`

Each is a small wrap — options + value + onChange. Risk: low. Visual
result: dev tabs match the harness theme instead of OS-themed white
on macOS.

### Batch 3 — HR2 native checkbox in admin/testing
- `app/admin/testing/_components/AIExploreTab.tsx:239` — replace the
  `<input type="checkbox">` with `<Checkbox>`.

### Batch 4 — HR4 + HR5 in operator-mock
- `app/operator-mock/page.tsx:355,358` — wrap the two `<button title=…>`
  in `<Tooltip>`, and replace the `alert(...)` with a `toast.info(...)`
  or simply remove (it's a mock label, not user-actionable).

### Batch 5 — Spec tidy-ups (no app code changes)
Three small doc updates flushed out by this audit:

1. **`design/libraries.mdx` — "Native checkbox / radio / range" section.**
   Add `app/settings/agent/page.tsx` (`backend` radio) to the approved
   carve-out site list. (The alternative is to migrate it to `<Select>`;
   per spec preference for low-priority radio sites, I'd add to the
   carve-out.)

2. **`design/gotchas.mdx` — "Native `<details>` is fine for content
   disclosure" section.** Add the four dock + dev-tab sites to the
   explicit approved-sites list so future agents don't re-litigate them:
   `app/harness/dock/PinnedIssuePanel.tsx`,
   `app/harness/dock/PinnedFeaturePanel.tsx`,
   `app/dev/_components/SessionsTab.tsx`,
   `app/dev/_components/TablesTab.tsx`,
   `app/admin/testing/_components/LlmTab.tsx`.

3. **`design/libraries.mdx` — tighten the input baseline section.** Add
   a one-sentence rule under "When the baseline is enough": *"Don't
   apply inline `style={{ background, border, borderRadius, padding }}`
   to an `<input>` or `<textarea>` — that drifts the look away from the
   canonical baseline. If you need a different look in one place, reach
   for `<TextInput>` and document why; if you need it everywhere, change
   the baseline."* This directly addresses the user's 2a — promotes the
   "use these inputs" guidance from implicit (baseline + wrappers) to an
   explicit "don't override" rule.

### Batch 6 — Optional, lower-priority cleanups
- Remove the redundant `aria-modal="true"` from `FeaturePeekPanel.tsx`
  and `issues/IssueDetail.tsx` (vaul sets it; the attribute is duplicate).

---

## Suggested execution order

1. Batch 5 (docs) — cheapest, sets the rule before code changes happen.
2. Batch 1 (EditTemplateClient) — single file, fixes a real bug (the
   `var(--bg-3))` typo).
3. Batch 2 (5 native `<select>` in `/dev`) — biggest visual win.
4. Batches 3 + 4 (one-line each).
5. Batch 6 (optional tidy).

Total: ~10 files, all small edits.

## Verification per batch

- **Batch 1:** load `/installed/templates/<slug>/edit`; the label /
  description fields should match `/harness?panel=settings` inputs
  pixel-for-pixel (same bg `--bg-2`, same 4px radius, same 12px font).
- **Batch 2:** load `/dev` and click each tab; selects should render
  the Radix-portaled listbox, not OS chrome.
- **Batch 3:** `/admin/testing` Headless checkbox should look like every
  other Checkbox in the app (lucide Check icon, accent fill).
- **Batch 4:** `/operator-mock` settings & close buttons get Radix
  Tooltips on hover; clicking settings shows a sonner toast (or no-ops).

## Out of scope for this audit

- The full settings-feedback memo at `design/settings-feedback.mdx` —
  that's a much bigger redesign about save patterns / rail grouping
  / etc., and it's its own workstream.
- Performance budget audits (gotchas §Performance budget).
- Bundle-size budget audits.
- The `/operator-mock` page's larger structure (it's a design mock).

---

## Implementation + verification log (2026-05-20)

All 6 batches implemented, plus the git-panel fix and HR4 follow-up.

**Deterministic verification — PASS:**
- `libs/git-graph` vitest: 4/4 pass (exercises `CommitDetail` + the new `GitTooltip`).
- operator `tsc --noEmit`: zero errors in any touched file (pre-existing errors in
  `RealGitPanel.tsx`, `operator-mock` JSX-namespace, `AIExploreTab` event types,
  `BackupsTab` — all unrelated, confirmed by line range).
- css-token lint (`app/_lints/css-tokens.test.ts`): zero violations in touched files
  (5 failures all pre-existing in concurrent agents' `SetupWizard`/`LlmTab` work).

**Live browser verification:**
- `/dev` → Telemetry tab: loads, renders data, zero console errors → Batch 2 verified.
- Git panel (`/harness/<slug>/dock-preview` → add `data:git`): BLOCKED. The shared
  OMP-managed dev server (:3055, pid chain under `omp`) is wedged in a self-perpetuating
  Fast Refresh rebuild loop (rebuilds every ~1-2s with no file changes for 9+ min).
  The git panel's `dynamic(() => import('@restart/git-graph'))` chunk never finishes
  on-demand compilation → stuck on "Loading git graph…". Established this is the wedged
  server, not the code: the chunk request is never even issued, and vitest+typecheck pass.
  Needs a dev-server restart for a clean visual pass.
- `/installed/templates/<slug>/edit` (Batch 1): BLOCKED — `papercusp-templates` feature
  flag is OFF, route disabled. Verification rests on typecheck + the change being a pure
  removal of bespoke inline styles (lets the global baseline apply).

**Concurrent-edit note:** `libs/git-graph` had in-progress uncommitted work from another
agent (a `CommitDetail` fetch/abort refactor + a `git-graph.css` drawer-bg fix). My
changes were re-applied on top without disturbing theirs; both coexist in the working
tree. Nothing committed — the parent repo and the submodule both carry intermixed
multi-agent work; committing is left to the user.
