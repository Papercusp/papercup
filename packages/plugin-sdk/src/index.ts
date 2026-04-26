/**
 * @papercusp/plugin-sdk — type definitions for Papercusp plugins.
 *
 * Plugins extend a Papercusp install (or any harness install) with new
 * roles, lifecycle hooks, dashboard tabs, API routes, and Postgres schemas.
 * The Papercup demo's "shareholder briefings" YouTube pipeline is the first
 * plugin built on this SDK.
 *
 * Stability: pre-1.0. The runtime that hosts plugins is in stage 5 of the
 * Papercusp/Papercup split (see PLAN.md); these types document the contract
 * but the loader implementation lands in a later stage.
 */

import type { ComponentType } from 'react';

/**
 * Context passed to plugin lifecycle hooks. Surfaces the harness's project
 * directory, slug, and database clients, plus a logger.
 */
export interface PapercuspContext {
  /** Slug of the harness project this plugin instance is running inside. */
  projectSlug: string;
  /** Absolute path to the project's filesystem root (where SPEC.md lives). */
  projectDir: string;
  /** Absolute path to the project's `.harness/` directory. */
  stateDir: string;
  /** Plugin-scoped logger; output goes to the harness run log. */
  log: (msg: string) => void;
  /**
   * Plugin-private storage path under `<stateDir>/plugins/<plugin-name>/`.
   * The runtime ensures it exists before any hook fires.
   */
  pluginDataDir: string;
}

/**
 * A custom role definition. Plugins can register additional agent roles
 * (e.g. `narrator` for briefings) that the harness orchestrator can invoke
 * via `invoke <role-name>`.
 */
export interface RoleDefinition {
  /** Role name; what `invoke <name>` references. */
  name: string;
  /** Path (relative to plugin root) or string content of the role's prompt. */
  prompt: { path: string } | { content: string };
  /** Default model for this role; project config can override. */
  defaultModel?: string;
  /** Default per-invocation timeout in seconds. */
  defaultTimeoutSec?: number;
}

/**
 * Lifecycle hooks plugins can register. All hooks are async.
 */
export interface PluginHooks {
  /** Fires before the harness loop's first iteration. */
  beforeMissionStart?(ctx: PapercuspContext): Promise<void>;
  /** Fires when the orchestrator decides DONE. */
  afterDone?(ctx: PapercuspContext): Promise<void>;
  /** Fires after `apply_proposal_to_spec` accepts a reviewer-approved proposal. */
  onProposalAccepted?(ctx: PapercuspContext, proposalPath: string): Promise<void>;
  /** Fires after each feature transitions to `passed`. */
  onFeaturePassed?(ctx: PapercuspContext, featureId: string): Promise<void>;
}

/**
 * A dashboard tab the plugin contributes to the harness UI. The runtime
 * mounts the React component as a sibling tab alongside Features, Logs, etc.
 */
export interface DashboardTab {
  /** Stable id; used in URL fragments. */
  id: string;
  /** Display label (kept short — fits on a tab). */
  label: string;
  /** React component rendered when the tab is active. */
  component: ComponentType<{ slug: string }>;
  /** Optional Lucide icon name. */
  icon?: string;
}

/**
 * Postgres schema additions a plugin needs. The runtime applies the DDL
 * on first load. SQL is expected to be idempotent (`CREATE TABLE IF NOT
 * EXISTS …`, etc.).
 */
export interface PluginSchemaDef {
  /** Postgres schema name (e.g. `papercup_briefings`). */
  schemaName: string;
  /** Path (relative to plugin root) to the DDL file. */
  ddlPath: string;
}

/**
 * The main plugin shape. Plugins default-export an object satisfying this
 * interface. Loader contract:
 *
 *   import plugin from './plugins/briefings';   // imports default export
 *   await loader.register(plugin);
 *
 * The loader validates `name` is unique, `papercusp` semver matches, and
 * any `schema` DDL applies cleanly.
 */
export interface Plugin {
  /** Unique plugin name (used as filesystem dir + Postgres schema prefix). */
  name: string;
  /** Plugin semver. */
  version: string;
  /** Required Papercusp framework semver range. */
  papercusp: string;
  /** Optional human-readable description shown in the marketplace + admin. */
  description?: string;

  /** Lifecycle init — runs once on plugin load. */
  init?(ctx: PapercuspContext): Promise<void>;

  /** Custom role registrations. Keyed by role name. */
  roles?: Record<string, RoleDefinition>;
  /** Lifecycle hooks. */
  hooks?: PluginHooks;
  /** Dashboard tab contributions. */
  dashboardTabs?: DashboardTab[];
  /**
   * API routes contributed by the plugin. The runtime mounts this Hono app
   * (or compatible) at `/api/plugins/<plugin-name>/`.
   *
   * Typed as `unknown` here to keep the SDK Hono-version-agnostic; loader
   * casts to the framework's Hono instance at registration time.
   */
  apiRoutes?: unknown;
  /** Postgres schema this plugin owns. */
  schema?: PluginSchemaDef;
  /**
   * JSON-Schema describing config keys this plugin accepts under
   * `.harness/config.json :: plugins.<plugin-name>`. Used for validation
   * and to render config UIs.
   */
  configSchema?: Record<string, unknown>;
}
