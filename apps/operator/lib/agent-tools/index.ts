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
import './operator/delegate';
import './architect/chat';
import './oracle/chat';
import './agent_chats/chat';
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
import './search/semantic';
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
import './harness/plan_reviews';
import './harness/phase_path';
import './harness/markdown_index';
import './harness/escalation';
import './harness/pending_reviews';
import './harness/health';
import './harness/list_features';
import './harness/membership';
import './cross_harness/docs_outline';
import './cross_harness/docs_get';
import './cross_harness/docs_search';
import './cross_harness/docs-resource-index';
import './cross_harness/docs-resource-section';
import './cross_harness/plans_list';
import './cross_harness/plans_get';
import './cross_harness/plans_search';
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
import './omp/sessions';
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
import './messages/dismiss';
import './agent_chats/list';
import './agent_chats/get';
import './agent_chats/create';
import './agent_chats/send_message';
import './agent_chats/archive';
import './dev/harnesses';
import './dev/telemetry';
import './dev/audit';
import './dev/sessions';
import './dev/activity';
import './dev/pg_health';
import './dev/pg_active_queries';
import './dev/pg_table_sizes';
import './dev/build_status';
import './dev/dogfood_substrate_status';
import './dev/ipc_echo';
import './dev/state_counter';
import './dev/event_emitter';
import './dev/processes';
import './dev/session_detail';
import './processes/kill';
import './dev/omp_session';

import './flags/list';
import './flags/get';
import './flags/set';

import './saved_prompts/list';

import './backup/snapshot_create';
import './backup/snapshot_list';
import './backup/restore';
import './backup/diff';
import './backup/promote';
import './backup/rollback';
import './backup/settings_get';
import './backup/settings_set';
import './docs/outline';
import './docs/get';
import './docs/search';
import './docs/resource-index';
import './docs/resource-section';

// SU-agent file-lock coordination — see su-agent-coordination-v3-2026-05-14.md
import './locks/acquire';
import './locks/release';
import './locks/heartbeat';
import './locks/cancel_wait';
import './locks/queue';
// Named-resource locks with drain semantics — plan named-resource-locks-drain
import './locks/acquire_resource';
import './locks/release_resource';
import './locks/heartbeat_resource';
import './locks/list';
import './locks/check_command';
// Blessed wrappers for destructive shared actions (requiresLock via guardResource)
import './dev/restart';
import './dev/service_health';
import './dev/rate_governor_status';
import './db/migrate';
import './db/check_drift';

// L1 agent coordination (identity & presence) — see
// agent-coordination-architecture-v2-2026-05-20.md
import './coordination/tools/whoami';
import './coordination/tools/presence';
import './coordination/tools/declare-intent';
// L3 channels — messages + acks + threads (Phase B core)
import './coordination/tools/send';
import './coordination/tools/inbox';
import './coordination/tools/ack';
import './coordination/tools/thread';
// L3 escalations + handoffs (Phase C)
import './coordination/tools/escalate';
import './coordination/tools/escalations';
import './coordination/tools/resolve';
import './coordination/tools/handoff';
import './coordination/tools/handoffs';
// Coordination substrate — topics (subscribe→inject taxonomy, D-004)
import './coordination/tools/topics-list';
import './coordination/tools/topics-create';
import './coordination/tools/topics-subscribe';
import './coordination/tools/topics-unsubscribe';
import './coordination/tools/topics-merge';
// Cross-object tagging + topic-index feed (integration-adoption Capstone P1).
import './coordination/tools/topics-tag';
import './coordination/tools/topics-feed';

// Conversations — questions + discussions on the substrate (the first consumer:
// coordination-conversations-2026-06-03). coord:ask is knowledge-first.
import './coordination/tools/ask';
import './coordination/tools/conversations-post';
import './coordination/tools/conversations-answer';
import './coordination/tools/conversations-resolve';
import './coordination/tools/conversations-join';
import './coordination/tools/conversations-list';
import './coordination/tools/conversations-get';

// Engineer issues — the agent-facing issue surface on the coordination substrate
// (engineer-issues-2026-06-03 D-003). Subscribable/Taggable/Threadable/Claimable/Lifecycle.
import './issues/create';
import './issues/list';
import './issues/get';
import './issues/update';
import './issues/comment';
import './issues/claim';
import './issues/release';
import './issues/close';
import './issues/tag';
import './issues/subscribe';
import './issues/search';
import './issues/link';
import './issues/promote';

import './coordination/tools/watermark';
import './coordination/tools/watermark-set';
import './coordination/tools/plan-events';
// Plan → harness on-ramp (Phase E v0.5 — preview only)
import './coordination/tools/promote';
// Completion-time for_each: a producing feature publishes its discovered items
// (P-043 / D-019) → generative children minted blocked_by it.
import './generators/publish';

// SU-agent plan tracking — see agent-plan-tracking-2026-05-20.md
import './plans/list';
import './plans/get';
import './plans/items';
import './plans/attention';
import './plans/search';
import './plans/lint';
import './plans/export';
import './plans/new';
import './plans/set-status';
import './plans/set-importance';
import './plans/set-now';
import './plans/add-decision';
import './plans/add-item';
// Phase 5 — whole-document write (CAS) + legacy-frontmatter conversion.
import './plans/set-content';
import './plans/set-content-chunk';
import './plans/set-frontmatter';
// plan-level lifecycle flip (draft→ready approve / demote / ship / reject).
import './plans/set-plan-status';
// Plan history/audit is the PG plan_revisions spine (plans:revisions /
// plans:revision-diff) — the git-history surface was removed when plans went
// PG-canonical (plans-pg-canonical-migration-2026-06-03 D-003).
import './plans/revisions-list';
import './plans/revisions-backfill';
import './plans/revision-transcript';
import './plans/revision-summary';
import './plans/revision-diff';
import './plans/run-transcript';
// plan-agent-launch — launch / resume an autonomous agent on a plan.
import './plans/start';
import './plans/pause';
import './plans/set-priority';
import './plans/launch';
import './plans/resume';
import './plans/runs-list';
import './plans/run-status';
// plan-feature-pipeline-unification P-019: promote:plan block handler.
import './architect/plan-block-handler';

// substrate-revocation-v1 Task 3 — self-revocation of own device keys.
import './substrate/revoke-self-device';

// substrate-revocation-v2 Component B — owner-revocation of another contributor.
import './substrate/revoke-contributor';
