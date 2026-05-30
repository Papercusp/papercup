---
title: Scout/SSE convergence — papercup-side loose ends
slug: scout-convergence-papercup-2026-05-30
status: shipped
created: 2026-05-30
updated: 2026-05-30
owner: avi@storewolf.com
related: [sse-typed-events-2026-05-12, search-core-rerank-adoption-2026-05-30, papercusp-systems-abstraction-2026-05-29, HANDOFF-systems-abstraction-phase2-2026-05-30]
---

# Scout/SSE convergence — papercup-side loose ends

## Now

**State:** This plan is the **papercup-side** execution of a cross-repo hand-off
brief written by the Restart-side Scout-refactor agent. The brief itself lives in
the **Restart** repo at `/home/marsh-office/Restart/docs/plans/papercusp-handoff-brief-2026-05-30.md`
(commit `0ed4c957` on Restart's `feat/scout-unify` branch — NOT on papercup's
origin; "origin" in the brief means `github.com/aviynw/Restart`). Companion docs
in the Restart repo: `scout-refactor-STATUS-2026-05-29.md` and
`scout-chat-protocol-convergence-assessment-2026-05-30.md`.

The brief lists 5 papercup-side items. All 5 have been **ground-truthed against
papercup `main`** (the brief described the Restart side; papercup's reality
diverges — see findings below). **Two gating decisions are made** (D-001, D-002).
Item ① (Phase 6) is sequenced behind item ② (org rename) so papercup adopts the
final package name once, not twice.

**Standing constraint:** papercup local `main` is **89 commits ahead of
`origin/main`** (0 behind). The "don't push without asking" rule from
`HANDOFF-systems-abstraction-phase2` and the `P-040` "coordinated submodule push
owed" applies. **Every push in this plan is user-gated.** The rename touches 4
shared submodules (`sse`, `sync`, `agent-chat`, `papercusp`), and pushing the
`libs/sse` `name` change forces Restart lockstep (Restart's `@restart/sse` +
6 `chat-protocol` consumers must migrate simultaneously).

**Progress (2026-05-30):** DONE — P-001 (in-tree sse rename), P-002 (sync/agent-chat
submodule refs), P-004 (sse pin-fork reconcile + push), P-005 (4 shared-lib pins
pushed FF; P-040 owed pushes discharged), and **P-003a** (chat-protocol org rename +
D-003 optional fields + Restart lockstep, pushed). **Item 2 (org rename) is fully
done for both shared libs; items 3 & 4 done.** The sse + chat-protocol renames are
consistent across papercup + all `Papercusp/*` remotes + Restart `feat/scout-unify`.

**ALL BRIEF ITEMS COMPLETE** (P-001…P-005, P-003a/b). The Scout/SSE convergence is
done across all three repos: papercup adopts the shared `@papercusp/sse` +
`@papercusp/chat-protocol` wire contract, all pins are pushed & fresh-cloneable, and
Restart consumes the same renamed packages. The chosen adoption (extend the shared
wire type, keep papercup's rich discriminated types) achieved option A with zero
consumer churn — better than the flat-presentation rewrite the original spec feared.
Only **P-006** (optional `sseResponse` Node adapter) remains deferred; no one blocked.

**Next:** nothing required. Optional follow-ups: P-006; and rewire the 33
`plan-parser` shim consumers (a separate systems-abstraction tail, unrelated).

## Background

`@restart/sse` (the package in the shared `Papercusp/sse` repo, consumed by both
papercup as `libs/sse` and Restart as `libs/sse`) and `@restart/chat-protocol`
(`Papercusp/chat-protocol`, consumed by Restart, 0× by papercup) carry the legacy
`@restart/*` scope even though they live in the `Papercusp` org. A
`@restart/* → @papercusp/*` consolidation is already in flight
(`@papercusp/rerank`, `@papercusp/search-core` done; all systems-abstraction
packages born `@papercusp/*`). The brief asks papercup to (1) adopt the shared
chat-protocol wire contract and (2) decide the org-scope rename.

## Decisions

### D-001 — Org-scope rename: rename `@restart/sse` + `@restart/chat-protocol` → `@papercusp/*`, batched
Date: 2026-05-30. User decision ("Rename, batched"). Rename both to the
`@papercusp/*` scope, consistent with the in-flight migration, **before** Phase 6
so papercup adopts the final name once. Pre-alpha ⇒ no deprecation aliases.
Note (finding): there is no *actively running* broad codemod to literally batch
into (coord presence empty; rerank/search-core already complete) — "batched"
means do sse + chat-protocol together as one coherent coordinated change using
the `@papercusp/*` scope, matching the established `@papercusp/rerank` wiring
(package `name` + `node_modules` symlink; resolution is symlink-only, no tsconfig
`paths`/vite alias for these scoped packages).

### D-002 — Phase 6: adopt the shared contract at the wire boundary only (option A)
Date: 2026-05-30. User decision ("A — share wire contract"). papercup imports the
shared `ChatEvent` union + `OpenCardSnapshot` for its **SSE/state-channel emit
path only**; `packages/tooldef/src/types.ts`'s generic, zod-driven
`CardSpec<TSchema>` / `CardResponse<TSchema>` stay the **internal source of
truth**, mapped to the wire snapshot at emit time (papercup already serializes
the schema to `dataSchemaJson`). The shared card types are a lossy simplification
of papercup's, so a wholesale swap would regress papercup's server-side card
system; the `ChatEvent` stream union is a clean match.

### D-003 — Option A must add the dropped wire fields as OPTIONAL (sub-question resolved)
Date: 2026-05-30. The assessment left open whether papercup clients need
`style`/`hint`/`voiceAnswerable` on the wire. **Confirmed they do:** `opt.hint`
is rendered in `apps/operator/app/_components/chat/AskChoiceCard.tsx:211`, and
`voiceAnswerable` is load-bearing across `apps/operator/lib/voice-cards/*` +
`ask_choice.ts`. So option A adds `hint` + `style` + `voiceAnswerable` +
`dataSchemaJson` to the shared `OpenCardSnapshot`/`CardPresentation`/`CardOption`
as **optional** fields (back-compatible for Scout's 6 consumers).

### D-004 — Dual-symlink transition for the sse rename (no forced push, fully reversible)
Date: 2026-05-30. Node resolves bare specifiers by the `node_modules` dir name,
not the package's `name` field, so keeping BOTH `node_modules/@restart/sse` and
`node_modules/@papercusp/sse` (each → `../../libs/sse`) lets old and new imports
coexist. This decouples the in-tree codemod (do now, local, reversible) from the
submodule migrations + pushes (gated). Drop the `@restart/sse` symlink only after
every in-tree AND submodule ref is migrated.

## Ground-truth findings (verified against papercup `main`)

- **Item ① chat-protocol:** imported **0×** in papercup; `tooldef/src/types.ts`
  holds the generic zod-driven card types exactly as the assessment describes.
- **Item ② rename blast radius:** `@restart/sse` = **73 import sites** (72 bare +
  1 `/react`) + **6 `package.json` deps** + the `libs/sse` `name`. Distribution:
  52 in-tree (apps/operator 46, agent-mcp 3, tooldef 1, desktop-ipc 1, flags 1)
  + 4 in-submodule (`sync`, `agent-chat`, `papercusp`, `sse` self) import sites;
  4 in-tree + 2 submodule (`sync`, `agent-chat`) package.json deps. Resolution is
  symlink-only (no tsconfig `paths`/vite alias).
- **Item ③ libs/sse pin is NOT cosmetic — it's a fork:**
  `44a3dec` (origin/main) has two divergent children — `415f191` ("add
  .gitignore", = `Papercusp/sse` remote `main`, the brief's bump target) and
  `fdda003` ("fix(server): repair two type errors", papercup LOCAL main pin via
  commit `a3e9be99`). Neither contains the other; `fdda003` is local-only (not on
  any sse remote). A blind bump to `415f191` would DROP the type-error fix. Fix =
  land both on `Papercusp/sse` main, then re-pin.
- **Item ④ four divergent pins (papercup side):** `agent-chat` (`c538393f9`) is on
  `origin/main`; `git-graph` (`cf3246046`), `sync` (`43363d874`),
  `ui-primitives` (`8075a3c2a`) are **local-only** — so papercup itself can't be
  cleanly fresh-cloned. These are the SAME unpushed pins as systems-abstraction
  `P-040`'s "coordinated submodule push owed" (user-gated). The brief's item-4
  table is *Restart's* separate divergent set on the legacy `papercupai/*` org
  (force-push risk there).
- **Coordination:** coord presence + locks both empty at start; no live owner to
  collide with on the rename.

## Phase 1 — In-tree sse rename (now, local-only)

- **P-001** `todo` — In-tree `@restart/sse` → `@papercusp/sse` rename (dual-symlink
  transition, local-only, no push). Add `node_modules/@papercusp/sse` symlink
  (keep `@restart/sse`); set `libs/sse/package.json` `name` → `@papercusp/sse`
  (local submodule commit); codemod 52 in-tree import sites + 4 in-tree
  package.json deps. Verify: no in-tree `@restart/sse` import remains, both
  symlinks resolve, targeted typecheck clean. Commit locally.
## Phase 2 — Gated cross-repo (on user push authorization)

- **P-002** `done` (local) — Migrated the live shared-lib submodule refs:
  `libs/sync` (`6b29966`) + `libs/agent-chat` (`dd2511c`) now consume
  `@papercusp/sse` (package.json + src). **Did NOT touch `libs/papercusp`** — its
  only ref is in the being-removed `apps/web/HarnessDashboard.tsx` (`@papercusp/web`,
  retired surface) and committing into the 2 MB orchestrator submodule would churn
  a pin other plans actively manage for zero value. So the **`@restart/sse`
  node_modules symlink is RETAINED** as a transitional alias covering that one
  lingering ref; it drops when the HarnessDashboard removal lands. Push of these
  submodule pins is folded into the P-005 coordinated push.
- **P-003a** `done` — chat-protocol org rename + D-003 field additions, shipped &
  pushed. `Papercusp/chat-protocol` main `524a446→50a066e`: renamed
  `@restart/chat-protocol → @papercusp/chat-protocol` + added `hint`/`style`
  (CardOption), `voiceAnswerable` (CardPresentation), `dataSchemaJson`
  (OpenCardSnapshot) — all OPTIONAL, back-compat for Scout's consumers. Restart
  lockstep: 5 consumers + tsconfig path + symlink + pin (`80bcdd25` on
  `feat/scout-unify`, pushed). Item 2 (org rename) is now fully done for BOTH
  shared libs; the shared chat-protocol types are adoption-ready.
- **P-003b** `done` — papercup emit-path adoption (option A), shipped & verified.
  Added `Papercusp/chat-protocol` as papercup submodule `libs/chat-protocol`
  (`abedf9c`) + symlink + `@papercusp/chat-protocol` dep in `packages/tooldef`.
  `packages/tooldef/src/types.ts` now re-exports the shared `ChatEvent` and makes
  `OpenCardSnapshot` **extend** the shared wire type (`Omit`-ing `presentation` +
  `dataSchemaJson`, keeping papercup's richer discriminated `CardPresentation` +
  required `dataSchemaJson`). A compile-time `_AssertWireCompatible<OpenCardSnapshot>`
  proves papercup's snapshot is a valid shared wire snapshot (a future drift fails
  the build). **Zero consumer churn** — the discriminated presentation is preserved.
  Shared-type reconciliation done in lockstep across `Papercusp/chat-protocol`
  (`50a066e→01f947f→abedf9c`: added `hint`/`style`/`voiceAnswerable`/`dataSchemaJson`,
  widened `min/max`→`number|string`, added `multiline`, made `presentation`
  optional — all back-compat) + Restart (`ef6744cc`: re-pin + 3 `?.` guards in shop
  RecommenderChat). Verified: tooldef wire-compat assertion passes; tooldef tsc 0
  new errors; state-channel + card-correlator 31/31; operator voice-cards +
  state-snapshot 55/55. (Pre-existing unrelated failure observed:
  `operator-state-snapshot.test.ts` file-load fails on a `@papercusp/backup` seam
  mock missing `workspacesRoot` — not chat-protocol-related.)
  Original spec retained below for reference:
  1. Add `Papercusp/chat-protocol` as a papercup submodule at `libs/chat-protocol`
     + `node_modules/@papercusp/chat-protocol` symlink + `package.json` dep
     (papercup resolves scoped pkgs by symlink, no tsconfig path needed).
  2. Make papercup's WIRE `OpenCardSnapshot` the shared type: in
     `packages/tooldef/src/card-correlator.ts:pendingToOpenCard` (the single build
     site) emit the shared shape; keep `tooldef`'s generic, zod-driven `CardSpec`/
     `CardResponse` (discriminated `CardPresentation`) as the internal source of
     truth and MAP discriminated→flat at emit. `dataSchemaJson` already produced
     via `zodToJsonSchema`.
  3. **Design crux (must resolve first):** papercup's `date` presentation uses
     `min/max: string`; the shared flat `CardPresentation` uses `min/max: number`.
     A discriminated→flat assignment won't typecheck. Resolve by widening the
     shared `CardPresentation.min/max` to `number | string` (optional, back-compat
     — Scout uses number for slider, papercup uses string date bounds) — which is
     ANOTHER `Papercusp/chat-protocol` commit + push + Restart re-pin. (CardOption
     is already compatible: papercup's `{id,label,hint?,style?}` ⊆ the augmented
     shared `{id,label,description?,hint?,style?}`.)
  4. Update the ~7 consumers that read `.presentation` and rely on discriminant
     narrowing (`voice-cards/{compose-ambiguity-prompt,match-voice-answer}.ts`,
     `app/_components/chat/PendingCardsBar.tsx`, `use-state-snapshots.ts`) to treat
     `options?` etc. as optional on the flat type; re-run the voice-cards +
     `state-channel` + `operator-state-snapshot` tests.
  Blocked-by: nothing external — all prerequisites (rename, fields, pushes) are done.
- **P-004** `done` — sse pin fork reconciled + pushed. Rebased the local chain
  (`fdda003` type-fix + the rename) onto the remote `.gitignore` (`415f191`) →
  linear `Papercusp/sse` main = **`305e084`** (nothing dropped). papercup re-pinned
  (`d646d2bc`); Restart re-pinned `415f191→305e084` + 3 consumers + tsconfig paths
  migrated (`d2b657a7` on `feat/scout-unify`, pushed). Both superprojects now
  consume `@papercusp/sse` consistently — no rename trap.
- **P-005** `done` — All 4 shared-lib pins were **clean fast-forwards** on the
  `Papercusp/*` remotes (the brief's "divergent" warning was about Restart's
  legacy `papercupai/*` pins, not papercup's). Pushed: `git-graph` `0c16d63..cf32460`,
  `ui-primitives` `77a93b0..8075a3c`, `sync` `41665f3..6b29966`, `agent-chat`
  `c538393..dd2511c`. papercup is now fresh-cloneable; this also discharges
  systems-abstraction `P-040`'s owed git-graph + ui-primitives pushes. NOTE: these
  are pushes to the SHARED submodule remotes only — papercup's superproject `main`
  (89 ahead) is unchanged; its wholesale push remains the separate user-managed event.
- **P-006** `todo` (optional, deferred) — Upstream a Node/Express `sseResponseNode()`
  adapter into `@papercusp/sse` so the server transport is shared, not just the
  wire format + client. No one blocked; low priority.
