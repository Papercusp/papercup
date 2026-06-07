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

/// What the run-loop should do after handling one event.
/// (No `Eq`: `VoiceChan(VoiceCmd)` carries a `serde_json::Value` for prefs
/// patches, which isn't `Eq`. `PartialEq` is all the run loop needs.)
#[derive(Debug, PartialEq)]
pub enum Action {
    None,
    /// A pui docs action (harness-docs-integration P-009): POST regenerate|verify
    /// for the selected doc. The run loop fires it; the refetch loop refreshes the
    /// badges on its next tick.
    DocsAction { action: String, doc_id: String },
    Render,
    /// Publish the swarm pane's bee selection to the ephemeral relay
    /// (pui-bee-dossier-pane-2026-06-06) so the bee-dossier pane can render it.
    /// The run loop POSTs `fleet:selected_bee { select }`. `owner_id` None clears.
    PublishBeeSelection { owner_id: Option<String>, name: Option<String> },
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
        /// Read-only `pui watch-pane <owner>` panes for active swarm agents —
        /// appended to the dock stack (pui-dock-agent-stack-2026-06-07). Opened
        /// via the zellij CLI only (no companion / no mark-launched).
        watch: Vec<crate::mux::PaneSpec>,
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
    /// Edit the fleet's hard cap from the Overview top-bar (Brief 23 P-005) —
    /// the run loop PUTs `/api/operator/rate-limit-config` then refetches the
    /// read-model (the reducer already updated the local copy optimistically).
    SetMaxAgents(u32),
    /// Start the realtime EL Conv-AI voice session (voice-realtime-tui P-007)
    /// — the run loop spawns the session task and owns the handle.
    VoiceSessionStart,
    /// Tear the realtime voice session down (user toggle).
    VoiceSessionStop,
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
    /// Watch-pane chat (pui-dock-agent-stack): send the composer draft to the
    /// watched bee via coord:message-agent → `Event::BeeMessageSent`.
    SendBeeMessage { to: String, body: String },
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
    pub hive_sel: usize,
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
    /// Fleet "no reachable session" action menu (pui-workbench-usability D-002).
    /// `Some` while Enter on an unreachable agent has surfaced the `[r]/[n]/[f]`
    /// choices; the next `r`/`n`/`f`/Esc closes it. Captures keys while open.
    pub fleet_action_menu: Option<FleetActionMenu>,
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
    /// Watch pane (pui-dock-agent-stack-2026-06-07): the owner id of the ONE
    /// swarm agent this instance renders read-only (dossier + activity + mail).
    /// `None` = a normal tabbed/pinned instance.
    pub watch: Option<String>,
    /// Consecutive roster refreshes the watched agent has been absent/stale —
    /// at 2 the watch pane exits (its `--close-on-exit` pane then closes).
    pub watch_misses: u8,
    /// The watched bee's accumulated raw output (the "thinking" feed) — a
    /// capped ring fed by the bee-output poll; newest at the END.
    pub watch_output: String,
    /// The bee-output poll cursor (byte offset into the spawn's .out file).
    pub watch_output_offset: u64,
    /// The watch pane's chat composer draft (Enter sends via
    /// coord:message-agent; Esc clears).
    pub watch_input: String,
    /// True while a chat send is in flight (composer locked).
    pub watch_sending: bool,
    /// True only in the dock's chat-pane: drive the reactive agent stack (a
    /// watch pane per active bee + an interactive pane per new local launch).
    pub dock_agent_panes: bool,
    /// Owner ids the dock has already opened a watch pane for (dedup; pruned
    /// when the agent leaves the roster so a returning bee re-panes).
    pub watched_panes: std::collections::HashSet<String>,
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
            plan_item_states: None,
            roster: Vec::new(),
            tracked_panes: crate::session_panes::TrackedPanes::new(),
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
            show_tutorial: false,
            tutorial_step: 0,
            notifs: Vec::new(),
            toast: None,
            show_notifs: false,
            unseen_notifs: 0,
            notif_seq: 0,
            fleet_action_menu: None,
            topology: None,
            hud_pane_id: None,
            companion_version: None,
            relaunch_command: None,
            fleet: FleetState::default(),
            bee: crate::bee::BeeState::default(),
            watch: None,
            watch_misses: 0,
            watch_output: String::new(),
            watch_output_offset: 0,
            watch_input: String::new(),
            watch_sending: false,
            dock_agent_panes: false,
            watched_panes: std::collections::HashSet::new(),
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
            operator_dock_open: false,
            operator_dock_focused: false,
            voice_phase: VoicePhase::Idle,
            convai_phase: ConvAiPhase::Off,
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
    pub fn push_notif(&mut self, n: Notif) {
        self.toast = Some(n.clone());
        self.notifs.insert(0, n);
        self.notifs.truncate(NOTIF_HISTORY_CAP);
        self.unseen_notifs += 1;
        self.notif_seq += 1;
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
        self.roster
            .iter()
            .filter(|r| {
                self.plan_filter.is_empty()
                    || r.current_plan_slug
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .is_none_or(|s| self.plan_filter.contains(s))
            })
            .collect()
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
        }
    }

    /// Restore a persisted view-state on startup (P12 / D-002). Selections are
    /// set directly and re-clamped when each tab's data arrives; the active
    /// harness is republished so the poller fetches the right harness's data.
    pub fn apply_view_state(&mut self, vs: &ViewState) {
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

    /// The dock agent stack's watch panes to open THIS roster refresh
    /// (pui-dock-agent-stack-2026-06-07): one `pui watch-pane <owner>` per
    /// running FLEET BEE (`source == "fleet-spawn"` — Queen/orchestrator
    /// spawns; engineer shells and the brain are NOT paned — owner ask) not
    /// yet paned. Prunes departed owners from the dedup set so a returning
    /// bee re-panes; interactive launch panes are excluded via `tracked_panes`.
    fn watch_panes_to_open(&mut self) -> Vec<crate::mux::PaneSpec> {
        let is_bee = |r: &crate::models::RosterEntry| r.is_live() && r.source == "fleet-spawn";
        let live: std::collections::HashSet<&str> = self
            .roster
            .iter()
            .filter(|r| is_bee(r))
            .map(|r| r.owner_id.as_str())
            .collect();
        self.watched_panes.retain(|o| live.contains(o.as_str()));
        let mut out = Vec::new();
        for r in &self.roster {
            if !is_bee(r) || self.watched_panes.contains(&r.owner_id) {
                continue;
            }
            // Already an interactive pane in this dock (a reactive launch).
            if r.adv_session_id.is_some_and(|id| self.tracked_panes.contains(&id)) {
                continue;
            }
            let title = r
                .agent
                .clone()
                .filter(|a| !a.is_empty())
                .map(|a| format!("{} · {}", a, short_owner(&r.owner_id)))
                .unwrap_or_else(|| r.label.clone());
            out.push(
                crate::mux::PaneSpec::new(["pui", "watch-pane", r.owner_id.as_str()])
                    .titled(title)
                    .stacked_autoclose(),
            );
        }
        for spec in &out {
            if let Some(owner) = spec.argv.get(2) {
                self.watched_panes.insert(owner.clone());
            }
        }
        out
    }

    /// Watch pane exit rule: the watched agent has been absent/stale for 2
    /// consecutive roster refreshes (one miss can be churn; two is gone).
    pub fn watch_should_exit(&self) -> bool {
        self.watch.is_some() && self.watch_misses >= 2
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

    /// Enter on a Fleet-roster agent (D-001/D-002). Resolves the agent's location
    /// and acts: focus a local pane, focus an external window, resume an ended
    /// session, or open the `[r]/[n]/[f]` menu. With no agent selected (empty
    /// roster) Enter is a no-op render — the empty-work-area hint already tells
    /// the user to press `n`.
    fn fleet_enter(&mut self) -> Action {
        let Some(entry) = self.selected_session().cloned() else {
            return Action::Render;
        };
        match self.resolve_agent_route(&entry) {
            AgentRoute::LocalPane { pane_id } => Action::FocusLocalPane { pane_id },
            AgentRoute::FocusWindow {
                adv_session_id,
                pid,
                window_id,
            } => Action::FocusWindow {
                adv_session_id,
                pid,
                window_id,
                label: entry.label.clone(),
            },
            AgentRoute::Resume { spec } => {
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
            Some(title) => format!(
                "{panes} {n} panes · {} {title}",
                crate::glyph::action::RUN
            ),
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
                // Watch pane (pui-dock-agent-stack-2026-06-07): track the watched
                // agent's roster presence; after 2 consecutive misses the run
                // loop exits this instance. A watch pane never opens panes.
                if let Some(w) = &self.watch {
                    let present = self.roster.iter().any(|r| &r.owner_id == w && !r.stale);
                    self.watch_misses = if present {
                        0
                    } else {
                        self.watch_misses.saturating_add(1)
                    };
                    return Action::Render;
                }
                // Reactively open work-area panes for new LOCAL workbench launches
                // (pui-reactive-session-panes D-006). The pure diff returns the
                // panes to open; record their ids so a refresh in the mark-launched
                // window can't re-open, and hand the specs to the run loop (I/O).
                let mut to_open =
                    crate::session_panes::panes_to_open(&self.tracked_panes, &pending, &self.local_host);
                // The dock's agent stack (pui-dock-agent-stack-2026-06-07): one
                // read-only watch pane per active swarm agent, so the user
                // scrolls through ALL active agents in the dock.
                let watch = if self.dock_agent_panes {
                    for p in &mut to_open {
                        // Interactive launch panes join the dock stack too.
                        p.spec.stacked = true;
                    }
                    self.watch_panes_to_open()
                } else {
                    Vec::new()
                };
                if to_open.is_empty() && watch.is_empty() {
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
                        watch,
                    }
                }
            }
            Event::FleetRate(s) => {
                self.fleet_rate = Some(s);
                Action::Render
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
                        self.push_notif(Notif {
                            level: "attention".into(),
                            message: reason,
                            harness: None,
                            ts: None,
                        });
                    }
                    U::Error(e) => {
                        self.convai_phase = ConvAiPhase::Off;
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
                Action::Render
            }
            Event::BeeOutput {
                owner,
                offset,
                chunk,
            } => {
                // Appended raw output from the watched bee. Stale-guarded on
                // owner; capped ring so a chatty agent can't grow the pane.
                if self.watch.as_deref() == Some(owner.as_str()) {
                    self.watch_output_offset = offset;
                    if !chunk.is_empty() {
                        self.watch_output.push_str(&chunk);
                        const CAP: usize = 64 * 1024;
                        if self.watch_output.len() > CAP {
                            let cut = self.watch_output.len() - CAP;
                            // keep char boundary
                            let cut = (cut..self.watch_output.len())
                                .find(|i| self.watch_output.is_char_boundary(*i))
                                .unwrap_or(cut);
                            self.watch_output.drain(..cut);
                        }
                    }
                }
                Action::Render
            }
            Event::BeeMessageSent(res) => {
                self.watch_sending = false;
                match res {
                    Ok(()) => self.push_notif(Notif {
                        level: "info".into(),
                        message: "sent — the bee replies in-thread (inbox below)".into(),
                        harness: None,
                        ts: None,
                    }),
                    Err(e) => self.push_notif(Notif {
                        level: "error".into(),
                        message: format!("send failed: {e}"),
                        harness: None,
                        ts: None,
                    }),
                }
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
                self.apply_view_state(&vs);
                // Restore may land us on the Plans tab — publish so the poller fetches
                // the selected plan's item-states on first paint (P-005a).
                self.publish_active_plan();
                Action::Render
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
            // --- Companion zellij plugin (P-004 / D-008) ---
            Event::CompanionReady(version) => {
                self.companion_version = Some(version);
                self.last_error = None;
                Action::Render
            }
            Event::Topology(t) => {
                self.topology = Some(t);
                Action::Render
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
        // Watch pane (pui-dock-agent-stack): the pane IS a chat-with-this-bee
        // surface — printable keys type into the composer, Enter sends (a
        // durable coord:message-agent thread + ping), Esc clears the draft.
        // Ctrl+C still quits (handled by the caller before on_key).
        if self.watch.is_some() {
            match code {
                KeyCode::Char(c) if !mods.contains(KeyModifiers::CONTROL) => {
                    self.watch_input.push(c);
                    return Action::Render;
                }
                KeyCode::Backspace => {
                    self.watch_input.pop();
                    return Action::Render;
                }
                KeyCode::Esc => {
                    self.watch_input.clear();
                    return Action::Render;
                }
                KeyCode::Enter => {
                    let body = self.watch_input.trim().to_string();
                    if body.is_empty() || self.watch_sending {
                        return Action::Render;
                    }
                    self.watch_sending = true;
                    self.watch_input.clear();
                    return Action::SendBeeMessage {
                        to: self.watch.clone().expect("watch checked above"),
                        body,
                    };
                }
                _ => return Action::None,
            }
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
                // On the Memory tab, Esc first clears an active search back to
                // the full list (D-006); else dismiss the transient toast.
                if self.tab == Tab::Memory && self.memory_hits.is_some() {
                    self.memory_hits = None;
                    self.memory_sel = 0;
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
                    Action::VoiceSessionStop
                }
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
            KeyCode::Enter if self.tab == Tab::Fleet => self.fleet_enter(),
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
            // Plugins tab (D-007/D-014): in Panes focus, Enter launches the
            // selected pane (original D-002 behavior); in List focus, Enter
            // loads the selected plugin's per-harness config for the settings
            // view (no-op when the plugin has no configSchema).
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
            // Testing run-on-click (D-004a): Enter drills into a domain's files /
            // runs the selected file; `r` is the run alias on the file column
            // (placed BEFORE the global relaunch `r` so it wins on this tab).
            KeyCode::Enter if self.tab == Tab::Testing => self.testing_activate(),
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
                    let action = if source == "manual" { "verify" } else { "regenerate" };
                    Action::DocsAction { action: action.to_string(), doc_id: doc }
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
                // to the bee-dossier relay (pui-bee-dossier-pane-2026-06-06).
                if self.tab == Tab::Fleet {
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
            // Config has no list, and the Voice tab owns its own j/k in voice_ui.
            Tab::Config | Tab::Operator | Tab::Voice => return,
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
            Tab::Config | Tab::Operator | Tab::Voice => return,
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
        a.update(Event::VoiceUi(VE::Stream(VoiceEvent::Status(VoiceStatus {
            channel: Some(VoiceChannelInfo {
                id: "vc-1".into(),
                name: "standup".into(),
            }),
            muted: false,
            peers: vec![],
            agent_speaking: false,
        }))));
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
        assert!(a.bee.assignment.is_none(), "stale dossier cleared on new selection");
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
            TermForms { one: "Swarm".into(), other: "Swarms".into() },
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
    fn enter_outside_plugins_tab_is_noop() {
        let mut a = App::new();
        a.update(key('3', KeyModifiers::NONE)); // leave the default Operator tab → Plans
        a.set_panes(vec![pane("Logs", "p", "/r", &["sh"])]);
        // On the Plans tab, Enter doesn't launch (on Operator it focuses the composer).
        assert_eq!(
            a.update(Event::Key(KeyEvent::new(
                KeyCode::Enter,
                KeyModifiers::NONE
            ))),
            Action::None
        );
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
                pane(10, "tab-bar", None, true), // plugin → not work
                pane(11, "pui", Some("pui hud"), false), // the HUD → not work
                pane(12, "claude", Some("psu --agent=claude"), false),
                pane(13, "codex", Some("psu --agent=codex"), false),
            ],
        }
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
            Some(PaletteCommand::Dock { side: "left".into() })
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
        assert_eq!(a.on_key(KeyCode::Enter, KeyModifiers::empty()), Action::Render);
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
            Action::Dock(DockCmd::SelectLayout { name: "grid".into() })
        );
    }

    #[test]
    fn palette_enter_float_unknown_target_errors() {
        let mut a = App::new();
        a.topology = Some(dock_topology());
        a.palette_open = true;
        a.palette_input = ":float zzz".to_string();
        assert_eq!(a.on_key(KeyCode::Enter, KeyModifiers::empty()), Action::Render);
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
        assert_eq!(a.update(key('V', KeyModifiers::SHIFT)), Action::VoiceSessionStart);
        assert_eq!(a.convai_phase, ConvAiPhase::Connecting);
        // Session connects → Live (+ a toast) and the shared thread id
        // backfills the app's conversation pointer (voice-first session).
        a.update(Event::ConvAi(U::Connected { conversation_id: "conv_1".into() }));
        assert_eq!(a.convai_phase, ConvAiPhase::Live);
        assert_eq!(a.conversation_id.as_deref(), Some("conv_1"));
        // V again stops.
        assert_eq!(a.update(key('V', KeyModifiers::SHIFT)), Action::VoiceSessionStop);
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
        a.update(Event::ConvAi(U::Ended { reason: "voice session closed".into() }));
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
        let before = a.plan_sel;
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
        let p = pending_launch(&a, 607, "claude");
        let act = a.update(Event::Roster {
            active: vec![],
            pending: vec![p],
        });
        match act {
            Action::LaunchPanes { sessions, watch } => {
                assert_eq!(sessions.len(), 1);
                assert!(watch.is_empty());
                assert_eq!(sessions[0].adv_session_id, 607);
                assert_eq!(sessions[0].spec.argv, vec!["psu", "--no-picker", "--agent=claude"]);
            }
            other => panic!("expected LaunchPanes, got {other:?}"),
        }
        assert!(a.tracked_panes.contains(&607));
    }

    #[test]
    fn dock_chat_pane_opens_watch_panes_for_active_agents() {
        // The dock agent stack (pui-dock-agent-stack-2026-06-07): one read-only
        // watch pane per live agent; dedup'd; pruned when the agent leaves so a
        // returning bee re-panes.
        let mut a = App::new();
        a.dock_agent_panes = true;
        let bee = |o: &str| RosterEntry {
            owner_id: o.into(),
            label: format!("bee · {o}"),
            source: "fleet-spawn".into(),
            liveness: "live".into(),
            agent: Some("claude".into()),
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
            Action::LaunchPanes { sessions, watch } => {
                assert!(sessions.is_empty());
                assert_eq!(watch.len(), 2);
                assert_eq!(watch[0].argv, vec!["pui", "watch-pane", "su-aaa"]);
                assert!(watch[0].stacked);
                assert!(watch[0].close_on_exit);
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
        assert!(!a.watched_panes.contains("su-bbb"));
        match a.update(Event::Roster {
            active: vec![bee("su-aaa"), bee("su-bbb")],
            pending: vec![],
        }) {
            Action::LaunchPanes { watch, .. } => {
                assert_eq!(watch.len(), 1);
                assert_eq!(watch[0].argv[2], "su-bbb");
            }
            other => panic!("expected LaunchPanes, got {other:?}"),
        }
    }

    #[test]
    fn watch_composer_types_sends_and_clears() {
        // The watch pane IS a chat surface: printable keys draft, Enter sends
        // a coord:message-agent thread, Esc clears (pui-dock-agent-stack).
        let mut a = App::new();
        a.watch = Some("s-bee1".into());
        a.update(key('h', KeyModifiers::NONE));
        a.update(key('i', KeyModifiers::NONE));
        assert_eq!(a.watch_input, "hi");
        a.update(Event::Key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE)));
        assert_eq!(a.watch_input, "h");
        a.update(key('i', KeyModifiers::NONE));
        match a.update(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))) {
            Action::SendBeeMessage { to, body } => {
                assert_eq!(to, "s-bee1");
                assert_eq!(body, "hi");
            }
            other => panic!("expected SendBeeMessage, got {other:?}"),
        }
        assert!(a.watch_input.is_empty());
        assert!(a.watch_sending);
        // While sending, Enter on a new draft is a no-op (composer locked).
        a.update(key('x', KeyModifiers::NONE));
        assert_eq!(
            a.update(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))),
            Action::Render
        );
        // The send result unlocks + toasts.
        a.update(Event::BeeMessageSent(Ok(())));
        assert!(!a.watch_sending);
        // Esc clears the draft.
        a.update(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(a.watch_input.is_empty());
    }

    #[test]
    fn bee_output_accumulates_capped_and_stale_guarded() {
        let mut a = App::new();
        a.watch = Some("s-bee1".into());
        a.update(Event::BeeOutput {
            owner: "s-bee1".into(),
            offset: 5,
            chunk: "think".into(),
        });
        assert_eq!(a.watch_output, "think");
        assert_eq!(a.watch_output_offset, 5);
        // A chunk for a DIFFERENT owner is dropped (stale guard).
        a.update(Event::BeeOutput {
            owner: "s-other".into(),
            offset: 99,
            chunk: "noise".into(),
        });
        assert_eq!(a.watch_output, "think");
        assert_eq!(a.watch_output_offset, 5);
        // The ring caps at 64KB, keeping the TAIL.
        a.update(Event::BeeOutput {
            owner: "s-bee1".into(),
            offset: 70_000,
            chunk: "x".repeat(70_000),
        });
        assert_eq!(a.watch_output.len(), 64 * 1024);
        assert!(a.watch_output.ends_with('x'));
    }

    #[test]
    fn watch_pane_tracks_misses_and_exits_after_two() {
        // `pui watch-pane <owner>` exits once its agent has been gone for two
        // consecutive roster refreshes (one miss can be churn) — and NEVER
        // opens panes itself.
        let mut a = App::new();
        a.watch = Some("su-w".into());
        let live = RosterEntry {
            owner_id: "su-w".into(),
            liveness: "live".into(),
            ..Default::default()
        };
        a.update(Event::Roster {
            active: vec![live.clone()],
            pending: vec![],
        });
        assert!(!a.watch_should_exit());
        a.update(Event::Roster {
            active: vec![],
            pending: vec![],
        });
        assert!(!a.watch_should_exit()); // one miss — churn tolerance
        a.update(Event::Roster {
            active: vec![],
            pending: vec![],
        });
        assert!(a.watch_should_exit()); // two misses — gone
        a.watch_misses = 0;
        let act = a.update(Event::Roster {
            active: vec![live],
            pending: vec![],
        });
        assert_eq!(act, Action::Render);
    }

    #[test]
    fn roster_refresh_does_not_reopen_a_tracked_pane() {
        let mut a = App::new();
        let p = pending_launch(&a, 607, "claude");
        let _ = a.update(Event::Roster { active: vec![], pending: vec![p.clone()] });
        // Same pending entry on the next refresh → dedup → just Render, no reopen.
        let act = a.update(Event::Roster { active: vec![], pending: vec![p] });
        assert_eq!(act, Action::Render);
        assert_eq!(a.tracked_panes.len(), 1);
    }

    #[test]
    fn roster_remote_pending_launch_is_not_paned() {
        let mut a = App::new();
        let mut p = pending_launch(&a, 607, "claude");
        p.host = "some-other-host".into();
        let act = a.update(Event::Roster { active: vec![], pending: vec![p] });
        assert_eq!(act, Action::Render);
        assert!(a.tracked_panes.is_empty());
    }

    #[test]
    fn roster_with_no_pending_just_renders() {
        let mut a = App::new();
        let act = a.update(Event::Roster { active: vec![], pending: vec![] });
        assert_eq!(act, Action::Render);
        assert!(a.tracked_panes.is_empty());
    }
}
