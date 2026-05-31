---
title: Brief — @papercusp/tooldef is now a shared repo (Papercusp/tooldef)
slug: BRIEF-tooldef-shared-repo-2026-05-30
status: active
created: 2026-05-30
owner: avi@storewolf.com
related: [papercusp-tooldef-extraction-2026-05-29]
---

# Brief — `@papercusp/tooldef` is now a shared repo

## Now

**State:** `Papercusp/tooldef` exists and is wired into Restart (`libs/tooldef`).
papercup `packages/tooldef` is still in-tree. **⚠️ The drift is ACTIVE, not
hypothetical:** a peer landed P-020 (Standard Schema — core no longer Zod-locked) +
P-052 (README) in papercup `packages/tooldef` *after* the initial `5405204b` split, and
is actively syncing `Papercusp/tooldef` main forward (observed `5405204b → 89dc309 →
0b3056ea` in minutes). So there is an active owner of the shared-repo sync — **do not
race them.** The in-tree→submodule conversion (the durable one-source fix) is still the
deferred `needs-human` P-054 fork AND now also needs coordination with that active
developer.

**Next:** (1) papercup agents editing `packages/tooldef` — your edits must reach
`Papercusp/tooldef` (the active syncer is doing this; don't duplicate). (2) P-054 owner
(avi) + the active tooldef developer — coordinate if/when to do the papercup conversion
(in-place submodule vs mirror); don't convert mid-development. (3) Restart agents —
Phase 1 can consume `@papercusp/tooldef` now (pin tracks the shared main).

**TL;DR:** `@papercusp/tooldef` was extracted to a standalone **`Papercusp/tooldef`**
repo (history-preserving, `main` = `5405204b`) so the **Restart** project can consume
it — mirroring how `@papercusp/sse` and `@papercusp/chat-protocol` are shared.
**papercup still uses `packages/tooldef` in-tree, unchanged.** The two copies are
byte-identical right now but **will drift** — if you edit papercup's tooldef, read the
⚠️ section.

## What changed (2026-05-30)

- **New repo `Papercusp/tooldef`** = a `git subtree split` of papercup
  `packages/tooldef` (full history, 2829 commits → `5405204b`). Self-contained (own
  `tsconfig.json`, src-as-entry). Confirmed host-agnostic: zero
  `@papercusp`/`@restart`/PG/operator-path imports; deps are only
  `@papercusp/chat-protocol` (type import) + `@standard-schema/spec` + `zod` (peer).
- **Restart wired it in:** `libs/tooldef` submodule + `tsconfig.base.json` path +
  `node_modules/@papercusp/tooldef` symlink (commit `97cf3476` on `feat/scout-unify`).
  Restart code can `import … from '@papercusp/tooldef'` today (transitive deps already
  present there).
- **papercup: UNCHANGED.** `packages/tooldef` is still the in-tree workspace package;
  all 42 direct + ~607 `@papercusp/agent-mcp`-re-export consumers resolve exactly as
  before. Nothing in papercup was restructured, and `main` was not touched by the
  extraction (the split branch was local + deleted).

## ⚠️ If you edit papercup `packages/tooldef` — READ THIS

There is now a **downstream consumer (Restart) of a separate `Papercusp/tooldef`
repo.** Today `Papercusp/tooldef@5405204b` is byte-identical to papercup's
`packages/tooldef`, but they are **two copies** until the P-054 conversion (below).

- An edit to papercup `packages/tooldef` that is **not** also propagated to
  `Papercusp/tooldef` makes Restart's copy **stale/divergent**.
- So, until papercup is converted to consume the shared repo: **if you change
  `packages/tooldef`, also push the change to `Papercusp/tooldef` and bump Restart's
  `libs/tooldef` pin** — or flag it for whoever owns the tooldef-adoption migration.
  Don't silently let them drift.

## The deferred decision — do NOT do unilaterally (papercup `P-054`)

Whether/how papercup stops keeping `packages/tooldef` in-tree and instead consumes
`Papercusp/tooldef`:

- **(a) in-place submodule (recommended)** — `packages/tooldef` becomes a submodule of
  `Papercusp/tooldef` at the **same path**, so resolution is unchanged for every
  consumer (the `packages/*` workspace glob + the `@papercusp/tooldef` name stay the
  same). Matches `sse`/`chat-protocol`. **But** it reverses papercup's documented
  in-tree choice and changes the tooldef-edit workflow for every papercup agent (edit
  the submodule → push → bump pin). Do it as its own verified pass against the operator
  build, not folded into other work.
- **(b) mirror** — keep `packages/tooldef` in-tree as source-of-truth + a one-way push
  to `Papercusp/tooldef`. No papercup restructure, but a mirror to maintain.

This is `needs-human` — it's the papercup tooldef-extraction plan's **P-054**. Don't
convert papercup unilaterally.

## For Restart agents

`@papercusp/tooldef` is available now (`libs/tooldef`, resolves via the
`tsconfig.base.json` path + symlink, like `@papercusp/sse`). It's the foundation of
the phased migration in `Restart:docs/plans/tooldef-adoption-restart-2026-05-30.md`
(Phase 1 = Scout-facing read tools). Adopting it does NOT require an `npm install` —
`@papercusp/chat-protocol`, `@standard-schema/spec`, and `zod` are already present.

## Refs

- Repo: `github.com/Papercusp/tooldef` — `main` `5405204b` (private).
- Restart wiring: `Papercusp/Restart` `feat/scout-unify` `97cf3476`.
- Migration plan: `Restart:docs/plans/tooldef-adoption-restart-2026-05-30.md`.
- papercup extraction plan + the `P-054` conversion gate:
  [[papercusp-tooldef-extraction-2026-05-29]].
