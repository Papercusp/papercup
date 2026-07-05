//! Application state + the single update reducer (SP-TUI A2 / P1 Create tab).
//!
//! `App` is the whole UI state; `update` is the only mutator. Rendering is a
//! pure function of `&App` (see `ui.rs`), so views are snapshot-testable.

use crate::event::Event;
use crate::fleet::FleetState;
use crate::models::{
    ActivityRow, AttentionItem, ChatMessage, ChatToolCall, CrewMember, DocsResponse,
    EffectiveClaudeSettings, FlagsResponse, FleetRateStatus, HarnessFeature, HarnessIssue,
    HarnessRef, Notif, OperatorConfig, PlanItemStates, PlanSummary, RosterEntry, TestingDomain,
    TuiPaneContribution, ViewState, WorkItem,
};
use crate::mux::PaneSpec;
use crossterm::event::{KeyCode, KeyModifiers};
use pui_companion_proto::Topology;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

/// Cap on retained notification history (P8).
const NOTIF_HISTORY_CAP: usize = 50;

/// The Cupboard kind-filter cycle (D-011): `f` steps through these;
/// `cupboard_kind` indexes this array. "all" sends no `kind` param.
pub const CUPBOARD_KINDS: [&str; 5] = ["all", "harness", "blueprint", "snapshot", "plugin"];

/// The Conversations state-filter cycle (Brief 25): `s` steps through these;
/// `conv_state_idx` indexes this array. "all" sends no `state` param.
pub const CONV_STATES: [&str; 4] = ["open", "resolved", "closed", "all"];
/// The Conversations kind-filter cycle (Brief 25): `t` steps through these;
/// `conv_kind_idx` indexes this array. "all" sends no `kind` param.
pub const CONV_KINDS: [&str; 3] = ["all", "question", "discussion"];
/// Rows the comms detail popup scrolls per PageDown/PageUp (owner ask 2026-06-14).
pub const FLEET_DETAIL_SCROLL_STEP: u16 = 6;

/// What the run-loop should do after handling one event.
/// (No `Eq`: `VoiceChan(VoiceCmd)` carries a `serde_json::Value` for prefs
/// patches, which isn't `Eq`. `PartialEq` is all the run loop needs.)
#[derive(Debug, PartialEq)]
pub enum Action {
    None,
    /// Refetch the plans status board now (the plans-pane's manual `g`). The
    /// standard refetch loop already feeds plans + roster push-driven; this
    /// forces an immediate refresh (pui-plans-status-board-2026-06-14).
    FetchPlansBoard,
    /// Fetch the per-item assignment/claim/liveness for one plan
    /// (pui-plans-status-board-2026-06-14 P-008) so the plans board's right-side
    /// work-items detail updates the instant the selection moves — the active-
    /// plan poller is the freshness backstop.
    FetchPlanItemStates {
        harness: String,
        plan: String,
    },
    /// Refetch the cross-Hive network board now (the network-pane's manual `g`
    /// — the refetch loop covers the push-driven cadence, B-09).
    FetchNetworkBoard,
    /// Open the per-hive drill-in for the selected network-board row (B-09's
    /// Enter seam). The run loop's `// B-10 SEAM:` arm consumes it: tier 1
    /// switches to the dock's `this hive` tab; tiers 2-4 open B-10's generated
    /// per-hive tab (placeholder: a plain named tab until the generator lands).
    OpenNetworkDrillIn(crate::network::DrillInRequest),
    /// A pui docs action (harness-docs-integration P-009): POST regenerate|verify
    /// for the selected doc. The run loop fires it; the refetch loop refreshes the
    /// badges on its next tick.
    DocsAction {
        action: String,
        doc_id: String,
    },
    Render,
    /// Publish the swarm pane's bee selection to the ephemeral relay
    /// (pui-bee-dossier-pane-2026-06-06) so the bee-dossier pane can render it.
    /// The run loop POSTs `fleet:selected_bee { select }`. `owner_id` None clears.
    PublishBeeSelection {
        owner_id: Option<String>,
        name: Option<String>,
    },
    Quit,
    /// Open a native agent session in a new multiplexer pane.
    Launch(PaneSpec),
    /// Reactively open work-area panes for new LOCAL workbench launches
    /// (pui-reactive-session-panes D-006). The run loop opens each `spec` via the
    /// multiplexer (companion when linked, else `zellij action new-pane`) and POSTs
    /// `/api/adv/sessions/mark-launched` for each `adv_session_id` so the pending
    /// row drops out of the roster. The reducer already recorded the ids in the
    /// tracked-pane set, so a refresh in the mark-launched window won't re-open.
    LaunchPanes {
        sessions: Vec<crate::session_panes::SessionPane>,
        /// `claude --resume <session_id>` panes for active fleet bees —
        /// appended to the dock stack (hive-agent-tabs P-004/P-014). Opened
        /// via the zellij CLI only (no companion / no mark-launched).
        bees: Vec<crate::mux::PaneSpec>,
    },
    /// Result of an applied agent control intent (P12b / tui:dispatch) — the run
    /// loop POSTs it to `/api/tui/intents/:id/result`. `result_json` is the JSON
    /// payload (the state snapshot for get_state, or `{"ok":true}`); on failure
    /// `error` is set and `result_json` is `"null"`.
    IntentResult {
        id: i64,
        result_json: String,
        error: Option<String>,
    },
    /// A command-palette workbench command (P12b) — the run loop dispatches it to
    /// the workbench-command task (list/save/restore layouts + crews).
    Workbench(PaletteCommand),
    /// A dockview dock-verb (Brief 50 / dockview-workbench D-008) — the run loop
    /// drives the companion plugin (or a CLI fallback). Carried separately from
    /// `Workbench` because these need the live companion handle + topology, which
    /// live in the run loop, not the workbench-command task.
    Dock(DockCmd),
    /// Send a user message to the operator (tui-operator-surface P1) — the run
    /// loop persists the user turn, opens the converse SSE stream, and feeds
    /// `ChatDelta`/`ChatToolCall`/`ChatDone`/`ChatError` events back. The string
    /// is the message text (the reducer has already appended it + a streaming
    /// assistant bubble before returning this).
    SendChat(String),
    /// Answer the focused inline card (sentinel-tui-shared-backend-and-cards
    /// Phase 2a) — the run loop POSTs `/card-response`. The reducer has already
    /// optimistically dismissed the card from `card_state`. `payload` is the
    /// submit body (`{picks:[…]}` / `{value:…}`), absent for decline/cancel.
    CardRespond {
        correlation_id: String,
        /// The card's own workspace (the wire `VersionedSnapshot.workspaceId`),
        /// preferred over the loop-resolved fallback for the `/card-response`
        /// `expectedWorkspaceId` gate.
        workspace_id: Option<String>,
        action: String,
        payload: Option<serde_json::Value>,
    },
    /// Edit the fleet's hard cap from the Overview top-bar (Brief 23 P-005) —
    /// the run loop PUTs `/api/operator/rate-limit-config` then refetches the
    /// read-model (the reducer already updated the local copy optimistically).
    SetMaxAgents(u32),
    /// Start the realtime EL Conv-AI voice session (voice-realtime-tui P-007)
    /// — the run loop spawns the session task and owns the handle.
    VoiceSessionStart,
    /// Tear the realtime voice session down (user toggle).
    VoiceSessionStop,
    /// Drive one shared-session control on the live operator-voice bus.
    VoiceSessionControl(crate::voice_convai::ConvAiControl),
    /// A P2P voice-channel command from the Voice tab (holepunch-voice-channels
    /// P-008) — the run loop owns the VoiceStream socket + executes it.
    VoiceChan(crate::voice_ui::VoiceCmd),
    /// Focus a worker's zellij pane via the companion (tui-operator-surface P2 —
    /// the `focus_pane` tui:dispatch intent). The run loop drives the companion
    /// and POSTs the intent result back.
    FocusPane {
        intent_id: i64,
        pane_id: u32,
    },
    /// Focus a live terminal pane in THIS workbench (companion) — the user-driven
    /// Enter-by-location LOCAL route (pui-workbench-usability D-001). Distinct
    /// from `FocusPane`: no `tui:dispatch` intent result is POSTed back.
    FocusLocalPane {
        pane_id: u32,
    },
    /// Bring an agent's EXTERNAL terminal window to the front via
    /// `/api/adv/sessions/focus` (Enter-by-location D-001). The run loop calls
    /// `client.focus_session` off the UI thread and toasts the outcome (`label`
    /// names the agent in that toast).
    FocusWindow {
        adv_session_id: Option<i64>,
        pid: Option<i64>,
        window_id: Option<String>,
        label: String,
    },
    /// Fetch the next older page of operator turns (load-earlier / scroll-back).
    /// The reducer already set `chat_loading_earlier`; the run loop snapshots the
    /// conversation id + oldest cursor from App.
    LoadEarlierChat,
    /// Fetch the selected testing domain's runnable files (D-004a) — the run
    /// loop spawns the domain-detail fetch; results return as
    /// `Event::TestingFiles` (stale-guarded by domain id).
    FetchTestingFiles {
        harness: String,
        domain_id: String,
    },
    /// Run one test file via `POST /api/harness/:slug/testing/run` (D-004a).
    /// The reducer already marked the run in-flight; the result returns as
    /// `Event::TestRunDone`.
    RunTest {
        harness: String,
        file: String,
    },
    /// Semantic memory search (D-006 Step 2) — the run loop calls the
    /// `memory:search` tool; hits return as `Event::MemoryHits`.
    SearchMemory {
        query: String,
        harness: String,
    },
    /// One `:set <key.path> <value>` / `:unset <key.path>` Config-tab edit
    /// (D-013) — the run loop fetches the current file, edits the dotted path
    /// (`value: Some` sets, `None` removes), PUTs it back, and refetches the
    /// effective view (returns as `Event::Config`).
    ConfigEdit {
        harness: String,
        key: String,
        value: Option<String>,
    },
    /// Load the selected plugin's saved per-harness config (D-014) — the run
    /// loop GETs `/api/plugins/config` and returns `Event::PluginConfig`.
    LoadPluginConfig {
        harness: String,
        plugin: String,
    },
    /// One `:pset <key.path> <value>` / `:punset <key.path>` plugin-settings
    /// edit on the selected plugin (D-014) — fetch→edit-path→PUT→refetch, result
    /// returns as `Event::PluginConfig`. `value: None` removes the key.
    PluginConfigEdit {
        harness: String,
        plugin: String,
        key: String,
        value: Option<String>,
    },
    /// Fetch Cupboard listings for the active (kind, query) filter (D-011) —
    /// the run loop GETs `/api/cupboard/listings` and the result returns as
    /// `Event::CupboardListings` (stale-guarded by kind+query).
    FetchCupboard {
        kind: String,
        query: String,
    },
    /// Execute the CONFIRMED per-kind Cupboard action (D-011): harness→join,
    /// blueprint→fork (install), snapshot→fork, plugin→install. The reducer
    /// only returns this after the Enter-arm + `y`-confirm two-step.
    CupboardAct {
        listing: crate::models::CupboardListing,
    },
    /// A voice-mode PTT command (voice-mode-tui-port-2026-06-05 P2). The run
    /// loop owns the mic capture handle + the audio player and drives the
    /// record → transcribe → operator-converse → speak pipeline, feeding
    /// `Event::Voice(..)` (and the existing `Chat*` events) back.
    Voice(VoiceCmd),
    /// Fetch the Conversations list (Brief 25) under the active state/kind filter
    /// ("all" → unfiltered). Result returns as `Event::Conversations`.
    FetchConversations {
        state: String,
        kind: String,
    },
    /// Fetch whole-fleet assignments for the default Swarm dossier
    /// (pui-dock-consolidation-2026-06-07 #2) → `Event::FleetAssignments`.
    FetchFleetAssignments,
    /// Fetch the federated p2p roster for the Hives tab
    /// (pui-hives-tab-2026-06-07) → `Event::Hives`.
    FetchHives,
    /// Join every member harness of a discovered hive (p2p-hive-directory P-006):
    /// POST each `links` entry to `/api/harness/join-link`. `slug` is the hive id.
    JoinHive {
        slug: String,
        links: Vec<String>,
    },
    /// P-008: set an agent's wake mode (auto|manual) via coord:wake-mode. The run
    /// loop spawns the run_tool call; the next roster poll refreshes the badge.
    SetWakeMode {
        agent: String,
        mode: String,
    },
    /// P-009: fetch an agent's staged wakes (coord:wake-queue list) for the
    /// review overlay → `Event::WakeQueue`.
    FetchWakeQueue {
        agent: String,
    },
    /// P-009: act on ONE staged wake — `release: true` delivers it (with
    /// `edited` content when the owner edited), `false` skips it. The run loop
    /// re-lists afterwards so the overlay refreshes.
    WakeQueueAct {
        agent: String,
        release: bool,
        id: i64,
        edited: Option<String>,
    },
    /// EI-312: refresh the fleet-wide staged-wake board (roster + per-agent
    /// queue lists) → `Event::WakeBoard`. The wake-pane's manual `g` refresh;
    /// the run loop also polls on a timer while pinned to `Tab::Wake`.
    FetchWakeBoard,
    /// EI-312: act on the wake board — `verb` is the coord:wake-queue action
    /// (release / skip need `id`; release_all / skip_all drain the agent's
    /// whole queue — release_all delivers ONE coalesced wake). The run loop
    /// re-snapshots the board afterwards.
    WakeBoardAct {
        agent: String,
        verb: &'static str,
        id: Option<i64>,
        edited: Option<String>,
    },
    /// P-013: create one zellij tab per (tab_name, kdl) pair via the companion's
    /// NewTab (`new_tabs_with_layout`) — the per-frame tabs.
    CreateFrameTabs {
        tabs: Vec<(String, String)>,
    },
    /// Open the persistent per-hive AXIS tabs (B4 / P-004) — one standing zellij
    /// tab per live federated peer, via the companion's NewTab (same path as the
    /// per-frame tabs). The reducer's diff (`hive_tabs_to_create`) is roster-gated.
    CreateHiveTabs {
        tabs: Vec<(String, String)>,
    },
    /// Load the selected conversation's full thread → `Event::ConversationDetail`
    /// (stale-guarded by id in the reducer).
    FetchConversationDetail {
        id: String,
    },
    /// Promote the selected conversation → an engineer issue (carries the thread).
    /// Outcome rides `Notify`/`Error` + a detail refetch.
    PromoteConversation {
        id: String,
    },
}

/// Where a Fleet-roster agent lives → how Enter reaches it (pui-workbench-
/// usability D-001, "Enter routes by LOCATION"). Resolved purely from the roster
/// entry + the live companion topology + the local host, so it unit-tests
/// without a running workbench. The reducer turns the chosen variant into an
/// [`Action`] (or opens the [`FleetActionMenu`]); the run loop performs the I/O.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentRoute {
    /// A live terminal pane in THIS zellij workbench → focus it (companion).
    LocalPane { pane_id: u32 },
    /// A live agent in an external terminal window → wmctrl focus via
    /// `/api/adv/sessions/focus`.
    FocusWindow {
        adv_session_id: Option<i64>,
        pid: Option<i64>,
        window_id: Option<String>,
    },
    /// An ended/dead session with a launch record → resume it in a new pane
    /// (`psu --resume <adv_session_id>`).
    Resume { spec: PaneSpec },
    /// No single unambiguous action — surface the `[r]/[n]/[f]` menu (D-002), so
    /// Enter never silently focuses empty space.
    Menu(FleetActionMenu),
}

/// The no-reachable-session choices Enter surfaces for a Fleet agent (D-002):
/// `[r] resume · [n] launch · [f] focus window`. Carries the resolved handles so
/// each key fires without re-resolving the route. `[n] launch` is always offered;
/// `r`/`f` only when viable (`can_resume`/`can_focus_window`).
#[derive(Debug, Clone, PartialEq)]
pub struct FleetActionMenu {
    /// Agent label (the menu header).
    pub label: String,
    /// One-line "why you're seeing this" note.
    pub note: String,
    pub can_resume: bool,
    pub can_focus_window: bool,
    /// Pre-built resume pane spec (Some iff `can_resume`).
    pub resume_spec: Option<PaneSpec>,
    /// External-window focus handle (adv_session_id, pid, window_id) — Some iff
    /// `can_focus_window`.
    pub focus: Option<(Option<i64>, Option<i64>, Option<String>)>,
}

/// The staged-wake review overlay's state (hive-agent-tabs P-009 / D-005).
/// Opened with `W` on a Fleet agent; lists the agent's staged wakes with
/// per-wake release / edit & release / skip. Modal while open.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WakeReview {
    /// The agent whose queue is under review (owner id) + its roster label.
    pub agent: String,
    pub label: String,
    pub pending: Vec<crate::models::PendingWake>,
    /// Selection index into `pending`.
    pub sel: usize,
    /// `Some` while the owner is editing the selected wake's content before
    /// release — the live input buffer ("edit" is an action within manual mode,
    /// not a third mode, D-005).
    pub edit: Option<String>,
    /// True until the first list lands.
    pub loading: bool,
    /// True while a release/skip is in flight (blocks double-fires).
    pub busy: bool,
    /// The last fetch/act error, shown inline.
    pub error: Option<String>,
}

impl WakeReview {
    pub fn loading(agent: String, label: String) -> Self {
        Self {
            agent,
            label,
            loading: true,
            ..Self::default()
        }
    }

    /// The selected staged wake, if any.
    pub fn selected(&self) -> Option<&crate::models::PendingWake> {
        self.pending.get(self.sel)
    }
}

/// Which board a pinned agent-context pane renders (dock 4-pane split,
/// owner ask 2026-06-11). One mode per zellij pane: `pui prompt-pane` /
/// `pui mail-pane` / `pui work-pane`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AgentCtxMode {
    /// The prompt the agent runs on: a fleet spawn's RECORDED prompt_body
    /// (with its brief led separately — the per-agent signal), or a live
    /// render of the role persona for interactive agents (the queen).
    #[default]
    Prompt,
    /// Coord mail addressed to / sent by the agent (fleet:bee_mail).
    Mail,
    /// The agent's work items + declared plan + claims (fleet:assignments).
    Work,
}

/// Which agents the wake-pane board shows (owner ask 2026-06-11): the dock's
/// "⏸ wakes" pane shows the whole fleet; a per-agent pane (e.g. "♛⏸ wakes"
/// under the Queen) filters to one agent. `Queen` resolves the live queen
/// from the roster each refresh (the owner id isn't known at layout time and
/// changes when the brain respawns); `Owner` pins an explicit id. `Hive`
/// (P-014 item 3 / D-007 GAP 1) scopes to one hive's attributed owners — the
/// fetch swaps to the server-filtered `network.hive.wakes` query, so the
/// client-side filter passes groups through.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum WakeFilter {
    #[default]
    All,
    Queen,
    Owner(String),
    Hive(String),
}

/// Apply a [`WakeFilter`] to assembled wake groups. Queen resolution prefers
/// the roster (`agent_pane_kind == "queen"` → that owner's groups); a queen
/// missing from the roster falls back to groups the assemble step already
/// kinded "queen" (label/kind ride the same roster join, so this only fires
/// for a stale roster read). Pure — unit-tested.
pub fn filter_wake_groups(
    groups: Vec<crate::models::WakeGroup>,
    filter: &WakeFilter,
    roster: &[crate::models::RosterEntry],
) -> Vec<crate::models::WakeGroup> {
    match filter {
        WakeFilter::All => groups,
        // Hive scope is applied server-side (`network.hive.wakes` rows arrive
        // pre-filtered to the hive's attributed owners) — pass through.
        WakeFilter::Hive(_) => groups,
        WakeFilter::Owner(id) => groups.into_iter().filter(|g| &g.agent == id).collect(),
        WakeFilter::Queen => {
            let queen_owner = roster
                .iter()
                .find(|r| r.agent_pane_kind.as_deref() == Some("queen"))
                .map(|r| r.owner_id.clone());
            groups
                .into_iter()
                .filter(|g| match &queen_owner {
                    Some(owner) => &g.agent == owner,
                    None => g.kind.as_deref() == Some("queen"),
                })
                .collect()
        }
    }
}

/// The fleet-wide staged-wake board (the `pui wake-pane` dock pane, EI-312):
/// every manual-mode agent's pending queue, queen first, replaced wholesale by
/// each `Event::WakeBoard` snapshot. Same review verbs as the `W` overlay
/// (release / edit & release / skip), plus the per-agent drains the EI-312
/// backend added (`release_all` — ONE coalesced wake for the whole queue —
/// and `skip_all`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WakeBoard {
    pub groups: Vec<crate::models::WakeGroup>,
    /// The GLOBAL default wake-mode ("manual" = the whole fleet is paused).
    pub global_mode: Option<String>,
    /// Flat selection index across every group's wakes, in render order.
    pub sel: usize,
    /// `Some` while editing the selected wake's content before release.
    pub edit: Option<String>,
    /// True until the first snapshot lands.
    pub loading: bool,
    /// True while an act is in flight (blocks double-fires).
    pub busy: bool,
    pub error: Option<String>,
}

impl WakeBoard {
    /// Total staged wakes across all groups (the flat selection space).
    pub fn total(&self) -> usize {
        self.groups.iter().map(|g| g.pending.len()).sum()
    }

    /// The selected wake and its owning group, resolved from the flat index.
    pub fn selected(&self) -> Option<(&crate::models::WakeGroup, &crate::models::PendingWake)> {
        let mut i = self.sel;
        for g in &self.groups {
            if i < g.pending.len() {
                return Some((g, &g.pending[i]));
            }
            i -= g.pending.len();
        }
        None
    }
}

/// A push-to-talk command on the Operator tab (voice-mode-tui-port D-007).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceCmd {
    /// Begin mic capture (key down on `v`, or toggle-on).
    Start,
    /// Stop capture and run the turn (key up under the kitty protocol, or
    /// toggle-off).
    Stop,
    /// Abort capture, discard audio (Esc while recording).
    Cancel,
}

/// A resolved dockview dock-verb (Brief 50 / dockview-workbench D-008). The
/// reducer resolves the pure [`PaletteCommand`] dock-verbs against the live
/// topology into one of these (concrete pane ids / preset names); the run loop
/// turns it into companion commands or CLI fallbacks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DockCmd {
    /// `:stack` — gather these work-area terminal panes into one stacked group.
    Stack { pane_ids: Vec<u32> },
    /// `:float [target]` — float a tiled pane / embed a floating one. `None`
    /// targets the HUD (run loop uses `hud_pane_id`, else a focused-pane CLI
    /// fallback); `Some(id)` is a resolved work pane.
    Float { pane_id: Option<u32> },
    /// `:dock <side>` / `:layout <name>` — switch to a named swap-layout preset.
    SelectLayout { name: String },
    /// `:layout next|prev` — cycle the swap-layout preset.
    CycleLayout { next: bool },
}

/// A command-palette workbench command (P12b / D-002). Parsed from the palette
/// input; the run loop executes it asynchronously.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaletteCommand {
    ListLayouts,
    ListCrews,
    SaveCrew(String),
    SaveLayout(String),
    RestoreCrew(String),
    RestoreLayout(String),
    /// `:pickup <item>` / `:pickup <plan> <item>` — convert-at-pickup (D-015):
    /// convert a plan item to a claimed work_item via POST /api/tui/plan-item-convert.
    /// `plan`/`harness` are None at parse; the palette Enter handler resolves them
    /// from the selected plan before dispatch (the parser stays pure).
    PickupPlanItem {
        harness: Option<String>,
        plan: Option<String>,
        item: String,
    },
    /// `:release <item>` / `:release <plan> <item>` — put a picked-up plan item
    /// back (P-005b release half): POST /api/tui/plan-item-release releases the
    /// converted work_item (server-side reflect rules flip the item back to
    /// todo + drop the lease) or, with no live execution record, just the bare
    /// plan-item lease. Plan/harness resolve from the selected plan exactly
    /// like `:pickup` (the parser stays pure).
    ReleasePlanItem {
        harness: Option<String>,
        plan: Option<String>,
        item: String,
    },
    /// `:create <slug> <path-or-github-url>` (D-010) — register a new pot via
    /// `POST /api/harness/projects` (local dir or GitHub clone).
    CreatePot {
        slug: String,
        source: String,
    },
    /// `:share <slug> [github-remote] [public]` (D-010) — the share sequence:
    /// resolve binding → finalize shared.json/swarm → (public only) Cupboard
    /// publish. With no remote given the run loop reads the pot repo's
    /// `origin` remote.
    SharePot {
        slug: String,
        remote: Option<String>,
        public: bool,
    },
    /// `:set <key.path> <value>` — edit the Config tab's settings file (D-013).
    /// Routed to `Action::ConfigEdit` in the reducer, not the workbench task.
    ConfigSet {
        key: String,
        value: String,
    },
    /// `:unset <key.path>` — remove a key from the settings file (D-013).
    ConfigUnset {
        key: String,
    },
    /// `:pset <key.path> <value>` — edit the SELECTED plugin's config (D-014).
    /// The plugin is resolved from `plugin_sel` in the palette-Enter handler.
    PluginSet {
        key: String,
        value: String,
    },
    /// `:punset <key.path>` — remove a key from the selected plugin's config.
    PluginUnset {
        key: String,
    },
    /// `:message <text>` / `:msg <text>` — "Message owner" (inbox-tiering D-004):
    /// open a work-item-scoped conversation with the SELECTED inbox item's owning
    /// agent. `to`/harness/plan_slug/item_ref/title are None at parse; the palette
    /// Enter handler resolves them from the selected inbox item (parser stays pure).
    MessageOwner {
        to: Option<String>,
        harness: Option<String>,
        plan_slug: Option<String>,
        item_ref: Option<String>,
        title: String,
        body: String,
    },
    /// `:stack` — gather the work area into one stacked group (dockview D-008).
    /// Resolved to `DockCmd::Stack` against the live topology at Enter.
    Stack,
    /// `:float [target]` — float/embed the HUD (bare) or a named work pane.
    /// `target` is a pane id or a title/command substring; resolved at Enter.
    Float {
        target: Option<String>,
    },
    /// `:dock <left|right>` — dock the HUD to that side via a mirrored swap preset.
    Dock {
        side: String,
    },
    /// `:layout <next|prev|name>` — cycle or select a swap-layout preset.
    Layout {
        which: String,
    },
    /// `:theme [name]` — flip the active palette (workbench-theme-system P1 /
    /// D-002). Bare `:theme` lists the registry like `:themes`; an unknown
    /// name lists it too instead of erroring silently. App-local — handled in
    /// the palette Enter handler, never dispatched to the workbench task.
    Theme {
        name: Option<String>,
    },
    /// `:themes` — list the registered themes, marking the active one.
    Themes,
}

/// Parse a command-palette line into a `PaletteCommand` (None = unknown). A
/// leading ':' is tolerated. Pure — unit-tested.
pub fn parse_palette_command(input: &str) -> Option<PaletteCommand> {
    let line = input
        .trim()
        .strip_prefix(':')
        .unwrap_or(input.trim())
        .trim();
    let mut it = line.splitn(2, char::is_whitespace);
    let cmd = it.next().unwrap_or("");
    let arg = it.next().unwrap_or("").trim().to_string();
    match cmd {
        "layouts" => Some(PaletteCommand::ListLayouts),
        "crews" => Some(PaletteCommand::ListCrews),
        // `:theme [name]` / `:themes` (workbench-theme-system P1 / D-002) —
        // bare `:theme` behaves like `:themes` (list, never error silently).
        "theme" => Some(PaletteCommand::Theme {
            name: (!arg.is_empty()).then_some(arg),
        }),
        "themes" => Some(PaletteCommand::Themes),
        "save-crew" if !arg.is_empty() => Some(PaletteCommand::SaveCrew(arg)),
        "save-layout" if !arg.is_empty() => Some(PaletteCommand::SaveLayout(arg)),
        "restore-crew" if !arg.is_empty() => Some(PaletteCommand::RestoreCrew(arg)),
        "restore-layout" if !arg.is_empty() => Some(PaletteCommand::RestoreLayout(arg)),
        "pickup" if !arg.is_empty() => {
            // `:pickup P-012` (selected plan) or `:pickup <plan-slug> P-012`.
            let mut parts = arg.split_whitespace().map(|s| s.to_string());
            let first = parts.next().unwrap_or_default();
            match parts.next() {
                Some(item) => Some(PaletteCommand::PickupPlanItem {
                    harness: None,
                    plan: Some(first),
                    item,
                }),
                None => Some(PaletteCommand::PickupPlanItem {
                    harness: None,
                    plan: None,
                    item: first,
                }),
            }
        }
        "release" if !arg.is_empty() => {
            // `:release P-012` (selected plan) or `:release <plan-slug> P-012` —
            // the `:pickup` inverse, same arg shape.
            let mut parts = arg.split_whitespace().map(|s| s.to_string());
            let first = parts.next().unwrap_or_default();
            match parts.next() {
                Some(item) => Some(PaletteCommand::ReleasePlanItem {
                    harness: None,
                    plan: Some(first),
                    item,
                }),
                None => Some(PaletteCommand::ReleasePlanItem {
                    harness: None,
                    plan: None,
                    item: first,
                }),
            }
        }
        // `:create <slug> <path-or-github-url>` — both args required (D-010).
        "create" => {
            let mut parts = arg.splitn(2, char::is_whitespace);
            let slug = parts.next().unwrap_or("").trim().to_string();
            let source = parts.next().unwrap_or("").trim().to_string();
            if slug.is_empty() || source.is_empty() {
                return None;
            }
            Some(PaletteCommand::CreatePot { slug, source })
        }
        // `:share <slug> [remote] [public]` — slug required; a bare `public`
        // token flags Cupboard publish; any other extra token is the remote.
        "share" => {
            let mut slug = String::new();
            let mut remote: Option<String> = None;
            let mut public = false;
            for tok in arg.split_whitespace() {
                if slug.is_empty() {
                    slug = tok.to_string();
                } else if tok.eq_ignore_ascii_case("public") {
                    public = true;
                } else if remote.is_none() {
                    remote = Some(tok.to_string());
                } else {
                    return None; // too many args
                }
            }
            if slug.is_empty() {
                return None;
            }
            Some(PaletteCommand::SharePot {
                slug,
                remote,
                public,
            })
        }
        // Config-tab editor (D-013): `:set <key.path> <value>` / `:unset <key.path>`.
        "set" if !arg.is_empty() => {
            let mut kv = arg.splitn(2, char::is_whitespace);
            let key = kv.next().unwrap_or("").to_string();
            let value = kv.next().unwrap_or("").trim().to_string();
            if key.is_empty() || value.is_empty() {
                None
            } else {
                Some(PaletteCommand::ConfigSet { key, value })
            }
        }
        "unset" if !arg.is_empty() => Some(PaletteCommand::ConfigUnset { key: arg }),
        // Plugin-settings editor (D-014): `:pset <key.path> <value>` /
        // `:punset <key.path>` — operate on the SELECTED plugin (resolved at
        // dispatch, so the parser stays pure).
        "pset" if !arg.is_empty() => {
            let mut kv = arg.splitn(2, char::is_whitespace);
            let key = kv.next().unwrap_or("").to_string();
            let value = kv.next().unwrap_or("").trim().to_string();
            if key.is_empty() || value.is_empty() {
                None
            } else {
                Some(PaletteCommand::PluginSet { key, value })
            }
        }
        "punset" if !arg.is_empty() => Some(PaletteCommand::PluginUnset { key: arg }),
        // `:message <text>` / `:msg <text>` — "Message owner" on the selected inbox
        // item (D-004). Fields None at parse; resolved from the selection at Enter.
        "message" | "msg" if !arg.is_empty() => Some(PaletteCommand::MessageOwner {
            to: None,
            harness: None,
            plan_slug: None,
            item_ref: None,
            title: String::new(),
            body: arg,
        }),
        // ── dockview dock-verbs (Brief 50 / D-008) ──
        // `:stack` — gather the work area into one stacked group.
        "stack" => Some(PaletteCommand::Stack),
        // `:float [target]` — bare floats the HUD; an arg targets a work pane.
        "float" => Some(PaletteCommand::Float {
            target: if arg.is_empty() { None } else { Some(arg) },
        }),
        // `:dock <left|right>` — dock the HUD to a side (mirrored preset).
        "dock" if !arg.is_empty() => Some(PaletteCommand::Dock { side: arg }),
        // `:layout <next|prev|name>` — cycle or select a swap preset.
        "layout" if !arg.is_empty() => Some(PaletteCommand::Layout { which: arg }),
        _ => None,
    }
}

/// Parse a `:set` value: JSON when it parses (numbers, booleans, null, arrays,
/// objects, quoted strings), bare string otherwise — so `:set cleanupPeriodDays
/// 60` sets a number while `:set model claude-opus-4-8` sets a string. Pure.
pub fn parse_config_value(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

/// Set (`Some`) or remove (`None`) a dotted path inside a JSON object tree,
/// creating intermediate objects on set. Errors when a path segment lands on a
/// non-object (never silently clobbers a scalar with a subtree); `:unset` of a
/// missing path is a no-op. Pure — unit-tested.
pub fn edit_json_path(
    root: &mut Value,
    path: &str,
    mut value: Option<Value>,
) -> Result<(), String> {
    let segs: Vec<&str> = path.split('.').filter(|s| !s.is_empty()).collect();
    if segs.is_empty() {
        return Err("empty key path".into());
    }
    let setting = value.is_some();
    let mut cur = root;
    for (i, seg) in segs.iter().enumerate() {
        let last = i + 1 == segs.len();
        let obj = cur
            .as_object_mut()
            .ok_or_else(|| format!("`{}` is not an object", segs[..i].join(".")))?;
        if last {
            match value.take() {
                Some(v) => {
                    obj.insert((*seg).to_string(), v);
                }
                None => {
                    obj.remove(*seg);
                }
            }
            return Ok(());
        }
        if setting {
            cur = obj
                .entry((*seg).to_string())
                .or_insert_with(|| Value::Object(Default::default()));
        } else {
            match obj.get_mut(*seg) {
                Some(next) => cur = next,
                None => return Ok(()), // :unset of a missing path — nothing to do
            }
        }
    }
    Ok(())
}

/// The workbench tabs. Variant identifiers are stable wire/route keys and are
/// deliberately NOT renamed (D-001 is label-only): `Tab::Harnesses` titles as
/// **Pots** and `Tab::Fleet` titles as **Fleet** (the cup-theme rename was
/// reverted by the owner 2026-06-05, RFC D-014).
/// Order + switch keys are the single source of truth — `draw_tabs` labels and
/// the keyboard dispatch both derive from `ALL` + `switch_key` (g1: no dual map).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    /// Overview — the dashboard landing surface (overview-dashboard-2026-06-05,
    /// Brief 23): top bar (usage/spend/max, stub until rate-limit-layer-v2's
    /// read-model lands) + Plans · Needs-you · Agents · Activity tiles + the
    /// always-on operator strip (Brief 24's draw_operator_dock). Leads the
    /// strip and is the DEFAULT startup tab; key 'h' (home) — the ten digits
    /// stay on the original lead tabs to avoid a fleet-wide renumber.
    Overview,
    /// Operator chat pane (tui-operator-surface-2026-06-04) — the conversational
    /// front door (key '1'). No longer the startup tab (Overview is, Brief 23
    /// D-001) but still always-on: the Overview bottom strip + the `o` right
    /// dock render the same chat state.
    Operator,
    Inbox,
    Plans,
    /// Fleet — the fleet monitoring + agent-launch surface. Titles as "Fleet"
    /// (the cup-theme rename was reverted by the owner 2026-06-05);
    /// absorbed the old Sessions launcher (D-002b: roster + dossier + n-launch
    /// fold into the fleet view).
    Fleet,
    /// Pots — the per-project features/issues surface (`Tab::Harnesses` variant,
    /// titled "Pots" per D-001).
    Harnesses,
    Docs,
    Testing,
    Config,
    Plugins,
    Settings,
    /// Memory browser (D-006 Step 2) — whatever the configured memory backend
    /// holds (mem0 today; the MemoryBackend seam later). Appended; key 'm'.
    Memory,
    /// Cupboard (D-011) — the marketplace: browse/search the 4 listing kinds
    /// (harness/blueprint/snapshot/plugin) + per-kind join/fork/install, all
    /// against the existing `/api/cupboard/*` routes. Appended; key 'c'.
    Cupboard,
    /// Conversations (conversations-tab-2026-06-05, Brief 25) — browse the coord
    /// conversations substrate (questions/discussions + threads + topics) with
    /// state/kind/topic filters, a detail thread + accepted answer + linked
    /// work-item, and promote-to-issue. Appended; key 'd' (Discuss).
    Conversations,
    /// Voice (holepunch-voice-channels-2026-06-05 P-008) — P2P user↔user voice
    /// channels over the operator voice node. Appended; key 'a' (audio). The
    /// operator Conv-AI voice MODE (voice-realtime-tui) is a dock toggle, not
    /// this tab — agreed division, coord 2026-06-05.
    Voice,
    /// Hives — the p2p swarm roster (pui-hives-tab-2026-06-07): every remote
    /// Papercusp install (machine) that has announced into the Model-B
    /// substrate (`shared_presence`), grouped by device. Replaces the Cupboard
    /// in the dock MAIN pane's tab subset; key 'i'.
    Hives,
    /// Wakes — the fleet-wide staged-wake board (EI-312): every manual-mode
    /// agent's pending wakes, queen first, with release / edit / skip and the
    /// release-all/skip-all drains. PANE-ONLY: not in `ALL` (no tab-strip slot,
    /// no switch key) — it renders solely as the dock's pinned `pui wake-pane`.
    /// (A one-pane `agent-pane` [chat | wakes] variant was tried + REVERTED
    /// 2026-06-11 — owner directive: dock agent chats are LIVE TUIs, never
    /// pui-rendered substitutes; pui panes are for data boards like this one.)
    Wake,
    /// Agent-context board (dock 4-pane split, owner ask 2026-06-11): ONE data
    /// pane about ONE agent — the prompt it runs on (`pui prompt-pane`), its coord
    /// mail (`pui mail-pane`), or its work items + plan linkage
    /// (`pui work-pane`). PANE-ONLY like Wake: no tab-strip slot, no switch
    /// key; the mode + agent scope come from the subcommand. Stacked with the
    /// wake board in the dock's per-agent side column.
    AgentCtx,
    /// Network — the aggregate cross-Hive board (hive-network-surface-2026-06-11
    /// B-09): one pinned-C-3 row per hive-context over the capability ladder,
    /// tier-badged, sections conditional on data availability. PANE-ONLY like
    /// Wake: renders solely as the dock `network` tab's pinned
    /// `pui network-pane` (and, focused on one key, as `pui hive-pane <key>`
    /// inside B-10's per-hive drill-in tabs). The user-facing name is
    /// "Network" — NEVER "Apiary" (C-5: reserved by the instance gym).
    Network,
    /// Plans status board (pui-plans-status-board-2026-06-14): a read-only
    /// summary of every plan — status, whether it is being worked on, the agent
    /// count (roster rows whose `current_plan_slug` matches), and item progress
    /// (done/total, plus wip/blocked/needs-human). PANE-ONLY like Wake/Network:
    /// not in `ALL` (no tab-strip slot, no switch key) — it renders solely as
    /// the dock `plans` tab's pinned `pui plans-pane`. A DATA board (owner
    /// directive: dock data boards are pui-rendered, chats are live TUIs).
    PlansBoard,
}

impl Tab {
    // NOTE: the old Activity tab was RETIRED (D-004b): it mirrored the coarse
    // audit_log, and the Fleet tab's mirror mode already rides the richer
    // `agent_activity` bridge — a re-point would have duplicated Fleet exactly.
    pub const ALL: [Tab; 16] = [
        Tab::Overview,
        Tab::Operator,
        Tab::Inbox,
        Tab::Plans,
        Tab::Fleet,
        Tab::Harnesses,
        Tab::Docs,
        Tab::Testing,
        Tab::Config,
        Tab::Plugins,
        Tab::Settings,
        Tab::Memory,
        Tab::Cupboard,
        Tab::Conversations,
        Tab::Voice,
        Tab::Hives,
    ];
    pub fn title(self) -> &'static str {
        match self {
            Tab::Overview => "Overview",
            Tab::Operator => "Operator",
            Tab::Inbox => "Inbox",
            Tab::Plans => "Plans",
            // D-001 label-only rename: Harnesses→Pots. The cup-theme rename
            // was REVERSED by the owner (2026-06-05) — "Fleet is clearer".
            Tab::Fleet => "Fleet",
            Tab::Harnesses => "Pots",
            Tab::Docs => "Docs",
            Tab::Testing => "Testing",
            Tab::Config => "Config",
            Tab::Plugins => "Plugins",
            Tab::Settings => "Settings",
            Tab::Memory => "Memory",
            Tab::Cupboard => "Cupboard",
            Tab::Conversations => "Convos",
            Tab::Voice => "Voice",
            Tab::Hives => "Hives",
            Tab::Wake => "Wakes",
            Tab::AgentCtx => "Agent",
            Tab::Network => "Network",
            Tab::PlansBoard => "PlansBoard",
        }
    }
    /// The DISPLAY label for this tab through the active Hive lexicon
    /// (pui-hive-lexicon-2026-06-06). Distinct from `title()`, which is the STABLE
    /// identity string (persistence keys, `from_title`, agent-facing state) and
    /// must never shift when the flag flips. Only the tabs whose title maps to a
    /// lexicon term key change (Fleet→Swarm, Pots→Hive(s), Cupboard→Comb,
    /// Operator→Queen); every other tab returns its `title()` verbatim.
    pub fn label(self, lex: &crate::lexicon::Lexicon) -> String {
        match self {
            // "Pots" is the plural of the `pot` term.
            Tab::Harnesses => lex.lex_plural("pot"),
            Tab::Fleet => lex.lex("fleet"),
            Tab::Cupboard => lex.lex("cupboard"),
            Tab::Operator => lex.lex("operator"),
            // "Hives" is the plural of the `hive` term (a swarm-joined install).
            Tab::Hives => lex.lex_plural("hive"),
            other => other.title().to_string(),
        }
    }
    /// The keyboard shortcut that switches to this tab — the ONLY keymap (the
    /// dispatch in `on_key` derives from it, g1). The ten ORIGINAL lead tabs
    /// keep the ten digits (1-9, 0); Overview (the landing tab, prepended)
    /// takes 'h' (home) so the digits don't renumber fleet-wide; other
    /// appended tabs take a mnemonic letter (Memory → 'm', Cupboard → 'c').
    pub fn switch_key(self) -> char {
        match self {
            Tab::Overview => 'h',
            Tab::Operator => '1',
            Tab::Inbox => '2',
            Tab::Plans => '3',
            Tab::Fleet => '4',
            Tab::Harnesses => '5',
            Tab::Docs => '6',
            Tab::Testing => '7',
            Tab::Config => '8',
            Tab::Plugins => '9',
            Tab::Settings => '0',
            Tab::Memory => 'm',
            Tab::Cupboard => 'c',
            Tab::Conversations => 'd',
            Tab::Voice => 'a',
            // hIves — 'h' is Overview (home), so the mnemonic falls to 'i'.
            Tab::Hives => 'i',
            // Pane-only (not in ALL) — unreachable from the strip; the char is
            // never dispatched (from_switch_key scans ALL).
            Tab::Wake => 'W',
            Tab::AgentCtx => 'X',
            Tab::Network => 'N',
            Tab::PlansBoard => 'B',
        }
    }
    pub fn index(self) -> usize {
        Tab::ALL.iter().position(|t| *t == self).unwrap_or(0)
    }
    /// Resolve a tab from its display title (used to restore persisted view-state
    /// by title, so a tab reorder doesn't land the user on the wrong tab).
    pub fn from_title(s: &str) -> Option<Tab> {
        Tab::ALL.iter().copied().find(|t| t.title() == s)
    }
    /// Resolve a tab from its keyboard switch shortcut (the unified dispatch, g1).
    pub fn from_switch_key(c: char) -> Option<Tab> {
        Tab::ALL.iter().copied().find(|t| t.switch_key() == c)
    }
}

/// Which column the Harnesses tab has keyboard focus on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HarnessFocus {
    Features,
    Issues,
}

/// Which column the Testing tab has keyboard focus on (D-004a): the domain
/// list (left) or the selected domain's runnable files (right).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TestingFocus {
    Domains,
    Files,
}

/// Which pane of the Plans master-detail surface holds keyboard focus (owner ask
/// 2026-06-16): the plans LIST (left) or the selected plan's work-ITEMS (bottom
/// right). ←/→ (or ↑/↓ while browsing) switch the two; Enter drills in; ↑/↓ then
/// move within. Shared by the in-app Plans tab AND the dock's pinned plans-pane
/// (`Tab::Plans` / `Tab::PlansBoard`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlansFocus {
    List,
    Items,
}

impl PlansFocus {
    /// The other pane (List ↔ Items) — the ←/→ / browse toggle.
    pub fn toggle(self) -> PlansFocus {
        match self {
            PlansFocus::List => PlansFocus::Items,
            PlansFocus::Items => PlansFocus::List,
        }
    }
}

/// Step a clamped list cursor by `delta` (±1), saturating at both ends; an empty
/// list stays at 0. Shared by the Plans two-level nav arms.
fn step_clamped(cur: usize, delta: isize, len: usize) -> usize {
    if len == 0 {
        0
    } else if delta > 0 {
        (cur + 1).min(len - 1)
    } else {
        cur.saturating_sub(1)
    }
}

/// Which sub-view of the Plugins tab has focus (D-007/D-014). `Tab` toggles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginsFocus {
    /// Installed plugin manifests — contributions (frontend/backend) + settings.
    List,
    /// Plugin-contributed launchable TUI panes (the original D-002 view).
    Panes,
}

/// One test run's lifecycle on the Testing tab (D-004a): in-flight, then the
/// finished status + tail output. Replaced wholesale per run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestRunState {
    pub running: bool,
    /// The file being run (the run pane's title).
    pub file: String,
    /// "pass" | "fail" once finished; empty while running.
    pub status: String,
    /// Tail of the runner output (server clips to ~8000 chars).
    pub output: String,
}

/// Root application state. Grows as more panels are ported.
pub struct App {
    pub should_quit: bool,
    pub status: String,
    pub tab: Tab,
    /// Single-pane dock mode (native-terminal-desktop P-013 / D-011): when set,
    /// the renderer shows JUST this tab's body full-screen (no tab strip / HUD /
    /// work area) and the run loop re-pins `tab` to it. The chat dock's operator
    /// pane pins Operator (`pui chat-pane`); the voice pane pins Voice
    /// (`pui voice-pane`). All data wiring is unchanged.
    pub pinned: Option<Tab>,
    pub plans: Vec<PlanSummary>,
    pub plan_sel: usize,
    /// Highlight cursor for the pinned plans status board (`pui plans-pane`,
    /// pui-plans-status-board-2026-06-14). Indexes `plans_board::board_rows`.
    pub plans_board_sel: usize,
    /// Two-level pane nav for the Plans master-detail surface (owner ask
    /// 2026-06-16) — shared by `Tab::Plans` + `Tab::PlansBoard` (only one is the
    /// active tab at a time, so they share the cursor/focus/entered state):
    /// which pane is focused (plans list ↔ work items), whether we've drilled in
    /// (↑/↓ move WITHIN vs switch panes), and the work-items cursor. Reset on tab
    /// entry. The items come from `plan_item_states` (fetched for the selected
    /// plan), so the cursor is shared too.
    pub plans_focus: PlansFocus,
    pub plans_entered: bool,
    pub plan_items_sel: usize,
    /// Merged plan-item assignment/claim/liveness for the SELECTED plan (P-005a),
    /// or None until fetched. Rendered in the Plans detail pane; the draw guards on
    /// `plan == selected_plan().slug` so a stale fetch never paints the wrong plan.
    pub plan_item_states: Option<PlanItemStates>,
    pub roster: Vec<RosterEntry>,
    /// adv_session ids the pui has already opened a reactive work-area pane for
    /// this run (pui-reactive-session-panes D-003/D-006). Dedups against the
    /// roster's `pending` tier so a refresh never re-opens a pane; keyed on the
    /// STABLE advSessionId, never pid. Starts empty each run — a restart cannot
    /// double-pane because live sessions are never in `pending` (P-010).
    pub tracked_panes: crate::session_panes::TrackedPanes,
    /// EI-358: may THIS process react to pending workbench launches at all?
    /// True for the full TUI / chat-pane / dock-driver (claim-then-open settles
    /// races between them); false for the board panes (watch/wake/prompt/mail/
    /// work/network/hive), which must never launch sessions.
    pub reactive_launch_panes: bool,
    /// This machine's hostname (pui-reactive-session-panes P-009), resolved once
    /// at startup the way the backend stamps a pending launch's `host`. Gates the
    /// LOCAL predicate for reactive panes so only this box's launches are paned.
    pub local_host: String,
    pub inbox: Vec<AttentionItem>,
    pub inbox_sel: usize,
    /// Overview tab (Brief 23): which of the four tiles the cursor is on —
    /// 0 Plans · 1 Needs-you · 2 Agents · 3 Activity. j/k cycle; Enter opens
    /// the tile's full tab (D-007).
    pub overview_sel: usize,
    /// Fleet rate/usage read-model for the Overview top-bar (P-005;
    /// rate-limit-layer-v2). None until the first fetch lands (or when the
    /// host predates the route) — the top-bar renders dashes then.
    pub fleet_rate: Option<FleetRateStatus>,
    /// Harnesses tab: the harness list + selection + the active harness's data.
    pub harnesses: Vec<HarnessRef>,
    pub harness_sel: usize,
    /// Active harness slug (display copy of `active_harness`).
    pub harness: String,
    /// POTS scope axis (D-003, matching the desktop's two-axis model): `?slug=`
    /// is WHICH pot is active (`harness`, always a real slug); this flag is HOW
    /// WIDE the global list tabs (Plans / Inbox / Fleet) read — `true` = "All
    /// Pots" (unfiltered), `false` = scoped to the active pot. The "all"
    /// sentinel lives on this axis, never in `harness`.
    pub all_pots: bool,
    /// Pot-selector overlay (D-003; clone of the palette/notifs overlay
    /// pattern): open flag + cursor over ["All Pots", ...harnesses].
    pub pot_picker_open: bool,
    pub pot_picker_sel: usize,
    /// Shared active-harness slug the backend poller reads each loop.
    pub active_harness: Arc<Mutex<String>>,
    /// Shared (harness, plan) the poller fetches plan-item-states for (P-005a) —
    /// the selected plan while the Plans tab is focused, else None (skip the fetch).
    /// Published by the reducer, exactly like `active_harness`/`active_doc`.
    pub active_plan: Arc<Mutex<Option<(String, String)>>>,
    pub features: Vec<HarnessFeature>,
    pub feat_sel: usize,
    pub issues: Vec<HarnessIssue>,
    pub issue_sel: usize,
    /// Which Harnesses column has focus (j/k + detail follow it).
    pub harness_focus: HarnessFocus,
    /// Two-level nav for the side-by-side 2-pane tabs — Pots (features|issues)
    /// and Testing (domains|files) — (owner ask 2026-06-15 #2, the Fleet model
    /// ported): false = BROWSING (↑/↓ switch the focused pane, Enter drills in);
    /// true = INSIDE (↑/↓ move within, Enter acts, Esc steps out). Reset on every
    /// tab switch. The Fleet tab keeps its own `fleet.entered`. (Plugins is
    /// excluded — its `Tab` swaps full-screen sub-views, not side-by-side panes.)
    pub pane_entered: bool,
    /// Docs tab: file list + selection + the active doc's content + scroll.
    pub docs_files: Vec<String>,
    pub doc_sel: usize,
    pub doc_content: String,
    pub doc_scroll: u16,
    /// Merged-doc model (harness-docs-integration P-009): per-doc source + drift
    /// status for the badges, + the active doc's source/status/overlay.
    pub doc_entries: Vec<crate::models::DocEntry>,
    pub doc_active: Option<crate::models::ActiveDocEntry>,
    /// Shared selected-doc path the poller fetches (None → endpoint's default).
    pub active_doc: Arc<Mutex<Option<String>>>,
    /// Testing tab: testing domains for the active harness.
    pub testing: Vec<TestingDomain>,
    pub testing_sel: usize,
    /// Testing tab run-on-click (D-004a): the selected domain's runnable files
    /// (fetched on Enter via domain-detail), the file cursor, which column has
    /// focus, whether a file fetch is in flight, and the last/in-flight run.
    pub testing_files: Vec<String>,
    pub testing_file_sel: usize,
    pub testing_focus: TestingFocus,
    pub testing_files_loading: bool,
    pub test_run: Option<TestRunState>,
    /// Config tab (D-013): the active harness's *effective* claude-settings —
    /// Claude Code defaults overlaid by `.claude/settings.json`, plus the raw
    /// file body. Editable via the `:set <key.path> <value>` / `:unset
    /// <key.path>` palette commands (Action::ConfigEdit round-trips the PUT).
    pub config: EffectiveClaudeSettings,
    /// Plugins tab (D-002): plugin-contributed TUI panes for the active harness +
    /// the selection cursor. Enter launches the selected pane in a mux pane.
    pub panes: Vec<TuiPaneContribution>,
    pub pane_sel: usize,
    /// Plugins tab (D-007/D-014): the installed plugin manifests + cursor + which
    /// sub-view is focused (List = manifests/contributions/settings, the new
    /// default; Panes = the launchable tui-panes, Tab toggles). `plugin_config`
    /// is the SELECTED plugin's saved per-harness config (loaded on selection /
    /// refreshed after a `:pset`/`:punset` round-trip; the String is the plugin
    /// it belongs to, so a stale fetch never paints another plugin's settings).
    pub plugins: Vec<crate::models::PluginManifest>,
    pub plugin_sel: usize,
    pub plugins_focus: PluginsFocus,
    pub plugin_config: Option<(String, serde_json::Value)>,
    /// Memory tab (D-006 Step 2): the backend's memories (`memory:list`), an
    /// optional search-hit overlay (`memory:search` — shown instead of the
    /// list while a query is active), the cursor, whether the backend reported
    /// itself available, and the `/`-search composer state.
    /// Hives tab (pui-hives-tab-2026-06-07): the federated p2p roster (raw
    /// shared_presence rows; grouped per-machine at render) + the list cursor.
    pub hives: Vec<crate::models::PresenceRow>,
    /// The P2P hive directory (p2p-hive-directory P-006) — discovered hives to
    /// browse + join, via `GET /api/discovery/pots`. `hive_dir_sel` is the
    /// selected directory row (for the Join CTA).
    pub hive_directory: Vec<crate::models::DiscoveredHiveRow>,
    pub hive_dir_sel: usize,
    pub hive_sel: usize,
    /// The cross-Hive network board (hive-network-surface-2026-06-11 B-09):
    /// the pinned-C-3 rows + cursor. Fed by the refetch loop (quietly optional
    /// until B-08's endpoint lands); rendered by the pinned `Tab::Network`.
    pub network_rows: Vec<crate::models::NetworkBoardRow>,
    pub network_sel: usize,
    /// `pui hive-pane <key>` (the primary pane of B-10's per-hive drill-in
    /// tabs): render ONLY this key's dossier, full-pane. `None` = the board.
    pub network_focus: Option<String>,
    /// The drill-in dossier data for the pinned `network_focus` key (P-014
    /// item 2): captured beacon history + the full C-1 ask log. Both empty
    /// outside hive-pane mode (and for keys with no traffic — sections hide).
    pub hive_beacons: Vec<crate::models::HiveBeaconSnapshot>,
    pub hive_asks: Vec<crate::models::CrossHiveAskRow>,
    pub memories: Vec<crate::models::MemoryEntry>,
    pub memory_hits: Option<(String, Vec<crate::models::MemoryEntry>)>,
    pub memory_sel: usize,
    pub memory_available: bool,
    pub memory_search_open: bool,
    pub memory_search_input: String,
    /// Cupboard tab (D-011): the fetched listings under the active kind filter
    /// (`cupboard_kind` indexes `CUPBOARD_KINDS`) + search query, the cursor,
    /// the in-flight flag, the `/`-search composer state, and the armed
    /// confirm — a per-kind action (join/fork/install) fires only after Enter
    /// arms a listing id and `y` confirms it.
    pub cupboard: Vec<crate::models::CupboardListing>,
    pub cupboard_sel: usize,
    pub cupboard_kind: usize,
    pub cupboard_query: String,
    pub cupboard_search_open: bool,
    pub cupboard_search_input: String,
    pub cupboard_loading: bool,
    pub cupboard_confirm: Option<String>,
    /// Conversations tab (Brief 25): the fetched conversation list under the
    /// active state/kind filter (`conv_state_idx` indexes `CONV_STATES`,
    /// `conv_kind_idx` indexes `CONV_KINDS`; "all" sends no filter), an optional
    /// client-side topic filter, the selection cursor, the in-flight flag, and
    /// the selected conversation's loaded detail (thread + accepted answer +
    /// linked work-item).
    pub conversations: Vec<crate::models::ConvSummary>,
    pub conversation_sel: usize,
    pub conv_state_idx: usize,
    pub conv_kind_idx: usize,
    pub conv_topic: Option<String>,
    pub conversations_loading: bool,
    pub conversation_detail: Option<crate::models::ConvDetail>,
    /// Settings tab (P10): operator feature flags (key, enabled), sorted; the
    /// flag-backend source ('defaults'/'posthog'); + the selection cursor.
    /// Read-only v1 — the full per-group settings port lives on the desktop.
    pub flags: Vec<(String, bool)>,
    pub flags_source: String,
    pub flag_sel: usize,
    /// Settings tab (P10b): the read-only operator-config overview — AI backend +
    /// per-role models + connected speech providers. Read-only; write-side settings
    /// (credentials/OAuth/pairing/wake-word) stay on the desktop.
    pub operator_config: OperatorConfig,
    /// The agent sessions this pui has launched this run (P12b crew roster). Each
    /// Action::Launch of a `psu` pane appends one; `:save-crew` persists the set.
    /// Append-only for v1 (pruning a closed pane is a follow-on).
    pub launched: Vec<CrewMember>,
    pub last_error: Option<String>,
    /// Help overlay visible.
    pub show_help: bool,
    /// Command palette open + its current input buffer.
    pub palette_open: bool,
    pub palette_input: String,
    /// Always-on presence sidebar visible (P7 — who's online + intent). `p` toggles.
    pub show_presence: bool,
    /// Plans-filter rail (D-009 — Inbox + Fleet). `plan_filter` is the selected
    /// plan slugs (empty = no filtering); `plan_filter_open` shows the
    /// collapsible left rail (`F` toggles on the two tabs it narrows);
    /// `plan_filter_sel` is the rail's own cursor into `visible_plans()`.
    pub plan_filter: BTreeSet<String>,
    pub plan_filter_open: bool,
    pub plan_filter_sel: usize,
    /// Detail popup (owner ask 2026-06-14): true while a detail view is open —
    /// over the Fleet pane (a mail/conversation in the comms view, or a plan in
    /// the plan-progress panel) or over the Plans tab (the selected plan, owner
    /// ask 2026-06-15). Modal — Esc/`q` close, `j`/`k` step to the next/prev
    /// item, PageUp/PageDown scroll the body. `fleet_detail_scroll` is the body's
    /// row offset (reset on open + on item change; clamped to the content at
    /// render). Transient; not persisted.
    pub fleet_detail_open: bool,
    pub fleet_detail_scroll: u16,
    /// First-run tutorial overlay (P9). `show_tutorial` is set true at startup
    /// when the device hasn't completed it (and re-openable via F1);
    /// `tutorial_step` is the current 0-based step. Default hidden so tests and
    /// the reducer aren't perturbed — `main` decides the initial value.
    pub show_tutorial: bool,
    pub tutorial_step: usize,
    /// Notifications (P8). `notifs` is the history (newest-first, seeded from
    /// `/api/toast-log` + appended live `attention.notify` events); `toast` is
    /// the current transient overlay; `show_notifs` opens the history overlay;
    /// `unseen_notifs` is the Inbox-tab badge (cleared on visit / on opening
    /// history); `notif_seq` advances per live event so the run-loop fires one
    /// OS notification each.
    pub notifs: Vec<Notif>,
    pub toast: Option<Notif>,
    pub show_notifs: bool,
    pub unseen_notifs: usize,
    pub notif_seq: u64,
    /// Whether the attention surfaces that "pop" are enabled: the transient
    /// toast overlay (`draw_toast`) and the OS desktop notification. MUTED by
    /// default (owner ask 2026-06-14) — set `PUI_NOTIFY=1` to re-enable. The
    /// Inbox badge (`unseen_notifs`) + the `N` history overlay (`notifs`) are
    /// independent of this and always stay live, so no message is ever lost.
    pub notify_enabled: bool,
    /// Fleet "no reachable session" action menu (pui-workbench-usability D-002).
    /// `Some` while Enter on an unreachable agent has surfaced the `[r]/[n]/[f]`
    /// choices; the next `r`/`n`/`f`/Esc closes it. Captures keys while open.
    pub fleet_action_menu: Option<FleetActionMenu>,
    /// `Some` while the staged-wake review overlay is open (P-009): the selected
    /// agent's pending wakes + release/edit/skip state. Captures keys while open.
    pub wake_review: Option<WakeReview>,
    /// The fleet-wide staged-wake board (the pinned `pui wake-pane`, EI-312).
    /// Only fetched/rendered when pinned to `Tab::Wake`.
    pub wake_board: WakeBoard,
    /// The wake-pane's agent scope (owner ask 2026-06-11): All for the dock's
    /// fleet-wide "⏸ wakes" pane; Queen/Owner for a per-agent pane. Set once
    /// from argv at launch; the refresh loop + `g` refetch both honor it.
    pub wake_filter: WakeFilter,
    /// The last P-011 regroup target sent to the companion — the spam guard:
    /// the same mis-ordered topology snapshot never refires the same repair.
    pub last_regroup: Option<Vec<u32>>,
    /// Deployed cloud frames (P-013) from `/api/deploy/frames` — the per-frame
    /// tab roster. Refreshed each poll; empty when nothing is deployed.
    pub frames: Vec<crate::models::DeployFrameRow>,
    /// Frame tabs this instance already asked the companion to create (P-013) —
    /// covers the window between the NewTab command and the next topology
    /// snapshot (which then carries the tab as ground truth).
    pub created_frame_tabs: std::collections::HashSet<String>,
    /// B4 (P-004): tab names already CREATED for the persistent per-hive axis —
    /// covers the NewTab→next-topology window so a hive isn't double-tabbed.
    pub created_hive_tabs: std::collections::HashSet<String>,
    /// Live workbench topology from the companion zellij plugin (P-004 / D-008):
    /// which agent is in which pane + tab. `None` until the companion links;
    /// replaced wholesale on each snapshot (idempotent — no diff bookkeeping).
    pub topology: Option<Topology>,
    /// pui's OWN zellij pane id (= the HUD pane), read from `$ZELLIJ_PANE_ID` at
    /// startup (dockview-workbench D-008). The bare `:float`/`:dock` dock-verbs
    /// target this pane. `None` when not running inside zellij (tests, plain
    /// terminal) — the run loop then falls back to focused-pane CLI verbs.
    pub hud_pane_id: Option<u32>,
    /// The companion plugin's version once it links (the liveness indicator).
    /// `None` when `pui` runs outside zellij / without the plugin installed.
    pub companion_version: Option<String>,
    /// The command line of the most-recently-exited workbench pane (P-004), so
    /// `r` can relaunch a crashed agent. `Some` only while an exit is pending an
    /// offer; cleared on relaunch. The pane-exit notification advertises the key.
    pub relaunch_command: Option<String>,
    /// Fleet status view (pui-fleet-status-view-2026-06-04): the live activity
    /// ring, fleet work-items, per-agent todos, view mode + selection. All fleet
    /// logic lives in `fleet.rs`; the reducer/render only touch this field.
    pub fleet: FleetState,
    /// Bee-dossier dock pane (pui-bee-dossier-pane-2026-06-06): the swarm-selected
    /// bee's ranked work-list + coord inbox/outbox. Populated by `pui bee-pane`
    /// polling the in-memory selection relay; all logic lives in `bee.rs`.
    pub bee: crate::bee::BeeState,
    /// Per-bee wake-pane lifecycle (owner ask 2026-06-11): consecutive roster
    /// misses for an Owner-scoped wake-pane's agent (2 misses + a drained
    /// queue → this instance exits).
    pub wake_owner_misses: u8,
    /// Agent-context pane mode (dock 4-pane split, owner ask 2026-06-11):
    /// which board a pinned `Tab::AgentCtx` instance renders — the launch
    /// brief, the coord mail, or the work items + plan linkage. The agent
    /// scope rides `wake_filter` (same Queen/Owner resolution; a pinned pane
    /// is its own process so the share is safe).
    pub agent_ctx_mode: AgentCtxMode,
    /// The agent-context pane's fetched data (`Event::AgentCtx`). `None` until
    /// the first fetch lands; `Some(Err)` renders the error inline.
    pub agent_ctx: Option<Result<crate::models::AgentCtxData, String>>,
    /// Agent-context pane scroll offset (j/k).
    pub agent_ctx_scroll: u16,
    /// True only in the dock's chat-pane: drive the reactive agent stack (a
    /// watch pane per active bee + an interactive pane per new local launch).
    pub dock_agent_panes: bool,
    /// HIVE_AGENT_TABS (hive-agent-tabs P-004): set at startup by the dock driver.
    /// When on, each claude bee renders as a `claude --resume <session_id>` Claude
    /// TUI instead of the read-only `pui watch-pane` (RosterEntry::dock_pane_argv).
    /// Default off → current behavior.
    pub hive_agent_tabs: bool,
    /// Owner ids the dock has already opened a bee pane for (dedup; pruned
    /// when the agent leaves the roster so a returning bee re-panes).
    pub paned_bees: std::collections::HashSet<String>,
    /// Hive lexicon (pui-hive-lexicon-2026-06-06): the active brand pack's
    /// term→label map, fetched once at startup. Empty = classic fallback (today's
    /// labels). `lex(term)` routes user-facing labels through it.
    pub lexicon: crate::lexicon::Lexicon,
    /// Operator chat pane (tui-operator-surface-2026-06-04). The transcript
    /// (oldest first; the last entry is the in-flight streaming bubble while a
    /// turn runs), the composer buffer + focus flag, the bottom-anchored scroll
    /// offset (lines scrolled UP from the latest; 0 = pinned to the newest), the
    /// in-flight flag, the conversation id (for persistence + load-earlier), and
    /// whether older history exists.
    pub chat_messages: Vec<ChatMessage>,
    pub chat_input: String,
    pub chat_composing: bool,
    pub chat_scroll: u16,
    pub chat_streaming: bool,
    pub conversation_id: Option<String>,
    pub chat_has_more_earlier: bool,
    /// The lowest `seq` currently loaded — the cursor for paginating older turns
    /// (`GET …/turns?beforeSeq=<this>`). `None` when the transcript is empty.
    pub chat_oldest_seq: Option<i64>,
    /// True while an older-history page fetch is in flight (dedupes the trigger).
    pub chat_loading_earlier: bool,
    /// Inline card state (sentinel-tui-shared-backend-and-cards-2026-06-22
    /// Phase 2a): the open `chat:ask_choice` cards mirrored from the
    /// state-channel snapshot + the live interaction (selection / input). The
    /// focused card renders over the operator pane; answering POSTs
    /// `/card-response`.
    pub card_state: crate::card_view::CardState,
    /// The active workspace id (resolved by the card loop at startup) — the
    /// defense-in-depth `expectedWorkspaceId` for a `/card-response`. `None`
    /// until resolved (dev / unscoped); the POST then omits the gate.
    pub card_workspace: Option<String>,
    // ─── Operator dock (operator-always-visible-2026-06-05, Brief 24) ───
    /// Whether the operator chat is docked beside the active tab's content. The
    /// dock reuses `draw_chat` + the same `chat_*` state as the Operator tab (one
    /// conversation, two render sites) so the operator is usable on every tab
    /// without switching to it. Defaults closed; once opened it follows the user
    /// across tabs and is persisted in view-state. Render is width-gated and
    /// suppressed on the Operator tab itself (where the whole tab IS the chat).
    pub operator_dock_open: bool,
    /// Whether the docked operator pane holds keyboard focus on a non-Operator
    /// tab. When focused, chat keys (compose/send/scroll/page-back + `v` voice)
    /// route to the dock instead of the active tab; `o` focuses (opening it),
    /// Esc blurs back to the tab. Always false on the Operator tab (that tab owns
    /// the chat directly).
    pub operator_dock_focused: bool,
    // ─── Voice mode (voice-mode-tui-port-2026-06-05 P2) ───
    /// Current PTT phase (Idle unless a voice turn is in flight). Drives the
    /// Operator status line + gates the `v` keybind.
    pub voice_phase: VoicePhase,
    /// Latest mic RMS level (0..~1) while recording — the meter; updated from
    /// the run loop on Tick, not via events (no per-frame event spam).
    pub voice_level: f32,
    /// The last voice-pipeline error (STT/converse/TTS), shown until the next
    /// turn starts.
    pub voice_error: Option<String>,
    // ─── Realtime operator voice (voice-realtime-tui-2026-06-05 P-007) ───
    /// The continuous EL Conv-AI session phase. `V` toggles; transcripts ride
    /// the shared operator chat; the session task lives in the run loop.
    pub convai_phase: ConvAiPhase,
    /// Last host-broadcast mode for the live shared session.
    pub convai_mode: String,
    /// Host-broadcast mute for the live shared session.
    pub convai_muted: bool,
    /// Whether this TUI surface currently owns mic/playout for the session.
    pub convai_is_player: bool,
    /// Whether `v` is currently holding the shared-session PTT gate open.
    pub convai_ptt_active: bool,
    /// P2P voice-channel tab state (holepunch-voice-channels P-008). All
    /// voice-tab keys/render live in `voice_ui`; the run loop owns the socket.
    pub voice_ui: crate::voice_ui::VoiceUiState,
}

/// Realtime Conv-AI session phase (distinct from the PTT `VoicePhase` — both
/// can exist, but `V` refuses to start while a PTT turn is in flight).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ConvAiPhase {
    #[default]
    Off,
    /// ws-init + connect in flight.
    Connecting,
    /// Session live — mic streaming, agent audible.
    Live,
}

impl ConvAiPhase {
    /// A one-glyph + label badge for the Operator title/status line.
    /// Glyphs ride the shared vocabulary (`crate::glyph`, Brief 27).
    pub fn badge(self) -> String {
        match self {
            ConvAiPhase::Off => String::new(),
            ConvAiPhase::Connecting => format!("{} voice…", crate::glyph::liveness::IDLE),
            ConvAiPhase::Live => format!("{} voice", crate::glyph::liveness::LIVE),
        }
    }
}

/// The voice PTT pipeline phase (voice-mode-tui-port-2026-06-05). Linear:
/// Idle → Recording → Transcribing → Thinking → Speaking → Idle, with any
/// stage able to fail back to Idle (error stored in `voice_error`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VoicePhase {
    #[default]
    Idle,
    /// Mic is capturing (press `v` again / release / Esc to end).
    Recording,
    /// Whisper is transcribing the captured audio.
    Transcribing,
    /// The operator turn is streaming a reply.
    Thinking,
    /// The reply is being synthesized + played back.
    Speaking,
}

impl VoicePhase {
    /// A one-glyph + label badge for the Operator status line.
    /// Glyphs ride the shared vocabulary (`crate::glyph`, Brief 27).
    pub fn badge(self) -> String {
        match self {
            VoicePhase::Idle => String::new(),
            VoicePhase::Recording => format!("{} REC", crate::glyph::liveness::LIVE),
            VoicePhase::Transcribing => {
                format!("{} transcribing", crate::glyph::action::EDIT)
            }
            VoicePhase::Thinking => "… thinking".to_string(),
            VoicePhase::Speaking => format!("{} speaking", crate::glyph::voice::SPEAKING),
        }
    }
    pub fn is_active(self) -> bool {
        !matches!(self, VoicePhase::Idle)
    }
}

impl App {
    pub fn new() -> Self {
        Self {
            should_quit: false,
            status: "pui · h overview · 1 operator · j/k move · [/] pot · ? help · q quit"
                .to_string(),
            // The Overview dashboard is the default landing surface (Brief 23,
            // overview-dashboard-2026-06-05 D-001); the operator chat stays
            // always-on via the Overview's bottom strip + the `o` right dock.
            tab: Tab::Overview,
            pinned: None,
            plans: Vec::new(),
            plan_sel: 0,
            plans_board_sel: 0,
            plans_focus: PlansFocus::List,
            plans_entered: false,
            plan_items_sel: 0,
            plan_item_states: None,
            roster: Vec::new(),
            tracked_panes: crate::session_panes::TrackedPanes::new(),
            reactive_launch_panes: false,
            local_host: crate::session_panes::local_host(),
            inbox: Vec::new(),
            inbox_sel: 0,
            overview_sel: 0,
            fleet_rate: None,
            harnesses: Vec::new(),
            harness_sel: 0,
            harness: "papercup".to_string(),
            // Fresh installs land in All-Pots (the desktop's fresh-load default).
            all_pots: true,
            pot_picker_open: false,
            pot_picker_sel: 0,
            active_harness: Arc::new(Mutex::new("papercup".to_string())),
            active_plan: Arc::new(Mutex::new(None)),
            features: Vec::new(),
            feat_sel: 0,
            issues: Vec::new(),
            issue_sel: 0,
            harness_focus: HarnessFocus::Features,
            pane_entered: false,
            docs_files: Vec::new(),
            doc_sel: 0,
            doc_content: String::new(),
            doc_scroll: 0,
            doc_entries: Vec::new(),
            doc_active: None,
            active_doc: Arc::new(Mutex::new(None)),
            testing: Vec::new(),
            testing_sel: 0,
            testing_files: Vec::new(),
            testing_file_sel: 0,
            testing_focus: TestingFocus::Domains,
            testing_files_loading: false,
            test_run: None,
            config: EffectiveClaudeSettings::default(),
            panes: Vec::new(),
            pane_sel: 0,
            plugins: Vec::new(),
            plugin_sel: 0,
            plugins_focus: PluginsFocus::List,
            plugin_config: None,
            hives: Vec::new(),
            hive_sel: 0,
            hive_directory: Vec::new(),
            hive_dir_sel: 0,
            network_rows: Vec::new(),
            network_sel: 0,
            network_focus: None,
            hive_beacons: Vec::new(),
            hive_asks: Vec::new(),
            memories: Vec::new(),
            memory_hits: None,
            memory_sel: 0,
            memory_available: false,
            memory_search_open: false,
            memory_search_input: String::new(),
            cupboard: Vec::new(),
            cupboard_sel: 0,
            cupboard_kind: 0,
            cupboard_query: String::new(),
            cupboard_search_open: false,
            cupboard_search_input: String::new(),
            cupboard_loading: false,
            cupboard_confirm: None,
            conversations: Vec::new(),
            conversation_sel: 0,
            conv_state_idx: 0,
            conv_kind_idx: 0,
            conv_topic: None,
            conversations_loading: false,
            conversation_detail: None,
            flags: Vec::new(),
            flags_source: String::new(),
            flag_sel: 0,
            operator_config: OperatorConfig::default(),
            launched: Vec::new(),
            last_error: None,
            show_help: false,
            palette_open: false,
            palette_input: String::new(),
            show_presence: true,
            plan_filter: BTreeSet::new(),
            plan_filter_open: false,
            plan_filter_sel: 0,
            fleet_detail_open: false,
            fleet_detail_scroll: 0,
            show_tutorial: false,
            tutorial_step: 0,
            notifs: Vec::new(),
            toast: None,
            show_notifs: false,
            unseen_notifs: 0,
            notif_seq: 0,
            notify_enabled: false,
            fleet_action_menu: None,
            wake_review: None,
            wake_board: WakeBoard {
                loading: true,
                ..WakeBoard::default()
            },
            wake_filter: WakeFilter::default(),
            last_regroup: None,
            frames: Vec::new(),
            created_frame_tabs: std::collections::HashSet::new(),
            created_hive_tabs: std::collections::HashSet::new(),
            topology: None,
            hud_pane_id: None,
            companion_version: None,
            relaunch_command: None,
            fleet: FleetState::default(),
            bee: crate::bee::BeeState::default(),
            wake_owner_misses: 0,
            agent_ctx_mode: AgentCtxMode::default(),
            agent_ctx: None,
            agent_ctx_scroll: 0,
            dock_agent_panes: false,
            hive_agent_tabs: false,
            paned_bees: std::collections::HashSet::new(),
            lexicon: crate::lexicon::Lexicon::default(),
            chat_messages: Vec::new(),
            chat_input: String::new(),
            chat_composing: false,
            chat_scroll: 0,
            chat_streaming: false,
            conversation_id: None,
            chat_has_more_earlier: false,
            chat_oldest_seq: None,
            chat_loading_earlier: false,
            card_state: crate::card_view::CardState::new(),
            card_workspace: None,
            operator_dock_open: false,
            operator_dock_focused: false,
            voice_phase: VoicePhase::Idle,
            convai_phase: ConvAiPhase::Off,
            convai_mode: "always-on".into(),
            convai_muted: false,
            convai_is_player: false,
            convai_ptt_active: false,
            voice_ui: crate::voice_ui::VoiceUiState::default(),
            voice_level: 0.0,
            voice_error: None,
        }
    }

    // ─── Hive lexicon (pui-hive-lexicon-2026-06-06) ───

    /// The singular display label for a lexicon term key through the active pack
    /// (classic fallback when unfetched/offline). Presentation only. The
    /// requested `lex(term)` app-state helper (pui-hive-lexicon-2026-06-06);
    /// `Tab::label` + the dock-KDL pane-name resolver are the live callsites
    /// today, this is the general seam for routing any future label.
    #[allow(dead_code)]
    pub fn lex(&self, term: &str) -> String {
        self.lexicon.lex(term)
    }
    /// The plural display label for a lexicon term key.
    #[allow(dead_code)]
    pub fn lex_plural(&self, term: &str) -> String {
        self.lexicon.lex_plural(term)
    }

    // ─── Operator chat pane (tui-operator-surface-2026-06-04) ───

    /// Seed the transcript from a loaded conversation (on open). Resets scroll to
    /// the latest. Any in-flight bubble is replaced (history load only happens at
    /// startup, before a turn can be in flight).
    pub fn set_chat_history(
        &mut self,
        conversation_id: String,
        messages: Vec<ChatMessage>,
        has_more_earlier: bool,
        oldest_seq: Option<i64>,
    ) {
        self.conversation_id = Some(conversation_id);
        self.chat_messages = messages;
        self.chat_has_more_earlier = has_more_earlier;
        self.chat_oldest_seq = oldest_seq;
        self.chat_loading_earlier = false;
        self.chat_scroll = 0;
    }

    /// Prepend an older page of turns (load-earlier). Inserts before the current
    /// transcript, advances the oldest cursor + has-more flag, and clears the
    /// in-flight flag. The bottom-anchored `chat_scroll` is preserved, so the
    /// user stays exactly where they were reading while older history fills in
    /// above. An empty page just clears the flags (defensive — has_more should be
    /// false then anyway).
    pub fn prepend_chat_earlier(
        &mut self,
        mut messages: Vec<ChatMessage>,
        has_more_earlier: bool,
        oldest_seq: Option<i64>,
    ) {
        self.chat_loading_earlier = false;
        self.chat_has_more_earlier = has_more_earlier;
        // Keep the existing oldest cursor if the page carried none (empty page).
        if oldest_seq.is_some() {
            self.chat_oldest_seq = oldest_seq;
        }
        if !messages.is_empty() {
            messages.append(&mut self.chat_messages);
            self.chat_messages = messages;
        }
    }

    /// Append the user's message + an empty streaming assistant bubble, mark the
    /// turn in-flight, and pin the view to the bottom. Called when the composer
    /// submits, just before the run loop spawns the converse task.
    pub fn begin_user_send(&mut self, text: &str) {
        self.chat_messages.push(ChatMessage::user(text));
        self.chat_messages.push(ChatMessage::streaming_assistant());
        self.chat_streaming = true;
        self.chat_scroll = 0;
    }

    /// The transcript to send as the converse `messages` array (role, content)
    /// pairs — every committed turn, excluding the in-flight streaming bubble and
    /// any empty assistant placeholder.
    pub fn chat_history_for_send(&self) -> Vec<(String, String)> {
        self.chat_messages
            .iter()
            .filter(|m| !(m.streaming || m.role == "assistant" && m.content.trim().is_empty()))
            .map(|m| (m.role.clone(), m.content.clone()))
            .collect()
    }

    /// Append a streamed `delta` chunk onto the in-flight assistant bubble's raw
    /// buffer (rendered via `chat_tags::live_preview`) and stay pinned to bottom.
    fn push_chat_delta(&mut self, text: &str) {
        if let Some(m) = self.chat_messages.iter_mut().rev().find(|m| m.streaming) {
            m.content.push_str(text);
        }
        self.chat_scroll = 0;
    }

    /// Record a mid-turn tool call as a chip on the in-flight assistant bubble.
    fn push_chat_tool(&mut self, tc: ChatToolCall) {
        if let Some(m) = self.chat_messages.iter_mut().rev().find(|m| m.streaming) {
            m.tools.push(tc);
        }
    }

    /// Finalize the in-flight assistant bubble: resolve its raw buffer to the
    /// user-visible `<say>` text and clear the streaming flag.
    fn finish_chat_turn(&mut self) {
        if let Some(m) = self.chat_messages.iter_mut().rev().find(|m| m.streaming) {
            // finalize strips the <report> span with the other control tags —
            // a report is not chat content; it persists via append_turn and
            // surfaces in the Inbox (report-cards-inbox-reconciliation D-002).
            m.content = crate::chat_tags::finalize(&m.content);
            m.streaming = false;
        }
        self.chat_streaming = false;
        self.chat_scroll = 0;
    }

    /// Finalize the in-flight bubble as an error (the converse stream failed).
    /// A bubble with no content yet becomes the error note; one mid-stream is
    /// finalized so partial output survives, and the error goes to the status bar.
    fn fail_chat_turn(&mut self, err: &str) {
        if let Some(m) = self.chat_messages.iter_mut().rev().find(|m| m.streaming) {
            if m.content.trim().is_empty() {
                m.content = format!("{} {err}", crate::glyph::severity::WARN);
            } else {
                m.content = crate::chat_tags::finalize(&m.content);
            }
            m.streaming = false;
        }
        self.chat_streaming = false;
        self.last_error = Some(format!("operator: {err}"));
        self.chat_scroll = 0;
    }

    // ─── Voice mode (voice-mode-tui-port-2026-06-05 P2) ───

    /// Update the live mic meter (run loop reads `CaptureSession::level()` on
    /// Tick while recording). No-op once recording ends.
    pub fn set_voice_level(&mut self, level: f32) {
        if self.voice_phase == VoicePhase::Recording {
            self.voice_level = level;
        }
    }

    /// True when chat input/scroll keys should drive the operator conversation —
    /// either on the full Operator tab, or in the docked pane when it holds focus
    /// on another tab (operator-always-visible-2026-06-05). The single predicate
    /// the chat key arms gate on so the dock is exactly as usable as the tab.
    pub fn operator_input_active(&self) -> bool {
        self.tab == Tab::Operator || (self.operator_dock_open && self.operator_dock_focused)
    }

    /// True when a `v` PTT keypress should be accepted — on the Operator tab or in
    /// a focused operator dock — and never while composing a typed message.
    pub fn voice_key_active(&self) -> bool {
        self.operator_input_active() && !self.chat_composing
    }

    /// Drive the focused inline card (sentinel-tui-shared-backend-and-cards
    /// Phase 2a). Returns `Action::CardRespond` when the user commits an answer
    /// (the reducer has already optimistically dismissed the card so the next
    /// card surfaces immediately), else `Action::Render` for navigation.
    ///
    /// Keymap by presentation:
    ///   - radio:    ↑/↓ k/j move · Enter / 1-9 pick (commits) · Esc declines/cancels
    ///   - checkbox: ↑/↓ k/j move · Space / 1-9 toggle · Enter submits · Esc declines/cancels
    ///   - text/date: type · Backspace · Enter submits · Esc declines/cancels
    ///   - slider:   ←/→ h/l (and j/k) nudge · Enter submits · Esc declines/cancels
    fn card_key(&mut self, code: KeyCode) -> Action {
        use crate::card_view::CardPresentation;
        // Snapshot the focused card's shape (clone the small bits we branch on)
        // so we don't hold an immutable borrow across the mutable card_state ops.
        let Some(card) = self.card_state.focused() else {
            return Action::Render;
        };
        let allow_decline = card.allow_decline;
        let is_choice = matches!(
            card.presentation,
            CardPresentation::Radio { .. } | CardPresentation::Checkbox { .. }
        );
        let is_checkbox = matches!(card.presentation, CardPresentation::Checkbox { .. });
        let is_slider = matches!(card.presentation, CardPresentation::Slider { .. });
        let is_text = matches!(
            card.presentation,
            CardPresentation::Text { .. } | CardPresentation::Date { .. }
        );

        match code {
            KeyCode::Esc => {
                // Esc declines when the card allows it, else cancels the run
                // (the brain's tool resolves {action:'cancel'}).
                let action = if allow_decline { "decline" } else { "cancel" };
                self.card_respond_action(action.to_string(), None)
            }
            KeyCode::Up | KeyCode::Char('k') if is_choice => {
                self.card_state.move_sel(false);
                Action::Render
            }
            KeyCode::Down | KeyCode::Char('j') if is_choice => {
                self.card_state.move_sel(true);
                Action::Render
            }
            KeyCode::Char(' ') if is_checkbox => {
                self.card_state.toggle_checked();
                Action::Render
            }
            // Slider nudge.
            KeyCode::Left | KeyCode::Char('h') | KeyCode::Char('j') if is_slider => {
                self.card_state.nudge_slider(false);
                Action::Render
            }
            KeyCode::Right | KeyCode::Char('l') | KeyCode::Char('k') if is_slider => {
                self.card_state.nudge_slider(true);
                Action::Render
            }
            // Number pick (1-9). For radio this commits; for checkbox it toggles.
            KeyCode::Char(c @ '1'..='9') if is_choice => {
                let n = (c as u8 - b'0') as usize;
                match self.card_state.pick_number(n) {
                    Some(resp) => self.card_finish(resp),
                    None => Action::Render, // checkbox toggle / out-of-range
                }
            }
            KeyCode::Char(c) if is_text => {
                self.card_state.type_char(c);
                Action::Render
            }
            KeyCode::Backspace if is_text => {
                self.card_state.backspace();
                Action::Render
            }
            KeyCode::Enter => match self.card_state.submit() {
                Some(resp) => self.card_finish(resp),
                None => Action::Render, // empty text / nothing selected — wait
            },
            _ => Action::Render, // swallow stray keys (the card is modal)
        }
    }

    /// Turn a committed `CardResponse` into a `/card-response` Action, after
    /// optimistically dismissing the focused card so the next one surfaces.
    fn card_finish(&mut self, resp: crate::card_view::CardResponse) -> Action {
        use crate::card_view::CardResponse;
        match resp {
            CardResponse::SubmitPicks(picks) => self.card_respond_action(
                "submit".to_string(),
                Some(serde_json::json!({ "picks": picks })),
            ),
            CardResponse::SubmitValue(value) => self.card_respond_action(
                "submit".to_string(),
                Some(serde_json::json!({ "value": value })),
            ),
        }
    }

    /// Dismiss the focused card locally + emit the POST action. `None` when no
    /// card is focused (defensive).
    fn card_respond_action(
        &mut self,
        action: String,
        payload: Option<serde_json::Value>,
    ) -> Action {
        let Some(correlation_id) = self.card_state.focused_correlation_id() else {
            return Action::Render;
        };
        let workspace_id = self.card_state.focused_workspace_id();
        self.card_state.dismiss(&correlation_id);
        Action::CardRespond {
            correlation_id,
            workspace_id,
            action,
            payload,
        }
    }

    /// Apply a voice-pipeline state change (`Event::Voice`). The pipeline task
    /// drives record → transcribe → converse → speak; this reduces each step to
    /// `voice_phase` + transcript side-effects. Returns whether a redraw is due.
    fn on_voice(&mut self, msg: crate::event::VoiceMsg) -> bool {
        use crate::event::VoiceMsg;
        match msg {
            VoiceMsg::Started(Ok(())) => {
                self.voice_phase = VoicePhase::Recording;
                self.voice_level = 0.0;
                self.voice_error = None;
            }
            VoiceMsg::Started(Err(e)) => {
                self.voice_phase = VoicePhase::Idle;
                self.voice_error = Some(e.clone());
                self.last_error = Some(format!("voice: {e}"));
            }
            VoiceMsg::Transcribed(text) => {
                // Show the recognized utterance as the user's turn + an empty
                // streaming assistant bubble (the converse fills it). Mirrors a
                // typed send (begin_user_send) so the transcript is identical.
                self.voice_phase = VoicePhase::Thinking;
                self.voice_level = 0.0;
                self.begin_user_send(&text);
            }
            VoiceMsg::Speaking => {
                self.voice_phase = VoicePhase::Speaking;
            }
            VoiceMsg::Finished => {
                self.voice_phase = VoicePhase::Idle;
                self.voice_level = 0.0;
            }
            VoiceMsg::Error(e) => {
                // A mid-turn failure: drop any in-flight streaming bubble's
                // streaming flag so the transcript isn't stuck, and surface why.
                self.voice_phase = VoicePhase::Idle;
                self.voice_level = 0.0;
                self.voice_error = Some(e.clone());
                self.last_error = Some(format!("voice: {e}"));
                if self.chat_streaming {
                    self.fail_chat_turn(&e);
                }
            }
        }
        true
    }

    pub fn set_plans(&mut self, plans: Vec<PlanSummary>) {
        self.plans = plans;
        self.clamp_sel();
    }

    pub fn set_roster(&mut self, roster: Vec<RosterEntry>) {
        self.roster = roster;
        // The Fleet tab navigates the (plans-filtered, D-009) roster too —
        // keep its cursor in range of what actually renders.
        let len = self.visible_roster().len();
        if self.fleet.agent_sel >= len {
            self.fleet.agent_sel = len.saturating_sub(1);
        }
        self.clamp_sel();
    }

    pub fn set_inbox(&mut self, inbox: Vec<AttentionItem>) {
        self.inbox = inbox;
        self.clamp_sel();
    }

    /// Record a live notification (P8): raise the toast, prepend to history,
    /// bump the badge + the OS-notify sequence. The proper "ping the human"
    /// channel — driven by `attention.notify` SSE events, which are already
    /// importance-gated at the source.
    ///
    /// Exception: coord *escalation* entries are agent↔agent coordination events
    /// the human-facing inbox forwards. As a popup they're pure noise — the SAME
    /// escalation flashes in EVERY pinned dock pane (owner report 2026-06-14).
    /// They still land in history (reachable via `N`) and bump the unseen badge,
    /// but they never raise the transient toast or the OS desktop notification.
    /// Leaving both the toast and `notif_seq` untouched suppresses BOTH popup
    /// channels — the run loop only fires `os_notify` when a fresh notif bumps
    /// `notif_seq` AND a toast is present.
    pub fn push_notif(&mut self, n: Notif) {
        if !Self::is_escalation_level(&n.level) {
            self.toast = Some(n.clone());
            self.notif_seq += 1;
        }
        self.notifs.insert(0, n);
        self.notifs.truncate(NOTIF_HISTORY_CAP);
        self.unseen_notifs += 1;
    }

    /// True for coord escalation notifications ("escalation" / "coord-escalation").
    /// These are recorded in history but never popped as a toast / OS notification.
    fn is_escalation_level(level: &str) -> bool {
        level.to_ascii_lowercase().contains("escalation")
    }

    /// Backfill notification history from `/api/toast-log` (no toast/badge bump).
    /// Any live events collected first stay ahead of the older backfill.
    pub fn set_notif_history(&mut self, history: Vec<Notif>) {
        self.notifs.extend(history);
        self.notifs.truncate(NOTIF_HISTORY_CAP);
    }

    pub fn set_features(&mut self, features: Vec<HarnessFeature>) {
        self.features = features;
        self.clamp_sel();
    }

    pub fn set_issues(&mut self, issues: Vec<HarnessIssue>) {
        self.issues = issues;
        if self.issue_sel >= self.issues.len() {
            self.issue_sel = self.issues.len().saturating_sub(1);
        }
    }

    pub fn set_harnesses(&mut self, harnesses: Vec<HarnessRef>) {
        self.harnesses = harnesses;
        if self.harness_sel >= self.harnesses.len() {
            self.harness_sel = self.harnesses.len().saturating_sub(1);
        }
        // Keep the active slug pointing at a real harness if the current one
        // isn't in the (freshly fetched) list.
        if !self.harnesses.iter().any(|h| h.slug == self.harness) {
            if let Some(h) = self.harnesses.get(self.harness_sel) {
                self.harness = h.slug.clone();
                self.harness_sel = self
                    .harnesses
                    .iter()
                    .position(|x| x.slug == self.harness)
                    .unwrap_or(0);
                self.publish_active();
            }
        } else {
            self.harness_sel = self
                .harnesses
                .iter()
                .position(|x| x.slug == self.harness)
                .unwrap_or(self.harness_sel);
        }
    }

    /// Cycle the active harness by `delta` (wrapping). Returns true if it changed.
    pub fn cycle_harness(&mut self, delta: isize) -> bool {
        let n = self.harnesses.len();
        if n == 0 {
            return false;
        }
        let cur = self.harness_sel as isize;
        let next = ((cur + delta).rem_euclid(n as isize)) as usize;
        self.select_harness(next)
    }

    /// Make `harnesses[next]` the active pot: reset the per-pot tab state, clamp
    /// the scope-filtered global selections, republish for the poller. Shared by
    /// `[`/`]` cycling and the pot-picker overlay (D-003).
    fn select_harness(&mut self, next: usize) -> bool {
        if next >= self.harnesses.len() || next == self.harness_sel {
            return false;
        }
        self.harness_sel = next;
        self.harness = self.harnesses[next].slug.clone();
        self.features.clear();
        self.issues.clear();
        self.feat_sel = 0;
        self.issue_sel = 0;
        self.harness_focus = HarnessFocus::Features;
        self.docs_files.clear();
        self.doc_content.clear();
        self.doc_sel = 0;
        self.doc_scroll = 0;
        self.doc_entries.clear();
        self.doc_active = None;
        self.testing.clear();
        self.testing_sel = 0;
        self.testing_files.clear();
        self.testing_file_sel = 0;
        self.testing_focus = TestingFocus::Domains;
        self.testing_files_loading = false;
        self.test_run = None;
        self.config = EffectiveClaudeSettings::default();
        self.panes.clear();
        self.pane_sel = 0;
        // Plugins are global, not per-harness — keep the list; just drop the
        // selected plugin's now-stale per-harness config (D-014).
        self.plugin_config = None;
        if let Ok(mut g) = self.active_doc.lock() {
            *g = None;
        }
        // The scope-filtered global lists change with the pot (D-003).
        self.clamp_scope_sel();
        self.publish_active();
        true
    }

    // ─── POTS scope axis (D-003) ───

    /// True when a row attributed to harness `h` is visible under the current
    /// scope: All-Pots shows everything; pot scope shows the active pot's rows.
    /// Rows that carry NO slug stay visible (they can't be attributed, and
    /// hiding them would silently drop real data).
    fn in_scope(&self, h: Option<&str>) -> bool {
        self.all_pots || h.map_or(true, |s| s.is_empty() || s == self.harness)
    }

    /// The Plans list under the current pot scope (what the Plans tab renders;
    /// `plan_sel` indexes THIS list).
    pub fn visible_plans(&self) -> Vec<&PlanSummary> {
        self.plans
            .iter()
            .filter(|p| self.in_scope(p.harness.as_deref()))
            .collect()
    }

    /// The Inbox under the current pot scope AND the plans filter (D-009) —
    /// `inbox_sel` indexes this. With a filter on, only items attributed to a
    /// selected plan show (an Inbox item without a plan is filtered out — the
    /// strict rule for a plan-attributed list).
    pub fn visible_inbox(&self) -> Vec<&AttentionItem> {
        let mut v: Vec<&AttentionItem> = self
            .inbox
            .iter()
            .filter(|i| self.in_scope(i.harness_slug.as_deref()))
            .filter(|i| {
                self.plan_filter.is_empty()
                    || i.plan_slug
                        .as_deref()
                        .is_some_and(|s| self.plan_filter.contains(s))
            })
            .collect();
        // Cluster by tier (Decisions ▸ Handled ▸ Alerts ▸ Activity) so the inbox
        // tier-sections render in order and j/k navigates sequentially (D-006).
        // A stable sort preserves the server's within-tier importance order.
        v.sort_by_key(|i| i.tier_rank());
        v
    }

    /// The Fleet roster under the plans filter (D-009) — `fleet.agent_sel`
    /// indexes this. Rows with NO current plan are never hidden (the desktop's
    /// rule: an unattributed agent must stay visible), so a filter only
    /// narrows plan-attributed rows.
    pub fn visible_roster(&self) -> Vec<&RosterEntry> {
        let mut v: Vec<&RosterEntry> = self
            .roster
            .iter()
            .filter(|r| {
                self.plan_filter.is_empty()
                    || r.current_plan_slug
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .is_none_or(|s| self.plan_filter.contains(s))
            })
            .collect();
        // #3: group by fleet for the Fleet-tab roster — fleets alphabetical, "no
        // fleet" last. A STABLE sort preserves the server's within-fleet (newest-
        // heartbeat) order. `agent_sel` indexes THIS order and draw_agents renders
        // it, so the grouping + cursor + headers stay in lockstep.
        v.sort_by_key(|r| r.fleet_group_sort_key());
        v
    }

    /// Re-clamp the cursors of the lists the plans filter narrows (D-009) so a
    /// shrinking filter never strands a selection past the visible end.
    fn clamp_filtered_cursors(&mut self) {
        let plans_len = self.visible_plans().len();
        if self.plan_filter_sel >= plans_len {
            self.plan_filter_sel = plans_len.saturating_sub(1);
        }
        let inbox_len = self.visible_inbox().len();
        if self.inbox_sel >= inbox_len {
            self.inbox_sel = inbox_len.saturating_sub(1);
        }
        let roster_len = self.visible_roster().len();
        if self.fleet.agent_sel >= roster_len {
            self.fleet.agent_sel = roster_len.saturating_sub(1);
        }
    }

    /// Fleet work-items under the current pot scope (Fleet headline + rollup).
    pub fn visible_work_items(&self) -> Vec<&WorkItem> {
        self.fleet
            .work_items
            .iter()
            .filter(|w| self.in_scope(w.harness.as_deref()))
            .collect()
    }

    /// The Fleet activity feed under the current pot scope (mirror mode).
    pub fn visible_fleet_activity(&self) -> Vec<&ActivityRow> {
        self.fleet
            .activity
            .iter()
            .filter(|a| self.in_scope(a.harness_slug.as_deref()))
            .collect()
    }

    /// The Memory tab's visible entries (D-006): search hits while a query is
    /// active, else the full list. `memory_sel` indexes THIS list.
    pub fn visible_memories(&self) -> &[crate::models::MemoryEntry] {
        match &self.memory_hits {
            Some((_, hits)) => hits,
            None => &self.memories,
        }
    }

    /// The selected memory entry (D-006).
    pub fn selected_memory(&self) -> Option<&crate::models::MemoryEntry> {
        self.visible_memories().get(self.memory_sel)
    }

    /// One-line scope indicator for the status bar (D-003).
    pub fn scope_label(&self) -> String {
        if self.all_pots {
            "⊙ all pots".to_string()
        } else {
            format!("⊙ {}", self.harness)
        }
    }

    /// Re-clamp the selections that index scope-FILTERED lists — called when
    /// the scope or the active pot changes (the visible lists shrink/grow).
    fn clamp_scope_sel(&mut self) {
        let plans = self.visible_plans().len();
        if self.plan_sel >= plans {
            self.plan_sel = plans.saturating_sub(1);
        }
        let inbox = self.visible_inbox().len();
        if self.inbox_sel >= inbox {
            self.inbox_sel = inbox.saturating_sub(1);
        }
    }

    /// Apply a pot-picker choice (D-003): index 0 = All Pots; index i>0 picks
    /// `harnesses[i-1]` and narrows the scope to it.
    fn apply_pot_choice(&mut self, index: usize) {
        if index == 0 {
            self.all_pots = true;
        } else {
            self.all_pots = false;
            self.select_harness(index - 1);
        }
        self.clamp_scope_sel();
        self.publish_active_plan();
    }

    fn publish_active(&self) {
        if let Ok(mut g) = self.active_harness.lock() {
            *g = self.harness.clone();
        }
    }

    /// Filesystem path of the active harness repo (for git launch), if known.
    pub fn active_repo_path(&self) -> Option<String> {
        self.harnesses
            .get(self.harness_sel)
            .and_then(|h| h.path.clone())
    }

    /// Launch `lazygit` scoped to the active harness repo.
    pub fn git_spec(&self) -> PaneSpec {
        let mut argv = vec!["lazygit".to_string()];
        if let Some(p) = self.active_repo_path() {
            argv.push("-p".to_string());
            argv.push(p);
        }
        PaneSpec::new(argv).titled(format!("git · {}", self.harness))
    }

    pub fn set_docs(&mut self, docs: DocsResponse) {
        self.docs_files = docs.files;
        self.doc_content = docs.content.unwrap_or_default();
        self.doc_entries = docs.entries;
        self.doc_active = docs.active_entry;
        // Until the user picks a doc, follow the server's chosen active path.
        let no_selection = self.active_doc.lock().map(|g| g.is_none()).unwrap_or(true);
        if no_selection {
            if let Some(ap) = docs.active_path {
                if let Some(i) = self.docs_files.iter().position(|f| *f == ap) {
                    self.doc_sel = i;
                }
            }
        }
        if self.doc_sel >= self.docs_files.len() {
            self.doc_sel = self.docs_files.len().saturating_sub(1);
        }
    }

    /// Publish the selected doc path so the poller fetches its content.
    pub fn publish_active_doc(&self) {
        if let Ok(mut g) = self.active_doc.lock() {
            *g = self.docs_files.get(self.doc_sel).cloned();
        }
    }

    pub fn set_testing(&mut self, testing: Vec<TestingDomain>) {
        self.testing = testing;
        if self.testing_sel >= self.testing.len() {
            self.testing_sel = self.testing.len().saturating_sub(1);
        }
    }

    /// Enter/r on the Testing tab (D-004a): on the domain column, fetch the
    /// selected domain's runnable files; on the file column, run the selected
    /// file (one run at a time — a second Enter while running is inert).
    fn testing_activate(&mut self) -> Action {
        match self.testing_focus {
            TestingFocus::Domains => match self.testing.get(self.testing_sel) {
                Some(d) => {
                    self.testing_files.clear();
                    self.testing_file_sel = 0;
                    self.testing_files_loading = true;
                    Action::FetchTestingFiles {
                        harness: self.harness.clone(),
                        domain_id: d.id.clone(),
                    }
                }
                None => Action::None,
            },
            TestingFocus::Files => {
                if self.test_run.as_ref().is_some_and(|r| r.running) {
                    return Action::Render; // a run is in flight — wait for it
                }
                match self.testing_files.get(self.testing_file_sel) {
                    Some(f) => {
                        let file = f.clone();
                        self.test_run = Some(TestRunState {
                            running: true,
                            file: file.clone(),
                            status: String::new(),
                            output: String::new(),
                        });
                        Action::RunTest {
                            harness: self.harness.clone(),
                            file,
                        }
                    }
                    None => Action::None,
                }
            }
        }
    }

    pub fn set_config(&mut self, v: EffectiveClaudeSettings) {
        self.config = v;
    }

    /// Settings tab (P10b): store the read-only operator-config overview.
    pub fn set_operator_config(&mut self, c: OperatorConfig) {
        self.operator_config = c;
    }

    /// Settings tab (P10): store the operator feature flags as a sorted Vec (the
    /// BTreeMap iteration is already key-sorted) + the flag-backend source.
    pub fn set_flags(&mut self, resp: FlagsResponse) {
        self.flags = resp.flags.into_iter().collect();
        self.flags_source = resp.source;
        if self.flag_sel >= self.flags.len() {
            self.flag_sel = self.flags.len().saturating_sub(1);
        }
    }

    /// Record a launched pane into the crew roster (P12b) if it's a `psu` agent
    /// session (git/plugin panes are ignored). The slot is its roster position.
    pub fn record_launch(&mut self, spec: &PaneSpec) {
        if let Some(mut m) = crate::workbench::crew_member_from_spec(spec) {
            m.slot = Some(self.launched.len() as u32);
            self.launched.push(m);
        }
    }

    /// The `:themes` registry listing with the active theme marked (P1 /
    /// D-002) — what the palette prints on `:themes` and on an unknown
    /// `:theme <name>`.
    fn theme_listing() -> String {
        let active = crate::theme::Theme::active_name();
        crate::theme::THEMES
            .iter()
            .map(|t| {
                if t.name == active {
                    format!("{}*", t.name)
                } else {
                    t.name.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join(" · ")
    }

    /// Snapshot the quiet UI/nav state for persistence (P12 / D-002 —
    /// `harness_shared.tui_view_state`). Pure read; the run loop ships this to
    /// the debounced saver on each nav change.
    pub fn capture_view_state(&self) -> ViewState {
        ViewState {
            tab: Some(self.tab.title().to_string()),
            harness: Some(self.harness.clone()),
            scope: Some(if self.all_pots { "all" } else { "pot" }.to_string()),
            harness_focus: Some(
                match self.harness_focus {
                    HarnessFocus::Features => "features",
                    HarnessFocus::Issues => "issues",
                }
                .to_string(),
            ),
            plan_sel: self.plan_sel,
            inbox_sel: self.inbox_sel,
            harness_sel: self.harness_sel,
            feat_sel: self.feat_sel,
            issue_sel: self.issue_sel,
            doc_sel: self.doc_sel,
            doc_scroll: self.doc_scroll,
            testing_sel: self.testing_sel,
            pane_sel: self.pane_sel,
            show_presence: self.show_presence,
            operator_dock_open: self.operator_dock_open,
            fleet_agent_sel: self.fleet.agent_sel,
            fleet_mode: Some(self.fleet.mode.label().to_string()),
            plan_filter: self.plan_filter.iter().cloned().collect(),
            plan_filter_open: self.plan_filter_open,
            // `:theme` selection (workbench-theme-system P1 / D-002): the
            // active palette follows the user across launches/machines.
            theme: Some(crate::theme::Theme::active_name().to_string()),
        }
    }

    /// Restore a persisted view-state on startup (P12 / D-002). Selections are
    /// set directly and re-clamped when each tab's data arrives; the active
    /// harness is republished so the poller fetches the right harness's data.
    pub fn apply_view_state(&mut self, vs: &ViewState) -> Option<String> {
        let previous_theme = crate::theme::Theme::active_name().to_string();
        let mut restored_theme = None;

        if let Some(t) = vs.tab.as_deref().and_then(Tab::from_title) {
            self.tab = t;
        }
        if let Some(h) = &vs.harness {
            if !h.is_empty() {
                self.harness = h.clone();
                self.publish_active();
            }
        }
        // POTS scope axis (D-003): restore "all" vs "pot"; an absent value
        // (older snapshot) keeps the app default (all).
        match vs.scope.as_deref() {
            Some("pot") => self.all_pots = false,
            Some("all") => self.all_pots = true,
            _ => {}
        }
        if let Some(f) = vs.harness_focus.as_deref() {
            self.harness_focus = match f {
                "issues" => HarnessFocus::Issues,
                _ => HarnessFocus::Features,
            };
        }
        self.plan_sel = vs.plan_sel;
        self.inbox_sel = vs.inbox_sel;
        self.harness_sel = vs.harness_sel;
        self.feat_sel = vs.feat_sel;
        self.issue_sel = vs.issue_sel;
        self.doc_sel = vs.doc_sel;
        self.doc_scroll = vs.doc_scroll;
        self.testing_sel = vs.testing_sel;
        self.pane_sel = vs.pane_sel;
        self.show_presence = vs.show_presence;
        self.operator_dock_open = vs.operator_dock_open;
        self.fleet.agent_sel = vs.fleet_agent_sel;
        if let Some(m) = vs.fleet_mode.as_deref() {
            self.fleet.mode = crate::fleet::FleetMode::from_label(m);
        }
        // Plans filter (D-009): restore the selection + rail visibility.
        self.plan_filter = vs.plan_filter.iter().cloned().collect();
        self.plan_filter_open = vs.plan_filter_open;
        // `:theme` selection (P1 / D-002): an absent (older snapshot) or
        // unknown (renamed/removed theme) name keeps the default — never an
        // error at boot.
        if let Some(name) = vs.theme.as_deref() {
            if crate::theme::Theme::set_active(name)
                && crate::theme::Theme::active_name() != previous_theme
            {
                restored_theme = Some(crate::theme::Theme::active_name().to_string());
            }
        }

        restored_theme
    }

    /// Apply an agent control intent (P12b / D-002 A6 — tui:dispatch). Returns the
    /// JSON result to POST back (a state snapshot for `get_state`, else
    /// `{"ok":true}`); Err carries a message for the error result.
    pub fn apply_intent(&mut self, intent: &str, args: &Value) -> Result<Value, String> {
        match intent {
            "get_state" => Ok(self.state_snapshot()),
            // Operator pane-driving affordance (tui-operator-surface P2): focus
            // the operator chat pane. (`focus_pane` is handled upstream in the
            // reducer because it needs a companion side-effect Action.)
            "open_chat" => {
                self.tab = Tab::Operator;
                Ok(json!({ "ok": true, "tab": "Operator" }))
            }
            "set_tab" => {
                let title = args
                    .get("tab")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "set_tab: missing string `tab`".to_string())?;
                let tab = Tab::from_title(title)
                    .ok_or_else(|| format!("set_tab: unknown tab `{title}`"))?;
                self.tab = tab;
                Ok(json!({ "ok": true, "tab": tab.title() }))
            }
            "set_harness" => {
                let slug = args
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "set_harness: missing string `slug`".to_string())?;
                self.harness = slug.to_string();
                if let Some(i) = self.harnesses.iter().position(|h| h.slug == slug) {
                    self.harness_sel = i;
                }
                self.publish_active();
                Ok(json!({ "ok": true, "harness": slug }))
            }
            // Plans filter (D-009): set the slugs that narrow Inbox + the Fleet
            // roster ([] clears), optionally opening/closing the rail — keeps
            // the filter agent-driveable, not just key-driveable.
            "set_plan_filter" => {
                let plans = args
                    .get("plans")
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| "set_plan_filter: missing array `plans`".to_string())?;
                self.plan_filter = plans
                    .iter()
                    .filter_map(|v| v.as_str())
                    .map(str::to_string)
                    .collect();
                if let Some(open) = args.get("open").and_then(|v| v.as_bool()) {
                    self.plan_filter_open = open;
                }
                self.clamp_filtered_cursors();
                Ok(json!({
                    "ok": true,
                    "plan_filter": self.plan_filter.iter().cloned().collect::<Vec<_>>(),
                    "plan_filter_open": self.plan_filter_open,
                }))
            }
            "select" => {
                let list = args
                    .get("list")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "select: missing string `list`".to_string())?;
                let index = args
                    .get("index")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| "select: missing integer `index`".to_string())?
                    as usize;
                self.set_selection(list, index)?;
                Ok(json!({ "ok": true, "list": list, "index": index }))
            }
            other => Err(format!("unknown intent `{other}`")),
        }
    }

    /// Set a tab's selection cursor by list name (the `select` intent). Clamps to
    /// the current list length.
    fn set_selection(&mut self, list: &str, index: usize) -> Result<(), String> {
        let clamp = |len: usize| if len == 0 { 0 } else { index.min(len - 1) };
        match list {
            // Plans/Inbox cursors index the scope-filtered lists (D-003).
            "plans" => self.plan_sel = clamp(self.visible_plans().len()),
            "inbox" => self.inbox_sel = clamp(self.visible_inbox().len()),
            "features" => self.feat_sel = clamp(self.features.len()),
            "issues" => self.issue_sel = clamp(self.issues.len()),
            "docs" => {
                self.doc_sel = clamp(self.docs_files.len());
                self.publish_active_doc();
            }
            "harnesses" | "pots" => self.harness_sel = clamp(self.harnesses.len()),
            "testing" => self.testing_sel = clamp(self.testing.len()),
            "panes" | "plugins" => self.pane_sel = clamp(self.panes.len()),
            "flags" | "settings" => self.flag_sel = clamp(self.flags.len()),
            "memory" | "memories" => self.memory_sel = clamp(self.visible_memories().len()),
            // The Fleet tab (fleet ⋃ the old Sessions launcher, D-002b) shares one
            // cursor; every legacy alias resolves to it. Clamped to the
            // plans-filtered roster (D-009) — the list that actually renders.
            "agents" | "fleet" | "brew" | "roster" | "sessions" => {
                self.fleet.agent_sel = clamp(self.visible_roster().len())
            }
            other => return Err(format!("select: unknown list `{other}`")),
        }
        Ok(())
    }

    /// A JSON snapshot of the workbench state — the `get_state` intent result, so
    /// an agent can read where the HUD is without a screen scrape.
    pub fn state_snapshot(&self) -> Value {
        json!({
            "tab": self.tab.title(),
            "harness": self.harness,
            // Active palette (workbench-theme-system P1) — agent-visible like
            // every other user-meaningful state axis.
            "theme": crate::theme::Theme::active_name(),
            // POTS scope axis (D-003): "all" widens the global lists; "pot"
            // narrows them to `harness`.
            "scope": if self.all_pots { "all" } else { "pot" },
            "harness_focus": match self.harness_focus {
                HarnessFocus::Features => "features",
                HarnessFocus::Issues => "issues",
            },
            "selections": {
                "plan": self.plan_sel,
                "roster": self.fleet.agent_sel,
                "inbox": self.inbox_sel,
                "feature": self.feat_sel,
                "issue": self.issue_sel,
                "doc": self.doc_sel,
                "harness": self.harness_sel,
                "testing": self.testing_sel,
                "pane": self.pane_sel,
                "agent": self.fleet.agent_sel,
                "memory": self.memory_sel,
            },
            "counts": {
                "plans": self.visible_plans().len(),
                "roster": self.visible_roster().len(),
                "roster_total": self.roster.len(),
                "inbox": self.visible_inbox().len(),
                "features": self.features.len(),
                "issues": self.issues.len(),
                "docs": self.docs_files.len(),
                "harnesses": self.harnesses.len(),
                "testing": self.testing.len(),
                "panes": self.panes.len(),
                "flags": self.flags.len(),
                "memories": self.visible_memories().len(),
                "work_items": self.fleet.work_items.len(),
                "fleet_activity": self.fleet.activity.len(),
            },
            "doc_scroll": self.doc_scroll,
            "show_presence": self.show_presence,
            // The plans filter (D-009) — agent-visible so a driver can see what
            // narrows the Inbox/Fleet lists.
            "plan_filter": self.plan_filter.iter().cloned().collect::<Vec<_>>(),
            "plan_filter_open": self.plan_filter_open,
            "companion": self.companion_version,
            "unseen_notifs": self.unseen_notifs,
            "fleet_mode": self.fleet.mode.label(),
            // Operator chat pane state (tui-operator-surface) — lets the operator
            // see its own surface (open? streaming?) via get_state.
            "chat": {
                "messages": self.chat_messages.len(),
                "streaming": self.chat_streaming,
                "composing": self.chat_composing,
                // Operator dock (operator-always-visible-2026-06-05): whether the
                // chat is docked beside the active tab and whether it holds focus.
                "dock_open": self.operator_dock_open,
                "dock_focused": self.operator_dock_focused,
            },
            // Live zellij panes (from the companion) so the operator knows which
            // pane_id to drive with the focus_pane intent (P2).
            "panes": self.topology.as_ref().map(|t| {
                t.panes.iter().map(|p| json!({
                    "id": p.id,
                    "title": p.title,
                    "focused": p.focused,
                    "exited": p.exited,
                })).collect::<Vec<_>>()
            }).unwrap_or_default(),
        })
    }

    pub fn set_panes(&mut self, panes: Vec<TuiPaneContribution>) {
        self.panes = panes;
        if self.pane_sel >= self.panes.len() {
            self.pane_sel = self.panes.len().saturating_sub(1);
        }
    }

    /// Store the installed plugin manifests (D-007). Clamps the cursor; if the
    /// selected plugin changed identity, drops the stale loaded config.
    pub fn set_plugins(&mut self, plugins: Vec<crate::models::PluginManifest>) {
        let prev = self.selected_plugin().map(|p| p.name.clone());
        self.plugins = plugins;
        if self.plugin_sel >= self.plugins.len() {
            self.plugin_sel = self.plugins.len().saturating_sub(1);
        }
        if prev.as_deref() != self.selected_plugin().map(|p| p.name.as_str()) {
            self.plugin_config = None;
        }
    }

    /// The selected plugin manifest (D-007), or None when the list is empty.
    pub fn selected_plugin(&self) -> Option<&crate::models::PluginManifest> {
        self.plugins.get(self.plugin_sel)
    }

    /// The selected plugin's saved per-harness config, only when it's the one
    /// currently loaded (D-014). None otherwise — the detail pane shows "(load
    /// with Enter)" so a stale config never paints under the wrong plugin.
    pub fn selected_plugin_config(&self) -> Option<&serde_json::Value> {
        let name = self.selected_plugin()?.name.as_str();
        self.plugin_config
            .as_ref()
            .filter(|(p, _)| p == name)
            .map(|(_, c)| c)
    }

    /// The selected plan under the current pot scope (D-003): `plan_sel`
    /// indexes the VISIBLE (scope-filtered) list.
    pub fn selected_plan(&self) -> Option<&PlanSummary> {
        self.visible_plans().get(self.plan_sel).copied()
    }

    /// The (harness, slug) of the plan the plans BOARD has highlighted
    /// (`plans_board_sel` indexes the sorted `plans_board::board_rows`). Drives
    /// the board's right-side detail + the active-plan publish for the poller
    /// (pui-plans-status-board-2026-06-14 P-008). Resolves the harness the same
    /// way `publish_active_plan` does (the plan's own, else the session's).
    pub fn selected_board_plan(&self) -> Option<(String, String)> {
        let rows = crate::plans_board::board_rows(self);
        rows.get(self.plans_board_sel.min(rows.len().saturating_sub(1)))
            .map(|r| {
                let h = r
                    .plan
                    .harness
                    .clone()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| self.harness.clone());
                (h, r.plan.slug.clone())
            })
    }

    /// The work items backing the Plans surface's Items pane (owner ask
    /// 2026-06-16) — the fetched `plan_item_states` for the currently-selected
    /// plan, guarded so a stale fetch for a PRIOR plan never leaks the wrong
    /// items. Empty until the fetch lands (or when no plan is selected). Shared by
    /// `Tab::Plans` + `Tab::PlansBoard` (whichever is active).
    pub(crate) fn plans_items(&self) -> &[crate::models::PlanItemState] {
        let want = match self.tab {
            Tab::PlansBoard => self.selected_board_plan().map(|(_, slug)| slug),
            _ => self.selected_plan().map(|p| p.slug.clone()),
        };
        match (&self.plan_item_states, want) {
            (Some(s), Some(slug)) if s.plan == slug => s.items.as_slice(),
            _ => &[],
        }
    }

    /// The work item under the Plans Items-pane cursor (`plan_items_sel`), or
    /// `None` when the list is empty.
    pub(crate) fn selected_plan_item(&self) -> Option<&crate::models::PlanItemState> {
        self.plans_items().get(self.plan_items_sel)
    }

    /// The swarm pane's currently-selected bee (ownerId, agent-name) — the row
    /// `fleet.agent_sel` lands on in the visible roster. None when the roster is
    /// empty. Used to PUBLISH the selection to the bee-dossier relay (Feature 1).
    fn selected_bee(&self) -> Option<(String, Option<String>)> {
        self.visible_roster()
            .get(self.fleet.agent_sel)
            .map(|r| (r.owner_id.clone(), r.agent.clone()))
    }

    /// If the Fleet (swarm) tab is focused, publish the cursor's bee as the
    /// selection: the run loop applies it in-process (the Fleet-tab dossier —
    /// pui-dock-consolidation-2026-06-07) and POSTs the relay for external
    /// consumers. Off the Fleet tab → `Action::Render` (no-op publish). Called
    /// after a roster cursor move; entering Fleet leaves the selection empty so
    /// the whole-fleet view leads (#2).
    fn publish_swarm_selection(&self) -> Action {
        if self.tab != Tab::Fleet {
            return Action::Render;
        }
        match self.selected_bee() {
            Some((owner_id, name)) => Action::PublishBeeSelection {
                owner_id: Some(owner_id),
                name,
            },
            None => Action::PublishBeeSelection {
                owner_id: None,
                name: None,
            },
        }
    }

    /// The dock agent stack's bee panes to open THIS roster refresh
    /// (hive-agent-tabs P-004): one live `claude --resume <session_id>` Claude
    /// TUI per running FLEET BEE (`source == "fleet-spawn"` — Queen/orchestrator
    /// spawns; engineer shells and the brain are NOT paned — owner ask) not
    /// yet paned. Prunes departed owners from the dedup set so a returning
    /// bee re-panes; interactive launch panes are excluded via `tracked_panes`.
    fn bee_panes_to_open(&mut self) -> Vec<crate::mux::PaneSpec> {
        let is_bee = |r: &crate::models::RosterEntry| r.is_live() && r.source == "fleet-spawn";
        let live: std::collections::HashSet<&str> = self
            .roster
            .iter()
            .filter(|r| is_bee(r))
            .map(|r| r.owner_id.as_str())
            .collect();
        self.paned_bees.retain(|o| live.contains(o.as_str()));
        let mut out: Vec<(u8, crate::mux::PaneSpec)> = Vec::new();
        let mut opened_owners: Vec<String> = Vec::new();
        for r in &self.roster {
            if !is_bee(r) || self.paned_bees.contains(&r.owner_id) {
                continue;
            }
            // Already an interactive pane in this dock (a reactive launch).
            if r.adv_session_id
                .is_some_and(|id| self.tracked_panes.contains(&id))
            {
                continue;
            }
            // P-004: a claude bee resumes as a real Claude TUI (claude --resume
            // <session_id>). None = no resumable session yet (the watch-pane
            // fallback was retired by hive-agent-tabs P-014) — skip WITHOUT
            // marking opened, so the pane appears once the session id lands.
            let Some(argv) = r.dock_pane_argv() else {
                continue;
            };
            let title = r
                .agent
                .clone()
                .filter(|a| !a.is_empty())
                .map(|a| {
                    // P-012: the right side is the bee's current work (declared
                    // intent / feature) so the title bar summarises what it's doing.
                    let right = r.work_summary().unwrap_or_else(|| short_owner(&r.owner_id));
                    format!("{a} · {right}")
                })
                .unwrap_or_else(|| r.label.clone());
            let kind = crate::agent_pane_kind::AgentPaneKind::from_opt(&r.agent_pane_kind);
            // P-010: prefix the per-type glyph into the bee pane title (zellij
            // has no per-pane color — D-008 — so the glyph carries the type).
            let title = crate::agent_pane_kind::glyph_prefixed_title(&title, kind);
            out.push((
                // P-011: group same-type panes — the batch appends in group-rank
                // order so bees land together, planners together. Unknown → last.
                kind.map(|k| k.group_rank()).unwrap_or(u8::MAX),
                crate::mux::PaneSpec::new(argv)
                    .titled(title)
                    .stacked_autoclose(),
            ));
            // NOTE (owner ask 2026-06-11): bees do NOT get a per-bee wake pane
            // here. zellij stacks can't nest a chat|wakes split, and a bee is a
            // dynamically-stacked pane, so an INLINE per-bee wake pane needs the
            // companion to split a live pane (a staged follow-up). Bees review
            // their staged wakes via the fleet-wide "⏸ wakes" board for now; the
            // queen gets her inline split in the dock KDL (chat_dock_kdl).
            // Record the owner directly — the argv is `claude --resume
            // <session_id>` (no owner at argv[2]), so parsing argv would dedup on
            // the wrong key and re-pane the bee every refresh.
            opened_owners.push(r.owner_id.clone());
        }
        self.paned_bees.extend(opened_owners);
        // Stable by rank: roster order survives within a type group (P-011).
        out.sort_by_key(|(rank, _)| *rank);
        out.into_iter().map(|(_, spec)| spec).collect()
    }

    /// P-013: the zellij tab name for a deployed frame. The ☁ prefix marks it
    /// as a frame tab (and keeps it distinct from any user-named tab).
    pub fn frame_tab_name(slug: &str) -> String {
        format!("☁ {slug}")
    }

    /// P-013: the per-frame tabs to create THIS refresh — one zellij tab per
    /// deployed cloud frame not yet present. The LOCAL frame is the dock's own
    /// tab (it is never duplicated); each remote frame's tab holds that frame's
    /// agents as watch panes (host-matched roster entries — the PG-backed
    /// remote view; the streamed desktop stays the webview Frames tab, OQ-5).
    /// Topology is ground truth for "present"; `created_frame_tabs` covers the
    /// command→snapshot window. Returns (tab_name, kdl) pairs; gated to the
    /// flag-on dock driver. Pure over (frames, roster, topology) — unit-tested.
    pub fn frame_tabs_to_create(&mut self) -> Vec<(String, String)> {
        if !(self.hive_agent_tabs && self.dock_agent_panes) {
            return Vec::new();
        }
        // No companion topology yet → no tab surface to create into.
        let Some(topo) = &self.topology else {
            return Vec::new();
        };
        let existing: std::collections::HashSet<&str> =
            topo.tabs.iter().map(|t| t.name.as_str()).collect();
        let mut out = Vec::new();
        for fr in &self.frames {
            let name = Self::frame_tab_name(&fr.slug);
            if existing.contains(name.as_str()) || self.created_frame_tabs.contains(&name) {
                continue;
            }
            // The frame tab is a MARKER since hive-agent-tabs P-014 retired the
            // watch-pane surface — remote agents render via the webview Frames
            // tab; the zellij tab just navigates (no per-agent panes).
            let kdl = crate::layout::frame_tab_kdl(&name);
            self.created_frame_tabs.insert(name.clone());
            out.push((name, kdl));
        }
        out
    }

    /// B4 (P-004): the persistent per-hive AXIS tabs to create THIS roster
    /// refresh — one standing zellij tab per LIVE federated peer not yet present.
    /// The LOCAL hive is the dock's own "this hive" tab (never duplicated), and a
    /// quiet/stale hive is simply absent from `desired_hive_tabs` so it gets no
    /// tab. Topology is ground truth for "present"; `created_hive_tabs` covers the
    /// command→snapshot window. Gated to the flag-on dock driver (same
    /// precondition as the frame tabs). Pure over (hives, topology) — unit-tested.
    pub fn hive_tabs_to_create(&mut self) -> Vec<(String, String)> {
        if !(self.hive_agent_tabs && self.dock_agent_panes) {
            return Vec::new();
        }
        // No companion topology yet → no tab surface to create into.
        let Some(topo) = &self.topology else {
            return Vec::new();
        };
        let existing: std::collections::HashSet<&str> =
            topo.tabs.iter().map(|t| t.name.as_str()).collect();
        let groups = crate::hives::group_hives(&self.hives);
        let mut out = Vec::new();
        for spec in crate::layout::desired_hive_tabs(&groups) {
            let name = crate::layout::hive_axis_tab_name(&spec);
            if existing.contains(name.as_str()) || self.created_hive_tabs.contains(&name) {
                continue;
            }
            let kdl = crate::layout::hive_axis_tab_kdl(&spec);
            self.created_hive_tabs.insert(name.clone());
            out.push((name, kdl));
        }
        out
    }

    /// P-011: the dock agent stack regrouped by type. Reads each pane's kind
    /// back from its glyph-prefixed NAME (the P-010 channel — zellij carries no
    /// other per-pane metadata) and returns the agent panes' ids in group-rank
    /// order when the live order interleaves types. `None` = already grouped /
    /// nothing to regroup / not the flag-on dock driver. The run loop turns
    /// `Some(ids)` into a companion `stack_panes` (the D-008 repair verb), which
    /// re-stacks them in the given order.
    pub fn dock_regroup_ids(&self, topo: &pui_companion_proto::Topology) -> Option<Vec<u32>> {
        if !(self.hive_agent_tabs && self.dock_agent_panes) {
            return None;
        }
        let typed: Vec<(u32, u8)> = topo
            .panes
            .iter()
            .filter(|p| !p.is_plugin && !p.exited)
            .filter_map(|p| {
                crate::agent_pane_kind::AgentPaneKind::from_glyph_prefix(&p.title)
                    .map(|k| (p.id, k.group_rank()))
            })
            .collect();
        if typed.len() < 2 {
            return None;
        }
        let mut grouped = typed.clone();
        grouped.sort_by_key(|(_, rank)| *rank); // stable — in-type order survives
        if grouped == typed {
            return None;
        }
        Some(grouped.into_iter().map(|(id, _)| id).collect())
    }

    /// Per-bee wake-pane exit rule (owner ask 2026-06-11): an Owner-scoped
    /// `pui wake-pane <owner>` exits once its agent has been gone for 2
    /// consecutive roster refreshes AND its queue is drained — a dead bee's
    /// staged wakes stay reviewable until released/skipped. The dock's static
    /// panes (fleet-wide All, the queen's --queen) never self-exit.
    pub fn wake_pane_should_exit(&self) -> bool {
        matches!(self.wake_filter, WakeFilter::Owner(_))
            && self.wake_owner_misses >= 2
            && !self.wake_board.loading
            && self.wake_board.total() == 0
    }

    /// The tabs the strip shows + switch keys may reach — the full `Tab::ALL`
    /// (the dock tab-subset jail is gone — pui-dock-agent-stack-2026-06-07;
    /// zellij is reserved for the agent stack, tabs live in the pui app).
    pub fn visible_tabs(&self) -> Vec<Tab> {
        Tab::ALL.to_vec()
    }

    /// Store merged plan-item assignment/claim/liveness for the selected plan (P-005a).
    pub fn set_plan_item_states(&mut self, s: PlanItemStates) {
        self.plan_item_states = Some(s);
    }

    /// Publish the (harness, plan) the poller should fetch plan-item-states for:
    /// the selected plan while the Plans tab is focused, else None (so the poller
    /// skips the fetch off-tab). Mirrors `active_harness`/`active_doc` publishing;
    /// called once per reducer tick on key/data/restore events.
    pub fn publish_active_plan(&self) {
        if let Ok(mut g) = self.active_plan.lock() {
            *g = if self.tab == Tab::Plans {
                self.selected_plan().map(|p| {
                    let h = p
                        .harness
                        .clone()
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| self.harness.clone());
                    (h, p.slug.clone())
                })
            } else if self.tab == Tab::PlansBoard {
                // The pinned plans board's right-side work-items detail needs
                // the SELECTED board plan's item states; the poller keeps it
                // fresh between the immediate FetchPlanItemStates fetches on j/k
                // (pui-plans-status-board-2026-06-14 P-008).
                self.selected_board_plan()
            } else {
                None
            };
        }
    }

    pub fn selected_inbox(&self) -> Option<&AttentionItem> {
        self.visible_inbox().get(self.inbox_sel).copied()
    }

    /// The roster entry the Fleet tab has selected (the single shared cursor,
    /// `fleet.agent_sel`, after the Sessions↦Fleet merge — D-002b). Backs the
    /// dossier + the `n`-launch agent default. Indexes the plans-filtered
    /// roster (D-009) — the list the tab renders.
    pub fn selected_session(&self) -> Option<&RosterEntry> {
        self.visible_roster().get(self.fleet.agent_sel).copied()
    }

    pub fn selected_feature(&self) -> Option<&HarnessFeature> {
        self.features.get(self.feat_sel)
    }

    pub fn selected_issue(&self) -> Option<&HarnessIssue> {
        self.issues.get(self.issue_sel)
    }

    pub fn selected_pane(&self) -> Option<&TuiPaneContribution> {
        self.panes.get(self.pane_sel)
    }

    /// Build the launch command for the selected plugin pane (D-002): the
    /// contribution's `command` becomes the pane argv, titled `"<plugin> · <slug>"`,
    /// run inside its `cwd`. `None` when no pane is selected / the list is empty.
    pub fn plugin_launch_spec(&self) -> Option<PaneSpec> {
        let p = self.selected_pane()?;
        if p.command.is_empty() {
            return None;
        }
        let spec =
            PaneSpec::new(p.command.clone()).titled(format!("{} · {}", p.plugin_name, p.slug));
        Some(if p.cwd.is_empty() {
            spec
        } else {
            spec.cwd(p.cwd.clone())
        })
    }

    /// Build the launch command for a new agent pane. Reuses the selected
    /// session's agent if any, else defaults to claude. (Harness/plan wiring
    /// follows once those are selectable in the TUI.)
    pub fn launch_spec(&self) -> PaneSpec {
        let agent = self
            .selected_session()
            .and_then(|r| r.agent.clone())
            .unwrap_or_else(|| "claude".to_string());
        let argv = vec![
            "psu".to_string(),
            "--no-picker".to_string(),
            format!("--agent={agent}"),
        ];
        PaneSpec::new(argv).titled(format!("pui · {agent}"))
    }

    /// Build the resume pane spec for a roster entry — `psu --resume <id>` (the
    /// adv_sessions row id; psu resolves the row, cds to its cwd, and resumes the
    /// EXACT agent/session). `None` when the entry carries no launch record to
    /// resume. Enter-by-location ended-session route (D-001).
    pub fn resume_spec(&self, entry: &RosterEntry) -> Option<PaneSpec> {
        let id = entry.adv_session_id?;
        let agent = entry.agent.clone().unwrap_or_default();
        let argv = vec!["psu".to_string(), "--resume".to_string(), id.to_string()];
        let title = if agent.is_empty() {
            format!("resume · adv:{id}")
        } else {
            format!("resume · {agent}")
        };
        let mut spec = PaneSpec::new(argv).titled(title);
        if let Some(cwd) = entry.cwd.clone().filter(|c| !c.is_empty()) {
            spec = spec.cwd(cwd);
        }
        Some(spec)
    }

    /// The local hostname (best-effort, "" when unknown) — used to gate
    /// same-host external-window focus (a pid on another machine can't be
    /// wmctrl-focused here, and could collide with a local pid).
    fn local_host() -> String {
        std::env::var("HOSTNAME").unwrap_or_default()
    }

    /// Try to correlate a roster agent to a LIVE terminal pane in this workbench
    /// (Enter-by-location local route, D-001). Conservative on purpose: it
    /// returns a pane only on an UNAMBIGUOUS title/command match against the
    /// strongest identifier the entry carries (feature → plan → role → agent
    /// kind). Two panes matching the strongest needle → `None` (don't guess and
    /// focus the wrong agent); the caller then falls through to window/resume.
    fn match_local_pane(&self, entry: &RosterEntry) -> Option<u32> {
        let topo = self.topology.as_ref()?;
        let active = topo
            .tabs
            .iter()
            .find(|t| t.active)
            .map(|t| t.pos)
            .unwrap_or(0);
        let candidates: Vec<&pui_companion_proto::PaneNode> = topo
            .panes
            .iter()
            .filter(|p| p.tab == active && !p.is_plugin && !p.exited && !self.is_hud_node(p))
            .collect();
        if candidates.is_empty() {
            return None;
        }
        let needles: Vec<String> = [
            entry.feature.clone(),
            entry.current_plan_slug.clone(),
            entry.role.clone(),
            entry.agent.clone(),
        ]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .collect();
        for needle in &needles {
            let matched: Vec<u32> = candidates
                .iter()
                .filter(|p| {
                    p.title.to_lowercase().contains(needle)
                        || p.command
                            .as_deref()
                            .map(|c| c.to_lowercase().contains(needle))
                            .unwrap_or(false)
                })
                .map(|p| p.id)
                .collect();
            if matched.len() == 1 {
                return Some(matched[0]);
            }
            if matched.len() > 1 {
                return None; // ambiguous on the strongest needle → don't guess
            }
        }
        None
    }

    /// Build the `[r]/[n]/[f]` no-session menu for an agent (D-002). `[n] launch`
    /// is always offered; `r`/`f` only when the entry supports them. Pre-resolves
    /// the resume spec + focus handle so the menu keys fire without re-deriving.
    fn no_session_menu(
        &self,
        entry: &RosterEntry,
        note: &str,
        can_resume: bool,
        can_focus_window: bool,
    ) -> FleetActionMenu {
        let resume_spec = if can_resume {
            self.resume_spec(entry)
        } else {
            None
        };
        let focus = if can_focus_window {
            Some((entry.adv_session_id, entry.pid, entry.window_id.clone()))
        } else {
            None
        };
        FleetActionMenu {
            label: entry.label.clone(),
            note: note.to_string(),
            // Guard against a resume spec that couldn't be built (no launch id).
            can_resume: can_resume && resume_spec.is_some(),
            can_focus_window,
            resume_spec,
            focus,
        }
    }

    /// Resolve where the selected Fleet agent lives and how Enter reaches it
    /// (pui-workbench-usability D-001/D-002). Pure over the roster entry, the
    /// live topology, and the local host. A confidently-matched local pane wins
    /// (it is right here in the workbench). Otherwise a live agent focuses its
    /// external window, or opens the menu when it is unreachable so Enter never
    /// silently no-ops. Otherwise an ended-but-resumable session resumes. Failing
    /// all of that, the menu is shown.
    pub fn resolve_agent_route(&self, entry: &RosterEntry) -> AgentRoute {
        // 1. Local workbench pane — highest signal, no I/O needed.
        if let Some(pane_id) = self.match_local_pane(entry) {
            return AgentRoute::LocalPane { pane_id };
        }
        let host = Self::local_host();
        let can_focus_window = entry.has_window_handle(&host);
        let resumable = entry.is_resumable();
        if entry.is_live() {
            // Running elsewhere. Focus its window if we can reach it; otherwise
            // it's a remote / operator-PTY agent we can't reach from here — open
            // the menu ([n] launch; resume is hidden, it'd double-spawn a live
            // session — D-001 "check liveness first").
            if can_focus_window {
                return AgentRoute::FocusWindow {
                    adv_session_id: entry.adv_session_id,
                    pid: entry.pid,
                    window_id: entry.window_id.clone(),
                };
            }
            return AgentRoute::Menu(self.no_session_menu(
                entry,
                "agent is live but not reachable from this workbench",
                false,
                false,
            ));
        }
        // Ended / dead → resume is the right move (won't double-spawn).
        if resumable {
            if let Some(spec) = self.resume_spec(entry) {
                return AgentRoute::Resume { spec };
            }
        }
        // Nothing live, nothing to resume → menu ([n] launch; [f] in case a
        // window handle lingers).
        AgentRoute::Menu(self.no_session_menu(
            entry,
            "no running session — launch or resume",
            false,
            can_focus_window,
        ))
    }

    /// The Enter-route tag for a roster row (owner ask 2026-06-11): what WILL
    /// Enter do for this agent? Rendered as a trailing hint on every Fleet
    /// roster row so the route is visible BEFORE the keypress — previously a
    /// dead-but-unresumable agent's row looked identical to a resumable one's
    /// until Enter (visibly) did nothing. One source of truth: the exact
    /// resolve_agent_route the keypress takes.
    pub fn enter_hint(&self, entry: &RosterEntry) -> &'static str {
        match self.resolve_agent_route(entry) {
            AgentRoute::LocalPane { .. } => "⏎ pane",
            AgentRoute::FocusWindow { .. } => "⏎ window",
            AgentRoute::Resume { .. } => "⏎ resume",
            AgentRoute::Menu(_) => "⏎ menu",
        }
    }

    /// Enter on a Fleet-roster agent (D-001/D-002). Resolves the agent's location
    /// and acts: focus a local pane, focus an external window, resume an ended
    /// session, or open the `[r]/[n]/[f]` menu. With no agent selected (empty
    /// roster) Enter is a no-op render — the empty-work-area hint already tells
    /// the user to press `n`.
    ///
    /// Every direct route raises an immediate toast (owner ask 2026-06-11):
    /// pane-focus can silently no-op on a stale pane id and window-focus
    /// resolves asynchronously, so without it a failed Enter was
    /// indistinguishable from a dead key. The menu route needs none — the
    /// modal IS the feedback.
    fn fleet_enter(&mut self) -> Action {
        let Some(entry) = self.selected_session().cloned() else {
            return Action::Render;
        };
        match self.resolve_agent_route(&entry) {
            AgentRoute::LocalPane { pane_id } => {
                self.push_notif(Notif {
                    level: "info".into(),
                    message: format!("⏎ focusing workbench pane · {}", entry.label),
                    harness: None,
                    ts: None,
                });
                Action::FocusLocalPane { pane_id }
            }
            AgentRoute::FocusWindow {
                adv_session_id,
                pid,
                window_id,
            } => {
                self.push_notif(Notif {
                    level: "info".into(),
                    message: format!("⏎ focusing window · {} …", entry.label),
                    harness: None,
                    ts: None,
                });
                Action::FocusWindow {
                    adv_session_id,
                    pid,
                    window_id,
                    label: entry.label.clone(),
                }
            }
            AgentRoute::Resume { spec } => {
                self.push_notif(Notif {
                    level: "info".into(),
                    message: format!("⏎ resuming {} · {}", entry.label, spec.argv.join(" ")),
                    harness: None,
                    ts: None,
                });
                self.record_launch(&spec);
                Action::Launch(spec)
            }
            AgentRoute::Menu(menu) => {
                self.fleet_action_menu = Some(menu);
                Action::Render
            }
        }
    }

    /// Handle a key while the Fleet `[r]/[n]/[f]` no-session menu is open (D-002).
    /// `r` resumes (when viable), `n` launches a fresh agent, `f` focuses the
    /// window (when viable); Esc / any other key closes it. Always consumes the
    /// key (the menu is modal).
    fn fleet_menu_key(&mut self, code: KeyCode) -> Action {
        let Some(menu) = self.fleet_action_menu.clone() else {
            return Action::Render;
        };
        match code {
            KeyCode::Char('r') if menu.can_resume => {
                self.fleet_action_menu = None;
                if let Some(spec) = menu.resume_spec {
                    self.record_launch(&spec);
                    return Action::Launch(spec);
                }
                Action::Render
            }
            KeyCode::Char('n') => {
                self.fleet_action_menu = None;
                let spec = self.launch_spec();
                self.record_launch(&spec);
                Action::Launch(spec)
            }
            KeyCode::Char('f') if menu.can_focus_window => {
                self.fleet_action_menu = None;
                match menu.focus {
                    Some((adv_session_id, pid, window_id)) => Action::FocusWindow {
                        adv_session_id,
                        pid,
                        window_id,
                        label: menu.label,
                    },
                    None => Action::Render,
                }
            }
            _ => {
                // Esc / any non-action key closes the menu without acting.
                self.fleet_action_menu = None;
                Action::Render
            }
        }
    }

    /// Handle a key while the staged-wake review overlay is open (P-009). Two
    /// layers: EDITING (a live input buffer over the selected wake) consumes
    /// typing/Backspace, Enter releases with the edited content, Esc cancels the
    /// edit; otherwise j/k navigate, `r`/Enter release as-is, `e` opens the edit,
    /// `s` skips, Esc closes. Always consumes the key (the overlay is modal).
    fn wake_review_key(&mut self, code: KeyCode) -> Action {
        let Some(rev) = self.wake_review.as_mut() else {
            return Action::Render;
        };
        // Editing layer: the buffer owns printable keys until Enter/Esc.
        if let Some(buf) = rev.edit.as_mut() {
            return match code {
                KeyCode::Esc => {
                    rev.edit = None;
                    Action::Render
                }
                KeyCode::Backspace => {
                    buf.pop();
                    Action::Render
                }
                KeyCode::Enter => {
                    if rev.busy {
                        return Action::Render;
                    }
                    let edited = buf.trim().to_string();
                    let Some(pw) = rev.selected() else {
                        rev.edit = None;
                        return Action::Render;
                    };
                    let (agent, id) = (rev.agent.clone(), pw.id);
                    rev.busy = true;
                    rev.edit = None;
                    Action::WakeQueueAct {
                        agent,
                        release: true,
                        id,
                        edited: if edited.is_empty() {
                            None
                        } else {
                            Some(edited)
                        },
                    }
                }
                KeyCode::Char(c) => {
                    buf.push(c);
                    Action::Render
                }
                _ => Action::None,
            };
        }
        match code {
            KeyCode::Esc => {
                self.wake_review = None;
                Action::Render
            }
            KeyCode::Char('j') | KeyCode::Down => {
                if !rev.pending.is_empty() {
                    rev.sel = (rev.sel + 1).min(rev.pending.len() - 1);
                }
                Action::Render
            }
            KeyCode::Char('k') | KeyCode::Up => {
                rev.sel = rev.sel.saturating_sub(1);
                Action::Render
            }
            KeyCode::Char('e') => {
                // Open the edit buffer seeded with the staged content.
                if let Some(pw) = rev.selected() {
                    rev.edit = Some(pw.summary.clone().unwrap_or_default());
                }
                Action::Render
            }
            KeyCode::Char('r') | KeyCode::Enter => {
                if rev.busy {
                    return Action::Render;
                }
                let Some(pw) = rev.selected() else {
                    return Action::Render;
                };
                let (agent, id) = (rev.agent.clone(), pw.id);
                rev.busy = true;
                Action::WakeQueueAct {
                    agent,
                    release: true,
                    id,
                    edited: None,
                }
            }
            KeyCode::Char('s') => {
                if rev.busy {
                    return Action::Render;
                }
                let Some(pw) = rev.selected() else {
                    return Action::Render;
                };
                let (agent, id) = (rev.agent.clone(), pw.id);
                rev.busy = true;
                Action::WakeQueueAct {
                    agent,
                    release: false,
                    id,
                    edited: None,
                }
            }
            _ => Action::None,
        }
    }

    /// The wake-pane board's keymap (EI-312) — the WakeReview verbs over a
    /// flat multi-agent selection, plus the per-agent drains:
    /// j/k select · r/Enter release · e edit & release · s skip ·
    /// R release-all (selected agent, ONE coalesced wake) · S skip-all ·
    /// w toggle the selected agent's wake-mode · g refresh.
    fn wake_board_key(&mut self, code: KeyCode) -> Action {
        let b = &mut self.wake_board;
        // Editing layer: the buffer owns printable keys until Enter/Esc.
        if let Some(buf) = b.edit.as_mut() {
            return match code {
                KeyCode::Esc => {
                    b.edit = None;
                    Action::Render
                }
                KeyCode::Backspace => {
                    buf.pop();
                    Action::Render
                }
                KeyCode::Enter => {
                    if b.busy {
                        return Action::Render;
                    }
                    let edited = buf.trim().to_string();
                    let Some((g, pw)) = b.selected() else {
                        b.edit = None;
                        return Action::Render;
                    };
                    let (agent, id) = (g.agent.clone(), pw.id);
                    b.busy = true;
                    b.edit = None;
                    Action::WakeBoardAct {
                        agent,
                        verb: "release",
                        id: Some(id),
                        edited: if edited.is_empty() {
                            None
                        } else {
                            Some(edited)
                        },
                    }
                }
                KeyCode::Char(c) => {
                    buf.push(c);
                    Action::Render
                }
                _ => Action::None,
            };
        }
        match code {
            KeyCode::Char('j') | KeyCode::Down => {
                let total = b.total();
                if total > 0 {
                    b.sel = (b.sel + 1).min(total - 1);
                }
                Action::Render
            }
            KeyCode::Char('k') | KeyCode::Up => {
                b.sel = b.sel.saturating_sub(1);
                Action::Render
            }
            // Notifications history works in the pinned dock pane too (owner ask
            // 2026-06-11): the alert toast flashes here, so its history must be
            // openable here — the board otherwise owns the whole keymap and 'N'
            // never reached the generic handler.
            KeyCode::Char('N') => {
                self.show_notifs = true;
                self.toast = None;
                self.unseen_notifs = 0;
                Action::Render
            }
            KeyCode::Char('e') => {
                if let Some((_, pw)) = b.selected() {
                    let seed = pw.summary.clone().unwrap_or_default();
                    b.edit = Some(seed);
                }
                Action::Render
            }
            KeyCode::Char('r') | KeyCode::Enter => {
                if b.busy {
                    return Action::Render;
                }
                let Some((g, pw)) = b.selected() else {
                    return Action::Render;
                };
                let (agent, id) = (g.agent.clone(), pw.id);
                b.busy = true;
                Action::WakeBoardAct {
                    agent,
                    verb: "release",
                    id: Some(id),
                    edited: None,
                }
            }
            KeyCode::Char('s') => {
                if b.busy {
                    return Action::Render;
                }
                let Some((g, pw)) = b.selected() else {
                    return Action::Render;
                };
                let (agent, id) = (g.agent.clone(), pw.id);
                b.busy = true;
                Action::WakeBoardAct {
                    agent,
                    verb: "skip",
                    id: Some(id),
                    edited: None,
                }
            }
            KeyCode::Char('R') => {
                if b.busy {
                    return Action::Render;
                }
                let Some((g, _)) = b.selected() else {
                    return Action::Render;
                };
                let agent = g.agent.clone();
                b.busy = true;
                Action::WakeBoardAct {
                    agent,
                    verb: "release_all",
                    id: None,
                    edited: None,
                }
            }
            KeyCode::Char('S') => {
                if b.busy {
                    return Action::Render;
                }
                let Some((g, _)) = b.selected() else {
                    return Action::Render;
                };
                let agent = g.agent.clone();
                b.busy = true;
                Action::WakeBoardAct {
                    agent,
                    verb: "skip_all",
                    id: None,
                    edited: None,
                }
            }
            KeyCode::Char('w') => {
                // Toggle the SELECTED agent's wake mode (the P-008 toggle, here
                // so a paused queue can be un-paused without leaving the pane).
                let Some((g, _)) = b.selected() else {
                    return Action::Render;
                };
                let agent = g.agent.clone();
                let mode = next_wake_mode(g.wake_mode.as_deref());
                Action::SetWakeMode {
                    agent,
                    mode: mode.to_string(),
                }
            }
            KeyCode::Char('g') => Action::FetchWakeBoard,
            _ => Action::None,
        }
    }

    /// The pinned network-pane's keymap (hive-network-surface B-09): j/k move
    /// the board cursor, Enter fires the drill-in seam (B-10's per-hive tab),
    /// `g` refetches now (the refetch loop covers the push-driven cadence).
    /// The `pui hive-pane <key>` focused mode has no list — nav keys are inert
    /// there, only `g` acts.
    fn network_key(&mut self, code: KeyCode) -> Action {
        match code {
            KeyCode::Char('j') | KeyCode::Down => {
                if self.network_focus.is_none() && self.network_sel + 1 < self.network_rows.len() {
                    self.network_sel += 1;
                }
                Action::Render
            }
            KeyCode::Char('k') | KeyCode::Up => {
                if self.network_focus.is_none() {
                    self.network_sel = self.network_sel.saturating_sub(1);
                }
                Action::Render
            }
            KeyCode::Enter => {
                if self.network_focus.is_some() {
                    return Action::None;
                }
                match self.network_rows.get(self.network_sel) {
                    Some(row) => Action::OpenNetworkDrillIn(crate::network::drill_in(row)),
                    None => Action::None,
                }
            }
            KeyCode::Char('g') => Action::FetchNetworkBoard,
            _ => Action::None,
        }
    }

    /// Keymap for the pinned plans status board (`pui plans-pane`,
    /// pui-plans-status-board-2026-06-14). Two-level pane nav (owner ask
    /// 2026-06-16, the same idiom as the Colony tab): ←/→ (and ↑/↓ while
    /// BROWSING) switch the focused pane (plans list ↔ work items); Enter drills
    /// in; ↑/↓ then move WITHIN the focused pane; Enter again opens that row's
    /// detail popup; Esc steps back out. `g` forces a refetch at any level.
    fn plans_board_key(&mut self, code: KeyCode) -> Action {
        match code {
            KeyCode::Char('g') => Action::FetchPlansBoard,
            // ←/→ switch the focused pane at ANY level (browse or inside).
            KeyCode::Char('h') | KeyCode::Left | KeyCode::Char('l') | KeyCode::Right => {
                self.plans_focus = self.plans_focus.toggle();
                Action::Render
            }
            // ↑/↓ while BROWSING switch panes; once INSIDE they move within.
            KeyCode::Char('j') | KeyCode::Down if !self.plans_entered => {
                self.plans_focus = self.plans_focus.toggle();
                Action::Render
            }
            KeyCode::Char('k') | KeyCode::Up if !self.plans_entered => {
                self.plans_focus = self.plans_focus.toggle();
                Action::Render
            }
            KeyCode::Char('j') | KeyCode::Down => self.plans_board_within_move(1),
            KeyCode::Char('k') | KeyCode::Up => self.plans_board_within_move(-1),
            // Enter drills in (browse → inside), then opens the focused row's
            // detail popup; reusing the fleet-detail modal (owner ask 2026-06-15
            // #1 for the plan body, extended to work items 2026-06-16).
            KeyCode::Enter => {
                if !self.plans_entered {
                    self.plans_entered = true;
                    Action::Render
                } else {
                    self.plans_open_focused_detail()
                }
            }
            KeyCode::Esc if self.plans_entered => {
                self.plans_entered = false;
                Action::Render
            }
            _ => Action::None,
        }
    }

    /// ↑/↓ within the focused Plans-board pane (entered): the plans LIST moves the
    /// board cursor + fetches the new plan's items (resetting the items cursor);
    /// the ITEMS pane moves the work-item cursor. Clamped (no fall-through).
    fn plans_board_within_move(&mut self, delta: isize) -> Action {
        match self.plans_focus {
            PlansFocus::List => {
                let count = crate::plans_board::board_rows(self).len();
                self.plans_board_sel = step_clamped(self.plans_board_sel, delta, count);
                self.plan_items_sel = 0; // a new plan → its own items
                self.fetch_selected_board_item_states()
            }
            PlansFocus::Items => {
                let len = self.plans_items().len();
                self.plan_items_sel = step_clamped(self.plan_items_sel, delta, len);
                Action::Render
            }
        }
    }

    /// ↑/↓ on the in-app Plans tab (two-level nav, owner ask 2026-06-16): BROWSE
    /// between the plans-list and work-items panes when not entered, else move
    /// WITHIN the focused pane — the plans LIST moves `plan_sel` and refetches the
    /// new plan's items (resetting the items cursor); the ITEMS pane moves
    /// `plan_items_sel`. Clamped (no fall-through).
    fn plans_tab_arrow(&mut self, delta: isize) -> Action {
        if !self.plans_entered {
            self.plans_focus = self.plans_focus.toggle();
            return Action::Render;
        }
        match self.plans_focus {
            PlansFocus::List => {
                let len = self.visible_plans().len();
                self.plan_sel = step_clamped(self.plan_sel, delta, len);
                self.plan_items_sel = 0; // a new plan → its own items
                self.publish_active_plan();
                // Immediate fetch so the items pane updates promptly (the poller
                // also keeps it fresh between keystrokes).
                match self.selected_plan() {
                    Some(p) => {
                        let harness = p
                            .harness
                            .clone()
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| self.harness.clone());
                        Action::FetchPlanItemStates {
                            harness,
                            plan: p.slug.clone(),
                        }
                    }
                    None => Action::Render,
                }
            }
            PlansFocus::Items => {
                let len = self.plans_items().len();
                self.plan_items_sel = step_clamped(self.plan_items_sel, delta, len);
                Action::Render
            }
        }
    }

    /// Enter on the focused (entered) Plans pane: the plans LIST opens the plan
    /// detail popup; the ITEMS pane opens the selected work item's detail. Shared
    /// by `Tab::Plans` + `Tab::PlansBoard`. No-op on an empty list.
    fn plans_open_focused_detail(&mut self) -> Action {
        let has = match self.plans_focus {
            PlansFocus::List => {
                self.selected_plan().is_some() || self.selected_board_plan().is_some()
            }
            PlansFocus::Items => self.selected_plan_item().is_some(),
        };
        if has {
            self.fleet_detail_open = true;
            self.fleet_detail_scroll = 0;
        }
        Action::Render
    }

    /// Kick an immediate plan-item-states fetch for the board's now-selected
    /// plan so the right-side work-items detail updates promptly on j/k; a
    /// no-selection board just redraws (pui-plans-status-board-2026-06-14 P-008).
    fn fetch_selected_board_item_states(&self) -> Action {
        match self.selected_board_plan() {
            Some((harness, plan)) => Action::FetchPlanItemStates { harness, plan },
            None => Action::Render,
        }
    }

    /// Is this topology pane the pui HUD? (dockview D-008) — pui's own pane id
    /// first (`hud_pane_id`, read from `$ZELLIJ_PANE_ID`), then the command
    /// (`pui hud`), then the title (`pui`) as a fallback.
    fn is_hud_node(&self, p: &pui_companion_proto::PaneNode) -> bool {
        if self.hud_pane_id == Some(p.id) {
            return true;
        }
        if let Some(cmd) = &p.command {
            if cmd.contains("pui hud") {
                return true;
            }
        }
        p.title == "pui"
    }

    /// The active tab's WORK-area terminal pane ids from the live companion
    /// topology: non-plugin panes minus the HUD (D-004). Empty without a
    /// companion link (no topology) — the `:stack` verb then errors helpfully.
    pub fn work_pane_ids(&self) -> Vec<u32> {
        let Some(topo) = &self.topology else {
            return Vec::new();
        };
        let active = topo
            .tabs
            .iter()
            .find(|t| t.active)
            .map(|t| t.pos)
            .unwrap_or(0);
        topo.panes
            .iter()
            .filter(|p| p.tab == active && !p.is_plugin && !self.is_hud_node(p))
            .map(|p| p.id)
            .collect()
    }

    /// Resolve a `:float <target>` token to a pane id: a bare integer that names
    /// a live pane, else the first pane whose title or command contains the token
    /// (case-insensitive). `None` when there's no topology / no match.
    pub fn resolve_pane_target(&self, target: &str) -> Option<u32> {
        let topo = self.topology.as_ref()?;
        if let Ok(id) = target.parse::<u32>() {
            if topo.panes.iter().any(|p| p.id == id) {
                return Some(id);
            }
        }
        let needle = target.to_lowercase();
        topo.panes
            .iter()
            .find(|p| {
                p.title.to_lowercase().contains(&needle)
                    || p.command
                        .as_deref()
                        .map(|c| c.to_lowercase().contains(&needle))
                        .unwrap_or(false)
            })
            .map(|p| p.id)
    }

    /// Record that a workbench pane's command exited (P-004): raise a
    /// notification naming the pane — the "an agent exited" ping the human sees —
    /// mark it exited in the cached topology, and (for command/agent panes) arm
    /// `r`-to-relaunch with the exited command line.
    pub fn on_pane_exited(&mut self, pane_id: u32, exit_code: Option<i32>) {
        // Scope the immutable topology borrow so we can mutate it below.
        let (title, command) = {
            let exited = self
                .topology
                .as_ref()
                .and_then(|t| t.panes.iter().find(|p| p.id == pane_id));
            (
                exited
                    .map(|p| p.title.clone())
                    .unwrap_or_else(|| format!("pane {pane_id}")),
                exited.and_then(|p| p.command.clone()),
            )
        };
        let code = exit_code
            .map(|c| c.to_string())
            .unwrap_or_else(|| "?".to_string());
        // Offer relaunch only for panes that carry a command (agents/command
        // panes) — re-running a plain shell isn't meaningful.
        self.relaunch_command = command.clone();
        let hint = if command.is_some() {
            " — press r to relaunch"
        } else {
            ""
        };
        self.push_notif(Notif {
            level: "attention".to_string(),
            message: format!("{title} exited (code {code}){hint}"),
            harness: None,
            ts: None,
        });
        if let Some(p) = self
            .topology
            .as_mut()
            .and_then(|t| t.panes.iter_mut().find(|p| p.id == pane_id))
        {
            p.exited = true;
        }
    }

    /// Build a pane that relaunches the last-exited command/agent pane, if armed
    /// (P-004). Re-runs the original command line through `sh -c` — robust vs
    /// re-parsing argv, and it works whether or not the companion is present
    /// (`Action::Launch` routes through the plugin when linked, else `zellij
    /// action`).
    pub fn relaunch_spec(&self) -> Option<PaneSpec> {
        let cmd = self.relaunch_command.as_ref()?;
        let label = cmd.split_whitespace().next().unwrap_or("pane");
        Some(
            PaneSpec::new(["sh".to_string(), "-c".to_string(), cmd.clone()])
                .titled(format!("relaunch · {label}")),
        )
    }

    /// One-line workbench indicator for the status bar (P-004) — `None` until the
    /// companion plugin links, else `▦ N panes` plus `▶ <title>` for the focused
    /// (terminal) pane so the HUD follows the live focus. `▦` (glyph::nav::PANES)
    /// replaced the old double-width `⚡`, which broke the right-aligned HUD
    /// sizing (Brief 27 / D-002: row content is single-column only).
    pub fn workbench_summary(&self) -> Option<String> {
        self.companion_version.as_ref()?;
        let topo = self.topology.as_ref();
        let n = topo.map(|t| t.panes.len()).unwrap_or(0);
        let focused = topo
            .and_then(|t| t.panes.iter().find(|p| p.focused && !p.is_plugin))
            .map(|p| p.title.clone());
        let panes = crate::glyph::nav::PANES;
        Some(match focused {
            Some(title) => format!("{panes} {n} panes · {} {title}", crate::glyph::action::RUN),
            None => format!("{panes} {n} panes"),
        })
    }

    fn clamp_sel(&mut self) {
        // Plans/Inbox cursors index the scope-FILTERED lists (D-003).
        self.clamp_scope_sel();
        if self.feat_sel >= self.features.len() {
            self.feat_sel = self.features.len().saturating_sub(1);
        }
        if self.issue_sel >= self.issues.len() {
            self.issue_sel = self.issues.len().saturating_sub(1);
        }
    }

    /// The single reducer. Pure w.r.t. I/O, so it is unit-testable.
    pub fn update(&mut self, ev: Event) -> Action {
        match ev {
            Event::Key(key) => {
                // Voice-tab hold-to-talk (P-009): swallow auto-repeat of the PTT
                // key so a held key doesn't flap the transmit toggle (Press starts,
                // Release stops). Other keys and other tabs autorepeat as before.
                if self.tab == Tab::Voice
                    && key.kind == crossterm::event::KeyEventKind::Repeat
                    && crate::voice_ui::ptt_key_code(&self.voice_ui) == key.code
                {
                    return Action::None;
                }
                let action = self.on_key(key.code, key.modifiers);
                // The selection or tab may have changed — republish which plan the
                // poller should fetch plan-item-states for (P-005a).
                self.publish_active_plan();
                action
            }
            Event::Tick => Action::None,
            Event::Plans(p) => {
                self.set_plans(p);
                self.publish_active_plan();
                self.last_error = None;
                Action::Render
            }
            Event::Roster { active, pending } => {
                self.set_roster(active);
                self.last_error = None;
                // Per-bee wake pane (owner ask 2026-06-11): an Owner-scoped
                // wake-pane tracks its agent's roster presence the same way —
                // the run loop exits this instance once the agent is gone AND
                // the queue is drained (wake_pane_should_exit).
                if let WakeFilter::Owner(id) = &self.wake_filter {
                    let present = self.roster.iter().any(|r| &r.owner_id == id && !r.stale);
                    self.wake_owner_misses = if present {
                        0
                    } else {
                        self.wake_owner_misses.saturating_add(1)
                    };
                }
                // Reactively open work-area panes for new LOCAL workbench launches
                // (pui-reactive-session-panes D-006). The pure diff returns the
                // panes to open; record their ids so a refresh in the mark-launched
                // window can't re-open, and hand the specs to the run loop (I/O).
                let mut to_open = if self.reactive_launch_panes {
                    crate::session_panes::panes_to_open(
                        &self.tracked_panes,
                        &pending,
                        &self.local_host,
                    )
                } else {
                    // EI-358: board panes never launch sessions — only the full
                    // TUI / chat-pane / dock-driver react to pending launches.
                    Vec::new()
                };
                // The dock's agent stack (hive-agent-tabs P-004): one
                // `claude --resume` bee pane per active fleet bee, so the user
                // scrolls through ALL active agents in the dock.
                let bees = if self.dock_agent_panes {
                    for p in &mut to_open {
                        // Interactive launch panes join the dock stack too.
                        p.spec.stacked = true;
                    }
                    self.bee_panes_to_open()
                } else {
                    Vec::new()
                };
                if to_open.is_empty() && bees.is_empty() {
                    // Swarm pane: re-publish an EXISTING bee selection when the
                    // roster lands (keeps the relay fresh across roster churn).
                    // No selection → leave it that way: the default Fleet view is
                    // the whole fleet (#2); only a cursor move selects an agent.
                    if self.tab == Tab::Fleet && self.bee.owner_id.is_some() {
                        return self.publish_swarm_selection();
                    }
                    Action::Render
                } else {
                    for p in &to_open {
                        self.tracked_panes.insert(p.adv_session_id);
                        self.record_launch(&p.spec); // crew roster (P12b), as a manual launch
                    }
                    Action::LaunchPanes {
                        sessions: to_open,
                        bees,
                    }
                }
            }
            Event::FleetRate(s) => {
                self.fleet_rate = Some(s);
                Action::Render
            }
            Event::LaunchClaimRetry(id) => {
                // EI-358: transport-failed claim — un-track so the next roster
                // tick retries (the row is still pending server-side).
                self.tracked_panes.remove(&id);
                Action::Render
            }
            Event::Frames(frames) => {
                // P-013: the deployed-frame roster landed — create any missing
                // per-frame tabs (flag-on dock driver only; pure diff inside).
                self.frames = frames;
                let tabs = self.frame_tabs_to_create();
                if tabs.is_empty() {
                    Action::Render
                } else {
                    Action::CreateFrameTabs { tabs }
                }
            }
            // Realtime operator voice (voice-realtime-tui-2026-06-05): session
            // updates land in the SHARED operator chat (D-007) + phase badges.
            Event::VoiceUi(ev) => {
                crate::voice_ui::apply_event(&mut self.voice_ui, ev);
                Action::Render
            }
            Event::ConvAi(u) => {
                use crate::voice_convai::ConvAiUpdate as U;
                match u {
                    U::Connected { conversation_id } => {
                        // The shared operator thread id (universal-voice D-005):
                        // backfill the app's conversation pointer when chat
                        // history hasn't loaded yet, so history paging + the
                        // conversation-gated features work in a voice-first
                        // session too.
                        if self.conversation_id.is_none() && !conversation_id.is_empty() {
                            self.conversation_id = Some(conversation_id);
                        }
                        self.convai_phase = ConvAiPhase::Live;
                        self.push_notif(Notif {
                            level: "info".into(),
                            message: "voice live — talk to the operator (V stops)".into(),
                            harness: None,
                            ts: None,
                        });
                    }
                    U::SessionState {
                        muted,
                        mode,
                        is_player,
                    } => {
                        self.convai_phase = ConvAiPhase::Live;
                        self.convai_muted = muted;
                        self.convai_mode = mode;
                        self.convai_is_player = is_player;
                        if self.convai_mode != "push-to-talk" {
                            self.convai_ptt_active = false;
                        }
                    }
                    U::UserTranscript(t) => {
                        self.chat_messages.push(ChatMessage::user(&t));
                        self.chat_scroll = 0; // snap to latest
                    }
                    U::AgentText(raw) => {
                        // The agent already SPOKE this; render the clean text
                        // in the transcript, surface a
                        // <set_mode> as a toast (the mode itself is a
                        // desktop-session concept — operator-converse-voice).
                        if let Some(mode) = crate::voice_convai::utterance_set_mode(&raw) {
                            self.push_notif(Notif {
                                level: "info".into(),
                                message: format!("operator mode → {mode}"),
                                harness: None,
                                ts: None,
                            });
                        }
                        let display = crate::chat_tags::finalize(&raw);
                        if !display.trim().is_empty() {
                            self.chat_messages.push(ChatMessage::assistant(&display));
                            self.chat_scroll = 0;
                        }
                    }
                    U::Ended { reason } => {
                        self.convai_phase = ConvAiPhase::Off;
                        self.convai_is_player = false;
                        self.convai_ptt_active = false;
                        self.push_notif(Notif {
                            level: "attention".into(),
                            message: reason,
                            harness: None,
                            ts: None,
                        });
                    }
                    U::Error(e) => {
                        self.convai_phase = ConvAiPhase::Off;
                        self.convai_is_player = false;
                        self.convai_ptt_active = false;
                        // Toast AND status line: the poller's success events
                        // wipe last_error within ms, so a one-shot session
                        // error must also land somewhere durable (the toast +
                        // notifs history).
                        self.push_notif(Notif {
                            level: "error".into(),
                            message: e.clone(),
                            harness: None,
                            ts: None,
                        });
                        self.last_error = Some(e);
                    }
                }
                Action::Render
            }
            Event::Inbox(i) => {
                self.set_inbox(i);
                self.last_error = None;
                Action::Render
            }
            Event::Features(fs) => {
                self.set_features(fs);
                self.last_error = None;
                Action::Render
            }
            Event::Issues(is) => {
                self.set_issues(is);
                self.last_error = None;
                Action::Render
            }
            Event::Harnesses(hs) => {
                self.set_harnesses(hs);
                self.last_error = None;
                Action::Render
            }
            Event::Docs(d) => {
                self.set_docs(d);
                self.last_error = None;
                Action::Render
            }
            Event::Testing(t) => {
                self.set_testing(t);
                self.last_error = None;
                Action::Render
            }
            Event::TestingFiles { domain_id, files } => {
                // Stale-guard: only paint files for the domain that is STILL
                // selected (mirrors the plan-item-states guard).
                if self.testing.get(self.testing_sel).map(|d| d.id.as_str())
                    == Some(domain_id.as_str())
                {
                    self.testing_files = files;
                    self.testing_file_sel = 0;
                    self.testing_files_loading = false;
                    self.testing_focus = TestingFocus::Files;
                }
                self.last_error = None;
                Action::Render
            }
            Event::Memories { available, results } => {
                self.memory_available = available;
                self.memories = results;
                let len = self.visible_memories().len();
                if self.memory_sel >= len {
                    self.memory_sel = len.saturating_sub(1);
                }
                self.last_error = None;
                Action::Render
            }
            Event::MemoryHits { query, results } => {
                // Only paint hits for the query that is still active (a cleared
                // search drops a late response).
                if self.memory_hits.as_ref().is_some_and(|(q, _)| *q == query) {
                    self.memory_hits = Some((query, results));
                    self.memory_sel = 0;
                }
                self.last_error = None;
                Action::Render
            }
            Event::TestRunDone { file, result } => {
                self.test_run = Some(TestRunState {
                    running: false,
                    file,
                    status: if result.status.is_empty() {
                        format!("exit {}", result.exit_code)
                    } else {
                        result.status
                    },
                    output: result.output,
                });
                Action::Render
            }
            Event::Config(c) => {
                self.set_config(c);
                self.last_error = None;
                Action::Render
            }
            Event::Flags(fl) => {
                self.set_flags(fl);
                self.last_error = None;
                Action::Render
            }
            Event::PlanItemStates(s) => {
                self.set_plan_item_states(s);
                self.last_error = None;
                Action::Render
            }
            Event::OperatorConfig(c) => {
                self.set_operator_config(c);
                self.last_error = None;
                Action::Render
            }
            Event::WorkItems(w) => {
                self.fleet.set_work_items(w);
                self.last_error = None;
                Action::Render
            }
            Event::ActivitySeed(a) => {
                self.fleet.seed_activity(a);
                self.last_error = None;
                Action::Render
            }
            Event::ActivityTodos(a) => {
                self.fleet.seed_todos(&a);
                self.last_error = None;
                Action::Render
            }
            Event::ActivityLive(a) => {
                self.fleet.push_activity(a);
                self.last_error = None;
                Action::Render
            }
            Event::BeeSelection { owner_id, name } => {
                // The relay poll observed a (possibly new) selection. The fetch is
                // triggered by the poll task itself on change; here we only store
                // the selection (clearing the stale dossier on a change).
                self.bee.set_selection(owner_id, name);
                Action::Render
            }
            Event::BeeDossier {
                owner_id,
                assignment,
                mail,
            } => {
                // Stale-guard: only paint a dossier for the currently selected bee.
                self.bee.set_dossier(&owner_id, assignment, mail);
                self.last_error = None;
                Action::Render
            }
            Event::FleetAssignments(agents) => {
                // Whole-fleet task list landed (the default Swarm dossier, #2).
                self.fleet.all_assignments = agents;
                Action::Render
            }
            Event::Hives(rows) => {
                // The federated p2p roster landed (the Hives tab). Raw rows;
                // per-device grouping happens at render (hives::group_hives).
                self.hives = rows;
                // B4 (P-004): sync the persistent per-hive tab axis — a standing
                // tab opens for any live federated peer not already present (pure
                // diff; flag-on dock driver only). Mirrors Frames→frame-tabs.
                let tabs = self.hive_tabs_to_create();
                if tabs.is_empty() {
                    Action::Render
                } else {
                    Action::CreateHiveTabs { tabs }
                }
            }
            Event::HiveDirectory(rows) => {
                // The P2P hive directory landed (p2p-hive-directory P-006).
                self.hive_directory = rows;
                if self.hive_dir_sel >= self.hive_directory.len() {
                    self.hive_dir_sel = self.hive_directory.len().saturating_sub(1);
                }
                Action::Render
            }
            Event::NetworkBoard(rows) => {
                // The cross-Hive network board landed (B-09): a whole C-3
                // snapshot — replace + clamp the cursor.
                self.network_rows = rows;
                if self.network_sel >= self.network_rows.len() {
                    self.network_sel = self.network_rows.len().saturating_sub(1);
                }
                Action::Render
            }
            Event::HiveDossier { beacons, asks } => {
                // The drill-in dossier data landed (P-014 item 2): a whole
                // snapshot for the pinned hive-pane key — replace both lists.
                self.hive_beacons = beacons;
                self.hive_asks = asks;
                Action::Render
            }
            Event::WakeQueue { agent, result } => {
                // P-009: a staged-wake list (or an act error) landed. Stale-guard
                // on the agent so a late response never paints another agent's
                // overlay; a closed overlay drops the event silently.
                if let Some(rev) = self.wake_review.as_mut() {
                    if rev.agent == agent {
                        rev.loading = false;
                        rev.busy = false;
                        match result {
                            Ok(pending) => {
                                rev.error = None;
                                rev.pending = pending;
                                if rev.sel >= rev.pending.len() {
                                    rev.sel = rev.pending.len().saturating_sub(1);
                                }
                            }
                            Err(e) => rev.error = Some(e),
                        }
                    }
                }
                Action::Render
            }
            Event::WakeBoard { result } => {
                // EI-312: a fleet-wide staged-wake snapshot landed (or an act
                // error). Whole-snapshot replace; clamp the flat selection.
                let b = &mut self.wake_board;
                b.loading = false;
                b.busy = false;
                match result {
                    Ok((groups, global_mode)) => {
                        b.error = None;
                        b.groups = groups;
                        b.global_mode = global_mode;
                        let total = b.total();
                        if b.sel >= total {
                            b.sel = total.saturating_sub(1);
                        }
                    }
                    Err(e) => b.error = Some(e),
                }
                Action::Render
            }
            Event::AgentCtx { result } => {
                // Dock 4-pane split: an agent-context snapshot landed.
                // Whole-snapshot replace, same shape as the wake board.
                self.agent_ctx = Some(result);
                Action::Render
            }
            Event::LexiconPack(payload) => {
                // The active brand pack landed (startup fetch). Store the resolved
                // term→label map; user-facing labels route through it from now on.
                self.lexicon = crate::lexicon::Lexicon::from_payload(&payload);
                Action::Render
            }
            Event::CupboardListings {
                kind,
                query,
                listings,
            } => {
                // Stale-guard (D-011): drop a response whose (kind, query) the
                // user has since changed — only the latest filter paints.
                if kind == CUPBOARD_KINDS[self.cupboard_kind] && query == self.cupboard_query {
                    self.cupboard = listings;
                    self.cupboard_loading = false;
                    if self.cupboard_sel >= self.cupboard.len() {
                        self.cupboard_sel = self.cupboard.len().saturating_sub(1);
                    }
                    self.last_error = None;
                }
                Action::Render
            }
            Event::Conversations(list) => {
                // Brief 25: the list under the active state/kind filter landed.
                self.conversations = list;
                self.conversations_loading = false;
                if self.conversation_sel >= self.conversations.len() {
                    self.conversation_sel = self.conversations.len().saturating_sub(1);
                }
                // Drop a client-side topic filter no longer present in the page.
                if let Some(t) = self.conv_topic.clone() {
                    if !self
                        .conversations
                        .iter()
                        .any(|c| c.topics.iter().any(|x| x == &t))
                    {
                        self.conv_topic = None;
                    }
                }
                self.last_error = None;
                Action::Render
            }
            Event::ConversationDetail { id, detail } => {
                // Stale-guard: only paint if it's still the selected conversation.
                let matches =
                    self.selected_conversation().map(|c| c.id.clone()) == Some(id.clone());
                if matches {
                    self.conversation_detail = Some(detail);
                    self.last_error = None;
                }
                Action::Render
            }
            Event::TuiPanes(p) => {
                self.set_panes(p);
                self.last_error = None;
                Action::Render
            }
            Event::Plugins(p) => {
                self.set_plugins(p);
                self.last_error = None;
                Action::Render
            }
            Event::PluginConfig { plugin, config } => {
                self.plugin_config = Some((plugin, config));
                self.last_error = None;
                Action::Render
            }
            Event::Notify(n) => {
                self.push_notif(n);
                self.last_error = None;
                Action::Render
            }
            Event::ToastHistory(h) => {
                self.set_notif_history(h);
                Action::Render
            }
            Event::Error(e) => {
                self.last_error = Some(e);
                Action::Render
            }
            Event::ViewStateLoaded(vs) => {
                let restored_theme = self.apply_view_state(&vs);
                // Restore may land us on the Plans tab — publish so the poller fetches
                // the selected plan's item-states on first paint (P-005a).
                self.publish_active_plan();
                match restored_theme {
                    Some(name) => Action::Workbench(PaletteCommand::Theme { name: Some(name) }),
                    None => Action::Render,
                }
            }
            Event::TuiIntent { id, intent, args } => {
                // `focus_pane` is a side-effecting intent: it drives the companion
                // zellij plugin, which the reducer can't reach — emit a dedicated
                // Action the run loop executes (then it POSTs the result back).
                if intent == "focus_pane" {
                    return match args.get("pane_id").and_then(|v| v.as_u64()) {
                        Some(pid) => Action::FocusPane {
                            intent_id: id,
                            pane_id: pid as u32,
                        },
                        None => Action::IntentResult {
                            id,
                            result_json: "null".to_string(),
                            error: Some("focus_pane: missing integer `pane_id`".to_string()),
                        },
                    };
                }
                match self.apply_intent(&intent, &args) {
                    Ok(result) => Action::IntentResult {
                        id,
                        result_json: result.to_string(),
                        error: None,
                    },
                    Err(e) => Action::IntentResult {
                        id,
                        result_json: "null".to_string(),
                        error: Some(e),
                    },
                }
            }
            // --- Operator chat pane (tui-operator-surface-2026-06-04) ---
            Event::ChatHistory {
                conversation_id,
                messages,
                has_more_earlier,
                oldest_seq,
            } => {
                self.set_chat_history(conversation_id, messages, has_more_earlier, oldest_seq);
                Action::Render
            }
            Event::ChatEarlier {
                messages,
                has_more_earlier,
                oldest_seq,
            } => {
                self.prepend_chat_earlier(messages, has_more_earlier, oldest_seq);
                Action::Render
            }
            Event::ChatDelta(t) => {
                self.push_chat_delta(&t);
                Action::Render
            }
            Event::ChatToolCall(tc) => {
                self.push_chat_tool(tc);
                Action::Render
            }
            Event::ChatDone => {
                self.finish_chat_turn();
                Action::Render
            }
            Event::ChatError(e) => {
                self.fail_chat_turn(&e);
                // A converse failure during a voice turn (P2) leaves the phase
                // stuck at Thinking — reset it so PTT is usable again.
                if self.voice_phase.is_active() {
                    self.voice_phase = VoicePhase::Idle;
                    self.voice_level = 0.0;
                    self.voice_error = Some(e);
                }
                Action::Render
            }
            // --- Inline cards (sentinel-tui-shared-backend-and-cards Phase 2a) ---
            Event::CardSnapshot(env) => {
                self.card_state.apply_snapshot(env);
                Action::Render
            }
            Event::CardWorkspace(ws) => {
                self.card_workspace = ws;
                Action::None
            }
            // --- Companion zellij plugin (P-004 / D-008) ---
            Event::CompanionReady(version) => {
                self.companion_version = Some(version);
                self.last_error = None;
                Action::Render
            }
            Event::Topology(t) => {
                // P-011: when the flag-on dock's agent stack interleaves types,
                // ask the companion to re-stack it grouped (sentinel · queen ·
                // bees · planners). Guarded against command spam: one repair per
                // distinct target order — a re-snapshot of the same mis-order
                // doesn't refire, and reaching a grouped state re-arms it.
                let regroup = self.dock_regroup_ids(&t);
                self.topology = Some(t);
                match regroup {
                    Some(ids) if self.last_regroup.as_ref() != Some(&ids) => {
                        self.last_regroup = Some(ids.clone());
                        Action::Dock(DockCmd::Stack { pane_ids: ids })
                    }
                    Some(_) => Action::Render,
                    None => {
                        self.last_regroup = None;
                        Action::Render
                    }
                }
            }
            Event::PaneExited { pane_id, exit_code } => {
                self.on_pane_exited(pane_id, exit_code);
                Action::Render
            }
            Event::PaneClosed { pane_id } => {
                if let Some(t) = self.topology.as_mut() {
                    t.panes.retain(|p| p.id != pane_id);
                }
                Action::Render
            }
            // --- Voice mode (voice-mode-tui-port-2026-06-05 P2) ---
            Event::Voice(msg) => {
                self.on_voice(msg);
                Action::Render
            }
            // A key RELEASE (kitty protocol only). On the Voice tab it ends
            // hold-to-talk transmit into the P2P channel (P-009); on the Operator
            // tab/dock it stops the voice-mode PTT recording. Else ignored.
            Event::KeyRelease(key) => {
                if self.tab == Tab::Voice {
                    if let Some(cmd) = crate::voice_ui::handle_release(&self.voice_ui, key.code) {
                        return Action::VoiceChan(cmd);
                    }
                    return Action::None;
                }
                if key.code == KeyCode::Char('v')
                    && self.convai_phase != ConvAiPhase::Off
                    && self.convai_mode == "push-to-talk"
                    && self.convai_ptt_active
                {
                    self.convai_ptt_active = false;
                    return Action::VoiceSessionControl(crate::voice_convai::ConvAiControl::Ptt(
                        false,
                    ));
                }
                if key.code == KeyCode::Char('v')
                    && self.voice_phase == VoicePhase::Recording
                    && self.voice_key_active()
                {
                    return Action::Voice(VoiceCmd::Stop);
                }
                Action::None
            }
        }
    }

    fn on_key(&mut self, code: KeyCode, mods: KeyModifiers) -> Action {
        // First-run tutorial (P9): Esc skips; any other key advances a step and
        // closes after the last. Swallows the key (nothing else reacts).
        if self.show_tutorial {
            if code == KeyCode::Esc {
                self.show_tutorial = false;
            } else {
                self.tutorial_step += 1;
                if self.tutorial_step >= crate::tutorial::STEPS {
                    self.show_tutorial = false;
                }
            }
            return Action::Render;
        }
        // Notifications history overlay: any key closes it.
        if self.show_notifs {
            self.show_notifs = false;
            return Action::Render;
        }
        // Inline card modal (sentinel-tui-shared-backend-and-cards Phase 2a):
        // when an open `chat:ask_choice` card is focused on the operator surface,
        // it's a BLOCKING prompt (the brain's tool call is awaiting) — capture
        // navigation/answer keys here, before the composer/tab keys see them.
        // Ctrl-C still quits (the universal escape hatch).
        let ctrl_c_global = code == KeyCode::Char('c') && mods.contains(KeyModifiers::CONTROL);
        if self.operator_input_active() && self.card_state.has_card() && !ctrl_c_global {
            return self.card_key(code);
        }
        // Comms detail popup (owner ask 2026-06-14): modal while open. Esc/`q`
        // close; `j`/`k` (↓/↑) step to the next/prev item WITHIN the focused
        // panel (clamped — no fall-through here, the popup stays on one list);
        // every other key is swallowed so it can't drive the dock underneath.
        if self.fleet_detail_open {
            return match code {
                KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => {
                    self.fleet_detail_open = false;
                    Action::Render
                }
                KeyCode::Char('j') | KeyCode::Down => self.fleet_detail_step(1),
                KeyCode::Char('k') | KeyCode::Up => self.fleet_detail_step(-1),
                // PageDown/PageUp scroll a long body/thread; render clamps to the
                // content so PageDown can't run off the end (owner ask 2026-06-14).
                KeyCode::PageDown => {
                    self.fleet_detail_scroll = self
                        .fleet_detail_scroll
                        .saturating_add(FLEET_DETAIL_SCROLL_STEP);
                    Action::Render
                }
                KeyCode::PageUp => {
                    self.fleet_detail_scroll = self
                        .fleet_detail_scroll
                        .saturating_sub(FLEET_DETAIL_SCROLL_STEP);
                    Action::Render
                }
                _ => Action::Render,
            };
        }
        // Staged-wake review overlay (P-009): modal while open — j/k select,
        // r release · e edit & release · s skip · Esc close/cancel-edit.
        if self.wake_review.is_some() {
            return self.wake_review_key(code);
        }
        // The pinned wake-pane (EI-312): the board owns the whole keymap —
        // there is no tab strip to navigate in a pinned dock pane.
        if self.tab == Tab::Wake {
            return self.wake_board_key(code);
        }
        // The pinned network-pane / hive-pane (hive-network-surface B-09):
        // the board owns the whole keymap, the wake-pane convention.
        if self.tab == Tab::Network {
            return self.network_key(code);
        }
        // The pinned plans-pane (pui-plans-status-board-2026-06-14): the board
        // owns the whole keymap — j/k move the highlight, g refreshes; there is
        // no tab strip to navigate in a pinned dock pane.
        if self.tab == Tab::PlansBoard {
            return self.plans_board_key(code);
        }
        // The pinned agent-context panes (dock 4-pane split): j/k scroll,
        // N opens the notifications history, everything else is swallowed
        // (no tab strip to navigate here either).
        if self.tab == Tab::AgentCtx {
            return match code {
                KeyCode::Char('j') | KeyCode::Down => {
                    self.agent_ctx_scroll = self.agent_ctx_scroll.saturating_add(1);
                    Action::Render
                }
                KeyCode::Char('k') | KeyCode::Up => {
                    self.agent_ctx_scroll = self.agent_ctx_scroll.saturating_sub(1);
                    Action::Render
                }
                KeyCode::Char('N') => {
                    self.show_notifs = true;
                    self.toast = None;
                    self.unseen_notifs = 0;
                    Action::Render
                }
                _ => Action::None,
            };
        }
        // Fleet no-session action menu (D-002): captures r/n/f/Esc while open so
        // the choices fire (or it closes) before any tab navigation.
        if self.fleet_action_menu.is_some() {
            return self.fleet_menu_key(code);
        }
        // Pot-picker overlay (D-003) captures navigation while open: j/k moves
        // over ["All Pots", ...pots], Enter applies, Esc closes unchanged.
        if self.pot_picker_open {
            return match code {
                KeyCode::Esc => {
                    self.pot_picker_open = false;
                    Action::Render
                }
                KeyCode::Enter => {
                    let idx = self.pot_picker_sel;
                    self.pot_picker_open = false;
                    self.apply_pot_choice(idx);
                    Action::Render
                }
                KeyCode::Char('j') | KeyCode::Down => {
                    self.pot_picker_sel = (self.pot_picker_sel + 1).min(self.harnesses.len());
                    Action::Render
                }
                KeyCode::Char('k') | KeyCode::Up => {
                    self.pot_picker_sel = self.pot_picker_sel.saturating_sub(1);
                    Action::Render
                }
                _ => Action::None,
            };
        }
        // Memory search composer (D-006): captures all input while open, like
        // the palette. Enter fires the semantic search; Esc cancels.
        if self.memory_search_open {
            return match code {
                KeyCode::Esc => {
                    self.memory_search_open = false;
                    self.memory_search_input.clear();
                    Action::Render
                }
                KeyCode::Enter => {
                    let query = self.memory_search_input.trim().to_string();
                    self.memory_search_open = false;
                    self.memory_search_input.clear();
                    if query.is_empty() {
                        return Action::Render;
                    }
                    // Mark the active query; hits land via Event::MemoryHits.
                    self.memory_hits = Some((query.clone(), Vec::new()));
                    self.memory_sel = 0;
                    Action::SearchMemory {
                        query,
                        harness: self.harness.clone(),
                    }
                }
                KeyCode::Backspace => {
                    self.memory_search_input.pop();
                    Action::Render
                }
                KeyCode::Char(c) => {
                    self.memory_search_input.push(c);
                    Action::Render
                }
                _ => Action::None,
            };
        }
        // Cupboard search composer (D-011): captures all input while open,
        // mirroring the Memory composer. Enter refetches with the query.
        if self.cupboard_search_open {
            return match code {
                KeyCode::Esc => {
                    self.cupboard_search_open = false;
                    self.cupboard_search_input.clear();
                    Action::Render
                }
                KeyCode::Enter => {
                    self.cupboard_search_open = false;
                    self.cupboard_query = self.cupboard_search_input.trim().to_string();
                    self.cupboard_search_input.clear();
                    self.cupboard_sel = 0;
                    self.cupboard_confirm = None;
                    self.refetch_cupboard()
                }
                KeyCode::Backspace => {
                    self.cupboard_search_input.pop();
                    Action::Render
                }
                KeyCode::Char(c) => {
                    self.cupboard_search_input.push(c);
                    Action::Render
                }
                _ => Action::None,
            };
        }
        // Command palette captures all input while open.
        if self.palette_open {
            return match code {
                KeyCode::Esc => {
                    self.palette_open = false;
                    self.palette_input.clear();
                    Action::Render
                }
                KeyCode::Enter => {
                    let line = self
                        .palette_input
                        .trim()
                        .strip_prefix(':')
                        .unwrap_or(self.palette_input.trim())
                        .trim()
                        .to_string();
                    // Parse the palette line into a workbench command (P12b).
                    let cmd = parse_palette_command(&self.palette_input);
                    self.palette_open = false;
                    self.palette_input.clear();
                    // `:tutorial` re-opens the guided tour from the start any
                    // time (D-012) — an app-local command, not a workbench one.
                    if line == "tutorial" {
                        self.show_tutorial = true;
                        self.tutorial_step = 0;
                        return Action::Render;
                    }
                    match cmd {
                        // `:theme <name>` / `:theme` / `:themes` (P1 / D-002) —
                        // the reducer flips the active palette + re-renders in
                        // place; the run loop's view-state save persists the
                        // selection, and on success the workbench task syncs
                        // the zellij chrome (P2 / D-003). An unknown/absent
                        // name lists the registry (active marked) instead of
                        // erroring silently.
                        Some(PaletteCommand::Theme { name: Some(name) }) => {
                            if crate::theme::Theme::set_active(&name) {
                                self.push_notif(crate::models::Notif {
                                    level: "info".to_string(),
                                    message: format!("theme: {name}"),
                                    harness: None,
                                    ts: None,
                                });
                                Action::Workbench(PaletteCommand::Theme { name: Some(name) })
                            } else {
                                self.push_notif(crate::models::Notif {
                                    level: "error".to_string(),
                                    message: format!(
                                        "theme: unknown `{name}` — available: {}",
                                        Self::theme_listing()
                                    ),
                                    harness: None,
                                    ts: None,
                                });
                                Action::Render
                            }
                        }
                        Some(PaletteCommand::Theme { name: None })
                        | Some(PaletteCommand::Themes) => {
                            self.push_notif(crate::models::Notif {
                                level: "info".to_string(),
                                message: format!("themes: {}", Self::theme_listing()),
                                harness: None,
                                ts: None,
                            });
                            Action::Render
                        }
                        // `:pickup` resolves its plan/harness from the SELECTED
                        // plan when not given explicitly (the parser is pure and
                        // can't see app state). No plan in scope → an error
                        // notif, not a half-scoped dispatch.
                        Some(PaletteCommand::PickupPlanItem {
                            harness,
                            plan,
                            item,
                        }) => {
                            let plan =
                                plan.or_else(|| self.selected_plan().map(|p| p.slug.clone()));
                            match plan {
                                Some(plan) => {
                                    let harness = harness
                                        .or_else(|| {
                                            self.selected_plan()
                                                .filter(|p| p.slug == plan)
                                                .and_then(|p| p.harness.clone())
                                        })
                                        .unwrap_or_else(|| "all".to_string());
                                    Action::Workbench(PaletteCommand::PickupPlanItem {
                                        harness: Some(harness),
                                        plan: Some(plan),
                                        item,
                                    })
                                }
                                None => {
                                    self.push_notif(crate::models::Notif {
                                        level: "error".to_string(),
                                        message:
                                            "pickup: no plan selected — use :pickup <plan> <item>"
                                                .to_string(),
                                        harness: None,
                                        ts: None,
                                    });
                                    Action::Render
                                }
                            }
                        }
                        // `:release` resolves its plan/harness from the SELECTED
                        // plan exactly like `:pickup` (same scoping rules).
                        Some(PaletteCommand::ReleasePlanItem {
                            harness,
                            plan,
                            item,
                        }) => {
                            let plan =
                                plan.or_else(|| self.selected_plan().map(|p| p.slug.clone()));
                            match plan {
                                Some(plan) => {
                                    let harness = harness
                                        .or_else(|| {
                                            self.selected_plan()
                                                .filter(|p| p.slug == plan)
                                                .and_then(|p| p.harness.clone())
                                        })
                                        .unwrap_or_else(|| "all".to_string());
                                    Action::Workbench(PaletteCommand::ReleasePlanItem {
                                        harness: Some(harness),
                                        plan: Some(plan),
                                        item,
                                    })
                                }
                                None => {
                                    self.push_notif(crate::models::Notif {
                                        level: "error".to_string(),
                                        message:
                                            "release: no plan selected — use :release <plan> <item>"
                                                .to_string(),
                                        harness: None,
                                        ts: None,
                                    });
                                    Action::Render
                                }
                            }
                        }
                        // Config-tab edits (D-013) go to the read→edit→PUT task,
                        // not the workbench command executor.
                        Some(PaletteCommand::ConfigSet { key, value }) => Action::ConfigEdit {
                            harness: self.harness.clone(),
                            key,
                            value: Some(value),
                        },
                        Some(PaletteCommand::ConfigUnset { key }) => Action::ConfigEdit {
                            harness: self.harness.clone(),
                            key,
                            value: None,
                        },
                        // Plugin-settings edits (D-014) resolve the plugin from
                        // the selected row; no plugin selected → an error notif.
                        Some(PaletteCommand::PluginSet { key, value }) => {
                            match self.selected_plugin().map(|p| p.name.clone()) {
                                Some(plugin) => Action::PluginConfigEdit {
                                    harness: self.harness.clone(),
                                    plugin,
                                    key,
                                    value: Some(value),
                                },
                                None => {
                                    self.push_notif(crate::models::Notif {
                                        level: "error".to_string(),
                                        message: "pset: no plugin selected (Plugins tab)"
                                            .to_string(),
                                        harness: None,
                                        ts: None,
                                    });
                                    Action::Render
                                }
                            }
                        }
                        Some(PaletteCommand::PluginUnset { key }) => {
                            match self.selected_plugin().map(|p| p.name.clone()) {
                                Some(plugin) => Action::PluginConfigEdit {
                                    harness: self.harness.clone(),
                                    plugin,
                                    key,
                                    value: None,
                                },
                                None => {
                                    self.push_notif(crate::models::Notif {
                                        level: "error".to_string(),
                                        message: "punset: no plugin selected (Plugins tab)"
                                            .to_string(),
                                        harness: None,
                                        ts: None,
                                    });
                                    Action::Render
                                }
                            }
                        }
                        // `:message <text>` (D-004) — resolve the owning agent +
                        // work-item scope from the SELECTED inbox item; no item
                        // selected → an error notif, not a half-scoped dispatch.
                        Some(PaletteCommand::MessageOwner { body, .. }) => {
                            match self.selected_inbox() {
                                Some(it) => Action::Workbench(PaletteCommand::MessageOwner {
                                    to: it.owner_agent_id.clone(),
                                    harness: it.harness_slug.clone(),
                                    plan_slug: it.plan_slug.clone(),
                                    item_ref: it.item_ref.clone(),
                                    title: it.title.clone(),
                                    body,
                                }),
                                None => {
                                    self.push_notif(crate::models::Notif {
                                        level: "error".to_string(),
                                        message: "message: no inbox item selected (Inbox tab)"
                                            .to_string(),
                                        harness: None,
                                        ts: None,
                                    });
                                    Action::Render
                                }
                            }
                        }
                        // ── dockview dock-verbs (Brief 50 / D-008): resolved
                        // against the live topology here, then driven by the run
                        // loop (companion or CLI fallback). ──
                        // `:stack` — gather the work area; needs the companion
                        // (no topology → no ids → a helpful error, not a no-op).
                        Some(PaletteCommand::Stack) => {
                            let ids = self.work_pane_ids();
                            if ids.len() >= 2 {
                                Action::Dock(DockCmd::Stack { pane_ids: ids })
                            } else {
                                self.push_notif(crate::models::Notif {
                                    level: "error".to_string(),
                                    message: if self.topology.is_none() {
                                        "stack: needs the companion plugin (run inside the workbench)"
                                            .to_string()
                                    } else {
                                        "stack: fewer than 2 work panes to stack".to_string()
                                    },
                                    harness: None,
                                    ts: None,
                                });
                                Action::Render
                            }
                        }
                        // `:float [target]` — bare floats the HUD (run loop uses
                        // hud_pane_id / the focused-pane CLI fallback); an arg
                        // targets a work pane resolved from topology.
                        Some(PaletteCommand::Float { target }) => match target {
                            None => Action::Dock(DockCmd::Float { pane_id: None }),
                            Some(t) => match self.resolve_pane_target(&t) {
                                Some(id) => Action::Dock(DockCmd::Float { pane_id: Some(id) }),
                                None => {
                                    self.push_notif(crate::models::Notif {
                                        level: "error".to_string(),
                                        message: format!("float: no pane matching '{t}'"),
                                        harness: None,
                                        ts: None,
                                    });
                                    Action::Render
                                }
                            },
                        },
                        // `:dock <left|right>` — mirrored swap preset.
                        Some(PaletteCommand::Dock { side }) => {
                            let name = match side.to_lowercase().as_str() {
                                "right" | "r" => Some("stacked"),
                                "left" | "l" => Some("stacked-left"),
                                _ => None,
                            };
                            match name {
                                Some(n) => Action::Dock(DockCmd::SelectLayout {
                                    name: n.to_string(),
                                }),
                                None => {
                                    self.push_notif(crate::models::Notif {
                                        level: "error".to_string(),
                                        message: "dock: use :dock left | :dock right".to_string(),
                                        harness: None,
                                        ts: None,
                                    });
                                    Action::Render
                                }
                            }
                        }
                        // `:layout <next|prev|name>` — cycle or select a preset.
                        Some(PaletteCommand::Layout { which }) => {
                            match which.to_lowercase().as_str() {
                                "next" | "n" => Action::Dock(DockCmd::CycleLayout { next: true }),
                                "prev" | "previous" | "p" => {
                                    Action::Dock(DockCmd::CycleLayout { next: false })
                                }
                                _ => Action::Dock(DockCmd::SelectLayout { name: which }),
                            }
                        }
                        Some(c) => Action::Workbench(c),
                        None => Action::Render,
                    }
                }
                KeyCode::Backspace => {
                    self.palette_input.pop();
                    Action::Render
                }
                KeyCode::Char(c) => {
                    self.palette_input.push(c);
                    Action::Render
                }
                _ => Action::None,
            };
        }
        // Operator chat composer captures all input while focused (like the
        // palette) so digits/letters type into the message instead of switching
        // tabs. Ctrl-C still quits (the universal escape hatch); Esc leaves
        // compose mode; Enter sends (unless a turn is already streaming).
        if self.operator_input_active() && self.chat_composing {
            let ctrl_c = code == KeyCode::Char('c') && mods.contains(KeyModifiers::CONTROL);
            if ctrl_c {
                self.should_quit = true;
                return Action::Quit;
            }
            return match code {
                KeyCode::Esc => {
                    self.chat_composing = false;
                    Action::Render
                }
                KeyCode::Enter => {
                    if self.chat_streaming {
                        return Action::Render; // a turn is in flight — wait for it
                    }
                    let text = self.chat_input.trim().to_string();
                    if text.is_empty() {
                        return Action::Render;
                    }
                    self.chat_input.clear();
                    self.begin_user_send(&text);
                    Action::SendChat(text)
                }
                KeyCode::Backspace => {
                    self.chat_input.pop();
                    Action::Render
                }
                KeyCode::Char(c) => {
                    self.chat_input.push(c);
                    Action::Render
                }
                _ => Action::None,
            };
        }
        // Help overlay: any key dismisses it.
        if self.show_help {
            self.show_help = false;
            return Action::Render;
        }

        let ctrl_c = code == KeyCode::Char('c') && mods.contains(KeyModifiers::CONTROL);
        if code == KeyCode::Char('q') || ctrl_c {
            self.should_quit = true;
            return Action::Quit;
        }
        // P-008 (hive-agent-tabs): flag-on, 'w' on the Fleet tab toggles the SELECTED
        // agent's wake mode (auto↔manual) via coord:wake-mode — the owner-driven
        // pause/edit gate, controlled from the roster. Guarded so flag-off + other
        // tabs are unchanged; skipped while the operator dock holds focus.
        if self.hive_agent_tabs
            && self.tab == Tab::Fleet
            && !self.operator_dock_focused
            && code == KeyCode::Char('w')
        {
            let sel = self.fleet.agent_sel;
            let roster = self.visible_roster();
            if let Some(entry) = roster.get(sel) {
                let mode = next_wake_mode(entry.wake_mode.as_deref());
                return Action::SetWakeMode {
                    agent: entry.owner_id.clone(),
                    mode: mode.to_string(),
                };
            }
            return Action::None;
        }
        // P-009 (hive-agent-tabs): flag-on, 'W' on the Fleet tab opens the SELECTED
        // agent's staged-wake review overlay (release / edit & release / skip).
        if self.hive_agent_tabs
            && self.tab == Tab::Fleet
            && !self.operator_dock_focused
            && code == KeyCode::Char('W')
        {
            let sel = self.fleet.agent_sel;
            let roster = self.visible_roster();
            if let Some(entry) = roster.get(sel) {
                let agent = entry.owner_id.clone();
                self.wake_review = Some(WakeReview::loading(agent.clone(), entry.label.clone()));
                return Action::FetchWakeQueue { agent };
            }
            return Action::None;
        }
        // Operator dock focus (operator-always-visible-2026-06-05, Brief 24): when
        // the docked operator pane holds focus on a non-Operator tab, route the
        // chat keys to it BEFORE the active tab's own list-nav sees them — so the
        // dock is exactly as usable as the full Operator tab. Esc blurs focus back
        // to the tab. Everything not matched here falls through, so tab-switch
        // digits/letters, `p`/`v`, and `o` (toggles focus off, below) still work
        // and navigation is never trapped. Compose-mode typing was already handled
        // above via `operator_input_active()`.
        if self.operator_dock_focused && self.tab != Tab::Operator {
            match code {
                KeyCode::Esc => {
                    self.operator_dock_focused = false;
                    return Action::Render;
                }
                KeyCode::Char('i') | KeyCode::Enter => {
                    self.chat_composing = true;
                    return Action::Render;
                }
                // PageUp doubles as the deliberate "page back into history" gesture
                // (mirrors the Operator-tab arm): scroll up + kick a load-earlier.
                KeyCode::PageUp => {
                    self.chat_scroll = self.chat_scroll.saturating_add(10);
                    if self.chat_has_more_earlier
                        && !self.chat_loading_earlier
                        && self.conversation_id.is_some()
                    {
                        self.chat_loading_earlier = true;
                        return Action::LoadEarlierChat;
                    }
                    return Action::Render;
                }
                KeyCode::PageDown => {
                    self.chat_scroll = self.chat_scroll.saturating_sub(10);
                    return Action::Render;
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    self.chat_scroll = self.chat_scroll.saturating_add(1); // into history
                    return Action::Render;
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    self.chat_scroll = self.chat_scroll.saturating_sub(1); // toward latest
                    return Action::Render;
                }
                _ => {}
            }
        }
        // Plans-filter rail capture (D-009): while the rail is open on a tab it
        // narrows, the list keys drive the rail (j/k move, Space/Enter toggle a
        // plan in/out of the filter, c clears, F/Esc closes). Everything else
        // falls through — digits still switch tabs, q still quits.
        if self.plan_filter_open && matches!(self.tab, Tab::Inbox | Tab::Fleet) {
            match code {
                KeyCode::Char('j') | KeyCode::Down => {
                    let len = self.visible_plans().len();
                    if len > 0 {
                        self.plan_filter_sel = (self.plan_filter_sel + 1).min(len - 1);
                    }
                    return Action::Render;
                }
                KeyCode::Char('k') | KeyCode::Up => {
                    self.plan_filter_sel = self.plan_filter_sel.saturating_sub(1);
                    return Action::Render;
                }
                KeyCode::Char(' ') | KeyCode::Enter => {
                    let slug = self
                        .visible_plans()
                        .get(self.plan_filter_sel)
                        .map(|p| p.slug.clone());
                    if let Some(slug) = slug {
                        if !self.plan_filter.remove(&slug) {
                            self.plan_filter.insert(slug);
                        }
                        self.clamp_filtered_cursors();
                    }
                    return Action::Render;
                }
                KeyCode::Char('c') => {
                    self.plan_filter.clear();
                    return Action::Render;
                }
                KeyCode::Char('F') | KeyCode::Esc => {
                    self.plan_filter_open = false;
                    return Action::Render;
                }
                _ => {}
            }
        }
        // Voice tab (holepunch-voice-channels P-008): delegate to voice_ui for the
        // keys it owns (and everything while its composer/settings overlay is open).
        // Keys it doesn't own fall through to the global dispatch below, so tab
        // switching (digits / 'a' / '<' '>') still works from the Voice tab.
        if self.tab == Tab::Voice && crate::voice_ui::owns_key(&self.voice_ui, code) {
            return match crate::voice_ui::handle_key(&mut self.voice_ui, code, mods) {
                Some(cmd) => Action::VoiceChan(cmd),
                None => Action::Render,
            };
        }
        match code {
            KeyCode::Char('?') => {
                self.show_help = true;
                Action::Render
            }
            KeyCode::F(1) => {
                // Re-open the guided tutorial from the start (P9).
                self.show_tutorial = true;
                self.tutorial_step = 0;
                Action::Render
            }
            KeyCode::Char(':') => {
                self.palette_open = true;
                self.palette_input.clear();
                Action::Render
            }
            // Focus the operator composer (tui-operator-surface). `i` mirrors the
            // vim insert idiom; while composing, all keys go to the message.
            KeyCode::Char('i') if self.tab == Tab::Operator => {
                self.chat_composing = true;
                Action::Render
            }
            // Push-to-talk (voice-mode-tui-port-2026-06-05 P2). `v` on the
            // Operator tab (outside compose): Idle → start recording; Recording
            // → stop + run the turn (the press-to-toggle path; the kitty
            // key-release path also stops, via Event::KeyRelease). While the
            // pipeline is transcribing/thinking/speaking `v` is ignored so a new
            // capture can't stomp an in-flight turn.
            KeyCode::Char('v') if self.voice_key_active() => match self.voice_phase {
                _ if self.convai_phase != ConvAiPhase::Off
                    && self.convai_mode == "push-to-talk" =>
                {
                    if self.convai_ptt_active {
                        Action::None
                    } else {
                        self.convai_ptt_active = true;
                        Action::VoiceSessionControl(crate::voice_convai::ConvAiControl::Ptt(true))
                    }
                }
                VoicePhase::Idle => {
                    // Optimistic — the run loop confirms via Event::Voice(Started).
                    self.voice_phase = VoicePhase::Recording;
                    self.voice_error = None;
                    Action::Voice(VoiceCmd::Start)
                }
                VoicePhase::Recording => Action::Voice(VoiceCmd::Stop),
                _ => Action::None,
            },
            KeyCode::Char('p') => {
                self.show_presence = !self.show_presence;
                Action::Render
            }
            // Operator dock (operator-always-visible-2026-06-05, Brief 24): `o`
            // focuses the docked operator pane from any non-Operator tab — opening
            // it if hidden — so you can talk to the operator without leaving the
            // tab; `o` again (or Esc) returns focus to the tab. `O` toggles the
            // dock's visibility (hide to reclaim width). On the Operator tab the
            // whole tab is already the chat, so both are no-ops there.
            KeyCode::Char('o') if self.tab != Tab::Operator => {
                self.operator_dock_open = true;
                self.operator_dock_focused = !self.operator_dock_focused;
                Action::Render
            }
            KeyCode::Char('O') if self.tab != Tab::Operator => {
                self.operator_dock_open = !self.operator_dock_open;
                if !self.operator_dock_open {
                    self.operator_dock_focused = false;
                }
                Action::Render
            }
            // Plans-filter rail (D-009): `F` opens it on the tabs it narrows
            // (the rail's own capture above handles `F`-to-close while open).
            KeyCode::Char('F') if matches!(self.tab, Tab::Inbox | Tab::Fleet) => {
                self.plan_filter_open = true;
                self.plan_filter_sel = 0;
                Action::Render
            }
            KeyCode::Char('N') => {
                // Open the notifications history; acknowledge pending ones.
                self.show_notifs = true;
                self.toast = None;
                self.unseen_notifs = 0;
                Action::Render
            }
            KeyCode::Char('P') => {
                // Open the pot selector (D-003): "All Pots" + each pot, with the
                // cursor on the current choice.
                self.pot_picker_open = true;
                self.pot_picker_sel = if self.all_pots {
                    0
                } else {
                    self.harness_sel + 1
                };
                Action::Render
            }
            KeyCode::Esc => {
                // Esc while recording aborts the capture, discarding audio (PTT
                // cancel — voice-mode-tui-port D-007).
                if self.voice_phase == VoicePhase::Recording {
                    self.voice_phase = VoicePhase::Idle;
                    self.voice_level = 0.0;
                    return Action::Voice(VoiceCmd::Cancel);
                }
                // On a side-by-side 2-pane tab (Pots/Testing), Esc first steps OUT
                // of an entered pane back to browsing (two-level nav, owner ask
                // 2026-06-15 #2).
                if matches!(self.tab, Tab::Harnesses | Tab::Testing) && self.pane_entered {
                    self.pane_entered = false;
                    return Action::Render;
                }
                // On the in-app Plans tab, Esc first steps OUT of an entered pane
                // back to pane-browsing (two-level nav, owner ask 2026-06-16).
                if self.tab == Tab::Plans && self.plans_entered {
                    self.plans_entered = false;
                    return Action::Render;
                }
                // On the Memory tab, Esc first clears an active search back to
                // the full list (D-006); else dismiss the transient toast.
                if self.tab == Tab::Memory && self.memory_hits.is_some() {
                    self.memory_hits = None;
                    self.memory_sel = 0;
                    return Action::Render;
                }
                // On the Fleet tab, Esc first steps OUT of an entered pane back to
                // pane-browsing (two-level nav, owner ask 2026-06-15 #2); only
                // then (a second Esc) does it clear an active agent filter.
                if self.tab == Tab::Fleet
                    && self.fleet.mode == crate::fleet::FleetMode::Curated
                    && self.fleet.entered
                {
                    self.fleet.entered = false;
                    return Action::Render;
                }
                // On the Fleet tab, Esc clears an active agent filter back to
                // the whole-fleet dossier/plan view (#2). The run loop applies
                // the cleared selection in-process + republishes the relay.
                if self.tab == Tab::Fleet && self.bee.owner_id.is_some() {
                    return Action::PublishBeeSelection {
                        owner_id: None,
                        name: None,
                    };
                }
                self.toast = None;
                Action::Render
            }
            // Memory semantic search (D-006): `/` opens the query composer.
            KeyCode::Char('/') if self.tab == Tab::Memory => {
                self.memory_search_open = true;
                self.memory_search_input.clear();
                Action::Render
            }
            // ─── Cupboard tab (D-011) ───
            // `f` cycles the kind filter (all/harness/blueprint/snapshot/plugin)
            // and refetches; `/` opens the search composer (seeded with the
            // active query); `r` refetches the current filter; Enter arms the
            // selected listing's action then confirms it; `y` fires the armed one.
            // ── Conversations tab (Brief 25) ─────────────────────────────────
            KeyCode::Char('s') if self.tab == Tab::Conversations => {
                self.conv_state_idx = (self.conv_state_idx + 1) % CONV_STATES.len();
                self.conversation_sel = 0;
                self.refetch_conversations()
            }
            KeyCode::Char('t') if self.tab == Tab::Conversations => {
                self.conv_kind_idx = (self.conv_kind_idx + 1) % CONV_KINDS.len();
                self.conversation_sel = 0;
                self.refetch_conversations()
            }
            KeyCode::Char('T') if self.tab == Tab::Conversations => {
                self.cycle_conv_topic();
                Action::Render
            }
            KeyCode::Char('r') if self.tab == Tab::Conversations => self.refetch_conversations(),
            // Realtime operator voice toggle (voice-realtime-tui-2026-06-05
            // P-007): `V` (shift) starts/stops the continuous Conv-AI session
            // on ANY tab; lowercase `v` stays the PTT turn. Refused mid-PTT so
            // the two pipelines never fight over the mic.
            KeyCode::Char('V') => {
                if self.convai_phase == ConvAiPhase::Off {
                    if self.voice_phase.is_active() {
                        self.voice_error = Some("finish the PTT turn first (v)".into());
                        Action::Render
                    } else {
                        self.convai_phase = ConvAiPhase::Connecting;
                        Action::VoiceSessionStart
                    }
                } else {
                    self.convai_phase = ConvAiPhase::Off;
                    self.convai_is_player = false;
                    self.convai_ptt_active = false;
                    Action::VoiceSessionStop
                }
            }
            KeyCode::Char('M') if self.convai_phase != ConvAiPhase::Off => {
                self.convai_muted = !self.convai_muted;
                Action::VoiceSessionControl(crate::voice_convai::ConvAiControl::Mute(
                    self.convai_muted,
                ))
            }
            KeyCode::Char('A') if self.convai_phase != ConvAiPhase::Off => {
                self.convai_mode = if self.convai_mode == "push-to-talk" {
                    "always-on".into()
                } else {
                    "push-to-talk".into()
                };
                self.convai_ptt_active = false;
                Action::VoiceSessionControl(crate::voice_convai::ConvAiControl::SetMode(
                    if self.convai_mode == "push-to-talk" {
                        "push-to-talk"
                    } else {
                        "always-on"
                    },
                ))
            }
            KeyCode::Char('H') if self.convai_phase != ConvAiPhase::Off => {
                Action::VoiceSessionControl(crate::voice_convai::ConvAiControl::ForceHost)
            }
            // Overview top-bar max-agents editor (P-005): `+` (or unshifted
            // `=`) raises and `-` lowers the hard cap, clamped 1..=64.
            KeyCode::Char('+') | KeyCode::Char('=') if self.tab == Tab::Overview => {
                self.nudge_max_agents(1)
            }
            KeyCode::Char('-') if self.tab == Tab::Overview => self.nudge_max_agents(-1),
            KeyCode::Enter if self.tab == Tab::Overview => self.overview_activate(),
            KeyCode::Enter if self.tab == Tab::Conversations => self.conv_open_detail(),
            KeyCode::Char('i') if self.tab == Tab::Conversations => self.conv_promote(),
            KeyCode::Char('f') if self.tab == Tab::Cupboard => {
                self.cupboard_kind = (self.cupboard_kind + 1) % CUPBOARD_KINDS.len();
                self.cupboard_sel = 0;
                self.cupboard_confirm = None;
                self.refetch_cupboard()
            }
            KeyCode::Char('/') if self.tab == Tab::Cupboard => {
                self.cupboard_search_open = true;
                self.cupboard_search_input = self.cupboard_query.clone();
                Action::Render
            }
            KeyCode::Char('r') if self.tab == Tab::Cupboard => self.refetch_cupboard(),
            KeyCode::Enter if self.tab == Tab::Cupboard => self.cupboard_activate(),
            KeyCode::Char('y') if self.tab == Tab::Cupboard => {
                // Confirm the armed listing by id (independent of the cursor,
                // which may have moved since arming).
                if let Some(id) = self.cupboard_confirm.take() {
                    if let Some(l) = self.cupboard.iter().find(|l| l.id == id) {
                        return Action::CupboardAct { listing: l.clone() };
                    }
                }
                Action::Render
            }
            // Enter on a Fleet-roster agent routes by WHERE the agent lives
            // (pui-workbench-usability D-001): local pane focus / external-window
            // focus / resume an ended session / the [r]/[n]/[f] menu — never the
            // old silent focus-empty-pane no-op.
            // Plans tab two-level pane nav (owner ask 2026-06-16, the Colony
            // idiom): Enter DRILLS into the focused pane (plans list ↔ work
            // items); once inside, Enter opens that row's detail popup. ←/→ (and
            // ↑/↓ while browsing) switch the focused pane; ↑/↓ inside move within;
            // Esc steps back out (handled in the Esc block).
            KeyCode::Enter if self.tab == Tab::Plans => {
                if !self.plans_entered {
                    self.plans_entered = true;
                    Action::Render
                } else {
                    self.plans_open_focused_detail()
                }
            }
            // ←/→ switch the focused pane (list ↔ items). Arrow-only here — `h`
            // stays the global "return to Overview" key on the in-app tab strip
            // (unlike the pinned plans-pane, which has no tab strip so binds h/l).
            KeyCode::Left | KeyCode::Right if self.tab == Tab::Plans => {
                self.plans_focus = self.plans_focus.toggle();
                Action::Render
            }
            KeyCode::Char('j') | KeyCode::Down if self.tab == Tab::Plans => self.plans_tab_arrow(1),
            KeyCode::Char('k') | KeyCode::Up if self.tab == Tab::Plans => self.plans_tab_arrow(-1),
            // Enter on the Fleet tab (two-level nav, owner ask 2026-06-15 #2): at
            // the pane-browsing level it DRILLS INTO the focused pane; once
            // inside, it acts on the selection — roster → reach the agent;
            // inbox/outbox/conversations → open the detail popup; plan-progress →
            // open the selected plan's detail popup; dossier → no per-row detail.
            // Mirror has no panes, so Enter acts directly.
            KeyCode::Enter if self.tab == Tab::Fleet => {
                if self.fleet.mode == crate::fleet::FleetMode::Curated && !self.fleet.entered {
                    self.fleet.entered = true;
                    Action::Render
                } else {
                    self.fleet_enter_focused()
                }
            }
            // Launch a native agent pane from the Fleet tab (the old Sessions
            // launcher, folded in — D-002b).
            KeyCode::Char('n') if self.tab == Tab::Fleet => Action::Launch(self.launch_spec()),
            // Comms sub-view toggle (pui-dock-consolidation-2026-06-07 #3/#4):
            // 'c' on the Fleet tab swaps the dossier + plan-progress view for the
            // comms view (selected agent's inbox/outbox over the whole-fleet
            // conversations). Shadows the Cupboard switch key while on Fleet —
            // the contextual-handlers-win-first rule of the keymap arm below.
            KeyCode::Char('c') if self.tab == Tab::Fleet => {
                self.fleet.show_comms = !self.fleet.show_comms;
                // Reset to the roster on every toggle so the view opens in a
                // known place, and drop any stale detail popup (owner ask 2026-06-14).
                self.fleet.fleet_focus = crate::fleet::FleetPanel::Roster;
                self.fleet.entered = false;
                self.fleet_detail_open = false;
                // The conversations half reuses the Conversations-tab data —
                // lazy-load it the first time the comms view opens.
                if self.fleet.show_comms
                    && self.conversations.is_empty()
                    && !self.conversations_loading
                {
                    return self.refetch_conversations();
                }
                Action::Render
            }
            // Fleet two-level nav (owner ask 2026-06-15 #2): BROWSE panes vs work
            // INSIDE one. Only Enter (drill in) / Esc (step out) / `c` change the
            // level. ←/→ (h/l) switch the focused pane at WHATEVER level you're on
            // (so once inside, ←/→ moves between panes, ↑/↓ within — a clean 2-D
            // nav); ↑/↓ (j/k) switch panes while browsing, else move within the
            // entered pane. Works in BOTH the default (roster · task-list ·
            // plan-progress) and comms (roster · inbox · outbox · conversations)
            // layouts. Active only in Curated mode; in Mirror these fall through
            // to the global handlers below.
            KeyCode::Char('h') | KeyCode::Left
                if self.tab == Tab::Fleet
                    && self.fleet.mode == crate::fleet::FleetMode::Curated =>
            {
                self.fleet.fleet_focus = self.fleet.fleet_focus.cycle(self.fleet.show_comms, -1);
                Action::Render
            }
            KeyCode::Char('l') | KeyCode::Right
                if self.tab == Tab::Fleet
                    && self.fleet.mode == crate::fleet::FleetMode::Curated =>
            {
                self.fleet.fleet_focus = self.fleet.fleet_focus.cycle(self.fleet.show_comms, 1);
                Action::Render
            }
            KeyCode::Char('j') | KeyCode::Down
                if self.tab == Tab::Fleet
                    && self.fleet.mode == crate::fleet::FleetMode::Curated =>
            {
                self.fleet_arrow(1)
            }
            KeyCode::Char('k') | KeyCode::Up
                if self.tab == Tab::Fleet
                    && self.fleet.mode == crate::fleet::FleetMode::Curated =>
            {
                self.fleet_arrow(-1)
            }
            // Two-level nav for the side-by-side 2-pane tabs — Pots
            // (features|issues) and Testing (domains|files) (owner ask 2026-06-15
            // #2): ↑/↓ switch the focused pane while BROWSING, else move within
            // the entered pane; ←/→ switch panes at any level (so once inside, ←/→
            // move between panes, ↑/↓ within); Enter drills in then acts; Esc
            // steps back out. `Tab` stays a switch alias. (Plugins is excluded —
            // its `Tab` swaps two FULL-SCREEN sub-views, not side-by-side panes.)
            KeyCode::Char('j') | KeyCode::Down
                if matches!(self.tab, Tab::Harnesses | Tab::Testing) =>
            {
                self.pane_arrow(1)
            }
            KeyCode::Char('k') | KeyCode::Up
                if matches!(self.tab, Tab::Harnesses | Tab::Testing) =>
            {
                self.pane_arrow(-1)
            }
            KeyCode::Left | KeyCode::Right if matches!(self.tab, Tab::Harnesses | Tab::Testing) => {
                self.pane_toggle_focus();
                Action::Render
            }
            // Hives tab (p2p-hive-directory P-006): 'J' JOINS a discovered hive —
            // POST each of its member links to /api/harness/join-link. Picks the
            // first JOINABLE directory hive (one carrying full member links); a
            // topic-only hive lists fine but can't be one-click-joined.
            KeyCode::Char('J') if self.tab == Tab::Hives => {
                if let Some(h) = self
                    .hive_directory
                    .iter()
                    .find(|h| !h.member_links.is_empty())
                {
                    self.status = format!("joining hive {}…", h.title);
                    return Action::JoinHive {
                        slug: h.hive_id.clone(),
                        links: h.member_links.clone(),
                    };
                }
                self.status = if self.hive_directory.is_empty() {
                    "no hives in the directory yet".to_string()
                } else {
                    "discovered hives published topics only — a full join link is required"
                        .to_string()
                };
                Action::Render
            }
            // Plugins tab (D-007/D-014): in Panes focus, Enter launches the
            // selected pane (original D-002 behavior); in List focus, Enter
            // loads the selected plugin's per-harness config for the settings
            // view (no-op when the plugin has no configSchema).
            // Pots: no per-item action — Enter just DRILLS IN (so ↑/↓ scroll the
            // focused list); Esc steps back out (two-level nav, owner ask
            // 2026-06-15 #2).
            KeyCode::Enter if self.tab == Tab::Harnesses => {
                self.pane_entered = true;
                Action::Render
            }
            KeyCode::Enter if self.tab == Tab::Plugins => match self.plugins_focus {
                PluginsFocus::Panes => match self.plugin_launch_spec() {
                    Some(spec) => Action::Launch(spec),
                    None => Action::None,
                },
                PluginsFocus::List => match self.selected_plugin() {
                    Some(p) if p.config_schema.is_some() => Action::LoadPluginConfig {
                        harness: self.harness.clone(),
                        plugin: p.name.clone(),
                    },
                    _ => Action::None,
                },
            },
            // Enter on the operator pane (outside compose) focuses the composer.
            KeyCode::Enter if self.tab == Tab::Operator => {
                self.chat_composing = true;
                Action::Render
            }
            // Testing run-on-click (D-004a): at the browsing level Enter DRILLS
            // INTO the focused pane; once inside it activates — loads a domain's
            // files / runs the selected file (two-level nav, owner ask 2026-06-15
            // #2). `r` is the run alias on the file column (placed BEFORE the
            // global relaunch `r` so it wins on this tab).
            KeyCode::Enter if self.tab == Tab::Testing => {
                if !self.pane_entered {
                    self.pane_entered = true;
                    Action::Render
                } else {
                    self.testing_activate()
                }
            }
            KeyCode::Char('r')
                if self.tab == Tab::Testing && self.testing_focus == TestingFocus::Files =>
            {
                self.testing_activate()
            }
            KeyCode::Char('g') => Action::Launch(self.git_spec()),
            // Relaunch the last-exited agent/command pane (P-004), when armed.
            KeyCode::Char('r') if self.relaunch_command.is_some() => match self.relaunch_spec() {
                Some(spec) => {
                    self.relaunch_command = None;
                    self.toast = None;
                    Action::Launch(spec)
                }
                None => Action::None,
            },
            KeyCode::Char(']') => {
                self.cycle_harness(1);
                Action::Render
            }
            KeyCode::Char('[') => {
                self.cycle_harness(-1);
                Action::Render
            }
            // Global tab cycle — scalable past the 1-9/0 digit shortcuts as more
            // tabs are appended (pui-fleet-status-view-2026-06-04).
            KeyCode::Char('>') => {
                self.cycle_tab(1);
                Action::Render
            }
            KeyCode::Char('<') => {
                self.cycle_tab(-1);
                Action::Render
            }
            KeyCode::Tab if self.tab == Tab::Harnesses => {
                self.harness_focus = match self.harness_focus {
                    HarnessFocus::Features => HarnessFocus::Issues,
                    HarnessFocus::Issues => HarnessFocus::Features,
                };
                Action::Render
            }
            // Fleet curated ↔ mirror toggle (D-006). On `Tab`, mirroring
            // the Pots column-switch idiom — frees `m` for the Memory tab.
            KeyCode::Tab if self.tab == Tab::Fleet => {
                self.fleet.toggle_mode();
                Action::Render
            }
            // Testing column focus (D-004a): Tab hops domains ↔ files.
            KeyCode::Tab if self.tab == Tab::Testing => {
                self.testing_focus = match self.testing_focus {
                    TestingFocus::Domains => TestingFocus::Files,
                    TestingFocus::Files => TestingFocus::Domains,
                };
                Action::Render
            }
            // Plugins sub-view focus (D-007/D-014): Tab hops the installed-plugin
            // list (contributions + settings) ↔ the launchable tui-panes.
            KeyCode::Tab if self.tab == Tab::Plugins => {
                self.plugins_focus = match self.plugins_focus {
                    PluginsFocus::List => PluginsFocus::Panes,
                    PluginsFocus::Panes => PluginsFocus::List,
                };
                Action::Render
            }
            KeyCode::PageDown if self.tab == Tab::Docs => {
                self.doc_scroll = self.doc_scroll.saturating_add(10);
                Action::Render
            }
            KeyCode::PageUp if self.tab == Tab::Docs => {
                self.doc_scroll = self.doc_scroll.saturating_sub(10);
                Action::Render
            }
            // Refresh the selected doc's freshness (harness-docs-integration P-009):
            // regenerate a stale generated/augmented doc, or re-verify a manual one.
            // (Capital R — lowercase r/g are taken globally.)
            KeyCode::Char('R') if self.tab == Tab::Docs => {
                if let Some(doc) = self.docs_files.get(self.doc_sel).cloned() {
                    let source = self
                        .doc_entries
                        .iter()
                        .find(|e| e.doc_id == doc)
                        .map(|e| e.source.as_str())
                        .unwrap_or("manual");
                    let action = if source == "manual" {
                        "verify"
                    } else {
                        "regenerate"
                    };
                    Action::DocsAction {
                        action: action.to_string(),
                        doc_id: doc,
                    }
                } else {
                    Action::None
                }
            }
            // Operator transcript scroll (chat_scroll = lines UP from the bottom).
            // PageUp is also the deliberate "page back into history" gesture, so it
            // kicks off a load-earlier fetch when more turns exist (deduped by the
            // in-flight flag). The fetch prepends without moving the user's view.
            KeyCode::PageUp if self.tab == Tab::Operator => {
                self.chat_scroll = self.chat_scroll.saturating_add(10);
                if self.chat_has_more_earlier
                    && !self.chat_loading_earlier
                    && self.conversation_id.is_some()
                {
                    self.chat_loading_earlier = true;
                    return Action::LoadEarlierChat;
                }
                Action::Render
            }
            KeyCode::PageDown if self.tab == Tab::Operator => {
                self.chat_scroll = self.chat_scroll.saturating_sub(10);
                Action::Render
            }
            KeyCode::Char('j') | KeyCode::Down => {
                if self.tab == Tab::Operator {
                    self.chat_scroll = self.chat_scroll.saturating_sub(1); // toward latest
                    return Action::Render;
                }
                let prev_domain = self.testing_sel;
                self.move_sel(1);
                if self.tab == Tab::Docs {
                    self.doc_scroll = 0; // reset scroll when the selected doc changes
                    self.publish_active_doc();
                }
                self.testing_domain_changed(prev_domain);
                // Swarm pane: a roster cursor move publishes the new bee selection
                // to the bee-dossier relay (pui-bee-dossier-pane-2026-06-06). A new
                // agent means new mail, so the comms cursors reset to the top.
                if self.tab == Tab::Fleet {
                    self.fleet.comms_inbox_sel = 0;
                    self.fleet.comms_outbox_sel = 0;
                    return self.publish_swarm_selection();
                }
                Action::Render
            }
            KeyCode::Char('k') | KeyCode::Up => {
                if self.tab == Tab::Operator {
                    self.chat_scroll = self.chat_scroll.saturating_add(1); // into history
                    return Action::Render;
                }
                let prev_domain = self.testing_sel;
                self.move_sel(-1);
                if self.tab == Tab::Docs {
                    self.doc_scroll = 0;
                    self.publish_active_doc();
                }
                self.testing_domain_changed(prev_domain);
                if self.tab == Tab::Fleet {
                    self.fleet.comms_inbox_sel = 0;
                    self.fleet.comms_outbox_sel = 0;
                    return self.publish_swarm_selection();
                }
                Action::Render
            }
            // Tab switching — the SINGLE keymap (g1): a char that maps to a tab's
            // `switch_key` switches to it. Must be the last `Char` arm so the
            // contextual char handlers above (n/g/r/i/p/N/[/]/</>) win first.
            KeyCode::Char(c) => match Tab::from_switch_key(c) {
                Some(t) => {
                    self.switch_to(t);
                    // Lazy-load the Cupboard listings the first time it's opened
                    // (D-011) — the marketplace isn't part of the startup fetch.
                    if t == Tab::Cupboard && self.cupboard.is_empty() && !self.cupboard_loading {
                        return self.refetch_cupboard();
                    }
                    // Same lazy-load for Conversations (Brief 25) — not in the
                    // startup poll; fetch the list on first open.
                    if t == Tab::Conversations
                        && self.conversations.is_empty()
                        && !self.conversations_loading
                    {
                        return self.refetch_conversations();
                    }
                    // Voice tab (holepunch-voice-channels P-008): connect the voice
                    // socket + fetch the channel list on first open.
                    if t == Tab::Voice && !self.voice_ui.connected {
                        return Action::VoiceChan(crate::voice_ui::VoiceCmd::Connect);
                    }
                    // Fleet (Swarm) tab: refresh the whole-fleet task list — the
                    // default dossier (pui-dock-consolidation-2026-06-07 #2) —
                    // on every entry (assignments are volatile: claims churn).
                    if t == Tab::Fleet {
                        return Action::FetchFleetAssignments;
                    }
                    // Hives tab: refresh the federated p2p roster on every entry
                    // (presence is volatile — peers announce + go stale).
                    if t == Tab::Hives {
                        return Action::FetchHives;
                    }
                    Action::Render
                }
                None => Action::None,
            },
            _ => Action::None,
        }
    }

    /// After a j/k move on the Testing domain column (D-004a): a domain change
    /// invalidates the fetched file list (it belongs to the previous domain) —
    /// Enter refetches for the new one.
    fn testing_domain_changed(&mut self, prev_domain_sel: usize) {
        if self.tab == Tab::Testing
            && self.testing_focus == TestingFocus::Domains
            && self.testing_sel != prev_domain_sel
        {
            self.testing_files.clear();
            self.testing_file_sel = 0;
            self.testing_files_loading = false;
        }
    }

    /// Switch the active tab, applying the per-tab on-enter side effects (landing
    /// on the Inbox acknowledges its notification badge). The one place tab
    /// changes flow through, so digit/letter keys and `<`/`>` cycling share it.
    fn switch_to(&mut self, tab: Tab) {
        self.tab = tab;
        // Leaving a multi-pane tab drops its entered-pane state so the next one
        // opens at the browsing level (two-level nav, owner ask 2026-06-15 #2).
        self.pane_entered = false;
        // Same for the Plans master-detail surface (owner ask 2026-06-16): open
        // at the plans-list pane, browsing level, items cursor reset.
        self.plans_entered = false;
        self.plans_focus = PlansFocus::List;
        self.plan_items_sel = 0;
        if tab == Tab::Inbox {
            self.unseen_notifs = 0;
            self.toast = None;
        }
    }

    /// Cycle the active tab by `delta` (wrapping) across `Tab::ALL` — the
    /// scalable nav beyond the digit shortcuts (`<`/`>`). Landing on Inbox
    /// acknowledges its notification badge, mirroring the digit-'2' handler.
    fn cycle_tab(&mut self, delta: isize) {
        let n = Tab::ALL.len() as isize;
        let cur = self.tab.index() as isize;
        let next = ((cur + delta).rem_euclid(n)) as usize;
        self.switch_to(Tab::ALL[next]);
    }

    // ─── Cupboard tab (D-011) ───

    /// Trigger a Cupboard listings fetch for the active (kind, query) filter.
    /// Marks the in-flight flag; the run loop emits `Event::CupboardListings`,
    /// which the stale-guarded reducer arm applies.
    fn refetch_cupboard(&mut self) -> Action {
        self.cupboard_loading = true;
        Action::FetchCupboard {
            kind: CUPBOARD_KINDS[self.cupboard_kind].to_string(),
            query: self.cupboard_query.clone(),
        }
    }

    /// Enter on the Cupboard tab: a two-step arm→confirm. The first Enter arms
    /// the selected listing (sets `cupboard_confirm` to its id, surfaced in the
    /// detail title); a second Enter on the still-selected armed listing fires
    /// its per-kind action. Nothing selected → no-op.
    fn cupboard_activate(&mut self) -> Action {
        let Some(listing) = self.cupboard.get(self.cupboard_sel) else {
            return Action::None;
        };
        if self.cupboard_confirm.as_deref() == Some(listing.id.as_str()) {
            self.cupboard_confirm = None;
            Action::CupboardAct {
                listing: listing.clone(),
            }
        } else {
            self.cupboard_confirm = Some(listing.id.clone());
            Action::Render
        }
    }

    // ── Conversations tab (Brief 25) ──────────────────────────────────────────
    /// The topic-filtered conversation list — `conversation_sel` indexes THIS.
    /// State/kind are applied server-side at fetch; the topic filter is
    /// client-side so the topic-cycle universe stays the full state/kind page.
    pub fn visible_conversations(&self) -> Vec<&crate::models::ConvSummary> {
        self.conversations
            .iter()
            .filter(|c| match &self.conv_topic {
                Some(t) => c.topics.iter().any(|x| x == t),
                None => true,
            })
            .collect()
    }

    pub fn selected_conversation(&self) -> Option<&crate::models::ConvSummary> {
        self.visible_conversations()
            .get(self.conversation_sel)
            .copied()
    }

    pub fn conv_state(&self) -> &'static str {
        CONV_STATES[self.conv_state_idx.min(CONV_STATES.len() - 1)]
    }
    pub fn conv_kind(&self) -> &'static str {
        CONV_KINDS[self.conv_kind_idx.min(CONV_KINDS.len() - 1)]
    }

    /// Mark the list in-flight + emit the fetch under the current state/kind.
    fn refetch_conversations(&mut self) -> Action {
        self.conversations_loading = true;
        self.conversation_detail = None;
        Action::FetchConversations {
            state: self.conv_state().to_string(),
            kind: self.conv_kind().to_string(),
        }
    }

    /// The sorted, unique topic universe across the loaded page (the cycle set).
    fn conv_topics_universe(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .conversations
            .iter()
            .flat_map(|c| c.topics.iter().cloned())
            .collect();
        v.sort();
        v.dedup();
        v
    }

    /// Cycle the client-side topic filter: None → t0 → t1 → … → None.
    fn cycle_conv_topic(&mut self) {
        let universe = self.conv_topics_universe();
        if universe.is_empty() {
            self.conv_topic = None;
            return;
        }
        self.conv_topic = match &self.conv_topic {
            None => Some(universe[0].clone()),
            Some(cur) => match universe.iter().position(|t| t == cur) {
                Some(i) if i + 1 < universe.len() => Some(universe[i + 1].clone()),
                _ => None,
            },
        };
        self.conversation_sel = 0;
        self.conversation_detail = None;
    }

    /// Enter on the Conversations tab: load the selected conversation's thread.
    fn conv_open_detail(&mut self) -> Action {
        match self.selected_conversation() {
            Some(c) => Action::FetchConversationDetail { id: c.id.clone() },
            None => Action::None,
        }
    }

    // ── Fleet comms-overlay navigation (owner ask 2026-06-14) ──────────────────

    /// Entry counts for the SELECTED bee's mail sides (rendered newest-first).
    fn comms_inbox_len(&self) -> usize {
        self.bee
            .mail
            .as_ref()
            .map(|m| m.inbox.entries.len())
            .unwrap_or(0)
    }
    fn comms_outbox_len(&self) -> usize {
        self.bee
            .mail
            .as_ref()
            .map(|m| m.outbox.entries.len())
            .unwrap_or(0)
    }

    /// The mail entry under the comms cursor when an Inbox/Outbox panel holds
    /// focus (rendered newest-first, so cursor 0 = the last entry). `None` when
    /// the roster/conversations panel is focused or the side is empty.
    pub fn selected_comms_mail(&self) -> Option<&crate::models::BeeMailEntry> {
        use crate::fleet::FleetPanel::*;
        let (side, sel) = match self.fleet.fleet_focus {
            Inbox => (&self.bee.mail.as_ref()?.inbox, self.fleet.comms_inbox_sel),
            Outbox => (&self.bee.mail.as_ref()?.outbox, self.fleet.comms_outbox_sel),
            _ => return None,
        };
        let n = side.entries.len();
        if n == 0 {
            return None;
        }
        side.entries.get(n - 1 - sel.min(n - 1))
    }

    /// Fleet ↑/↓ (two-level nav, owner ask 2026-06-15 #2): BROWSE between panes
    /// when not yet entered; once inside, move WITHIN the focused pane (the
    /// roster publishes its new bee selection; the other panes move their
    /// cursor/scroll).
    fn fleet_arrow(&mut self, delta: isize) -> Action {
        if !self.fleet.entered {
            self.fleet.fleet_focus = self.fleet.fleet_focus.cycle(self.fleet.show_comms, delta);
            return Action::Render;
        }
        if self.fleet.fleet_focus == crate::fleet::FleetPanel::Roster {
            return self.fleet_roster_move(delta);
        }
        self.fleet_within_move(delta);
        Action::Render
    }

    /// Move the roster cursor + republish the bee selection (a new agent means
    /// new mail, so the comms cursors reset). The entered-roster ↑/↓ path — the
    /// roster-move side effects the generic `move_sel` arm used to run for Fleet.
    fn fleet_roster_move(&mut self, delta: isize) -> Action {
        self.move_sel(delta);
        self.fleet.comms_inbox_sel = 0;
        self.fleet.comms_outbox_sel = 0;
        // A new agent narrows the dossier to that bee — reset the task cursor so
        // it doesn't point past the new (shorter) list.
        self.fleet.dossier_sel = 0;
        self.publish_swarm_selection()
    }

    /// ↑/↓ for the side-by-side 2-pane tabs — Pots/Testing (two-level nav, owner
    /// ask 2026-06-15 #2): BROWSE between the two panes when not entered, else
    /// move WITHIN the focused list (replaying the generic `move_sel` side effects
    /// so Testing's domain→files invalidation still fires).
    fn pane_arrow(&mut self, delta: isize) -> Action {
        if !self.pane_entered {
            self.pane_toggle_focus();
            return Action::Render;
        }
        let prev_domain = self.testing_sel;
        self.move_sel(delta);
        self.testing_domain_changed(prev_domain); // no-op unless Testing + Domains
        Action::Render
    }

    /// Toggle the focused pane of the current horizontal 2-pane tab.
    fn pane_toggle_focus(&mut self) {
        match self.tab {
            Tab::Harnesses => {
                self.harness_focus = match self.harness_focus {
                    HarnessFocus::Features => HarnessFocus::Issues,
                    HarnessFocus::Issues => HarnessFocus::Features,
                }
            }
            Tab::Testing => {
                self.testing_focus = match self.testing_focus {
                    TestingFocus::Domains => TestingFocus::Files,
                    TestingFocus::Files => TestingFocus::Domains,
                }
            }
            _ => {}
        }
    }

    /// `j`/`k` (↑/↓) move WITHIN the focused panel: the inbox/outbox/conversation
    /// row cursor (clamped — no fall-through; `h`/`l` switch panels), or the
    /// dossier scroll offset / plan-progress selection. Only reached when the
    /// pane is "entered" (two-level nav); the roster has its own `fleet_roster_move`.
    fn fleet_within_move(&mut self, delta: isize) {
        use crate::fleet::FleetPanel::*;
        let sel_step = |cur: usize, delta: isize, len: usize| -> usize {
            if len == 0 {
                0
            } else if delta > 0 {
                (cur + 1).min(len - 1)
            } else {
                cur.saturating_sub(1)
            }
        };
        match self.fleet.fleet_focus {
            Roster => {}
            Inbox => {
                self.fleet.comms_inbox_sel =
                    sel_step(self.fleet.comms_inbox_sel, delta, self.comms_inbox_len());
            }
            Outbox => {
                self.fleet.comms_outbox_sel =
                    sel_step(self.fleet.comms_outbox_sel, delta, self.comms_outbox_len());
            }
            Conversations => {
                let len = self.visible_conversations().len();
                self.conversation_sel = sel_step(self.conversation_sel, delta, len);
            }
            Dossier => {
                // ↑/↓ now move a highlighted task cursor (was a bare scroll),
                // skipping per-bee headers (owner ask 2026-06-16).
                let len = crate::fleet::dossier_task_count(self);
                self.fleet.dossier_sel = sel_step(self.fleet.dossier_sel, delta, len);
            }
            PlanProgress => {
                let len = crate::fleet::plan_progress_list(self).len();
                self.fleet.plan_progress_sel = sel_step(self.fleet.plan_progress_sel, delta, len);
            }
        }
    }

    /// Enter on the focused Fleet panel: roster → reach the agent;
    /// inbox/outbox/conversations → open the detail popup (conversations also
    /// fetch the thread); plan-progress → open the selected plan's detail popup
    /// (owner ask 2026-06-15). The dossier (a multi-bee scrolled list) has no
    /// per-row detail.
    fn fleet_enter_focused(&mut self) -> Action {
        use crate::fleet::FleetPanel::*;
        match self.fleet.fleet_focus {
            Roster => self.fleet_enter(),
            Inbox | Outbox => {
                if self.selected_comms_mail().is_some() {
                    self.fleet_detail_open = true;
                    self.fleet_detail_scroll = 0;
                }
                Action::Render
            }
            Conversations => {
                if self.selected_conversation().is_some() {
                    self.fleet_detail_open = true;
                    self.fleet_detail_scroll = 0;
                    return self.conv_open_detail();
                }
                Action::Render
            }
            PlanProgress => {
                // Only open when there's a plan to describe — an empty panel's
                // Enter is a no-op (matches the comms panels' guarded open).
                if !crate::fleet::plan_progress_list(self).is_empty() {
                    self.fleet_detail_open = true;
                    self.fleet_detail_scroll = 0;
                }
                Action::Render
            }
            // Dossier (worklist): open the selected work item's detail popup —
            // consistent with the other panes' guarded Enter (owner ask 2026-06-16).
            Dossier => {
                if crate::fleet::selected_dossier_item(self).is_some() {
                    self.fleet_detail_open = true;
                    self.fleet_detail_scroll = 0;
                }
                Action::Render
            }
        }
    }

    /// `j`/`k` while the detail popup is open: step WITHIN the focused list
    /// (clamped — no fall-through, the popup stays on one list); conversations
    /// refetch the newly-selected thread. On the Plans tab the popup steps the
    /// plan-list selection (owner ask 2026-06-15 #1).
    fn fleet_detail_step(&mut self, delta: isize) -> Action {
        use crate::fleet::FleetPanel::*;
        // A new item starts at the top of the popup.
        self.fleet_detail_scroll = 0;
        let step = |cur: usize, delta: isize, len: usize| -> usize {
            if len == 0 {
                return 0;
            }
            if delta > 0 {
                (cur + 1).min(len - 1)
            } else {
                cur.saturating_sub(1)
            }
        };
        // Both Plans surfaces reuse this popup; j/k step the FOCUSED pane's
        // cursor (owner ask 2026-06-16) so closing it leaves the list where you
        // navigated — the work-items list when the Items pane is focused, else
        // the plan list.
        if self.tab == Tab::Plans {
            if self.plans_focus == PlansFocus::Items {
                let len = self.plans_items().len();
                self.plan_items_sel = step(self.plan_items_sel, delta, len);
            } else {
                let len = self.visible_plans().len();
                self.plan_sel = step(self.plan_sel, delta, len);
                self.plan_items_sel = 0;
            }
            return Action::Render;
        }
        if self.tab == Tab::PlansBoard {
            if self.plans_focus == PlansFocus::Items {
                let len = self.plans_items().len();
                self.plan_items_sel = step(self.plan_items_sel, delta, len);
                return Action::Render;
            }
            let len = crate::plans_board::board_rows(self).len();
            self.plans_board_sel = step(self.plans_board_sel, delta, len);
            self.plan_items_sel = 0;
            return self.fetch_selected_board_item_states();
        }
        match self.fleet.fleet_focus {
            Inbox => {
                self.fleet.comms_inbox_sel =
                    step(self.fleet.comms_inbox_sel, delta, self.comms_inbox_len());
                Action::Render
            }
            Outbox => {
                self.fleet.comms_outbox_sel =
                    step(self.fleet.comms_outbox_sel, delta, self.comms_outbox_len());
                Action::Render
            }
            Conversations => {
                let len = self.visible_conversations().len();
                self.conversation_sel = step(self.conversation_sel, delta, len);
                self.conv_open_detail()
            }
            PlanProgress => {
                let len = crate::fleet::plan_progress_list(self).len();
                self.fleet.plan_progress_sel = step(self.fleet.plan_progress_sel, delta, len);
                Action::Render
            }
            // Dossier: step the task cursor within the popup so closing it leaves
            // the worklist where you navigated (owner ask 2026-06-16).
            Dossier => {
                let len = crate::fleet::dossier_task_count(self);
                self.fleet.dossier_sel = step(self.fleet.dossier_sel, delta, len);
                Action::Render
            }
            Roster => Action::Render,
        }
    }

    /// `i` on the Conversations tab: promote the selected conversation → issue.
    fn conv_promote(&mut self) -> Action {
        match self.selected_conversation() {
            Some(c) if c.promoted_issue_id.is_none() && c.state != "closed" => {
                Action::PromoteConversation { id: c.id.clone() }
            }
            _ => Action::None,
        }
    }

    /// Enter on the Overview tab: click the selected tile through to its full
    /// tab (overview-dashboard-2026-06-05 D-007). Pure tile→tab mapping:
    /// 0 Plans → Plans · 1 Needs-you → Inbox · 2 Agents / 3 Activity → Fleet
    /// (the fleet view carries both the roster and the activity stream).
    pub fn overview_tile_target(sel: usize) -> Tab {
        match sel {
            0 => Tab::Plans,
            1 => Tab::Inbox,
            _ => Tab::Fleet,
        }
    }

    fn overview_activate(&mut self) -> Action {
        let target = Self::overview_tile_target(self.overview_sel);
        self.switch_to(target);
        Action::Render
    }

    /// Nudge the editable hard cap (`maxSimultaneousAgents`) from the Overview
    /// top-bar (P-005). No-op until the read-model has loaded — you can't edit
    /// what you can't see. Optimistic: the local copy updates immediately; the
    /// run loop PUTs + refetches truth (a failed PUT is corrected by the next
    /// poll, the same contract as the desktop control).
    fn nudge_max_agents(&mut self, delta: i64) -> Action {
        let Some(s) = self.fleet_rate.as_mut() else {
            return Action::None;
        };
        let next = (i64::from(s.config.max_simultaneous_agents) + delta).clamp(1, 64) as u32;
        if next == s.config.max_simultaneous_agents {
            return Action::None;
        }
        s.config.max_simultaneous_agents = next;
        s.fleet.cap = next;
        Action::SetMaxAgents(next)
    }

    fn move_sel(&mut self, delta: isize) {
        // Two phases: the visible LENGTH first (scope-filtered lists borrow
        // self immutably, D-003), then the cursor slot.
        let len = match self.tab {
            // The Overview's four tiles (Plans · Needs-you · Agents · Activity).
            Tab::Overview => 4,
            Tab::Plans => self.visible_plans().len(),
            Tab::Inbox => self.visible_inbox().len(),
            Tab::Harnesses => match self.harness_focus {
                HarnessFocus::Features => self.features.len(),
                HarnessFocus::Issues => self.issues.len(),
            },
            Tab::Docs => self.docs_files.len(),
            Tab::Testing => match self.testing_focus {
                TestingFocus::Domains => self.testing.len(),
                TestingFocus::Files => self.testing_files.len(),
            },
            Tab::Plugins => match self.plugins_focus {
                PluginsFocus::List => self.plugins.len(),
                PluginsFocus::Panes => self.panes.len(),
            },
            Tab::Settings => self.flags.len(),
            Tab::Fleet => self.visible_roster().len(),
            Tab::Memory => self.visible_memories().len(),
            Tab::Cupboard => self.cupboard.len(),
            Tab::Conversations => self.visible_conversations().len(),
            Tab::Hives => crate::hives::group_hives(&self.hives).len(),
            // No list move_sel navigates — j/k scroll the transcript (Operator),
            // Config has no list, the Voice tab owns its own j/k in voice_ui,
            // and the Wake board / agent-context / network panes own their own
            // j/k (pinned dock panes own their whole keymap).
            Tab::Config
            | Tab::Operator
            | Tab::Voice
            | Tab::Wake
            | Tab::AgentCtx
            | Tab::Network
            | Tab::PlansBoard => return,
        };
        if len == 0 {
            return;
        }
        let slot: &mut usize = match self.tab {
            Tab::Overview => &mut self.overview_sel,
            Tab::Plans => &mut self.plan_sel,
            Tab::Inbox => &mut self.inbox_sel,
            Tab::Harnesses => match self.harness_focus {
                HarnessFocus::Features => &mut self.feat_sel,
                HarnessFocus::Issues => &mut self.issue_sel,
            },
            Tab::Docs => &mut self.doc_sel,
            Tab::Testing => match self.testing_focus {
                TestingFocus::Domains => &mut self.testing_sel,
                TestingFocus::Files => &mut self.testing_file_sel,
            },
            Tab::Plugins => match self.plugins_focus {
                PluginsFocus::List => &mut self.plugin_sel,
                PluginsFocus::Panes => &mut self.pane_sel,
            },
            Tab::Settings => &mut self.flag_sel,
            Tab::Fleet => &mut self.fleet.agent_sel,
            Tab::Memory => &mut self.memory_sel,
            Tab::Cupboard => &mut self.cupboard_sel,
            Tab::Conversations => &mut self.conversation_sel,
            Tab::Hives => &mut self.hive_sel,
            Tab::Config
            | Tab::Operator
            | Tab::Voice
            | Tab::Wake
            | Tab::AgentCtx
            | Tab::Network
            | Tab::PlansBoard => return,
        };
        let next = (*slot as isize + delta).clamp(0, len as isize - 1);
        *slot = next as usize;
    }
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

/// Shorten an owner id for a pane title: "su-8b77dde5-…" → "su-8b77d".
/// Flip a wake mode for the P-008 toggle: `manual`→`auto`, anything else
/// (auto / unset) → `manual`. Pure — unit-tested.
fn next_wake_mode(current: Option<&str>) -> &'static str {
    if current == Some("manual") {
        "auto"
    } else {
        "manual"
    }
}

fn short_owner(owner: &str) -> String {
    let mut n = 0usize;
    for (i, c) in owner.char_indices() {
        if c == '-' {
            n += 1;
            if n == 2 {
                return owner[..i].to_string();
            }
        }
    }
    owner.chars().take(8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ActivityRow, PlanSummary, WorkItem};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    fn key(c: char, mods: KeyModifiers) -> Event {
        Event::Key(KeyEvent::new(KeyCode::Char(c), mods))
    }

    #[test]
    fn next_wake_mode_flips_manual_else_defaults_to_manual() {
        // P-008 toggle: manual → auto; auto / unset → manual.
        assert_eq!(next_wake_mode(Some("manual")), "auto");
        assert_eq!(next_wake_mode(Some("auto")), "manual");
        assert_eq!(next_wake_mode(None), "manual");
    }

    // ─── Dock grouping by pane type (hive-agent-tabs P-011) ───

    fn fleet_bee(owner: &str, kind: &str) -> RosterEntry {
        RosterEntry {
            owner_id: owner.into(),
            label: format!("su · {owner}"),
            source: "fleet-spawn".into(),
            liveness: "live".into(),
            agent: Some("claude".into()),
            agent_pane_kind: Some(kind.into()),
            session_id: Some(format!("sid-{owner}")),
            ..Default::default()
        }
    }

    #[test]
    fn bee_panes_append_grouped_by_kind_and_dedup_by_owner() {
        let mut a = App::new();
        a.hive_agent_tabs = true;
        a.dock_agent_panes = true;
        // Roster interleaves planner/bee/planner/bee — the batch must group.
        a.set_roster(vec![
            fleet_bee("p-1", "planner"),
            fleet_bee("b-1", "bee"),
            fleet_bee("p-2", "planner"),
            fleet_bee("b-2", "bee"),
        ]);
        let specs = a.bee_panes_to_open();
        let titles: Vec<&str> = specs
            .iter()
            .map(|s| s.title.as_deref().unwrap_or(""))
            .collect();
        // One pane per agent (owner ask 2026-06-11: bees do NOT get a per-bee
        // wake pane — they review via the fleet-wide board; the queen's inline
        // split lives in the dock KDL). 4 agents ⇒ 4 specs.
        assert_eq!(specs.len(), 4);
        // Bees (rank 2) before planners (rank 3); roster order within a group.
        assert!(
            titles[0].starts_with("☕") && titles[1].starts_with("☕"),
            "{titles:?}"
        );
        assert!(
            titles[2].starts_with("📋") && titles[3].starts_with("📋"),
            "{titles:?}"
        );
        // The dedup set records OWNER ids (not argv[2], which is a session id for
        // a flag-on claude --resume bee) — a re-refresh opens nothing.
        for o in ["p-1", "b-1", "p-2", "b-2"] {
            assert!(a.paned_bees.contains(o), "owner {o} not recorded");
        }
        assert!(
            a.bee_panes_to_open().is_empty(),
            "second refresh must dedup"
        );
    }

    #[test]
    fn owner_scoped_wake_pane_exits_only_when_bee_gone_AND_queue_drained() {
        let mut a = App::new();
        a.wake_filter = WakeFilter::Owner("b-1".into());
        a.update(Event::WakeBoard {
            result: Ok((
                vec![board_group("b-1", vec![pending_wake(7, "boot")])],
                None,
            )),
        });
        let bee = fleet_bee("b-1", "bee");
        // Present → no exit, misses reset.
        a.update(Event::Roster {
            active: vec![bee.clone()],
            pending: vec![],
        });
        assert!(!a.wake_pane_should_exit());
        // Gone twice → still NO exit: the queue holds a reviewable wake.
        a.update(Event::Roster {
            active: vec![],
            pending: vec![],
        });
        a.update(Event::Roster {
            active: vec![],
            pending: vec![],
        });
        assert_eq!(a.wake_owner_misses, 2);
        assert!(
            !a.wake_pane_should_exit(),
            "drain gate: staged wakes keep the pane"
        );
        // Queue drains → NOW it exits.
        a.update(Event::WakeBoard {
            result: Ok((vec![], None)),
        });
        assert!(a.wake_pane_should_exit());
        // A returning bee resets the misses (churn tolerance).
        a.update(Event::Roster {
            active: vec![bee],
            pending: vec![],
        });
        assert!(!a.wake_pane_should_exit());
        assert_eq!(a.wake_owner_misses, 0);
        // The static panes never self-exit, drained or not.
        let mut q = App::new();
        q.wake_filter = WakeFilter::Queen;
        q.update(Event::WakeBoard {
            result: Ok((vec![], None)),
        });
        q.update(Event::Roster {
            active: vec![],
            pending: vec![],
        });
        q.update(Event::Roster {
            active: vec![],
            pending: vec![],
        });
        assert!(!q.wake_pane_should_exit());
    }

    fn topo_pane(id: u32, title: &str) -> pui_companion_proto::PaneNode {
        pui_companion_proto::PaneNode {
            id,
            tab: 0,
            title: title.into(),
            focused: false,
            is_plugin: false,
            exited: false,
            command: None,
        }
    }

    #[test]
    fn dock_regroup_ids_orders_interleaved_types_and_is_stable_when_grouped() {
        let mut a = App::new();
        a.hive_agent_tabs = true;
        a.dock_agent_panes = true;
        // sentinel(1) · bee(2) · queen(3) · planner(4) · bee(5) + unglyphed cups(6).
        let topo = pui_companion_proto::Topology {
            tabs: vec![],
            panes: vec![
                topo_pane(1, "🥤 papercup"),
                topo_pane(2, "☕ claude · F-12"),
                topo_pane(3, "🍵 mug"),
                topo_pane(4, "📋 planner · my-plan"),
                topo_pane(5, "☕ codex · F-9"),
                topo_pane(6, "cups"),
            ],
        };
        // Grouped target: sentinel · queen · bees (roster order) · planner; the
        // unglyphed cups pane never participates.
        assert_eq!(a.dock_regroup_ids(&topo), Some(vec![1, 3, 2, 5, 4]));
        // Already-grouped → None (no churn).
        let grouped = pui_companion_proto::Topology {
            tabs: vec![],
            panes: vec![
                topo_pane(1, "🥤 papercup"),
                topo_pane(3, "🍵 mug"),
                topo_pane(2, "☕ claude · F-12"),
                topo_pane(5, "☕ codex · F-9"),
                topo_pane(4, "📋 planner · my-plan"),
            ],
        };
        assert_eq!(a.dock_regroup_ids(&grouped), None);
        // Flag-off / non-driver → never regroups.
        a.hive_agent_tabs = false;
        assert_eq!(a.dock_regroup_ids(&topo), None);
    }

    #[test]
    fn topology_event_fires_one_stack_repair_per_target() {
        let mut a = App::new();
        a.hive_agent_tabs = true;
        a.dock_agent_panes = true;
        let mis = pui_companion_proto::Topology {
            tabs: vec![],
            panes: vec![topo_pane(2, "☕ claude · F-12"), topo_pane(1, "🥤 papercup")],
        };
        // First mis-ordered snapshot → the stack repair fires.
        match a.update(Event::Topology(mis.clone())) {
            Action::Dock(DockCmd::Stack { pane_ids }) => assert_eq!(pane_ids, vec![1, 2]),
            other => panic!("expected a stack repair, got {other:?}"),
        }
        // The SAME mis-order again → guarded (no spam).
        assert_eq!(a.update(Event::Topology(mis)), Action::Render);
        // A grouped snapshot re-arms the guard.
        let grouped = pui_companion_proto::Topology {
            tabs: vec![],
            panes: vec![topo_pane(1, "🥤 papercup"), topo_pane(2, "☕ claude · F-12")],
        };
        assert_eq!(a.update(Event::Topology(grouped)), Action::Render);
        assert!(a.last_regroup.is_none());
    }

    // ─── Per-frame tabs (hive-agent-tabs P-013) ───

    fn frame(slug: &str, host: &str) -> crate::models::DeployFrameRow {
        crate::models::DeployFrameRow {
            slug: slug.into(),
            frame: crate::models::DeployFrameInfo {
                id: format!("fr-{slug}"),
                host: Some(host.into()),
                region: Some("iad".into()),
                kind: Some("fly".into()),
            },
            desktop: true,
        }
    }

    #[test]
    fn frames_event_creates_missing_frame_tabs_with_host_matched_agents() {
        let mut a = App::new();
        a.hive_agent_tabs = true;
        a.dock_agent_panes = true;
        // Topology present (companion linked) — only the local dock tab exists.
        a.topology = Some(pui_companion_proto::Topology {
            tabs: vec![pui_companion_proto::TabNode {
                pos: 0,
                name: "Tab #1".into(),
                active: true,
                swap_layout: None,
                swap_dirty: false,
            }],
            panes: vec![],
        });
        // One remote agent on the frame's host, one local.
        let mut remote = fleet_bee("su-remote", "bee");
        remote.host = "cloud-1".into();
        let mut local = fleet_bee("su-local", "bee");
        local.host = "dev-box".into();
        a.set_roster(vec![remote, local]);
        match a.update(Event::Frames(vec![frame("papercup-cloud", "cloud-1")])) {
            Action::CreateFrameTabs { tabs } => {
                assert_eq!(tabs.len(), 1);
                let (name, kdl) = &tabs[0];
                assert_eq!(name, "☁ papercup-cloud");
                // P-014 retired the watch-pane surface: the frame tab is a named
                // placeholder — no per-agent panes (the remote live view is the
                // streamed desktop in the webview Frames tab).
                assert!(kdl.contains("tab name=\"☁ papercup-cloud\""), "{kdl}");
                assert!(!kdl.contains("watch-pane"), "{kdl}");
                assert!(
                    !kdl.contains("su-remote") && !kdl.contains("su-local"),
                    "{kdl}"
                );
            }
            other => panic!("expected CreateFrameTabs, got {other:?}"),
        }
        // Same frames again → already created (dedup window) → no re-create.
        assert_eq!(
            a.update(Event::Frames(vec![frame("papercup-cloud", "cloud-1")])),
            Action::Render
        );
        // A tab already in topology never re-creates either.
        a.created_frame_tabs.clear();
        a.topology
            .as_mut()
            .unwrap()
            .tabs
            .push(pui_companion_proto::TabNode {
                pos: 1,
                name: "☁ papercup-cloud".into(),
                active: false,
                swap_layout: None,
                swap_dirty: false,
            });
        assert_eq!(
            a.update(Event::Frames(vec![frame("papercup-cloud", "cloud-1")])),
            Action::Render
        );
    }

    fn fed_peer(host: &str, key: &str, stale: bool) -> crate::models::PresenceRow {
        crate::models::PresenceRow {
            owner_id: format!("fed:1@{host}"),
            owner_label: format!("gh:1 · {host}"),
            intent: "working".into(),
            host: host.into(),
            user_id: Some("1".into()),
            stale,
            federated: true,
            device_pubkey: Some(key.into()),
            harness_slug: Some("papercup".into()),
            current_view: None,
            heartbeat_at: Some("2026-06-14T00:00:00Z".into()),
        }
    }

    #[test]
    fn hives_event_opens_a_persistent_tab_per_live_federated_peer() {
        let mut a = App::new();
        a.hive_agent_tabs = true;
        a.dock_agent_panes = true;
        // Topology present (companion linked) — only the local dock tab exists.
        a.topology = Some(pui_companion_proto::Topology {
            tabs: vec![pui_companion_proto::TabNode {
                pos: 0,
                name: "Tab #1".into(),
                active: true,
                swap_layout: None,
                swap_dirty: false,
            }],
            panes: vec![],
        });
        // One LIVE federated peer + one STALE → only the live one earns a tab.
        match a.update(Event::Hives(vec![
            fed_peer("mbp", "key-a", false),
            fed_peer("tower", "key-b", true),
        ])) {
            Action::CreateHiveTabs { tabs } => {
                assert_eq!(tabs.len(), 1);
                let (name, kdl) = &tabs[0];
                assert_eq!(name, "◆ mbp");
                assert!(kdl.contains("tab name=\"◆ mbp\""), "{kdl}");
                // Persistent — rides the hive's lifetime, no close_on_exit husk.
                assert!(!kdl.contains("close_on_exit"), "{kdl}");
                assert!(kdl.contains("args \"hive-pane\" \"key-a\""), "{kdl}");
            }
            other => panic!("expected CreateHiveTabs, got {other:?}"),
        }
        // Same roster again → already created (dedup window) → no re-create.
        assert_eq!(
            a.update(Event::Hives(vec![fed_peer("mbp", "key-a", false)])),
            Action::Render
        );
        // A tab already in topology never re-creates either.
        a.created_hive_tabs.clear();
        a.topology
            .as_mut()
            .unwrap()
            .tabs
            .push(pui_companion_proto::TabNode {
                pos: 1,
                name: "◆ mbp".into(),
                active: false,
                swap_layout: None,
                swap_dirty: false,
            });
        assert_eq!(
            a.update(Event::Hives(vec![fed_peer("mbp", "key-a", false)])),
            Action::Render
        );
    }

    #[test]
    fn hive_tabs_gated_to_the_flag_on_dock_driver_with_topology() {
        let mut a = App::new();
        a.hives = vec![fed_peer("mbp", "key-a", false)];
        // dock-agent-panes on but hive-agent-tabs off → never.
        a.dock_agent_panes = true;
        assert!(a.hive_tabs_to_create().is_empty());
        // Both flags on but NO topology (no companion) → no tab surface yet.
        a.hive_agent_tabs = true;
        a.topology = None;
        assert!(a.hive_tabs_to_create().is_empty());
    }

    #[test]
    fn frame_tabs_gated_to_the_flag_on_dock_driver_with_topology() {
        let mut a = App::new();
        // Flag-off → never.
        a.dock_agent_panes = true;
        a.topology = Some(pui_companion_proto::Topology::default());
        a.frames = vec![frame("papercup-cloud", "cloud-1")];
        assert!(a.frame_tabs_to_create().is_empty());
        // Flag-on but no topology (no companion) → nothing offered yet.
        a.hive_agent_tabs = true;
        a.topology = None;
        assert!(a.frame_tabs_to_create().is_empty());
        // Topology arrives → the tab is offered (placeholder pane, no agents).
        a.topology = Some(pui_companion_proto::Topology::default());
        let tabs = a.frame_tabs_to_create();
        assert_eq!(tabs.len(), 1);
        assert!(tabs[0].1.contains("tab name=\"☁ papercup-cloud\""));
    }

    // ─── Staged-wake review overlay (hive-agent-tabs P-009) ───

    fn pending_wake(id: i64, summary: &str) -> crate::models::PendingWake {
        crate::models::PendingWake {
            id,
            owner_id: "su-aaa".into(),
            summary: Some(summary.into()),
            source: Some("routinesTick".into()),
            created_at: "2026-06-09".into(),
            count: 1,
            last_seen_at: None,
        }
    }

    fn app_with_review_open() -> App {
        let mut a = App::new();
        a.hive_agent_tabs = true;
        a.switch_to(Tab::Fleet);
        a.set_roster(vec![RosterEntry {
            owner_id: "su-aaa".into(),
            label: "su · su-aaa".into(),
            liveness: "live".into(),
            agent: Some("claude".into()),
            wake_mode: Some("manual".into()),
            ..Default::default()
        }]);
        a.fleet.agent_sel = 0;
        let act = a.update(key('W', KeyModifiers::SHIFT));
        assert_eq!(
            act,
            Action::FetchWakeQueue {
                agent: "su-aaa".into()
            }
        );
        assert!(a.wake_review.as_ref().expect("overlay open").loading);
        a
    }

    #[test]
    fn wake_review_opens_with_shift_w_and_paints_the_list() {
        let mut a = app_with_review_open();
        let act = a.update(Event::WakeQueue {
            agent: "su-aaa".into(),
            result: Ok(vec![pending_wake(7, "tick"), pending_wake(9, "mail")]),
        });
        assert_eq!(act, Action::Render);
        let rev = a.wake_review.as_ref().unwrap();
        assert!(!rev.loading && !rev.busy);
        assert_eq!(rev.pending.len(), 2);
        assert_eq!(rev.selected().unwrap().id, 7);
    }

    #[test]
    fn wake_review_release_skip_and_edit_flow() {
        let mut a = app_with_review_open();
        a.update(Event::WakeQueue {
            agent: "su-aaa".into(),
            result: Ok(vec![pending_wake(7, "tick"), pending_wake(9, "mail")]),
        });
        // j selects #9; r releases it as-is and goes busy.
        a.update(key('j', KeyModifiers::NONE));
        let act = a.update(key('r', KeyModifiers::NONE));
        assert_eq!(
            act,
            Action::WakeQueueAct {
                agent: "su-aaa".into(),
                release: true,
                id: 9,
                edited: None
            }
        );
        assert!(a.wake_review.as_ref().unwrap().busy);
        // Busy blocks a double-fire.
        assert_eq!(a.update(key('s', KeyModifiers::NONE)), Action::Render);
        // The refreshed list (released wake gone) clears busy + clamps sel.
        a.update(Event::WakeQueue {
            agent: "su-aaa".into(),
            result: Ok(vec![pending_wake(7, "tick")]),
        });
        let rev = a.wake_review.as_ref().unwrap();
        assert!(!rev.busy);
        assert_eq!(rev.pending.len(), 1);
        assert_eq!(rev.sel, 0);
        // e seeds the edit buffer with the staged content; typing + Enter
        // releases the EDITED text.
        a.update(key('e', KeyModifiers::NONE));
        assert_eq!(
            a.wake_review.as_ref().unwrap().edit.as_deref(),
            Some("tick")
        );
        a.update(key('!', KeyModifiers::NONE));
        let act = a.update(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert_eq!(
            act,
            Action::WakeQueueAct {
                agent: "su-aaa".into(),
                release: true,
                id: 7,
                edited: Some("tick!".into())
            }
        );
        // Empty queue + Esc closes the overlay.
        a.update(Event::WakeQueue {
            agent: "su-aaa".into(),
            result: Ok(vec![]),
        });
        a.update(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(a.wake_review.is_none());
    }

    #[test]
    fn wake_review_stale_guards_and_surfaces_errors() {
        let mut a = app_with_review_open();
        // A payload for ANOTHER agent never paints this overlay.
        a.update(Event::WakeQueue {
            agent: "su-zzz".into(),
            result: Ok(vec![pending_wake(1, "other")]),
        });
        assert!(a.wake_review.as_ref().unwrap().loading);
        assert!(a.wake_review.as_ref().unwrap().pending.is_empty());
        // An act/fetch error shows inline and clears busy/loading.
        a.update(Event::WakeQueue {
            agent: "su-aaa".into(),
            result: Err("boom".into()),
        });
        let rev = a.wake_review.as_ref().unwrap();
        assert!(!rev.loading && !rev.busy);
        assert_eq!(rev.error.as_deref(), Some("boom"));
    }

    // ─── The wake-pane board (EI-312) ───

    fn board_group(
        agent: &str,
        wakes: Vec<crate::models::PendingWake>,
    ) -> crate::models::WakeGroup {
        crate::models::WakeGroup {
            agent: agent.into(),
            label: agent.into(),
            kind: Some("queen".into()),
            wake_mode: Some("manual".into()),
            pending: wakes,
        }
    }

    fn app_on_wake_board() -> App {
        let mut a = App::new();
        a.tab = Tab::Wake;
        a.update(Event::WakeBoard {
            result: Ok((
                vec![
                    board_group(
                        "su-q",
                        vec![pending_wake(27, "boot storm"), pending_wake(53, "tick")],
                    ),
                    board_group("su-b", vec![pending_wake(60, "placement")]),
                ],
                Some("manual".into()),
            )),
        });
        a
    }

    #[test]
    fn wake_board_snapshot_paints_and_flat_selection_crosses_groups() {
        let mut a = app_on_wake_board();
        assert!(!a.wake_board.loading);
        assert_eq!(a.wake_board.total(), 3);
        assert_eq!(a.wake_board.global_mode.as_deref(), Some("manual"));
        // Flat j/j walks into the SECOND group's wake.
        a.update(key('j', KeyModifiers::NONE));
        a.update(key('j', KeyModifiers::NONE));
        let (g, pw) = a.wake_board.selected().expect("selected");
        assert_eq!(g.agent, "su-b");
        assert_eq!(pw.id, 60);
        // Clamped at the end.
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.wake_board.sel, 2);
    }

    #[test]
    fn wake_board_release_and_drain_verbs_fire_on_the_selected_agent() {
        let mut a = app_on_wake_board();
        // r releases the selected wake (the queen's first row).
        let act = a.update(key('r', KeyModifiers::NONE));
        assert_eq!(
            act,
            Action::WakeBoardAct {
                agent: "su-q".into(),
                verb: "release",
                id: Some(27),
                edited: None
            }
        );
        assert!(a.wake_board.busy);
        // Busy blocks a double-fire; the next snapshot clears it.
        assert_eq!(a.update(key('s', KeyModifiers::NONE)), Action::Render);
        a.update(Event::WakeBoard {
            result: Ok((
                vec![board_group("su-q", vec![pending_wake(53, "tick")])],
                None,
            )),
        });
        assert!(!a.wake_board.busy);
        // R drains the selected agent's WHOLE queue as one coalesced wake.
        let act = a.update(key('R', KeyModifiers::SHIFT));
        assert_eq!(
            act,
            Action::WakeBoardAct {
                agent: "su-q".into(),
                verb: "release_all",
                id: None,
                edited: None
            }
        );
        a.update(Event::WakeBoard {
            result: Ok((vec![], None)),
        });
        // S on an empty board is a no-op (nothing selected).
        assert_eq!(a.update(key('S', KeyModifiers::SHIFT)), Action::Render);
    }

    #[test]
    fn wake_board_edit_seeds_types_and_releases_edited() {
        let mut a = app_on_wake_board();
        a.update(key('e', KeyModifiers::NONE));
        assert_eq!(a.wake_board.edit.as_deref(), Some("boot storm"));
        a.update(key('!', KeyModifiers::NONE));
        let act = a.update(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert_eq!(
            act,
            Action::WakeBoardAct {
                agent: "su-q".into(),
                verb: "release",
                id: Some(27),
                edited: Some("boot storm!".into())
            }
        );
        assert!(a.wake_board.edit.is_none());
        // An act error lands inline and clears busy.
        a.update(Event::WakeBoard {
            result: Err("nope".into()),
        });
        assert!(!a.wake_board.busy);
        assert_eq!(a.wake_board.error.as_deref(), Some("nope"));
    }

    #[test]
    fn wake_board_w_toggles_the_selected_agents_mode_and_g_refreshes() {
        let mut a = app_on_wake_board();
        let act = a.update(key('w', KeyModifiers::NONE));
        assert_eq!(
            act,
            Action::SetWakeMode {
                agent: "su-q".into(),
                mode: "auto".into()
            }
        );
        assert_eq!(
            a.update(key('g', KeyModifiers::NONE)),
            Action::FetchWakeBoard
        );
    }

    #[test]
    fn filter_wake_groups_scopes_to_queen_or_owner() {
        let mk = |agent: &str, kind: Option<&str>| crate::models::WakeGroup {
            agent: agent.into(),
            label: agent.into(),
            kind: kind.map(str::to_string),
            wake_mode: Some("manual".into()),
            pending: vec![pending_wake(1, "x")],
        };
        let groups = || {
            vec![
                mk("su-q", Some("queen")),
                mk("su-b", Some("bee")),
                mk("su-gone", None),
            ]
        };
        let roster = vec![RosterEntry {
            owner_id: "su-q".into(),
            label: "the queen".into(),
            agent_pane_kind: Some("queen".into()),
            ..Default::default()
        }];

        // All → passthrough.
        assert_eq!(
            filter_wake_groups(groups(), &WakeFilter::All, &roster).len(),
            3
        );
        // Queen → resolved from the roster by pane-kind.
        let q = filter_wake_groups(groups(), &WakeFilter::Queen, &roster);
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].agent, "su-q");
        // Queen with NO roster queen → falls back to the group's own kind tag.
        let q2 = filter_wake_groups(groups(), &WakeFilter::Queen, &[]);
        assert_eq!(q2.len(), 1);
        assert_eq!(q2[0].agent, "su-q");
        // Owner → that agent only (including one the roster has dropped).
        let o = filter_wake_groups(groups(), &WakeFilter::Owner("su-gone".into()), &roster);
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].agent, "su-gone");
    }

    fn plan(slug: &str) -> PlanSummary {
        PlanSummary {
            slug: slug.into(),
            title: slug.into(),
            status: "todo".into(),
            updated: "2026-06-04".into(),
            owner: None,
            harness: None,
            archived: false,
            next_action: None,
            item_counts: Default::default(),
            open: None,
            done: None,
            priority: None,
        }
    }

    // ─── Voice mode PTT (voice-mode-tui-port-2026-06-05 P2) ───

    #[test]
    fn voice_v_starts_recording_on_operator_tab() {
        let mut a = App::new();
        a.tab = Tab::Operator; // (already the default, explicit for intent)
        assert_eq!(a.voice_phase, VoicePhase::Idle);
        let act = a.update(key('v', KeyModifiers::NONE));
        assert_eq!(act, Action::Voice(VoiceCmd::Start));
        assert_eq!(a.voice_phase, VoicePhase::Recording); // optimistic
    }

    #[test]
    fn voice_v_again_stops_recording_toggle() {
        let mut a = App::new();
        a.tab = Tab::Operator;
        a.update(key('v', KeyModifiers::NONE)); // start
        let act = a.update(key('v', KeyModifiers::NONE)); // toggle-stop
        assert_eq!(act, Action::Voice(VoiceCmd::Stop));
    }

    #[test]
    fn voice_key_release_stops_when_recording_hold_to_talk() {
        let mut a = App::new();
        a.tab = Tab::Operator;
        a.update(key('v', KeyModifiers::NONE)); // recording
        let release = Event::KeyRelease(KeyEvent::new(KeyCode::Char('v'), KeyModifiers::NONE));
        assert_eq!(a.update(release), Action::Voice(VoiceCmd::Stop));
        // A release while idle is a no-op (Action::None).
        let mut b = App::new();
        b.tab = Tab::Operator;
        let rel = Event::KeyRelease(KeyEvent::new(KeyCode::Char('v'), KeyModifiers::NONE));
        assert_eq!(b.update(rel), Action::None);
    }

    // ─── Voice TAB channel hold-to-talk (holepunch-voice-channels P-009) ───

    fn voice_tab_in_channel() -> App {
        use crate::voice_stream::{VoiceChannelInfo, VoiceEvent, VoiceStatus};
        use crate::voice_ui::VoiceUiEvent as VE;
        let mut a = App::new();
        a.tab = Tab::Voice;
        a.voice_ui.connected = true;
        a.update(Event::VoiceUi(VE::Stream(VoiceEvent::Status(
            VoiceStatus {
                channel: Some(VoiceChannelInfo {
                    id: "vc-1".into(),
                    name: "standup".into(),
                }),
                muted: false,
                peers: vec![],
                agent_speaking: false,
            },
        ))));
        a
    }

    #[test]
    fn voice_tab_hold_to_talk_press_then_release() {
        use crate::voice_ui::{VoiceCmd as VC, VoiceUiEvent as VE};
        let mut a = voice_tab_in_channel();
        // Press the PTT key → start transmit into the channel.
        assert_eq!(
            a.update(key('v', KeyModifiers::NONE)),
            Action::VoiceChan(VC::MicOn)
        );
        a.update(Event::VoiceUi(VE::MicState(true)));
        // Releasing the PTT key → stop transmit (kitty hold-to-talk).
        let release = Event::KeyRelease(KeyEvent::new(KeyCode::Char('v'), KeyModifiers::NONE));
        assert_eq!(a.update(release), Action::VoiceChan(VC::MicOff));
    }

    #[test]
    fn voice_tab_swallows_ptt_autorepeat_but_not_press() {
        use crate::voice_ui::{VoiceCmd as VC, VoiceUiEvent as VE};
        let mut a = voice_tab_in_channel();
        // Auto-repeat of the PTT key while held is swallowed — a held key must
        // not flap the transmit toggle.
        let repeat = Event::Key(KeyEvent::new_with_kind(
            KeyCode::Char('v'),
            KeyModifiers::NONE,
            crossterm::event::KeyEventKind::Repeat,
        ));
        assert_eq!(a.update(repeat), Action::None);
        // A genuine Press still toggles transmit (the guard is repeat-specific).
        assert_eq!(
            a.update(key('v', KeyModifiers::NONE)),
            Action::VoiceChan(VC::MicOn)
        );
        a.update(Event::VoiceUi(VE::MicState(true)));
        // And a repeat after transmit started is likewise swallowed (no MicOff).
        let repeat2 = Event::Key(KeyEvent::new_with_kind(
            KeyCode::Char('v'),
            KeyModifiers::NONE,
            crossterm::event::KeyEventKind::Repeat,
        ));
        assert_eq!(a.update(repeat2), Action::None);
    }

    #[test]
    fn voice_esc_cancels_recording() {
        let mut a = App::new();
        a.tab = Tab::Operator;
        a.update(key('v', KeyModifiers::NONE)); // recording
        let act = a.update(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        assert_eq!(act, Action::Voice(VoiceCmd::Cancel));
        assert_eq!(a.voice_phase, VoicePhase::Idle);
    }

    #[test]
    fn voice_v_ignored_off_operator_tab_and_while_composing() {
        let mut a = App::new();
        a.tab = Tab::Plans;
        // On a non-Operator tab `v` is not a voice key (no Start).
        assert_ne!(
            a.update(key('v', KeyModifiers::NONE)),
            Action::Voice(VoiceCmd::Start)
        );
        assert_eq!(a.voice_phase, VoicePhase::Idle);
        // While composing, `v` types into the message, never starts voice.
        let mut b = App::new();
        b.tab = Tab::Operator;
        b.chat_composing = true;
        b.update(key('v', KeyModifiers::NONE));
        assert_eq!(b.voice_phase, VoicePhase::Idle);
        assert_eq!(b.chat_input, "v");
    }

    #[test]
    fn voice_v_ignored_mid_pipeline() {
        let mut a = App::new();
        a.tab = Tab::Operator;
        a.voice_phase = VoicePhase::Thinking; // a turn is converse-streaming
        assert_eq!(a.update(key('v', KeyModifiers::NONE)), Action::None);
        assert_eq!(a.voice_phase, VoicePhase::Thinking);
    }

    #[test]
    fn voice_transcribed_injects_user_turn_and_thinks() {
        let mut a = App::new();
        a.tab = Tab::Operator;
        let before = a.chat_messages.len();
        a.update(Event::Voice(crate::event::VoiceMsg::Transcribed(
            "hello there".into(),
        )));
        assert_eq!(a.voice_phase, VoicePhase::Thinking);
        // begin_user_send added the user msg + a streaming assistant bubble.
        assert_eq!(a.chat_messages.len(), before + 2);
        assert_eq!(a.chat_messages[before].content, "hello there");
        assert!(a.chat_streaming);
    }

    #[test]
    fn voice_lifecycle_phases_and_errors_reset() {
        let mut a = App::new();
        a.tab = Tab::Operator;
        a.update(Event::Voice(crate::event::VoiceMsg::Started(Ok(()))));
        assert_eq!(a.voice_phase, VoicePhase::Recording);
        a.update(Event::Voice(crate::event::VoiceMsg::Speaking));
        assert_eq!(a.voice_phase, VoicePhase::Speaking);
        a.update(Event::Voice(crate::event::VoiceMsg::Finished));
        assert_eq!(a.voice_phase, VoicePhase::Idle);
        // An open failure resets + records the error.
        a.update(Event::Voice(crate::event::VoiceMsg::Started(Err(
            "no mic".into()
        ))));
        assert_eq!(a.voice_phase, VoicePhase::Idle);
        assert_eq!(a.voice_error.as_deref(), Some("no mic"));
    }

    #[test]
    fn voice_level_only_tracks_while_recording() {
        let mut a = App::new();
        a.set_voice_level(0.5);
        assert_eq!(a.voice_level, 0.0); // ignored when idle
        a.voice_phase = VoicePhase::Recording;
        a.set_voice_level(0.5);
        assert_eq!(a.voice_level, 0.5);
    }

    #[test]
    fn q_and_ctrl_c_quit() {
        let mut a = App::new();
        assert_eq!(a.update(key('q', KeyModifiers::NONE)), Action::Quit);
        assert!(a.should_quit);
        let mut b = App::new();
        assert_eq!(b.update(key('c', KeyModifiers::CONTROL)), Action::Quit);
        assert!(b.should_quit);
    }

    #[test]
    fn c_switches_to_cupboard_and_lazy_loads() {
        // `c` is the Cupboard tab switch key (D-011) — switching to it while
        // empty triggers the lazy listings fetch.
        let mut a = App::new();
        let act = a.update(key('c', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Cupboard);
        assert!(matches!(act, Action::FetchCupboard { .. }));
        assert!(!a.should_quit);
    }

    #[test]
    fn number_keys_switch_tabs() {
        // Digit keys follow Tab::switch_key (D-002 reorder): 1 Operator, 2 Inbox,
        // 3 Plans, 4 Fleet, 5 Pots (Harnesses).
        let mut a = App::new();
        assert_eq!(a.update(key('2', KeyModifiers::NONE)), Action::Render);
        assert_eq!(a.tab, Tab::Inbox);
        a.update(key('3', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Plans);
        a.update(key('4', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Fleet);
        a.update(key('5', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Harnesses);
        a.update(key('1', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Operator);
    }

    #[test]
    fn jk_navigates_and_clamps() {
        let mut a = App::new();
        a.update(key('3', KeyModifiers::NONE)); // leave the default Operator tab → Plans
        a.set_plans(vec![plan("a"), plan("b"), plan("c")]);
        // Two-level nav (owner ask 2026-06-16): Enter drills into the plans-list
        // pane, then j/k move the selection (clamped). Browsing j/k switch panes.
        a.update(ev(KeyCode::Enter)); // → inside the list pane
        assert_eq!(a.plan_sel, 0);
        a.update(key('k', KeyModifiers::NONE)); // up at top → stays 0
        assert_eq!(a.plan_sel, 0);
        a.update(key('j', KeyModifiers::NONE));
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.plan_sel, 2);
        a.update(key('j', KeyModifiers::NONE)); // down at bottom → stays 2
        assert_eq!(a.plan_sel, 2);
    }

    #[test]
    fn set_plans_clamps_stale_selection() {
        let mut a = App::new();
        a.set_plans(vec![plan("a"), plan("b"), plan("c")]);
        a.plan_sel = 2;
        a.set_plans(vec![plan("a")]); // shrank
        assert_eq!(a.plan_sel, 0);
        assert_eq!(a.selected_plan().unwrap().slug, "a");
    }

    #[test]
    fn error_event_sets_status_and_renders() {
        let mut a = App::new();
        assert_eq!(a.update(Event::Error("boom".into())), Action::Render);
        assert_eq!(a.last_error.as_deref(), Some("boom"));
    }

    #[test]
    fn inbox_tab_navigates_its_own_list() {
        use crate::models::AttentionItem;
        let item = |id: &str| AttentionItem {
            id: id.into(),
            kind: "plan-item".into(),
            source: "plan".into(),
            harness_slug: None,
            plan_slug: Some("p".into()),
            item_ref: Some("P-001".into()),
            title: id.into(),
            body: None,
            status: "todo".into(),
            importance: None,
            needs_human: false,
            tier: None,
            owner_agent_id: None,
            owner_label: None,
            triage_state: None,
            triage_note: None,
            report: None,
        };
        let mut a = App::new();
        a.update(key('2', KeyModifiers::NONE)); // Inbox tab
        assert_eq!(a.tab, Tab::Inbox);
        a.set_inbox(vec![item("x"), item("y")]);
        assert_eq!(a.inbox_sel, 0);
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.inbox_sel, 1);
        assert_eq!(a.selected_inbox().unwrap().id, "y");
        a.update(key('j', KeyModifiers::NONE)); // clamp at bottom
        assert_eq!(a.inbox_sel, 1);
    }

    fn roster_entry(agent: &str) -> RosterEntry {
        RosterEntry {
            owner_id: "su-1".into(),
            label: "su · su-1".into(),
            intent: None,
            current_files: vec![],
            liveness: "live".into(),
            stale: false,
            agent: Some(agent.into()),
            role: None,
            feature: None,
            current_plan_slug: None,
            heartbeat_at: None,
            ..Default::default()
        }
    }

    #[test]
    fn launch_spec_uses_selected_agent_else_default() {
        let a = App::new(); // empty roster → default
        assert!(a.launch_spec().argv.contains(&"--agent=claude".to_string()));
        let mut b = App::new();
        b.set_roster(vec![roster_entry("codex")]);
        assert!(b.launch_spec().argv.contains(&"--agent=codex".to_string()));
    }

    // ── Enter-route hints + always-visible Enter feedback (owner ask 2026-06-11) ──

    /// Dead session WITH an adv launch record → Enter resumes, and the row
    /// says so beforehand.
    #[test]
    fn enter_hint_resume_for_dead_recorded_session() {
        let a = App::new();
        let mut e = roster_entry("claude");
        e.stale = true;
        e.liveness = "stale".into();
        e.adv_session_id = Some(1054);
        assert_eq!(a.enter_hint(&e), "⏎ resume");
    }

    /// Dead session WITHOUT an adv launch record (the "Enter did nothing"
    /// class) → the hint says menu before the keypress.
    #[test]
    fn enter_hint_menu_for_dead_unrecorded_session() {
        let a = App::new();
        let mut e = roster_entry("claude");
        e.stale = true;
        e.liveness = "stale".into();
        e.adv_session_id = None;
        assert_eq!(a.enter_hint(&e), "⏎ menu");
    }

    /// Live agent with a same-host pid → Enter focuses its window.
    #[test]
    fn enter_hint_window_for_live_same_host_pid() {
        let a = App::new();
        let mut e = roster_entry("claude");
        e.pid = Some(4242);
        assert_eq!(a.enter_hint(&e), "⏎ window");
    }

    /// Live but unreachable (no pane, no window handle) → menu.
    #[test]
    fn enter_hint_menu_for_live_unreachable() {
        let a = App::new();
        let mut e = roster_entry("claude");
        e.host = "some-other-host".into();
        assert_eq!(a.enter_hint(&e), "⏎ menu");
    }

    /// Enter on a resumable row launches AND toasts — a failed/slow launch is
    /// no longer indistinguishable from a dead key.
    #[test]
    fn fleet_enter_resume_toasts_and_launches() {
        let mut a = App::new();
        let mut e = roster_entry("claude");
        e.stale = true;
        e.liveness = "stale".into();
        e.adv_session_id = Some(1054);
        a.set_roster(vec![e]);
        let act = a.fleet_enter();
        match act {
            Action::Launch(spec) => {
                assert!(spec.argv.contains(&"--resume".to_string()));
                assert!(spec.argv.contains(&"1054".to_string()));
            }
            other => panic!("expected Launch, got {other:?}"),
        }
        let toast = a.toast.expect("Enter must raise an immediate toast");
        assert!(toast.message.contains("resuming"), "got: {}", toast.message);
        assert!(toast.message.contains("--resume"), "got: {}", toast.message);
    }

    /// Enter on a dead, unrecorded row opens the modal menu (the visible
    /// feedback for that route) instead of silently rendering.
    #[test]
    fn fleet_enter_unresumable_opens_menu() {
        let mut a = App::new();
        let mut e = roster_entry("claude");
        e.stale = true;
        e.liveness = "stale".into();
        a.set_roster(vec![e]);
        let _ = a.fleet_enter();
        let menu = a.fleet_action_menu.expect("menu must open");
        assert!(!menu.can_resume, "no adv record → resume not offered");
    }

    // ── Swarm pane → bee-dossier selection relay (pui-bee-dossier-pane-2026-06-06) ──

    fn bee_roster_entry(owner: &str, agent: &str) -> RosterEntry {
        RosterEntry {
            owner_id: owner.into(),
            label: format!("su · {owner}"),
            liveness: "live".into(),
            agent: Some(agent.into()),
            ..Default::default()
        }
    }

    #[test]
    fn fleet_cursor_move_publishes_bee_selection() {
        let mut a = App::new();
        a.switch_to(Tab::Fleet);
        a.set_roster(vec![
            bee_roster_entry("su-aaa", "claude"),
            bee_roster_entry("su-bbb", "codex"),
        ]);
        a.fleet.agent_sel = 0;
        a.fleet.entered = true; // inside the roster pane → ↑/↓ move its cursor
                                // j moves to the second bee and publishes IT.
        match a.update(key('j', KeyModifiers::NONE)) {
            Action::PublishBeeSelection { owner_id, name } => {
                assert_eq!(owner_id.as_deref(), Some("su-bbb"));
                assert_eq!(name.as_deref(), Some("codex"));
            }
            other => panic!("expected PublishBeeSelection, got {other:?}"),
        }
        // k moves back to the first bee and publishes it.
        match a.update(key('k', KeyModifiers::NONE)) {
            Action::PublishBeeSelection { owner_id, .. } => {
                assert_eq!(owner_id.as_deref(), Some("su-aaa"));
            }
            other => panic!("expected PublishBeeSelection, got {other:?}"),
        }
    }

    #[test]
    fn cursor_move_off_fleet_does_not_publish_bee_selection() {
        // A roster move on a non-Fleet tab is an ordinary Render, never a publish.
        let mut a = App::new();
        a.switch_to(Tab::Plans);
        assert_eq!(a.update(key('j', KeyModifiers::NONE)), Action::Render);
    }

    #[test]
    fn bee_selection_event_updates_state_and_clears_stale_dossier() {
        let mut a = App::new();
        a.update(Event::BeeSelection {
            owner_id: Some("su-x".into()),
            name: Some("forager".into()),
        });
        assert_eq!(a.bee.owner_id.as_deref(), Some("su-x"));
        // A dossier for the selected bee lands; a new selection clears it.
        a.update(Event::BeeDossier {
            owner_id: "su-x".into(),
            assignment: Some(crate::models::BeeAssignment::default()),
            mail: None,
        });
        assert!(a.bee.assignment.is_some());
        a.update(Event::BeeSelection {
            owner_id: Some("su-y".into()),
            name: None,
        });
        assert!(
            a.bee.assignment.is_none(),
            "stale dossier cleared on new selection"
        );
    }

    #[test]
    fn switching_to_fleet_fetches_whole_fleet_assignments() {
        // Entering the Fleet tab refreshes the whole-fleet task list — the
        // default dossier (pui-dock-consolidation-2026-06-07 #2).
        let mut a = App::new();
        assert_eq!(
            a.update(key('4', KeyModifiers::NONE)),
            Action::FetchFleetAssignments
        );
        assert_eq!(a.tab, Tab::Fleet);
        // The payload lands in fleet.all_assignments via the reducer.
        a.update(Event::FleetAssignments(vec![
            crate::models::BeeAssignment::default(),
        ]));
        assert_eq!(a.fleet.all_assignments.len(), 1);
    }

    #[test]
    fn fleet_comms_toggle_on_c_lazy_loads_conversations() {
        // 'c' on the Fleet tab swaps in the comms sub-view (#3/#4); the first
        // open lazy-loads the whole-fleet conversations list it renders.
        let mut a = App::new();
        a.switch_to(Tab::Fleet);
        let act = a.update(key('c', KeyModifiers::NONE));
        assert!(a.fleet.show_comms);
        assert!(matches!(act, Action::FetchConversations { .. }));
        assert!(a.conversations_loading);
        // Toggling back off is a plain render — no refetch.
        assert_eq!(a.update(key('c', KeyModifiers::NONE)), Action::Render);
        assert!(!a.fleet.show_comms);
    }

    #[test]
    fn esc_on_fleet_clears_agent_filter() {
        // Esc with an agent selected publishes the CLEARED selection — back to
        // the whole-fleet dossier/plan view (#2).
        let mut a = App::new();
        a.switch_to(Tab::Fleet);
        a.update(Event::BeeSelection {
            owner_id: Some("su-x".into()),
            name: Some("forager".into()),
        });
        match a.update(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))) {
            Action::PublishBeeSelection { owner_id, name } => {
                assert!(owner_id.is_none());
                assert!(name.is_none());
            }
            other => panic!("expected PublishBeeSelection(None), got {other:?}"),
        }
        // With no selection, Esc falls through to the toast-dismiss render.
        a.update(Event::BeeSelection {
            owner_id: None,
            name: None,
        });
        assert_eq!(
            a.update(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))),
            Action::Render
        );
    }

    #[test]
    fn lexicon_pack_event_routes_tab_labels() {
        use crate::models::{LexiconPackPayload, TermForms};
        use std::collections::HashMap;
        let mut a = App::new();
        // Default = classic identity labels via the lexicon fallback.
        assert_eq!(Tab::Fleet.label(&a.lexicon), "Fleet");
        let mut terms = HashMap::new();
        terms.insert(
            "fleet".to_string(),
            TermForms {
                one: "Swarm".into(),
                other: "Swarms".into(),
            },
        );
        a.update(Event::LexiconPack(LexiconPackPayload {
            pack_id: "the-hive".into(),
            label: "The Hive".into(),
            terms,
        }));
        assert_eq!(Tab::Fleet.label(&a.lexicon), "Swarm");
        // title() (the stable identity) is unchanged — persistence/state safe.
        assert_eq!(Tab::Fleet.title(), "Fleet");
    }

    // ── Enter-by-location routing (pui-workbench-usability D-001/D-002) ──

    /// A live roster agent with an external-window handle (window id / same-host
    /// pid) and no matching local pane.
    fn live_windowed_entry(agent: &str) -> RosterEntry {
        RosterEntry {
            owner_id: "su-w".into(),
            label: format!("su · {agent}-w"),
            liveness: "live".into(),
            stale: false,
            agent: Some(agent.into()),
            pid: Some(4242),
            pid_alive: Some(true),
            window_id: Some("0x0123abcd".into()),
            adv_session_id: Some(7),
            has_launch_record: true,
            mode: Some("console".into()),
            cwd: Some("/repo".into()),
            ..Default::default()
        }
    }

    /// An ended/dead session that still carries a resume handle.
    fn ended_resumable_entry(agent: &str) -> RosterEntry {
        RosterEntry {
            owner_id: "su-e".into(),
            label: format!("su · {agent}-e"),
            liveness: "stale".into(),
            stale: true,
            agent: Some(agent.into()),
            adv_session_id: Some(42),
            has_launch_record: true,
            cwd: Some("/repo".into()),
            ..Default::default()
        }
    }

    #[test]
    fn roster_entry_liveness_and_handle_helpers() {
        // A fresh heartbeat over a DEAD process (zombie) is not live (D-001
        // "check liveness first" — must not focus, should resume).
        let zombie = RosterEntry {
            liveness: "live".into(),
            stale: false,
            pid_alive: Some(false),
            ..Default::default()
        };
        assert!(!zombie.is_live());
        // A genuinely live entry.
        assert!(live_windowed_entry("claude").is_live());
        // Resumability needs both an adv id and a known agent.
        assert!(ended_resumable_entry("claude").is_resumable());
        assert!(!RosterEntry {
            agent: Some("claude".into()),
            ..Default::default()
        }
        .is_resumable());
        // Window handle: an explicit window id always counts; a bare same-host
        // pid counts; nothing → false.
        assert!(live_windowed_entry("claude").has_window_handle("any-host"));
        assert!(RosterEntry {
            pid: Some(9),
            host: "h1".into(),
            ..Default::default()
        }
        .has_window_handle("h1"));
        assert!(!RosterEntry::default().has_window_handle("h1"));
        // A cross-host pid with no window id can't be focused locally.
        assert!(!RosterEntry {
            pid: Some(9),
            host: "other".into(),
            ..Default::default()
        }
        .has_window_handle("h1"));
    }

    #[test]
    fn route_local_pane_wins_when_topology_matches() {
        use pui_companion_proto::{PaneNode, TabNode, Topology};
        let mut a = App::new();
        a.companion_version = Some("0.1.0".into());
        a.topology = Some(Topology {
            tabs: vec![TabNode {
                pos: 0,
                name: "papercup".into(),
                active: true,
                swap_layout: None,
                swap_dirty: false,
            }],
            panes: vec![PaneNode {
                id: 5,
                tab: 0,
                title: "claude · F-9".into(),
                focused: false,
                is_plugin: false,
                exited: false,
                command: Some("psu".into()),
            }],
        });
        // Live + windowed, but a local pane matches the entry's feature → local
        // pane wins (it's right here in the workbench).
        let entry = RosterEntry {
            feature: Some("F-9".into()),
            ..live_windowed_entry("claude")
        };
        assert_eq!(
            a.resolve_agent_route(&entry),
            AgentRoute::LocalPane { pane_id: 5 }
        );
    }

    #[test]
    fn route_focus_window_when_live_and_windowed() {
        let a = App::new(); // no topology → no local pane
        match a.resolve_agent_route(&live_windowed_entry("claude")) {
            AgentRoute::FocusWindow {
                adv_session_id,
                window_id,
                ..
            } => {
                assert_eq!(adv_session_id, Some(7));
                assert_eq!(window_id.as_deref(), Some("0x0123abcd"));
            }
            other => panic!("expected FocusWindow, got {other:?}"),
        }
    }

    #[test]
    fn route_menu_when_live_but_unreachable() {
        let a = App::new();
        // Live, but no window id and no pid → can't reach it from here.
        let entry = RosterEntry {
            owner_id: "su-r".into(),
            label: "su · remote".into(),
            liveness: "live".into(),
            stale: false,
            agent: Some("claude".into()),
            adv_session_id: Some(3),
            has_launch_record: true,
            ..Default::default()
        };
        match a.resolve_agent_route(&entry) {
            AgentRoute::Menu(m) => {
                // A live session must NOT offer resume (it'd double-spawn — D-001).
                assert!(!m.can_resume);
                assert!(!m.can_focus_window);
            }
            other => panic!("expected Menu, got {other:?}"),
        }
    }

    #[test]
    fn route_resume_when_ended_and_resumable() {
        let a = App::new();
        match a.resolve_agent_route(&ended_resumable_entry("claude")) {
            AgentRoute::Resume { spec } => {
                assert_eq!(spec.argv, vec!["psu", "--resume", "42"]);
                assert_eq!(spec.cwd.as_deref(), Some("/repo"));
            }
            other => panic!("expected Resume, got {other:?}"),
        }
    }

    #[test]
    fn route_menu_when_dead_and_not_resumable() {
        let a = App::new();
        let entry = RosterEntry {
            label: "su · ghost".into(),
            liveness: "stale".into(),
            stale: true,
            agent: Some("claude".into()),
            ..Default::default() // no adv_session_id → not resumable
        };
        match a.resolve_agent_route(&entry) {
            AgentRoute::Menu(m) => assert!(!m.can_resume),
            other => panic!("expected Menu, got {other:?}"),
        }
    }

    #[test]
    fn enter_on_fleet_focus_window_action() {
        let mut a = App::new();
        a.tab = Tab::Fleet;
        a.set_roster(vec![live_windowed_entry("claude")]);
        a.fleet.entered = true; // inside the roster → Enter reaches the agent
        match a.on_key(KeyCode::Enter, KeyModifiers::empty()) {
            Action::FocusWindow { window_id, .. } => {
                assert_eq!(window_id.as_deref(), Some("0x0123abcd"))
            }
            other => panic!("expected FocusWindow, got {other:?}"),
        }
        // No menu opened — it acted on the unambiguous route.
        assert!(a.fleet_action_menu.is_none());
    }

    #[test]
    fn enter_on_fleet_resume_launches() {
        let mut a = App::new();
        a.tab = Tab::Fleet;
        a.set_roster(vec![ended_resumable_entry("codex")]);
        a.fleet.entered = true; // inside the roster → Enter resumes the agent
        match a.on_key(KeyCode::Enter, KeyModifiers::empty()) {
            Action::Launch(spec) => {
                assert!(spec.argv.iter().any(|x| x == "--resume"));
                assert!(spec.argv.iter().any(|x| x == "42"));
            }
            other => panic!("expected Launch(resume), got {other:?}"),
        }
        // The resume was recorded into the crew roster.
        assert_eq!(a.launched.len(), 1);
    }

    #[test]
    fn enter_on_fleet_opens_menu_then_n_launches() {
        let mut a = App::new();
        a.tab = Tab::Fleet;
        // Live but unreachable → Enter opens the menu (D-002), not a silent no-op.
        let entry = RosterEntry {
            label: "su · remote".into(),
            liveness: "live".into(),
            stale: false,
            agent: Some("claude".into()),
            ..Default::default()
        };
        a.set_roster(vec![entry]);
        a.fleet.entered = true; // inside the roster → Enter acts on the agent
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::Render
        );
        assert!(a.fleet_action_menu.is_some());
        // `n` in the menu launches a fresh agent and closes the menu.
        match a.on_key(KeyCode::Char('n'), KeyModifiers::empty()) {
            Action::Launch(spec) => assert_eq!(spec.argv[0], "psu"),
            other => panic!("expected Launch, got {other:?}"),
        }
        assert!(a.fleet_action_menu.is_none());
    }

    #[test]
    fn fleet_menu_f_focuses_and_esc_closes() {
        let mut a = App::new();
        a.tab = Tab::Fleet;
        // A dead-but-windowed session: not resumable here lacks an id, but it has
        // a window handle → the menu offers [f].
        let entry = RosterEntry {
            label: "su · win".into(),
            liveness: "stale".into(),
            stale: true,
            agent: Some("claude".into()),
            window_id: Some("0xdead".into()),
            ..Default::default()
        };
        a.set_roster(vec![entry]);
        a.fleet.entered = true; // inside the roster → Enter acts on the agent
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::Render
        );
        let menu = a.fleet_action_menu.clone().expect("menu open");
        assert!(menu.can_focus_window);
        match a.on_key(KeyCode::Char('f'), KeyModifiers::empty()) {
            Action::FocusWindow { window_id, .. } => {
                assert_eq!(window_id.as_deref(), Some("0xdead"))
            }
            other => panic!("expected FocusWindow, got {other:?}"),
        }
        assert!(a.fleet_action_menu.is_none());
        // Re-open and Esc closes without acting.
        a.on_key(KeyCode::Enter, KeyModifiers::empty());
        assert!(a.fleet_action_menu.is_some());
        assert_eq!(
            a.on_key(KeyCode::Esc, KeyModifiers::empty()),
            Action::Render
        );
        assert!(a.fleet_action_menu.is_none());
    }

    #[test]
    fn enter_on_empty_fleet_roster_is_noop_render() {
        let mut a = App::new();
        a.tab = Tab::Fleet; // empty roster
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::Render
        );
        assert!(a.fleet_action_menu.is_none());
    }

    #[test]
    fn n_launches_on_brew_only() {
        // The agent launcher folded from Sessions into Fleet (D-002b): `n` only
        // launches on the Fleet tab.
        let mut a = App::new();
        a.update(key('3', KeyModifiers::NONE)); // Plans tab
        assert_eq!(a.update(key('n', KeyModifiers::NONE)), Action::None);
        a.update(key('4', KeyModifiers::NONE)); // Fleet
        match a.update(key('n', KeyModifiers::NONE)) {
            Action::Launch(spec) => assert_eq!(spec.argv[0], "psu"),
            other => panic!("expected Launch, got {other:?}"),
        }
    }

    #[test]
    fn help_toggles_and_any_key_dismisses() {
        let mut a = App::new();
        assert_eq!(a.update(key('?', KeyModifiers::NONE)), Action::Render);
        assert!(a.show_help);
        a.update(key('j', KeyModifiers::NONE)); // any key closes help
        assert!(!a.show_help);
    }

    #[test]
    fn palette_captures_input_until_esc() {
        let mut a = App::new();
        a.update(key(':', KeyModifiers::NONE));
        assert!(a.palette_open);
        a.update(key('h', KeyModifiers::NONE));
        a.update(key('i', KeyModifiers::NONE));
        assert_eq!(a.palette_input, "hi");
        a.update(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(!a.palette_open);
        assert_eq!(a.palette_input, "");
        a.update(key('2', KeyModifiers::NONE)); // tab keys work again
        assert_eq!(a.tab, Tab::Inbox);
    }

    #[test]
    fn harnesses_tab_navigates_features() {
        use crate::models::HarnessFeature;
        let f = |id: &str| HarnessFeature {
            id: id.into(),
            title: id.into(),
            status: "todo".into(),
            attempts: 0,
        };
        let mut a = App::new();
        assert_eq!(a.update(key('5', KeyModifiers::NONE)), Action::Render);
        assert_eq!(a.tab, Tab::Harnesses);
        a.set_features(vec![f("F-1"), f("F-2")]);
        a.pane_entered = true; // inside the features pane → ↑/↓ move its cursor
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.feat_sel, 1);
        assert_eq!(a.features[a.feat_sel].id, "F-2");
    }

    #[test]
    fn harness_cycle_and_git_spec() {
        use crate::models::HarnessRef;
        let mut a = App::new();
        assert!(!a.cycle_harness(1)); // empty → no-op
        a.set_harnesses(vec![
            HarnessRef {
                slug: "papercup".into(),
                path: Some("/r/papercup".into()),
            },
            HarnessRef {
                slug: "restart".into(),
                path: Some("/r/restart".into()),
            },
        ]);
        assert_eq!(a.harness, "papercup");
        assert!(a.cycle_harness(1));
        assert_eq!(a.harness, "restart");
        assert_eq!(*a.active_harness.lock().unwrap(), "restart"); // shared cell follows
        assert_eq!(a.git_spec().argv, vec!["lazygit", "-p", "/r/restart"]);
        assert!(a.cycle_harness(1)); // wraps
        assert_eq!(a.harness, "papercup");
    }

    #[test]
    fn docs_tab_navigates_and_publishes_selection() {
        use crate::models::DocsResponse;
        let mut a = App::new();
        a.update(key('6', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Docs);
        a.set_docs(DocsResponse {
            files: vec!["a.md".into(), "sub/b.md".into()],
            active_path: Some("a.md".into()),
            content: Some("# A".into()),
            entries: vec![],
            active_entry: None,
        });
        assert_eq!(a.doc_sel, 0); // followed the server's active path
        assert_eq!(a.doc_content, "# A");
        a.update(key('j', KeyModifiers::NONE)); // select sub/b.md + publish
        assert_eq!(a.doc_sel, 1);
        assert_eq!(*a.active_doc.lock().unwrap(), Some("sub/b.md".to_string()));
    }

    #[test]
    fn testing_and_config_tabs_switch_and_nav() {
        use crate::models::TestingDomain;
        let mut a = App::new();
        assert_eq!(a.update(key('7', KeyModifiers::NONE)), Action::Render);
        assert_eq!(a.tab, Tab::Testing);
        a.set_testing(vec![
            TestingDomain {
                id: "unit".into(),
                label: "Unit".into(),
                description: "d".into(),
                tier: "universal".into(),
            },
            TestingDomain {
                id: "e2e".into(),
                label: "E2E".into(),
                description: "d".into(),
                tier: "project".into(),
            },
        ]);
        a.pane_entered = true; // inside the domains pane → ↑/↓ move its cursor
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.testing_sel, 1);
        assert_eq!(a.update(key('8', KeyModifiers::NONE)), Action::Render);
        assert_eq!(a.tab, Tab::Config);
        a.set_config(EffectiveClaudeSettings {
            content: "{\"model\":\"opus\"}".into(),
            effective: json!({ "model": "opus" }),
            file_keys: vec!["model".into()],
            parse_error: None,
        });
        assert_eq!(a.config.content, "{\"model\":\"opus\"}");
        assert_eq!(a.config.effective["model"], "opus");
        // Config has no list; j/k is a no-op there.
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Config);
    }

    fn pane(label: &str, plugin: &str, cwd: &str, cmd: &[&str]) -> TuiPaneContribution {
        TuiPaneContribution {
            plugin_name: plugin.into(),
            slug: "papercup".into(),
            label: label.into(),
            icon: None,
            command: cmd.iter().map(|s| s.to_string()).collect(),
            cwd: cwd.into(),
        }
    }

    #[test]
    fn plugins_tab_navigates_and_enter_launches_selected_pane() {
        let mut a = App::new();
        // `9` switches to the Plugins tab.
        assert_eq!(a.update(key('9', KeyModifiers::NONE)), Action::Render);
        assert_eq!(a.tab, Tab::Plugins);
        // The tab defaults to the List sub-view (D-007); Tab toggles to the
        // panes launcher this test exercises.
        assert_eq!(a.plugins_focus, PluginsFocus::List);
        a.update(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
        assert_eq!(a.plugins_focus, PluginsFocus::Panes);
        // Enter with no panes is a no-op.
        assert_eq!(
            a.update(Event::Key(KeyEvent::new(
                KeyCode::Enter,
                KeyModifiers::NONE
            ))),
            Action::None
        );
        a.set_panes(vec![
            pane("Logs", "logs-plugin", "/repo/papercup", &["sh", "tail.sh"]),
            pane("Watch", "watch-plugin", "/tmp", &["watch", "ls"]),
        ]);
        assert_eq!(a.pane_sel, 0);
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.pane_sel, 1);
        assert_eq!(a.selected_pane().unwrap().label, "Watch");
        // Enter launches the selected pane: command → argv, cwd set, titled.
        match a.update(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        ))) {
            Action::Launch(spec) => {
                assert_eq!(spec.argv, vec!["watch", "ls"]);
                assert_eq!(spec.cwd.as_deref(), Some("/tmp"));
                assert_eq!(spec.title.as_deref(), Some("watch-plugin · papercup"));
            }
            other => panic!("expected Launch, got {other:?}"),
        }
    }

    #[test]
    fn enter_on_plans_tab_does_not_launch_plugin() {
        let mut a = App::new();
        a.update(key('3', KeyModifiers::NONE)); // leave the default Operator tab → Plans
        a.set_panes(vec![pane("Logs", "p", "/r", &["sh"])]);
        // On the Plans tab, Enter never launches a plugin pane (that's Plugins-tab
        // only). The first Enter just DRILLS into the focused pane (two-level nav,
        // owner ask 2026-06-16); the detail popup only opens on a SECOND Enter and
        // only when there's a row to describe (none here) — so it stays closed.
        let act = a.update(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert!(
            !matches!(act, Action::Launch(_)),
            "Enter must not launch on Plans: {act:?}"
        );
        assert!(!a.fleet_detail_open, "first Enter drills in, no popup yet");
    }

    #[test]
    fn plugin_launch_spec_skips_cwd_when_empty_and_handles_empty_command() {
        let mut a = App::new();
        a.set_panes(vec![pane("No cwd", "p", "", &["render"])]);
        let spec = a.plugin_launch_spec().expect("a spec");
        assert_eq!(spec.argv, vec!["render"]);
        assert_eq!(spec.cwd, None); // empty cwd → not threaded
                                    // An empty command yields no launchable spec.
        a.set_panes(vec![pane("Broken", "p", "/r", &[])]);
        assert!(a.plugin_launch_spec().is_none());
    }

    #[test]
    fn g_launches_git() {
        let mut a = App::new();
        match a.update(key('g', KeyModifiers::NONE)) {
            Action::Launch(spec) => assert_eq!(spec.argv[0], "lazygit"),
            other => panic!("expected Launch, got {other:?}"),
        }
    }

    #[test]
    fn pots_tab_two_level_nav_browse_enter_within_esc() {
        // Owner ask 2026-06-15 #2 (rollout): the horizontal 2-pane tabs gain the
        // same two-level nav as the Fleet tab — ↑/↓ switch panes while BROWSING,
        // Enter drills IN, ↑/↓ then move within, Esc steps back out.
        use crate::models::{HarnessFeature, HarnessIssue};
        let issue = |id: &str| HarnessIssue {
            id: id.into(),
            title: id.into(),
            severity: "minor".into(),
            status: "open".into(),
            source: "x".into(),
            found_during: None,
            linked_feature_id: None,
            attempts: 0,
        };
        let mut a = App::new();
        a.update(key('5', KeyModifiers::NONE)); // Pots
        a.set_features(vec![HarnessFeature {
            id: "F-1".into(),
            title: "f".into(),
            status: "todo".into(),
            attempts: 0,
        }]);
        a.set_issues(vec![issue("I-1"), issue("I-2")]);
        assert!(!a.pane_entered);
        assert_eq!(a.harness_focus, HarnessFocus::Features);
        // Browsing: ↓ switches the focused pane, NOT a row cursor.
        a.update(ev(KeyCode::Down));
        assert_eq!(
            (a.harness_focus, a.pane_entered),
            (HarnessFocus::Issues, false)
        );
        assert_eq!(a.issue_sel, 0);
        // Enter drills into the issues pane.
        a.update(ev(KeyCode::Enter));
        assert!(a.pane_entered);
        // Inside: ↓ now moves the issue cursor.
        a.update(ev(KeyCode::Down));
        assert_eq!(a.issue_sel, 1);
        // Esc steps back out to browsing; ↓ then switches panes again.
        a.update(ev(KeyCode::Esc));
        assert!(!a.pane_entered);
        a.update(ev(KeyCode::Down));
        assert_eq!(a.harness_focus, HarnessFocus::Features);
    }

    #[test]
    fn harness_focus_toggles_and_navigates_issues() {
        use crate::models::{HarnessFeature, HarnessIssue};
        let issue = |id: &str| HarnessIssue {
            id: id.into(),
            title: id.into(),
            severity: "minor".into(),
            status: "open".into(),
            source: "x".into(),
            found_during: None,
            linked_feature_id: None,
            attempts: 0,
        };
        let mut a = App::new();
        a.update(key('5', KeyModifiers::NONE)); // Pots (Harnesses)
        a.set_features(vec![HarnessFeature {
            id: "F-1".into(),
            title: "f".into(),
            status: "todo".into(),
            attempts: 0,
        }]);
        a.set_issues(vec![issue("I-1"), issue("I-2")]);
        a.pane_entered = true; // inside a pane → ↑/↓ move within (Tab still switches)
        assert_eq!(a.harness_focus, HarnessFocus::Features);
        // Tab switches focus to issues; j then moves the issue list.
        a.update(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
        assert_eq!(a.harness_focus, HarnessFocus::Issues);
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.issue_sel, 1);
        assert_eq!(a.selected_issue().unwrap().id, "I-2");
        // Tab back to features.
        a.update(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
        assert_eq!(a.harness_focus, HarnessFocus::Features);
    }

    #[test]
    fn doc_scroll_pgupdn_and_reset_on_change() {
        use crate::models::DocsResponse;
        let mut a = App::new();
        a.update(key('6', KeyModifiers::NONE)); // Docs
        a.set_docs(DocsResponse {
            files: vec!["a.md".into(), "b.md".into()],
            active_path: Some("a.md".into()),
            content: Some("x".into()),
            entries: vec![],
            active_entry: None,
        });
        assert_eq!(a.doc_scroll, 0);
        a.update(Event::Key(KeyEvent::new(
            KeyCode::PageDown,
            KeyModifiers::NONE,
        )));
        a.update(Event::Key(KeyEvent::new(
            KeyCode::PageDown,
            KeyModifiers::NONE,
        )));
        assert_eq!(a.doc_scroll, 20);
        a.update(Event::Key(KeyEvent::new(
            KeyCode::PageUp,
            KeyModifiers::NONE,
        )));
        assert_eq!(a.doc_scroll, 10);
        // Selecting a different doc resets scroll to top.
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.doc_sel, 1);
        assert_eq!(a.doc_scroll, 0);
    }

    #[test]
    fn tick_is_noop() {
        let mut a = App::new();
        assert_eq!(a.update(Event::Tick), Action::None);
    }

    fn notif(level: &str, msg: &str) -> Notif {
        Notif {
            level: level.into(),
            message: msg.into(),
            harness: None,
            ts: None,
        }
    }

    #[test]
    fn push_notif_raises_toast_badge_and_seq() {
        let mut a = App::new();
        assert_eq!(a.notif_seq, 0);
        a.update(Event::Notify(notif("high", "Decide P-002")));
        assert_eq!(a.notif_seq, 1);
        assert_eq!(a.unseen_notifs, 1);
        assert_eq!(a.toast.as_ref().unwrap().message, "Decide P-002");
        assert_eq!(a.notifs.len(), 1);
    }

    #[test]
    fn escalation_notif_records_history_but_never_pops() {
        let mut a = App::new();
        // An escalation lands in history + bumps the unseen badge, but raises
        // NO toast and does NOT bump notif_seq (so the run loop skips os_notify).
        a.update(Event::Notify(notif("escalation", "s-178: escalation")));
        assert_eq!(a.notifs.len(), 1);
        assert_eq!(a.notifs[0].message, "s-178: escalation");
        assert_eq!(a.unseen_notifs, 1);
        assert!(a.toast.is_none(), "escalation must not raise a toast popup");
        assert_eq!(a.notif_seq, 0, "escalation must not bump the OS-notify seq");
        // The coord-escalation variant is suppressed the same way.
        a.update(Event::Notify(notif("coord-escalation", "x: esc")));
        assert!(a.toast.is_none());
        assert_eq!(a.notif_seq, 0);
        // A non-escalation notif still toasts + bumps seq as before — and must
        // not be masked by the escalation currently sitting in front of history.
        a.update(Event::Notify(notif("high", "Decide P-002")));
        assert_eq!(a.toast.as_ref().unwrap().message, "Decide P-002");
        assert_eq!(a.notif_seq, 1);
        assert_eq!(a.unseen_notifs, 3);
    }

    #[test]
    fn notif_history_backfill_does_not_toast() {
        let mut a = App::new();
        a.update(Event::ToastHistory(vec![
            notif("error", "old1"),
            notif("default", "old2"),
        ]));
        assert_eq!(a.notifs.len(), 2);
        assert!(a.toast.is_none());
        assert_eq!(a.notif_seq, 0);
        assert_eq!(a.unseen_notifs, 0);
        // A live event prepends ahead of the backfill.
        a.update(Event::Notify(notif("urgent", "live")));
        assert_eq!(a.notifs[0].message, "live");
        assert_eq!(a.notifs.len(), 3);
    }

    #[test]
    fn opening_notifs_history_clears_toast_and_badge() {
        let mut a = App::new();
        a.update(Event::Notify(notif("high", "x")));
        assert_eq!(a.unseen_notifs, 1);
        assert!(a.toast.is_some());
        a.update(key('N', KeyModifiers::SHIFT)); // open history
        assert!(a.show_notifs);
        assert!(a.toast.is_none());
        assert_eq!(a.unseen_notifs, 0);
        a.update(key('j', KeyModifiers::NONE)); // any key closes it
        assert!(!a.show_notifs);
    }

    #[test]
    fn esc_dismisses_toast_and_inbox_visit_clears() {
        let mut a = App::new();
        a.update(Event::Notify(notif("high", "x")));
        assert!(a.toast.is_some());
        a.update(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(a.toast.is_none());
        // Visiting the inbox clears the badge + any toast.
        a.update(Event::Notify(notif("high", "y")));
        a.update(key('2', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Inbox);
        assert!(a.toast.is_none());
        assert_eq!(a.unseen_notifs, 0);
    }

    #[test]
    fn notif_history_is_capped_newest_first() {
        let mut a = App::new();
        for i in 0..60 {
            a.update(Event::Notify(notif("n", &format!("m{i}"))));
        }
        assert_eq!(a.notifs.len(), 50); // NOTIF_HISTORY_CAP
        assert_eq!(a.notifs[0].message, "m59"); // newest first
    }

    #[test]
    fn tutorial_steps_through_and_dismisses() {
        let mut a = App::new();
        a.show_tutorial = true;
        // Each key advances a step; the key is swallowed (no tab switch).
        a.update(key('2', KeyModifiers::NONE));
        assert!(a.show_tutorial);
        assert_eq!(a.tutorial_step, 1);
        assert_eq!(a.tab, Tab::Overview); // swallowed (default tab is Overview, Brief 23)
        a.update(key(' ', KeyModifiers::NONE));
        assert_eq!(a.tutorial_step, 2);
        assert!(a.show_tutorial);
        a.update(key(' ', KeyModifiers::NONE)); // → step 3 (the zellij-layer step)
        assert_eq!(a.tutorial_step, 3);
        assert!(a.show_tutorial);
        a.update(key('x', KeyModifiers::NONE)); // advance past last → close
        assert!(!a.show_tutorial);
        // Keys behave normally again.
        a.update(key('2', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Inbox);
    }

    #[test]
    fn tutorial_esc_skips_immediately() {
        let mut a = App::new();
        a.show_tutorial = true;
        a.update(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(!a.show_tutorial);
    }

    #[test]
    fn tutorial_f1_reopens_from_start() {
        let mut a = App::new();
        a.tutorial_step = 2;
        a.update(Event::Key(KeyEvent::new(KeyCode::F(1), KeyModifiers::NONE)));
        assert!(a.show_tutorial);
        assert_eq!(a.tutorial_step, 0);
    }

    #[test]
    fn p_toggles_presence_sidebar() {
        let mut a = App::new();
        assert!(a.show_presence); // on by default
        assert_eq!(a.update(key('p', KeyModifiers::NONE)), Action::Render);
        assert!(!a.show_presence);
        a.update(key('p', KeyModifiers::NONE));
        assert!(a.show_presence);
    }

    #[test]
    fn palette_tutorial_command_reopens_tutorial() {
        // D-012: `:tutorial` in the command palette re-opens the guided tour.
        let mut a = App::new();
        a.tutorial_step = 3; // stale progress from a previous run
        a.update(key(':', KeyModifiers::NONE));
        assert!(a.palette_open);
        for c in "tutorial".chars() {
            a.update(key(c, KeyModifiers::NONE));
        }
        a.update(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert!(!a.palette_open);
        assert!(a.show_tutorial);
        assert_eq!(a.tutorial_step, 0); // restarts from the first page
    }

    #[test]
    fn plan_filter_rail_keys_toggle_clear_and_close() {
        // D-009: `F` opens the rail on Inbox/Fleet; j/k move its cursor;
        // Space toggles the plan under it; c clears; F closes.
        let mut a = App::new();
        a.set_plans(vec![plan("alpha"), plan("beta")]);
        a.update(key('2', KeyModifiers::NONE)); // Inbox tab
        assert_eq!(a.tab, Tab::Inbox);
        assert!(!a.plan_filter_open);
        a.update(key('F', KeyModifiers::NONE));
        assert!(a.plan_filter_open);
        a.update(key('j', KeyModifiers::NONE)); // cursor → "beta"
        assert_eq!(a.plan_filter_sel, 1);
        a.update(key(' ', KeyModifiers::NONE)); // toggle "beta" on
        assert!(a.plan_filter.contains("beta"));
        a.update(key(' ', KeyModifiers::NONE)); // toggle "beta" off
        assert!(a.plan_filter.is_empty());
        a.update(key(' ', KeyModifiers::NONE)); // back on for the clear check
        a.update(key('c', KeyModifiers::NONE));
        assert!(a.plan_filter.is_empty());
        a.update(key('F', KeyModifiers::NONE)); // close
        assert!(!a.plan_filter_open);
        // On a tab the filter doesn't narrow, `F` is a no-op.
        a.update(key('3', KeyModifiers::NONE)); // Plans tab
        a.update(key('F', KeyModifiers::NONE));
        assert!(!a.plan_filter_open);
    }

    #[test]
    fn plan_filter_narrows_inbox_strict_and_roster_keeps_unattributed() {
        use crate::models::AttentionItem;
        let item = |id: &str, plan: Option<&str>| AttentionItem {
            id: id.into(),
            kind: "plan-item".into(),
            source: "plan".into(),
            harness_slug: None,
            plan_slug: plan.map(Into::into),
            item_ref: None,
            title: id.into(),
            body: None,
            status: "todo".into(),
            importance: None,
            needs_human: false,
            tier: None,
            owner_agent_id: None,
            owner_label: None,
            triage_state: None,
            triage_note: None,
            report: None,
        };
        let mut a = App::new();
        a.set_inbox(vec![
            item("a", Some("alpha")),
            item("b", Some("beta")),
            item("c", None),
        ]);
        let on_plan = |slug: &str| {
            let mut r = roster_entry("claude");
            r.owner_id = format!("su-{slug}");
            r.current_plan_slug = Some(slug.into());
            r
        };
        let unattributed = roster_entry("codex"); // current_plan_slug: None
        a.set_roster(vec![on_plan("alpha"), on_plan("beta"), unattributed]);
        // No filter → everything visible.
        assert_eq!(a.visible_inbox().len(), 3);
        assert_eq!(a.visible_roster().len(), 3);
        a.plan_filter.insert("alpha".into());
        // Inbox is strict: only items attributed to a selected plan remain
        // (the no-plan item drops out).
        let inbox: Vec<_> = a.visible_inbox().iter().map(|i| i.id.clone()).collect();
        assert_eq!(inbox, vec!["a"]);
        // The roster never hides unattributed rows: alpha + the no-plan agent.
        let roster: Vec<_> = a
            .visible_roster()
            .iter()
            .map(|r| r.owner_id.clone())
            .collect();
        assert_eq!(roster, vec!["su-alpha", "su-1"]);
        // The Fleet cursor + selected_session ride the filtered list.
        a.fleet.agent_sel = 1;
        assert_eq!(
            a.selected_session().map(|r| r.owner_id.as_str()),
            Some("su-1")
        );
    }

    #[test]
    fn plan_filter_round_trips_view_state() {
        // D-009: the filter selection + rail visibility persist via ViewState.
        let mut a = App::new();
        a.plan_filter.insert("alpha".into());
        a.plan_filter.insert("beta".into());
        a.plan_filter_open = true;
        let vs = a.capture_view_state();
        assert_eq!(vs.plan_filter, vec!["alpha", "beta"]);
        assert!(vs.plan_filter_open);
        let mut b = App::new();
        b.apply_view_state(&vs);
        assert_eq!(b.plan_filter, a.plan_filter);
        assert!(b.plan_filter_open);
    }

    #[test]
    fn companion_topology_pane_exit_and_close() {
        use pui_companion_proto::{PaneNode, TabNode, Topology};
        let mut a = App::new();
        // Nothing until the companion links.
        assert!(a.workbench_summary().is_none());

        a.update(Event::CompanionReady("0.1.0".into()));
        assert_eq!(a.companion_version.as_deref(), Some("0.1.0"));

        let topo = Topology {
            tabs: vec![TabNode {
                pos: 0,
                name: "papercup".into(),
                active: true,
                swap_layout: None,
                swap_dirty: false,
            }],
            panes: vec![PaneNode {
                id: 7,
                tab: 0,
                title: "claude · F-1".into(),
                focused: true,
                is_plugin: false,
                exited: false,
                command: Some("psu".into()),
            }],
        };
        assert_eq!(a.update(Event::Topology(topo)), Action::Render);
        assert_eq!(a.topology.as_ref().unwrap().panes.len(), 1);
        // The HUD follows the live focus: the focused terminal pane is shown.
        assert_eq!(
            a.workbench_summary().as_deref(),
            Some(
                format!(
                    "{} 1 panes · {} claude · F-1",
                    crate::glyph::nav::PANES,
                    crate::glyph::action::RUN
                )
                .as_str()
            )
        );

        // A pane-exit raises a notification naming the pane, marks it exited, and
        // arms r-to-relaunch with the exited command.
        let before = a.notif_seq;
        a.update(Event::PaneExited {
            pane_id: 7,
            exit_code: Some(0),
        });
        assert!(a.notif_seq > before);
        assert!(a.toast.as_ref().unwrap().message.contains("claude · F-1"));
        assert!(a.toast.as_ref().unwrap().message.contains("relaunch"));
        assert_eq!(a.relaunch_command.as_deref(), Some("psu"));
        assert!(a.topology.as_ref().unwrap().panes[0].exited);

        // A pane-close drops it from the cached topology.
        a.update(Event::PaneClosed { pane_id: 7 });
        assert!(a.topology.as_ref().unwrap().panes.is_empty());
        assert_eq!(
            a.workbench_summary().as_deref(),
            Some(format!("{} 0 panes", crate::glyph::nav::PANES).as_str())
        );
    }

    #[test]
    fn companion_r_relaunches_last_exited_pane() {
        use pui_companion_proto::{PaneNode, Topology};
        let mut a = App::new();
        a.topology = Some(Topology {
            tabs: vec![],
            panes: vec![PaneNode {
                id: 4,
                tab: 0,
                title: "claude · F-2".into(),
                focused: false,
                is_plugin: false,
                exited: false,
                command: Some("psu --no-picker --agent=claude".into()),
            }],
        });
        // No relaunch armed → `r` is inert (falls through to the default arm).
        assert_eq!(a.update(key('r', KeyModifiers::NONE)), Action::None);

        // After the pane exits, `r` relaunches its command line via `sh -c`.
        a.update(Event::PaneExited {
            pane_id: 4,
            exit_code: Some(1),
        });
        assert_eq!(
            a.relaunch_command.as_deref(),
            Some("psu --no-picker --agent=claude")
        );
        match a.update(key('r', KeyModifiers::NONE)) {
            Action::Launch(spec) => {
                assert_eq!(spec.argv[0], "sh");
                assert_eq!(spec.argv[1], "-c");
                assert_eq!(spec.argv[2], "psu --no-picker --agent=claude");
            }
            other => panic!("expected Launch, got {other:?}"),
        }
        // Relaunch is one-shot: it disarms + dismisses the toast.
        assert_eq!(a.relaunch_command, None);
        assert!(a.toast.is_none());
        assert_eq!(a.update(key('r', KeyModifiers::NONE)), Action::None);
    }

    #[test]
    fn companion_pane_exit_without_command_does_not_arm_relaunch() {
        use pui_companion_proto::{PaneNode, Topology};
        let mut a = App::new();
        a.topology = Some(Topology {
            tabs: vec![],
            panes: vec![PaneNode {
                id: 1,
                tab: 0,
                title: "shell".into(),
                focused: false,
                is_plugin: false,
                exited: false,
                command: None, // a plain shell, not a command/agent pane
            }],
        });
        a.update(Event::PaneExited {
            pane_id: 1,
            exit_code: Some(0),
        });
        assert_eq!(a.relaunch_command, None);
        assert!(!a.toast.as_ref().unwrap().message.contains("relaunch"));
    }

    #[test]
    fn view_state_capture_apply_round_trips() {
        let mut a = App::new();
        a.tab = Tab::Docs;
        a.harness = "restart".to_string();
        a.harness_focus = HarnessFocus::Issues;
        a.plan_sel = 4;
        a.doc_sel = 2;
        a.doc_scroll = 11;
        a.feat_sel = 3;
        a.show_presence = true;
        // Fleet tab state persists too (pui-fleet-status-view).
        a.fleet.agent_sel = 6;
        a.fleet.mode = crate::fleet::FleetMode::Mirror;

        let vs = a.capture_view_state();
        assert_eq!(vs.tab.as_deref(), Some("Docs"));
        assert_eq!(vs.harness.as_deref(), Some("restart"));
        assert_eq!(vs.harness_focus.as_deref(), Some("issues"));
        assert_eq!(vs.fleet_agent_sel, 6);
        assert_eq!(vs.fleet_mode.as_deref(), Some("mirror"));
        // `:theme` persistence (P1 / D-002): the capture carries the active
        // registry name (apply re-selects it — a no-op here, same theme).
        assert_eq!(
            vs.theme.as_deref(),
            Some(crate::theme::Theme::active_name())
        );

        // Apply onto a fresh App restores every captured field.
        let mut b = App::new();
        b.apply_view_state(&vs);
        assert_eq!(b.tab, Tab::Docs);
        assert_eq!(b.harness, "restart");
        assert_eq!(b.harness_focus, HarnessFocus::Issues);
        assert_eq!(b.plan_sel, 4);
        assert_eq!(b.doc_sel, 2);
        assert_eq!(b.doc_scroll, 11);
        assert_eq!(b.feat_sel, 3);
        assert!(b.show_presence);
        assert_eq!(b.fleet.agent_sel, 6);
        assert_eq!(b.fleet.mode, crate::fleet::FleetMode::Mirror);
        // The active-harness mutex is republished for the poller.
        assert_eq!(*b.active_harness.lock().unwrap(), "restart");
    }

    #[test]
    fn view_state_loaded_event_applies() {
        let mut a = App::new();
        let vs = ViewState {
            tab: Some("Fleet".into()),
            fleet_agent_sel: 5,
            ..Default::default()
        };
        a.update(Event::ViewStateLoaded(vs));
        assert_eq!(a.tab, Tab::Fleet); // "Fleet" titles Tab::Fleet
        assert_eq!(a.fleet.agent_sel, 5);
    }

    #[test]
    fn apply_view_state_ignores_unknown_tab_and_blank_harness() {
        let mut a = App::new();
        let original_tab = a.tab;
        let original_harness = a.harness.clone();
        a.apply_view_state(&ViewState {
            tab: Some("Nonexistent".into()),
            harness: Some(String::new()),
            ..Default::default()
        });
        assert_eq!(a.tab, original_tab);
        assert_eq!(a.harness, original_harness);
    }

    // --- P12b / tui:dispatch agent control surface ---

    #[test]
    fn intent_get_state_snapshots() {
        let mut a = App::new();
        a.tab = Tab::Fleet;
        let v = a.apply_intent("get_state", &serde_json::json!({})).unwrap();
        assert_eq!(v["tab"], "Fleet");
        assert!(v["counts"]["plans"].is_number());
        assert_eq!(v["selections"]["plan"], 0);
    }

    #[test]
    fn intent_set_tab_switches_and_validates() {
        let mut a = App::new();
        a.apply_intent("set_tab", &serde_json::json!({"tab":"Docs"}))
            .unwrap();
        assert_eq!(a.tab, Tab::Docs);
        assert!(a
            .apply_intent("set_tab", &serde_json::json!({"tab":"Nope"}))
            .is_err());
        assert!(a.apply_intent("set_tab", &serde_json::json!({})).is_err());
    }

    #[test]
    fn intent_set_plan_filter_sets_clears_and_validates() {
        // D-009: the plans filter is agent-driveable via tui:dispatch.
        let mut a = App::new();
        let v = a
            .apply_intent(
                "set_plan_filter",
                &serde_json::json!({"plans": ["alpha", "beta"], "open": true}),
            )
            .unwrap();
        assert_eq!(v["plan_filter"], serde_json::json!(["alpha", "beta"]));
        assert!(a.plan_filter_open);
        assert!(a.plan_filter.contains("alpha"));
        // [] clears; omitted `open` leaves the rail alone.
        a.apply_intent("set_plan_filter", &serde_json::json!({"plans": []}))
            .unwrap();
        assert!(a.plan_filter.is_empty());
        assert!(a.plan_filter_open);
        assert!(a
            .apply_intent("set_plan_filter", &serde_json::json!({}))
            .is_err());
    }

    #[test]
    fn intent_set_harness_republishes() {
        let mut a = App::new();
        a.apply_intent("set_harness", &serde_json::json!({"slug":"restart"}))
            .unwrap();
        assert_eq!(a.harness, "restart");
        assert_eq!(*a.active_harness.lock().unwrap(), "restart");
    }

    #[test]
    fn intent_select_clamps_and_validates() {
        let mut a = App::new();
        // Empty list → clamps to 0 (no panic).
        a.apply_intent("select", &serde_json::json!({"list":"plans","index":9}))
            .unwrap();
        assert_eq!(a.plan_sel, 0);
        assert!(a
            .apply_intent("select", &serde_json::json!({"list":"bogus","index":0}))
            .is_err());
        assert!(a
            .apply_intent("select", &serde_json::json!({"list":"plans"}))
            .is_err());
    }

    #[test]
    fn intent_unknown_errors() {
        let mut a = App::new();
        assert!(a
            .apply_intent("frobnicate", &serde_json::json!({}))
            .is_err());
    }

    #[test]
    fn tui_intent_event_produces_result_action() {
        let mut a = App::new();
        match a.update(Event::TuiIntent {
            id: 42,
            intent: "get_state".into(),
            args: serde_json::json!({}),
        }) {
            Action::IntentResult {
                id,
                result_json,
                error,
            } => {
                assert_eq!(id, 42);
                assert!(error.is_none());
                let v: serde_json::Value = serde_json::from_str(&result_json).unwrap();
                assert!(v["tab"].is_string());
            }
            other => panic!("expected IntentResult, got {other:?}"),
        }
        match a.update(Event::TuiIntent {
            id: 7,
            intent: "nope".into(),
            args: serde_json::json!({}),
        }) {
            Action::IntentResult { id, error, .. } => {
                assert_eq!(id, 7);
                assert!(error.is_some());
            }
            other => panic!("expected IntentResult, got {other:?}"),
        }
    }

    // --- P10 Settings tab (feature flags) ---

    fn flags(pairs: &[(&str, bool)]) -> FlagsResponse {
        let mut m = std::collections::BTreeMap::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), *v);
        }
        FlagsResponse {
            flags: m,
            source: "test-src".into(),
        }
    }

    #[test]
    fn set_flags_sorts_by_key_and_keeps_source() {
        let mut a = App::new();
        a.set_flags(flags(&[("z-flag", true), ("a-flag", false)]));
        assert_eq!(a.flags.len(), 2);
        assert_eq!(a.flags[0], ("a-flag".to_string(), false));
        assert_eq!(a.flags[1], ("z-flag".to_string(), true));
        assert_eq!(a.flags_source, "test-src");
    }

    #[test]
    fn key_0_switches_to_settings_and_navigates() {
        let mut a = App::new();
        a.on_key(KeyCode::Char('0'), KeyModifiers::empty());
        assert_eq!(a.tab, Tab::Settings);
        // Empty list → move clamps to 0 (no panic).
        a.move_sel(1);
        assert_eq!(a.flag_sel, 0);
        a.set_flags(flags(&[("a", true), ("b", false), ("c", true)]));
        a.move_sel(2);
        assert_eq!(a.flag_sel, 2);
        a.move_sel(5); // clamps to last
        assert_eq!(a.flag_sel, 2);
    }

    #[test]
    fn flags_event_applies() {
        let mut a = App::new();
        a.update(Event::Flags(flags(&[("k", true)])));
        assert_eq!(a.flags.len(), 1);
        assert_eq!(a.flags_source, "test-src");
    }

    #[test]
    fn select_intent_targets_flags_list() {
        let mut a = App::new();
        a.set_flags(flags(&[("a", true), ("b", false)]));
        a.apply_intent("select", &serde_json::json!({"list":"flags","index":1}))
            .unwrap();
        assert_eq!(a.flag_sel, 1);
    }

    // --- P12b palette save/restore + launch-tracking ---

    #[test]
    fn parse_palette_commands() {
        assert_eq!(
            parse_palette_command("layouts"),
            Some(PaletteCommand::ListLayouts)
        );
        assert_eq!(
            parse_palette_command(":crews"),
            Some(PaletteCommand::ListCrews)
        );
        assert_eq!(
            parse_palette_command("save-crew morning"),
            Some(PaletteCommand::SaveCrew("morning".into()))
        );
        assert_eq!(
            parse_palette_command(" save-layout  main "),
            Some(PaletteCommand::SaveLayout("main".into()))
        );
        assert_eq!(
            parse_palette_command("restore-crew x"),
            Some(PaletteCommand::RestoreCrew("x".into()))
        );
        assert_eq!(
            parse_palette_command("restore-layout y"),
            Some(PaletteCommand::RestoreLayout("y".into()))
        );
        // `:pickup <item>` resolves plan later (selected plan); `:pickup <plan> <item>` is explicit.
        assert_eq!(
            parse_palette_command(":pickup P-012"),
            Some(PaletteCommand::PickupPlanItem {
                harness: None,
                plan: None,
                item: "P-012".into()
            })
        );
        assert_eq!(
            parse_palette_command("pickup demo-plan P-012"),
            Some(PaletteCommand::PickupPlanItem {
                harness: None,
                plan: Some("demo-plan".into()),
                item: "P-012".into(),
            })
        );
        // `:release` mirrors `:pickup` (the P-005b inverse): bare item resolves
        // the plan later (selected plan); `<plan> <item>` is explicit.
        assert_eq!(
            parse_palette_command(":release P-012"),
            Some(PaletteCommand::ReleasePlanItem {
                harness: None,
                plan: None,
                item: "P-012".into()
            })
        );
        assert_eq!(
            parse_palette_command("release demo-plan P-012"),
            Some(PaletteCommand::ReleasePlanItem {
                harness: None,
                plan: Some("demo-plan".into()),
                item: "P-012".into(),
            })
        );
        // Missing arg / unknown / empty → None.
        assert_eq!(parse_palette_command("save-crew"), None);
        assert_eq!(parse_palette_command("pickup"), None);
        assert_eq!(parse_palette_command("release"), None);
        assert_eq!(parse_palette_command("bogus"), None);
        assert_eq!(parse_palette_command(""), None);
    }

    #[test]
    fn parse_message_owner_palette_command() {
        // `:message <text>` / `:msg <text>` (D-004) — body required; scope fields
        // are None at parse (resolved from the selected inbox item at Enter).
        assert_eq!(
            parse_palette_command(":message please advise on the rename"),
            Some(PaletteCommand::MessageOwner {
                to: None,
                harness: None,
                plan_slug: None,
                item_ref: None,
                title: String::new(),
                body: "please advise on the rename".to_string(),
            })
        );
        assert_eq!(
            parse_palette_command("msg quick q"),
            Some(PaletteCommand::MessageOwner {
                to: None,
                harness: None,
                plan_slug: None,
                item_ref: None,
                title: String::new(),
                body: "quick q".to_string(),
            })
        );
        // Body required.
        assert_eq!(parse_palette_command("message"), None);
        assert_eq!(parse_palette_command(":msg"), None);
    }

    #[test]
    fn parse_create_and_share_palette_commands() {
        // `:create <slug> <source>` — both args required (D-010).
        assert_eq!(
            parse_palette_command("create my-pot /tmp/my-pot"),
            Some(PaletteCommand::CreatePot {
                slug: "my-pot".into(),
                source: "/tmp/my-pot".into()
            })
        );
        assert_eq!(
            parse_palette_command(":create gh https://github.com/o/r"),
            Some(PaletteCommand::CreatePot {
                slug: "gh".into(),
                source: "https://github.com/o/r".into()
            })
        );
        assert_eq!(parse_palette_command("create only-slug"), None);
        assert_eq!(parse_palette_command("create"), None);
        // `:share <slug> [remote] [public]` — slug required; `public` flags the
        // Cupboard publish; an extra non-`public` token is the remote.
        assert_eq!(
            parse_palette_command("share my-pot"),
            Some(PaletteCommand::SharePot {
                slug: "my-pot".into(),
                remote: None,
                public: false
            })
        );
        assert_eq!(
            parse_palette_command("share my-pot public"),
            Some(PaletteCommand::SharePot {
                slug: "my-pot".into(),
                remote: None,
                public: true
            })
        );
        assert_eq!(
            parse_palette_command("share my-pot git@github.com:o/r.git public"),
            Some(PaletteCommand::SharePot {
                slug: "my-pot".into(),
                remote: Some("git@github.com:o/r.git".into()),
                public: true
            })
        );
        assert_eq!(parse_palette_command("share"), None);
    }

    #[test]
    fn cupboard_browse_arm_confirm_and_stale_guard() {
        use crate::models::CupboardListing;
        let enter = |a: &mut App| a.on_key(KeyCode::Enter, KeyModifiers::empty());
        let mut a = App::new();
        // Switching to the Cupboard tab lazy-loads listings (key 'c').
        let act = a.update(key('c', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Cupboard);
        assert!(matches!(act, Action::FetchCupboard { .. }));
        assert!(a.cupboard_loading);
        // A listings event for the ACTIVE filter ("all", "") populates the list.
        let listing = CupboardListing {
            id: "L1".into(),
            listing_kind: "plugin".into(),
            title: Some("Worker".into()),
            ..Default::default()
        };
        a.update(Event::CupboardListings {
            kind: "all".into(),
            query: String::new(),
            listings: vec![listing],
        });
        assert_eq!(a.cupboard.len(), 1);
        assert!(!a.cupboard_loading);
        // A STALE event (a kind the user isn't on) is ignored.
        a.update(Event::CupboardListings {
            kind: "plugin".into(),
            query: String::new(),
            listings: vec![],
        });
        assert_eq!(a.cupboard.len(), 1);
        // Enter arms the selected listing; a second Enter fires CupboardAct.
        assert_eq!(enter(&mut a), Action::Render);
        assert_eq!(a.cupboard_confirm.as_deref(), Some("L1"));
        assert!(matches!(enter(&mut a), Action::CupboardAct { .. }));
        assert!(a.cupboard_confirm.is_none());
        // `f` cycles the kind filter (all→harness) and refetches.
        let f = a.update(key('f', KeyModifiers::NONE));
        assert_eq!(a.cupboard_kind, 1);
        assert_eq!(CUPBOARD_KINDS[a.cupboard_kind], "harness");
        assert!(matches!(f, Action::FetchCupboard { .. }));
        // `/` opens the search composer seeded with the active query.
        let s = a.update(key('/', KeyModifiers::NONE));
        assert!(a.cupboard_search_open);
        assert_eq!(s, Action::Render);
    }

    #[test]
    fn conversations_tab_browse_filter_and_promote() {
        use crate::models::{ConvCore, ConvDetail, ConvSummary};
        // Tab wiring: key 'd', title "Convos".
        assert_eq!(Tab::from_switch_key('d'), Some(Tab::Conversations));
        assert_eq!(Tab::Conversations.title(), "Convos");

        let mut a = App::new();
        // 'd' switches to Conversations + lazy-loads the list (Brief 25).
        let act = a.update(key('d', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Conversations);
        assert!(matches!(act, Action::FetchConversations { .. }));
        assert!(a.conversations_loading);

        // The list lands: 2 tagged + 1 untagged, all open.
        let mk = |id: &str, kind: &str, topics: Vec<&str>| ConvSummary {
            id: id.into(),
            kind: kind.into(),
            state: "open".into(),
            topics: topics.into_iter().map(String::from).collect(),
            ..Default::default()
        };
        a.update(Event::Conversations(vec![
            mk("c1", "question", vec!["zero-cache"]),
            mk("c2", "discussion", vec!["firefox"]),
            mk("c3", "question", vec![]),
        ]));
        assert_eq!(a.conversations.len(), 3);
        assert!(!a.conversations_loading);
        assert_eq!(a.visible_conversations().len(), 3);

        // 'T' cycles the client-side topic filter through the sorted universe.
        a.update(key('T', KeyModifiers::SHIFT));
        assert_eq!(a.conv_topic.as_deref(), Some("firefox")); // sorted: firefox < zero-cache
        assert_eq!(a.visible_conversations().len(), 1);
        assert_eq!(a.visible_conversations()[0].id, "c2");
        a.update(key('T', KeyModifiers::SHIFT));
        assert_eq!(a.conv_topic.as_deref(), Some("zero-cache"));
        a.update(key('T', KeyModifiers::SHIFT));
        assert_eq!(a.conv_topic, None); // wraps back to unfiltered
        assert_eq!(a.visible_conversations().len(), 3);

        // 's' cycles state (open→resolved) + refetches; 't' cycles kind.
        let s = a.update(key('s', KeyModifiers::NONE));
        assert_eq!(a.conv_state(), "resolved");
        assert!(matches!(s, Action::FetchConversations { .. }));
        let t = a.update(key('t', KeyModifiers::NONE));
        assert_eq!(a.conv_kind(), "question");
        assert!(matches!(t, Action::FetchConversations { .. }));

        // Enter loads the selected (c1) conversation's detail.
        let e = a.on_key(KeyCode::Enter, KeyModifiers::empty());
        assert!(matches!(e, Action::FetchConversationDetail { ref id } if id == "c1"));
        a.update(Event::ConversationDetail {
            id: "c1".into(),
            detail: ConvDetail {
                conversation: Some(ConvCore {
                    id: "c1".into(),
                    kind: "question".into(),
                    state: "open".into(),
                    ..Default::default()
                }),
                topics: vec!["zero-cache".into()],
                posts: vec![],
                subscriber_count: 2,
            },
        });
        assert!(a.conversation_detail.is_some());
        // A STALE detail (a different conversation) is ignored.
        a.update(Event::ConversationDetail {
            id: "cX".into(),
            detail: ConvDetail::default(),
        });
        assert_eq!(
            a.conversation_detail
                .as_ref()
                .and_then(|d| d.conversation.as_ref())
                .map(|c| c.id.as_str()),
            Some("c1"),
        );

        // 'i' promotes the selected (open, unpromoted) conversation.
        let p = a.update(key('i', KeyModifiers::NONE));
        assert!(matches!(p, Action::PromoteConversation { ref id } if id == "c1"));

        // An already-promoted conversation is NOT promotable again (returns None).
        a.update(Event::Conversations(vec![ConvSummary {
            id: "c9".into(),
            kind: "discussion".into(),
            state: "closed".into(),
            promoted_issue_id: Some("EI-7".into()),
            ..Default::default()
        }]));
        a.conversation_sel = 0;
        assert_eq!(a.update(key('i', KeyModifiers::NONE)), Action::None);
    }

    #[test]
    fn palette_enter_dispatches_workbench_command() {
        let mut a = App::new();
        a.palette_open = true;
        a.palette_input = "save-crew morning".to_string();
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::Workbench(PaletteCommand::SaveCrew("morning".into()))
        );
        assert!(!a.palette_open);
        // Unknown command just closes the palette.
        a.palette_open = true;
        a.palette_input = "nope".to_string();
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::Render
        );
    }

    #[test]
    fn parses_config_palette_commands() {
        // D-013: `:set <key.path> <value>` / `:unset <key.path>`.
        assert_eq!(
            parse_palette_command(":set permissions.defaultMode plan"),
            Some(PaletteCommand::ConfigSet {
                key: "permissions.defaultMode".into(),
                value: "plan".into()
            })
        );
        assert_eq!(
            parse_palette_command("set cleanupPeriodDays 60"),
            Some(PaletteCommand::ConfigSet {
                key: "cleanupPeriodDays".into(),
                value: "60".into()
            })
        );
        // Value with spaces survives (splitn 2 on the key).
        assert_eq!(
            parse_palette_command(r#":set env.NAME some value"#),
            Some(PaletteCommand::ConfigSet {
                key: "env.NAME".into(),
                value: "some value".into()
            })
        );
        assert_eq!(parse_palette_command(":set model"), None); // value required
        assert_eq!(
            parse_palette_command(":unset env.FOO"),
            Some(PaletteCommand::ConfigUnset {
                key: "env.FOO".into()
            })
        );
        assert_eq!(parse_palette_command(":unset"), None);
    }

    #[test]
    fn palette_enter_dispatches_config_edit() {
        let mut a = App::new();
        a.harness = "papercup".to_string();
        a.palette_open = true;
        a.palette_input = ":set model opus".to_string();
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::ConfigEdit {
                harness: "papercup".into(),
                key: "model".into(),
                value: Some("opus".into())
            }
        );
        a.palette_open = true;
        a.palette_input = ":unset model".to_string();
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::ConfigEdit {
                harness: "papercup".into(),
                key: "model".into(),
                value: None
            }
        );
    }

    // ── dockview dock-verbs (Brief 50 / dockview-workbench D-008) ──

    fn dock_topology() -> pui_companion_proto::Topology {
        use pui_companion_proto::{PaneNode, TabNode, Topology};
        let pane = |id, title: &str, cmd: Option<&str>, is_plugin| PaneNode {
            id,
            tab: 0,
            title: title.to_string(),
            focused: false,
            is_plugin,
            exited: false,
            command: cmd.map(String::from),
        };
        Topology {
            tabs: vec![TabNode {
                pos: 0,
                name: "papercup".into(),
                active: true,
                swap_layout: Some("stacked".into()),
                swap_dirty: false,
            }],
            panes: vec![
                pane(10, "tab-bar", None, true),         // plugin → not work
                pane(11, "pui", Some("pui hud"), false), // the HUD → not work
                pane(12, "claude", Some("psu --agent=claude"), false),
                pane(13, "codex", Some("psu --agent=codex"), false),
            ],
        }
    }

    #[test]
    fn parse_theme_palette_commands() {
        // `:theme <name>` switches; bare `:theme` and `:themes` list (D-002).
        assert_eq!(
            parse_palette_command(":theme honeycomb"),
            Some(PaletteCommand::Theme {
                name: Some("honeycomb".into())
            })
        );
        assert_eq!(
            parse_palette_command("theme  papercusp-dark "),
            Some(PaletteCommand::Theme {
                name: Some("papercusp-dark".into())
            })
        );
        assert_eq!(
            parse_palette_command(":theme"),
            Some(PaletteCommand::Theme { name: None })
        );
        assert_eq!(
            parse_palette_command("themes"),
            Some(PaletteCommand::Themes)
        );
    }

    #[test]
    fn parse_dock_verbs() {
        assert_eq!(parse_palette_command(":stack"), Some(PaletteCommand::Stack));
        assert_eq!(
            parse_palette_command("float"),
            Some(PaletteCommand::Float { target: None })
        );
        assert_eq!(
            parse_palette_command(":float claude"),
            Some(PaletteCommand::Float {
                target: Some("claude".into())
            })
        );
        assert_eq!(
            parse_palette_command("dock left"),
            Some(PaletteCommand::Dock {
                side: "left".into()
            })
        );
        assert_eq!(parse_palette_command(":dock"), None); // side required
        assert_eq!(
            parse_palette_command("layout next"),
            Some(PaletteCommand::Layout {
                which: "next".into()
            })
        );
        assert_eq!(parse_palette_command(":layout"), None); // arg required
    }

    #[test]
    fn work_pane_ids_excludes_hud_and_plugins() {
        let mut a = App::new();
        a.topology = Some(dock_topology());
        assert_eq!(a.work_pane_ids(), vec![12, 13]);
        // No topology (no companion) → empty, so :stack errors helpfully.
        a.topology = None;
        assert!(a.work_pane_ids().is_empty());
    }

    #[test]
    fn work_pane_ids_respects_hud_pane_id() {
        // When pui knows its own pane id, that pane is the HUD even if its
        // command/title didn't match.
        let mut a = App::new();
        let mut topo = dock_topology();
        // Rename the would-be HUD so only the id can identify it.
        topo.panes[1].title = "shell".into();
        topo.panes[1].command = Some("bash".into());
        a.topology = Some(topo);
        a.hud_pane_id = Some(11);
        assert_eq!(a.work_pane_ids(), vec![12, 13]);
    }

    #[test]
    fn resolve_pane_target_by_id_and_substring() {
        let mut a = App::new();
        a.topology = Some(dock_topology());
        assert_eq!(a.resolve_pane_target("12"), Some(12)); // numeric id
        assert_eq!(a.resolve_pane_target("codex"), Some(13)); // title substring
        assert_eq!(a.resolve_pane_target("agent=claude"), Some(12)); // command substring
        assert_eq!(a.resolve_pane_target("nope"), None);
    }

    #[test]
    fn palette_enter_dispatches_stack() {
        let mut a = App::new();
        a.topology = Some(dock_topology());
        a.palette_open = true;
        a.palette_input = ":stack".to_string();
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::Dock(DockCmd::Stack {
                pane_ids: vec![12, 13]
            })
        );
    }

    #[test]
    fn palette_enter_stack_without_companion_errors() {
        let mut a = App::new();
        a.topology = None; // no companion link
        a.palette_open = true;
        a.palette_input = ":stack".to_string();
        // Resolves to a no-op Render + an error notif, not a half-dispatch.
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::Render
        );
        assert!(a
            .notifs
            .first()
            .map(|n| n.level == "error" && n.message.contains("companion"))
            .unwrap_or(false));
    }

    #[test]
    fn palette_enter_dispatches_float_and_dock_and_layout() {
        let mut a = App::new();
        a.topology = Some(dock_topology());
        // bare :float → HUD (pane_id None; the run loop resolves the HUD).
        a.palette_open = true;
        a.palette_input = ":float".to_string();
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::Dock(DockCmd::Float { pane_id: None })
        );
        // :float <target> → resolved work pane.
        a.palette_open = true;
        a.palette_input = ":float codex".to_string();
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::Dock(DockCmd::Float { pane_id: Some(13) })
        );
        // :dock left|right → mirrored preset.
        a.palette_open = true;
        a.palette_input = ":dock left".to_string();
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::Dock(DockCmd::SelectLayout {
                name: "stacked-left".into()
            })
        );
        a.palette_open = true;
        a.palette_input = ":dock right".to_string();
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::Dock(DockCmd::SelectLayout {
                name: "stacked".into()
            })
        );
        // :layout next|prev → cycle; :layout <name> → select.
        a.palette_open = true;
        a.palette_input = ":layout next".to_string();
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::Dock(DockCmd::CycleLayout { next: true })
        );
        a.palette_open = true;
        a.palette_input = ":layout grid".to_string();
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::Dock(DockCmd::SelectLayout {
                name: "grid".into()
            })
        );
    }

    #[test]
    fn palette_enter_float_unknown_target_errors() {
        let mut a = App::new();
        a.topology = Some(dock_topology());
        a.palette_open = true;
        a.palette_input = ":float zzz".to_string();
        assert_eq!(
            a.on_key(KeyCode::Enter, KeyModifiers::empty()),
            Action::Render
        );
        assert!(a
            .notifs
            .first()
            .map(|n| n.level == "error" && n.message.contains("no pane matching"))
            .unwrap_or(false));
    }

    #[test]
    fn config_value_parses_json_else_string() {
        assert_eq!(parse_config_value("60"), json!(60));
        assert_eq!(parse_config_value("true"), json!(true));
        assert_eq!(parse_config_value("null"), json!(null));
        assert_eq!(parse_config_value(r#"["a","b"]"#), json!(["a", "b"]));
        assert_eq!(parse_config_value(r#"{"x":1}"#), json!({ "x": 1 }));
        assert_eq!(
            parse_config_value("claude-opus-4-8"),
            json!("claude-opus-4-8")
        );
        // A quoted JSON string stays a string (unquoted).
        assert_eq!(parse_config_value(r#""sixty""#), json!("sixty"));
    }

    #[test]
    fn edit_json_path_sets_and_unsets() {
        let mut v = json!({});
        edit_json_path(&mut v, "permissions.defaultMode", Some(json!("plan"))).unwrap();
        assert_eq!(v, json!({ "permissions": { "defaultMode": "plan" } }));
        edit_json_path(&mut v, "model", Some(json!("opus"))).unwrap();
        edit_json_path(&mut v, "permissions.defaultMode", None).unwrap();
        assert_eq!(v, json!({ "permissions": {}, "model": "opus" }));
        // :unset of a missing path is a no-op, not an error.
        edit_json_path(&mut v, "a.b.c", None).unwrap();
        // Setting THROUGH a scalar errors instead of clobbering it.
        let err = edit_json_path(&mut v, "model.sub", Some(json!(1))).unwrap_err();
        assert!(err.contains("not an object"), "{err}");
        // Empty path errors.
        assert!(edit_json_path(&mut v, "", Some(json!(1))).is_err());
        assert!(edit_json_path(&mut v, "..", Some(json!(1))).is_err());
    }

    #[test]
    fn record_launch_tracks_psu_agents_only() {
        let mut a = App::new();
        let spec = a.launch_spec(); // psu --no-picker --agent=claude
        a.record_launch(&spec);
        assert_eq!(a.launched.len(), 1);
        assert_eq!(a.launched[0].agent.as_deref(), Some("claude"));
        assert_eq!(a.launched[0].slot, Some(0));
        // A git pane is not a crew agent → not recorded.
        let g = a.git_spec();
        a.record_launch(&g);
        assert_eq!(a.launched.len(), 1);
    }

    // --- Fleet status view (pui-fleet-status-view-2026-06-04) ---

    fn activity_row(owner: &str, kind: &str, summary: &str) -> ActivityRow {
        ActivityRow {
            id: "1".into(),
            owner_id: owner.into(),
            agent: Some("claude".into()),
            harness_slug: Some("papercup".into()),
            kind: kind.into(),
            tool_name: None,
            summary: Some(summary.into()),
            status: None,
            detail: None,
            created_at: "2026-06-04 18:53:58.46-04".into(),
        }
    }

    fn work_item(family: &str, state: &str) -> WorkItem {
        WorkItem {
            id: "WI-1".into(),
            kind: if family == "issue" {
                "bug".into()
            } else {
                "feature".into()
            },
            family: family.into(),
            harness: Some("papercup".into()),
            title: "t".into(),
            state: state.into(),
            assignee: None,
            severity: None,
        }
    }

    #[test]
    fn key_4_switches_to_brew_and_tab_toggles_mode() {
        // Fleet is digit '4' (D-002); the curated↔mirror toggle moved from
        // `m` to `Tab` (frees `m` for the Memory tab), mirroring Pots' column Tab.
        use crate::fleet::FleetMode;
        let mut a = App::new();
        a.update(key('4', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Fleet);
        assert_eq!(a.fleet.mode, FleetMode::Curated);
        a.update(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
        assert_eq!(a.fleet.mode, FleetMode::Mirror);
        a.update(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
        assert_eq!(a.fleet.mode, FleetMode::Curated);
        // Tab only toggles the mode on the Fleet tab (elsewhere it's column-switch
        // or inert — no mode change).
        a.update(key('3', KeyModifiers::NONE)); // Plans
        a.update(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
        assert_eq!(a.fleet.mode, FleetMode::Curated);
    }

    #[test]
    fn angle_keys_cycle_tabs_and_clear_inbox_badge() {
        let mut a = App::new();
        a.unseen_notifs = 3;
        // Operator leads the strip (index 0); '>' advances to Inbox, clearing badge.
        a.tab = Tab::Operator;
        a.update(key('>', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Inbox);
        assert_eq!(a.unseen_notifs, 0);
        // '<' wraps from the first tab to the last tab in ALL (order-independent).
        a.tab = Tab::ALL[0];
        a.update(key('<', KeyModifiers::NONE));
        assert_eq!(a.tab, *Tab::ALL.last().unwrap());
        // A full forward cycle returns to the start.
        a.tab = Tab::Fleet;
        for _ in 0..Tab::ALL.len() {
            a.update(key('>', KeyModifiers::NONE));
        }
        assert_eq!(a.tab, Tab::Fleet);
    }

    #[test]
    fn fleet_tab_navigates_roster_and_reclamps() {
        let mut a = App::new();
        a.update(key('4', KeyModifiers::NONE)); // Fleet
        a.set_roster(vec![roster_entry("claude"), roster_entry("codex")]);
        a.fleet.entered = true; // inside the roster pane → ↑/↓ move its cursor
        assert_eq!(a.fleet.agent_sel, 0);
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.fleet.agent_sel, 1);
        a.update(key('j', KeyModifiers::NONE)); // clamp at bottom
        assert_eq!(a.fleet.agent_sel, 1);
        // Shrinking the roster re-clamps the fleet cursor.
        a.set_roster(vec![roster_entry("claude")]);
        assert_eq!(a.fleet.agent_sel, 0);
    }

    #[test]
    fn fleet_events_update_state() {
        let mut a = App::new();
        assert_eq!(
            a.update(Event::WorkItems(vec![work_item("feature", "passed")])),
            Action::Render
        );
        assert_eq!(a.fleet.work_items.len(), 1);
        assert_eq!(
            a.update(Event::ActivitySeed(vec![activity_row(
                "su-a", "tool", "✎ x.rs"
            )])),
            Action::Render
        );
        assert_eq!(a.fleet.activity.len(), 1);
        assert_eq!(
            a.update(Event::ActivityLive(activity_row("su-b", "tool", "▶ test"))),
            Action::Render
        );
        assert_eq!(a.fleet.activity.len(), 2);
        assert_eq!(a.fleet.activity[0].summary.as_deref(), Some("▶ test")); // prepended
    }

    #[test]
    fn select_intent_targets_agents_and_snapshot_exposes_fleet() {
        let mut a = App::new();
        a.set_roster(vec![roster_entry("claude"), roster_entry("codex")]);
        a.apply_intent("select", &serde_json::json!({"list":"agents","index":1}))
            .unwrap();
        assert_eq!(a.fleet.agent_sel, 1);
        let snap = a.state_snapshot();
        assert_eq!(snap["fleet_mode"], "curated");
        assert_eq!(snap["selections"]["agent"], 1);
    }

    #[test]
    fn switch_key_maps_ten_tabs_to_ten_digits() {
        // D-002 reorder + D-004b Activity retirement: ten tabs, ten digits.
        // from_switch_key is the inverse (the unified dispatch, g1).
        assert_eq!(Tab::Operator.switch_key(), '1');
        assert_eq!(Tab::Plans.switch_key(), '3');
        assert_eq!(Tab::Fleet.switch_key(), '4');
        assert_eq!(Tab::Plugins.switch_key(), '9');
        assert_eq!(Tab::Settings.switch_key(), '0');
        assert_eq!(Tab::from_switch_key('1'), Some(Tab::Operator));
        assert_eq!(Tab::from_switch_key('0'), Some(Tab::Settings));
        assert_eq!(Tab::from_switch_key('z'), None);
        // Every tab's key is unique (the single-keymap invariant).
        for t in Tab::ALL {
            assert_eq!(Tab::from_switch_key(t.switch_key()), Some(t));
        }
    }

    // --- Operator chat pane (tui-operator-surface-2026-06-04) ---

    fn ev(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
    }

    #[test]
    fn overview_is_default_tab_and_leads_strip() {
        let a = App::new();
        // Brief 23 (overview-dashboard-2026-06-05 D-001): the Overview
        // dashboard is the landing surface; the operator stays always-on via
        // the Overview bottom strip + the `o` dock.
        assert_eq!(a.tab, Tab::Overview);
        assert_eq!(Tab::ALL[0], Tab::Overview); // leads the strip
        assert_eq!(Tab::Overview.switch_key(), 'h'); // home
        assert_eq!(Tab::Overview.title(), "Overview");
        assert_eq!(Tab::from_title("Overview"), Some(Tab::Overview));
        // The operator keeps its digit + title (front door, key '1').
        assert_eq!(Tab::Operator.switch_key(), '1');
        assert_eq!(Tab::Operator.title(), "Operator");
        assert_eq!(Tab::from_title("Operator"), Some(Tab::Operator));
        // Sessions folded into Fleet (D-002b) + Activity retired (D-004b) → ten
        // digit tabs, plus the appended Memory ('m', D-006) + Cupboard ('c',
        // D-011) + Conversations ('d', Brief 25) + Voice ('a', holepunch-voice-
        // channels P-008) + Hives ('i', pui-hives-tab-2026-06-07) letter tabs
        // + the prepended Overview ('h', Brief 23).
        assert_eq!(Tab::ALL.len(), 16);
        assert_eq!(Tab::Memory.switch_key(), 'm');
        assert_eq!(Tab::Cupboard.switch_key(), 'c');
        assert_eq!(Tab::Conversations.switch_key(), 'd');
        assert_eq!(Tab::Voice.switch_key(), 'a');
        assert_eq!(Tab::Hives.switch_key(), 'i');
        assert_eq!(Tab::from_switch_key('a'), Some(Tab::Voice));
        assert_eq!(Tab::from_switch_key('i'), Some(Tab::Hives));
        assert_eq!(Tab::from_title("Hives"), Some(Tab::Hives));
        // `h` returns to the Overview from elsewhere; `1` still reaches the chat.
        let mut b = App::new();
        b.update(key('3', KeyModifiers::NONE));
        assert_eq!(b.tab, Tab::Plans);
        b.update(key('h', KeyModifiers::NONE));
        assert_eq!(b.tab, Tab::Overview);
        b.update(key('1', KeyModifiers::NONE));
        assert_eq!(b.tab, Tab::Operator);
    }

    #[test]
    fn realtime_voice_toggle_and_phase_lifecycle() {
        use crate::voice_convai::ConvAiUpdate as U;
        let mut a = App::new();
        assert_eq!(a.convai_phase, ConvAiPhase::Off);
        // V starts: optimistic Connecting + the run-loop action.
        assert_eq!(
            a.update(key('V', KeyModifiers::SHIFT)),
            Action::VoiceSessionStart
        );
        assert_eq!(a.convai_phase, ConvAiPhase::Connecting);
        // Session connects → Live (+ a toast) and the shared thread id
        // backfills the app's conversation pointer (voice-first session).
        a.update(Event::ConvAi(U::Connected {
            conversation_id: "conv_1".into(),
        }));
        assert_eq!(a.convai_phase, ConvAiPhase::Live);
        assert_eq!(a.conversation_id.as_deref(), Some("conv_1"));
        // V again stops.
        assert_eq!(
            a.update(key('V', KeyModifiers::SHIFT)),
            Action::VoiceSessionStop
        );
        assert_eq!(a.convai_phase, ConvAiPhase::Off);
        // A session error lands in the status line + resets the phase.
        a.update(key('V', KeyModifiers::SHIFT));
        a.update(Event::ConvAi(U::Error("voice init: 409".into())));
        assert_eq!(a.convai_phase, ConvAiPhase::Off);
        assert!(a.last_error.as_deref().unwrap_or("").contains("409"));
        // Mid-PTT the realtime toggle refuses (one mic owner at a time).
        let mut b = App::new();
        b.voice_phase = VoicePhase::Recording;
        assert_eq!(b.update(key('V', KeyModifiers::SHIFT)), Action::Render);
        assert_eq!(b.convai_phase, ConvAiPhase::Off);
        assert!(b.voice_error.as_deref().unwrap_or("").contains("PTT"));
    }

    #[test]
    fn realtime_voice_controls_follow_host_state_and_keys() {
        use crate::voice_convai::{ConvAiControl as C, ConvAiUpdate as U};
        let mut a = App::new();
        a.tab = Tab::Operator;
        a.convai_phase = ConvAiPhase::Live;
        a.update(Event::ConvAi(U::SessionState {
            muted: false,
            mode: "push-to-talk".into(),
            is_player: false,
        }));
        assert_eq!(a.convai_mode, "push-to-talk");
        assert!(!a.convai_muted);
        assert!(!a.convai_is_player);

        assert_eq!(
            a.update(key('M', KeyModifiers::SHIFT)),
            Action::VoiceSessionControl(C::Mute(true))
        );
        assert!(a.convai_muted);

        assert_eq!(
            a.update(key('A', KeyModifiers::SHIFT)),
            Action::VoiceSessionControl(C::SetMode("always-on"))
        );
        assert_eq!(a.convai_mode, "always-on");

        assert_eq!(
            a.update(key('H', KeyModifiers::SHIFT)),
            Action::VoiceSessionControl(C::ForceHost)
        );

        a.update(Event::ConvAi(U::SessionState {
            muted: true,
            mode: "push-to-talk".into(),
            is_player: true,
        }));
        assert_eq!(
            a.update(key('v', KeyModifiers::NONE)),
            Action::VoiceSessionControl(C::Ptt(true))
        );
        assert!(a.convai_ptt_active);
        assert_eq!(
            a.update(Event::KeyRelease(KeyEvent::new(
                KeyCode::Char('v'),
                KeyModifiers::NONE,
            ))),
            Action::VoiceSessionControl(C::Ptt(false))
        );
        assert!(!a.convai_ptt_active);
    }

    #[test]
    fn convai_transcripts_land_in_shared_chat_with_tags_stripped() {
        use crate::voice_convai::ConvAiUpdate as U;
        let mut a = App::new();
        a.update(Event::ConvAi(U::UserTranscript("how is the fleet".into())));
        assert_eq!(a.chat_messages.last().unwrap().role, "user");
        assert_eq!(a.chat_messages.last().unwrap().content, "how is the fleet");
        // Agent utterance: <say> renders clean, <set_mode> becomes a toast,
        // raw tags never reach the transcript.
        a.update(Event::ConvAi(U::AgentText(
            "<say>all green</say><set_mode>passive</set_mode>".into(),
        )));
        let last = a.chat_messages.last().unwrap();
        assert_eq!(last.role, "assistant");
        assert_eq!(last.content, "all green");
        assert!(!last.content.contains("set_mode"));
        assert!(a.notifs.iter().any(|n| n.message.contains("passive")));
        // Ended resets the phase + toasts the reason.
        a.update(Event::ConvAi(U::Ended {
            reason: "voice session closed".into(),
        }));
        assert_eq!(a.convai_phase, ConvAiPhase::Off);
        assert!(a.notifs.iter().any(|n| n.message.contains("closed")));
    }

    #[test]
    fn overview_max_agents_nudge_clamps_and_emits_put() {
        let mut a = App::new();
        assert_eq!(a.tab, Tab::Overview);
        // No read-model yet → the editor keys are a no-op (can't edit what we
        // can't see; the host may predate the route).
        assert_eq!(a.update(key('+', KeyModifiers::NONE)), Action::None);
        // Seed the read-model (as the poller would).
        let mut s = crate::models::FleetRateStatus::default();
        s.config.max_simultaneous_agents = 4;
        s.fleet.cap = 4;
        a.update(Event::FleetRate(s));
        // '+' raises optimistically + emits the PUT action; cap follows.
        assert_eq!(
            a.update(key('+', KeyModifiers::NONE)),
            Action::SetMaxAgents(5)
        );
        let fr = a.fleet_rate.as_ref().unwrap();
        assert_eq!(fr.config.max_simultaneous_agents, 5);
        assert_eq!(fr.fleet.cap, 5);
        // '=' (unshifted '+') raises too; '-' lowers.
        assert_eq!(
            a.update(key('=', KeyModifiers::NONE)),
            Action::SetMaxAgents(6)
        );
        assert_eq!(
            a.update(key('-', KeyModifiers::NONE)),
            Action::SetMaxAgents(5)
        );
        // Clamp floor at 1 — no redundant PUT.
        a.fleet_rate
            .as_mut()
            .unwrap()
            .config
            .max_simultaneous_agents = 1;
        assert_eq!(a.update(key('-', KeyModifiers::NONE)), Action::None);
        // The editor only lives on the Overview tab.
        a.tab = Tab::Plans;
        assert_eq!(a.update(key('+', KeyModifiers::NONE)), Action::None);
    }

    #[test]
    fn overview_tiles_cycle_and_enter_clicks_through() {
        // j/k move the tile cursor (clamped to the 4 tiles); Enter opens the
        // selected tile's full tab (D-007).
        let mut a = App::new();
        assert_eq!(a.tab, Tab::Overview);
        assert_eq!(a.overview_sel, 0);
        a.update(ev(KeyCode::Char('j')));
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(a.overview_sel, 2);
        a.update(ev(KeyCode::Char('j')));
        a.update(ev(KeyCode::Char('j'))); // clamps at the last tile
        assert_eq!(a.overview_sel, 3);
        a.update(ev(KeyCode::Enter)); // Activity tile → Fleet
        assert_eq!(a.tab, Tab::Fleet);
        // Tile→tab mapping is total + stable.
        assert_eq!(App::overview_tile_target(0), Tab::Plans);
        assert_eq!(App::overview_tile_target(1), Tab::Inbox);
        assert_eq!(App::overview_tile_target(2), Tab::Fleet);
        assert_eq!(App::overview_tile_target(3), Tab::Fleet);
        // Needs-you tile → Inbox.
        let mut c = App::new();
        c.update(ev(KeyCode::Char('j')));
        assert_eq!(c.overview_sel, 1);
        c.update(ev(KeyCode::Enter));
        assert_eq!(c.tab, Tab::Inbox);
    }

    #[test]
    fn compose_mode_captures_input_and_sends() {
        let mut a = App::new(); // starts on Operator
                                // Outside compose, digit keys still switch tabs.
        a.update(key('2', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Inbox);
        a.update(key('1', KeyModifiers::NONE)); // back to Operator (leads the strip)
                                                // `i` focuses the composer; now keys are captured as text.
        a.update(key('i', KeyModifiers::NONE));
        assert!(a.chat_composing);
        a.update(key('h', KeyModifiers::NONE));
        a.update(key('2', KeyModifiers::NONE)); // a digit types, does NOT switch tab
        assert_eq!(a.chat_input, "h2");
        assert_eq!(a.tab, Tab::Operator);
        // Enter sends: appends the user msg + a streaming bubble, returns SendChat.
        match a.update(ev(KeyCode::Enter)) {
            Action::SendChat(t) => assert_eq!(t, "h2"),
            other => panic!("expected SendChat, got {other:?}"),
        }
        assert!(a.chat_input.is_empty());
        assert!(a.chat_streaming);
        assert_eq!(a.chat_messages.len(), 2);
        assert_eq!(a.chat_messages[0].role, "user");
        assert_eq!(a.chat_messages[0].content, "h2");
        assert!(a.chat_messages[1].streaming);
        // Enter while a turn is in flight is a no-op send.
        a.chat_input = "again".into();
        assert_eq!(a.update(ev(KeyCode::Enter)), Action::Render);
        assert_eq!(a.chat_messages.len(), 2);
    }

    #[test]
    fn compose_esc_leaves_and_ctrl_c_quits() {
        let mut a = App::new();
        a.tab = Tab::Operator; // `i` composes on the Operator tab (Overview is default now)
        a.update(key('i', KeyModifiers::NONE));
        assert!(a.chat_composing);
        a.update(ev(KeyCode::Esc));
        assert!(!a.chat_composing);
        // After leaving compose, digit keys switch tabs again.
        a.update(key('3', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Plans);
        // Ctrl-C quits even while composing (the universal escape hatch).
        let mut b = App::new();
        b.tab = Tab::Operator;
        b.update(key('i', KeyModifiers::NONE));
        assert_eq!(b.update(key('c', KeyModifiers::CONTROL)), Action::Quit);
        assert!(b.should_quit);
        // A plain `q` typed while composing is just text, not quit.
        let mut c = App::new();
        c.tab = Tab::Operator;
        c.update(key('i', KeyModifiers::NONE));
        assert_eq!(c.update(key('q', KeyModifiers::NONE)), Action::Render);
        assert!(!c.should_quit);
        assert_eq!(c.chat_input, "q");
    }

    #[test]
    fn chat_stream_lifecycle_builds_and_finalizes() {
        let mut a = App::new();
        a.begin_user_send("hi");
        assert!(a.chat_streaming);
        // Deltas accumulate raw into the streaming bubble.
        a.update(Event::ChatDelta("<say>hel".into()));
        a.update(Event::ChatDelta("lo</say>".into()));
        assert!(a.chat_messages[1].streaming);
        assert_eq!(a.chat_messages[1].content, "<say>hello</say>"); // raw while streaming
                                                                    // A tool call becomes a chip on the streaming bubble.
        a.update(Event::ChatToolCall(ChatToolCall {
            name: "harness:list".into(),
        }));
        assert_eq!(a.chat_messages[1].tools.len(), 1);
        // Done finalizes: raw → the <say> body, streaming cleared.
        a.update(Event::ChatDone);
        assert!(!a.chat_streaming);
        assert!(!a.chat_messages[1].streaming);
        assert_eq!(a.chat_messages[1].content, "hello");
    }

    #[test]
    fn chat_report_tag_is_stripped_from_the_finalized_bubble() {
        // report-cards-inbox-reconciliation D-002: the report is NOT chat
        // content — finalize leaves only the say; the payload persists via
        // append_turn (main.rs) and surfaces in the Inbox detail instead.
        let mut a = App::new();
        a.begin_user_send("status?");
        a.update(Event::ChatDelta(
            "<say>Here is where things stand.</say>".into(),
        ));
        a.update(Event::ChatDelta(
            concat!(
                r#"<report>{"plans":[{"slug":"rate-limit-layer-v2","title":"Rate-limit v2","#,
                r#""status":"active","items":[{"id":"P-001","text":"Error classifier","status":"done"}]}]}</report>"#,
            )
            .into(),
        ));
        a.update(Event::ChatDone);
        // On finalize: the say is the whole bubble — no report JSON leaks.
        assert_eq!(a.chat_messages[1].content, "Here is where things stand.");
        assert!(!a.chat_messages[1].content.contains("Rate-limit v2"));
    }

    #[test]
    fn chat_error_finalizes_bubble_and_sets_status() {
        // Empty bubble → becomes the error note.
        let mut a = App::new();
        a.begin_user_send("hi");
        a.update(Event::ChatError("backend down".into()));
        assert!(!a.chat_streaming);
        assert_eq!(
            a.chat_messages[1].content,
            format!("{} backend down", crate::glyph::severity::WARN)
        );
        assert!(a.last_error.as_deref().unwrap().contains("backend down"));
        // Mid-stream bubble → partial say is preserved on error.
        let mut b = App::new();
        b.begin_user_send("hi");
        b.update(Event::ChatDelta("<say>partial".into()));
        b.update(Event::ChatError("dropped".into()));
        assert_eq!(b.chat_messages[1].content, "partial");
    }

    #[test]
    fn chat_history_seeds_transcript() {
        let mut a = App::new();
        a.update(Event::ChatHistory {
            conversation_id: "conv-1".into(),
            messages: vec![
                ChatMessage::user("hello"),
                ChatMessage::assistant("hi there"),
            ],
            has_more_earlier: true,
            oldest_seq: Some(40),
        });
        assert_eq!(a.conversation_id.as_deref(), Some("conv-1"));
        assert_eq!(a.chat_messages.len(), 2);
        assert!(a.chat_has_more_earlier);
        assert_eq!(a.chat_oldest_seq, Some(40));
    }

    #[test]
    fn page_up_triggers_load_earlier_then_prepends() {
        let mut a = App::new();
        a.tab = Tab::Operator; // chat behavior — Overview is the default now (Brief 23)
        a.update(Event::ChatHistory {
            conversation_id: "c1".into(),
            messages: vec![ChatMessage::user("newest")],
            has_more_earlier: true,
            oldest_seq: Some(10),
        });
        // PageUp with more history + a conversation → fires a load + marks in-flight.
        assert_eq!(a.update(ev(KeyCode::PageUp)), Action::LoadEarlierChat);
        assert!(a.chat_loading_earlier);
        // A second PageUp while loading does NOT re-fire (deduped) — just scrolls.
        assert_eq!(a.update(ev(KeyCode::PageUp)), Action::Render);
        // The earlier page prepends before the existing turns + advances the cursor.
        a.update(Event::ChatEarlier {
            messages: vec![
                ChatMessage::user("older-1"),
                ChatMessage::assistant("older-2"),
            ],
            has_more_earlier: false,
            oldest_seq: Some(8),
        });
        assert!(!a.chat_loading_earlier);
        assert!(!a.chat_has_more_earlier);
        assert_eq!(a.chat_oldest_seq, Some(8));
        assert_eq!(a.chat_messages.len(), 3);
        assert_eq!(a.chat_messages[0].content, "older-1"); // prepended at the front
        assert_eq!(a.chat_messages[2].content, "newest");
        // No more history → PageUp no longer fires a load.
        assert_eq!(a.update(ev(KeyCode::PageUp)), Action::Render);
    }

    #[test]
    fn page_up_no_load_without_more_or_conversation() {
        let mut a = App::new();
        a.tab = Tab::Operator; // chat behavior — Overview is the default now (Brief 23)
                               // No conversation loaded yet → PageUp just scrolls.
        assert_eq!(a.update(ev(KeyCode::PageUp)), Action::Render);
        assert!(!a.chat_loading_earlier);
        // Conversation loaded but no earlier history → PageUp just scrolls.
        a.update(Event::ChatHistory {
            conversation_id: "c1".into(),
            messages: vec![ChatMessage::user("only")],
            has_more_earlier: false,
            oldest_seq: Some(0),
        });
        assert_eq!(a.update(ev(KeyCode::PageUp)), Action::Render);
        assert!(!a.chat_loading_earlier);
    }

    #[test]
    fn chat_history_for_send_excludes_streaming_and_empty() {
        let mut a = App::new();
        a.chat_messages = vec![ChatMessage::user("q1"), ChatMessage::assistant("a1")];
        a.begin_user_send("q2"); // pushes user q2 + an empty streaming bubble
        let h = a.chat_history_for_send();
        assert_eq!(
            h,
            vec![
                ("user".to_string(), "q1".to_string()),
                ("assistant".to_string(), "a1".to_string()),
                ("user".to_string(), "q2".to_string()),
            ]
        );
    }

    #[test]
    fn chat_scroll_keys_adjust_offset_and_delta_snaps_bottom() {
        let mut a = App::new();
        a.tab = Tab::Operator; // chat behavior — Overview is the default now (Brief 23)
        assert_eq!(a.chat_scroll, 0);
        a.update(ev(KeyCode::Char('k'))); // up into history
        a.update(ev(KeyCode::Char('k')));
        assert_eq!(a.chat_scroll, 2);
        a.update(ev(KeyCode::PageUp));
        assert_eq!(a.chat_scroll, 12);
        a.update(ev(KeyCode::Char('j'))); // toward latest
        assert_eq!(a.chat_scroll, 11);
        a.update(ev(KeyCode::PageDown));
        assert_eq!(a.chat_scroll, 1);
        // A new delta snaps back to the bottom.
        a.begin_user_send("x");
        a.chat_scroll = 5;
        a.update(Event::ChatDelta("y".into()));
        assert_eq!(a.chat_scroll, 0);
    }

    #[test]
    fn open_chat_and_focus_pane_intents() {
        let mut a = App::new();
        a.update(key('3', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Plans);
        // open_chat focuses the operator pane.
        a.apply_intent("open_chat", &serde_json::json!({})).unwrap();
        assert_eq!(a.tab, Tab::Operator);
        // focus_pane → a FocusPane action (companion side-effect, run-loop driven).
        match a.update(Event::TuiIntent {
            id: 9,
            intent: "focus_pane".into(),
            args: serde_json::json!({ "pane_id": 7 }),
        }) {
            Action::FocusPane { intent_id, pane_id } => {
                assert_eq!(intent_id, 9);
                assert_eq!(pane_id, 7);
            }
            other => panic!("expected FocusPane, got {other:?}"),
        }
        // Missing pane_id → an error IntentResult, not a panic.
        match a.update(Event::TuiIntent {
            id: 10,
            intent: "focus_pane".into(),
            args: serde_json::json!({}),
        }) {
            Action::IntentResult { id, error, .. } => {
                assert_eq!(id, 10);
                assert!(error.is_some());
            }
            other => panic!("expected IntentResult error, got {other:?}"),
        }
    }

    // --- Memory tab (D-006 Step 2, pui-completion-and-polish) ---

    fn mem(id: &str, text: &str, kind: &str) -> crate::models::MemoryEntry {
        crate::models::MemoryEntry {
            id: id.into(),
            memory: text.into(),
            metadata: Some(serde_json::json!({ "kind": kind })),
            score: None,
        }
    }

    #[test]
    fn memory_tab_lists_searches_and_clears() {
        let mut a = App::new();
        a.update(key('m', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Memory);
        // The list lands from memory:list; availability follows the payload.
        a.update(Event::Memories {
            available: true,
            results: vec![
                mem("m1", "likes rust", "preference"),
                mem("m2", "tz is ET", "identity"),
            ],
        });
        assert!(a.memory_available);
        assert_eq!(a.visible_memories().len(), 2);
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.memory_sel, 1);
        assert_eq!(a.selected_memory().unwrap().id, "m2");
        // `/` opens the composer; typed keys go to the query, not tabs.
        a.update(key('/', KeyModifiers::NONE));
        assert!(a.memory_search_open);
        a.update(key('r', KeyModifiers::NONE));
        a.update(key('u', KeyModifiers::NONE));
        a.update(key('s', KeyModifiers::NONE));
        a.update(key('t', KeyModifiers::NONE));
        assert_eq!(a.memory_search_input, "rust");
        assert_eq!(a.tab, Tab::Memory);
        // Enter fires the search + arms the active query.
        match a.update(ev(KeyCode::Enter)) {
            Action::SearchMemory { query, harness } => {
                assert_eq!(query, "rust");
                assert_eq!(harness, "papercup");
            }
            other => panic!("expected SearchMemory, got {other:?}"),
        }
        assert!(!a.memory_search_open);
        // Hits for the ACTIVE query apply; a stale query's hits are dropped.
        a.update(Event::MemoryHits {
            query: "stale".into(),
            results: vec![mem("x", "x", "project")],
        });
        assert!(a.visible_memories().is_empty()); // armed query, no hits yet
        a.update(Event::MemoryHits {
            query: "rust".into(),
            results: vec![mem("m1", "likes rust", "preference")],
        });
        assert_eq!(a.visible_memories().len(), 1);
        assert_eq!(a.selected_memory().unwrap().kind(), "preference");
        // Esc clears the search back to the full list.
        a.update(ev(KeyCode::Esc));
        assert!(a.memory_hits.is_none());
        assert_eq!(a.visible_memories().len(), 2);
        // Esc with no active search just dismisses toasts (no panic).
        a.update(ev(KeyCode::Esc));
    }

    #[test]
    fn memory_search_esc_cancels_composer() {
        let mut a = App::new();
        a.update(key('m', KeyModifiers::NONE));
        a.update(key('/', KeyModifiers::NONE));
        a.update(key('x', KeyModifiers::NONE));
        a.update(ev(KeyCode::Esc));
        assert!(!a.memory_search_open);
        assert!(a.memory_search_input.is_empty());
        assert!(a.memory_hits.is_none());
        // An empty query on Enter is inert.
        a.update(key('/', KeyModifiers::NONE));
        assert_eq!(a.update(ev(KeyCode::Enter)), Action::Render);
        assert!(a.memory_hits.is_none());
    }

    // --- POTS scope axis + picker (D-003, pui-completion-and-polish) ---

    fn plan_in(slug: &str, harness: Option<&str>) -> PlanSummary {
        let mut p = plan(slug);
        p.harness = harness.map(|s| s.to_string());
        p
    }

    #[test]
    fn scope_filters_plans_and_keeps_unattributed_rows() {
        let mut a = App::new();
        assert!(a.all_pots); // fresh installs land in All-Pots
        a.set_plans(vec![
            plan_in("p-papercup", Some("papercup")),
            plan_in("p-restart", Some("restart")),
            plan_in("p-unattributed", None),
        ]);
        assert_eq!(a.visible_plans().len(), 3);
        // Narrow to the active pot (papercup): restart's plan filters out, the
        // unattributed plan stays (it can't be attributed).
        a.all_pots = false;
        let vis: Vec<&str> = a.visible_plans().iter().map(|p| p.slug.as_str()).collect();
        assert_eq!(vis, vec!["p-papercup", "p-unattributed"]);
        // The selection indexes the VISIBLE list.
        a.plan_sel = 1;
        assert_eq!(a.selected_plan().unwrap().slug, "p-unattributed");
        // Scope label follows the axis.
        assert_eq!(a.scope_label(), "⊙ papercup");
        a.all_pots = true;
        assert_eq!(a.scope_label(), "⊙ all pots");
    }

    #[test]
    fn pot_picker_opens_navigates_and_applies() {
        use crate::models::HarnessRef;
        let mut a = App::new();
        a.set_harnesses(vec![
            HarnessRef {
                slug: "papercup".into(),
                path: None,
            },
            HarnessRef {
                slug: "restart".into(),
                path: None,
            },
        ]);
        // `P` opens the picker with the cursor on the current choice (All).
        a.update(key('P', KeyModifiers::SHIFT));
        assert!(a.pot_picker_open);
        assert_eq!(a.pot_picker_sel, 0);
        // j to "papercup", j to "restart", Enter applies pot scope + switches.
        a.update(key('j', KeyModifiers::NONE));
        a.update(key('j', KeyModifiers::NONE));
        a.update(key('j', KeyModifiers::NONE)); // clamped at the last entry
        assert_eq!(a.pot_picker_sel, 2);
        a.update(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert!(!a.pot_picker_open);
        assert!(!a.all_pots);
        assert_eq!(a.harness, "restart");
        assert_eq!(*a.active_harness.lock().unwrap(), "restart");
        // Re-open: the cursor sits on the active pot; Enter on "All Pots" widens.
        a.update(key('P', KeyModifiers::SHIFT));
        assert_eq!(a.pot_picker_sel, 2); // index 1 + harness_sel(1)
        a.update(key('k', KeyModifiers::NONE));
        a.update(key('k', KeyModifiers::NONE));
        a.update(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert!(a.all_pots);
        assert_eq!(a.harness, "restart"); // the slug axis is untouched by All
                                          // Esc closes without applying.
        a.update(key('P', KeyModifiers::SHIFT));
        a.update(key('j', KeyModifiers::NONE));
        a.update(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(!a.pot_picker_open);
        assert!(a.all_pots); // unchanged
    }

    #[test]
    fn scope_persists_in_view_state_and_snapshot() {
        let mut a = App::new();
        a.all_pots = false;
        let vs = a.capture_view_state();
        assert_eq!(vs.scope.as_deref(), Some("pot"));
        let mut b = App::new();
        assert!(b.all_pots);
        b.apply_view_state(&vs);
        assert!(!b.all_pots);
        // An older snapshot without the field keeps the default.
        let mut c = App::new();
        c.apply_view_state(&ViewState::default());
        assert!(c.all_pots);
        // The agent-facing snapshot exposes the axis.
        assert_eq!(a.state_snapshot()["scope"], "pot");
        assert_eq!(c.state_snapshot()["scope"], "all");
    }

    #[test]
    fn scope_change_clamps_filtered_selection() {
        let mut a = App::new();
        a.set_plans(vec![
            plan_in("p1", Some("restart")),
            plan_in("p2", Some("restart")),
            plan_in("p3", Some("papercup")),
        ]);
        a.plan_sel = 2; // p3 visible under All
                        // Narrowing to papercup leaves 1 visible plan → the cursor clamps.
        a.apply_pot_choice(0); // All (no-op scope-wise but exercises the path)
        assert!(a.all_pots);
        a.all_pots = false;
        a.clamp_scope_sel();
        assert_eq!(a.plan_sel, 0);
        assert_eq!(a.selected_plan().unwrap().slug, "p3");
    }

    // --- Testing run-on-click (D-004a, pui-completion-and-polish-2026-06-05) ---

    fn test_domain(id: &str) -> TestingDomain {
        TestingDomain {
            id: id.into(),
            label: id.into(),
            description: "d".into(),
            tier: "universal".into(),
        }
    }

    #[test]
    fn testing_enter_fetches_domain_files_then_runs() {
        let mut a = App::new();
        a.update(key('7', KeyModifiers::NONE)); // Testing
        a.set_testing(vec![test_domain("unit"), test_domain("e2e")]);
        a.pane_entered = true; // inside the panes → Enter activates / ↑↓ move within
                               // Enter on the domain column fetches the selected domain's files.
        match a.update(ev(KeyCode::Enter)) {
            Action::FetchTestingFiles { harness, domain_id } => {
                assert_eq!(harness, "papercup");
                assert_eq!(domain_id, "unit");
            }
            other => panic!("expected FetchTestingFiles, got {other:?}"),
        }
        assert!(a.testing_files_loading);
        // Files for the selected domain land + focus hops to the file column.
        a.update(Event::TestingFiles {
            domain_id: "unit".into(),
            files: vec!["a.test.ts".into(), "b.test.ts".into()],
        });
        assert!(!a.testing_files_loading);
        assert_eq!(a.testing_focus, TestingFocus::Files);
        assert_eq!(a.testing_files.len(), 2);
        // j moves the FILE cursor while the file column is focused.
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.testing_file_sel, 1);
        // Enter runs the selected file (marks the run in flight).
        match a.update(ev(KeyCode::Enter)) {
            Action::RunTest { harness, file } => {
                assert_eq!(harness, "papercup");
                assert_eq!(file, "b.test.ts");
            }
            other => panic!("expected RunTest, got {other:?}"),
        }
        assert!(a.test_run.as_ref().unwrap().running);
        // A second Enter while running is inert (one run at a time).
        assert_eq!(a.update(ev(KeyCode::Enter)), Action::Render);
        // The result finalizes the run pane.
        a.update(Event::TestRunDone {
            file: "b.test.ts".into(),
            result: crate::models::TestRunResult {
                status: "pass".into(),
                output: "1 passed".into(),
                ..Default::default()
            },
        });
        let run = a.test_run.as_ref().unwrap();
        assert!(!run.running);
        assert_eq!(run.status, "pass");
        assert_eq!(run.output, "1 passed");
    }

    #[test]
    fn testing_files_stale_guard_and_domain_change_clears() {
        let mut a = App::new();
        a.update(key('7', KeyModifiers::NONE));
        a.set_testing(vec![test_domain("unit"), test_domain("e2e")]);
        a.pane_entered = true; // inside the panes → ↑/↓ move within (Tab still switches)
                               // A stale fetch for a NON-selected domain is dropped.
        a.update(key('j', KeyModifiers::NONE)); // select e2e
        a.update(Event::TestingFiles {
            domain_id: "unit".into(),
            files: vec!["a.test.ts".into()],
        });
        assert!(a.testing_files.is_empty());
        assert_eq!(a.testing_focus, TestingFocus::Domains);
        // A matching fetch applies + focuses the file column.
        a.update(Event::TestingFiles {
            domain_id: "e2e".into(),
            files: vec!["x.spec.ts".into()],
        });
        assert_eq!(a.testing_files.len(), 1);
        assert_eq!(a.testing_focus, TestingFocus::Files);
        // Tab hops back to the domain column; changing the domain clears the
        // (now stale) file list.
        a.update(ev(KeyCode::Tab));
        assert_eq!(a.testing_focus, TestingFocus::Domains);
        a.update(key('k', KeyModifiers::NONE)); // back to unit
        assert!(a.testing_files.is_empty());
    }

    #[test]
    fn testing_r_runs_only_on_file_column() {
        let mut a = App::new();
        a.update(key('7', KeyModifiers::NONE));
        a.set_testing(vec![test_domain("unit")]);
        // On the domain column `r` is not a run key (and no relaunch armed).
        assert_eq!(a.update(key('r', KeyModifiers::NONE)), Action::None);
        a.update(Event::TestingFiles {
            domain_id: "unit".into(),
            files: vec!["a.test.ts".into()],
        });
        match a.update(key('r', KeyModifiers::NONE)) {
            Action::RunTest { file, .. } => assert_eq!(file, "a.test.ts"),
            other => panic!("expected RunTest, got {other:?}"),
        }
        // An error result still resolves the pane (status from exit fallback).
        a.update(Event::TestRunDone {
            file: "a.test.ts".into(),
            result: crate::models::TestRunResult {
                status: String::new(),
                exit_code: 1,
                output: "boom".into(),
                ..Default::default()
            },
        });
        let run = a.test_run.as_ref().unwrap();
        assert_eq!(run.status, "exit 1");
        assert!(!run.running);
    }

    // ─── Operator dock (operator-always-visible-2026-06-05, Brief 24) ───

    #[test]
    fn operator_dock_o_opens_focuses_then_blurs() {
        let mut a = App::new();
        a.tab = Tab::Plans;
        assert!(!a.operator_dock_open && !a.operator_dock_focused);
        a.update(key('o', KeyModifiers::NONE)); // open + focus
        assert!(a.operator_dock_open && a.operator_dock_focused);
        a.update(key('o', KeyModifiers::NONE)); // blur, stays open/visible
        assert!(a.operator_dock_open && !a.operator_dock_focused);
    }

    #[test]
    fn operator_dock_shift_o_toggles_visibility_and_clears_focus() {
        let mut a = App::new();
        a.tab = Tab::Plans;
        a.update(key('o', KeyModifiers::NONE)); // open + focus
        a.update(key('O', KeyModifiers::SHIFT)); // hide → clears focus
        assert!(!a.operator_dock_open && !a.operator_dock_focused);
        a.update(key('O', KeyModifiers::SHIFT)); // re-open (unfocused)
        assert!(a.operator_dock_open && !a.operator_dock_focused);
    }

    #[test]
    fn operator_dock_esc_blurs_but_stays_visible() {
        let mut a = App::new();
        a.tab = Tab::Plans;
        a.update(key('o', KeyModifiers::NONE));
        assert!(a.operator_dock_focused);
        a.update(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(!a.operator_dock_focused);
        assert!(a.operator_dock_open);
    }

    #[test]
    fn operator_dock_o_is_noop_on_operator_tab() {
        let mut a = App::new();
        a.tab = Tab::Operator; // the whole tab is already the chat
        a.update(key('o', KeyModifiers::NONE));
        assert!(!a.operator_dock_open && !a.operator_dock_focused);
    }

    #[test]
    fn operator_dock_focused_routes_compose_and_send() {
        let mut a = App::new();
        a.tab = Tab::Plans;
        a.update(key('o', KeyModifiers::NONE)); // open + focus
        a.update(key('i', KeyModifiers::NONE)); // compose into the dock
        assert!(a.chat_composing);
        a.update(key('h', KeyModifiers::NONE));
        a.update(key('i', KeyModifiers::NONE)); // types (compose capture), not re-focus
        assert_eq!(a.chat_input, "hi");
        let act = a.update(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert_eq!(act, Action::SendChat("hi".to_string()));
        assert_eq!(a.chat_input, "");
    }

    #[test]
    fn operator_dock_focused_routes_scroll_not_tab_nav() {
        let mut a = App::new();
        a.tab = Tab::Plans;
        a.plans = vec![plan("one"), plan("two"), plan("three")];
        a.update(key('o', KeyModifiers::NONE)); // focus the dock
        let sel = a.plan_sel;
        a.update(key('k', KeyModifiers::NONE)); // into history
        assert_eq!(a.chat_scroll, 1);
        assert_eq!(a.plan_sel, sel); // tab list NOT moved
        a.update(key('j', KeyModifiers::NONE)); // toward latest
        assert_eq!(a.chat_scroll, 0);
        assert_eq!(a.plan_sel, sel);
    }

    #[test]
    fn operator_dock_unfocused_lets_tab_nav_through() {
        let mut a = App::new();
        a.tab = Tab::Plans;
        a.plans = vec![plan("one"), plan("two"), plan("three")];
        a.operator_dock_open = true; // visible but NOT focused
                                     // The unfocused dock lets keys reach the Plans tab's two-level nav (owner
                                     // ask 2026-06-16): Enter drills into the list pane, then j moves the
                                     // selection — and the chat is never scrolled.
        let before = a.plan_sel;
        a.update(ev(KeyCode::Enter)); // → inside the list pane
        a.update(key('j', KeyModifiers::NONE)); // moves the Plans selection
        assert_eq!(a.plan_sel, before + 1);
        assert_eq!(a.chat_scroll, 0); // chat untouched
    }

    #[test]
    fn operator_dock_focused_enables_voice_key() {
        let mut a = App::new();
        a.tab = Tab::Plans;
        assert!(!a.voice_key_active()); // off on a plain tab
        a.update(key('o', KeyModifiers::NONE)); // focus the dock
        assert!(a.voice_key_active()); // v PTT now accepted in the dock
    }

    #[test]
    fn operator_dock_tab_switch_works_while_focused() {
        let mut a = App::new();
        a.tab = Tab::Plans;
        a.update(key('o', KeyModifiers::NONE)); // focus the dock
        a.update(key('2', KeyModifiers::NONE)); // '2' = Inbox — never trapped
        assert_eq!(a.tab, Tab::Inbox);
        assert!(a.operator_dock_focused); // focus follows the user across tabs
    }

    #[test]
    fn operator_dock_open_persists_through_view_state() {
        let mut a = App::new();
        a.tab = Tab::Plans;
        a.update(key('o', KeyModifiers::NONE)); // open
        let vs = a.capture_view_state();
        assert!(vs.operator_dock_open);
        let mut b = App::new();
        b.apply_view_state(&vs);
        assert!(b.operator_dock_open);
    }

    // ─── Reactive workbench panes (pui-reactive-session-panes D-006, P-008 wiring) ───

    /// A pending workbench launch as the roster's `pending` tier delivers it,
    /// stamped with `host` so the LOCAL predicate matches `a.local_host`.
    fn pending_launch(a: &App, id: i64, agent: &str) -> RosterEntry {
        RosterEntry {
            owner_id: format!("pending:adv:{id}"),
            host: a.local_host.clone(),
            liveness: "pending".into(),
            agent: Some(agent.into()),
            adv_session_id: Some(id),
            has_launch_record: true,
            display: Some("workbench".into()),
            launch_argv: vec![
                "psu".into(),
                "--no-picker".into(),
                format!("--agent={agent}"),
            ],
            ..Default::default()
        }
    }

    #[test]
    fn roster_pending_workbench_emits_launch_panes_and_tracks_it() {
        let mut a = App::new();
        a.reactive_launch_panes = true; // EI-358: tests run as a launch-capable mode
        let p = pending_launch(&a, 607, "claude");
        let act = a.update(Event::Roster {
            active: vec![],
            pending: vec![p],
        });
        match act {
            Action::LaunchPanes { sessions, bees } => {
                assert_eq!(sessions.len(), 1);
                assert!(bees.is_empty());
                assert_eq!(sessions[0].adv_session_id, 607);
                assert_eq!(
                    sessions[0].spec.argv,
                    vec!["psu", "--no-picker", "--agent=claude"]
                );
            }
            other => panic!("expected LaunchPanes, got {other:?}"),
        }
        assert!(a.tracked_panes.contains(&607));
    }

    #[test]
    fn dock_chat_pane_opens_bee_panes_for_active_agents() {
        // The dock agent stack (hive-agent-tabs P-004): one `claude --resume`
        // bee pane per live fleet bee with a resumable session id; dedup'd;
        // pruned when the agent leaves so a returning bee re-panes.
        let mut a = App::new();
        a.dock_agent_panes = true;
        let bee = |o: &str| RosterEntry {
            owner_id: o.into(),
            label: format!("bee · {o}"),
            source: "fleet-spawn".into(),
            liveness: "live".into(),
            agent: Some("claude".into()),
            session_id: Some(format!("sid-{o}")),
            ..Default::default()
        };
        // An engineer shell (omp-hook-session) is NEVER paned — bees only.
        let shell = RosterEntry {
            owner_id: "su-shell".into(),
            source: "omp-hook-session".into(),
            liveness: "live".into(),
            ..Default::default()
        };
        let act = a.update(Event::Roster {
            active: vec![bee("su-aaa"), bee("su-bbb"), shell],
            pending: vec![],
        });
        match act {
            Action::LaunchPanes { sessions, bees } => {
                assert!(sessions.is_empty());
                assert_eq!(bees.len(), 2);
                assert_eq!(bees[0].argv, vec!["claude", "--resume", "sid-su-aaa"]);
                assert!(bees[0].stacked);
                assert!(bees[0].close_on_exit);
            }
            other => panic!("expected LaunchPanes, got {other:?}"),
        }
        // Same roster again → all watched → plain Render (no re-open).
        let act = a.update(Event::Roster {
            active: vec![bee("su-aaa"), bee("su-bbb")],
            pending: vec![],
        });
        assert_eq!(act, Action::Render);
        // su-bbb leaves → pruned; when it returns it re-panes.
        let _ = a.update(Event::Roster {
            active: vec![bee("su-aaa")],
            pending: vec![],
        });
        assert!(!a.paned_bees.contains("su-bbb"));
        match a.update(Event::Roster {
            active: vec![bee("su-aaa"), bee("su-bbb")],
            pending: vec![],
        }) {
            Action::LaunchPanes { bees, .. } => {
                assert_eq!(bees.len(), 1);
                assert_eq!(bees[0].argv[2], "sid-su-bbb");
            }
            other => panic!("expected LaunchPanes, got {other:?}"),
        }
    }

    /// EI-358: a board pane (reactive_launch_panes = false — watch/wake/
    /// prompt/mail/work/network/hive) must NEVER react to pending launches;
    /// only the full TUI / chat-pane / dock-driver may (and claim-then-open
    /// settles races among those).
    #[test]
    fn board_pane_never_emits_launch_panes() {
        let mut a = App::new(); // reactive_launch_panes defaults to false
        let p = pending_launch(&a, 608, "claude");
        let act = a.update(Event::Roster {
            active: vec![],
            pending: vec![p],
        });
        assert!(
            !matches!(act, Action::LaunchPanes { ref sessions, .. } if !sessions.is_empty()),
            "board pane reacted to a pending launch: {act:?}"
        );
        assert!(a.tracked_panes.is_empty());
    }

    #[test]
    fn roster_refresh_does_not_reopen_a_tracked_pane() {
        let mut a = App::new();
        a.reactive_launch_panes = true; // EI-358: tests run as a launch-capable mode
        let p = pending_launch(&a, 607, "claude");
        let _ = a.update(Event::Roster {
            active: vec![],
            pending: vec![p.clone()],
        });
        // Same pending entry on the next refresh → dedup → just Render, no reopen.
        let act = a.update(Event::Roster {
            active: vec![],
            pending: vec![p],
        });
        assert_eq!(act, Action::Render);
        assert_eq!(a.tracked_panes.len(), 1);
    }

    #[test]
    fn roster_remote_pending_launch_is_not_paned() {
        let mut a = App::new();
        let mut p = pending_launch(&a, 607, "claude");
        p.host = "some-other-host".into();
        let act = a.update(Event::Roster {
            active: vec![],
            pending: vec![p],
        });
        assert_eq!(act, Action::Render);
        assert!(a.tracked_panes.is_empty());
    }

    #[test]
    fn roster_with_no_pending_just_renders() {
        let mut a = App::new();
        let act = a.update(Event::Roster {
            active: vec![],
            pending: vec![],
        });
        assert_eq!(act, Action::Render);
        assert!(a.tracked_panes.is_empty());
    }

    // --- Fleet comms-overlay navigation (owner ask 2026-06-14) ---

    fn comms_mail(kind: &str, from: &str, summary: &str) -> crate::models::BeeMailEntry {
        crate::models::BeeMailEntry {
            ts: "2026-06-14T04:00:00Z".into(),
            msg_id: "m".into(),
            kind: kind.into(),
            from: Some(from.into()),
            to: vec!["bee-1".into()],
            summary: Some(summary.into()),
            body: Some(format!("full body of {summary}")),
        }
    }

    fn comms_conv(id: &str) -> crate::models::ConvSummary {
        crate::models::ConvSummary {
            id: id.into(),
            kind: "question".into(),
            state: "open".into(),
            scope: "fleet".into(),
            harness_slug: None,
            title: Some(format!("conv {id}")),
            asker_id: "asker".into(),
            topics: vec![],
            promoted_issue_id: None,
            created_ts: "2026-06-14".into(),
        }
    }

    /// A Fleet tab with the comms overlay open + a selected bee carrying two
    /// inbox / one outbox entries and two fleet conversations.
    fn comms_app() -> App {
        let mut a = App::new();
        a.tab = Tab::Fleet;
        a.fleet.show_comms = true;
        a.bee.mail = Some(crate::models::BeeMailPayload {
            owner_id: "bee-1".into(),
            inbox: crate::models::BeeMailSide {
                total: 2,
                entries: vec![
                    comms_mail("message", "a", "i0"),
                    comms_mail("escalation", "b", "i1"),
                ],
            },
            outbox: crate::models::BeeMailSide {
                total: 1,
                entries: vec![comms_mail("message", "bee-1", "o0")],
            },
        });
        a.conversations = vec![comms_conv("c0"), comms_conv("c1")];
        a
    }

    #[test]
    fn fleet_hl_cycles_comms_panels() {
        use crate::fleet::FleetPanel;
        let mut a = comms_app(); // show_comms = true
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Roster);
        // l / → step forward through Roster→Inbox→Outbox→Conversations and wrap.
        a.update(ev(KeyCode::Char('l')));
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Inbox);
        a.update(ev(KeyCode::Right));
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Outbox);
        a.update(ev(KeyCode::Char('l')));
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Conversations);
        a.update(ev(KeyCode::Char('l'))); // wraps back to the roster
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Roster);
        // h / ← step backward (wrapping to the last panel).
        a.update(ev(KeyCode::Char('h')));
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Conversations);
        a.update(ev(KeyCode::Left));
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Outbox);
    }

    #[test]
    fn fleet_jk_moves_within_panel_no_fallthrough() {
        use crate::fleet::FleetPanel;
        let mut a = comms_app();
        a.fleet.entered = true; // inside the panes → ↑/↓ move within (←/→ keep switching)
        a.update(ev(KeyCode::Char('l'))); // Inbox (2 items)
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(
            (a.fleet.fleet_focus, a.fleet.comms_inbox_sel),
            (FleetPanel::Inbox, 1)
        );
        a.update(ev(KeyCode::Char('j'))); // CLAMP — stays on inbox, no fall-through
        assert_eq!(
            (a.fleet.fleet_focus, a.fleet.comms_inbox_sel),
            (FleetPanel::Inbox, 1)
        );
        // Outbox/conversations are reached by CYCLING (l), not by scrolling off.
        a.update(ev(KeyCode::Char('l'))); // Outbox (1 item)
        a.update(ev(KeyCode::Char('j'))); // clamp at 0
        assert_eq!(
            (a.fleet.fleet_focus, a.fleet.comms_outbox_sel),
            (FleetPanel::Outbox, 0)
        );
        a.update(ev(KeyCode::Char('l'))); // Conversations (2)
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(
            (a.fleet.fleet_focus, a.conversation_sel),
            (FleetPanel::Conversations, 1)
        );
        a.update(ev(KeyCode::Char('k')));
        assert_eq!(a.conversation_sel, 0);
    }

    #[test]
    fn fleet_two_level_nav_browse_enter_within_esc() {
        // Owner ask 2026-06-15 #2: ↑/↓ switch panes while BROWSING; Enter drills
        // INTO the focused pane; then ↑/↓ move within; Esc steps back out.
        use crate::fleet::FleetPanel;
        let mut a = App::new();
        a.tab = Tab::Fleet; // comms off → Roster · Dossier · PlanProgress
        let mut p1 = plan("plan-a");
        p1.item_counts = crate::models::ItemCounts {
            todo: 2,
            done: 1,
            ..Default::default()
        };
        let mut p2 = plan("plan-b");
        p2.item_counts = crate::models::ItemCounts {
            todo: 1,
            done: 1,
            ..Default::default()
        };
        a.set_plans(vec![p1, p2]);
        assert!(!a.fleet.entered);
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Roster);
        // Browsing: ↓ switches panes (does NOT move a cursor).
        a.update(ev(KeyCode::Down));
        assert_eq!(
            (a.fleet.fleet_focus, a.fleet.entered),
            (FleetPanel::Dossier, false)
        );
        a.update(ev(KeyCode::Down));
        assert_eq!(
            (a.fleet.fleet_focus, a.fleet.entered),
            (FleetPanel::PlanProgress, false)
        );
        // Enter drills into the focused pane (no popup yet — just enters).
        a.update(ev(KeyCode::Enter));
        assert!(a.fleet.entered);
        assert!(!a.fleet_detail_open);
        // Inside: ↓ now moves the plan selection within plan-progress.
        assert_eq!(a.fleet.plan_progress_sel, 0);
        a.update(ev(KeyCode::Down));
        assert_eq!(a.fleet.plan_progress_sel, 1);
        // Esc steps back out to browsing (does NOT clear anything else yet).
        a.update(ev(KeyCode::Esc));
        assert!(!a.fleet.entered);
        // Browsing again: ↓ switches panes (wraps Roster → …).
        a.update(ev(KeyCode::Down));
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Roster);
    }

    #[test]
    fn fleet_default_view_cycles_dossier_cursor_and_plan_select() {
        use crate::fleet::FleetPanel;
        let mut a = App::new();
        a.tab = Tab::Fleet; // comms OFF (default) → Roster → Dossier → PlanProgress
                            // Two live plans so the plan-progress list is non-empty + selectable.
        let mut p1 = plan("plan-a");
        p1.item_counts = crate::models::ItemCounts {
            todo: 2,
            done: 1,
            ..Default::default()
        };
        let mut p2 = plan("plan-b");
        p2.item_counts = crate::models::ItemCounts {
            todo: 1,
            done: 1,
            ..Default::default()
        };
        a.set_plans(vec![p1, p2]);
        // Whole-fleet dossier (no agent selected) with 3 tasks → a non-empty,
        // selectable worklist (owner ask 2026-06-16: cursor, not bare scroll).
        a.fleet.all_assignments = vec![crate::models::BeeAssignment {
            agent_id: "su-a".into(),
            load: 3,
            queued: (0..3)
                .map(|i| crate::models::BeeWorkItem {
                    id: format!("WI-{i}"),
                    title: format!("task {i}"),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }];
        a.fleet.entered = true; // inside the panes → ↑/↓ move within (←/→ keep switching)
        assert!(!a.fleet.show_comms);
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Roster);
        a.update(ev(KeyCode::Char('l')));
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Dossier);
        // j/k move a SELECTION cursor over the 3 tasks (skipping the bee header),
        // clamped — not a bare scroll.
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(a.fleet.dossier_sel, 1);
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(a.fleet.dossier_sel, 2);
        a.update(ev(KeyCode::Char('j'))); // clamp at the last task
        assert_eq!(a.fleet.dossier_sel, 2);
        a.update(ev(KeyCode::Char('k')));
        assert_eq!(a.fleet.dossier_sel, 1);
        a.update(ev(KeyCode::Char('l'))); // → PlanProgress
        assert_eq!(a.fleet.fleet_focus, FleetPanel::PlanProgress);
        // j/k now move a SELECTION cursor over the plan list (2 plans), clamped.
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(a.fleet.plan_progress_sel, 1);
        a.update(ev(KeyCode::Char('j'))); // clamp at the last plan
        assert_eq!(a.fleet.plan_progress_sel, 1);
        a.update(ev(KeyCode::Char('k')));
        assert_eq!(a.fleet.plan_progress_sel, 0);
        a.update(ev(KeyCode::Char('l'))); // wrap → Roster
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Roster);
    }

    #[test]
    fn fleet_dossier_enter_opens_work_item_detail_and_steps() {
        // Owner ask 2026-06-16: the worklist Enter opens the selected work item's
        // detail popup; j/k step the task cursor within the modal; Esc closes.
        use crate::fleet::FleetPanel;
        let mut a = App::new();
        a.tab = Tab::Fleet;
        a.fleet.all_assignments = vec![crate::models::BeeAssignment {
            agent_id: "su-a".into(),
            load: 2,
            queued: vec![
                crate::models::BeeWorkItem {
                    id: "WI-1".into(),
                    title: "first task".into(),
                    status: Some("wip".into()),
                    ..Default::default()
                },
                crate::models::BeeWorkItem {
                    id: "WI-2".into(),
                    title: "second task".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }];
        a.fleet.entered = true;
        a.update(ev(KeyCode::Char('l'))); // → Dossier
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Dossier);
        assert!(!a.fleet_detail_open);
        a.update(ev(KeyCode::Enter)); // opens the selected work item's detail
        assert!(a.fleet_detail_open);
        // The popup body names the selected (cursor 0) work item.
        let body: String = crate::fleet::dossier_detail_lines(&a)
            .iter()
            .flat_map(|l| l.spans.iter())
            .map(|s| s.content.as_ref())
            .collect();
        assert!(
            body.contains("first task"),
            "popup should name the selected work item: {body}"
        );
        // Modal: j steps the task cursor; an unrelated key is swallowed.
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(a.fleet.dossier_sel, 1);
        a.update(ev(KeyCode::Char('x')));
        assert!(a.fleet_detail_open);
        a.update(ev(KeyCode::Esc));
        assert!(!a.fleet_detail_open);
    }

    /// One plan-item-states fixture for the Plans Items-pane tests.
    fn item_states(plan: &str, ids: &[&str]) -> crate::models::PlanItemStates {
        crate::models::PlanItemStates {
            harness: "papercup".into(),
            plan: plan.into(),
            harness_liveness_mode: "availability".into(),
            items: ids
                .iter()
                .map(|id| crate::models::PlanItemState {
                    item_id: (*id).into(),
                    item_status: Some("todo".into()),
                    ..Default::default()
                })
                .collect(),
        }
    }

    #[test]
    fn plans_tab_two_level_nav_list_and_items_with_detail() {
        // Owner ask 2026-06-16: the Plans tab gains Colony-style two-level nav —
        // ←/→ switch the plans-list ↔ work-items panes, Enter drills in, ↑/↓ move
        // within, Enter opens that row's detail popup, Esc steps back out.
        use crate::app::PlansFocus;
        let mut a = App::new();
        a.tab = Tab::Plans;
        let mut p1 = plan("plan-x");
        p1.item_counts = crate::models::ItemCounts {
            todo: 2,
            done: 1,
            ..Default::default()
        };
        a.set_plans(vec![p1, plan("plan-y")]);
        a.plan_item_states = Some(item_states("plan-x", &["P-001", "P-002", "P-003"]));
        assert!(!a.plans_entered);
        assert_eq!(a.plans_focus, PlansFocus::List);
        // Enter drills into the focused (list) pane — no popup yet.
        a.update(ev(KeyCode::Enter));
        assert!(a.plans_entered);
        assert!(!a.fleet_detail_open);
        // Inside the list: ↓ moves the plan selection.
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(a.plan_sel, 1);
        assert_eq!(a.selected_plan().unwrap().slug, "plan-y");
        // ←/→ (arrow-only on the in-app tab — `h` stays Overview) switches to the
        // work-items pane at any level.
        a.update(ev(KeyCode::Right));
        assert_eq!(a.plans_focus, PlansFocus::Items);
        // Re-select plan-x to get its loaded items.
        a.update(ev(KeyCode::Left)); // back to list
        a.update(ev(KeyCode::Char('k'))); // plan_sel → 0 (plan-x)
        assert_eq!(a.plan_sel, 0);
        a.plan_item_states = Some(item_states("plan-x", &["P-001", "P-002", "P-003"]));
        a.update(ev(KeyCode::Right)); // → Items
        assert_eq!(a.plans_focus, PlansFocus::Items);
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(a.plan_items_sel, 1);
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(a.plan_items_sel, 2);
        a.update(ev(KeyCode::Char('j'))); // clamp at the last item
        assert_eq!(a.plan_items_sel, 2);
        // Enter opens the work-item detail popup; j steps within it.
        a.update(ev(KeyCode::Enter));
        assert!(a.fleet_detail_open);
        assert_eq!(a.selected_plan_item().unwrap().item_id, "P-003");
        a.update(ev(KeyCode::Char('k')));
        assert_eq!(a.plan_items_sel, 1);
        a.update(ev(KeyCode::Esc)); // close popup
        assert!(!a.fleet_detail_open);
        // Esc steps out of the entered pane back to browsing.
        a.update(ev(KeyCode::Esc));
        assert!(!a.plans_entered);
    }

    #[test]
    fn plans_board_two_level_nav_list_and_items_with_detail() {
        // Owner ask 2026-06-16: the dock's plans-pane (Tab::PlansBoard) — the
        // "plans tab" the user sees in the dock — gains the same two-level nav.
        use crate::app::PlansFocus;
        let mut a = App::new();
        a.tab = Tab::PlansBoard;
        let mut p1 = plan("board-a");
        p1.item_counts = crate::models::ItemCounts {
            todo: 2,
            done: 1,
            ..Default::default()
        };
        a.set_plans(vec![p1, plan("board-b")]);
        assert_eq!(a.plans_focus, PlansFocus::List);
        assert!(!a.plans_entered);
        // ↑/↓ while browsing switch panes (list ↔ items).
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(a.plans_focus, PlansFocus::Items);
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(a.plans_focus, PlansFocus::List);
        // Enter drills into the list pane (no popup yet).
        a.update(ev(KeyCode::Enter));
        assert!(a.plans_entered);
        assert!(!a.fleet_detail_open);
        // Inside the list: ↓ moves the board cursor.
        let before = a.plans_board_sel;
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(a.plans_board_sel, before + 1);
        // Enter opens the plan detail popup; Esc closes it.
        a.update(ev(KeyCode::Enter));
        assert!(a.fleet_detail_open);
        a.update(ev(KeyCode::Esc));
        assert!(!a.fleet_detail_open);
        // ←/→ to the items pane; with the selected board plan's items loaded, ↓
        // moves the work-item cursor and Enter opens the item detail.
        let slug = a.selected_board_plan().unwrap().1;
        a.plan_item_states = Some(item_states(&slug, &["P-001", "P-002"]));
        a.update(ev(KeyCode::Char('l')));
        assert_eq!(a.plans_focus, PlansFocus::Items);
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(a.plan_items_sel, 1);
        a.update(ev(KeyCode::Enter));
        assert!(a.fleet_detail_open);
        assert_eq!(a.selected_plan_item().unwrap().item_id, "P-002");
        a.update(ev(KeyCode::Esc));
        assert!(!a.fleet_detail_open);
        // Esc steps out of the entered pane.
        a.update(ev(KeyCode::Esc));
        assert!(!a.plans_entered);
    }

    #[test]
    fn plan_progress_enter_opens_detail_popup_and_steps_plans() {
        use crate::fleet::FleetPanel;
        let mut a = App::new();
        a.tab = Tab::Fleet; // default (comms-off) view
        let mut p1 = plan("plan-alpha");
        p1.item_counts = crate::models::ItemCounts {
            todo: 3,
            done: 2,
            ..Default::default()
        };
        let mut p2 = plan("plan-beta");
        p2.item_counts = crate::models::ItemCounts {
            todo: 1,
            wip: 1,
            ..Default::default()
        };
        a.set_plans(vec![p1, p2]);
        a.fleet.entered = true; // inside the panes → ←/→ switch, ⏎ opens, ↑/↓ within
                                // Cycle focus to the plan-progress panel (Roster → Dossier → PlanProgress).
        a.update(ev(KeyCode::Char('l')));
        a.update(ev(KeyCode::Char('l')));
        assert_eq!(a.fleet.fleet_focus, FleetPanel::PlanProgress);
        // Enter opens the detail popup for the highlighted plan.
        assert!(!a.fleet_detail_open);
        a.update(ev(KeyCode::Enter));
        assert!(a.fleet_detail_open);
        // The popup body describes the selected plan (sel 0 → most remaining first).
        let body: String = crate::fleet::plan_detail_lines(&a)
            .iter()
            .flat_map(|l| l.spans.iter())
            .map(|s| s.content.as_ref())
            .collect();
        assert!(
            body.contains("plan-alpha"),
            "popup should name the selected plan: {body}"
        );
        // Modal: j steps to the next plan WITHIN the popup; an unrelated key is
        // swallowed (can't drive the dock underneath).
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(a.fleet.plan_progress_sel, 1);
        a.update(ev(KeyCode::Char('x')));
        assert!(a.fleet_detail_open);
        // Esc closes it.
        a.update(ev(KeyCode::Esc));
        assert!(!a.fleet_detail_open);
    }

    #[test]
    fn comms_roster_move_resets_mail_cursor() {
        use crate::fleet::FleetPanel;
        let mut a = comms_app();
        a.set_roster(vec![
            fleet_bee("bee-1", "claude"),
            fleet_bee("bee-2", "claude"),
        ]);
        a.fleet.comms_inbox_sel = 1;
        a.fleet.comms_outbox_sel = 1;
        a.fleet.entered = true; // inside the roster → j moves its cursor
                                // Roster holds focus → j moves the roster cursor and resets the mail cursors
                                // (a new agent has new mail).
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Roster);
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(a.fleet.comms_inbox_sel, 0);
        assert_eq!(a.fleet.comms_outbox_sel, 0);
    }

    #[test]
    fn comms_enter_opens_detail_and_esc_closes() {
        let mut a = comms_app();
        a.fleet.entered = true; // inside the panes → Enter opens the focused item
        a.update(ev(KeyCode::Char('l'))); // focus Inbox
        assert!(!a.fleet_detail_open);
        a.update(ev(KeyCode::Enter));
        assert!(a.fleet_detail_open);
        assert!(a.selected_comms_mail().is_some());
        // Modal: a non-navigation key is swallowed, popup stays open.
        a.update(ev(KeyCode::Char('x')));
        assert!(a.fleet_detail_open);
        // Esc closes it.
        a.update(ev(KeyCode::Esc));
        assert!(!a.fleet_detail_open);
    }

    #[test]
    fn comms_enter_on_conversation_fetches_and_opens() {
        use crate::fleet::FleetPanel;
        let mut a = comms_app();
        a.fleet.fleet_focus = FleetPanel::Conversations;
        a.fleet.entered = true; // inside the conversations pane → Enter opens the thread
        let act = a.update(ev(KeyCode::Enter));
        assert!(a.fleet_detail_open);
        assert!(matches!(act, Action::FetchConversationDetail { .. }));
    }

    #[test]
    fn fleet_detail_step_stays_within_focused_panel() {
        use crate::fleet::FleetPanel;
        let mut a = comms_app();
        a.fleet.entered = true; // inside the panes
        a.update(ev(KeyCode::Char('l'))); // Inbox
        a.update(ev(KeyCode::Enter)); // open popup
                                      // j/k inside the popup step within the inbox only — no fall-through.
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(
            (a.fleet.fleet_focus, a.fleet.comms_inbox_sel),
            (FleetPanel::Inbox, 1)
        );
        a.update(ev(KeyCode::Char('j'))); // clamp (inbox has 2)
        assert_eq!(
            (a.fleet.fleet_focus, a.fleet.comms_inbox_sel),
            (FleetPanel::Inbox, 1)
        );
        a.update(ev(KeyCode::Char('k')));
        assert_eq!(a.fleet.comms_inbox_sel, 0);
        assert!(a.fleet_detail_open);
    }

    #[test]
    fn comms_toggle_resets_focus_to_roster() {
        use crate::fleet::FleetPanel;
        let mut a = comms_app();
        a.fleet.fleet_focus = FleetPanel::Inbox;
        a.update(ev(KeyCode::Char('c'))); // toggle comms OFF
        assert!(!a.fleet.show_comms);
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Roster);
        assert!(!a.fleet_detail_open);
        // Toggling back ON also lands on the roster (a known starting place).
        a.update(ev(KeyCode::Char('c')));
        assert!(a.fleet.show_comms);
        assert_eq!(a.fleet.fleet_focus, FleetPanel::Roster);
    }

    #[test]
    fn fleet_detail_popup_is_modal_swallows_other_keys() {
        // While the detail popup is open, unrelated keys (e.g. `c`/`n`) are
        // swallowed so they can't drive the dock underneath — Esc closes first.
        let mut a = comms_app();
        a.fleet.entered = true; // inside the panes
        a.update(ev(KeyCode::Char('l')));
        a.update(ev(KeyCode::Enter)); // open the popup
        assert!(a.fleet_detail_open);
        let show_before = a.fleet.show_comms;
        a.update(ev(KeyCode::Char('c'))); // swallowed — does NOT toggle comms
        assert!(a.fleet_detail_open);
        assert_eq!(a.fleet.show_comms, show_before);
    }

    #[test]
    fn fleet_detail_scroll_pages_and_resets_on_item_change() {
        let mut a = comms_app();
        a.fleet.entered = true; // inside the panes
        a.update(ev(KeyCode::Char('l'))); // Inbox
        a.update(ev(KeyCode::Enter)); // open popup
        assert_eq!(a.fleet_detail_scroll, 0);
        a.update(ev(KeyCode::PageDown));
        assert_eq!(a.fleet_detail_scroll, FLEET_DETAIL_SCROLL_STEP);
        a.update(ev(KeyCode::PageDown));
        assert_eq!(a.fleet_detail_scroll, 2 * FLEET_DETAIL_SCROLL_STEP);
        a.update(ev(KeyCode::PageUp));
        assert_eq!(a.fleet_detail_scroll, FLEET_DETAIL_SCROLL_STEP);
        // Stepping to another item resets the scroll to the top.
        a.update(ev(KeyCode::Char('j')));
        assert_eq!(a.fleet_detail_scroll, 0);
        // PageUp saturates at 0 (no underflow).
        a.update(ev(KeyCode::PageUp));
        assert_eq!(a.fleet_detail_scroll, 0);
    }
}
