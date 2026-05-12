/**
 * Operator-side first-party agent tools.
 *
 * Tools that live operator-side (rather than in @papercusp/agent-mcp's
 * `src/tools/`) because they depend on operator-app-only helpers
 * (workspace registry, audit_log readers, scan-history libs, voice
 * preferences, etc.) that the standalone agent-mcp package cannot
 * import.
 *
 * Each tool calls `defineTool({ requirePrincipal: false, roles, ... })`
 * (the D1a flag) and self-registers into the unified projection
 * registry — same dispatch path as package-side tools and plugin tools.
 *
 * Importing this file once at app startup is enough to register the
 * full set; the catch-all route at app/api/agent-tools/[...path]/route.ts
 * does that side-effect import.
 *
 * Add a tool by dropping a file under this directory and adding a
 * side-effect import below.
 */

import './operator/stats';
import './operator/last_scan';
import './operator/scan';
import './operator/converse';
import './architect/chat';
import './operator/scans_list';
import './operator/audit';
import './operator/nudge';
import './operator/dismissed';
import './operator/standing_approvals_list';
import './operator/standing_approvals_decide';
import './operator/standing_approval_mark_shown';
import './operator/scanner_reset';
import './operator/voice_utterance_log';
import './operator/voice_debug';
import './operator/voice_prefs';
import './operator/conv_voice';
import './operator/voice_spend_summary';
import './roles/list';
import './roles/get';
import './roles/firing_on';
import './roles/known';
import './hooks/known';
import './agent_tools/list';
import './ui/list_clients';
import './ui/get_state';
import './ui/dispatch';
import './chat/ask_choice';
import './search/fulltext';
import './memory/remember';
import './memory/search';
import './memory/list';
import './memory/forget';
import './memory/update';
import './autoloop/status';
import './autoloop/control';
import './operator/dedup_check';
import './operator/parse_suggestions';
import './wiki/backlinks';
import './experts/trigger_for';
import './harness/plan_reviews';
import './harness/phase_path';
import './harness/markdown_index';
import './harness/escalation';
import './harness/pending_reviews';
import './harness/health';
import './harness/list_features';
import './operator/actions_recent';
import './operator/notifications_recent';
import './snapshots/list';
import './snapshots/get';
import './operator/preview_prompt';
import './operator/scanner_bootstrap';
import './operator/decisions';
import './delegates/list';
import './delegates/inbox';
import './agents/list';
import './operator/budget';
import './operator/paused';
import './operator/trigger_state';
import './operator/preferences';
import './omp/config';
import './operator/multi_workspace';
import './operator/credentials_status';
import './projects/list';
import './projects/get';
import './projects/spec_revisions';
import './projects/spec_revision';
import './operator/notes';
import './cross_harness/inbox';
import './cross_harness/outbox';
import './cross_harness/supervisor_notes';
import './cross_harness/recent_activity';
import './plugins/runtime_status';
import './plugins/invoke_action';
import './plugins/fire_event';
import './tasks/create';
import './messages/send';
import './messages/feature_send';
import './messages/feature_dismiss';
import './agent_chats/list';
import './agent_chats/get';
import './agent_chats/create';
import './agent_chats/send_message';
import './agent_chats/archive';
import './experts/list';
import './experts/get';
import './experts/spec_get';
import './experts/feedback_list';
import './experts/roles';
import './experts/chat_agents';
import './dev/harnesses';
import './dev/telemetry';
import './dev/audit';
import './dev/sessions';
import './dev/activity';
import './dev/pg_health';
import './dev/pg_active_queries';
import './dev/pg_table_sizes';
import './dev/build_status';
import './dev/processes';
import './dev/session_detail';
import './processes/kill';
import './dev/omp_session';

import './backup/snapshot_create';
import './backup/snapshot_list';
import './backup/restore';
import './backup/diff';
import './backup/promote';
import './backup/rollback';
import './backup/settings_get';
import './backup/settings_set';
