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

// Wire tooldef's semantic-delta gate to FLAGS.TOOL_DELTA_PROTOCOL
// (agent-tool-delta-protocol-2026-06-22) — a pure side-effect that registers the
// host flag-reading resolver; OFF reverts every tool to Lane-B (full |
// not_modified). See delta-flag-wiring.ts.
import './delta-flag-wiring';

// Wire tooldef's result-annotator seam to the banded context-usage gauge
// (agent-managed-compaction-2026-07-01 P-013) — a side-effect that registers the host
// annotator appended to every tool result ≥65%. See context-gauge-wiring.ts.
import './context-gauge-wiring';

// code-execution-tool-orchestration (B-CX-2A): the code:run code-mode tool.
import './code/run';
// code-execution-tool-orchestration (B-CX-API): the code:tools on-demand signature lookup.
import './code/tools';
// code-recipes-2026-06-21 Phase 2 (P-005) — the recipe reuse verbs: list / get /
// search (the BEFORE-author dedup check) / run (reuse under the REUSER envelope, D-004).
import './recipes/list';
import './recipes/get';
import './recipes/search';
import './recipes/run';
// code-recipes-2026-06-21 Phase 3 (P-013 / D-017) — the Queen's deterministic
// graduation worklist: ranked promote candidates + near-duplicate merge clusters.
import './recipes/candidates';
// code-recipes-2026-06-21 Phase 4 (P-010 / D-015) — the hygiene actions: merge
// near-duplicate clusters into one survivor, sweep the stale never-reused one-offs.
import './recipes/merge';
import './recipes/sweep';

// reflexive-platform-extensibility-datatypes-2026-06-24 P-013 — the datatype
// registry surface: meta:define-datatype (declare + dedup gate) and the read verbs.
import './datatypes/declare';
import './datatypes/list';
import './datatypes/get';
// D-010 shared leg — offer a local datatype to the global tier (PENDING moderation):
import './datatypes/publish';
// D-010 distribution — browse the approved global catalog + install one into your workspace:
import './datatypes/catalog';
import './datatypes/install';
// P-011 — workspace observability over the datatype registry (counts by tier + review-status):
import './datatypes/summary';

// reflexive-platform-extensibility-datatypes-2026-06-24 P-004 — tools:scaffold:
// PURE codegen of a reviewable defineTool skeleton (writes/runs/mints nothing).
import './tools/scaffold';
// P-002 — meta:define-tool: tier router (composed → live recipe; sandboxed/elevated → PR rail).
import './tools/define';
// tools:find — intent search over the full catalog (tool-discovery-for-weak-models WS3).
import './tools/find';
import './tools/invoke';

import './operator/stats';
import './operator/converse';
// Sentinel-as-Herald: the papercup:converse alias (same brain, Herald persona).
import './operator/sentinel-converse';
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
import './voice/say';
import './voice/delegate-deep';
// Shared operator_conversations thread (sentinel-as-claude-tui Phase B):
import './conversation/recent';
import './conversation/append';
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
import './curation/state-of-pot';
// p2p-hive-directory-2026-06-06 P-005 — browse the discovered P2P pot directory:
import './discovery/pots';
// p2p-hive-directory-2026-06-06 P-004 — create/edit a pot's directory listing:
import './discovery/set_pot';
// autoloop-pot-operator-rebuild-2026-06-05 P0 — the Pot operator's self-declared
// wake surface (declare-wake / wake / status):
import './pot/declare_wake';
import './pot/wake';
import './pot/status';
// queen-brief-cache B-06 / P-010 — the Queen's per-wake efficiency read surface:
import './pot/mug_efficiency';
// queen-autonomous-execution B-08 — the Queen's plan-aware placement survey:
import './pot/survey';
import './pot/start';
import './pot/pause';
// queen-steering-panel-2026-06-15 B-01 — owner steering controls for the Queen
// (focus directive / eligible plans / new-work pause); hive_settings-backed (C-1).
import './pot/set_steering';
import './pot/get_steering';
// overwatch-role-2026-06-15 B-07 — the autonomous system-health supervisor's
// control surface (start/pause its loop), sibling to pot:start/pause:
import './overwatch/start';
import './overwatch/pause';
// overwatch-role-2026-06-15 B-04 — the overwatch's declare-next-wake verb (its own
// channel, gated coord:write so it can't touch the Queen's pot:declare-wake):
import './overwatch/declare_wake';
// overwatch-role-2026-06-15 B-04 — the wake-loop module: registers the
// `system:overwatch-launch` action + the B-07 wake-bridge waker at boot (so an
// `kettle:start` in THIS process finds a wired waker, not the fail-soft no-op).
import '../overwatch/loop';
// hive-tool-namespace-2026-06-08 — local hive lifecycle (read + create/dissolve/update):
import './pot/list';
import './pot/get';
import './pot/create';
// EI-1582 — the agent-facing producer for hive_slug (wire a harness in as a member):
import './pot/add_member';
// hive-from-github-url-2026-06-11 P-006 — create a Hive FROM a GitHub URL:
import './pot/create_from_repo';
// per-hive-learning-loops-2026-06-14 P-071 — opt INTO platform mode ("Papercusp inside Papercusp"):
import './platform/enable';
// per-hive-learning-loops-2026-06-14 P-072 — send a local improvement UPSTREAM (fork-PR + Comb learning-pack):
import './platform/contribute';
// pr-system-completion-dogfood PR-5 (D-3) — GC abandoned contribution forks (KEEP-on-merge + stale-fork sweep):
import './platform/fork_gc';
// pr-system-completion-dogfood PR-5 (item 2) — assert the fork→PR dogfood loop round-tripped (WI shipped + linked PR):
import './platform/dogfood_verify';
import './pot/dissolve';
// pot:obliterate — the HARD delete: dissolve + purge the harness_shared rows dissolve leaves behind.
import './pot/obliterate';
// shared-hive-hardening-2026-06-13 P-012 — a joiner cleanly LEAVES a shared hive:
import './pot/leave';
import './pot/update';
// cross-hive-boundary-2026-06-08 P-002 — owner cross-Hive capability grants:
import './pot/cross_grant';
// hive-network-surface-2026-06-11 P-005 (B-07) — owner beacon-publish consent:
import './pot/beacon_consent';
// hive-network-surface-2026-06-11 P-003 (B-04) — front-door cross-Hive ask tools:
import './pot/ask';
import './pot/request_work';
import './pot/asks';
// shared-hive-owner-enforcement-2026-06-19 (EN-3) — the claimed owner's control surface:
// P-MEMBER approval-mode (membership_pending / membership_decide) + P-MOD report→queue→
// takedown / ban (report / moderation_queue / moderation_resolve / takedown / ban_member).
import './pot/membership_pending';
import './pot/membership_decide';
import './pot/report';
import './pot/moderation_queue';
import './pot/moderation_resolve';
import './pot/takedown';
import './pot/ban_member';
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
// queen-memory-hybrid-2026-07-02 L1b — the generalized standing-facts ledger
// (deterministic scoped conclusions folded verbatim into briefs/dossiers/orients)
import './facts/assert';
import './facts/retract';
import './facts/list';
// fleet-reliability-verification-2026-07-10 P-010 (WI-3812) — self-verifying
// federation probes: probe:emit stamps required federation keys + refuses
// loudly when unfederatable; probe:get reads the derived per-hop verdict;
// probe:record-hop is the extension seam later pipeline stages stamp through.
import './probe/emit';
import './probe/get';
import './probe/record-hop';
// fleet-reliability-verification-2026-07-10 P-011 — gates:canary-check: run a
// self-checking gate canary on demand, bifurcating "still red" into gate-broken
// (the checker itself can't pass a known-good) vs system-broken (trust the red).
import './gates/canary-check';
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
import './memory/recover-from-transcripts';
import './autoloop/status';
import './autoloop/control';
// loop-routines-interval-recurrence-2026-06-20 (B-LOOP-5 / P-008) — the engine-managed
// LOOP surface: arm a tracked warm-wake loop on your own session (the /loop replacement),
// end it, inspect it. Gated by FLAGS.LOOPS (loop:arm); loop:end/status are always available.
import './loop/arm';
import './loop/checkpoint';
import './loop/end';
import './loop/soak_report';
import './loop/status';
import './operator/dedup_check';
import './wiki/backlinks';
import './harness/phase_path';
import './harness/markdown_index';
import './harness/escalation';
// tool-call-batching-wrappers-2026-06-21 P-006 — the "state of X" compound read
// (harness:status + escalation [+ list] + issues:list in one round-trip).
import './harness/overview';
import './harness/pending_reviews';
import './harness/health';
import './harness/list_features';
import './harness/membership';
// Cloud deployment (cloud-deployment-layer-2026-06-06 P-012/P-016)
import './deploy/deploy';
import './deploy/pot';
// Runtime build-identity ledger (fleet-reliability-verification-2026-07-10 P-008):
// "is the fix actually running there" in one query, distinct from the cloud
// deployment group above.
import './deploys/vintage';
// Queen account pool + auto-scale-out (cloud-deployment-layer-2026-06-06 Phase 7 P-019/P-020/P-021)
import './accounts/accounts';
// accounts-pool-tab-2026-06-15 P-002 — the experimental one-click OAuth account-link tools.
import './accounts/link';
// accounts-pool-tab-2026-06-15 P-004 — the owner's session-now account override tools.
import './accounts/session-override';
// EI-7357 — restores accounts:test-egress (the clean-IP gate probe egress-probe.ts's own
// doc comment references, but which was never actually registered as an MCP tool).
import './accounts/test-egress';
// gateway-clamp-advisory-capacity-probe-2026-07-09 P-001 — accounts:probe-capacity: ask upstream for the
// REAL unified-5h/7d budget and record it. The only way a usage-walled account (routed no live traffic,
// so its projection can never self-heal) gets a fresh reading short of waiting out its projected reset.
import './accounts/probe-capacity';
// gateway-live-control-and-egress-plan-2026-06-20 B-GWCTL — gateway:status / gateway:reload (hot-config).
import './gateway/gateway';
// local-concurrent-inference-2026-07-02 P-004 — gateway:local_backend_register/list/remove.
import './gateway/local-backends';
// local-concurrent-inference-2026-07-02 P-009 — provisioner:detect_hardware/recommend/plan_install/install.
import './provisioner/provisioner';
// WI-1659 (P-006 fast-follow) — cert:run/cert:catalog, the on-demand agent surface for the
// model-certification battery (lib/inference-gateway/cert-battery).
import './cert/battery';
// desktop-agent-behaviour-suite-2026-07-03 P-014/P-015 — behaviour:run/behaviour:catalog, the
// on-demand surface that scores a REAL agent run against the behaviour standard (lib/behaviour-suite).
import './behaviour/run';
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
import './dev/code_run_adoption';
// WI-839 — the other 2 measuring-code-run-adoption.mdx recurring metrics (sibling reads).
import './dev/limit_failure_rate';
import './dev/orient_dedup_rate';
import './dev/audit';
import './dev/sessions';
import './dev/activity';
import './dev/pg_health';
import './dev/pg_active_queries';
import './dev/pg_table_sizes';
import './dev/pg_query';
import './dev/build_status';
// git-sync-dx-hardening-2026-06-17 P-002 — "where is my change / is it live?" probe
import './dev/pipeline_position';
// EI-7349 — "why is nothing shipping?" causal-chain explainer (gate -> deploy -> pool)
import './dev/why';
// coord-lifecycle-automation-2026-06-04 D-006 — the re-runnable corpus categorizer
import './dev/coord_categorize';
import './dev/dogfood_substrate_status';
import './dev/ipc_echo';
import './dev/state_counter';
import './dev/event_emitter';
import './dev/processes';
import './dev/session_detail';
import './dev/resolve_owner';
// tool-call-batching-wrappers-2026-06-21 P-001 — tool co-occurrence miner
// (the deterministic wrapper-candidate / code-recipes-promotion signal).
import './dev/tool_cooccurrence';
import './processes/kill';
import './turn/interrupt';
import './dev/omp_session';
// EI-4911 — the Claude-Code analogue of dev:omp_session: find/search/read local Claude transcripts.
import './dev/claude_session';

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
import './trust/comms';

import './saved_prompts/list';

import './backup/snapshot_create';
import './backup/snapshot_list';
import './backup/restore';
import './backup/diff';
import './backup/promote';
import './backup/rollback';
import './backup/settings_get';
import './backup/settings_set';

// setup:* — the onboarding tutor's conversational replacements for the GUI
// Setup Wizard steps (agent-first-onboarding-2026-07-03 P-004). Backups are
// deliberately NOT here — the tutor reuses backup:settings_set above.
import './setup/status';
import './setup/set_git_identity';
import './setup/set_telemetry';
import './setup/set_update_channel';
import './setup/save_key';
import './setup/save_integration_key';
import './setup/complete';
import './setup/set_tutorial_progress';
import './docs/outline';
import './docs/get';
import './docs/search';
import './docs/author';
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
import './harness_docs/retire';

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
// Visible-terminal sibling of bash: opens a NEW terminal window on the user's
// HOST desktop and runs an arbitrary command in it. Reuses the console-launcher
// envelope + console-spawn primitive; runs OUTSIDE bwrap (the visible terminal
// is the point) — same tier/role gating as bash, recorded as a plan decision.
import './capability/terminal';
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
import './dev/worker_chunk_loop_metrics';
import './db/migrate';
import './db/check_drift';
import './db/next_migration';
import './testing/prune_orphan_runs';
import './testing/flakiness';

// Named-fleet registry tools (named-su-agent-fleets-2026-06-29 P-004 / D-002 / D-003):
// create / list / status / join / leave / take-leadership over the durable
// harness_shared.agent_fleets registry + the soft coord_presence fleet_slug label.
// fleet:take-leadership IS routing option (2) — "hand a plan to a fleet" makes the
// handoff agent the leader (P-007); there is no separate routing engine.
import './fleet_registry/create';
import './fleet_registry/list';
import './fleet_registry/status';
import './fleet_registry/join';
import './fleet_registry/leave';
import './fleet_registry/take-leadership';
import './fleet_registry/launch-on-plan';
import './fleet_registry/request-remote-spawn';
import './fleet_registry/recolor';

// L1 agent coordination (identity & presence) — see
// agent-coordination-architecture-v2-2026-05-20.md
import './coordination/tools/whoami';
// Identity durability across relaunch (compaction-continuity-hardening P-007):
// migrate ownerId-keyed surfaces from a dead predecessor sid to the live one.
import './coordination/tools/rebind-identity';
import './coordination/tools/presence';
// Unified presence/roster reader (presence-coord-unification P-001 / D-001): one door
// with four view lenses (live/members/claims/history) that consolidates coord:presence,
// fleet:assignments, coord:glance, etc. — replaces "which of 5 tools do I call".
import './coordination/tools/roster';
import './coordination/tools/declare-intent';
// Per-agent wake mode + staged-wake review — the pause/edit gate's control surface
// (hive-agent-tabs-psu-tui-2026-06-09 P-008/P-009 / D-005). The stage-vs-fire
// behavior is in wakeRecipients (P-007, gated on POT_AGENT_TABS); these expose it.
import './coordination/tools/wake-mode';
import './coordination/tools/wake-queue';
// One cheap combined fleet glance (wake gate + staged wakes + bees + governor +
// contextual tips) — the high-frequency statusline/TUI read.
import './coordination/tools/glance';
// COMPOUND agent wake-orientation read (code-execution B-CX-1B): my assignments +
// claimable backlog + inbox summary in one round-trip (the work-centric sibling of glance).
import './coordination/tools/orient';
// Official session modes as first-class data (modes-and-intake-ux-2026-07-05):
// catalog/index (mode:list), point read (mode:get), and the axis-aware setter
// with the owner-sticky guard + same-axis auto-switch (mode:set). Presence/orient
// surface active modes ambiently; contracts inject at activation, not in the base prompt.
import './mode/list';
import './mode/get';
import './mode/set';
// Dispatch a slash-exposed tool command AT another agent via deliver-and-wake
// (WI-126) — the cross-session leg of slash exposure; the wake-mode gate stages
// dispatched commands for manual-mode targets.
import './slash/dispatch';
// L3 channels — messages + acks + threads (Phase B core)
import './coordination/tools/send';
// COMPOUND coordinator dispatch (fleet-dispatch-wake-clarity P-002 / D-002): assign a
// lane + deliver the note + WAKE the target + report pickup, in ONE call — composes
// coord:presence + plan_items:assign + coord:send (deliver-and-wake). Flags an
// `ended`/not-wakeable target loudly instead of a silent woken:0.
import './coordination/tools/dispatch';
// The discoverable "wake a parked agent NOW" alias (fleet-dispatch-wake-clarity P-006):
// fires the target's inbox-wake key (reusing wakeRecipients) so it re-orients on its
// already-claimed lane — closes the coord:wake/coord:nudge 404 gap.
import './coordination/tools/wake';
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
// Live open/resolved severe-condition state (WI-1444 lifecycle reader, EI-6138)
import './coordination/tools/conditions';
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
// Audience-keyed catch-up — the message history for a fleet/topic you belong to
// (low-tier coord:read, membership-checked; the pull counterpart to @fleet:/@topic:).
import './coordination/tools/catch-up';
// Per-member fleet delivery override — full | digest | muted for a fleet's broadcasts
// without leaving it (the "+ optional override" on the derived fleet subscription).
import './coordination/tools/fleet-delivery';
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
import './improvements/set-watchdog-tunables';

// live-configurability-audit-2026-06-20 P-024/P-025 — the runtime-config override-registry
// readback (config:list-overrides); the concern modules (e.g. watchdog-tunables) self-register.
import './config/list-overrides';
import './config/reset-overrides';
import './config/set-compaction-limit';
// context-trimming-tiers-2026-07-01 P-005 — the tier-menu read/write surface
// (per-tier soft compaction limits ride the menu):
import './config/tiers-get';
import './config/tiers-set';
// agent-managed-compaction-2026-07-01 — the agent's "compact now, at a stopping point" verb:
import './session/request-compaction';
// session-search-scope-2026-07-05 — the episodic transcript-index verbs: the fused
// search (needle + window in one call, session:'self' compaction recovery) + the
// navigation reads (list/read/timeline) over harness_shared.session_turns.
import './sessions/search';
import './sessions/read';
import './sessions/list';
import './sessions/timeline';
// sentinel-herald Phase 8 P-037 — pre-existing override mechanisms now self-register as
// config-override concerns so config:list-overrides is the canonical audit surface. These
// stores are already transitively imported by their tools; importing them here makes the
// registration explicit + order-independent (matches the P-024 self-register convention).
import '../rate-limit-config';
import '../agent-config';
import '../voice-prefs';
import '../deployment/account-session-override';
// live-configurability-audit-2026-06-20 P-003 — runtime-settable deploy-migration lock_timeout:
import './db/migrate-policy';
// live-configurability-audit-2026-06-20 P-002 — read/retune/pause the system routines (git-sync, …):
import './routines/list';
import './routines/set';
// git-sync:run — fire git-sync once on demand (WI-1320; the manual lever git-sync lacked,
// so a force-deploy ships CURRENT staging not stale).
import './git_sync/run';
// WI-1555 — the owner ratify surface for the multi-owner integration-requests queue
// (lib/sync/pot-git/integration-requests.ts had no exposed verb until this tool).
import './pot_git/integration_requests';
// schedule-inventory-and-ephemeral-tier-2026-06-26 P-002 — central read-only inventory of every cadence:
import './schedule/inventory';
// live-configurability-audit-2026-06-20 P-020 — runtime dispatch telemetry-buffer sizing:
import './telemetry/set-buffer';
// live-configurability-audit-2026-06-20 P-020 — runtime per-workspace txn lock/statement timeouts:
import './db/txn-timeouts';
// live-configurability-audit-2026-06-20 P-008 — runtime role→capability grants (DARK behind
// papercusp-capability-grant-tool; D-007 owner-authority):
import './capability/grant-role';
import './capability/revoke-role';
// live-configurability-audit-2026-06-20 P-009 — runtime per-role capability-envelope override
// (capability_envelope:set_role). DARK behind papercusp-capability-envelope-overrides.
import './capability/envelope-set-role';
// live-configurability-audit-2026-06-20 P-001 — per-(harness,role) prompt override (read/set/clear):
import './prompt/role-override';
// live-configurability-audit-2026-06-20 P-005 — settable fleet opus-budget shed bands:
import './fleet/opus-budget';
// live-configurability-audit-2026-06-20 P-006 — settable account scale-out trigger policy:
import './accounts/scale-policy';
// live-configurability-audit-2026-06-20 P-011 — settable auto-implement risk policy + dispatch limits:
import './improvements/set-auto-policy';
// live-configurability-audit-2026-06-20 P-012 — settable per-harness gym promotion gates:
import './gym/set-gates';
// live-configurability-audit-2026-06-20 P-014 — coordination liveness/reclaim config (reclaim tool):
import './work_items/reclaim-config';
// live-configurability-audit-2026-06-20 P-014 — handoff TTL + session-reaper grace config tools:
import './coordination/handoff-config';
import './coordination/session-reaper-config';
// live-configurability-audit-2026-06-20 P-015 — hive placement-watchdog control policy:
import './pot/control-policy';
// live-configurability-audit-2026-06-20 P-016 — green-checkpoint / release thresholds:
import './release/checkpoint-config';
// live-configurability-audit-2026-06-20 P-022 — runtime Scout workspace spend-ceiling override:
import './learning/set-scout-budget';
// live-configurability-audit-2026-06-20 P-018 — runtime per-(tool,role) quota overrides:
import './quota/set-tool';
// live-configurability-audit-2026-06-20 P-019 — runtime §G auth/sandbox dials (DARK, owner-authority):
import './auth/set-full-access-roles';
import './clamp/set-safe-tools';
import './exec_sandbox/set-policy';
// live-configurability-audit-2026-06-20 P-010 — runtime capability→tier override (DARK §G umbrella):
import './capability/set-tier';
// release-pipeline-resilience-2026-06-09 P-015 — the manual deploy lever + gate-unblock diagnosis:
import './release/deploy';
// WI-1320 follow-up — the manual GATE-run lever (fire the green-checkpoint suite on demand):
import './release/checkpoint-run';
// desktop-update-center-and-release-tooling P-5 Unit B — the LOCAL desktop-release cut + hand-off orchestrator:
import './release/cut';

// Engineer issues (bug/change): the agent-facing issues:* TOOL surface was RETIRED onto the
// unified work_items:* surface (coordination-unification-2026-06-23 P-015 / D-011). The
// engineer-issues STORE stays — work_items:* dispatches to it for the issue family; the 13
// thin issues/*.ts wrappers were deleted. Agents use work_items:{create,list,get,update,
// comment,claim,release,set_state(=close),tag,subscribe,search,link,promote}.

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
// work_items:create is now dual-arity (bulk-endpoint-standardization-2026-06-21 P-002):
// single spec OR items:[…] → keyed-array envelope, RETIRING the old create_batch
// multiplexer (its bulk loop folded back into create via the shared _create-core).
import './work_items/create';
import './work_items/get';
import './work_items/list';
import './work_items/burn_down';
import './work_items/search';
import './work_items/set_state';
// release-pipeline-resilience-2026-06-09 P-013 — the additive live-verified marker (done=staging vs
// confirmed-live), distinct from the lifecycle state:
import './work_items/set_live_verified';
// Structured completion → auto-emit (coord-lifecycle-automation-2026-06-04 D-004)
import './work_items/complete';
import './work_items/claim';
// COMPOUND work-pickup (code-execution B-CX-1B): get(detail)+claim(+declare-intent) in
// one round-trip — the #1 measured agent flow; also closes the get→claim race.
import './work_items/pickup';
import './work_items/release';
// Park a work-item resumably: checkpoint + release + broadcast in one verb
// (modes-and-intake-ux-2026-07-05 P-004 — the named form of "parked with a
// complete resume checkpoint").
import './work_items/park';
// Hold a work-item OPEN without releasing the claim: held_open_by stamp gates
// non-holder terminal transitions + excludes self-select
// (fleet-deltas-leader-primitives-2026-07-10 P-006; EI-8993/EI-8973).
import './work_items/hold_open';
// (work_items:batch RETIRED — bulk-endpoint-standardization-2026-06-21 P-002: every
// verb it multiplexed — claim/release/set_state/set_priority/tag/subscribe — is now
// itself dual-arity (items[]/ids[] via _bulk), so the op-multiplexer is redundant.)
// Per-assignee ordered work-list (local-hive-orchestration P-020 / D-004 / D-008):
// reorder moves an item within its assignee's queue; writer (bee|queen) = the
// propose/dispose audit, gated by the existing automation tier (work_items:write → medium).
import './work_items/reorder';
import './work_items/link';
import './work_items/tag';
import './work_items/subscribe';
import './work_items/comment';
// Field-edit (title/body/severity/kind/found-during/linked-feature) — the unified
// replacement for the retired issues:update (coordination-unification-2026-06-23 P-009).
import './work_items/update';
import './work_items/checkpoint';
import './work_items/amend';
import './work_items/expand';
import './work_items/promote';
// Blackboard tuple-space primitives (fleet-as-supervised-blackboard D-004): claim_next
// is the associative `in` (self-select / work-steal via SKIP LOCKED); observe is `rd`.
import './work_items/claim_next';
import './work_items/observe';
// hybrid-bee-scheduler-work-stealing-2026-06-22 — the per-bee SPEC-DRIVEN claim path: the bee's
// scheduler:get_next pulls deterministically per its Queen-issued claim spec within the global
// floors (the richer sibling of claim_next); the Queen steers via scheduler:set_claim_spec.
import './scheduler/get_next';
import './scheduler/set_claim_spec';
// EI-7678: the READ counterpart to set_claim_spec — confirm a bee's/fleet's current spec
// (source/revision/updatedBy/updatedAt) without grepping source or guessing.
import './scheduler/get_claim_spec';
// p2p-work-distribution-2026-07-02 P-004: the cross-machine refusal-receipt timeline.
import './p2p/trace';
// agent-allocation-framework-2026-07-03 P-002 (D-004): the ONE delegation write path —
// hand a fleet an account pool / GPU (share-%) or agent seats (agent_slot, count-capped);
// the /res loopback (p2p-allotment-set) wraps the same core.
import './resource/delegate';
// The live-execution view (P-001): in-flight claims + the spec revision each bee runs under.
import './scheduler/running';
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
// work_items:completion_stats — the genuine-completions-vs-dedup metric
// (work-item-completion-integrity-2026-07-01 WI-1405, contract C-1 consumer).
import './work_items/completion_stats';

// Fleet — structured concurrency / supervision over the spawn tree
// (fleet-as-supervised-blackboard-2026-06-04). fleet:cancel is the transitive
// cancellation primitive (D-003); fleet:tree reads the durable nursery structure.
import './fleet/cancel';
// fleet:kill — unified desktop+headless agent termination with close_terminal
// (WI-3728, owner-directed 2026-07-10). Desktop leg kills the psu host + closes
// the terminal window; headless leg delegates to the fleet/cancel machinery.
import './fleet/kill';
import './fleet/tree';
import './fleet/supervise';
import './fleet/admit';
import './fleet/governor';
// cup:spawn — the operator→bee launch verb over the same durable nursery
// (Brief 4, agent-briefs-2026-06-05; renamed from fleet:spawn per WI-1764 #3 so
// the namespace encodes the substrate: cup:* = the autonomous mug↔cup loop,
// fleet:* = visible desktop su members). chat <spawn> tags, the operator brain's
// tool call, and the admin HTTP trigger all land in spawnAgentInHarness.
import './cup/spawn';
// fleet:assignments — the canonical "who's on what" state query over the
// fleet_assignment view (state-not-chat-fleet-state-2026-06-05 D-002).
import './fleet/assignments';
// fleet:leader-brief — a leader's ONE-call fleet-health brief over ITS OWN
// fleet (fleet-reliability-verification-2026-07-10 P-007): reuses
// fleet:assignments' decoration pipeline, filtered + reshaped leader-lean.
import './fleet/leader-brief';
// fleet:bench — bench a fleet member as TRACKED STATE
// (fleet-reliability-verification-2026-07-10 P-006): stage a member's next
// assignment centrally (captures + registers their wake await FOR them,
// catching a bench miss at stage time) instead of a hand-written per-member
// convention; { list: true } queries who's benched, on what key, staged how.
import './fleet/bench';
// fleet:place_batch — one-wake BATCH placement (queen-autonomous-execution
// B-07 / P-001+P-002): ranks task↔bee affinity + fans spawn/warm-inject across
// the fleet in a single call (the Queen's serial placement loop, collapsed).
import './fleet/place_batch';
// fleet:capacity — the Queen's SOURCE-side read of the shared inference-capacity oracle
// (queen-capacity-aware-dispatch-2026-06-22 P-003): bee-tier dispatchBudget + per-tier caps +
// pool saturation, so placement is sized to what the pool can sustain (the read that mirrors
// what place_batch's MUG_CAPACITY_DISPATCH clamp DOES).
import './fleet/capacity';
// fleet:drain — graceful wind-down signal for bee eviction (local-hive P-051).
// Distinct from fleet:cancel's hard kill; the bee cooperates to release locks/claims.
import './fleet/drain';
// Bee-dossier dock pane (pui-bee-dossier-pane-2026-06-06): fleet:cup_mail reads
// one bee's coord inbox+outbox by ownerId; fleet:selected_cup is the ephemeral
// in-memory swarm-pane→bee-pane selection relay (NOT PG — DB is not a transport).
import './fleet/cup_mail';
import './fleet/selected_cup';
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
// app-templates-2026-07-04 (WI-3198) — the `templates:*` group exposes the Cupboard
// app-template storefront to MCP agents (the whole surface was HTTP-only, so a
// shell-less webapp/claude agent could not reach it): browse listings, read a
// template's GUIDE, and materialize one into a fresh harness + start a builder.
import './templates/list';
import './templates/get-guide';
import './templates/new-app';
// P-009 (B3) — kind #1 harness creation: deterministically generate an
// `extends: coding` blueprint from an existing repo, then compose harness:create.
import './harness/generate_from_repo';
// WI-1563 — harness:configure: the non-hive counterpart of pot:update's
// configOverrides half (set per-instance blueprint-knob overrides on an
// EXISTING harness that isn't a hive).
import './harness/configure';
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
import './scout/ideation-feedback';
// su-ideate-learning-substrate-2026-07-10 P-009 — route an su idea onto the plan
// rail: a draft plan + an origin='su-ideate' routed-idea ledger row (grade/outcome
// attribution rides the same plan:<slug> terminal-state read).
import './scout/route-idea';
// su-ideate-learning-substrate-2026-07-10 P-010 — record one su IDEATE pass as a
// status='ran', origin='su-ideate' tick on the Scout ledger (migration 571): the
// su analogue of a scout-cycle tick, partitioned OFF Scout's cadence/health reads.
import './scout/ideate-pass-record';

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
// WI-4014 Part 2 (linking-system follow-up to WI-3956): the lifecycle verb for a
// standing event-key INJECT subscription (watch:create wake:false targetKind:'event')
// — the wake:false sibling of events:cancel, mirroring topics:unsubscribe's shape.
import './events/unsubscribe';
// event-await-discoverability-and-coverage-2026-07-03 P-002 — the awaitable-key
// catalog ("what can I wait on instead of polling?"), rendered from the SSOT
// registry events/await/catalog.ts.
import './events/catalog';
// P-003 — thin named sugar verbs (deploy:await / checkpoint:await / work-item:await
// / service:await-up / git-sync:await / plan-item:await / fleet:await-drained) that
// resolve to events:await, sourcing key shapes from the catalog (D-002/D-005).
import './events/sugar';

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
import { registerPotWakeRules } from '../pot/wake';
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
      void registerPotWakeRules(ws).catch(() => {});
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
import { potBootCheck } from '../pot/watchdog';
try {
  if (backgroundWorkersEnabled()) {
    void potBootCheck()
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
// loop-wake-rate-limit-robustness P0b: side-effect import registers the resume-turn-outcome
// handler (feeds a dead loop wake turn into the autoloop circuit + 429-aware re-arm). Mirrors
// the lock-grant-bridge reconciler registration; must be imported at boot to take effect.
import '../harness/routines/loop-turn-outcome';
try {
  startAwaitSweeper();
} catch {
  /* never block boot */
}

// fleet-deltas-leader-primitives-2026-07-10 P-008 — the predicate-watch poller
// (engine-side "wake me when a tool result crosses a threshold"). Boot-started so
// rows registered before a host restart keep polling; same fail-soft contract as
// the sweeper above (missing table pre-migration-541 must never block boot).
import { startPredicateWatchPoller } from '../events/await/predicate-watch';
try {
  startPredicateWatchPoller();
} catch {
  /* never block boot */
}
