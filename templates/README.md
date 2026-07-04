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
