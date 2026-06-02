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
 * STATUS: P-002 first cut. Rule-derived from the dogfood §7 buckets + D-1.
 * The DEFAULT covers the large majority (per-install, slug-keyed result tables
 * that don't sync). Only the EXCEPTIONS are declared. Tables in NEEDS_REVIEW
 * still need an owner judgment before P-003 (the projection engine) consumes
 * this. Completeness must be validated against the live schema (P-002 tail).
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
  'harness_feature_notes', 'feature_audit_consolidated', 'harness_tests',
  'llm_test_fixtures', 'llm_test_claims', 'llm_test_findings',
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

/** Name-prefix → workspace-owned (operator/user/session/device-personal state). */
const WORKSPACE_OWNED_PREFIXES = [
  'operator_', 'user_', 'users', 'auth_', 'mobile_', 'voice_', 'ui_',
  'pi_sessions', 'power_user_sessions', 'adv_sessions',
];

const GIT_SET = new Set(GIT_DOCS);
const PEER_SET = new Set(PEER_LOG_LIVE);
const WS_EXPLICIT_SET = new Set(WORKSPACE_OWNED_EXPLICIT);
const SECURITY_SET = new Set(SECURITY);

/**
 * Tables whose classification is a genuine judgment call — DO NOT trust the
 * resolved DEFAULT for these until an owner signs off (P-002 review gate).
 */
export const NEEDS_REVIEW: Record<string, string> = {
  // legacy papercup-org department schema — D-008 (out of scope / legacy):
  org_charter: 'legacy org', org_decisions: 'legacy org', org_departments: 'legacy org',
  org_inbox: 'legacy org', org_notes: 'legacy org', org_outbox: 'legacy org',
  org_projects: 'legacy org',
  // SU coordination layer — per-install or cross-peer? presence may want peer-log:
  coord_event_log: 'coord: local vs peer?', coord_presence: 'coord: local vs peer?',
  coord_subscriptions: 'coord: local vs peer?', coord_watermarks: 'coord: local vs peer?',
  // plugin config — workspace-owned vs per-harness key axis:
  plugin_configs: 'plugin key axis', plugin_enables: 'plugin key axis',
  plugin_capability_grants: 'plugin key axis', plugin_kv: 'plugin key axis',
  plugin_reload_state: 'plugin key axis', hidden_plugins: 'plugin key axis',
  // per-install runtime telemetry — workspace-owned vs slug-shared key:
  tool_invocations: 'telemetry key (has workspace RLS today → likely workspace-owned)',
  tool_invocations_artifacts: 'telemetry key', tool_invocations_spawn_tree: 'telemetry key',
  route_invocations: 'telemetry key', telemetry_reports: 'telemetry key',
  telemetry_reports_archive: 'telemetry key', adaptive_telemetry: 'telemetry key',
  // mem0 per-engineer memory (§7.4 LOCAL) — workspace-owned key:
  memory_anchors: 'mem0 per-engineer → workspace-owned?', memory_canonical: 'mem0 key',
  memory_vec_local: 'mem0 key', memory_vec_openai: 'mem0 key',
  // backup operational state:
  backup_events: 'backup key', backup_snapshots: 'backup key',
  // misc judgment calls:
  spawned_agents: 'has workspace RLS today → workspace-owned?',
  harness_feature_debug_notes: 'document (git) vs runtime (none)?',
  pr_check_status_cache: 'prs-related: peer-log vs none cache?',
  substrate_meta: 'sync machinery itself', substrate_outbox: 'sync machinery itself',
};

/**
 * Resolve a table's two-axis spec. Order: explicit overrides → security →
 * prefix rules → DEFAULT. Strip a `harness_shared.` / `papercup_shared.`
 * schema qualifier before calling.
 */
export function resolveTableSpec(table: string): TableSpec {
  const t = table.includes('.') ? table.slice(table.indexOf('.') + 1) : table;
  if (SECURITY_SET.has(t)) return { key: 'workspace-owned', sync: 'none', security: true, note: '§7.5 SECURITY' };
  if (GIT_SET.has(t)) return { key: 'slug-shared', sync: 'git', note: '§7.2 GIT document' };
  if (PEER_SET.has(t)) return { key: 'slug-shared', sync: 'peer-log', note: '§7.1 live shared' };
  if (WS_EXPLICIT_SET.has(t)) return { key: 'workspace-owned', sync: 'none', note: 'config/settings (D-1)' };
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
