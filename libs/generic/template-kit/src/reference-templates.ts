/**
 * Reference template manifests — the retro-fitted proof that the
 * template.yaml schema + composition semantics describe REALITY
 * (plan app-templates-2026-07-04 P-005 + P-014).
 *
 * P-014's recommended realization (owner directive: one app = a composition
 * of MANY templates) splits template #1 three ways, extracted from what
 * quartermaster actually is (oddsmith is the second reference instance):
 *
 *   - PAPERCUSP_OPS_HIVES_TEMPLATE   (aspect) — the 2-hive ops construction:
 *     the judgment plane + the ONE seam. Carries both Tier B components.
 *   - TAURI_DESKTOP_SHELL_TEMPLATE   (aspect) — the app chassis: the
 *     deterministic plane's host stack + release pipeline.
 *   - AGENTIC_DESKTOP_APP_TEMPLATE   (app)    — a THIN pure composition of
 *     both (no own components; the P-014 schema rule allows this exactly for
 *     non-empty composesWith).
 *
 * These are DRAFTS of the shippable templates: P-006 writes the GUIDE.md +
 * starter blueprints + contract templates around them, P-007 makes checks/
 * real, and P-013 (consumer #1) re-materializes quartermaster's agentic plane
 * from them. The suite validates each standalone, as a set
 * (validateTemplateSet), composed (composeTemplates — the union-of-checks),
 * and against COMPONENT_CATALOG, so catalog drift breaks this file loudly
 * (the P-009 gym re-runs the same validation).
 */
import type { TemplateManifest } from "./template-manifest.js";

/** Aspect: the 2-hive ops construction — the judgment plane + the ONE seam. */
export const PAPERCUSP_OPS_HIVES_TEMPLATE: TemplateManifest = {
  id: "papercusp-ops-hives",
  version: "0.1.0",
  scope: "aspect",
  category: "agentic",
  summary:
    "The judgment plane quartermaster and oddsmith instantiate: a domain hive + an -ops hive over it " +
    "(the Queen surveying a backlog and placing member harnesses), crossing into the app at exactly ONE " +
    "seam — work_items of a declared kind go up, a typed contract comes down through a single parse gate " +
    "into an app table. Nothing else crosses; confinement is enforced at install and the app's " +
    "blueprints/README.md states the rule.",
  components: [
    { id: "hive-app-seam", version: "0.1.0" },
    { id: "typed-contracts", version: "0.0.1" },
  ],
  // Starter blueprints (P-006): ops-hive extends work, member extends
  // research — placeholder lexicon, renamed per the domain at composition.
  blueprints: ["ops-hive", "member"],
  // The CandidateSet analog — the typed down-leg contract template the
  // building agent specializes for its domain.
  contracts: ["candidate-set"],
  decisionPoints: [
    { id: "seam-work-item-kind", prompt: "What work_item kind crosses the seam (quartermaster: purchase-research; oddsmith: bet-analysis)?" },
    { id: "contract-shape", prompt: "What does the down-leg contract carry (specialize the candidate-set template; one parse gate, rejects emitted as events)?" },
    { id: "domain-lexicon", prompt: "What are the domain nouns/verbs for hives, roles, and work (replaces the placeholder lexicon in the starter blueprints)?" },
    { id: "domain-roles", prompt: "Which member roles does the domain hive place, and with what capability envelopes (confinement rule stays inviolable)?" },
    { id: "app-tables", prompt: "Which app tables does ingested contract output land in, and what is the app-plane read model over them?" },
  ],
  composesWith: ["tauri-desktop-shell", "agentic-desktop-app"],
  docs: ["agent-insights/templates-system-design", "agent-insights/templates-template-yaml", "agent-insights/templates-component-catalog"],
  checks: [
    { id: "confinement-guard", run: "checks/confinement-guard.test.ts", summary: "no hive role holds cart/checkout/vault/approvals-write-analog capabilities" },
    { id: "seam-round-trip", run: "checks/seam-round-trip.test.ts", summary: "enqueue → complete with payload → contract parse gate ingests → app table row exists" },
    { id: "gym-signals", run: "checks/gym-signals.test.ts", summary: "the hive's guardrail gym signals are present and wired" },
  ],
};

/** Aspect: the app chassis — the deterministic plane's host stack + release pipeline. */
export const TAURI_DESKTOP_SHELL_TEMPLATE: TemplateManifest = {
  id: "tauri-desktop-shell",
  version: "0.1.0",
  scope: "aspect",
  category: "shell",
  summary:
    "The deterministic app chassis: a thin Tauri 2 shell (a HOST, not the app) spawning a Node/Hono " +
    "sidecar that serves the SPA + /api on a free localhost port, embedded Postgres with migrations on " +
    "boot and discovery-file connection resolution, operator.json for shell/CLI discovery, graceful " +
    "SIGTERM shutdown, and the tauri-release-kit build/release pipeline. Plain TypeScript packages — " +
    "Tier A throughout: compose and modify freely.",
  components: [
    { id: "tauri-shell", version: "0.0.1" },
    { id: "hono-host", version: "0.0.1" },
    { id: "embedded-postgres-server", version: "0.0.1" },
    { id: "tauri-release-kit", version: "0.1.0" },
  ],
  contracts: [],
  decisionPoints: [
    { id: "ui-shape", prompt: "What SPA surface does the deterministic plane need (grids, approvals view, streams)? FREE tier — compose as judged best." },
    { id: "app-identity", prompt: "App name, bundle identifier, app-home directory, and release channels (feeds tauri.conf + tauri-release-kit config)." },
  ],
  composesWith: ["papercusp-ops-hives", "agentic-desktop-app"],
  docs: ["agent-insights/templates-system-design", "agent-insights/templates-template-yaml", "agent-insights/templates-component-catalog"],
  checks: [
    { id: "boot-e2e", run: "checks/boot-e2e.test.ts", summary: "composed app builds, sidecar spawns, discovery file written, health returns 200" },
  ],
};

/**
 * App: template #1 — a THIN pure composition of the two aspects (no own
 * components; P-014 allows this exactly for non-empty composesWith).
 */
export const AGENTIC_DESKTOP_APP_TEMPLATE: TemplateManifest = {
  id: "agentic-desktop-app",
  version: "0.1.0",
  scope: "app",
  category: "app",
  summary:
    "The two-plane agentic desktop app quartermaster and oddsmith instantiate: papercusp-ops-hives " +
    "(judgment plane + the ONE seam) composed onto tauri-desktop-shell (the deterministic chassis), plus " +
    "glue guidance. An app built from this composition must pass the UNION of both aspects' checks — " +
    "that additive rule is what keeps free-form composition safe without a deterministic composer.",
  components: [],
  contracts: [],
  decisionPoints: [
    { id: "domain", prompt: "What is the app's domain — the noun the deterministic plane ledgers and the judgment plane reasons about? Drives every aspect-level decision point." },
  ],
  composesWith: ["papercusp-ops-hives", "tauri-desktop-shell"],
  // P-015: requires is the HARD pinned edge — composing/installing this app
  // template pulls both aspects in; the checks union covers the closure.
  // (P-022 later re-layers this onto the non-agentic 'desktop-app' template.)
  requires: [
    { id: "papercusp-ops-hives", version: "0.1.0" },
    { id: "tauri-desktop-shell", version: "0.1.0" },
  ],
  docs: ["agent-insights/templates-system-design", "agent-insights/templates-template-yaml"],
  checks: [
    { id: "composition-integrity", run: "checks/composition-integrity.test.ts", summary: "the composed set resolves (composeTemplates ok: pins consistent, one app scope) and the union of checks is what CI runs" },
  ],
};

/** The reference template set — validateTemplateSet(REFERENCE_TEMPLATES) must stay green. */
export const REFERENCE_TEMPLATES: TemplateManifest[] = [
  PAPERCUSP_OPS_HIVES_TEMPLATE,
  TAURI_DESKTOP_SHELL_TEMPLATE,
  AGENTIC_DESKTOP_APP_TEMPLATE,
];
