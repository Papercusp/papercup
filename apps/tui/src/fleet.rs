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
//! Two modes (D-006): **curated** (default, calm — per-agent latest + plan
//! progress) and the **faithful mirror** (the raw activity firehose). Both
//! consume the same stream; `m` toggles. The "wire curated to the
//! curator-operator" seam is left open (no curator surface has landed yet) — the
//! curated mode is a local heuristic for now.
//!
//! All state + render lives here; `app.rs`/`ui.rs` only hold a `fleet` field, a
//! `Tab::Fleet` arm, and a one-line `draw` delegation, so this barely collides
//! with the parallel pui work. Render is a pure function of `&App`.

use crate::app::App;
use crate::glyph;
use crate::models::{ActivityRow, CuratedSignal, TodoSnapshot, WorkItem};
use crate::theme::Theme;
use crate::ui::trunc;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    text::{Line, Span},
    widgets::{List, ListItem, ListState, Paragraph, Wrap},
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
    /// The curator's salience-ranked "what matters" signals (curation:feed). The
    /// curated mode shows these when available (D-006 — the curator deciding what
    /// matters); empty otherwise.
    pub curated_signals: Vec<CuratedSignal>,
    /// True once `curation:feed` has answered (the curator surface is live). Lets
    /// the curated view distinguish "curator live + fleet calm" (show "calm")
    /// from "no curator surface yet" (fall back to the local heuristic).
    pub curation_available: bool,
}

impl Default for FleetState {
    fn default() -> Self {
        Self {
            mode: FleetMode::Curated,
            activity: Vec::new(),
            work_items: Vec::new(),
            agent_todos: HashMap::new(),
            agent_sel: 0,
            curated_signals: Vec::new(),
            curation_available: false,
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

    /// Record the curator's salience feed (curation:feed) + mark the surface live.
    pub fn set_curated_signals(&mut self, signals: Vec<CuratedSignal>) {
        self.curated_signals = signals;
        self.curation_available = true;
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

    match app.fleet.mode {
        FleetMode::Curated => draw_curated(f, app, &agg, rows[1]),
        FleetMode::Mirror => draw_mirror(f, app, rows[1]),
    }
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
        Span::styled(format!("[{}]  m: toggle", mode.label()), Theme::info()),
    ]);
    f.render_widget(Paragraph::new(line).style(Theme::status_bar()), area);
}

/// Curated mode (D-006 — "the curator deciding what matters, calm"). When the
/// curator surface is live (`curation:feed` answered), the salience-ranked "what
/// matters" list leads, with agents + plan progress as supporting context. Until
/// the curator lands (pre-restart / not built), it falls back to the local
/// heuristic (agents + selected-agent detail + plan progress) so the view is
/// always useful.
fn draw_curated(f: &mut Frame, app: &App, agg: &FleetAggregate, area: Rect) {
    if app.fleet.curation_available {
        let cols = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(48), Constraint::Percentage(52)])
            .split(area);
        draw_what_matters(f, app, cols[0]);
        let right = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
            .split(cols[1]);
        draw_agents(f, app, right[0]);
        draw_plan_progress(f, app, agg, right[1]);
    } else {
        draw_curated_heuristic(f, app, agg, area);
    }
}

/// The pre-curator fallback: agents (left) + selected-agent detail over plan
/// progress (right). Used until `curation:feed` is live.
fn draw_curated_heuristic(f: &mut Frame, app: &App, agg: &FleetAggregate, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(46), Constraint::Percentage(54)])
        .split(area);

    draw_agents(f, app, cols[0]);

    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(52), Constraint::Percentage(48)])
        .split(cols[1]);
    draw_agent_detail(f, app, right[0]);
    draw_plan_progress(f, app, agg, right[1]);
}

/// The curator's "what matters" — salience-ranked fleet signals (curation:feed).
/// Urgent (escalations/blockers) lead, then decisions-owed + user-completions,
/// then routine. An empty feed means the curator is live but the fleet is calm.
fn draw_what_matters(f: &mut Frame, app: &App, area: Rect) {
    // Pot-scope-filtered (D-003).
    let sigs = app.visible_signals();
    let items: Vec<ListItem> = sigs
        .iter()
        .map(|s| {
            let mark = Theme::signal_marker(&s.kind);
            let style = if s.urgent {
                Theme::warn()
            } else if s.disposition == "surface" {
                Theme::selected()
            } else {
                Theme::dim()
            };
            let loc = s
                .harness
                .clone()
                .filter(|h| !h.is_empty())
                .map(|h| format!(" [{h}]"))
                .unwrap_or_default();
            ListItem::new(Line::from(vec![
                mark,
                Span::raw(" "),
                Span::styled(trunc(&s.title, 40), style),
                Span::styled(loc, Theme::dim()),
            ]))
        })
        .collect();
    let body = if items.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            format!(
                "{} fleet calm — nothing needs attention",
                glyph::status::DONE
            ),
            Theme::dim(),
        )))]
    } else {
        items
    };
    f.render_widget(
        List::new(body).style(Theme::panel()).block(Theme::block(
            Line::from(format!(
                " {} What matters ({}) — the curator's view ",
                glyph::header::BOLT,
                sigs.len()
            )),
            !sigs.is_empty(),
        )),
        area,
    );
}

/// The agent list — roster joined to each agent's latest activity summary + todo
/// progress. The navigable spine of the Fleet tab (j/k).
fn draw_agents(f: &mut Frame, app: &App, area: Rect) {
    let latest = app.fleet.latest_by_owner();
    // The plans-filtered roster (D-009) — `fleet.agent_sel` indexes THIS list.
    let roster = app.visible_roster();
    let items: Vec<ListItem> = roster
        .iter()
        .map(|r| {
            // Liveness dot — coloured by freshness (Brief 27 glyph vocabulary).
            let dot = Theme::liveness_marker(r.stale, &r.liveness);
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
            ListItem::new(Line::from(vec![
                dot,
                Span::raw(format!(" {:<6} ", trunc(&agent, 6))),
                Span::raw(format!("{:<30} ", trunc(&act, 30))),
                Span::styled(todo, Theme::dim()),
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
    // Styled column header above the roster (D-005).
    let body_area = crate::ui::block_with_header(
        f,
        area,
        Theme::block(Line::from(title), true),
        &format!("    {:<7}{:<31}{}", "agent", "doing now", "todos"),
    );
    let list = List::new(body)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);
}

/// Detail for the selected agent: presence + last activity + its mirrored todos.
fn draw_agent_detail(f: &mut Frame, app: &App, area: Rect) {
    // Same plans-filtered roster as `draw_agents` (D-009) — the dossier must
    // describe the row the cursor is on.
    let roster = app.visible_roster();
    let sel = roster
        .get(app.fleet.agent_sel.min(roster.len().saturating_sub(1)))
        .copied();
    let body = match sel {
        Some(r) => {
            let latest = app.fleet.latest_by_owner();
            let last = latest
                .get(r.owner_id.as_str())
                .map(|a| {
                    format!(
                        "{}  ({})",
                        a.summary.clone().unwrap_or_default(),
                        hms(&a.created_at)
                    )
                })
                .unwrap_or_else(|| "(no recent activity)".to_string());
            // The dossier (folded in from the old Sessions tab — D-002b): presence
            // + plan/heartbeat + last activity + mirrored todos + open files.
            let mut out = format!(
                "{}\n\nagent: {}   role: {}   feature: {}\nliveness: {}{}\nplan: {}   beat: {}\nintent: {}\n\nlast: {}\n",
                r.label,
                r.agent.clone().unwrap_or_default(),
                r.role.clone().unwrap_or_default(),
                r.feature.clone().unwrap_or_default(),
                r.liveness,
                if r.stale { " (stale)" } else { "" },
                r.current_plan_slug.clone().unwrap_or_default(),
                r.heartbeat_at.clone().unwrap_or_default(),
                r.intent.clone().unwrap_or_default(),
                last,
            );
            // Mirrored todos (D-004): the selected agent's Claude/Codex/OMP todos.
            if let Some(t) = app.fleet.agent_todos.get(&r.owner_id) {
                out.push_str(&format!("\ntodos ({}/{}):\n", t.done, t.count));
                for td in t.todos.iter().take(8) {
                    let mark = glyph::status_for(td.status.as_deref().unwrap_or("todo"));
                    out.push_str(&format!("  {mark} {}\n", trunc(&td.content, 46)));
                }
            }
            // Files in scope (the dossier's file list).
            if !r.current_files.is_empty() {
                out.push_str(&format!("\nfiles ({}):\n", r.current_files.len()));
                for fpath in r.current_files.iter().take(8) {
                    out.push_str(&format!("  {}\n", trunc(fpath, 46)));
                }
            }
            out
        }
        None => "Select an agent (j/k) to see its dossier · n launches a new agent.".to_string(),
    };
    // Empty-work-area hint (pui-workbench-usability D-002): at startup the
    // workbench opens with a blank work area + no agent — surface the launch
    // affordance instead of leaving it silent. Prepended so it's the first thing
    // seen whether or not an agent row is selected.
    let body = if app.work_area_empty() {
        format!(
            "{} Work area is empty — press n to launch an agent here.\n\n{}",
            glyph::nav::PANES,
            body
        )
    } else {
        body
    };
    f.render_widget(
        Paragraph::new(body)
            .wrap(Wrap { trim: false })
            .style(Theme::panel())
            .block(Theme::block(Line::from(" Dossier "), sel.is_some())),
        area,
    );
}

/// Fleet-wide plan progress — one bar per live plan, ordered by priority desc
/// then by remaining work desc (the plans that need attention float up).
fn draw_plan_progress(f: &mut Frame, app: &App, agg: &FleetAggregate, area: Rect) {
    // Pot-scope-filtered (D-003), matching the aggregate's headline numbers.
    let mut plans: Vec<&crate::models::PlanSummary> = app
        .visible_plans()
        .into_iter()
        .filter(|p| !p.archived && p.item_counts.total() > 0)
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
            "(no plan items)",
            Theme::dim(),
        )))]
    } else {
        items
    };
    f.render_widget(
        List::new(body).style(Theme::panel()).block(Theme::block(
            Line::from(format!(
                " Plan progress — {}/{} items done ",
                agg.plan_items_done, agg.plan_items_total
            )),
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

    fn curated(id: &str, kind: &str, title: &str, harness: &str, urgent: bool) -> CuratedSignal {
        CuratedSignal {
            id: id.into(),
            kind: kind.into(),
            title: title.into(),
            detail: None,
            harness: if harness.is_empty() {
                None
            } else {
                Some(harness.into())
            },
            severity: None,
            disposition: "surface".into(),
            urgent,
            ts: "2026-06-04T00:00:00Z".into(),
        }
    }

    #[test]
    fn curated_what_matters_renders_signals_when_curator_live() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false;
        app.fleet.set_curated_signals(vec![
            curated(
                "e1",
                "escalation",
                "needs a human decision",
                "papercup",
                true,
            ),
            curated("d1", "decision", "design review owed", "restart", false),
        ]);
        assert!(app.fleet.curation_available);
        let text = render_fleet(&app, 120, 24);
        assert!(text.contains("What matters (2)"));
        assert!(text.contains("the curator's view"));
        assert!(text.contains("needs a human decision"));
        assert!(text.contains("design review owed"));
        assert!(text.contains("[papercup]"));
        assert!(text.contains(glyph::severity::WARN)); // escalation glyph (Brief 27 vocabulary)
    }

    #[test]
    fn curated_empty_feed_shows_calm() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false;
        app.fleet.set_curated_signals(vec![]); // curator live, nothing salient
        let text = render_fleet(&app, 120, 24);
        assert!(text.contains("What matters (0)"));
        assert!(text.contains("fleet calm"));
    }

    #[test]
    fn curated_falls_back_to_heuristic_without_curator() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Fleet;
        app.show_presence = false;
        // No curation feed yet (curation_available == false) → the agents+detail
        // heuristic, not the what-matters panel.
        assert!(!app.fleet.curation_available);
        let text = render_fleet(&app, 120, 24);
        assert!(text.contains("Agents"));
        assert!(!text.contains("What matters"));
    }

    /// Brief 27 / P-010: buffer-level width safety. Render the Fleet view
    /// (agent roster + work-item rollup + curated signals) at 80 and 120 cols
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

        // Curated mode — the What-matters panel renders the signal glyphs
        // (escalation ▲ / blocker ⊘) plus the ⚡ header emoji (sanctioned).
        app.fleet.set_curated_signals(vec![
            curated("e1", "escalation", "needs a human", "papercup", true),
            curated("b1", "blocker", "blocked on X", "papercup", false),
        ]);
        for &(w, h) in &[(80u16, 30u16), (120, 30)] {
            let rows = scan(&app, w, h);
            let joined = rows.join("\n");
            assert!(
                joined.contains(glyph::severity::WARN),
                "escalation glyph missing from curated render at width {w}"
            );
        }
    }

    #[test]
    fn curation_feed_payload_parses() {
        // The inner JSON of the curation:feed MCP envelope.
        let j = r#"{"signals":[
            {"id":"escalation:m1","kind":"escalation","title":"help","detail":null,
             "harness":"papercup","severity":"advisory","ref":"escalation:m1",
             "ts":"2026-06-04T00:00:00Z","disposition":"surface","urgent":true}
        ],"count":1,"policyVersion":"curator-v1"}"#;
        let p: crate::models::CurationFeedPayload = serde_json::from_str(j).unwrap();
        assert_eq!(p.signals.len(), 1);
        assert_eq!(p.signals[0].kind, "escalation");
        assert!(p.signals[0].urgent);
        assert_eq!(p.signals[0].disposition, "surface");
        assert_eq!(p.signals[0].harness.as_deref(), Some("papercup"));
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
        if let Ok(v) = c.roster_typed().await {
            app.set_roster(v);
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
