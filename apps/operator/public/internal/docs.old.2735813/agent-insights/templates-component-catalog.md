# Templates — component catalog
URL: /internal/docs/agent-insights/templates-component-catalog

The human catalog of template-composable components (hive-app-seam, tauri-shell, embedded-postgres-server, tauri-release-kit, typed-contracts, hono-host) — a projection of @papercusp/template-kit's machine-readable COMPONENT_CATALOG.

**Status:** the P-004 component catalog for the templates system
([design of record](/internal/docs/agent-insights/templates-system-design)).
**Machine source of truth:** `@papercusp/template-kit` —
`libs/generic/template-kit/src/catalog.ts` (`COMPONENT_CATALOG`), validated by its test
suite (format + unique ids + resolvable `composesWith` refs). **Edit the code first**,
then mirror this page; the anti-rot gym (P-009) re-checks entries against the living
repos.

## The manifest format

Every component carries a manifest (`@papercusp/template-kit`
`parseComponentManifest` / `validateCatalog`):

| Field          | Meaning                                                                                                                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | kebab-case catalog id, unique                                                                                                                                                                                                                            |
| `version`      | semver of the extracted package (or the reference apps' version for a pattern)                                                                                                                                                                           |
| `tier`         | **A** plain (compose/modify freely) · **B** seam (MUST use for its crossing) · **C** guardrail (sealed; modify only with disclosure + checks green) — [D-002](/internal/docs/agent-insights/templates-system-design#the-tier-model-owner-decision-d-002) |
| `kind`         | `package` (extracted, directly consumable) · `pattern` (documented shape + reference impls; extraction may be planned)                                                                                                                                   |
| `provides`     | capability slugs                                                                                                                                                                                                                                         |
| `composesWith` | catalog ids it is designed to pair with                                                                                                                                                                                                                  |
| `source`       | repo / repo-relative path / npm package                                                                                                                                                                                                                  |
| `tests`        | how to prove it still works                                                                                                                                                                                                                              |

## The catalog

| Component                  | Tier  | Kind    | Provides                                                                                    | Composes with                                                     | Source                                                                                                                                                                                                | Tests                                                                |
| -------------------------- | ----- | ------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `hive-app-seam`            | **B** | package | hive-bootstrap · domain-work-items-transport · ingest-loop                                  | typed-contracts, hono-host, embedded-postgres-server, tauri-shell | [Papercusp/hive-app-seam](https://github.com/Papercusp/hive-app-seam) · `@papercusp/hive-app-seam` (submoduled: quartermaster + oddsmith `libs/hive-app-seam`, papercup `libs/generic/hive-app-seam`) | lib `npm test` (17); consumed with app tests unmodified in both apps |
| `tauri-shell`              | A     | pattern | desktop-window-lifecycle · sidecar-process-lifecycle · packaged-sidecar-resolution          | hono-host, embedded-postgres-server                               | reference: quartermaster `apps/desktop/src-tauri/src/main.rs` — extraction is **P-003**                                                                                                               | reference shells build + boot E2E (deb green 2026-07-04)             |
| `embedded-postgres-server` | A     | pattern | embedded-postgres · db-lifecycle · connection-discovery                                     | hono-host, hive-app-seam                                          | two app copies (`@quartermaster/…` + `@oddsmith/embedded-postgres-server`); discovery half already shared as `@papercusp/embedded-pg-discovery` — server half is a promotion candidate                | each app's PG-backed integration suites                              |
| `tauri-release-kit`        | A     | package | desktop-build-orchestration · release-channels · updater-manifest · artifact-classification | tauri-shell                                                       | [Papercusp/tauri-release-kit](https://github.com/Papercusp/tauri-release-kit) · `@papercusp/tauri-release-kit`                                                                                        | lib `npm test`; driven by both apps' `bin/release.ts`                |
| `typed-contracts`          | **B** | pattern | contract-schema · single-parse-gate · payload-validation                                    | hive-app-seam                                                     | reference: quartermaster `packages/contracts`, oddsmith `libs/prospect-contract` + `@oddsmith/contracts`                                                                                              | contract suites + seam round-trip tests                              |
| `hono-host`                | A     | pattern | sidecar-http-host · operator-json-discovery · spa-serving · sse-streams                     | tauri-shell, embedded-postgres-server, hive-app-seam              | reference: quartermaster `apps/desktop/bin/serve.ts` + `src/_hono/`; oddsmith equivalent                                                                                                              | each app's `_hono` integration suites                                |

## How an agent uses this

1. A **template** ([`template.yaml`](/internal/docs/agent-insights/templates-template-yaml),
   P-005) references components by catalog id — version-pinned, cross-validated
   against this catalog by `validateTemplateAgainstCatalog`.
2. **Tier B is not optional**: an app that crosses the app⇄hive boundary MUST compose
   `hive-app-seam` + its own `typed-contracts` package for that crossing. Tier A
   components are starting points — modify freely.
3. The component's `tests` column is the *component-local* proof; the composed app's
   proof is the template's `checks/` suite
   ([design doc](/internal/docs/agent-insights/templates-system-design#checks--what-green-means)).

## Adding a component

Add the manifest to `COMPONENT_CATALOG` (`libs/generic/template-kit/src/catalog.ts`) —
the suite enforces format, id uniqueness, and resolvable `composesWith` — then mirror
the row here. Prefer **extracting from a real app** over inventing
(design principle: extract, don't invent; `tauri-release-kit` and `hive-app-seam` are
the precedents). A genuinely papercusp-independent component may ALSO belong in root
`BORROWABLE.md` (generated — `npm run gen:borrowable`); papercusp-facing components
like `hive-app-seam` belong in its *reusable-but-coupled* section instead.
