//! Event sources that feed the single update loop through one mpsc channel.
//!
//! Architecture (SP-TUI A2): all inputs — terminal keys, periodic ticks, and
//! async backend deltas — are normalised into `Event` and drained by one
//! `App::update`. crossterm's `event::read` is blocking, so it lives on a
//! dedicated OS thread that forwards into the async channel; the backend poller
//! (see `main`) forwards `Plans` / `Roster` / `Error`.

use crate::models::{
    ActivityRow, AttentionItem, BeeAssignment, BeeMailPayload, ChatMessage, ChatToolCall,
    ConvDetail, ConvSummary, DocsResponse, EffectiveClaudeSettings, FlagsResponse,
    FleetRateStatus, HarnessFeature, HarnessIssue, HarnessRef, LexiconPackPayload, Notif,
    OperatorConfig, PlanItemStates, PlanSummary, RosterEntry, TestingDomain, TuiPaneContribution,
    ViewState, WorkItem,
};
use crossterm::event::{self, Event as CtEvent, KeyEvent};
use pui_companion_proto::Topology;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

/// Everything the update loop reacts to.
#[derive(Debug, Clone)]
pub enum Event {
    /// A terminal key press.
    Key(KeyEvent),
    /// Idle tick (emitted when no input arrives within the poll window).
    Tick,
    /// Fresh plans list from the backend poller.
    Plans(Vec<PlanSummary>),
    /// Fresh agent roster from the backend poller. `active` is the presence-
    /// primary roster (rendered); `pending` is the recorded-but-not-running
    /// workbench-launch tier (pui-reactive-session-panes D-006) the reducer diffs
    /// to reactively open work-area panes — never rendered in the roster.
    Roster {
        active: Vec<RosterEntry>,
        pending: Vec<RosterEntry>,
    },
    /// Fresh inbox (attention) items from the backend poller.
    Inbox(Vec<AttentionItem>),
    /// Fresh fleet rate/usage read-model (Overview top-bar, Brief 23 P-005).
    FleetRate(FleetRateStatus),
    /// EI-358: a pending-launch CLAIM failed in transport (operator blip) — the
    /// reducer un-tracks the id so a later roster tick retries. A LOST claim
    /// (another pui instance won) never emits this; it stays tracked/skipped.
    LaunchClaimRetry(i64),
    /// Realtime operator voice session updates (voice-realtime-tui-2026-06-05).
    ConvAi(crate::voice_convai::ConvAiUpdate),
    /// P2P voice-channel updates (holepunch-voice-channels P-008): socket
    /// status/error/mic + HTTP-fetched channel list / prefs, folded into the
    /// Voice tab's state by the reducer.
    VoiceUi(crate::voice_ui::VoiceUiEvent),
    /// Fresh features for the active harness.
    Features(Vec<HarnessFeature>),
    /// Fresh issues for the active harness.
    Issues(Vec<HarnessIssue>),
    /// The harness list (for the selector).
    Harnesses(Vec<HarnessRef>),
    /// Project docs (file list + active doc content) for the active harness.
    Docs(DocsResponse),
    /// Testing domains for the active harness.
    Testing(Vec<TestingDomain>),
    /// The selected testing domain's runnable files (D-004a, from domain-detail).
    /// Carries the domain id so a stale fetch never paints the wrong domain.
    TestingFiles {
        domain_id: String,
        files: Vec<String>,
    },
    /// The user's memories from `memory:list` (D-006 Step 2). `available=false`
    /// = the memory backend reported unavailable (the tab's empty state).
    Memories {
        available: bool,
        results: Vec<crate::models::MemoryEntry>,
    },
    /// Semantic hits from `memory:search` for the query the user typed (D-006).
    MemoryHits {
        query: String,
        results: Vec<crate::models::MemoryEntry>,
    },
    /// A test run finished (D-004a) — the file that ran + its result.
    TestRunDone {
        file: String,
        result: crate::models::TestRunResult,
    },
    /// Plugin-contributed TUI panes for the active harness (D-002).
    TuiPanes(Vec<TuiPaneContribution>),
    /// All installed plugin manifests for the Plugins tab (D-007) — identity +
    /// frontend/backend contribution surfaces + configSchema.
    Plugins(Vec<crate::models::PluginManifest>),
    /// One plugin's saved per-harness config (D-014) — loaded on Enter in the
    /// Plugins list, refreshed after each `:pset`/`:punset` round-trip. Carries
    /// the plugin name so a stale fetch never paints another plugin's config.
    PluginConfig {
        plugin: String,
        config: serde_json::Value,
    },
    /// The active harness's effective claude-settings view (D-013) — defaults
    /// overlaid by the file, plus the raw file body the `:set`/`:unset` editor
    /// round-trips.
    Config(EffectiveClaudeSettings),
    /// Feature flags + values for the read-only Settings tab (P10).
    Flags(FlagsResponse),
    /// Merged plan-item assignment/claim/liveness for the SELECTED plan (P-005a) —
    /// rendered in the Plans detail pane.
    PlanItemStates(PlanItemStates),
    /// Read-only operator-config overview (P10b) for the Settings tab — AI backend
    /// + per-role models + connected speech providers.
    OperatorConfig(OperatorConfig),
    /// Fleet-wide work items (work_items:list) for the Fleet tab (P0).
    WorkItems(Vec<WorkItem>),
    /// Activity backfill (activity:recent, newest-first) seeding the Fleet feed (P1).
    ActivitySeed(Vec<ActivityRow>),
    /// A dedicated todos backfill (activity:recent kind=todos) for the per-agent
    /// todo map (P2) — keeps todos current even when they fall outside the feed.
    ActivityTodos(Vec<ActivityRow>),
    /// One live activity row from /api/activity/stream — prepended to the feed (P1).
    ActivityLive(ActivityRow),
    // --- Bee-dossier dock pane (pui-bee-dossier-pane-2026-06-06) ---
    /// The Fleet-tab bee selection changed (applied in-process by the run loop's
    /// `PublishBeeSelection` arm — pui-dock-consolidation-2026-06-07). The
    /// reducer updates `bee`, clearing the stale dossier on a change.
    BeeSelection {
        owner_id: Option<String>,
        name: Option<String>,
    },
    /// A fetched bee dossier (assignment + coord inbox/outbox). Carries the
    /// owner_id so a stale fetch never paints the wrong bee (the standard guard).
    BeeDossier {
        owner_id: String,
        assignment: Option<BeeAssignment>,
        mail: Option<BeeMailPayload>,
    },
    /// Whole-fleet assignments (every bee's ranked work-list), for the default
    /// Swarm dossier (pui-dock-consolidation-2026-06-07 #2). The reducer stores
    /// them in `fleet.all_assignments`.
    FleetAssignments(Vec<BeeAssignment>),
    /// A RUNNING bee's appended raw output (the watch pane's thinking feed,
    /// pui-dock-agent-stack-2026-06-07): bytes since the last poll cursor.
    BeeOutput {
        owner: String,
        offset: u64,
        chunk: String,
    },
    /// The watch pane's chat send finished (Ok → the thread is open and the
    /// bee was pinged; Err carries the message).
    BeeMessageSent(Result<(), String>),
    /// A manual-mode agent's staged wakes (hive-agent-tabs P-009) — the result of
    /// `FetchWakeQueue` (and the auto-refresh after a release/skip). Carries the
    /// agent so a stale response never paints another agent's review overlay.
    WakeQueue {
        agent: String,
        result: Result<Vec<crate::models::PendingWake>, String>,
    },
    /// The fleet-wide staged-wake board (the `pui wake-pane` dock pane,
    /// EI-312): per-agent groups (queen first) + the GLOBAL default wake-mode.
    /// A whole snapshot — it replaces the pane's state each refresh.
    WakeBoard {
        result: Result<(Vec<crate::models::WakeGroup>, Option<String>), String>,
    },
    /// The agent-context pane snapshot (dock 4-pane split, owner ask
    /// 2026-06-11) — brief / mail / work data for ONE agent, replacing the
    /// pinned `Tab::AgentCtx` pane's state each refresh.
    AgentCtx {
        result: Result<crate::models::AgentCtxData, String>,
    },
    /// The deployed cloud frames (hive-agent-tabs P-013) from
    /// `/api/deploy/frames` — drives the per-frame zellij tabs in the dock.
    Frames(Vec<crate::models::DeployFrameRow>),
    /// The federated p2p roster for the Hives tab (pui-hives-tab-2026-06-07) —
    /// every remote peer announced into `shared_presence`, via `coord:presence`.
    Hives(Vec<crate::models::PresenceRow>),
    /// The P2P hive directory (p2p-hive-directory P-006) — verified hives
    /// announced on the directory topic, via `GET /api/discovery/hives`.
    HiveDirectory(Vec<crate::models::DiscoveredHiveRow>),
    /// The cross-Hive network board (hive-network-surface-2026-06-11 B-09) —
    /// one pinned-C-3 row per hive-context over the capability ladder, from
    /// B-08's data endpoint. A whole snapshot; replaces the pane's rows.
    NetworkBoard(Vec<crate::models::NetworkBoardRow>),
    /// The per-hive drill-in dossier data (hive-network-surface P-014 item 2):
    /// a foreign hive's captured beacon HISTORY + the full C-1 ask log for the
    /// `pui hive-pane <key>` instance's pinned key. A whole snapshot; replaces
    /// both lists each refetch (rides the standard SSE + 60s cadence).
    HiveDossier {
        beacons: Vec<crate::models::HiveBeaconSnapshot>,
        asks: Vec<crate::models::CrossHiveAskRow>,
    },
    /// The active Hive lexicon pack, fetched once at startup
    /// (pui-hive-lexicon-2026-06-06). The reducer stores the term→label map.
    LexiconPack(LexiconPackPayload),
    /// Marketplace listings for the Cupboard tab (D-011) — the result of a
    /// `FetchCupboard` action. Carries the (kind, query) the fetch was for so a
    /// stale response never paints a newer filter's view. Action outcomes
    /// (join/fork/install) ride the ordinary `Notify`/`Error` events.
    CupboardListings {
        kind: String,
        query: String,
        listings: Vec<crate::models::CupboardListing>,
    },
    /// The conversations list for the Conversations tab (Brief 25) — the result
    /// of a `FetchConversations` action under the current state/kind/topic filter.
    Conversations(Vec<ConvSummary>),
    /// One conversation's full detail (thread + topics + accepted answer + linked
    /// work-item) loaded on selection. Carries the id so a stale fetch never
    /// paints another conversation's detail (the TestingFiles/PluginConfig guard).
    ConversationDetail { id: String, detail: ConvDetail },
    /// A live `attention.notify` event (P8) — raise a toast + OS notification.
    Notify(Notif),
    /// Backfilled notification history from `/api/toast-log` (P8).
    ToastHistory(Vec<Notif>),
    /// A backend fetch failed (shown in the status bar).
    Error(String),
    /// The persisted workbench view-state loaded on startup (P12 / D-002) —
    /// restore the active tab/selections/scroll where the user left off.
    ViewStateLoaded(ViewState),
    /// An agent control intent (P12b / D-002 A6 — tui:dispatch) arrived over the
    /// `/api/tui/intents/stream` SSE. Applied to AppState; the result is POSTed
    /// back to `/api/tui/intents/:id/result`.
    TuiIntent {
        id: i64,
        intent: String,
        args: serde_json::Value,
    },
    // --- Operator chat pane (tui-operator-surface-2026-06-04) ---
    /// The operator conversation loaded on open (GET /api/operator/conversations):
    /// the conversation id + recent turns (oldest first) + whether older history
    /// exists. Seeds the transcript.
    ChatHistory {
        conversation_id: String,
        messages: Vec<ChatMessage>,
        has_more_earlier: bool,
        /// Lowest `seq` in this page — the load-earlier cursor. `None` if empty.
        oldest_seq: Option<i64>,
    },
    /// An older page of turns (load-earlier / infinite scroll-back) — prepended
    /// to the transcript. Carries the new oldest cursor + whether more remain.
    ChatEarlier {
        messages: Vec<ChatMessage>,
        has_more_earlier: bool,
        oldest_seq: Option<i64>,
    },
    /// A streamed `delta` chunk of the in-flight operator turn — appended to the
    /// streaming assistant bubble's raw buffer.
    ChatDelta(String),
    /// A `tool_call` the operator made mid-turn — a chip on the streaming bubble.
    ChatToolCall(ChatToolCall),
    /// The in-flight operator turn finished (`done`) — finalize the bubble.
    ChatDone,
    /// The operator converse stream errored (`error`, or transport failure).
    ChatError(String),
    // --- Companion zellij plugin (P-004 / D-008): the in-zellij vantage point.
    // Sourced from the `zellij pipe` child's stdout, not the backend. ---
    /// The companion plugin linked up (carries its version).
    CompanionReady(String),
    /// Fresh live workbench topology (tabs + panes) from the companion plugin.
    Topology(Topology),
    /// A command pane's command exited — the crash/finish signal (offer relaunch).
    PaneExited {
        pane_id: u32,
        exit_code: Option<i32>,
    },
    /// A pane was fully closed in the live session.
    PaneClosed { pane_id: u32 },
    // --- Voice mode (voice-mode-tui-port-2026-06-05) ---
    /// A terminal key RELEASE. Only delivered when the kitty keyboard protocol
    /// is active (most terminals never emit it); drives hold-to-talk PTT. Press
    /// + Repeat still arrive as `Key`, so every existing binding is unaffected.
    KeyRelease(KeyEvent),
    /// A voice-pipeline state change (record → transcribe → converse → speak),
    /// sourced from the PTT turn task. See `app::VoicePhase`.
    Voice(VoiceMsg),
}

/// A message from the voice PTT pipeline (voice-mode-tui-port-2026-06-05).
#[derive(Debug, Clone)]
pub enum VoiceMsg {
    /// Mic capture opened (or failed to open — `Err` carries why).
    Started(std::result::Result<(), String>),
    /// Whisper transcribed the utterance — inject it as the user's turn.
    Transcribed(String),
    /// The reply is being synthesized + played.
    Speaking,
    /// The turn finished (reply spoken, or nothing to say) — back to idle.
    Finished,
    /// The pipeline failed (STT/converse/TTS) — surfaced in the status line.
    Error(String),
}

/// Spawn the blocking input reader. Emits `Key` on input and `Tick` otherwise,
/// so the loop stays responsive without a busy-wait. Returns when the channel
/// receiver is dropped.
///
/// Press + Repeat forward as `Key` (so held nav keys still autorepeat and every
/// existing binding is untouched); Release forwards as `KeyRelease` (only ever
/// emitted when the kitty keyboard protocol is active — see main's enhancement
/// push — which drives hold-to-talk PTT). Without the protocol no Release events
/// arrive, so PTT falls back to press-to-toggle (voice-mode-tui-port D-007).
pub fn spawn_input_listener(tx: UnboundedSender<Event>) {
    use crossterm::event::KeyEventKind;
    std::thread::spawn(move || loop {
        match event::poll(Duration::from_millis(250)) {
            Ok(true) => {
                if let Ok(CtEvent::Key(key)) = event::read() {
                    let ev = match key.kind {
                        KeyEventKind::Release => Event::KeyRelease(key),
                        // Press + Repeat → Key (preserves pre-enhancement behavior).
                        _ => Event::Key(key),
                    };
                    if tx.send(ev).is_err() {
                        break;
                    }
                }
            }
            Ok(false) => {
                if tx.send(Event::Tick).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    });
}
