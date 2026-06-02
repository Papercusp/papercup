/**
 * Harness-state table registry — the single source of truth for the two-axis
 * storage model (plan `harness-state-storage-unification-2026-06-01`, P-002).
 *
 * Spec: `/internal/docs/system/storage-policy` § "Two axes". Vocabulary is
 * deliberate — DO NOT write "canonical"; use these two orthogonal axes:
 *
 *   • key  — the runtime store-of-record identity (always PG; D-002):
 *       'slug-shared'     → keyed by harness_slug; ONE set shared across every
 *                            workspace that has the harness in its registry
 *                            (harnesses-across-workspaces D-1: shared results).
 *       'workspace-owned' → keyed by (workspace, harness, …); per-workspace
 *                            config / settings / personal state (D-1).
 *
 *   • sync — the cross-machine SYNC AUTHORITY (merge + propagation):
 *       'none'     → local-only; never leaves this install.
 *       'git'      → committed `.harness/state/` files, GitHub-merged
 *                    (dogfood D-001/D-020 — git over Hyperbee for documents).
 *       'peer-log' → Hyperbee/Model-B per-peer log, LWW (live shared state).
 *
 * PG is the runtime store-of-record for EVERY row regardless of `sync`; the
 * sync authority is the cross-machine merge point that PG converges to. `git`
 * and `peer-log` tables are hydrated-from / exported-to their authority; PG is
 * never a "disposable cache" (see the storage-policy reframe).
 *
 * STATUS: P-002 classification COMPLETE — every previously-ambiguous table now
 * has an explicit call (NEEDS_REVIEW is empty). The DEFAULT covers the large
 * majority (per-install, slug-keyed result tables that don't sync); only the
 * EXCEPTIONS are declared. Live-schema-drift coverage (a NEW table added later
 * must be classified, not silently DEFAULTed) is asserted by the P-003
 * projection engine at boot via `classifyInventory()` against the live schema.
 */

export type TableKey = 'slug-shared' | 'workspace-owned';
export type SyncAuthority = 'none' | 'git' | 'peer-log';

export interface TableSpec {
  /** runtime store-of-record identity (PG is always the store). */
  key: TableKey;
  /** cross-machine merge + propagation authority. */
  sync: SyncAuthority;
  /** never cross machines under any circumstance (§7.5 SECURITY); forces sync='none'. */
  security?: boolean;
  /** legacy/dead surface (kept for reference; not extended) — D-008 papercup-org. */
  legacy?: boolean;
  /** why this differs from DEFAULT / where it came from. */
  note?: string;
}

/** Fall-through for the large majority: a per-install, slug-keyed result table. */
export const DEFAULT_SPEC: TableSpec = { key: 'slug-shared', sync: 'none' };

/**
 * GIT sync authority — document-shaped shared state (dogfood §7.2 GIT bucket).
 * key=slug-shared; PG hydrates from / exports to `.harness/state/<…>`.
 */
const GIT_DOCS = [
  'harness_decisions', 'harness_summaries', 'harness_escalations',
  'harness_design_artifacts', 'harness_text_artifacts', 'harness_chunk_plans',
  'harness_feature_notes', 'harness_feature_debug_notes', 'feature_audit_consolidated',
  'harness_tests', 'llm_test_fixtures', 'llm_test_claims', 'llm_test_findings',
  'harness_phases', 'harness_promotions', 'harness_lanes', 'harness_checkpoints',
  'harness_branch_actions', 'harness_snapshots', 'harness_experts',
  'harness_skills', 'goals', 'harness_proposals_shared', 'snapshot_features',
  'project_spec_revisions',
  // papercup_shared.* document tables (schema-qualified at the engine layer):
  'messages', 'directives', 'briefings', 'directive_summaries',
];

/**
 * PEER-LOG sync authority — live cross-machine shared state (§7.1 HYPERBEE +
 * the Hyperbee/Model-B projection set in apps/operator/lib/sync/hyperbee/projections).
 */
const PEER_LOG_LIVE = [
  'harness_features_consolidated', 'harness_issues_consolidated',
  'feature_claims', 'feature_queue', 'feature_working_set',
  'contributors', 'contributor_usage_events', 'harness_feature_prs',
  'shared_presence',
];

/**
 * Workspace-owned config/settings that DON'T match a prefix rule below.
 * (across-workspaces D-1: "config becomes fully workspace-owned".)
 */
const WORKSPACE_OWNED_EXPLICIT = [
  'harness_prompt_overrides',     // the (workspace,harness,role) 3-tier override — across-workspaces Phase 1b
  'orchestrator_settings', 'setup_wizard_state', 'workspace_backup_settings',
  'pr_reviewer_settings', 'insights_first_visit', 'known_schema_versions',
  'adaptive_telemetry', 'spawned_agents', 'hidden_plugins',  // P-002 review: per-install/per-workspace
  // P-002 completeness review (classifyInventory over live schema surfaced these per-workspace tables):
  'harness_registry',          // per-workspace harness membership list (one JSONB row/workspace) — NOT slug-shared
  'autoloop_state', 'harness_dock_layouts', 'saved_prompts',
  'harness_brainstorm', 'harness_plan_review', 'plan_revisions', 'plan_runs', 'plan_run_turns', // §7.4 LOCAL Plans = workspace-scoped
];

/**
 * SECURITY (§7.5) — credentials / tokens / principals. NEVER cross machines
 * (sync forced to 'none'); workspace-owned.
 */
const SECURITY = [
  'operator_credentials', 'operator_secrets', 'operator_publish_credentials',
  'operator_search_provider_credentials', 'operator_voice_credentials',
  'operator_marketplace_token', 'operator_trust_store',
  'oauth_nonces', 'mobile_pair_tokens', 'mobile_push_tokens', 'token_index',
  'spawn_sig_verification_failures', 'system_principals',
  'system_principal_activity', 'trusted_authors',
  'provision_state', 'provision_audit_log', 'auth_audit_log', 'webhook_audit',
];

/**
 * Name-prefix → workspace-owned (operator/user/session/device-personal +
 * P-002-reviewed per-install operational classes: coord, plugin, backup,
 * telemetry, mem0, invocations).
 */
const WORKSPACE_OWNED_PREFIXES = [
  'operator_', 'user_', 'users', 'auth_', 'mobile_', 'voice_', 'ui_',
  'pi_sessions', 'power_user_sessions', 'adv_sessions',
  'coord_', 'plugin_', 'backup_', 'telemetry_', 'memory_',
  'tool_invocations', 'route_invocations',
];

/** Legacy / dead (D-008 papercup-org departments) — classified DEFAULT, not extended. */
const LEGACY_DEAD = [
  'org_charter', 'org_decisions', 'org_departments', 'org_inbox',
  'org_notes', 'org_outbox', 'org_projects',
];

const GIT_SET = new Set(GIT_DOCS);
const PEER_SET = new Set(PEER_LOG_LIVE);
const WS_EXPLICIT_SET = new Set(WORKSPACE_OWNED_EXPLICIT);
const SECURITY_SET = new Set(SECURITY);
const LEGACY_SET = new Set(LEGACY_DEAD);

/** The registry's sync-authority sets, exported for the projection engine (P-003). */
export const PEER_LOG_TABLES: readonly string[] = PEER_LOG_LIVE;
export const GIT_TABLES: readonly string[] = GIT_DOCS;

/**
 * Remaining genuine judgment calls — EMPTY as of P-002 close. New entries here
 * mark a table whose classification an owner must confirm before it ships.
 */
export const NEEDS_REVIEW: Record<string, string> = {};

/**
 * Resolve a table's two-axis spec. Order: security → git → peer-log →
 * workspace-explicit → legacy → workspace-prefix → DEFAULT. Strip a
 * `harness_shared.` / `papercup_shared.` schema qualifier before calling.
 */
export function resolveTableSpec(table: string): TableSpec {
  const t = table.includes('.') ? table.slice(table.indexOf('.') + 1) : table;
  if (SECURITY_SET.has(t)) return { key: 'workspace-owned', sync: 'none', security: true, note: '§7.5 SECURITY' };
  if (GIT_SET.has(t)) return { key: 'slug-shared', sync: 'git', note: '§7.2 GIT document' };
  if (PEER_SET.has(t)) return { key: 'slug-shared', sync: 'peer-log', note: '§7.1 live shared' };
  if (WS_EXPLICIT_SET.has(t)) return { key: 'workspace-owned', sync: 'none', note: 'config/settings (D-1)' };
  if (LEGACY_SET.has(t)) return { ...DEFAULT_SPEC, legacy: true, note: 'legacy/dead — D-008 papercup-org' };
  for (const p of WORKSPACE_OWNED_PREFIXES) {
    if (t === p || t.startsWith(p)) return { key: 'workspace-owned', sync: 'none', note: `prefix:${p}` };
  }
  return { ...DEFAULT_SPEC };
}

/** True if the table's classification is still a pending judgment call. */
export function needsReview(table: string): boolean {
  const t = table.includes('.') ? table.slice(table.indexOf('.') + 1) : table;
  return t in NEEDS_REVIEW;
}

export interface InventoryClassification {
  total: number;
  /** count per `${key}/${sync}` bucket. */
  byBucket: Record<string, number>;
  /** tables that fell through to DEFAULT (slug-shared/none) — intentional, but reviewable. */
  defaulted: string[];
  /** tables still flagged NEEDS_REVIEW (should be empty at/after P-002 close). */
  unreviewed: string[];
}

/**
 * Classify a full list of live tables (P-003 engine boot passes the live
 * `information_schema` set here). Surfaces the DEFAULT fall-through set + any
 * still-unreviewed table so a NEW table can never silently inherit DEFAULT
 * without someone seeing it.
 */
export function classifyInventory(tables: string[]): InventoryClassification {
  const byBucket: Record<string, number> = {};
  const defaulted: string[] = [];
  const unreviewed: string[] = [];
  for (const raw of tables) {
    const t = raw.includes('.') ? raw.slice(raw.indexOf('.') + 1) : raw;
    const spec = resolveTableSpec(t);
    const bucket = `${spec.key}/${spec.sync}${spec.security ? '/sec' : ''}${spec.legacy ? '/legacy' : ''}`;
    byBucket[bucket] = (byBucket[bucket] ?? 0) + 1;
    const isExplicit =
      SECURITY_SET.has(t) || GIT_SET.has(t) || PEER_SET.has(t) ||
      WS_EXPLICIT_SET.has(t) || LEGACY_SET.has(t) ||
      WORKSPACE_OWNED_PREFIXES.some((p) => t === p || t.startsWith(p));
    if (!isExplicit) defaulted.push(t);
    if (needsReview(t)) unreviewed.push(t);
  }
  return { total: tables.length, byBucket, defaulted, unreviewed };
}
