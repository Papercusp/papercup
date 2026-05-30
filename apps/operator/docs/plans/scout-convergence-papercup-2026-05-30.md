---
title: Scout/SSE convergence — papercup-side loose ends
slug: scout-convergence-papercup-2026-05-30
status: active
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

**Next:** execute P-001 (in-tree `@restart/sse` → `@papercusp/sse` rename, dual-
symlink transition, local-only — safe and reversible). Then the gated steps
(P-002 submodules, P-003 Phase 6, P-004 sse-pin fork, P-005 divergent-pin
reconcile) on user authorization, batched into one coordinated cross-repo push.

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

- **P-002** `todo` (gated) — Migrate the 4 submodule `@restart/sse` refs +
  2 submodule package.json deps (`sync`, `agent-chat`, `papercusp`, `sse` self) as
  per-submodule commits; then drop the `@restart/sse` symlink. Pushing the
  `libs/sse` `name` rename forces Restart lockstep. Blocked-by: P-001 + user push
  authorization. Coordinate with P-005.
- **P-003** `todo` (gated) — Phase 6 option A: add the 4 optional wire fields to
  shared chat-protocol types; rename `@restart/chat-protocol` →
  `@papercusp/chat-protocol` (shared repo + Restart's 6 consumers); papercup
  imports `ChatEvent` + `OpenCardSnapshot` for the wire/state-channel emit path,
  keeping `tooldef` generics internal. Blocked-by: D-001 rename landing.
- **P-004** `todo` (gated) — Reconcile the `libs/sse` pin fork: land `fdda003` +
  `415f191` both on `Papercusp/sse` main, re-pin papercup. Fold into the P-002
  coordinated push.
- **P-005** `todo` (gated) — Reconcile the 4 divergent submodule pins
  (`git-graph`/`sync`/`ui-primitives` local-only; `agent-chat` reachable). Same
  batch as systems-abstraction `P-040`'s owed push. Owner reconcile + authorized
  push.
- **P-006** `todo` (optional, deferred) — Upstream a Node/Express `sseResponseNode()`
  adapter into `@papercusp/sse` so the server transport is shared, not just the
  wire format + client. No one blocked; low priority.
