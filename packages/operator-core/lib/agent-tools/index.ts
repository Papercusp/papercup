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

// Configure the pre-prompt registry (token-efficient-agent-io P-002) before any
// tool dispatch — a pure side-effect that installs the curated list consulted by
// the read serializer + write shim + prompt legend.
import './pre-prompt-registry-config';

// code-execution-tool-orchestration (B-CX-2A): the code:run code-mode tool.
import './code/run';

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
import './voice/transcript';
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
import './curation/change-feed';
// hive-creative-ideation-2026-06-08 P-003 (B1) — the "state of the Hive" corpus digest (Scout loop substrate):
import './curation/state-of-hive';
// p2p-hive-directory-2026-06-06 P-005 — browse the discovered P2P hive directory:
import './discovery/hives';
// p2p-hive-directory-2026-06-06 P-004 — create/edit a hive's directory listing:
import './discovery/set_hive';
// autoloop-pot-operator-rebuild-2026-06-05 P0 — the Pot operator's self-declared
// wake surface (declare-wake / wake / status):
import './hive/declare_wake';
import './hive/wake';
import './hive/status';
// queen-brief-cache B-06 / P-010 — the Queen's per-wake efficiency read surface:
import './hive/queen_efficiency';
// queen-autonomous-execution B-08 — the Queen's plan-aware placement survey:
import './hive/survey';
import './hive/start';
import './hive/pause';
// queen-steering-panel-2026-06-15 B-01 — owner steering controls for the Queen
// (focus directive / eligible plans / new-work pause); hive_settings-backed (C-1).
import './hive/set_steering';
import './hive/get_steering';
// overwatch-role-2026-06-15 B-07 — the autonomous system-health supervisor's
// control surface (start/pause its loop), sibling to hive:start/pause:
import './overwatch/start';
import './overwatch/pause';
// overwatch-role-2026-06-15 B-04 — the overwatch's declare-next-wake verb (its own
// channel, gated coord:write so it can't touch the Queen's hive:declare-wake):
import './overwatch/declare_wake';
// overwatch-role-2026-06-15 B-04 — the wake-loop module: registers the
// `system:overwatch-launch` action + the B-07 wake-bridge waker at boot (so an
// `overwatch:start` in THIS process finds a wired waker, not the fail-soft no-op).
import '../overwatch/loop';
// hive-tool-namespace-2026-06-08 — local hive lifecycle (read + create/dissolve/update):
import './hive/list';
import './hive/get';
import './hive/create';
// EI-1582 — the agent-facing producer for hive_slug (wire a harness in as a member):
import './hive/add_member';
// hive-from-github-url-2026-06-11 P-006 — create a Hive FROM a GitHub URL:
import './hive/create_from_repo';
// per-hive-learning-loops-2026-06-14 P-071 — opt INTO platform mode ("Papercusp inside Papercusp"):
import './platform/enable';
// per-hive-learning-loops-2026-06-14 P-072 — send a local improvement UPSTREAM (fork-PR + Comb learning-pack):
import './platform/contribute';
// pr-system-completion-dogfood PR-5 (D-3) — GC abandoned contribution forks (KEEP-on-merge + stale-fork sweep):
import './platform/fork_gc';
// pr-system-completion-dogfood PR-5 (item 2) — assert the fork→PR dogfood loop round-tripped (WI shipped + linked PR):
import './platform/dogfood_verify';
import './hive/dissolve';
// shared-hive-hardening-2026-06-13 P-012 — a joiner cleanly LEAVES a shared hive:
import './hive/leave';
import './hive/update';
// cross-hive-boundary-2026-06-08 P-002 — owner cross-Hive capability grants:
import './hive/cross_grant';
// hive-network-surface-2026-06-11 P-005 (B-07) — owner beacon-publish consent:
import './hive/beacon_consent';
// hive-network-surface-2026-06-11 P-003 (B-04) — front-door cross-Hive ask tools:
import './hive/ask';
import './hive/request_work';
import './hive/asks';
// shared-hive-owner-enforcement-2026-06-19 (EN-3) — the claimed owner's control surface:
// P-MEMBER approval-mode (membership_pending / membership_decide) + P-MOD report→queue→
// takedown / ban (report / moderation_queue / moderation_resolve / takedown / ban_member).
import './hive/membership_pending';
import './hive/membership_decide';
import './hive/report';
import './hive/moderation_queue';
import './hive/moderation_resolve';
import './hive/takedown';
import './hive/ban_member';
// hive-network-surface-2026-06-11 P-006 (B-08) — the aggregate Network board
// (C-3 rows) over the capability-tier ladder; the agent twin of the
// `network.board` named sync query that backs the dock Network tab:
import './network/board';
import './chat/ask_choice';
// queen-autonomous-execution B-17/P-043 — install the B-12 decider-backed classifier
// into the B-10 agent-question gate (behavior-neutral until owner P-092 arming):
import './coordination/wire-agent-question-gate';
import './search/fulltext';
import './search/semantic';
import './memory/remember';
import './memory/search';
import './memory/list';
// learning-packs-2026-06-11 P-009/P-012/P-013 — hive learning-pack management
// (catalog/install-with-review/uninstall/mute/upgrade/conflict-sweep):
import './learning_packs/list';
import './learning_packs/install';
import './learning_packs/uninstall';
import './learning_packs/set_enabled';
import './learning_packs/upgrade';
import './learning_packs/sweep';
import './learning_packs/publish';
// consume-edges P-032 (B-11) — the fleet→pack candidate review queue:
import './learning_packs/candidates';
import './learning_packs/decide_candidate';
import './memory/forget';
import './memory/update';
import './autoloop/status';
import './autoloop/control';
// loop-routines-interval-recurrence-2026-06-20 (B-LOOP-5 / P-008) — the engine-managed
// LOOP surface: arm a tracked warm-wake loop on your own session (the /loop replacement),
// end it, inspect it. Gated by FLAGS.LOOPS (loop:arm); loop:end/status are always available.
import './loop/arm';
import './loop/end';
import './loop/status';
import './operator/dedup_check';
import './wiki/backlinks';
import './harness/phase_path';
import './harness/markdown_index';
import './harness/escalation';
import './harness/pending_reviews';
import './harness/health';
import './harness/list_features';
import './harness/membership';
// Cloud deployment (cloud-deployment-layer-2026-06-06 P-012/P-016)
import './deploy/deploy';
import './deploy/hive';
// Queen account pool + auto-scale-out (cloud-deployment-layer-2026-06-06 Phase 7 P-019/P-020/P-021)
import './accounts/accounts';
// accounts-pool-tab-2026-06-15 P-002 — the experimental one-click OAuth account-link tools.
import './accounts/link';
// accounts-pool-tab-2026-06-15 P-004 — the owner's session-now account override tools.
import './accounts/session-override';
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
import './instance/capture';
import './instance/boot';
import './instance/clone';
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
// git-sync-dx-hardening-2026-06-17 P-002 — "where is my change / is it live?" probe
import './dev/pipeline_position';
// coord-lifecycle-automation-2026-06-04 D-006 — the re-runnable corpus categorizer
import './dev/coord_categorize';
import './dev/dogfood_substrate_status';
import './dev/ipc_echo';
import './dev/state_counter';
import './dev/event_emitter';
import './dev/processes';
import './dev/session_detail';
import './processes/kill';
import './turn/interrupt';
import './dev/omp_session';

import './flags/list';
import './flags/get';
import './flags/set';

// Queen autonomy policy — per-category risk ceilings (queen-autonomy-policy B-03).
import './autonomy/get';
import './autonomy/set';
// The Queen autonomy decider gate (queen-autonomy-policy B-12 / P-070).
import './autonomy/decide';
// The Queen decision-disposition log (queen-autonomy-policy B-13 / P-111).
import './autonomy/record_disposition';
// The auto-revert tripwire + graduation surface (queen-autonomy-policy B-16 /
// P-080-082): the recent-auto-decisions feed, one-click undo, graduation status.
import './autonomy/tripwire_list';
import './autonomy/tripwire_revert';
import './autonomy/graduation_status';

// The owner's LOCAL trusted-GitHub-user list (shared-hive-trust-admission P-009):
// manage who may auto-run verified remote work.
import './trust/list';
import './trust/add';
import './trust/remove';

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
// Fleet capability surface (agent-capability-confinement-2026-06-13, B-05):
// gated defineTool re-exposure of native capabilities. bash is a thin shell
// wrapper with output-spill + async/background jobs; write/edit acquire the
// per-path file lock inside dispatch (P-013, file-lock-guard).
import './capability/bash';
import './capability/bash_output';
import './capability/bash_kill';
import './capability/read';
import './capability/write';
import './capability/edit';
import './capability/git';
import './capability/fetch';
// Read-only verification exec (EI-524 / P-035): typecheck/test via fixed commands,
// the sanctioned inspect path for confined bees (capability:bash is envelope-gated).
import './capability/inspect';
// Bee-operated SANDBOX desktop (computer-tool-plan): screenshot/click/type via
// xdotool against a LEASED Xvfb display (never host :0). The handler runs in the
// OPERATOR process, so it resolves the display per-caller from ctx.harnessSlug → the
// in-process hive lease (open-Q#2), env fallback for direct/frame. Dormant (errors
// "no desktop leased") until the hive is equipped via computer:provision_desktop.
import './computer/computer';
// Explicit per-hive desktop lease lifecycle (computer-tool-plan Gap A): the
// operator/Queen surface that stands up / tears down / lists the sandbox desktops
// capability:computer resolves via ctx.harnessSlug.
import './computer/provision-desktop';
import './computer/release-desktop';
import './computer/list-desktops';
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
// Per-agent wake mode + staged-wake review — the pause/edit gate's control surface
// (hive-agent-tabs-psu-tui-2026-06-09 P-008/P-009 / D-005). The stage-vs-fire
// behavior is in wakeRecipients (P-007, gated on HIVE_AGENT_TABS); these expose it.
import './coordination/tools/wake-mode';
import './coordination/tools/wake-queue';
// One cheap combined fleet glance (wake gate + staged wakes + bees + governor +
// contextual tips) — the high-frequency statusline/TUI read.
import './coordination/tools/glance';
// Dispatch a slash-exposed tool command AT another agent via deliver-and-wake
// (WI-126) — the cross-session leg of slash exposure; the wake-mode gate stages
// dispatched commands for manual-mode targets.
import './slash/dispatch';
// L3 channels — messages + acks + threads (Phase B core)
import './coordination/tools/send';
// Open a work-item-scoped conversation with an agent — the inbox "Message owner"
// action (inbox-tiering-and-message-agent-2026-06-05, D-004).
import './coordination/tools/message-agent';
// Idle end-of-turn wake scaffold — register a standing wake watch on your own
// inbox-wake key so a later coord:send {wake:true} re-invokes you
// (local-hive-orchestration-2026-06-06 P-041).
import './coordination/tools/await-inbox';
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
// The whole-fleet coordination firehose — every envelope across every channel
// (high-tier audit:read; backs the /adv Conversations "Feed" view).
import './coordination/tools/feed';
// Spawn admission — the brain decides worth-it (unify-agent-spawn-chokepoint P-005/P-006)
import './spawn/request';
import './spawn/approve';
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
import './improvements/triage';
import './improvements/resolve';
import './improvements/watchdog-status';
import './improvements/keyless-digest';
import './improvements/learning-loops';

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

// Rubrics — the shared-standards store (rubric-driven-observations-2026-06-20 P-002).
// A rubric = the standard for a system characteristic (model + method + rating scale +
// drift markers + per-characteristic criteria); agents grade STRUCTURED OBSERVATIONS
// against an active rubric. Authorship D-001: any agent proposes, the Queen ratifies.
import './rubrics/list';
import './rubrics/get';
import './rubrics/search';
import './rubrics/propose';
import './rubrics/ratify';
// rubrics:trend — the qualitative health TREND of a rubric (per-criterion rating
// time-series + direction over the Overwatch scorecards; P-010).
import './rubrics/trend';
// scorecards: the READ side of the every-turn Overwatch scorecard — read
// rubric-graded observations back (filter rubricRef/sourceHive/since), surfacing
// nKeys/missingKeys for completeness. The linchpin for monitoring-the-monitor
// (plan-templates-and-rubric-v2-2026-06-20 P-013).
import './scorecards/list';
// scorecards:freshness — the emission-freshness check (P-014b): has the Overwatch emitted a
// COMPLETE scorecard since the last wake, or silently skipped (stale) / truncated (partial-only)?
import './scorecards/freshness';

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
// Per-assignee ordered work-list (local-hive-orchestration P-020 / D-004 / D-008):
// reorder moves an item within its assignee's queue; writer (bee|queen) = the
// propose/dispose audit, gated by the existing automation tier (work_items:write → medium).
import './work_items/reorder';
import './work_items/link';
import './work_items/tag';
import './work_items/subscribe';
import './work_items/comment';
import './work_items/checkpoint';
import './work_items/amend';
import './work_items/expand';
import './work_items/promote';
// Blackboard tuple-space primitives (fleet-as-supervised-blackboard D-004): claim_next
// is the associative `in` (self-select / work-steal via SKIP LOCKED); observe is `rd`.
import './work_items/claim_next';
import './work_items/observe';
// The Queen's co-location lever (hive-coordination-model P-002): stamp a work-item's
// swarm_affinity so tightly-coupled work co-locates on one Swarm; honored by claim_next
// under the per-Hive claim lease.
import './work_items/co_locate';
// The Queen's steer-don't-dispatch lever (autoloop-pot-operator-rebuild B7 /
// decentralized-dispatch-scaling D-003/D-004, P-009/P-010): set a feature-family item's
// BACKLOG priority (feature_order) — the order claim_next pulls against — reading the
// rolled-up change feed. Distinct from work_items:reorder (per-bee claimed work-list).
import './work_items/set_priority';
// Register the work-item claim AUTHORITY ops (cross-Swarm claim RPC receiving side) —
// decentralized-dispatch-scaling P-004 / D-002. Side-effecting; mirrors plan-items.
import './work_items/register-claim-authority-ops';
// Register the work-item REPLICA authority ops (cross-Swarm BOINC redundancy RPC
// receiving side) — EI-266. Side-effecting; mirrors the claim ops above.
import './work_items/register-replica-authority-ops';
// Wire the FILE-LOCK authority (fed-reanchor P-060 cutover 2): the domain→harness→Hive
// resolvers + the authority-side store adapter, so locks:acquire/release serialize at the
// Hive authority cross-machine. Side-effecting; dormant passthrough at single-hive (N=1).
import './locks/file-lock-authority-wiring';
// BOINC-style redundancy for HIGH-STAKES items (decentralized-dispatch-scaling P-014):
// run one item independently on N Swarms then judge + adopt the best (reuse gym:judge).
// Opt-in, off by default (PAPERCUSP_WORKITEM_REDUNDANCY + the per-item redundancy column).
import './work_items/set_redundancy';
import './work_items/claim_replica';
import './work_items/record_replica_result';
import './work_items/judge_redundancy';
import './work_items/redundancy_status';

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
// fleet:place_batch — one-wake BATCH placement (queen-autonomous-execution
// B-07 / P-001+P-002): ranks task↔bee affinity + fans spawn/warm-inject across
// the fleet in a single call (the Queen's serial placement loop, collapsed).
import './fleet/place_batch';
// fleet:drain — graceful wind-down signal for bee eviction (local-hive P-051).
// Distinct from fleet:cancel's hard kill; the bee cooperates to release locks/claims.
import './fleet/drain';
// Bee-dossier dock pane (pui-bee-dossier-pane-2026-06-06): fleet:bee_mail reads
// one bee's coord inbox+outbox by ownerId; fleet:selected_bee is the ephemeral
// in-memory swarm-pane→bee-pane selection relay (NOT PG — DB is not a transport).
import './fleet/bee_mail';
import './fleet/selected_bee';
// Host-dependency diagnostic for the fleet OS sandbox (fleet-spawn-sandbox P-011):
// bubblewrap/socat/srt presence, the Ubuntu 24.04+ AppArmor userns profile,
// container nesting — with per-check remedies.
import './fleet/sandbox_deps';

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
// plan-templates-and-rubric-v2-2026-06-20 P-003 — single-item structured read.
import './plans/get-item';
// plan-templates-and-rubric-v2-2026-06-20 P-005 — structured template_data read/write
// (validate-on-write against the per-template registry zod schema).
import './plans/get-template-data';
import './plans/set-template-data';
// plan-templates-and-rubric-v2-2026-06-20 P-006 — registers the built-in `rubric`
// template type (side-effect import) so set-template-data can validate it on write.
import './plans/rubric-template';
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
// shared-hive-collaboration-2026-06-14 P-003 — first-class ownership transfer + co-owners.
import './plans/transfer-owner';
// shared-hive-collaboration-2026-06-14 P-015 — initiative grouping label.
import './plans/set-initiative';
// plan-templates-and-rubric-v2-2026-06-20 P-002 — generic arbitrary-frontmatter-key setter (templates blocker).
import './plans/set-frontmatter-field';
// plan-templates-and-rubric-v2-2026-06-20 P-003 — structured item/decision-edit setters (vs plans:edit string-replace).
import './plans/set-item-blocked-by';
import './plans/set-item-phase';
import './plans/set-decision-body';
// plan-level lifecycle flip (draft→ready approve / demote / ship / reject).
import './plans/set-plan-status';
// scheduled-recurring-plans-2026-06-16 P-014 — author/clear a plan's schedule + manual run-now.
import './plans/set-schedule';
import './plans/run-now';
// scheduled-recurring-plans-2026-06-16 P-016/P-017 — arm/disarm (autonomy-gated: schedule-arm category).
import './plans/arm-schedule';
import './plans/disarm-schedule';
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
// domain-generic-hive-architecture-2026-06-18 P-016 — blueprint:publish, the
// publish entry point (mirror of learning_packs:publish): promote a local/private
// blueprint to the published/installed tier via the shared Cupboard core.
import './blueprint/publish';
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

// experiment-registry-invocation-api-2026-06-14 P-030/P-031 — the universal experiment
// surface over the eval-battery registry: catalog (discover) + run (offline replay,
// riding frontier:replay-harness). experiment:status is the P-032 sibling.
import './experiment/catalog';
import './experiment/run';
import './experiment/results';

// scout-idea-grading-2026-06-12 B-03 (C-3) — grade a routed Scout idea 1–5
// (+ optional critique) over the C-2 ledger seam; owner grades are sovereign.
import './scout/grade-idea';

// self-learning-frontier-2026-06-12 P-004 (FB-02, D-003) — the behavior-change
// ledger read surface: recent prompt/rule mutations (change_ledger:list) + the
// mutation-calendar overlap advisory (change_ledger:calendar). Read-only; the
// write side is the hooks in lib/change-ledger/.
import './change_ledger/list';
import './change_ledger/calendar';
// The Queen decision ledger read surface (queen-autonomy-policy B-13 / P-113):
// the action-chokepoint + disposition rows, filterable + rolled-up. Read-only;
// the write side is lib/decision-ledger/{emit,disposition}.ts.
import './decision_ledger/list';
import './decision_ledger/summary';
// prompt-sedimentology read surface (self-learning-frontier P-023 / FB-09):
// the per-rule dead-weight standings + recent shadow-cycle rows. Read-only;
// the write side is the weekly system:prompt-ablation routine (dark until the
// frontier P-001 arming gate).
import './ablation/report';
// calibration-markets read surface (self-learning-frontier P-041 / FB-13):
// per-persona per-domain Brier scores + trust weights — the Queen-weighting
// consumption point (D-005). Read-only; the write side is the capture seams
// + the system:calibration-resolve sweep (dark until the frontier P-001
// arming gate).
import './calibration/summary';

// event-reaction-system-2026-06-04 D-010 — the inspectable reactive-graph tool
// (what fires what + recent fired reactions with their cause-chain).
import './events/graph';

// await-event-primitive-2026-06-05 — the universal subscription primitive:
// register a one-shot wake on an event key (events:await), fire a key
// (events:emit), inspect/cancel (events:status / events:cancel). Delivery is
// liveness-adaptive (pty-inject / session-resume / inbox) + durable
// (harness_shared.event_awaits + event_wake_deliveries, migration 163).
// `watch` is the unified subscription primitive (unify-watch-primitive-2026-06-06);
// events:await / topics:subscribe are thin sugar presets over it (D-007).
import './events/watch';
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

// lexicon:active_pack (pui-hive-lexicon-2026-06-06) — expose the active brand
// pack's term→label map over HTTP so the Rust pui resolves user-facing labels
// from the ONE server-twin source instead of duplicating the packs.
import './lexicon/active_pack';

// storage:* (storage-settings-page-2026-06-15 P-003) — live storage usage by
// category + the safe prune-by-category-and-age executor behind the Settings →
// Storage page (federated categories refused; default keep-all).
import './storage/usage';
import './storage/prune';

// autoloop-pot-operator-rebuild-2026-06-05 P0 — re-project the Pot's persisted
// event-wake subscriptions (harness_shared.pot_wake) into live reaction rules.
// The registry is in-memory, so this runs on every host boot. Loaded after
// '../events' (the registry must exist). Fail-soft: a missing table
// (pre-migration-158) or a PG hiccup must never block boot.
// Boot registration is a background reader, so it covers every workspace
// `backgroundWorkspaceIds()` names (per-window-workspace-context P-020) —
// under the shared-operator model a non-global workspace's pot must still
// wake on its subscribed events.
import { registerHiveWakeRules } from '../hive/wake';
import { backgroundWorkspaceIds } from '../workspace-registry';
// EI-307: projecting the persisted hive-wake subscriptions into the in-memory
// reaction matcher is REQUEST-SERVING work, not a background loop — it must run on
// every operator host that serves tool calls, INCLUDING staging (:3170), so a tool
// invoked there fires its demand-wake reaction in-process. `backgroundWorkersEnabled`
// turns the loops off on :3170 (request-only), and gating the matcher on it was the
// bug (staging matched no rule → demand wakes silently dropped). `reactionMatcherShouldArm`
// arms green + staging; still excludes vitest (EI-312 leg 1: a worker must not poke the
// live wake system) + explicit full-disable.
import { backgroundWorkersEnabled, reactionMatcherShouldArm } from '../background-workers';
try {
  if (reactionMatcherShouldArm()) {
    for (const ws of backgroundWorkspaceIds()) {
      void registerHiveWakeRules(ws).catch(() => {});
    }
  }
} catch {
  /* never block boot */
}

// start-hive-wake-orchestration-2026-06-09 P-010 — the boot liveness check
// (crash recovery): a STARTED hive whose host died mid-turn never ran the
// turn-end hook, so it may sit started with no wake armed forever. Arm the
// watchdog fallback for each such hive. Fail-soft; never blocks boot.
// Gated like the wake-rule registration above (EI-312 leg 1).
import { hiveBootCheck } from '../hive/watchdog';
try {
  if (backgroundWorkersEnabled()) {
    void hiveBootCheck()
      .then((results) => {
        for (const r of results) {
          if (r.outcome === 'armed' || r.outcome === 'staged') {
            console.warn(`[hive-watchdog] boot ${r.outcome} a fallback wake: ${r.reason}`);
          }
        }
      })
      .catch(() => {});
  }
} catch {
  /* never block boot */
}

// overwatch-role-2026-06-15 B-09 / D-004 — the OVERWATCH boot liveness check
// (crash recovery, who-watches-the-watcher): an overwatch whose host died
// mid-turn never ran its turn-end hook, so it may sit started with no wake armed.
// Re-arm the fallback for each GUARDED overwatch. Self-gates on the
// `papercusp-overwatch` flag + B-07's started bit (no-op until activated).
// Fail-soft; never blocks boot.
import { overwatchBootCheck } from '../overwatch/watchdog';
try {
  if (backgroundWorkersEnabled()) {
    void overwatchBootCheck()
      .then((results) => {
        for (const r of results) {
          if (r.outcome === 'armed') {
            console.warn(`[overwatch-watchdog] boot armed a fallback wake: ${r.reason}`);
          }
        }
      })
      .catch(() => {});
  }
} catch {
  /* never block boot */
}

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
