---
title: Papercusp dogfood — design memo — create-harness picker UX (P-012)
slug: dogfood-design-memo-create-harness-picker-ux-2026-05-24
created: 2026-05-24
updated: 2026-05-25
status: ready
---

# Design memo — create-harness picker UX (P-012)

> Fourth dogfood-arc design memo. Sister to `binding-service-api`,
> `device-attestation-ux`, `two-channel-binding-ux` (all 3 accepted
> 2026-05-24). This one is the FIRST USER-VISIBLE SURFACE of the
> dogfood arc per Phase 1a plan + therefore design-gated before
> any paperclip-zone implementation.

## Now

**State:** draft for review. P-012 picker UI is the only remaining Phase
1a work item; backend is feature-complete (Entries 1/2/3 wired; Entry 4
placeholder until Phase 1b P-009 lands). This memo specs the 4-entry
picker UX so the implementer (when paperclip coordination + UX
agreement settle) drops in markup that's pre-decided on layout +
copy + error states.

**Next action:** user reviews. On accept, implementer can begin
paperclip-coordinated P-012 work using the shapes pinned in this memo
+ the discriminated union in `create-harness-entry-types.ts` (already
in tree as 32nd types module).

## Background

Per v5 §3 four mutually-exclusive entry points:
- Entry 1 — New local directory (non-git)
- Entry 2 — GitHub URL (shared-only per D-025)
- Entry 3 — Existing local repo
- Entry 4 — Harness link (`papercusp://harness?...`)

Backend route + types-only spine in tree:
- `POST /api/harness/projects` extended for Entries 1+2+3 (commit `3caa50ca`)
- `create-harness-entry-types.ts` discriminated union + validator + labels
- `harness-shared-config-types.ts` (Entry 4 link parser)
- `harness-link-types.ts` (`papercusp://` URL parser)

Implementation is paperclip-zone (`apps/operator/app/harness/` or
`apps/operator/app/admin/harness/`). Implementer must coordinate via
`pgrep -af paperclip` + commit-fast-don't-stomp discipline per the
`harness-paperclip` skill.

## Design

### The picker — 4 cards top-to-bottom

```
┌─ Create harness ─────────────────────────────────────┐
│                                                       │
│  ┌─ New local directory ─┐  ┌─ GitHub URL ─────────┐ │
│  │ Start fresh. Private. │  │ Paste github.com URL.│ │
│  │ Folder + name.        │  │ Joins or creates     │ │
│  │ [private default]     │  │ shared.             │ │
│  │ ✓ no GitHub auth      │  │ ✓ requires GitHub   │ │
│  └───────────────────────┘  └─────────────────────┘ │
│                                                       │
│  ┌─ Existing local folder┐  ┌─ Harness link ──────┐ │
│  │ Use a folder you have.│  │ papercusp:// from a │ │
│  │ Slug + path.          │  │ teammate.           │ │
│  │ [private default]     │  │ [inherits state]    │ │
│  │ ✓ no GitHub auth      │  │ ✓ requires GitHub   │ │
│  └───────────────────────┘  └─────────────────────┘ │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Card content (per-entry, source: `ENTRY_DISPLAY_LABELS` + `ENTRY_DISPLAY_DESCRIPTIONS`)

| Entry | Title | Description | Auth required | State |
|---|---|---|---|---|
| 1 | New local directory | Start a new local-only project. Private by default. | No | private |
| 2 | GitHub URL | Paste a GitHub URL. Joins or creates a shared harness. | Yes | shared-private |
| 3 | Existing local folder | Use a folder you already have. Private by default. | No | private |
| 4 | Harness link | Paste a papercusp:// link from a teammate. | Yes | inherits |

### Selecting a card → per-entry form

Each card click reveals a focused form. No modal navigation — the picker
collapses into "selected card with form below + back button."

#### Entry 1 form
- Folder name (text input, validated kebab-case)
- Parent directory picker (native OS dir-picker via Tauri)
- Description (vditor markdown editor)
- "Create" button (disabled until validateCreateHarnessEntry → ok)

#### Entry 2 form
- GitHub URL (text input, https://github.com/... validated client-side)
- Description (vditor)
- "Continue" button → triggers OAuth if needed, then dispatches POST /harness/projects
- During wizard step 2 (binding lookup), if existing binding found, the
  form swaps to a confirm card: "A shared Papercusp harness already
  exists for this repo. Join existing harness?" (primary action) + "Back"

#### Entry 3 form
- Slug (text input)
- Folder path (native dir-picker)
- "Use this folder" button

#### Entry 4 form
- Harness link (textarea, validates papercusp:// prefix + parseHarnessLink)
- "Join" button → fires OAuth + dispatches the §0.2 attestation flow + Entry 4 clone

### Progress UI for clone/init

Long-running operations (Entry 2's clone, Entry 4's full §0.2 + clone +
Hyperbee bootstrap) show an inline progress strip rather than a modal:

```
┌─ Joining papercup-ai/papercup ─────────────────────┐
│  ✓ OAuth verified                                   │
│  ✓ Cloned to /home/avi/papercup                    │
│  ✓ Joined Hyperswarm topic                         │
│  ⏳ Bootstrapping Hyperbee state...                 │
│      [============>          ] 42%                  │
│  · Channel 2 contributor file (waiting)             │
└─────────────────────────────────────────────────────┘
```

Per-step states: `pending | in_progress | success | failure`. Failures
surface inline with retry + "open detail logs" actions.

### Error handling

Per `validateCreateHarnessEntry` discriminated union:
- `missing_field` → red inline annotation on the specific field
- `bad_url` → "Not a valid URL" toast + field annotation
- `bad_oauth_token` → fires the §0.2 attestation flow (if first time on
  device) or "Sign in with GitHub" CTA (if expired)
- `bad_path` → "Path doesn't exist" + dir-picker re-trigger

Backend errors per `clone-github.ts` / `init-local-dir.ts` structured
error codes (`invalid_url|invalid_path|dest_exists|git_missing|unknown`)
map to UI copy via a centralized `errorCodeToCopy()` helper.

### State preservation

Picker URL state via nuqs:
- `?picker=entry_1_init` (or `entry_2_github_url`, etc.) → opens that
  card's form preselected
- Form-field state stays in `useState` (per the "transient lifecycle"
  exception to the nuqs default rule — drafts shouldn't survive page reload)

### Privacy explainer (Entry 2 + Entry 4)

Per v5 §5 step 7 privacy-modal copy:
- Entry 2: "Anyone with this repo link or harness link can join and see
  all contributors' GitHub usernames + avatars."
- Entry 4: Shows BOTH the §5.1 provisional-owner explainer (if creating
  a new binding) OR the join-existing summary (if binding exists).

Both surfaces use the `harness-shared-config-types.HARNESS_SHARED_PRIVACY_LEVELS`
enum + the shared modal component from `Phase1aPickerModal.tsx` (new).

## Implementation notes for the agent

### Files (all NEW — no existing-file edits in paperclip-zone)

- `apps/operator/app/harness/CreateHarnessPicker.tsx` (new)
- `apps/operator/app/harness/CreateHarnessForm.tsx` (new — wraps the 4 sub-forms behind a discriminated `kind` switch)
- `apps/operator/app/harness/EntryNewLocalForm.tsx` (new)
- `apps/operator/app/harness/EntryGithubUrlForm.tsx` (new)
- `apps/operator/app/harness/EntryExistingLocalForm.tsx` (new)
- `apps/operator/app/harness/EntryHarnessLinkForm.tsx` (new — placeholder until Phase 1b P-009)
- `apps/operator/app/harness/CreateHarnessProgressStrip.tsx` (new)

All NEW files; no rename or refactor of existing files. Reduces
paperclip-stomp risk to near-zero — paperclip only touches files it
already knows about + new files added in-session don't trip its
diff comparisons.

### Paperclip coordination

Per the `harness-paperclip` skill:
1. `pgrep -af paperclip` immediately before each Edit/Write
2. `locks:acquire` on every file before touching
3. Commit + push within ~5 minutes of each substantive edit
4. If paperclip is actively rewriting `app/harness/*.tsx` files this
   session, defer the picker work — paperclip's UI passes are also
   user-driven, no need to race

### Types-only spine that ships INTO the form

Every form imports from these (already in tree):
- `create-harness-entry-types` — discriminated input + validator + labels
- `harness-shared-config-types` — privacy enum + .harness/shared.json shape
- `harness-link-types` — papercusp:// URL parser (Entry 4)
- `harness-state-types` — default state per entry, capability gates

The form's role is markup + Tauri-native-picker wiring + dispatching
POST /harness/projects with the validated discriminated input. Pure
decisions live in the types modules.

## Open questions

### Q-1 — Vditor or plain textarea for description?

v5 §3 P-012 spec says "uses vditor for description input." Vditor is
already a project dep + already used in other surfaces (decisions
editor, harness summaries). Default: yes vditor.

Counter-argument: the create-harness flow is "I'm setting up a new
project, I don't have markdown to paste yet." A plain textarea may be
faster + less surprising. Picker may show vditor and let users skip
it (empty description allowed) — that's the v1 compromise.

### Q-2 — Auto-derive Entry 1 slug from folder name?

Folder name `my-cool-project` → slug `my-cool-project` (lowercased,
kebab-cased). Saves the user a field; eliminates the slug ≠ folder
class of confusion.

Counter-argument: the user may want a slug that differs from the
folder for display reasons. v1: auto-derive but allow override via
an "Advanced: customize slug" expander.

### Q-3 — Show all 4 cards or progressively disclose Entry 4?

Entry 4 requires a teammate having already created a shared harness +
shared its link. For a brand-new user with no teammates, the Entry 4
card is dead weight. v1: show all 4 always (consistent UI, simpler
to reason about); future v2 may collapse Entry 4 into an "I have a
link" link below the 3-card grid for new accounts.

## Cross-references

- `papercusp-dogfood-phase1a-workspace-ui-shell-2026-05-24.md` — parent
  plan; P-012 is the last open item.
- `apps/operator/lib/harness/create-harness-entry-types.ts` — discriminated
  input + validator + labels.
- `apps/operator/lib/harness/harness-shared-config-types.ts` — privacy
  enum + .harness/shared.json shape.
- `apps/operator/lib/harness/harness-link-types.ts` — Entry 4 URL parser.
- `apps/operator/lib/harness/harness-state-types.ts` — default states.
- v5 §3 (lines 273-309) — 4-entry spec verbatim.

## Acceptance criteria for this memo

- [ ] User reviews the 4-card layout + per-entry form descriptions.
- [ ] Q-1 (vditor vs textarea), Q-2 (auto-slug), Q-3 (Entry 4 always
      visible) resolved either in memo body or as D-decisions in
      Phase 1a plan.
- [ ] On accept, promote to status: accepted + the implementer can
      begin paperclip-coordinated work using the file plan above.
