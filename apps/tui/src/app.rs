//! Application state + the single update reducer (SP-TUI A2 / P1 Create tab).
//!
//! `App` is the whole UI state; `update` is the only mutator. Rendering is a
//! pure function of `&App` (see `ui.rs`), so views are snapshot-testable.

use crate::event::Event;
use crate::fleet::FleetState;
use crate::models::{
    ActivityRow, AttentionItem, ChatMessage, ChatToolCall, CrewMember, CuratedSignal,
    DocsResponse, EffectiveClaudeSettings, FlagsResponse, HarnessFeature, HarnessIssue,
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

/// What the run-loop should do after handling one event.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    None,
    Render,
    Quit,
    /// Open a native agent session in a new multiplexer pane.
    Launch(PaneSpec),
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
    /// Send a user message to the operator (tui-operator-surface P1) — the run
    /// loop persists the user turn, opens the converse SSE stream, and feeds
    /// `ChatDelta`/`ChatToolCall`/`ChatDone`/`ChatError` events back. The string
    /// is the message text (the reducer has already appended it + a streaming
    /// assistant bubble before returning this).
    SendChat(String),
    /// Focus a worker's zellij pane via the companion (tui-operator-surface P2 —
    /// the `focus_pane` tui:dispatch intent). The run loop drives the companion
    /// and POSTs the intent result back.
    FocusPane { intent_id: i64, pane_id: u32 },
    /// Fetch the next older page of operator turns (load-earlier / scroll-back).
    /// The reducer already set `chat_loading_earlier`; the run loop snapshots the
    /// conversation id + oldest cursor from App.
    LoadEarlierChat,
    /// Fetch the selected testing domain's runnable files (D-004a) — the run
    /// loop spawns the domain-detail fetch; results return as
    /// `Event::TestingFiles` (stale-guarded by domain id).
    FetchTestingFiles { harness: String, domain_id: String },
    /// Run one test file via `POST /api/harness/:slug/testing/run` (D-004a).
    /// The reducer already marked the run in-flight; the result returns as
    /// `Event::TestRunDone`.
    RunTest { harness: String, file: String },
    /// Semantic memory search (D-006 Step 2) — the run loop calls the
    /// `memory:search` tool; hits return as `Event::MemoryHits`.
    SearchMemory { query: String, harness: String },
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
    LoadPluginConfig { harness: String, plugin: String },
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
    FetchCupboard { kind: String, query: String },
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
    /// `:create <slug> <path-or-github-url>` (D-010) — register a new pot via
    /// `POST /api/harness/projects` (local dir or GitHub clone).
    CreatePot { slug: String, source: String },
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
    ConfigSet { key: String, value: String },
    /// `:unset <key.path>` — remove a key from the settings file (D-013).
    ConfigUnset { key: String },
    /// `:pset <key.path> <value>` — edit the SELECTED plugin's config (D-014).
    /// The plugin is resolved from `plugin_sel` in the palette-Enter handler.
    PluginSet { key: String, value: String },
    /// `:punset <key.path>` — remove a key from the selected plugin's config.
    PluginUnset { key: String },
}

/// Parse a command-palette line into a `PaletteCommand` (None = unknown). A
/// leading ':' is tolerated. Pure — unit-tested.
pub fn parse_palette_command(input: &str) -> Option<PaletteCommand> {
    let line = input.trim().strip_prefix(':').unwrap_or(input.trim()).trim();
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
                Some(item) => Some(PaletteCommand::PickupPlanItem { harness: None, plan: Some(first), item }),
                None => Some(PaletteCommand::PickupPlanItem { harness: None, plan: None, item: first }),
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
            Some(PaletteCommand::SharePot { slug, remote, public })
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
pub fn edit_json_path(root: &mut Value, path: &str, mut value: Option<Value>) -> Result<(), String> {
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
/// **Pots** and `Tab::Fleet` titles as **Brew** (cup-theme naming, RFC D-014).
/// Order + switch keys are the single source of truth — `draw_tabs` labels and
/// the keyboard dispatch both derive from `ALL` + `switch_key` (g1: no dual map).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    /// Operator chat pane (tui-operator-surface-2026-06-04) — the conversational
    /// front door + the default startup tab; leads the strip (D-002, key '1').
    Operator,
    Inbox,
    Plans,
    /// Brew — the fleet monitoring + agent-launch surface. `Tab::Fleet` is the
    /// stable variant; it titles as "Brew" (D-001) and absorbed the old Sessions
    /// launcher (D-002b: roster + dossier + n-launch fold into the fleet view).
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
}

impl Tab {
    // NOTE: the old Activity tab was RETIRED (D-004b): it mirrored the coarse
    // audit_log, and the Brew tab's mirror mode already rides the richer
    // `agent_activity` bridge — a re-point would have duplicated Brew exactly.
    pub const ALL: [Tab; 12] = [
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
    ];
    pub fn title(self) -> &'static str {
        match self {
            Tab::Operator => "Operator",
            Tab::Inbox => "Inbox",
            Tab::Plans => "Plans",
            // D-001 label-only renames (cup theme): Fleet→Brew, Harnesses→Pots.
            Tab::Fleet => "Brew",
            Tab::Harnesses => "Pots",
            Tab::Docs => "Docs",
            Tab::Testing => "Testing",
            Tab::Config => "Config",
            Tab::Plugins => "Plugins",
            Tab::Settings => "Settings",
            Tab::Memory => "Memory",
            Tab::Cupboard => "Cupboard",
        }
    }
    /// The keyboard shortcut that switches to this tab — the ONLY keymap (the
    /// dispatch in `on_key` derives from it, g1). Ten lead tabs take the ten
    /// digits (1-9, 0); appended tabs take a mnemonic letter (Memory → 'm',
    /// Cupboard → 'c').
    pub fn switch_key(self) -> char {
        match self {
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
    pub plans: Vec<PlanSummary>,
    pub plan_sel: usize,
    /// Merged plan-item assignment/claim/liveness for the SELECTED plan (P-005a),
    /// or None until fetched. Rendered in the Plans detail pane; the draw guards on
    /// `plan == selected_plan().slug` so a stale fetch never paints the wrong plan.
    pub plan_item_states: Option<PlanItemStates>,
    pub roster: Vec<RosterEntry>,
    pub inbox: Vec<AttentionItem>,
    pub inbox_sel: usize,
    /// Harnesses tab: the harness list + selection + the active harness's data.
    pub harnesses: Vec<HarnessRef>,
    pub harness_sel: usize,
    /// Active harness slug (display copy of `active_harness`).
    pub harness: String,
    /// POTS scope axis (D-003, matching the desktop's two-axis model): `?slug=`
    /// is WHICH pot is active (`harness`, always a real slug); this flag is HOW
    /// WIDE the global list tabs (Plans / Inbox / Brew) read — `true` = "All
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
    /// Plans-filter rail (D-009 — Inbox + Brew). `plan_filter` is the selected
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
    /// Live workbench topology from the companion zellij plugin (P-004 / D-008):
    /// which agent is in which pane + tab. `None` until the companion links;
    /// replaced wholesale on each snapshot (idempotent — no diff bookkeeping).
    pub topology: Option<Topology>,
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
    pub fn badge(self) -> &'static str {
        match self {
            VoicePhase::Idle => "",
            VoicePhase::Recording => "● REC",
            VoicePhase::Transcribing => "✎ transcribing",
            VoicePhase::Thinking => "… thinking",
            VoicePhase::Speaking => "♪ speaking",
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
            status: "pui · 1 operator · 4 brew · 1-0 tabs · j/k move · [/] pot · ? help · q quit".to_string(),
            // The operator chat is the default landing surface — the single pane
            // of glass for talking to the fleet (tui-operator-surface D-004).
            tab: Tab::Operator,
            plans: Vec::new(),
            plan_sel: 0,
            plan_item_states: None,
            roster: Vec::new(),
            inbox: Vec::new(),
            inbox_sel: 0,
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
            topology: None,
            companion_version: None,
            relaunch_command: None,
            fleet: FleetState::default(),
            chat_messages: Vec::new(),
            chat_input: String::new(),
            chat_composing: false,
            chat_scroll: 0,
            chat_streaming: false,
            conversation_id: None,
            chat_has_more_earlier: false,
            chat_oldest_seq: None,
            chat_loading_earlier: false,
            voice_phase: VoicePhase::Idle,
            voice_level: 0.0,
            voice_error: None,
        }
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
                m.content = format!("⚠ {err}");
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

    /// True when a `v` PTT keypress should be accepted on the Operator tab —
    /// only there, and never while composing a typed message.
    pub fn voice_key_active(&self) -> bool {
        self.tab == Tab::Operator && !self.chat_composing
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
                self.harness_sel =
                    self.harnesses.iter().position(|x| x.slug == self.harness).unwrap_or(0);
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
        self.inbox
            .iter()
            .filter(|i| self.in_scope(i.harness_slug.as_deref()))
            .filter(|i| {
                self.plan_filter.is_empty()
                    || i.plan_slug
                        .as_deref()
                        .is_some_and(|s| self.plan_filter.contains(s))
            })
            .collect()
    }

    /// The Brew roster under the plans filter (D-009) — `fleet.agent_sel`
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

    /// Fleet work-items under the current pot scope (Brew headline + rollup).
    pub fn visible_work_items(&self) -> Vec<&WorkItem> {
        self.fleet
            .work_items
            .iter()
            .filter(|w| self.in_scope(w.harness.as_deref()))
            .collect()
    }

    /// The Brew activity feed under the current pot scope (mirror mode).
    pub fn visible_fleet_activity(&self) -> Vec<&ActivityRow> {
        self.fleet
            .activity
            .iter()
            .filter(|a| self.in_scope(a.harness_slug.as_deref()))
            .collect()
    }

    /// The curator's signals under the current pot scope (Brew curated mode).
    pub fn visible_signals(&self) -> Vec<&CuratedSignal> {
        self.fleet
            .curated_signals
            .iter()
            .filter(|s| self.in_scope(s.harness.as_deref()))
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
            // Plans filter (D-009): set the slugs that narrow Inbox + the Brew
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
            // The Brew tab (fleet ⋃ the old Sessions launcher, D-002b) shares one
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
            // narrows the Inbox/Brew lists.
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

    /// The roster entry the Brew tab has selected (the single shared cursor,
    /// `fleet.agent_sel`, after the Sessions↦Brew merge — D-002b). Backs the
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
        let spec = PaneSpec::new(p.command.clone())
            .titled(format!("{} · {}", p.plugin_name, p.slug));
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
    /// companion plugin links, else `⚡ N panes` plus `▶ <title>` for the focused
    /// (terminal) pane so the HUD follows the live focus.
    pub fn workbench_summary(&self) -> Option<String> {
        self.companion_version.as_ref()?;
        let topo = self.topology.as_ref();
        let n = topo.map(|t| t.panes.len()).unwrap_or(0);
        let focused = topo
            .and_then(|t| t.panes.iter().find(|p| p.focused && !p.is_plugin))
            .map(|p| p.title.clone());
        Some(match focused {
            Some(title) => format!("⚡ {n} panes · ▶ {title}"),
            None => format!("⚡ {n} panes"),
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
            Event::Roster(r) => {
                self.set_roster(r);
                self.last_error = None;
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
                if self
                    .memory_hits
                    .as_ref()
                    .is_some_and(|(q, _)| *q == query)
                {
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
            Event::CuratedSignals(s) => {
                self.fleet.set_curated_signals(s);
                self.last_error = None;
                Action::Render
            }
            Event::CupboardListings { kind, query, listings } => {
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
            // A key RELEASE (kitty protocol only): releasing `v` while recording
            // ends hold-to-talk. Everything else ignores releases.
            Event::KeyRelease(key) => {
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
                        Some(PaletteCommand::PickupPlanItem { harness, plan, item }) => {
                            let plan = plan.or_else(|| self.selected_plan().map(|p| p.slug.clone()));
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
                                        message: "pickup: no plan selected — use :pickup <plan> <item>"
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
                                        message: "pset: no plugin selected (Plugins tab)".to_string(),
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
                                        message: "punset: no plugin selected (Plugins tab)".to_string(),
                                        harness: None,
                                        ts: None,
                                    });
                                    Action::Render
                                }
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
        if self.tab == Tab::Operator && self.chat_composing {
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
            // Launch a native agent pane from the Brew tab (the old Sessions
            // launcher, folded in — D-002b).
            KeyCode::Char('n') if self.tab == Tab::Fleet => Action::Launch(self.launch_spec()),
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
            KeyCode::Char('r') if self.relaunch_command.is_some() => {
                match self.relaunch_spec() {
                    Some(spec) => {
                        self.relaunch_command = None;
                        self.toast = None;
                        Action::Launch(spec)
                    }
                    None => Action::None,
                }
            }
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
            // Brew (fleet) curated ↔ mirror toggle (D-006). On `Tab`, mirroring
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
            Action::CupboardAct { listing: listing.clone() }
        } else {
            self.cupboard_confirm = Some(listing.id.clone());
            Action::Render
        }
    }

    fn move_sel(&mut self, delta: isize) {
        // Two phases: the visible LENGTH first (scope-filtered lists borrow
        // self immutably, D-003), then the cursor slot.
        let len = match self.tab {
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
            // No list to navigate — j/k scroll the transcript (Operator) handled
            // in on_key; Config has no list.
            Tab::Config | Tab::Operator => return,
        };
        if len == 0 {
            return;
        }
        let slot: &mut usize = match self.tab {
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
            Tab::Config | Tab::Operator => return,
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
        assert_ne!(a.update(key('v', KeyModifiers::NONE)), Action::Voice(VoiceCmd::Start));
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
        a.update(Event::Voice(crate::event::VoiceMsg::Transcribed("hello there".into())));
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
        a.update(Event::Voice(crate::event::VoiceMsg::Started(Err("no mic".into()))));
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
        // 3 Plans, 4 Brew (Fleet), 5 Pots (Harnesses).
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

    #[test]
    fn n_launches_on_brew_only() {
        // The agent launcher folded from Sessions into Brew (D-002b): `n` only
        // launches on the Brew (Fleet) tab.
        let mut a = App::new();
        a.update(key('3', KeyModifiers::NONE)); // Plans tab
        assert_eq!(a.update(key('n', KeyModifiers::NONE)), Action::None);
        a.update(key('4', KeyModifiers::NONE)); // Brew
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
            HarnessRef { slug: "papercup".into(), path: Some("/r/papercup".into()) },
            HarnessRef { slug: "restart".into(), path: Some("/r/restart".into()) },
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
            TestingDomain { id: "unit".into(), label: "Unit".into(), description: "d".into(), tier: "universal".into() },
            TestingDomain { id: "e2e".into(), label: "E2E".into(), description: "d".into(), tier: "project".into() },
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
            a.update(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))),
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
        match a.update(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))) {
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
            a.update(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))),
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
        });
        assert_eq!(a.doc_scroll, 0);
        a.update(Event::Key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE)));
        a.update(Event::Key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE)));
        assert_eq!(a.doc_scroll, 20);
        a.update(Event::Key(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE)));
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
        assert_eq!(a.tab, Tab::Operator); // swallowed (default tab is Operator)
        a.update(key(' ', KeyModifiers::NONE));
        assert_eq!(a.tutorial_step, 2);
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
        a.update(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        assert!(!a.palette_open);
        assert!(a.show_tutorial);
        assert_eq!(a.tutorial_step, 0); // restarts from the first page
    }

    #[test]
    fn plan_filter_rail_keys_toggle_clear_and_close() {
        // D-009: `F` opens the rail on Inbox/Brew; j/k move its cursor;
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
        // The Brew cursor + selected_session ride the filtered list.
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
            tabs: vec![TabNode { pos: 0, name: "papercup".into(), active: true }],
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
        assert_eq!(a.workbench_summary().as_deref(), Some("⚡ 1 panes · ▶ claude · F-1"));

        // A pane-exit raises a notification naming the pane, marks it exited, and
        // arms r-to-relaunch with the exited command.
        let before = a.notif_seq;
        a.update(Event::PaneExited { pane_id: 7, exit_code: Some(0) });
        assert!(a.notif_seq > before);
        assert!(a.toast.as_ref().unwrap().message.contains("claude · F-1"));
        assert!(a.toast.as_ref().unwrap().message.contains("relaunch"));
        assert_eq!(a.relaunch_command.as_deref(), Some("psu"));
        assert!(a.topology.as_ref().unwrap().panes[0].exited);

        // A pane-close drops it from the cached topology.
        a.update(Event::PaneClosed { pane_id: 7 });
        assert!(a.topology.as_ref().unwrap().panes.is_empty());
        assert_eq!(a.workbench_summary().as_deref(), Some("⚡ 0 panes"));
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
        a.update(Event::PaneExited { pane_id: 4, exit_code: Some(1) });
        assert_eq!(a.relaunch_command.as_deref(), Some("psu --no-picker --agent=claude"));
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
        a.update(Event::PaneExited { pane_id: 1, exit_code: Some(0) });
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
            tab: Some("Brew".into()),
            fleet_agent_sel: 5,
            ..Default::default()
        };
        a.update(Event::ViewStateLoaded(vs));
        assert_eq!(a.tab, Tab::Fleet); // "Brew" titles Tab::Fleet
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
        assert_eq!(v["tab"], "Brew");
        assert!(v["counts"]["plans"].is_number());
        assert_eq!(v["selections"]["plan"], 0);
    }

    #[test]
    fn intent_set_tab_switches_and_validates() {
        let mut a = App::new();
        a.apply_intent("set_tab", &serde_json::json!({"tab":"Docs"})).unwrap();
        assert_eq!(a.tab, Tab::Docs);
        assert!(a.apply_intent("set_tab", &serde_json::json!({"tab":"Nope"})).is_err());
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
        assert!(a.apply_intent("frobnicate", &serde_json::json!({})).is_err());
    }

    #[test]
    fn tui_intent_event_produces_result_action() {
        let mut a = App::new();
        match a.update(Event::TuiIntent {
            id: 42,
            intent: "get_state".into(),
            args: serde_json::json!({}),
        }) {
            Action::IntentResult { id, result_json, error } => {
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
        FlagsResponse { flags: m, source: "test-src".into() }
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
        assert_eq!(parse_palette_command("layouts"), Some(PaletteCommand::ListLayouts));
        assert_eq!(parse_palette_command(":crews"), Some(PaletteCommand::ListCrews));
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
        // Missing arg / unknown / empty → None.
        assert_eq!(parse_palette_command("save-crew"), None);
        assert_eq!(parse_palette_command("bogus"), None);
        assert_eq!(parse_palette_command(""), None);
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
            Some(PaletteCommand::SharePot { slug: "my-pot".into(), remote: None, public: false })
        );
        assert_eq!(
            parse_palette_command("share my-pot public"),
            Some(PaletteCommand::SharePot { slug: "my-pot".into(), remote: None, public: true })
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
        assert_eq!(a.on_key(KeyCode::Enter, KeyModifiers::empty()), Action::Render);
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
            Some(PaletteCommand::ConfigSet { key: "cleanupPeriodDays".into(), value: "60".into() })
        );
        // Value with spaces survives (splitn 2 on the key).
        assert_eq!(
            parse_palette_command(r#":set env.NAME some value"#),
            Some(PaletteCommand::ConfigSet { key: "env.NAME".into(), value: "some value".into() })
        );
        assert_eq!(parse_palette_command(":set model"), None); // value required
        assert_eq!(
            parse_palette_command(":unset env.FOO"),
            Some(PaletteCommand::ConfigUnset { key: "env.FOO".into() })
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
            Action::ConfigEdit { harness: "papercup".into(), key: "model".into(), value: None }
        );
    }

    #[test]
    fn config_value_parses_json_else_string() {
        assert_eq!(parse_config_value("60"), json!(60));
        assert_eq!(parse_config_value("true"), json!(true));
        assert_eq!(parse_config_value("null"), json!(null));
        assert_eq!(parse_config_value(r#"["a","b"]"#), json!(["a", "b"]));
        assert_eq!(parse_config_value(r#"{"x":1}"#), json!({ "x": 1 }));
        assert_eq!(parse_config_value("claude-opus-4-8"), json!("claude-opus-4-8"));
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
            kind: if family == "issue" { "bug".into() } else { "feature".into() },
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
        // Brew (Fleet) is digit '4' (D-002); the curated↔mirror toggle moved from
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
        // Tab only toggles the mode on the Brew tab (elsewhere it's column-switch
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
        a.update(key('4', KeyModifiers::NONE)); // Brew
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
            a.update(Event::ActivitySeed(vec![activity_row("su-a", "tool", "✎ x.rs")])),
            Action::Render
        );
        assert_eq!(a.fleet.activity.len(), 1);
        assert_eq!(
            a.update(Event::ActivityLive(activity_row("su-b", "tool", "▶ test"))),
            Action::Render
        );
        assert_eq!(a.fleet.activity.len(), 2);
        assert_eq!(a.fleet.activity[0].summary.as_deref(), Some("▶ test")); // prepended
        // The curator feed marks the surface available + stores the signals (P3).
        assert!(!a.fleet.curation_available);
        let sig = crate::models::CuratedSignal {
            id: "e1".into(),
            kind: "escalation".into(),
            title: "needs a human".into(),
            detail: None,
            harness: Some("papercup".into()),
            severity: None,
            disposition: "surface".into(),
            urgent: true,
            ts: "2026-06-04T00:00:00Z".into(),
        };
        assert_eq!(a.update(Event::CuratedSignals(vec![sig])), Action::Render);
        assert!(a.fleet.curation_available);
        assert_eq!(a.fleet.curated_signals.len(), 1);
        assert!(a.fleet.curated_signals[0].urgent);
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
    fn operator_is_default_tab_and_leads_strip() {
        let a = App::new();
        assert_eq!(a.tab, Tab::Operator); // D-004: the front door
        assert_eq!(Tab::Operator.switch_key(), '1'); // leads the strip (D-002)
        assert_eq!(Tab::Operator.title(), "Operator");
        assert_eq!(Tab::from_title("Operator"), Some(Tab::Operator));
        // Sessions folded into Brew (D-002b) + Activity retired (D-004b) → ten
        // digit tabs, plus the appended Memory ('m', D-006) + Cupboard ('c',
        // D-011) letter tabs.
        assert_eq!(Tab::ALL.len(), 12);
        assert_eq!(Tab::Memory.switch_key(), 'm');
        assert_eq!(Tab::Cupboard.switch_key(), 'c');
        // `1` returns to it from elsewhere.
        let mut b = App::new();
        b.update(key('3', KeyModifiers::NONE));
        assert_eq!(b.tab, Tab::Plans);
        b.update(key('1', KeyModifiers::NONE));
        assert_eq!(b.tab, Tab::Operator);
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
        a.update(key('i', KeyModifiers::NONE));
        assert!(a.chat_composing);
        a.update(ev(KeyCode::Esc));
        assert!(!a.chat_composing);
        // After leaving compose, digit keys switch tabs again.
        a.update(key('3', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Plans);
        // Ctrl-C quits even while composing (the universal escape hatch).
        let mut b = App::new();
        b.update(key('i', KeyModifiers::NONE));
        assert_eq!(b.update(key('c', KeyModifiers::CONTROL)), Action::Quit);
        assert!(b.should_quit);
        // A plain `q` typed while composing is just text, not quit.
        let mut c = App::new();
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
        a.update(Event::ChatToolCall(ChatToolCall { name: "harness:list".into() }));
        assert_eq!(a.chat_messages[1].tools.len(), 1);
        // Done finalizes: raw → the <say> body, streaming cleared.
        a.update(Event::ChatDone);
        assert!(!a.chat_streaming);
        assert!(!a.chat_messages[1].streaming);
        assert_eq!(a.chat_messages[1].content, "hello");
    }

    #[test]
    fn chat_error_finalizes_bubble_and_sets_status() {
        // Empty bubble → becomes the error note.
        let mut a = App::new();
        a.begin_user_send("hi");
        a.update(Event::ChatError("backend down".into()));
        assert!(!a.chat_streaming);
        assert_eq!(a.chat_messages[1].content, "⚠ backend down");
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
        let mut a = App::new(); // on Operator
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
            messages: vec![ChatMessage::user("older-1"), ChatMessage::assistant("older-2")],
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
        a.chat_messages = vec![
            ChatMessage::user("q1"),
            ChatMessage::assistant("a1"),
        ];
        a.begin_user_send("q2"); // pushes user q2 + an empty streaming bubble
        let h = a.chat_history_for_send();
        assert_eq!(h, vec![
            ("user".to_string(), "q1".to_string()),
            ("assistant".to_string(), "a1".to_string()),
            ("user".to_string(), "q2".to_string()),
        ]);
    }

    #[test]
    fn chat_scroll_keys_adjust_offset_and_delta_snaps_bottom() {
        let mut a = App::new(); // on Operator
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
            results: vec![mem("m1", "likes rust", "preference"), mem("m2", "tz is ET", "identity")],
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
        a.update(Event::MemoryHits { query: "stale".into(), results: vec![mem("x", "x", "project")] });
        assert!(a.visible_memories().is_empty()); // armed query, no hits yet
        a.update(Event::MemoryHits { query: "rust".into(), results: vec![mem("m1", "likes rust", "preference")] });
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
            HarnessRef { slug: "papercup".into(), path: None },
            HarnessRef { slug: "restart".into(), path: None },
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
        a.update(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        assert!(!a.pot_picker_open);
        assert!(!a.all_pots);
        assert_eq!(a.harness, "restart");
        assert_eq!(*a.active_harness.lock().unwrap(), "restart");
        // Re-open: the cursor sits on the active pot; Enter on "All Pots" widens.
        a.update(key('P', KeyModifiers::SHIFT));
        assert_eq!(a.pot_picker_sel, 2); // index 1 + harness_sel(1)
        a.update(key('k', KeyModifiers::NONE));
        a.update(key('k', KeyModifiers::NONE));
        a.update(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
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
        a.update(Event::TestingFiles { domain_id: "unit".into(), files: vec!["a.test.ts".into()] });
        assert!(a.testing_files.is_empty());
        assert_eq!(a.testing_focus, TestingFocus::Domains);
        // A matching fetch applies + focuses the file column.
        a.update(Event::TestingFiles { domain_id: "e2e".into(), files: vec!["x.spec.ts".into()] });
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
        a.update(Event::TestingFiles { domain_id: "unit".into(), files: vec!["a.test.ts".into()] });
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
}
