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
import './operator/converse';
import './operator/delegate';
import './architect/chat';
import './oracle/chat';
import './agent_chats/chat';
import './operator/audit';
import './operator/nudge';
import './operator/standing_approvals_list';
import './operator/standing_approvals_decide';
import './operator/standing_approval_mark_shown';
import './operator/voice_utterance_log';
import './operator/voice_debug';
import './operator/voice_prefs';
import './operator/conv_voice';
import './operator/voice_spend_summary';
// P2P voice channels (holepunch-voice-channels-2026-06-05 P-006/P-007/P-011):
import './voice/channels';
import './voice/join';
import './voice/leave';
import './voice/status';
import './voice/agent';
import './roles/list';
import './roles/get';
import './roles/firing_on';
import './roles/known';
import './hooks/known';
import './agent_tools/list';
import './ui/list_clients';
import './ui/get_state';
import './ui/dispatch';
import './tui/dispatch';
import './activity/report';
import './activity/recent';
import './curation/feed';
// autoloop-pot-operator-rebuild-2026-06-05 P0 — the Pot operator's self-declared
// wake surface (declare-wake / wake / status):
import './pot/declare_wake';
import './pot/wake';
import './pot/status';
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
import './operator/decisions';
import './agents/list';
import './operator/budget';
import './operator/paused';
import './operator/trigger_state';
import './operator/preferences';
import './operator/rate_limit_config';
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
import './plugins/tui_panes';
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
// coord-lifecycle-automation-2026-06-04 D-006 — the re-runnable corpus categorizer
import './dev/coord_categorize';
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

// Per-harness project docs — typed, drift-tracked (harness-docs-integration-2026-06-05)
import './harness_docs/record';
import './harness_docs/list';
import './harness_docs/anchor';
import './harness_docs/verify';
import './harness_docs/set_overlay';
import './harness_docs/regenerate';
import './harness_docs/ingest';

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
// Multi-granularity intention locks (Gray IS/IX/S/SIX/X) — locks-correctness-hardening D-005
import './locks/acquire_granular';
import './locks/release_granular';
import './locks/list';
import './locks/check_command';
// Blessed wrappers for destructive shared actions (requiresLock via guardResource)
import './dev/restart';
import './dev/service_health';
import './dev/rate_governor_status';
import './db/migrate';
import './db/check_drift';
import './db/next_migration';

// L1 agent coordination (identity & presence) — see
// agent-coordination-architecture-v2-2026-05-20.md
import './coordination/tools/whoami';
import './coordination/tools/presence';
import './coordination/tools/declare-intent';
// L3 channels — messages + acks + threads (Phase B core)
import './coordination/tools/send';
// Open a work-item-scoped conversation with an agent — the inbox "Message owner"
// action (inbox-tiering-and-message-agent-2026-06-05, D-004).
import './coordination/tools/message-agent';
// Operator inbox-triage PASS — re-tier an attention item, audit the why
// (inbox-tiering-and-message-agent-2026-06-05, D-006).
import './inbox/triage';
// Lifecycle auto-emission target (coord-lifecycle-automation-2026-06-04)
import './coordination/tools/emit';
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
import './coordination/tools/conversations-promote';

// Self-improvement loop — capture + triage + the resolve back-edge
// (papercusp-self-improvement-loop-2026-06-04 Phase 1 + 2;
// close-the-self-improvement-loop-2026-06-05 D-001). Captured items are
// engineer issues tagged `papercusp-improvement`; the digest triages them;
// resolve closes the loop (a verified fix leaves the queue).
import './improvements/capture';
import './improvements/digest';
import './improvements/resolve';

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

// Work items — the UNIFIED work-item surface (unify-work-items-2026-06-04 D-007).
// One `work_item` type discriminated by `kind` (feature|research-task|chunk|bug|change);
// a facade over the two per-kind tables (harness_features_consolidated + engineer_issues).
// WI-NNN ids (D-008). Coexists with features:*/issues:* during the migration (their
// retirement is the deferred, coordinated follow-on).
import './work_items/create';
import './work_items/get';
import './work_items/list';
import './work_items/search';
import './work_items/set_state';
// Structured completion → auto-emit (coord-lifecycle-automation-2026-06-04 D-004)
import './work_items/complete';
import './work_items/claim';
import './work_items/release';
import './work_items/link';
import './work_items/tag';
import './work_items/subscribe';
import './work_items/comment';
import './work_items/promote';
// Blackboard tuple-space primitives (fleet-as-supervised-blackboard D-004): claim_next
// is the associative `in` (self-select / work-steal via SKIP LOCKED); observe is `rd`.
import './work_items/claim_next';
import './work_items/observe';

// Fleet — structured concurrency / supervision over the spawn tree
// (fleet-as-supervised-blackboard-2026-06-04). fleet:cancel is the transitive
// cancellation primitive (D-003); fleet:tree reads the durable nursery structure.
import './fleet/cancel';
import './fleet/tree';
import './fleet/supervise';
import './fleet/admit';
import './fleet/governor';
// fleet:spawn — the operator→agent launch verb over the same durable nursery
// (Brief 4, agent-briefs-2026-06-05): chat <spawn> tags, the operator brain's
// tool call, and the admin HTTP trigger all land in spawnAgentInHarness.
import './fleet/spawn';
// fleet:assignments — the canonical "who's on what" state query over the
// fleet_assignment view (state-not-chat-fleet-state-2026-06-05 D-002).
import './fleet/assignments';

// Coordination ops as blueprint primitives — the dual-surface decision tools
// (coordination-ops-as-blueprint-primitives-2026-06-04 D-001). coord:vote /
// coord:deliberate / coord:ask run the vote/deliberate coord-op programs;
// coord:thread-post is the spawned voter's cast surface. One impl, two surfaces
// (the same ops the program spine executor invokes).
import '../coord-ops/agent-tools';

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
// Targeted in-place edit (old_string → new_string), the surgical complement.
import './plans/edit';
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

// plan-item-assignment-claim-liveness-2026-06-04 — per-plan-item ASSIGNMENT (durable,
// federated Claimable scalar) + leased CLAIM (authority-mediated, rides Track B) +
// LIVENESS (LOCAL availability vs SHARED activity). assign/claim/heartbeat/my_items/…
import './plan-items';

// substrate-revocation-v1 Task 3 — self-revocation of own device keys.
import './substrate/revoke-self-device';

// substrate-revocation-v2 Component B — owner-revocation of another contributor.
import './substrate/revoke-contributor';

// harness-blueprint-orchestration-2026-06-03 P-007 (B1) — agent-authorable
// Harness Blueprints: validate / create / extend (pure authoring → canonical
// YAML), and harness:create (scaffold a harness, instantiate a blueprint).
import './blueprint/validate';
import './blueprint/create';
import './blueprint/extend';
// autoloop-pot-operator-rebuild-2026-06-05 P-003 (P1) — blueprint:catalog, the
// discovery half of the Pot's superpower (catalog → choose → harness:create).
import './blueprint/catalog';
import './harness/create';
// P-009 (B3) — kind #1 harness creation: deterministically generate an
// `extends: coding` blueprint from an existing repo, then compose harness:create.
import './harness/generate_from_repo';
// harness-blueprint-orchestration-2026-06-03 P-012 (Phase D) — the gym is a
// blueprint (D-022); its judge/proposer roles re-use lib/gym primitives via these
// tools: gym:judge (frozen Opus judge, target's rubric) + gym:signals (the
// deterministic un-gameable guardrails resolved by name).
import './gym/judge';
import './gym/signals';

// event-reaction-system-2026-06-04 D-010 — the inspectable reactive-graph tool
// (what fires what + recent fired reactions with their cause-chain).
import './events/graph';

// await-event-primitive-2026-06-05 — the universal subscription primitive:
// register a one-shot wake on an event key (events:await), fire a key
// (events:emit), inspect/cancel (events:status / events:cancel). Delivery is
// liveness-adaptive (pty-inject / session-resume / inbox) + durable
// (harness_shared.event_awaits + event_wake_deliveries, migration 163).
import './events/await';
import './events/emit';
import './events/cancel';
import './events/status';

// event-reaction-system-2026-06-04 — the declarative "when tool X settles, fire
// tool Y" layer over the dispatcher. Importing this registers the built-in
// Events-file rules and wires PROJECTED_DEPS.postInvoke to the reaction engine.
// (Loaded last; rule→tool lookup is at fire-time, so order is not load-bearing.)
import '../events';

// coord-lifecycle-automation-2026-06-04 — the lifecycle auto-emit layer over the
// event engine. Loaded AFTER '../events' (the registry must exist) and after all
// tools above (so the `emits` collector is complete):
//   • lifecycle-rules: the central claim/intent/finding rules (registerReactionRule)
//   • register-emit-rules: desugars every tool's `emits:` (e.g. work_items:complete
//     → completion) into the same registry.
import '../coord-lifecycle/lifecycle-rules';
import '../coord-lifecycle/register-emit-rules';

// docs-and-memory-as-projections-2026-06-05 P0 — the topic-keyed RATIONALE
// projection (@papercusp/projection-index): plan decisions + work-items + insights,
// indexed by topic and kept fresh by the event engine. `rationale:feed` is the
// agent-facing read; `rationale:reproject` is the maintenance verb the rules fire.
// Loaded after '../events' (the registry must exist) — rule→tool lookup is at
// fire-time so relative order with the tools is not load-bearing.
import './rationale/feed';
import './rationale/reproject';
import '../rationale/rules';

// autoloop-pot-operator-rebuild-2026-06-05 P0 — re-project the Pot's persisted
// event-wake subscriptions (harness_shared.pot_wake) into live reaction rules.
// The registry is in-memory, so this runs on every host boot. Loaded after
// '../events' (the registry must exist). Fail-soft: a missing table
// (pre-migration-158) or a PG hiccup must never block boot.
import { registerPotWakeRules } from '../pot/wake';
void registerPotWakeRules().catch(() => {});

// await-event-primitive-2026-06-05 — the background sweeper (stuck-delivery
// recovery, await timeouts, parked→resume conversion). Lazy/unref'd interval;
// all state in PG; fail-soft (a missing table pre-migration-163 must never
// block boot — each sweep catches its own errors).
import { startAwaitSweeper } from '../events/await/engine';
try {
  startAwaitSweeper();
} catch {
  /* never block boot */
}
