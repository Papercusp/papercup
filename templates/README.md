# Templates

Distributable units an agent composes into an app (or an app-aspect) on
papercusp: **components** (version-pinned refs into the
[component catalog](../libs/generic/template-kit/src/catalog.ts)) +
**guidance** (`GUIDE.md`, the composition prompt) + **checks** (the acceptance
suite any composition must pass). Correctness by **verification, not
construction** — the design of record is
`apps/operator-docs … agent-insights/templates-system-design`
(served at `/internal/docs/agent-insights/templates-system-design`).

## Source of truth (v1 — plan app-templates-2026-07-04 P-006/D-005)

- **This directory is the v1 template source of truth**: versioned with the
  repo, git-synced, readable by the anti-rot gym (P-009). The Cupboard/Comb
  Templates section (P-010) *projects* from here.
- **Manifests are pinned by test**: `@papercusp/template-kit`
  `src/reference-templates.ts` is the machine form; the kit's suite asserts
  each `templates/<id>/template.yaml` here parses, validates, and matches it.
  Edit BOTH sides (yaml + reference manifest) — a mismatch fails the kit's
  tests loudly.
- Schema: `agent-insights/templates-template-yaml`
  (validator: `@papercusp/template-kit` `parseTemplateManifest`).

## The set (template #1, split per P-014)

| Template | Scope | What |
|---|---|---|
| [`agentic-desktop-app`](agentic-desktop-app/) | app | THIN composition of the two aspects below — start here to build a whole app |
| [`papercusp-ops-hives`](papercusp-ops-hives/) | aspect | the judgment plane: domain hive + -ops hive + the ONE work_items⇄contract seam |
| [`tauri-desktop-shell`](tauri-desktop-shell/) | aspect | the deterministic chassis: Tauri shell → Node/Hono sidecar → embedded Postgres + release kit |

An app built from N templates must pass the **union of their checks**
(`composeTemplates` — see the schema doc §Composition semantics).

## Running the checks (landed: P-007)

The `<id>/checks/*.test.ts` files are PORTABLE template content — copied
verbatim into a composed app and parameterized via a JSON config named by the
**`TEMPLATE_CHECKS_CONFIG`** env var (schema: `@papercusp/template-kit`
`TemplateChecksConfig`). Unconfigured they SKIP. This directory is also the
`@papercusp/templates` workspace member, so in-repo:

```sh
npm test -w @papercusp/templates                 # composition-integrity green, rest skip
TEMPLATE_CHECKS_CONFIG=<config> npm test -w @papercusp/templates   # the full union
```

Worked consumer-#1 config (runs green against quartermaster):
[`agentic-desktop-app/reference/quartermaster.checks-config.json`](agentic-desktop-app/reference/quartermaster.checks-config.json).
Per-check contracts: each template's `checks/README.md`.

## The template gym (landed: P-009)

Anti-rot cadence (D-007: *the template is tested by building an app from it*):
the `template-gym` system routine (`system:template-gym`, every 6h) re-verifies
five legs — the P-013 verbatim-materialization invariant (`<id>/checks/*.test.ts`
⇄ quartermaster `packages/template-checks/`, byte-identical;
`composition-integrity` is declared repo-side-only), docs⇄catalog drift
(`COMPONENT_CATALOG` ids ⊆ the published catalog page), the template-kit drift
pins, this workspace's suite, and consumer #1's configured union inside the
quartermaster repo. A standing RED auto-files ONE `template-drift` work-item
(stable watchdogKey `template-gym:<leg>`); the gym is advisory and never gates.

Code: `packages/operator-core/lib/harness/routines/template-gym-{runner,action}.ts`
(+ `seed-template-gym-routine.ts`). On-demand run + per-leg re-run:

```sh
npx tsx packages/operator-core/lib/harness/routines/template-gym-runner.ts \
  [--legs materialization,docs-catalog,kit-suite,template-suite,app-checks] \
  [--qm-root <quartermaster clone>]        # default: the sibling ../quartermaster
```

Run history: `~/.papercusp/template-gym/` (`last-run.json` + `runs.jsonl`).

## Cupboard distribution (landed: P-010)

Each template here is publishable as a **`kind=template` Cupboard listing**
(repo-backed: the listing points at this dir via `listing_ref = <id>`; nothing
is flattened or copied at publish time). The loop:

- **Publish**: the `template:publish` agent tool (title ≤200 / description
  ≤280 — worker caps). D-007 review policy: a template carries GUIDE.md — an
  instruction-carrying artifact — so listings land **pending** and are publicly
  invisible until operator approval. The official set uses
  **"Papercusp Official:"** title prefixes.
- **Install**: the Cupboard **Templates** tab (`?kind=template`) →
  `POST /api/cupboard/install-template` → shallow-clone + kit validation
  (schema + component-catalog pin check — a stale pin fails the install, same
  rule as the gym) → materialized under **`~/.papercusp/templates/<id>/`**,
  where the from-template scaffold entry (P-011) reads it.
- Worker side: D1 migration `010_template_kind.sql`;
  operator side: `operator-core/lib/cupboard/install-template-core.ts`.
