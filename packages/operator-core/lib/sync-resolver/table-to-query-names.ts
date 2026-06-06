/**
 * Reverse map: PG table → camelCase queryNames that read from it.
 *
 * Used by the sync-sse.ts LISTEN handler to bridge PG-trigger-driven
 * `emit_change_notify` events to the established camelCase consumer
 * subscriptions (P-067 from papercusp-dogfood-v5).
 *
 * Without this bridge, a PG INSERT on `harness_shared.harness_text_artifacts`
 * fires a `harness_shared.harness_text_artifacts.changed` event, but
 * existing `useSyncQuery({ queryName: 'harnessTextArtifact.byHarness' })`
 * subscribers see no matching name and don't refetch. With this bridge,
 * the LISTEN handler synthesizes additional events with the camelCase
 * names the consumers subscribe to. The dedupe window in sync-sse.ts
 * collapses repeated identical (name, args) within 90s, so this stays
 * cheap even under heavy write load.
 *
 * Maintenance: each entry corresponds to a v2 registry entry in
 * `apps/operator/lib/sync-resolver/index.ts`. When you add a new
 * registry entry that reads from table T, add (T → name) here too.
 * The `T` is the FULL `<schema>.<table>` string that the PG trigger
 * emits.
 *
 * Note on args: PG-trigger events don't carry per-row scoping args
 * (just the workspace_id GUC). The bridge emits events with NO `args`
 * field — clients invalidate the full query cache for that name (the
 * SSEAdapter calls `queryClient.invalidateQueries({ queryKey: [name] })`
 * which is correct: any subscriber to that name refetches with its own
 * args).
 */

/**
 * Map of (schema.table) → camelCase queryNames that scope reads on it.
 * Keys are the exact strings the PG trigger emits in the `name` field
 * (`harness_shared.<table>.changed` becomes the lookup key after
 * stripping the `.changed` suffix).
 */
export const TABLE_TO_QUERY_NAMES: Readonly<Record<string, readonly string[]>> = {
  // ── Per-harness HYPERBEE-bucket tables ────────────────────────────
  'harness_shared.harness_text_artifacts': ['harnessTextArtifact.byHarness'],
  'harness_shared.harness_project_files': ['harnessProjectFiles.byHarness'],
  'harness_shared.harness_skills': ['harnessSkills.byHarness'],
  'harness_shared.harness_decisions': ['harnessDecisions.byHarness'],
  'harness_shared.harness_lanes': ['harnessLanes.byHarness'],
  'harness_shared.harness_escalations': ['harnessEscalations.byHarness'],
  'harness_shared.harness_checkpoints': ['harnessCheckpoints.byHarness'],
  'harness_shared.harness_git_log': ['harnessGitLog.byHarness'],
  'harness_shared.harness_feature_prs': ['featurePrs.byHarness'],
  'harness_shared.harness_status': ['harnessStatus.byHarness'],
  'harness_shared.harness_tests': ['harnessTests.byHarness'],
  'harness_shared.harness_archives': ['harnessArchives.byHarness'],
  'harness_shared.harness_hook_logs': ['harnessHookLogs.byHarness'],
  'harness_shared.harness_summaries': ['summary.byHarness'],
  'harness_shared.harness_phases': ['harnessPhases.byHarness'],
  'harness_shared.harness_smoke_test': ['harnessSmokeTest.byHarness'],
  'harness_shared.harness_plan_review': ['harnessPlanReview.byHarness'],
  // Plans went PG-canonical (plans-pg-canonical-migration-2026-06-03): a write to
  // harness_plans invalidates the plan directory + per-plan reads. plan_revisions
  // / plan_runs feed the audit + run panels.
  'harness_shared.harness_plans': [
    'plans.list',
    'plans.get',
    'plans.items',
    'plans.attention',
    'plans.search',
  ],
  'harness_shared.plan_revisions': ['plans.revisions'],
  'harness_shared.plan_runs': ['plans.runs'],
  'harness_shared.harness_brainstorm': ['harnessBrainstorm.byHarness'],
  'harness_shared.pending_reviews': ['pendingReviews.byHarness'],
  'harness_shared.harness_pending_issues': ['harnessPendingIssues.byHarness'],
  'harness_shared.harness_screenshots': ['harnessScreenshots.byHarness'],
  'harness_shared.harness_branch_actions': ['harnessBranchActions.byHarnessAndBranch'],
  'harness_shared.agent_chats_consolidated': ['agentChats.byHarness'],
  'harness_shared.harness_feature_notes': ['featureNotes.byHarness'],
  'harness_shared.harness_feature_debug_notes': ['featureDebugNotes.byHarness'],
  'harness_shared.feature_audit_consolidated': ['featureAudit.byHarness'],
  // chunkPlans contributes 2 query names sharing 1 table; both fire.
  'harness_shared.harness_chunk_plans': [
    'chunkPlans.byHarness',
    'chunkPlans.byFeature',
  ],
  'harness_shared.harness_proposals_shared': ['proposalsShared.byHarness'],

  // ── Per-workspace tables ──────────────────────────────────────────
  'harness_shared.toast_log': ['toastLog.recent'],
  'harness_shared.operator_budget': ['operatorBudget.byWorkspace'],
  'harness_shared.audit_log': ['auditLog.operatorDecisions'],
  'harness_shared.user_actions': ['userActions.byHarness', 'userActions.byKind'],
  'harness_shared.plugin_configs': ['pluginConfigs.byHarness'],
  'harness_shared.plugin_enables': ['pluginEnables.byWorkspace'],
  'harness_shared.project_spec_revisions': ['projectSpecRevisions.byProject'],

  // ── Cross-harness *Consolidated tables ────────────────────────────
  'harness_shared.harness_features_consolidated': ['featuresConsolidated.bySlug', 'featuresConsolidated.byPlanSlug'],
  'harness_shared.harness_issues_consolidated': ['issuesConsolidated.bySlug'],
  'harness_shared.agent_runs_consolidated': [
    'agentRunsConsolidated.bySlug',
    'agentRunsConsolidated.recent',
  ],
  'harness_shared.harness_snapshots_consolidated': ['snapshotsConsolidated.bySlug'],

  // ── Org-overlay tables (per-org-id, sometimes per-dept) ──────────
  'harness_shared.org_charter': ['orgCharter.byOrg'],
  'harness_shared.org_departments': ['orgDepartments.byOrg'],
  'harness_shared.org_projects': ['orgProjects.byOrg'],
  'harness_shared.org_inbox': ['orgInbox.byDept'],
  'harness_shared.org_outbox': ['orgOutbox.byDept'],
  'harness_shared.org_notes': ['orgNotes.byDept'],
  'harness_shared.org_decisions': ['orgDecisions.byDept'],

  // ── Insights / activity ledger (v5 addendum 3) ──────────────────
  // No camelCase query names yet — Insights tab + activity-feed reads
  // are P-073+ work. Mapped here in advance so trigger events have a
  // home the moment the consumers land; until then, the trigger fires
  // events with no matching subscriber (harmless no-op, dedupe handles).
  'harness_shared.contributor_usage_events': ['contributorUsageEvents.byHarness'],
  'harness_shared.insights_first_visit': ['insightsFirstVisit.byHarness'],
};

/**
 * Given a trigger-event name like `harness_shared.<table>.changed`,
 * return the camelCase query names that should ALSO be invalidated.
 * Returns an empty array for unknown tables (no bridge mapping).
 *
 * Pure function — caller emits the synthesized events.
 */
export function queryNamesForTriggerEvent(triggerEventName: string): readonly string[] {
  // Strip the `.changed` suffix.
  if (!triggerEventName.endsWith('.changed')) return [];
  const tableKey = triggerEventName.slice(0, -'.changed'.length);
  return TABLE_TO_QUERY_NAMES[tableKey] ?? [];
}

/** Test-only — enumerate every camelCase name covered by the bridge. */
export function allBridgedQueryNames(): string[] {
  const set = new Set<string>();
  for (const names of Object.values(TABLE_TO_QUERY_NAMES)) {
    for (const n of names) set.add(n);
  }
  return Array.from(set).sort();
}
