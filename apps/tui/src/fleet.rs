//! Fleet status view (pui-fleet-status-view-2026-06-04).
//!
//! The Fleet tab is the unified, fleet-wide dashboard the owner asked for —
//! "Claude's task panel, but with plan + subagent status, across the whole
//! fleet". It fuses four data sources:
//!   - **plan/work_item progress** — `app.plans` (itemCounts) + `work_items`.
//!   - **subagent status** — `app.roster` (coord presence), joined to each
//!     agent's latest activity + todo progress.
//!   - **a live activity overlay** — the worker-integration bridge stream
//!     (`/api/activity/stream`), seeded from `activity:recent`. Each row carries
//!     a server-enriched `summary` (`✎ generated.ts`, `▶ npm test`, `⇄ 3/5`).
//!   - **worker-todo mirroring** — the `kind:"todos"` activity rows, mapped to
//!     per-agent todo lists.
//!
//! Two modes (D-006): **curated** (default, calm — roster | dossier + plan
//! progress, whole-fleet by default, agent-filtered on selection, with a
//! `c`-toggled comms sub-view — pui-dock-consolidation-2026-06-07) and the
//! **faithful mirror** (the raw activity firehose). Both consume the same
//! stream; `Tab` toggles the mode.
//!
//! All state + render lives here; `app.rs`/`ui.rs` only hold a `fleet` field, a
//! `Tab::Fleet` arm, and a one-line `draw` delegation, so this barely collides
//! with the parallel pui work. Render is a pure function of `&App`.

use crate::app::App;
use crate::glyph;
use crate::models::{ActivityRow, TodoSnapshot, WorkItem};
use crate::theme::Theme;
use crate::ui::trunc;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    text::{Line, Span},
    widgets::{List, ListItem, ListState, Paragraph},
    Frame,
};
use std::collections::HashMap;

/// Retained live-activity rows (newest-first). The mirror feed firehose is
/// bounded so a busy fleet never grows the ring without limit (P1 risk: render
/// perf / memory).
const ACTIVITY_CAP: usize = 400;

/// Which Fleet view mode is showing (D-006). Curated is the calm default; the
/// mirror is the drill-in firehose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FleetMode {
    /// Per-agent latest + plan progress; the calm default.
    Curated,
    /// The raw fleet-wide activity feed (every tool call).
    Mirror,
}

impl FleetMode {
    pub fn label(self) -> &'static str {
        match self {
            FleetMode::Curated => "curated",
            FleetMode::Mirror => "mirror",
        }
    }
    /// Parse a persisted label back to a mode (unknown → Curated, the default).
    pub fn from_label(s: &str) -> FleetMode {
        match s {
            "mirror" => FleetMode::Mirror,
            _ => FleetMode::Curated,
        }
    }
}

/// Which panel of the comms sub-view holds keyboard focus (owner ask
/// 2026-06-14). Spatial nav: `h`/`l` (or ←/→) cross the Roster ↔ mail columns;
/// `j`/`k` walk the row cursor, falling through Inbox → Outbox → Conversations
/// at the list edges so the three stacked right-column panels stay reachable
/// with only the four keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommsFocus {
    Roster,
    Inbox,
    Outbox,
    Conversations,
}

/// Fleet-tab state: the live activity ring, the fleet work-items, per-agent todo
/// snapshots, the view mode, and the agent-selection cursor.
pub struct FleetState {
    pub mode: FleetMode,
    /// Live + backfilled activity rows, newest-first, capped at `ACTIVITY_CAP`.
    pub activity: Vec<ActivityRow>,
    /// Fleet-wide work items (features + issues + chunks).
    pub work_items: Vec<WorkItem>,
    /// Latest todo snapshot per worker (owner_id → snapshot), from `kind:"todos"`
    /// activity rows (D-004 worker-todo mirroring).
    pub agent_todos: HashMap<String, TodoSnapshot>,
    /// Selection cursor into the agent list (the roster).
    pub agent_sel: usize,
    /// Comms sub-view toggle (pui-dock-consolidation-2026-06-07, `c`): false =
    /// roster + dossier + plan-progress (default); true = roster + inbox/outbox
    /// (selected agent) over conversations (whole-fleet broadcasts + threads).
    pub show_comms: bool,
    /// Comms sub-view focus + per-panel row cursors (owner ask 2026-06-14):
    /// which of the four comms panels takes keys, and the cursor into the
    /// SELECTED bee's inbox/outbox (rendered newest-first, so index 0 = newest).
    /// The conversations panel reuses `App::conversation_sel`.
    pub comms_focus: CommsFocus,
    pub comms_inbox_sel: usize,
    pub comms_outbox_sel: usize,
    /// Whole-fleet assignments (every bee's ranked work-list), for the DEFAULT
    /// dossier when no agent is selected (#2: "show all tasks from the fleet").
    /// Refreshed on Fleet entry + periodically. A selection narrows to one bee's
    /// dossier (`app.bee`).
    pub all_assignments: Vec<crate::models::BeeAssignment>,
}

impl Default for FleetState {
    fn default() -> Self {
        Self {
            mode: FleetMode::Curated,
            activity: Vec::new(),
            work_items: Vec::new(),
            agent_todos: HashMap::new(),
            agent_sel: 0,
            show_comms: false,
            comms_focus: CommsFocus::Roster,
            comms_inbox_sel: 0,
            comms_outbox_sel: 0,
            all_assignments: Vec::new(),
        }
    }
}

impl FleetState {
    /// Toggle curated ↔ mirror (D-006).
    pub fn toggle_mode(&mut self) {
        self.mode = match self.mode {
            FleetMode::Curated => FleetMode::Mirror,
            FleetMode::Mirror => FleetMode::Curated,
        };
    }

    pub fn set_work_items(&mut self, items: Vec<WorkItem>) {
        self.work_items = items;
    }

    /// Replace the activity ring from a backfill (`activity:recent` returns
    /// newest-first), then ingest any todo snapshots it carries. Capped.
    pub fn seed_activity(&mut self, rows: Vec<ActivityRow>) {
        for r in &rows {
            self.ingest_todos(r);
        }
        self.activity = rows;
        self.activity.truncate(ACTIVITY_CAP);
    }

    /// Ingest a dedicated `kind:"todos"` backfill into the per-agent todo map
    /// WITHOUT touching the feed (todos are sparse; a kind-scoped fetch keeps the
    /// map current even when todo rows fall outside the general feed window).
    pub fn seed_todos(&mut self, rows: &[ActivityRow]) {
        for r in rows {
            self.ingest_todos(r);
        }
    }

    /// Prepend one live activity row (newest at index 0) + ingest todos. Capped.
    pub fn push_activity(&mut self, row: ActivityRow) {
        self.ingest_todos(&row);
        self.activity.insert(0, row);
        self.activity.truncate(ACTIVITY_CAP);
    }

    /// If `row` is a todo snapshot, record it as this agent's current todos.
    fn ingest_todos(&mut self, row: &ActivityRow) {
        if row.kind != "todos" {
            return;
        }
        if let Some(detail) = &row.detail {
            if let Ok(snap) = serde_json::from_value::<TodoSnapshot>(detail.clone()) {
                self.agent_todos.insert(row.owner_id.clone(), snap);
            }
        }
    }

    /// The most-recent activity row per `owner_id` (the ring is newest-first, so
    /// the first occurrence wins). Used to annotate each agent with what it's
    /// doing right now.
    pub fn latest_by_owner(&self) -> HashMap<&str, &ActivityRow> {
        let mut map: HashMap<&str, &ActivityRow> = HashMap::new();
        for r in &self.activity {
            map.entry(r.owner_id.as_str()).or_insert(r);
        }
        map
    }
}

/// A fleet-wide rollup computed at render time from plans + work-items + roster.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FleetAggregate {
    pub agents_online: usize,
    pub agents_total: usize,
    pub plan_items_done: u32,
    pub plan_items_total: u32,
    pub active_plans: usize,
    pub wi_total: usize,
    pub wi_features: usize,
    pub wi_issues: usize,
    pub wi_open_issues: usize,
    pub wi_features_passed: usize,
    /// Work items in a terminal/done state (features passed, issues resolved or
    /// closed) — the "done" half of D-002's work_item progress.
    pub wi_done: usize,
    /// Work items still open (total − done) — the "remaining" half.
    pub wi_remaining: usize,
}

/// Roll up the fleet headline numbers. Pure over `&App` (reads roster + plans +
/// fleet.work_items); no borrow of `app.fleet` is held mutably.
pub fn aggregate(app: &App) -> FleetAggregate {
    let agents_online = app.roster.iter().filter(|r| !r.stale).count();
    let agents_total = app.roster.len();

    // Plan progress across the live (non-archived) plans — under the current
    // pot scope (D-003): All-Pots aggregates everything, pot scope just it.
    let mut plan_items_done = 0u32;
    let mut plan_items_total = 0u32;
    let mut active_plans = 0usize;
    for p in app.visible_plans().into_iter().filter(|p| !p.archived) {
        let total = p.item_counts.total();
        if total > 0 {
            active_plans += 1;
        }
        plan_items_done += p.item_counts.done;
        plan_items_total += total;
    }

    let wi = app.visible_work_items();
    let wi_features = wi.iter().filter(|w| w.family == "feature").count();
    let wi_issues = wi.iter().filter(|w| w.family == "issue").count();
    let wi_open_issues = wi
        .iter()
        .filter(|w| w.family == "issue" && w.state == "open")
        .count();
    let wi_features_passed = wi
        .iter()
        .filter(|w| w.family == "feature" && w.state == "passed")
        .count();
    // Done = features passed + issues resolved/closed (the terminal states).
    let wi_issues_done = wi
        .iter()
        .filter(|w| w.family == "issue" && (w.state == "resolved" || w.state == "closed"))
        .count();
    let wi_done = wi_features_passed + wi_issues_done;
    let wi_remaining = wi.len().saturating_sub(wi_done);

    FleetAggregate {
        agents_online,
        agents_total,
        plan_items_done,
        plan_items_total,
        active_plans,
        wi_total: wi.len(),
        wi_features,
        wi_issues,
        wi_open_issues,
        wi_features_passed,
        wi_done,
        wi_remaining,
    }
}

/// The HH:MM:SS slice of a Postgres timestamp like `2026-06-04 18:53:58.46-04`.
/// Falls back to the raw string (clipped) for an unexpected shape.
fn hms(ts: &str) -> String {
    // Prefer the time component after the date's space; else after a 'T'.
    let time = ts
        .split_once(' ')
        .map(|(_, t)| t)
        .or_else(|| ts.split_once('T').map(|(_, t)| t))
        .unwrap_or(ts);
    let clock = time.split(['.', '-', '+', 'Z']).next().unwrap_or(time);
    let clock = clock.trim();
    if clock.is_empty() {
        trunc(ts, 8)
    } else {
        trunc(clock, 8)
    }
}

/// A fixed-width unicode progress bar, `done`/`total` filled over `width` cells.
fn progress_bar(done: u32, total: u32, width: usize) -> String {
    if total == 0 {
        return "─".repeat(width);
    }
    let filled = ((done as f64 / total as f64) * width as f64).round() as usize;
    let filled = filled.min(width);
    let mut s = String::with_capacity(width);
    for _ in 0..filled {
        s.push('█');
    }
    for _ in filled..width {
        s.push('░');
    }
    s
}

/// Render the Fleet tab. Pure over `&App`.
pub fn draw_fleet(f: &mut Frame, app: &App, area: Rect) {
    let agg = aggregate(app);

    // A 1-line headline strip above the body.
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(1)])
        .split(area);
    draw_headline(f, &agg, app.fleet.mode, rows[0]);

    // Comms sub-view (pui-dock-consolidation-2026-06-07, `c`): roster + the
    // selected agent's direct inbox/outbox over the whole-fleet conversations.
    // Off by default — the dossier + plan-progress view leads. Mirror mode keeps
    // its own raw feed.
    if app.fleet.show_comms && app.fleet.mode == FleetMode::Curated {
        draw_comms_view(f, app, rows[1]);
        return;
    }

    match app.fleet.mode {
        FleetMode::Curated => draw_curated(f, app, &agg, rows[1]),
        FleetMode::Mirror => draw_mirror(f, app, rows[1]),
    }
}

/// The comms sub-view (#3/#4): roster (left) | the selected agent's coord
/// **Inbox/Outbox** (right-top, direct messages — reused from `bee.rs`) over the
/// whole-fleet **Conversations** (right-bottom — broadcasts + multi-party
/// threads, the all-hands channel). The 3-way split (direct → inbox/outbox,
/// group → conversations, structured coord events → the dossier/swarm activity)
/// is how ALL fleet communication is captured.
fn draw_comms_view(f: &mut Frame, app: &App, area: Rect) {
    // The focused panel takes an active border + a highlighted row cursor; the
    // other three render quiet (owner ask 2026-06-14, `h`/`l`/`j`/`k` nav).
    let focus = app.fleet.comms_focus;
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(46), Constraint::Percentage(54)])
        .split(area);
    draw_agents(f, app, cols[0], focus == CommsFocus::Roster);

    let right = Layout::default()
        .direction(Direction::Vertical)
        // inbox + outbox share the top half; conversations take the bottom half.
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(cols[1]);
    let mail = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(right[0]);
    let inbox_sel = (focus == CommsFocus::Inbox).then_some(app.fleet.comms_inbox_sel);
    let outbox_sel = (focus == CommsFocus::Outbox).then_some(app.fleet.comms_outbox_sel);
    let conv_sel = (focus == CommsFocus::Conversations).then_some(app.conversation_sel);
    crate::bee::draw_inbox(f, app, mail[0], inbox_sel);
    crate::bee::draw_outbox(f, app, mail[1], outbox_sel);
    draw_conversations_compact(f, app, right[1], conv_sel);
}

/// Whole-fleet conversations (broadcasts + multi-party threads) — the all-hands
/// channel. A compact list reusing the Conversations-tab data (`visible_conversations`).
fn draw_conversations_compact(f: &mut Frame, app: &App, area: Rect, sel: Option<usize>) {
    let convs = app.visible_conversations();
    let items: Vec<ListItem> = if convs.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "(no fleet conversations)",
            Theme::dim(),
        )))]
    } else {
        convs
            .iter()
            .enumerate()
            .map(|(idx, c)| {
                let k = match c.kind.as_str() {
                    "question" => "Q",
                    "discussion" => "D",
                    _ => "·",
                };
                let title = c.title.clone().unwrap_or_else(|| c.id.clone());
                let item = ListItem::new(Line::from(format!(
                    "{} {:<9} {}",
                    k,
                    trunc(&c.state, 9),
                    trunc(&title, 40)
                )));
                if sel == Some(idx) {
                    item.style(Theme::selected())
                } else {
                    item
                }
            })
            .collect()
    };
    let body = crate::ui::block_with_header(
        f,
        area,
        Theme::block(
            Line::from(format!(" {} conversations (fleet) ", glyph::nav::FLEET)),
            sel.is_some(),
        ),
        " all-hands — broadcasts + threads",
    );
    f.render_widget(List::new(items).style(Theme::panel()), body);
}

fn draw_headline(f: &mut Frame, agg: &FleetAggregate, mode: FleetMode, area: Rect) {
    let line = Line::from(vec![
        // Label is "Fleet" — the cup-theme rename was reverted by the owner (2026-06-05).
        Span::styled(
            format!(" {} Fleet ", glyph::nav::FLEET),
            Theme::title_active(),
        ),
        Span::raw(format!(
            " {}/{} online · plans {}/{} items ({} active) · work-items {}/{} done ({} open) · ",
            agg.agents_online,
            agg.agents_total,
            agg.plan_items_done,
            agg.plan_items_total,
            agg.active_plans,
            agg.wi_done,
            agg.wi_total,
            agg.wi_remaining,
        )),
        // Key hints: Tab flips curated↔mirror (D-006 moved off `m`); `c` swaps
        // the comms sub-view in/out (dock consolidation #3/#4).
        Span::styled(
            format!("[{}]  Tab: mode · c: comms", mode.label()),
            Theme::info(),
        ),
    ]);
    f.render_widget(Paragraph::new(line).style(Theme::status_bar()), area);
}

/// Curated mode (D-006 — calm by default).
/// The default Swarm view (pui-dock-consolidation-2026-06-07): roster (left) |
/// dossier (right-top) + plan progress (right-bottom). The dossier + plan
/// progress default to the WHOLE FLEET; selecting an agent in the roster filters
/// both to that agent (#2). `c` swaps in the comms sub-view (handled in
/// `draw_fleet`).
fn draw_curated(f: &mut Frame, app: &App, agg: &FleetAggregate, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(46), Constraint::Percentage(54)])
        .split(area);

    draw_agents(f, app, cols[0]);

    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(56), Constraint::Percentage(44)])
        .split(cols[1]);
    draw_dossier(f, app, right[0]);
    draw_plan_progress(f, app, agg, right[1]);
}

/// The dossier region (#2): when an agent is selected in the roster, that bee's
/// ranked task list (reused from `bee.rs`, driven by the in-process selection
/// fetch); with NO selection, the whole-fleet task list (every bee's claimed
/// work, from `fleet.all_assignments`).
fn draw_dossier(f: &mut Frame, app: &App, area: Rect) {
    if app.bee.owner_id.is_some() {
        crate::bee::draw_tasklist(f, app, area);
    } else {
        draw_all_tasklist(f, app, area);
    }
}

/// Whole-fleet task list: every bee's claimed work-items, grouped by bee in load
/// order. The default dossier when no agent is selected (#2 "show all tasks from
/// the fleet"). Reuses `bee::task_row` per item under a per-bee header line.
fn draw_all_tasklist(f: &mut Frame, app: &App, area: Rect) {
    let asn = &app.fleet.all_assignments;
    let total: i64 = asn.iter().map(|a| a.load).sum();
    let mut items: Vec<ListItem> = Vec::new();
    if asn.is_empty() {
        items.push(ListItem::new(Line::from(Span::styled(
            "(loading fleet task list…)",
            Theme::dim(),
        ))));
    } else {
        // Busiest bees first; a bee with no claimed work still shows its header.
        let mut ordered: Vec<&crate::models::BeeAssignment> = asn.iter().collect();
        ordered.sort_by(|a, b| b.load.cmp(&a.load));
        for a in ordered {
            let label = a
                .name
                .clone()
                .or_else(|| a.label.clone())
                .unwrap_or_else(|| a.agent_id.clone());
            let dot = if a.alive {
                glyph::status::DONE
            } else {
                glyph::status::DROPPED
            };
            items.push(ListItem::new(Line::from(Span::styled(
                format!(" {} {} ({})", dot, trunc(&label, 22), a.load),
                Theme::info(),
            ))));
            for (i, w) in a.queued.iter().enumerate() {
                items.push(crate::bee::task_row(i, w));
            }
        }
    }
    let body = crate::ui::block_with_header(
        f,
        area,
        Theme::block(
            Line::from(format!(" {} fleet task list ({total} claimed) ", glyph::nav::FLEET)),
            false,
        ),
        " select an agent to filter · rank · st · task",
    );
    f.render_widget(List::new(items).style(Theme::panel()), body);
}

/// Compact liveness legend (owner ask 2026-06-11): the roster's dot vocabulary
/// plus the heartbeat age that produces each state. The AGE THRESHOLDS mirror
/// `operator-core/lib/liveness.ts` (LIVE_MS 60s · STALE_MS 10min) — the backend
/// derives the status and pui only renders it, so these labels are documentation
/// of the wire contract, not a second derivation.
fn liveness_legend_spans() -> Vec<Span<'static>> {
    let entries: [(&str, &str, bool, &str); 3] = [
        (glyph::liveness::LIVE, "live <1m", false, "live"),
        (glyph::liveness::IDLE, "idle <10m", false, "idle"),
        (glyph::liveness::STALE, "stale ≥10m", true, "stale"),
    ];
    let mut spans: Vec<Span<'static>> = Vec::new();
    for (i, (dot, label, stale, liveness)) in entries.into_iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled(
                " · ",
                ratatui::style::Style::default().fg(ratatui::style::Color::DarkGray),
            ));
        }
        spans.push(Span::styled(
            format!("{dot} {label}"),
            Theme::liveness_style(stale, liveness),
        ));
    }
    spans
}

/// The MANUAL wake-mode badge text (P-008): the staged-wake count rides on the
/// badge when anything is pending review (" ⏸MANUAL·3"), bare otherwise.
fn wake_badge_text(pending: i64) -> String {
    if pending > 0 {
        format!(" ⏸MANUAL·{pending}")
    } else {
        " ⏸MANUAL".to_string()
    }
}

/// The agent list — roster joined to each agent's latest activity summary + todo
/// progress. The navigable spine of the Fleet tab (j/k).
fn draw_agents(f: &mut Frame, app: &App, area: Rect, focused: bool) {
    let latest = app.fleet.latest_by_owner();
    // The plans-filtered roster (D-009) — `fleet.agent_sel` indexes THIS list.
    let roster = app.visible_roster();
    let items: Vec<ListItem> = roster
        .iter()
        .map(|r| {
            // Liveness dot — coloured by freshness (Brief 27 glyph vocabulary).
            let dot = Theme::liveness_marker(r.stale, &r.liveness);
            // P-004 (progress-tab-agents-convergence, owner ask 2026-06-11): the
            // kind GLYPH leads each roster row — ♛ queen · 🐝 bee · 🛡 sentinel ·
            // 📋 planner · 🛠 su (the owner's own psu sessions) — so workers and
            // owner sessions read apart at a glance, same vocabulary as the pane
            // titles. Flag-on; flag-off keeps the legacy dot-only row.
            let kind = crate::agent_pane_kind::AgentPaneKind::from_opt(&r.agent_pane_kind);
            let glyph_cell = match (app.hive_agent_tabs, kind) {
                (true, Some(k)) => Span::styled(
                    format!("{} ", k.glyph()),
                    ratatui::style::Style::default().fg(k.color()),
                ),
                (true, None) => Span::raw("  ".to_string()),
                _ => Span::raw(String::new()),
            };
            let agent = r.agent.clone().unwrap_or_else(|| "-".into());
            // The "what it's doing" cell: live activity summary, else intent/role.
            let act = latest
                .get(r.owner_id.as_str())
                .and_then(|a| a.summary.clone())
                .filter(|s| !s.is_empty())
                .or_else(|| r.intent.clone().filter(|s| !s.is_empty()))
                .or_else(|| r.feature.clone().filter(|s| !s.is_empty()))
                .unwrap_or_default();
            let todo = app
                .fleet
                .agent_todos
                .get(&r.owner_id)
                .map(|t| format!("⇄{}/{}", t.done, t.count))
                .unwrap_or_default();
            // P-010: flag-on, tint the agent name by its pane-type (Queen/Bee/
            // Sentinel/Planner). zellij has no per-pane color (D-008), so pui draws
            // it here where it owns the chrome. Flag-off → plain (current).
            let agent_cell = format!(" {:<6} ", trunc(&agent, 6));
            let agent_span = match (app.hive_agent_tabs, kind) {
                (true, Some(k)) => {
                    Span::styled(agent_cell, ratatui::style::Style::default().fg(k.color()))
                }
                _ => Span::raw(agent_cell),
            };
            // P-008: flag-on, a wake-mode badge — `manual` is the notable (paused)
            // state; `auto` is the default → no badge, uncluttered. The staged-wake
            // COUNT rides on the badge so the owner sees review-pending work at a
            // glance ('W' opens the P-009 review overlay).
            let wake_badge = if app.hive_agent_tabs && r.wake_mode.as_deref() == Some("manual") {
                Span::styled(
                    wake_badge_text(r.pending_wakes),
                    ratatui::style::Style::default().fg(ratatui::style::Color::Yellow),
                )
            } else {
                Span::raw("")
            };
            // Claim discipline: declared on a plan but holding no claim backing
            // it — the lane is invisible to the Queen/peers. Yellow ⚠ so an
            // "active" row without a claimed lane reads differently at a glance.
            let unclaimed_badge = if app.hive_agent_tabs && r.declared_unclaimed {
                Span::styled(
                    " ⚠unclaimed",
                    ratatui::style::Style::default().fg(ratatui::style::Color::Yellow),
                )
            } else {
                Span::raw("")
            };
            // Enter-route tag (owner ask 2026-06-11): what Enter will do for
            // THIS row — ⏎ pane / ⏎ window / ⏎ resume / ⏎ menu — so a
            // non-resumable agent is visible before the keypress, not after a
            // silent one. Resume is the high-signal route → green; the rest
            // stay dim chrome.
            let hint = app.enter_hint(r);
            let hint_span = if hint == "⏎ resume" {
                Span::styled(
                    format!(" {hint}"),
                    ratatui::style::Style::default().fg(ratatui::style::Color::Green),
                )
            } else {
                Span::styled(format!(" {hint}"), Theme::dim())
            };
            ListItem::new(Line::from(vec![
                dot,
                glyph_cell,
                agent_span,
                Span::raw(format!("{:<30} ", trunc(&act, 30))),
                Span::styled(todo, Theme::dim()),
                wake_badge,
                unclaimed_badge,
                hint_span,
            ]))
        })
        .collect();
    let mut state = ListState::default();
    if !roster.is_empty() {
        state.select(Some(
            app.fleet.agent_sel.min(roster.len().saturating_sub(1)),
        ));
    }
    let body = if items.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "(no agents in the fleet) — press n to launch one here",
            Theme::dim(),
        )))]
    } else {
        items
    };
    // The plans-filter badge (D-009) keeps an active-but-hidden rail visible.
    // `Enter: reach` advertises the Enter-by-location routing (D-001).
    let title = if app.plan_filter.is_empty() {
        format!(" Agents ({}) · Enter: reach · n: launch ", roster.len())
    } else {
        format!(
            " Agents ({}/{}) · F:plans({}) · Enter: reach · n: launch ",
            roster.len(),
            app.roster.len(),
            app.plan_filter.len()
        )
    };
    // Styled column header above the roster (D-005) — one compact legend line
    // rides above it (owner ask 2026-06-11): the kind glyphs (♛ 🐝 🛡 📋 🛠,
    // flag-on — flag-off rows carry no glyphs) + the liveness dots with their
    // heartbeat-age thresholds (always — the dots render regardless of flag).
    let header = format!("    {:<7}{:<31}{}", "agent", "doing now", "todos");
    let mut legend_spans: Vec<Span<'static>> = Vec::new();
    if app.hive_agent_tabs {
        legend_spans.extend(crate::agent_pane_kind::legend_line().spans);
        legend_spans.push(Span::raw("   "));
    } else {
        legend_spans.push(Span::raw(" "));
    }
    legend_spans.extend(liveness_legend_spans());
    let header_rows: Vec<Line<'static>> = vec![
        Line::from(legend_spans),
        Line::from(Span::styled(header, Theme::header())),
    ];
    let body_area = crate::ui::block_with_header_rows(
        f,
        area,
        Theme::block(Line::from(title), focused),
        header_rows,
    );
    let list = List::new(body)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);
}

/// Fleet-wide plan progress — one bar per live plan, ordered by priority desc
/// then by remaining work desc (the plans that need attention float up). With an
/// agent selected in the roster (#2), narrows to the plans that agent is linked
/// to (declared plan + claim plan-slugs from `fleet:assignments`).
fn draw_plan_progress(f: &mut Frame, app: &App, agg: &FleetAggregate, area: Rect) {
    // The selected agent's plan-set (None = no selection → whole fleet). Prefer
    // the whole-fleet snapshot; fall back to the per-bee dossier fetch.
    let agent_plans: Option<std::collections::HashSet<&str>> =
        app.bee.owner_id.as_deref().map(|owner| {
            app.fleet
                .all_assignments
                .iter()
                .find(|a| a.agent_id == owner)
                .or(app.bee.assignment.as_ref())
                .map(|a| a.plan_slugs())
                .unwrap_or_default()
        });

    // Pot-scope-filtered (D-003), matching the aggregate's headline numbers.
    let mut plans: Vec<&crate::models::PlanSummary> = app
        .visible_plans()
        .into_iter()
        .filter(|p| !p.archived && p.item_counts.total() > 0)
        .filter(|p| {
            agent_plans
                .as_ref()
                .is_none_or(|set| set.contains(p.slug.as_str()))
        })
        .collect();
    plans.sort_by(|a, b| {
        b.priority
            .unwrap_or(0)
            .cmp(&a.priority.unwrap_or(0))
            .then(b.item_counts.remaining().cmp(&a.item_counts.remaining()))
    });

    let items: Vec<ListItem> = plans
        .iter()
        .map(|p| {
            let c = &p.item_counts;
            ListItem::new(Line::from(vec![
                Span::raw(format!("{:<26} ", trunc(&p.slug, 26))),
                Span::styled(progress_bar(c.done, c.total(), 10), Theme::selected()),
                Span::raw(format!(" {}/{}", c.done, c.total())),
            ]))
        })
        .collect();
    let body = if items.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            if agent_plans.is_some() {
                "(no plans for this agent — Esc for the whole fleet)"
            } else {
                "(no plan items)"
            },
            Theme::dim(),
        )))]
    } else {
        items
    };
    let title = match app.bee.name.as_deref().or(app.bee.owner_id.as_deref()) {
        Some(who) if agent_plans.is_some() => {
            format!(" Plan progress — {} (Esc clears) ", trunc(who, 24))
        }
        _ => format!(
            " Plan progress — {}/{} items done ",
            agg.plan_items_done, agg.plan_items_total
        ),
    };
    f.render_widget(
        List::new(body).style(Theme::panel()).block(Theme::block(
            Line::from(title),
            agg.plan_items_total > 0,
        )),
        area,
    );
}

/// Mirror mode: the raw fleet-wide activity firehose, newest-first.
fn draw_mirror(f: &mut Frame, app: &App, area: Rect) {
    // Pot-scope-filtered (D-003).
    let activity = app.visible_fleet_activity();
    let items: Vec<ListItem> = activity
        .iter()
        .map(|a| {
            let agent = a.agent.clone().unwrap_or_else(|| "-".into());
            let harness = a.harness_slug.clone().unwrap_or_default();
            let summary = a
                .summary
                .clone()
                .unwrap_or_else(|| a.tool_name.clone().unwrap_or_else(|| a.kind.clone()));
            ListItem::new(Line::from(vec![
                Span::styled(format!("{:<8} ", hms(&a.created_at)), Theme::dim()),
                Span::raw(format!("{:<6} ", trunc(&agent, 6))),
                Span::styled(format!("{:<12} ", trunc(&harness, 12)), Theme::dim()),
                Span::raw(trunc(&summary, 48)),
            ]))
        })
        .collect();
    let body = if items.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "(no activity yet — the fleet is quiet, or the bridge hasn't reported)",
            Theme::dim(),
        )))]
    } else {
        items
    };
    // Styled column header above the firehose (D-005). No highlight symbol on
    // this list, so the header has no selection indent.
    let body_area = crate::ui::block_with_header(
        f,
        area,
        Theme::block(
            Line::from(format!(
                " Activity mirror ({}) — every tool call, newest first ",
                activity.len()
            )),
            !activity.is_empty(),
        ),
        &format!("{:<9}{:<7}{:<13}{}", "time", "agent", "pot", "summary"),
    );
    f.render_widget(List::new(body).style(Theme::panel()), body_area);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ActivityRow, RosterEntry, TodoItem, WorkItem};
    use serde_json::json;

    #[test]
    fn wake_badge_text_carries_the_pending_count() {
        // P-008: bare badge when nothing staged; the count rides on it otherwise.
        assert_eq!(wake_badge_text(0), " ⏸MANUAL");
        assert_eq!(wake_badge_text(3), " ⏸MANUAL·3");
    }

    #[test]
    fn liveness_legend_names_each_dot_with_its_heartbeat_threshold() {
        // Owner ask 2026-06-11: the legend documents the wire contract —
        // thresholds mirror operator-core/lib/liveness.ts (LIVE_MS/STALE_MS).
        let text: String = liveness_legend_spans()
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        assert_eq!(
            text,
            format!(
                "{} live <1m · {} idle <10m · {} stale ≥10m",
                glyph::liveness::LIVE,
                glyph::liveness::IDLE,
                glyph::liveness::STALE
            )
        );
        // Each entry is tinted with the same style the roster dot uses.
        let spans = liveness_legend_spans();
        assert_eq!(
            spans[0].style,
            Theme::liveness_style(false, "live"),
            "live entry mis-styled"
        );
        assert_eq!(spans[4].style, Theme::liveness_style(true, "stale"));
    }

    fn row(owner: &str, kind: &str, summary: &str) -> ActivityRow {
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

    fn todos_row(owner: &str, done: u32, count: u32, active: &str) -> ActivityRow {
        let mut r = row(owner, "todos", "⇄ todos");
        r.detail = Some(json!({
            "count": count,
            "done": done,
            "todos": [
                {"content": active, "status": "in_progress"},
                {"content": "later", "status": "pending"},
            ],
        }));
        r
    }

    #[test]
    fn mode_toggles() {
        let mut s = FleetState::default();
        assert_eq!(s.mode, FleetMode::Curated);
        s.toggle_mode();
        assert_eq!(s.mode, FleetMode::Mirror);
        s.toggle_mode();
        assert_eq!(s.mode, FleetMode::Curated);
    }

    #[test]
    fn push_activity_is_newest_first_and_capped() {
        let mut s = FleetState::default();
        for i in 0..(ACTIVITY_CAP + 50) {
            s.push_activity(row("su-a", "tool", &format!("m{i}")));
        }
        assert_eq!(s.activity.len(), ACTIVITY_CAP);
        // Newest pushed is at index 0.
        assert_eq!(
            s.activity[0].summary.as_deref(),
            Some(format!("m{}", ACTIVITY_CAP + 49).as_str())
        );
    }

    #[test]
    fn seed_activity_replaces_and_caps() {
        let mut s = FleetState::default();
        s.push_activity(row("su-a", "tool", "live"));
        let backfill: Vec<ActivityRow> = (0..3)
            .map(|i| row("su-b", "tool", &format!("b{i}")))
            .collect();
        s.seed_activity(backfill);
        assert_eq!(s.activity.len(), 3);
        assert_eq!(s.activity[0].summary.as_deref(), Some("b0"));
    }

    #[test]
    fn todos_ingested_into_per_agent_map() {
        let mut s = FleetState::default();
        s.push_activity(todos_row("su-a", 2, 5, "build fleet.rs"));
        let snap = s.agent_todos.get("su-a").expect("todos for su-a");
        assert_eq!(snap.done, 2);
        assert_eq!(snap.count, 5);
        assert_eq!(snap.todos[0].content, "build fleet.rs");
        assert_eq!(
            snap.todos[0],
            TodoItem {
                content: "build fleet.rs".into(),
                status: Some("in_progress".into()),
            }
        );
        // A newer todos row replaces the snapshot.
        s.push_activity(todos_row("su-a", 4, 5, "wire pollers"));
        assert_eq!(s.agent_todos.get("su-a").unwrap().done, 4);
    }

    #[test]
    fn latest_by_owner_keeps_newest() {
        let mut s = FleetState::default();
        // Pushed newest-last here, but push prepends, so su-a's newest is "second".
        s.push_activity(row("su-a", "tool", "first"));
        s.push_activity(row("su-a", "tool", "second"));
        let latest = s.latest_by_owner();
        assert_eq!(
            latest.get("su-a").unwrap().summary.as_deref(),
            Some("second")
        );
    }

    fn roster_entry(owner: &str, stale: bool) -> RosterEntry {
        RosterEntry {
            owner_id: owner.into(),
            label: format!("su · {owner}"),
            intent: Some("working".into()),
            current_files: vec![],
            liveness: if stale { "dead".into() } else { "live".into() },
            stale,
            agent: Some("claude".into()),
            role: Some("worker".into()),
            feature: None,
            current_plan_slug: None,
            heartbeat_at: None,
            ..Default::default()
        }
    }

    fn wi(kind: &str, family: &str, state: &str) -> WorkItem {
        WorkItem {
            id: "X-1".into(),
            kind: kind.into(),
            family: family.into(),
            harness: Some("papercup".into()),
            title: "t".into(),
            state: state.into(),
            assignee: None,
            severity: None,
        }
    }

    #[test]
    fn aggregate_rolls_up_plans_workitems_roster() {
        let mut app = App::new();
        app.set_roster(vec![
            roster_entry("su-a", false),
            roster_entry("su-b", true),
        ]);
        // Two plans: one with progress, one archived (excluded).
        let mut p1 = crate::models::PlanSummary {
            slug: "p1".into(),
            title: "P1".into(),
            status: "active".into(),
            updated: "x".into(),
            owner: None,
            harness: None,
            archived: false,
            next_action: None,
            item_counts: crate::models::ItemCounts {
                todo: 3,
                done: 2,
                ..Default::default()
            },
            priority: Some(5),
        };
        let mut p2 = p1.clone();
        p2.slug = "archived".into();
        p2.archived = true;
        p1.slug = "p1".into();
        app.set_plans(vec![p1, p2]);
        app.fleet.set_work_items(vec![
            wi("feature", "feature", "passed"),
            wi("feature", "feature", "todo"),
            wi("bug", "issue", "open"),
        ]);

        let agg = aggregate(&app);
        assert_eq!(agg.agents_online, 1);
        assert_eq!(agg.agents_total, 2);
        assert_eq!(agg.plan_items_done, 2); // archived plan excluded
        assert_eq!(agg.plan_items_total, 5);
        assert_eq!(agg.active_plans, 1);
        assert_eq!(agg.wi_total, 3);
        assert_eq!(agg.wi_features, 2);
        assert_eq!(agg.wi_issues, 1);
        assert_eq!(agg.wi_open_issues, 1);
        assert_eq!(agg.wi_features_passed, 1);
        // Done = passed features + resolved/closed issues; remaining = total − done.
        assert_eq!(agg.wi_done, 1); // 1 passed feature, the lone issue is open
        assert_eq!(agg.wi_remaining, 2); // 1 todo feature + 1 open issue
    }

    #[test]
    fn aggregate_counts_resolved_and_closed_issues_as_done() {
        let mut app = App::new();
        app.fleet.set_work_items(vec![
            wi("bug", "issue", "resolved"),
            wi("change", "issue", "closed"),
            wi("bug", "issue", "open"),
            wi("feature", "feature", "passed"),
        ]);
        let agg = aggregate(&app);
        assert_eq!(agg.wi_total, 4);
        assert_eq!(agg.wi_done, 3); // resolved + closed + passed
        assert_eq!(agg.wi_remaining, 1); // the open bug
        assert_eq!(agg.wi_open_issues, 1);
    }

    #[test]
    fn hms_extracts_clock() {
        assert_eq!(hms("2026-06-04 18:53:58.46-04"), "18:53:58");
        assert_eq!(hms("2026-06-04T09:01:02Z"), "09:01:02");
    }

    #[test]
    fn progress_bar_fills_proportionally() {
        assert_eq!(progress_bar(0, 0, 4), "────");
        assert_eq!(progress_bar(0, 10, 4), "░░░░");
        assert_eq!(progress_bar(10, 10, 4), "████");
        assert_eq!(progress_bar(5, 10, 4), "██░░");
    }

    fn render_fleet(app: &App, w: u16, h: u16) -> String {
        use ratatui::{backend::TestBackend, Terminal};
        let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
        term.draw(|f| crate::ui::draw(f, app)).unwrap();
        term.backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect()
    }

    #[test]
    fn curated_default_shows_roster_fleet_tasklist_and_plan_progress() {
        // The default curated layout (pui-dock-consolidation-2026-06-07 #2):
        // roster (left) | whole-fleet task list + plan progress (right). No
        // agent selected → the fleet-wide dossier, not a single bee's.
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false;
        let text = render_fleet(&app, 120, 24);
        assert!(text.contains("Agents"));
        assert!(text.contains("fleet task list"));
        assert!(text.contains("Plan progress"));
    }

    #[test]
    fn plan_progress_filters_to_selected_agents_plans() {
        // #2: selecting an agent narrows plan progress to ITS plans (declared
        // plan + claim plan-slugs from fleet:assignments); Esc clears.
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false;
        let mk = |slug: &str| crate::models::PlanSummary {
            slug: slug.into(),
            title: slug.to_uppercase(),
            status: "active".into(),
            updated: "x".into(),
            owner: None,
            harness: None,
            archived: false,
            next_action: None,
            item_counts: crate::models::ItemCounts {
                todo: 1,
                done: 1,
                ..Default::default()
            },
            priority: None,
        };
        app.set_plans(vec![mk("plan-mine"), mk("plan-other")]);
        app.fleet.all_assignments = vec![crate::models::BeeAssignment {
            agent_id: "su-a".into(),
            declared_plan_slug: Some("plan-mine".into()),
            ..Default::default()
        }];
        // No selection → both plans render.
        let text = render_fleet(&app, 120, 30);
        assert!(text.contains("plan-mine"));
        assert!(text.contains("plan-other"));
        // Selection → only the agent's plan; the title names the agent.
        app.bee.set_selection(Some("su-a".into()), Some("forager".into()));
        let text = render_fleet(&app, 120, 30);
        assert!(text.contains("plan-mine"));
        assert!(!text.contains("plan-other"));
        assert!(text.contains("forager"));
        assert!(text.contains("Esc clears"));
    }

    #[test]
    fn bee_assignment_plan_slugs_unions_declared_and_claims() {
        let a = crate::models::BeeAssignment {
            declared_plan_slug: Some("p-declared".into()),
            claims: vec![
                crate::models::BeeClaim {
                    plan_slug: Some("p-claimed".into()),
                },
                crate::models::BeeClaim { plan_slug: None },
            ],
            ..Default::default()
        };
        let set = a.plan_slugs();
        assert!(set.contains("p-declared"));
        assert!(set.contains("p-claimed"));
        assert_eq!(set.len(), 2);
    }

    /// Brief 27 / P-010: buffer-level width safety. Render the Fleet view
    /// (agent roster + work-item rollup) at 80 and 120 cols
    /// and assert (a) no double-width symbol appears anywhere in the frame
    /// outside the header-only set (`glyph::header::SET` — Block-title emoji),
    /// and (b) the roster labels align in a single column across rows (a wide
    /// glyph upstream of a label would shift it right by one cell).
    #[test]
    fn fleet_render_width_safe_and_aligned_at_80_and_120() {
        use unicode_width::UnicodeWidthStr;

        // Frame-wide scan: every cell symbol must be ≤1 column wide unless it
        // is one of the sanctioned header emoji.
        fn scan(app: &App, w: u16, h: u16) -> Vec<String> {
            use ratatui::{backend::TestBackend, Terminal};
            let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
            term.draw(|f| crate::ui::draw(f, app)).unwrap();
            let buf = term.backend().buffer().clone();
            let mut rows: Vec<String> = Vec::with_capacity(h as usize);
            for y in 0..h {
                let mut row = String::with_capacity(w as usize);
                for x in 0..w {
                    let sym = buf.cell((x, y)).unwrap().symbol();
                    if UnicodeWidthStr::width(sym) > 1 {
                        assert!(
                            glyph::header::SET.contains(&sym),
                            "width-2 symbol {sym:?} leaked into row content at ({x},{y}) \
                             width {w} — only glyph::header::* may be wide"
                        );
                    }
                    row.push_str(sym);
                }
                rows.push(row);
            }
            rows
        }

        // Heuristic (no curator) mode — per-agent roster rows render.
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false;
        app.set_roster(vec![
            roster_entry("su-alpha", false),
            roster_entry("su-bee", true),
            roster_entry("su-much-longer-name", false),
        ]);
        app.fleet.set_work_items(vec![
            wi("feature", "feature", "passed"),
            wi("feature", "feature", "todo"),
            wi("bug", "issue", "open"),
        ]);

        for &(w, h) in &[(80u16, 30u16), (120, 30)] {
            let rows = scan(&app, w, h);
            // Roster rows: every agent label starts at the same column (a wide
            // glyph in the liveness-dot cell would shift the label by one).
            let cols: Vec<usize> = rows.iter().filter_map(|r| r.find("claude")).collect();
            assert!(
                cols.len() >= 3,
                "expected 3 roster rows in the {w}-col render, got {cols:?}"
            );
            assert!(
                cols.windows(2).all(|p| p[0] == p[1]),
                "roster label column drifted at width {w}: {cols:?}"
            );
        }

    }

    /// Live read-only QA (feedback-no-live-keystroke-drive-pui): fetch REAL fleet
    /// data via the operator client, populate a Fleet App, and render both modes
    /// to a TestBackend. No live pui process, no keystrokes — just the real wire +
    /// the pure renderer. `PUI_DUMP=1` writes the renders for manual inspection.
    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_fleet_render() {
        use ratatui::{backend::TestBackend, Terminal};
        let c = crate::client::OperatorClient::from_discovery()
            .await
            .expect("connect via discovery");
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false; // full width for the dashboard
        match c.plans_typed().await {
            Ok(v) => {
                let with_items = v.iter().filter(|p| p.item_counts.total() > 0).count();
                eprintln!(
                    "plans: {} loaded, {} with item progress",
                    v.len(),
                    with_items
                );
                app.set_plans(v);
            }
            Err(e) => eprintln!("plans_typed ERR: {e}"),
        }
        if let Ok((active, _pending)) = c.roster_typed().await {
            app.set_roster(active);
        }
        if let Ok(v) = c.work_items_list().await {
            app.fleet.set_work_items(v);
        }
        if let Ok(v) = c.activity_recent(None, 100).await {
            app.fleet.seed_activity(v);
        }
        if let Ok(v) = c.activity_recent(Some("todos"), 50).await {
            app.fleet.seed_todos(&v);
        }

        let agg = aggregate(&app);
        eprintln!(
            "live fleet: agents {}/{}, plan items {}/{} ({} active plans), work-items {} ({} feat / {} issue, {} passed, {} open-issue), activity {} rows, todo-maps {}",
            agg.agents_online, agg.agents_total, agg.plan_items_done, agg.plan_items_total,
            agg.active_plans, agg.wi_total, agg.wi_features, agg.wi_issues,
            agg.wi_features_passed, agg.wi_open_issues, app.fleet.activity.len(),
            app.fleet.agent_todos.len(),
        );

        let render = |app: &App| -> String {
            let mut term = Terminal::new(TestBackend::new(200, 50)).unwrap();
            term.draw(|f| crate::ui::draw(f, app)).unwrap();
            term.backend()
                .buffer()
                .content()
                .iter()
                .map(|cell| cell.symbol())
                .collect()
        };
        let wrap = |s: &str| -> String {
            s.chars()
                .collect::<Vec<_>>()
                .chunks(200)
                .map(|c| c.iter().collect::<String>())
                .collect::<Vec<_>>()
                .join("\n")
        };

        // Curated (default) renders the dashboard.
        let curated = render(&app);
        let nonblank = curated.chars().filter(|ch| !ch.is_whitespace()).count();
        assert!(nonblank > 0, "fleet curated rendered blank");
        assert!(curated.contains("Fleet"), "headline missing");
        assert!(curated.contains("online"), "agent rollup missing");
        assert!(curated.contains("[curated]"), "mode indicator missing");

        // Mirror renders the firehose.
        app.fleet.mode = FleetMode::Mirror;
        let mirror = render(&app);
        assert!(mirror.contains("Activity mirror"), "mirror feed missing");
        assert!(mirror.contains("[mirror]"));

        if std::env::var("PUI_DUMP").is_ok() {
            let _ = std::fs::write("/tmp/fleet-curated.txt", wrap(&curated));
            let _ = std::fs::write("/tmp/fleet-mirror.txt", wrap(&mirror));
            eprintln!("dumped /tmp/fleet-curated.txt + /tmp/fleet-mirror.txt");
        }
    }
}
