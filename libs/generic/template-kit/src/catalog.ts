/**
 * The curated component catalog — the machine-readable SOURCE OF TRUTH for
 * template-composable components (plan app-templates-2026-07-04 P-004).
 *
 * The human docs page (operator-docs
 * `agent-insights/templates-component-catalog`) is a PROJECTION of this
 * array — edit HERE, then mirror the docs table. `catalog.test.ts` validates
 * every entry (format + unique ids + resolvable composesWith), which is the
 * "manifests validate" acceptance; the anti-rot gym (P-009) re-checks entries
 * against the living repos.
 *
 * Membership is curated in code (the BORROWABLE.md precedent: tagging never
 * requires a submodule commit). `pattern` entries describe a documented shape
 * whose canonical form lives in the reference apps; `package` entries are
 * extracted, directly consumable code.
 */
import type { ComponentManifest } from "./component-manifest.js";

export const COMPONENT_CATALOG: ComponentManifest[] = [
  {
    id: "hive-app-seam",
    version: "0.1.0",
    tier: "B",
    kind: "package",
    provides: ["hive-bootstrap", "domain-work-items-transport", "ingest-loop"],
    composesWith: ["typed-contracts", "hono-host", "embedded-postgres-server", "tauri-shell"],
    source: {
      repo: "Papercusp/hive-app-seam",
      path: "libs/generic/hive-app-seam",
      package: "@papercusp/hive-app-seam",
    },
    tests: "npm test in the lib (17 vitest tests); consumed with app tests unmodified in quartermaster + oddsmith",
    summary:
      "The ONE app⇄hive seam (Tier B component #1): first-run hive bootstrap (bundled-blueprint local install + " +
      "idempotent fingerprint marker + ensure-hive), the generic domain work-items transport over " +
      "/api/harness/:slug/work-items (UP: enqueue kind:'task' items carrying the payload.domainKind envelope; " +
      "DOWN: fetchCompleted() returns untrusted payload.out for the app-owned contract gate), and the best-effort " +
      "poll ingest loop. Contract gates, storage, and app defaults stay app-side by design.",
    guide: "agent-insights/templates-system-design",
  },
  {
    id: "tauri-shell",
    version: "0.0.1",
    tier: "A",
    kind: "pattern",
    provides: ["desktop-window-lifecycle", "sidecar-process-lifecycle", "packaged-sidecar-resolution"],
    composesWith: ["hono-host", "embedded-postgres-server"],
    source: {
      path: "quartermaster:apps/desktop/src-tauri/src/main.rs (reference; extraction = P-003)",
    },
    tests: "reference apps' shells build + boot E2E (deb proven green 2026-07-04); packaged-sidecar checks land with P-003",
    summary:
      "The thin Tauri 2 host pattern — a HOST, not the app: pick a free port, spawn the Node sidecar " +
      "(packaged: resource_dir()/dist-sidecar + vendored bin/node + bundled_path_env; dev: repo dist-sidecar), " +
      "poll the operator.json discovery file until the Hono host is live, open the WebviewWindow at that port, " +
      "and SIGTERM the sidecar on close. Everything app-shaped lives in the SPA + sidecar. " +
      "Generalization into a reusable skeleton is P-003 (sequenced behind the packaged-build verification).",
    guide: "agent-insights/templates-system-design",
  },
  {
    id: "embedded-postgres-server",
    version: "0.0.1",
    tier: "A",
    kind: "pattern",
    provides: ["embedded-postgres", "db-lifecycle", "connection-discovery"],
    composesWith: ["hono-host", "hive-app-seam"],
    source: {
      path: "quartermaster:libs/embedded-postgres-server (@quartermaster/embedded-postgres-server) + oddsmith:libs/embedded-postgres-server (@oddsmith/embedded-postgres-server)",
      package: "@papercusp/embedded-pg-discovery (the discovery half, already shared)",
    },
    tests: "each app's PG-backed integration suites (testcontainers global setup) exercise it end-to-end",
    summary:
      "Per-app embedded Postgres: download/extract-free native PG via embedded-postgres, boot/stop lifecycle " +
      "bound to the sidecar, migrations on boot, and connection-URL discovery via @papercusp/embedded-pg-discovery " +
      "(env → JSON discovery file → fallback). Currently two app-namespaced copies of the server half — a " +
      "promotion candidate to one @papercusp package; the discovery half is already extracted + shared.",
  },
  {
    id: "tauri-release-kit",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: ["desktop-build-orchestration", "release-channels", "updater-manifest", "artifact-classification"],
    composesWith: ["tauri-shell"],
    source: {
      repo: "Papercusp/tauri-release-kit",
      path: "libs/generic/tauri-release-kit",
      package: "@papercusp/tauri-release-kit",
    },
    tests: "npm test in the lib (vitest); driven for real by quartermaster + oddsmith bin/release.ts",
    summary:
      "Provider-agnostic Tauri desktop build+release orchestration: a pure core (version bump, channel/tag " +
      "resolution, latest.json updater-manifest generation, artifact classification) plus a per-target driver " +
      "registry (Linux-local, Mac/Windows over an SSH frame), with the app-specific sidecar build injected via a " +
      "buildSidecar() seam and all side effects behind Exec/Fs/Log ports. Zero domain coupling, zero runtime deps.",
  },
  {
    id: "typed-contracts",
    version: "0.0.1",
    tier: "B",
    kind: "pattern",
    provides: ["contract-schema", "single-parse-gate", "payload-validation"],
    composesWith: ["hive-app-seam"],
    source: {
      path: "quartermaster:packages/contracts (parseCandidateSet/PurchaseResearchInputSchema) + oddsmith:libs/prospect-contract + @oddsmith/contracts (SignalSchema)",
    },
    tests: "contract packages' own vitest suites + every seam test that round-trips a payload through the gate",
    summary:
      "The typed-contract pattern — the MANDATORY down-leg discipline of the one seam: a dedicated contracts " +
      "package owns the zod schemas for what crosses the app⇄hive boundary (input payloads wire-validated at " +
      "enqueue; agent outputs parsed through ONE gate before touching app tables; rejects emitted UP as events, " +
      "never silently dropped). An app composes hive-app-seam with ITS OWN contracts package — the seam " +
      "deliberately ships no validation.",
    guide: "agent-insights/templates-system-design",
  },
  {
    id: "hono-host",
    version: "0.0.1",
    tier: "A",
    kind: "pattern",
    provides: ["sidecar-http-host", "operator-json-discovery", "spa-serving", "sse-streams"],
    composesWith: ["tauri-shell", "embedded-postgres-server", "hive-app-seam"],
    source: {
      path: "quartermaster:apps/desktop/bin/serve.ts + apps/desktop/src/_hono/ (reference); oddsmith equivalent under apps/desktop",
    },
    tests: "each app's _hono route integration suites (real PG + fake transports)",
    summary:
      "The Node sidecar host pattern: a Hono app serving the SPA + /api routes on a free localhost port, " +
      "operator.json written to the app home for shell/CLI discovery (port + pid, removed on shutdown), SSE " +
      "streams for table-less moments, graceful SIGTERM shutdown (host close → sync stop → PG stop → discovery " +
      "file removal), and env-gated optional planes so boot without config changes nothing.",
  },

  // ---- P-017: the data-sync component family (papercusp-data-sync template) ----
  {
    id: "sync",
    version: "0.0.1",
    tier: "A",
    kind: "package",
    provides: ["state-sync-transport", "sse-sync-client", "reconnect-backpressure"],
    composesWith: ["sse", "projection-index", "debounce-coalesce", "hono-host"],
    source: { repo: "Papercusp/papercup", path: "libs/generic/sync", package: "@papercusp/sync" },
    tests: "npm test in the lib (vitest)",
    summary:
      "Schema-agnostic sync transports (Zero + SSE) with reconnect and backpressure handling — the client half " +
      "of live app-state sync: subscribe to server changes, survive drops, and never overrun a slow consumer.",
    guide: "agent-insights/templates-system-design",
  },
  {
    id: "sse",
    version: "0.0.1",
    tier: "A",
    kind: "package",
    provides: ["sse-response-builder", "sse-channel-bus", "pg-notify-bridge"],
    composesWith: ["sync", "hono-host", "embedded-postgres-server"],
    source: { repo: "Papercusp/papercup", path: "libs/generic/sse", package: "@papercusp/sse" },
    tests: "npm test in the lib (vitest)",
    summary:
      "Spec-compliant Server-Sent Events primitives — the server half of live sync: an SSE response builder for " +
      "any fetch-style host (Hono drop-in), an in-process channel bus, and a PG NOTIFY bridge so table changes " +
      "stream to subscribed clients without polling.",
  },
  {
    id: "projection-index",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: ["event-maintained-projection", "structured-index"],
    composesWith: ["sync", "sse", "embedded-postgres-server"],
    source: { repo: "Papercusp/papercup", path: "libs/generic/projection-index", package: "@papercusp/projection-index" },
    tests: "npm test in the lib (vitest)",
    summary:
      "A generic event-maintained structured→index projection: feed it source records as they change and it " +
      "keeps a queryable index current — the read-model half of a synced data plane (derived views stay fresh " +
      "without rebuild jobs).",
  },
  {
    id: "debounce-coalesce",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: ["wake-floor-debounce", "burst-coalesce"],
    composesWith: ["sync", "sse", "projection-index"],
    source: { repo: "Papercusp/papercup", path: "libs/generic/debounce-coalesce", package: "@papercusp/debounce-coalesce" },
    tests: "npm test in the lib (vitest)",
    summary:
      "Per-subscriber wake-floor + burst-coalesce primitive: a leading-edge debounce that enforces a minimum " +
      "wake interval and folds change bursts into one delivery — what keeps a live sync plane from stampeding " +
      "its consumers.",
  },
  {
    id: "resumable-download",
    version: "0.1.0",
    tier: "A",
    kind: "package",
    provides: ["resumable-http-download", "streaming-checksum"],
    composesWith: ["sync", "hono-host"],
    source: { repo: "Papercusp/papercup", path: "libs/generic/resumable-download", package: "@papercusp/resumable-download" },
    tests: "npm test in the lib (vitest)",
    summary:
      "Generic, domain-free resumable HTTP downloader with streaming checksum verification (HTTP Range resume) — " +
      "the large-asset leg of data sync: interrupted transfers continue where they stopped and corruption is " +
      "caught in-stream.",
  },
];
