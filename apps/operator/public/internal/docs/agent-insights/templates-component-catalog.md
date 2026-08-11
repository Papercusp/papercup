# The component catalog — what templates are allowed to compose
URL: /internal/docs/agent-insights/templates-component-catalog

The curated COMPONENT_CATALOG in @papercusp/template-kit: what an entry means (tier, package vs pattern, provides/composesWith/source), how templates pin against it, and why this page is a projection of the code.

The **component catalog** is the machine-readable source of truth for what an app template may
compose. It is a curated array in code — `COMPONENT_CATALOG` in
`@papercusp/template-kit` (`src/catalog.ts`).

> 🚨 **This page is a PROJECTION of that array.** `catalog.ts` says so in its own header: *edit
> HERE, then mirror the docs table.* Never add a component by editing this page — the code is
> canonical, `catalog.test.ts` validates it, and a docs-only entry composes nothing.

## What an entry is

`ComponentManifest` (`src/component-manifest.ts`):

| field          | meaning                                                               |
| -------------- | --------------------------------------------------------------------- |
| `id`           | kebab id a template pins in `components: [{ id, version }]`           |
| `version`      | semver; a template pinning a stale version FAILS the Cupboard install |
| `tier`         | `A` \| `B` \| `C` — how load-bearing the component is                 |
| `kind`         | `package` \| `pattern` — **the field people misread; see below**      |
| `provides`     | capability tags this component contributes                            |
| `composesWith` | other component ids it is designed to sit beside                      |
| `source`       | `{ repo?, path?, package? }` — where the real code lives              |
| `tests`        | prose: what test evidence backs this entry                            |
| `summary`      | what it is and how to consume it                                      |
| `guide?`       | optional extra build guidance                                         |

## `package` vs `pattern` — the distinction that matters

* **`package`** — extracted, directly consumable code. There is something to install/`file:`-link
  (`source.package`, e.g. `@papercusp/sync`).
* **`pattern`** — a *documented shape*, whose canonical form lives in the reference apps. There is
  **no package to depend on**; you build the shape.

Treating a `pattern` as installable is the classic mistake: you go looking for an npm package that
was never meant to exist.

## Membership is curated in code, on purpose

Entries are hand-curated rather than derived from the repo — the same precedent as `BORROWABLE.md`
— so tagging a component never requires a submodule commit. `catalog.test.ts` enforces format,
unique ids, and that every `composesWith` resolves; the anti-rot gym re-checks entries against the
living repos.

## Current members (21)

Seam + chassis: `pot-app-seam` · `tauri-shell` · `embedded-postgres-server` · `tauri-release-kit` ·
`typed-contracts` · `hono-host` · `next-standalone-host` · `embedded-pg-discovery`

Data + sync: `sync` · `sse` · `projection-index` · `debounce-coalesce` · `resumable-download`

Search: `search` · `search-core` · `rerank` · `rrf`

UI: `ui-primitives` · `papergrid` · `dock-workbench` · `lexicon`

Read `catalog.ts` for each entry's tier, provides and summary — that list is the authority and this
one is a convenience index.

## Getting the code into a materialized app

A catalog entry naming `source.package` does **not** mean `npm install` works: every first-party
component package is `private: true` and 404s on npm. Two real routes:

* `pot-app-seam` (and `template-kit`) are **vendored into the template dir**, so they reach every
  platform and link as `file:./pot-app-seam`.
* Everything else is `file:`-linked from the install's `libs/generic` tree — whose path is
  per-install and reported as `supplyChain` by `templates:get-guide` / `templates:new-app`. Do not
  hardcode it, and treat `supplyChain.root: null` as a real answer meaning *this install cannot
  provide these*.

See `agent-insights/templates-system-design` § Supply chain.
