/**
 * @papercusp/plugin-sdk — type definitions for Papercusp plugins.
 *
 * Plugins extend a Papercusp install with new roles, lifecycle hooks,
 * dashboard tabs, API routes, Postgres schemas, full UI panels, routines,
 * and event hooks. Capabilities (declarative permissions) gate every
 * non-trivial action.
 *
 * Stability: pre-1.0. Spec at apps/papercusp-spec/ (dev: http://localhost:4324/).
 */

import type { ComponentType } from 'react';

/* ─────────────────────────────────────────────────────────────────────
 * Capabilities — declarative permission strings.
 *
 * Format: namespace:action[:resource]
 *
 * - Manifest declares them up-front
 * - DI container enforces at every service-method call
 * - Iframe sandbox enforces network ones via CSP
 * - Install-time consent prompts the user
 *
 * See §10 of the Papercusp spec (apps/papercusp-spec/, /spec/capabilities/) for the full model.
 * ───────────────────────────────────────────────────────────────────── */

export type Capability =
  // Data access (the DI container's read/write methods are gated by these).
  | 'tasks:read' | 'tasks:write'
  | 'features:read' | 'features:write'
  | 'comments:read' | 'comments:write'
  | 'goals:read' | 'goals:write'
  | 'projects:read' | 'projects:write'

  // Plugin's own resources (always granted; declarative for clarity).
  | 'storage:plugin-private'
  | 'db:plugin-schema'

  // Routines.
  | 'routines:read' | 'routines:write'

  // UI surfaces this plugin claims.
  | 'ui:dashboard-tab'
  | 'ui:sidebar-item'
  | 'ui:harness-route'         // owns /harness/<install-slug>

  // Network — manifest declares allowed domains; iframe CSP enforces.
  // Use as: 'http:fetch:youtube.com', 'http:fetch:*.googleapis.com'
  | `http:fetch:${string}`

  // Secrets — by name, no wildcard. e.g. 'secrets:read:YOUTUBE_API_KEY'.
  | `secrets:read:${string}`
  | `secrets:write:${string}`

  // Events / hooks. e.g. 'events:emit:briefing-ready'.
  | `events:emit:${string}`
  | `events:listen:${string}`

  // Roles. e.g. 'roles:register:narrator'.
  | `roles:register:${string}`;


/* ─────────────────────────────────────────────────────────────────────
 * Plugin context passed at load time and on every hook invocation.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * Lifecycle context: filesystem paths + log surface.
 */
export interface PapercuspContext {
  /** Slug of the harness install this plugin instance is running inside. */
  installSlug: string;
  /** Absolute path to the install's project root. */
  projectDir: string;
  /** Absolute path to the install's `.harness/` directory (legacy file state). */
  stateDir: string;
  /** Plugin-private storage path under `<stateDir>/plugins/<plugin-name>/`. */
  pluginDataDir: string;
  /** Plugin-scoped logger; output goes to the harness run log. */
  log: (msg: string) => void;
}


/* ─────────────────────────────────────────────────────────────────────
 * Roles — custom agent invocations.
 * ───────────────────────────────────────────────────────────────────── */

export interface RoleDefinition {
  /** Role name; the orchestrator dispatches via `NEXT_<UPPER_NAME>`. */
  name: string;
  /** Path (relative to plugin root) or string content of the prompt. */
  prompt: { path: string } | { content: string };
  /** Default model identifier; install config can override. */
  defaultModel?: string;
  /** Default per-invocation timeout in seconds. */
  defaultTimeoutSec?: number;
  /** What inputs from the harness state should be included in the user prompt. */
  reads?: ('features' | 'goals' | 'pending_events' | 'issues' | 'worker_log' | 'audit')[];
}


/* ─────────────────────────────────────────────────────────────────────
 * Lifecycle hooks — host calls these at well-known phases.
 * ───────────────────────────────────────────────────────────────────── */

export interface PluginHooks {
  /** Fires once when the plugin is loaded. */
  onLoad?(ctx: PapercuspContext): Promise<void>;
  /** Fires when the plugin is being unloaded (uninstall, host shutdown). */
  onUnload?(ctx: PapercuspContext): Promise<void>;

  /** Fires before the harness loop's first iteration. */
  beforeMissionStart?(ctx: PapercuspContext): Promise<void>;
  /** Fires when the orchestrator decides DONE. */
  afterDone?(ctx: PapercuspContext): Promise<void>;

  /** Fires after a feature transitions to `passed`. */
  onFeaturePassed?(ctx: PapercuspContext, featureId: string): Promise<void>;
  /** Fires after `apply_proposal_to_spec` accepts a reviewer-approved proposal. */
  onProposalAccepted?(ctx: PapercuspContext, proposalPath: string): Promise<void>;

  /** Fires after the orchestrator role completes. Receives its decision verb. */
  onPostOrchestrator?(ctx: PapercuspContext, decision: string): Promise<void>;
  /** Fires after a worker role completes. Receives the feature it worked on. */
  onPostWorker?(ctx: PapercuspContext, featureId: string): Promise<void>;
  /** Fires after a validator role completes. */
  onPostValidator?(ctx: PapercuspContext, featureId: string, status: 'passed' | 'failing'): Promise<void>;
}


/* ─────────────────────────────────────────────────────────────────────
 * Routines — scheduled or triggered event sources.
 *
 * The substrate's routine ticker fires due cron routines and inserts into
 * pending_events; webhook/api routines insert on receipt. Orchestrator
 * consumes the queue on its next tick.
 * ───────────────────────────────────────────────────────────────────── */

export interface RoutineDefinition {
  /** Stable name within the plugin (used for the routine row's name column). */
  name: string;
  /** Trigger config. */
  trigger:
    | { kind: 'cron'; expr: string }                    // e.g. '0 9 * * MON'
    | { kind: 'webhook'; tokenEnv?: string }             // value read from secrets
    | { kind: 'api'; method?: 'POST' | 'GET' };
  /** Which role to dispatch when this routine fires. */
  targetRole: string;
  /** Optional payload to include with the pending_event. */
  payloadTemplate?: Record<string, unknown>;
  /** What happens if the routine fires while a previous run is still in progress. */
  concurrency?: 'queue' | 'skip' | 'cancel-prev';
  /** What happens if the substrate was offline when a cron event was due. */
  catchup?: 'skip-old' | 'run-all-backlog';
}


/* ─────────────────────────────────────────────────────────────────────
 * UI contributions.
 *
 * Six axes (matching the spec):
 *   1. ui  — full route at /harness/<slug>; owns the harness's dashboard
 *   2. dashboardTabs — tabs inside the harness's dashboard
 *   3. sidebarItems — top-nav additions
 *
 * v1: React components compiled into the host bundle (Backstage style).
 * v2: Iframe-loaded bundles with capability-checked postMessage RPC
 *     (Figma style). Same manifest, different loader.
 * ───────────────────────────────────────────────────────────────────── */

export interface UiContribution {
  /** URL slug — mounted at /harness/<slug>. Must match the install's slug. */
  slug: string;
  /** Display name in the harness picker + nav. */
  label: string;
  /** Optional icon: lucide-react name (v1) or URL (v2 iframe). */
  icon?: string;
  /** Lazy-loaded React component (v1). */
  component: () => Promise<{ default: ComponentType<HarnessUIProps> }>;
  /** Optional sub-routes mounted at /harness/<slug>/<sub>. */
  subRoutes?: SubRouteContribution[];
}

export interface SubRouteContribution {
  path: string;                    // e.g. 'briefings' → /harness/<slug>/briefings
  label: string;
  component: () => Promise<{ default: ComponentType<HarnessUIProps> }>;
}

/** Props the host passes to every UI component */
export interface HarnessUIProps {
  /** Slug of the harness install. */
  slug: string;
  /** DI container — read host state via this. Capability-scoped. */
  api: PapercuspApi;
  /** Read-only? (e.g., on the public site). */
  readOnly: boolean;
}

export interface DashboardTab {
  id: string;
  label: string;
  icon?: string;
  /** React component rendered when the tab is active. */
  component: ComponentType<{ slug: string; api: PapercuspApi; readOnly: boolean }>;
}

export interface SidebarItem {
  id: string;
  label: string;
  href: string;
  icon?: string;
  /** Optional badge value (count, status). */
  badge?: () => Promise<string | number | null>;
}


/* ─────────────────────────────────────────────────────────────────────
 * Dependency-injection container exposed to plugins.
 *
 * Plugins receive this via HarnessUIProps.api or via createContext() in
 * server-side hooks. Every method is a typed proxy; the runtime checks
 * the plugin's declared capabilities before delegating to real services.
 * ───────────────────────────────────────────────────────────────────── */

export interface PapercuspApi {
  tasks: TasksService;
  goals: GoalsService;
  pendingEvents: PendingEventsService;
  routines: RoutinesService;
  comments: CommentsService;
  secrets: SecretsService;
  fetch: PluginFetch;
  storage: PluginStorage;
  db: PluginDb;
  hooks: PluginHookBus;
  /** Inspector — what capabilities this plugin actually has. */
  capabilities: () => Capability[];
}

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  parentId: string | null;
  goalId: string | null;
  attempts: number;
  takenBy: string | null;
  expiresAt: string | null;
  metadata?: Record<string, unknown>;
}

export interface TasksService {
  /** Cap: tasks:read */
  list(opts?: { status?: string; goalId?: string; parentId?: string }): Promise<TaskRow[]>;
  /** Cap: tasks:read */
  get(id: string): Promise<TaskRow | null>;
  /** Cap: tasks:read */
  lineage(id: string): Promise<{ level: number; kind: 'task' | 'goal'; id: string; title: string }[]>;
  /** Cap: tasks:write */
  create(input: Partial<TaskRow> & { title: string }): Promise<TaskRow>;
  /** Cap: tasks:write */
  setStatus(id: string, status: string): Promise<TaskRow>;
}

export interface GoalRow {
  id: string;
  installSlug: string;
  title: string;
  body: string | null;
  parentId: string | null;
  budgetCents: number | null;
  status: string;
}

export interface GoalsService {
  /** Cap: goals:read */
  list(): Promise<GoalRow[]>;
  /** Cap: goals:read */
  get(id: string): Promise<GoalRow | null>;
  /** Cap: goals:write */
  create(input: Partial<GoalRow> & { id: string; title: string }): Promise<GoalRow>;
}

export interface PendingEventsService {
  /** Cap: tasks:read (events are part of the orchestrator's input set) */
  listUnconsumed(): Promise<{ id: string; kind: string; targetRole: string; payload: unknown; dueAt: string | null }[]>;
}

export interface RoutinesService {
  /** Cap: routines:read */
  list(): Promise<{ id: string; name: string; triggerKind: string; targetRole: string; nextFireAt: string | null; active: boolean }[]>;
  /** Cap: routines:write */
  upsert(definition: RoutineDefinition): Promise<{ id: string }>;
  /** Cap: routines:write */
  delete(name: string): Promise<void>;
  /** Cap: routines:write — manually fire (inserts a pending_event) */
  trigger(name: string, payload?: Record<string, unknown>): Promise<{ eventId: string }>;
}

export interface CommentsService {
  /** Cap: comments:read */
  list(taskId: string): Promise<{ id: string; body: string; createdAt: string; author: string }[]>;
  /** Cap: comments:write */
  create(taskId: string, body: string): Promise<{ id: string }>;
}

export interface SecretsService {
  /** Cap: secrets:read:<NAME> for the specific name */
  read(name: string): Promise<string>;
}

/** Cap-checked fetch. Domain must appear in `http:fetch:<domain>` capability. */
export type PluginFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface PluginStorage {
  /** Cap: storage:plugin-private (always granted). Path is namespaced under plugin's dir. */
  read(path: string): Promise<Buffer | null>;
  write(path: string, data: Buffer | string): Promise<void>;
  delete(path: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface PluginDb {
  /** Cap: db:plugin-schema. Returns a Drizzle-compatible client scoped to plugin_<name>. */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string, params?: unknown[]): Promise<void>;
}


/* ─────────────────────────────────────────────────────────────────────
 * Hook bus — WordPress-style addAction/addFilter.
 *
 * Lets plugins extend behaviour without modifying core. Hook names + arg
 * shapes are part of the spec; capabilities gate subscription/emission.
 * ───────────────────────────────────────────────────────────────────── */

export interface PluginHookBus {
  /** Cap: events:listen:<event-name>. Fires when the host emits <event-name>. */
  addAction<T = unknown>(event: string, handler: (arg: T) => void | Promise<void>): void;
  /** Cap: events:listen:<event-name>. Lets plugins transform a value passing through the host. */
  addFilter<T = unknown>(event: string, handler: (arg: T) => T | Promise<T>): void;
  /** Cap: events:emit:<event-name>. Plugins can emit their own custom events for other plugins. */
  emit<T = unknown>(event: string, arg: T): Promise<void>;
}


/* ─────────────────────────────────────────────────────────────────────
 * Plugin schema — Postgres DDL the plugin owns.
 * ───────────────────────────────────────────────────────────────────── */

export interface PluginSchemaDef {
  /** Postgres schema name. Convention: plugin_<plugin-name-with-underscores>. */
  schemaName: string;
  /** Path (relative to plugin root) to the DDL file. */
  ddlPath: string;
}


/* ─────────────────────────────────────────────────────────────────────
 * The main plugin shape.
 *
 *   import plugin from './plugins/briefings';
 *   await loader.register(plugin);
 *
 * The loader validates: name unique, semver matches manifest, capabilities
 * resolve, schema DDL applies cleanly, UI components import.
 * ───────────────────────────────────────────────────────────────────── */

export interface Plugin {
  /** Unique plugin name (filesystem dir + Postgres schema prefix). */
  name: string;
  /** Plugin semver. */
  version: string;
  /** Required Papercusp framework semver range. */
  papercusp: string;
  /** Optional human-readable description shown in the marketplace + admin. */
  description?: string;

  /** Declarative permission manifest. Loader enforces these at every API call. */
  capabilities: Capability[];

  /** Lifecycle init — runs once on plugin load. */
  init?(ctx: PapercuspContext): Promise<void>;

  /** Custom role registrations. Keyed by role name. */
  roles?: Record<string, RoleDefinition>;
  /** Lifecycle hooks. */
  hooks?: PluginHooks;
  /** Routines — substrate-evaluated triggers. */
  routines?: RoutineDefinition[];

  /** Full-route UI mounted at /harness/<slug>. */
  ui?: UiContribution;
  /** Tabs added to a host's harness dashboard. */
  dashboardTabs?: DashboardTab[];
  /** Top-nav sidebar items. */
  sidebarItems?: SidebarItem[];

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
   * the install's plugin config. Used for validation + config UIs.
   */
  configSchema?: Record<string, unknown>;
}


/* ─────────────────────────────────────────────────────────────────────
 * Helper: defineService for typed service registration.
 *
 * Plugin authors declare what their service exposes; the loader uses this
 * metadata to enforce capabilities at the proxy level.
 * ───────────────────────────────────────────────────────────────────── */

export interface ServiceMethodDef {
  /** Capability required to invoke this method. Either a literal or a function for resource-scoped caps. */
  capability: Capability | ((...args: unknown[]) => Capability);
}

export interface ServiceDef {
  name: string;
  methods: Record<string, ServiceMethodDef>;
}

export function defineService(def: ServiceDef): ServiceDef {
  return def;
}
