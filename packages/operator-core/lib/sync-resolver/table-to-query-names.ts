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
  // The harness registry is one JSONB row per workspace (mig 025); its
  // trigger (mig 222) is what defeats the bus's 90s source-side dedupe for
  // back-to-back registry changes (EI-206 — a create followed by a delete
  // inside the window left open harness lists stale).
  // network.board: a hive create/dissolve changes its tier 1–2 rows.
  'harness_shared.harness_registry': ['harnessProjects.lite', 'network.board'],
  // ── Per-harness HYPERBEE-bucket tables ────────────────────────────
  'harness_shared.harness_text_artifacts': ['harnessTextArtifact.byHarness'],
  'harness_shared.harness_project_files': ['harnessProjectFiles.byHarness'],
  'harness_shared.harness_skills': ['harnessSkills.byHarness'],
  'harness_shared.harness_decisions': ['harnessDecisions.byHarness'],
  'harness_shared.harness_lanes': ['harnessLanes.byHarness'],
  'harness_shared.harness_escalations': ['harnessEscalations.byHarness'],
  'harness_shared.harness_checkpoints': ['harnessCheckpoints.byHarness'],
  'harness_shared.harness_feature_prs': ['featurePrs.byHarness'],
  'harness_shared.harness_status': ['harnessStatus.byHarness'],
  'harness_shared.harness_tests': ['harnessTests.byHarness'],
  'harness_shared.harness_archives': ['harnessArchives.byHarness'],
  'harness_shared.harness_hook_logs': ['harnessHookLogs.byHarness'],
  'harness_shared.harness_smoke_test': ['harnessSmokeTest.byHarness'],
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
  // plan_runs feeds BOTH the Agents-tab flat list (plans.runs, { slug }) and the
  // Runs-tab history+rollup (plans.runHistory, { planSlug }) — a row write busts both.
  'harness_shared.plan_runs': ['plans.runs', 'plans.runHistory'],
  'harness_shared.harness_brainstorm': ['harnessBrainstorm.byHarness'],
  'harness_shared.pending_reviews': ['pendingReviews.byHarness'],
  'harness_shared.harness_pending_issues': ['harnessPendingIssues.byHarness'],
  'harness_shared.harness_screenshots': ['harnessScreenshots.byHarness'],
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
  // workItems.byHarness reads BOTH families (features_consolidated + engineer_issues)
  // plus spawned_agents for spine-position — all three tables re-fire it.
  'harness_shared.harness_features_consolidated': [
    'featuresConsolidated.bySlug',
    'featuresConsolidated.byPlanSlug',
    'workItems.byHarness',
  ],
  'harness_shared.harness_issues_consolidated': ['issuesConsolidated.bySlug'],
  // engineer_issues = the issue-family store of the unified work_items surface
  // (trigger added in migration 215).
  'harness_shared.engineer_issues': ['workItems.byHarness'],
  'harness_shared.agent_runs_consolidated': [
    'agentRunsConsolidated.bySlug',
    'agentRunsConsolidated.recent',
  ],
  // The agentRunsConsolidated.* rows JOIN spawned_agents for the run outcome
  // (spawnStatus/exitCode/errorMessage/sessionId — adv-harness-tab-migration
  // P-023), so an outcome flip must re-fire those queries too. The trigger is
  // column-targeted (migration 213) so heartbeat writes don't spam this.
  // workItems.byHarness joins the latest spawn per feature (spine position).
  'harness_shared.spawned_agents': [
    'agentRunsConsolidated.bySlug',
    'agentRunsConsolidated.recent',
    'workItems.byHarness',
    'fleetAssignments.byHarness',
    // hiveRoster.byHive (presence-v2 P-006 fold) reads spawned_agents for the
    // Tier-1 model tier; an outcome/model flip re-fires it too. byHarness (P-007,
    // the MemberWorkPanel repoint) is the same fold keyed by harness→hive.
    'hiveRoster.byHive',
    'hiveRoster.byHarness',
  ],
  // fleetAssignments.byHarness (progress-tab-agents-convergence P-001) reads the
  // fleet_assignment view = presence + plan-item claims + work-item claims.
  // coord_presence fires on heartbeats too — the 90s (name,args) dedupe window
  // bounds the refetch rate; claim flips are what actually matter.
  // network.board reads live-agent counts off the same fleet view, so a
  // presence/claim flip refreshes its tier 1–3 liveAgents too (90s dedupe bounds
  // the heartbeat churn; grant/ask/beacon changes ride explicit
  // notifySyncInvalidate('network.board', {}) from their writers + the 60s
  // consumer safety-net).
  // dev.coordPresence is the live-agents roster (the Mod+U PresenceRail +
  // /coord dashboard read it): a heartbeat/intent/claim write must push the
  // roster too, not just the fleet view (shared-hive-collaboration P-006 — the
  // rail was a 30s poll before; SSE push replaces it).
  'harness_shared.coord_presence': [
    'fleetAssignments.byHarness',
    'network.board',
    'dev.coordPresence',
    // hiveRoster.byHive (presence-v2 P-006) folds coord_presence + the fleet
    // work-detail; a presence/intent/claim/last_active write refreshes it too.
    // byHarness (P-007) is the same fold keyed by harness→hive.
    'hiveRoster.byHive',
    'hiveRoster.byHarness',
    // dev.assignableMembers (P-016) unions live presence + offline members — a
    // presence flip moves a person between the online/offline groups in the picker.
    'dev.assignableMembers',
  ],
  // hive_members (admission) is the offline half of the @-assign picker — a new
  // admitted member becomes assignable the moment they're admitted (P-016).
  'harness_shared.hive_members': ['dev.assignableMembers'],
  // hive_settings backs the owner-steering:* keys (queen-steering-panel B-01/C-1) —
  // a steering write refreshes the 👑 Queen tab's hive.steering query. The set tool
  // also fires notifySyncInvalidate explicitly; this covers a FEDERATED steering
  // write arriving from a peer Swarm (the keys federate via the capture trigger).
  'harness_shared.hive_settings': ['hive.steering'],
  'harness_shared.feature_claims': ['fleetAssignments.byHarness', 'network.board', 'hiveRoster.byHive', 'hiveRoster.byHarness'],
  'harness_shared.claim_audit': ['fleetAssignments.byHarness', 'hiveRoster.byHive', 'hiveRoster.byHarness'],
  // dev.coordFeed is the live coordination firehose (the PresenceRail Activity
  // tab + the /adv Conversations Feed). The emit_change_notify trigger on
  // coord_event_log is filtered to ORIGINAL rows (body->>'notify_kind' IS NULL)
  // so the per-subscriber fan-out delivery copies don't each fire — the busiest
  // coord table stays cheap (shared-hive-collaboration P-006). The (name,args)
  // dedupe bounds burst refetches.
  'harness_shared.coord_event_log': ['dev.coordFeed'],
  'harness_shared.harness_snapshots_consolidated': ['snapshotsConsolidated.bySlug'],

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
