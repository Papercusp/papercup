# Papercusp Official: App — build guide

The one whole-app root. It is a **thin pure composition**: it owns no
components of its own, and every capability it gives you comes from an aspect
in its closure. What it adds is the glue guidance below and the decision points
that shape the composition — above all `target`, which picks the chassis.

> **This template replaced four.** The old web-app and desktop-app roots and
> their two agentic twins were the cross-product of two booleans: which
> chassis, and whether the agent plane joins. Web and desktop shared 15 of 15
> files with 11 byte-identical and **no code divergence at all**, so they were
> never really different templates — they were one template with a parameter
> nobody had extracted yet. Those four refs still resolve here; there is
> nothing to migrate.

## Before you write anything

- Read `template.yaml` — the pinned closure, the checks that gate you, and the
  structured MUSTs mirrored below.
- Read the docs it declares (the `docs:` list names the canonical pages),
  starting with `agent-insights/templates-system-design`.
- Inspect the **operator app** itself — a running reference instance of every
  pattern these templates encode, and the existence proof for `target: both`:
  it serves the same codebase through a Tauri shell and a plain browser with no
  runtime branch anywhere in its sync layer.

## How to build from this (orientation)

1. **Answer `target` FIRST.** `desktop`, `web`, or both. This is not a
   preference — it *selects* the chassis aspect into your composition, and the
   chassis carries its own decision points, which you cannot even see until you
   have chosen. Pick `web` and you inherit `tenancy`, `hosting-target`,
   `auth-strategy`, `render-strategy`, `observability`. Pick `desktop` and you
   inherit the sidecar and release-pipeline forks instead.
2. **Answer the chassis's own decision points**, in the order the chassis
   states. On web, `tenancy` says outright that it comes first: single-user
   local install vs multi-user server deployment forks auth, connection
   resolution, and the hosting target beneath it.
3. **Answer `domain`** — the noun the app ledgers and surfaces. Every
   aspect-level decision point (schema, panels, lexicon terms, searchable
   surfaces) derives from it.
4. **Expand the closure** (`resolveSelection` in `@papercusp/template-kit`,
   which takes your answers and returns the full template list) and work each
   aspect's GUIDE in dependency order: chassis → data-layer → ui.
5. **Answer `optional-planes`** — add `papercusp-data-sync` and/or
   `papercusp-search` to the composition now if the app needs them. Both drop
   onto either chassis.
6. **Run the union of checks.** Every template in your closure contributes its
   checks and all of them must be green — that additive rule is what keeps free
   composition safe without a deterministic generator.

## MUST

1. **`thin-app-template`** — this root adds guidance and decision points, never
   its own components. Capability belongs in aspects. Enforced by
   `checks/composition-integrity.test.ts`.
2. **`answer-target-first`** — `target` is answered before anything else. A
   chassis-level decision answered against the wrong chassis is not a small
   mistake; it is an app built on the wrong host.
3. **`full-union-green`** — the composed app passes the FULL union of its
   closure's checks, not a subset you found convenient.
4. **`dual-target-is-opt-in`** — `target: both` is chosen deliberately and
   stated in the ship disclosure. The code is already shared; what doubles is
   the **checks**, on every build. Choose it because the app genuinely ships
   two artifacts, never because it sounded more flexible.
5. **`no-agent-surfaces`** — no hives and no seam unless `papercusp-ops-pots`
   is explicitly in your composition. The agent plane is never implicit.

## SHOULD

- Keep the chassis swap honest. The reason one root serves both targets is that
  the data and UI closure is *identical*; if you find yourself branching on the
  target inside app code, that branch belongs in the chassis aspect instead.
- Record every decision-point answer. The answers are the ship disclosure that
  makes a free-form composition reviewable by someone who was not there.

## FREE

- Domain schema, routes, copy, brand, and which optional planes you compose.
- How you organise your own source tree — the closure constrains the seams
  between aspects, not the shape of your product code.

## What this template does NOT decide for you

The agent plane. An app with agents composes `papercusp-ops-pots` on top of
this root, and crosses into the judgment plane at exactly one typed seam. If
agents appear mid-build, add it to the composition explicitly rather than
growing an ad-hoc orchestration loop inside the app.
