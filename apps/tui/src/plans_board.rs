//! The Plans status board pane (pui-plans-status-board-2026-06-14) — the dock's
//! at-a-glance summary of every plan, with a right-side detail of the selected
//! plan's full info + its work items and who is working each one.
//!
//! Rendered by the pinned `pui plans-pane` dock tab as a master-detail surface:
//!   * LEFT (master) — one row per plan: status, a prominent agent-count badge
//!     ("● N working" — roster rows whose `current_plan_slug` matches), and
//!     done/total progress. Sorted by STATUS (active → ready → draft → shipped →
//!     superseded), then worked-on / priority / recency within a status.
//!   * RIGHT (detail of the selected plan) — TOP: full plan info (title, status,
//!     harness, owner, updated, priority, progress, the agents on it BY NAME);
//!     BOTTOM: the plan's work items from `plan_item_states` — per-item status,
//!     who's on it (live claim holder ?? assignee), claim liveness, and intent.
//!
//! No new backend: the list joins two datasets the pui already fetches in
//! `refetch_all` (`plans_typed` + `roster_typed`), push-driven for the pinned
//! pane. The right-side work-items detail rides `plan_item_states`, fetched for
//! the selected plan on j/k (`Action::FetchPlanItemStates`) + kept fresh by the
//! active-plan poller (`publish_active_plan` now covers `Tab::PlansBoard`). The
//! keymap (j/k select · g refresh) lives in `app.rs::plans_board_key`; this
//! module is the pure row-join (`board_rows`) + the renderer.

use crate::app::App;
use crate::glyph;
use crate::models::{PlanItemState, PlanSummary, RosterEntry};
use crate::theme::Theme;
use crate::ui::trunc;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap},
    Frame,
};

/// One board row: a plan plus the live (non-stale) agents working it.
pub struct PlanBoardRow<'a> {
    pub plan: &'a PlanSummary,
    pub agents: Vec<&'a RosterEntry>,
}

impl PlanBoardRow<'_> {
    /// A plan is "being worked on" when ≥1 live agent has claimed it as their
    /// current plan OR it has work in flight (a `wip` item).
    pub fn worked(&self) -> bool {
        !self.agents.is_empty() || self.plan.item_counts.wip > 0
    }
}

/// Sort rank for a plan status (owner ask 2026-06-14): active up top, then
/// ready, then draft, then the terminal states (shipped before superseded);
/// anything unrecognised sinks to the bottom.
fn status_rank(status: &str) -> u8 {
    match status.trim().to_ascii_lowercase().as_str() {
        "active" => 0,
        "ready" => 1,
        "draft" => 2,
        "shipped" => 3,
        "superseded" => 4,
        _ => 5,
    }
}

/// The board rows in render order: every in-scope, non-archived plan joined
/// with its live agents, sorted by STATUS (owner ask 2026-06-14), then
/// worked-on / priority / recency within a status. Pure (reads `app.plans` +
/// `app.roster`) so `app.rs` reuses it for the selection-clamp count + the
/// selected-plan resolution, and the tests assert the ordering.
pub fn board_rows(app: &App) -> Vec<PlanBoardRow<'_>> {
    let mut rows: Vec<PlanBoardRow> = app
        .visible_plans()
        .into_iter()
        .filter(|p| !p.archived)
        .map(|plan| {
            let agents = app
                .roster
                .iter()
                .filter(|r| {
                    !r.stale && r.current_plan_slug.as_deref() == Some(plan.slug.as_str())
                })
                .collect::<Vec<_>>();
            PlanBoardRow { plan, agents }
        })
        .collect();
    rows.sort_by(|a, b| {
        // STATUS first (active → ready → draft → shipped → superseded), then
        // worked-on first, higher priority, more-recently updated, slug.
        status_rank(&a.plan.status)
            .cmp(&status_rank(&b.plan.status))
            .then(b.worked().cmp(&a.worked()))
            .then(b.plan.priority.unwrap_or(0).cmp(&a.plan.priority.unwrap_or(0)))
            .then(b.plan.updated.cmp(&a.plan.updated))
            .then(a.plan.slug.cmp(&b.plan.slug))
    });
    rows
}

/// A compact done/total progress bar (`█`-filled, `░`-empty). An item-less plan
/// renders as an all-`─` placeholder so the column still aligns.
fn progress_bar(done: u32, total: u32, width: usize) -> String {
    if total == 0 {
        return "─".repeat(width);
    }
    let filled = ((done as usize * width) / total as usize).min(width);
    format!("{}{}", "█".repeat(filled), "░".repeat(width - filled))
}

/// The prominent agent-count badge for a plan (owner ask: "make it more obvious
/// how many agents are currently working on the plan"). Bold + bright when
/// anyone is on it, dim when idle.
fn agent_badge(n: usize) -> Span<'static> {
    if n == 0 {
        Span::styled(format!("{} idle", glyph::liveness::STALE), Theme::dim())
    } else {
        Span::styled(
            format!("{} {n} working", glyph::liveness::LIVE),
            Theme::success().add_modifier(Modifier::BOLD),
        )
    }
}

/// One master-list row (LEFT): status glyph · status · slug · agent badge ·
/// done/total. The richer breakdown (bar, chips, next-action) lives in the
/// detail pane, so the narrow list column stays glanceable.
fn row_line<'a>(row: &PlanBoardRow<'a>) -> Line<'a> {
    let p = row.plan;
    let c = &p.item_counts;
    Line::from(vec![
        Theme::status_marker(&p.status),
        Span::styled(format!(" {:<10}", trunc(&p.status, 10)), Theme::status_style(&p.status)),
        Span::raw(format!("{:<22} ", trunc(&p.slug, 21))),
        agent_badge(row.agents.len()),
        Span::styled(format!("  {}/{}", c.done, c.total()), Theme::dim()),
    ])
}

/// One work-item row (RIGHT, bottom): disposition glyph · item id · status ·
/// who's on it · claim liveness · intent. Mirrors the Plans-tab item line but
/// coloured for the board (pui-plans-status-board P-008).
fn item_line(it: &PlanItemState) -> Line<'static> {
    use crate::glyph::{liveness, severity, status};
    let (glyph, label, gstyle) = match it.disposition.as_str() {
        "active" => (liveness::LIVE, "active", Theme::success()),
        "assigned-idle" => (liveness::IDLE, "assigned", Theme::info()),
        "claimed-pooled" => (status::NEEDS_HUMAN, "claimed", Theme::status_style("needs-human")),
        "claimed-mismatch" => (severity::WARN, "MISMATCH", Theme::warn()),
        "pooled" => (severity::INFO, "pooled", Theme::dim()),
        _ => ("?", "—", Theme::dim()),
    };
    let who = it
        .claim_owner_name
        .as_deref()
        .or(it.assignee_name.as_deref())
        .unwrap_or("—");
    let who_style = if it.claim_owner_name.is_some() {
        Theme::success()
    } else if it.assignee_name.is_some() {
        Theme::info()
    } else {
        Theme::dim()
    };
    let live = match it.claim_liveness_mode.as_deref() {
        Some("availability") => "avail",
        Some("activity") => "activ",
        _ => "",
    };
    let intent = it.claim_intent.as_deref().unwrap_or("");
    Line::from(vec![
        Span::styled(format!("{glyph} "), gstyle),
        Span::raw(format!("{:<8}", trunc(&it.item_id, 8))),
        Span::styled(format!("{:<9}", label), gstyle),
        Span::styled(format!("{:<16}", trunc(who, 15)), who_style),
        Span::styled(format!("{:<6}", live), Theme::dim()),
        Span::styled(trunc(intent, 36), Theme::dim()),
    ])
}

/// The detail-popup body for one plan work item (owner ask 2026-06-16, the
/// Items pane's Enter) — id · status · disposition · who's on it (live claim ??
/// durable assignee) · claim liveness mode + lease · declared intent. Shared by
/// the in-app Plans tab and the dock plans-pane popups.
pub(crate) fn item_detail_lines(it: &PlanItemState) -> Vec<Line<'static>> {
    let mut out = vec![
        Line::from(Span::styled(it.item_id.clone(), Theme::title())),
        Line::from(vec![
            Span::styled("status      ", Theme::dim()),
            Span::raw(it.item_status.clone().unwrap_or_else(|| "—".to_string())),
            Span::styled("   disposition  ", Theme::dim()),
            Span::raw(if it.disposition.is_empty() {
                "—".to_string()
            } else {
                it.disposition.clone()
            }),
        ]),
    ];
    let who = it
        .claim_owner_name
        .clone()
        .or_else(|| it.claim_owner.clone())
        .or_else(|| it.assignee_name.clone());
    if let Some(w) = who.filter(|s| !s.is_empty()) {
        out.push(Line::from(vec![
            Span::styled("who         ", Theme::dim()),
            Span::raw(w),
        ]));
    }
    if let Some(m) = it.claim_liveness_mode.clone().filter(|s| !s.is_empty()) {
        out.push(Line::from(vec![
            Span::styled("liveness    ", Theme::dim()),
            Span::raw(m),
        ]));
    }
    if let Some(exp) = it.claim_expires_ts.clone().filter(|s| !s.is_empty()) {
        out.push(Line::from(vec![
            Span::styled("lease ends  ", Theme::dim()),
            Span::raw(exp),
        ]));
    }
    if let Some(intent) = it.claim_intent.clone().filter(|s| !s.is_empty()) {
        out.push(Line::from(Span::styled("─".repeat(40), Theme::dim())));
        out.push(Line::from(Span::styled("intent", Theme::info())));
        for l in intent.lines() {
            out.push(Line::from(l.to_string()));
        }
    }
    out
}

/// RIGHT-top: the selected plan's full info — the fields the master list can't
/// fit, plus the agents working it spelled out by name (owner ask).
fn draw_plan_detail(f: &mut Frame, plan: &PlanSummary, agents: &[&RosterEntry], area: Rect) {
    let c = &plan.item_counts;
    let agents_line = if agents.is_empty() {
        Line::from(Span::styled("agents:  none working", Theme::dim()))
    } else {
        let names = agents
            .iter()
            .map(|r| r.agent.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| r.label.clone()))
            .map(|n| trunc(&n, 20))
            .collect::<Vec<_>>()
            .join(", ");
        Line::from(vec![
            Span::styled(format!("agents:  {} ", agents.len()), Theme::success().add_modifier(Modifier::BOLD)),
            Span::styled(trunc(&names, 60), Theme::success()),
        ])
    };
    let mut lines = vec![
        Line::from(Span::styled(trunc(&plan.title, 70), Theme::title())),
        Line::from(vec![
            Span::raw("status:  "),
            Theme::status_marker(&plan.status),
            Span::styled(format!(" {}", plan.status), Theme::status_style(&plan.status)),
            Span::styled(
                format!(
                    "   harness: {}   prio: {}",
                    plan.harness.clone().unwrap_or_else(|| "—".into()),
                    plan.priority.map(|p| p.to_string()).unwrap_or_else(|| "—".into()),
                ),
                Theme::dim(),
            ),
        ]),
        Line::from(Span::styled(
            format!(
                "owner:   {}   updated: {}",
                plan.owner.clone().unwrap_or_else(|| "—".into()),
                if plan.updated.is_empty() { "—" } else { &plan.updated },
            ),
            Theme::dim(),
        )),
        // Progress: bar + the full status breakdown (completed / in-progress /
        // not-started / attention).
        Line::from(vec![
            Span::raw("items:   "),
            Span::styled(format!("{} ", progress_bar(c.done, c.total(), 14)), Theme::info()),
            Span::styled(format!("{}", c.done), Theme::success()),
            Span::styled(format!("/{} done", c.total()), Theme::dim()),
        ]),
        Line::from(vec![
            Span::raw("         "),
            Span::styled(format!("{} {} in-progress  ", glyph::status::WIP, c.wip), Theme::info()),
            Span::styled(format!("{} {} not-started  ", glyph::status::TODO, c.todo), Theme::dim()),
            Span::styled(format!("{} {} blocked  ", glyph::status::BLOCKED, c.blocked), if c.blocked > 0 { Theme::danger() } else { Theme::dim() }),
            Span::styled(format!("{} {} needs-human", glyph::status::NEEDS_HUMAN, c.needs_human), if c.needs_human > 0 { Theme::status_style("needs-human") } else { Theme::dim() }),
        ]),
        agents_line,
    ];
    if let Some(next) = plan.next_action.as_deref().filter(|s| !s.trim().is_empty()) {
        lines.push(Line::from(vec![
            Span::styled("next:    ", Theme::dim()),
            Span::styled(trunc(next.trim(), 64), Style::default()),
        ]));
    }
    f.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .block(Block::default().borders(Borders::ALL).title(" Plan ")),
        area,
    );
}

/// RIGHT-bottom: the selected plan's work items + who's on each, from
/// `plan_item_states`. Guarded on `states.plan == plan_slug` so a stale fetch
/// from a prior selection never paints the wrong plan. `focused` adds the active
/// border + a highlighted cursor over the items (owner ask 2026-06-16); `cursor`
/// is the selected item index when this pane is the focused/entered one.
fn draw_work_items(
    f: &mut Frame,
    app: &App,
    plan_slug: &str,
    area: Rect,
    focused: bool,
    cursor: Option<usize>,
) {
    let states = app
        .plan_item_states
        .as_ref()
        .filter(|s| s.plan == plan_slug);
    // The header row sits at flat index 0, so the cursor's item maps to flat
    // index `cursor + 1` (the highlight lands on a real item, never the header).
    let mut item_count = 0usize;
    let (title, body): (String, Vec<ListItem>) = match states {
        Some(s) if !s.items.is_empty() => {
            item_count = s.items.len();
            let mode = if s.harness_liveness_mode.is_empty() {
                "—".to_string()
            } else {
                s.harness_liveness_mode.clone()
            };
            let header = ListItem::new(Line::from(Span::styled(
                format!("{:<2}{:<8}{:<9}{:<16}{:<6}{}", "", "item", "state", "who", "live", "intent"),
                Theme::dim(),
            )));
            let mut items = vec![header];
            items.extend(s.items.iter().map(|it| ListItem::new(item_line(it))));
            (format!(" Work items ({}) · liveness: {mode} ", s.items.len()), items)
        }
        Some(_) => (
            " Work items (0) ".to_string(),
            vec![ListItem::new(Line::from(Span::styled(
                "  this plan has no items yet",
                Theme::dim(),
            )))],
        ),
        None => (
            " Work items ".to_string(),
            vec![ListItem::new(Line::from(Span::styled("  loading…", Theme::dim())))],
        ),
    };
    let mut state = ListState::default();
    if let Some(c) = cursor {
        if item_count > 0 {
            state.select(Some(c.min(item_count - 1) + 1));
        }
    }
    let list = List::new(body)
        .block(Theme::block(Line::from(title), focused))
        .highlight_style(Theme::selected())
        .highlight_symbol("▸ ");
    f.render_stateful_widget(list, area, &mut state);
}

pub fn draw_plans_board(f: &mut Frame, app: &App, body: Rect) {
    let rows = board_rows(app);
    let outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // header summary (full width)
            Constraint::Min(1),    // master | detail
            Constraint::Length(1), // footer (full width)
        ])
        .split(body);

    // Header: totals + a prominent agent count (owner ask #1).
    let worked = rows.iter().filter(|r| r.worked()).count();
    let agents_total: usize = rows.iter().map(|r| r.agents.len()).sum();
    let title = Line::from(vec![
        Span::styled(format!(" Plans — {} total", rows.len()), Theme::title()),
        Span::styled(
            format!(" · {worked} being worked on"),
            if worked > 0 { Theme::info() } else { Theme::dim() },
        ),
        Span::raw(" · "),
        Span::styled(
            format!("{} {agents_total} agent(s) active", glyph::liveness::LIVE),
            if agents_total > 0 {
                Theme::success().add_modifier(Modifier::BOLD)
            } else {
                Theme::dim()
            },
        ),
    ]);
    f.render_widget(Paragraph::new(title), outer[0]);

    if rows.is_empty() {
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(
                " no plans in scope — create one from the Plans tab",
                Theme::dim(),
            ))),
            outer[1],
        );
    } else {
        // Master (left) | detail (right).
        let cols = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(44), Constraint::Percentage(56)])
            .split(outer[1]);

        // Two-level pane nav (owner ask 2026-06-16): the focused pane wears the
        // active border; ←/→ (or ↑/↓ browsing) switch list ↔ items, Enter drills
        // in, ↑/↓ then move within.
        let list_focused = app.plans_focus == crate::app::PlansFocus::List;
        let items_focused = app.plans_focus == crate::app::PlansFocus::Items;
        let sel = app.plans_board_sel.min(rows.len() - 1);
        let items: Vec<ListItem> = rows.iter().map(|r| ListItem::new(row_line(r))).collect();
        let mut state = ListState::default();
        state.select(Some(sel));
        let list = List::new(items)
            .block(Theme::block(
                Line::from(format!(" Plans ({}) ", rows.len())),
                list_focused,
            ))
            .highlight_style(Theme::selected())
            .highlight_symbol("▸ ");
        f.render_stateful_widget(list, cols[0], &mut state);

        // Right column: plan info (top) + work items (bottom) for the selection.
        let right = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(10), Constraint::Min(0)])
            .split(cols[1]);
        let selected = &rows[sel];
        draw_plan_detail(f, selected.plan, &selected.agents, right[0]);
        let item_cursor = items_focused.then_some(app.plan_items_sel);
        draw_work_items(f, app, &selected.plan.slug, right[1], items_focused, item_cursor);
    }

    // Footer: the two-level nav legend (owner ask 2026-06-16) + glyph legend.
    let nav = if app.plans_entered {
        let pane = match app.plans_focus {
            crate::app::PlansFocus::List => "plans",
            crate::app::PlansFocus::Items => "work items",
        };
        format!(" ▸ {pane} · inside   ↑/↓ move · ⏎ open · Esc back · g refresh   ")
    } else {
        " ↑/↓ or ←/→ switch pane · ⏎ enter · g refresh   ".to_string()
    };
    let footer = Line::from(vec![Span::styled(
        format!(
            "{nav}{} working · {} in-progress {} not-started {} blocked {} needs-human",
            glyph::liveness::LIVE,
            glyph::status::WIP,
            glyph::status::TODO,
            glyph::status::BLOCKED,
            glyph::status::NEEDS_HUMAN,
        ),
        Theme::dim(),
    )]);
    f.render_widget(Paragraph::new(footer), outer[2]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Tab;
    use crate::models::{ItemCounts, PlanItemState, PlanItemStates};
    use ratatui::{backend::TestBackend, Terminal};

    fn plan(slug: &str, status: &str, counts: ItemCounts, priority: Option<i64>) -> PlanSummary {
        PlanSummary {
            slug: slug.into(),
            title: format!("{slug} title"),
            status: status.into(),
            updated: "2026-06-14".into(),
            owner: Some("avi@x.z".into()),
            harness: Some("papercup".into()),
            archived: false,
            next_action: Some(format!("do the next thing for {slug}")),
            item_counts: counts,
            priority,
        }
    }

    fn counts(todo: u32, wip: u32, done: u32, blocked: u32, needs_human: u32) -> ItemCounts {
        ItemCounts { todo, wip, blocked, needs_human, done, dropped: 0, unknown: 0 }
    }

    fn agent_on(plan_slug: &str, name: &str, stale: bool) -> RosterEntry {
        RosterEntry {
            owner_id: format!("su-{name}"),
            agent: Some(name.into()),
            current_plan_slug: Some(plan_slug.into()),
            stale,
            liveness: "live".into(),
            ..Default::default()
        }
    }

    fn board_app() -> App {
        let mut app = App::new();
        app.tab = Tab::PlansBoard;
        app.pinned = Some(Tab::PlansBoard);
        app.set_plans(vec![
            plan("draft-plan", "draft", counts(3, 0, 0, 0, 0), None),
            plan("worked-plan", "active", counts(2, 3, 5, 1, 0), Some(2)),
            plan("shipped-plan", "shipped", counts(0, 0, 9, 0, 0), None),
            plan("ready-plan", "ready", counts(4, 0, 0, 0, 1), Some(1)),
        ]);
        app.update(crate::event::Event::Roster {
            active: vec![
                agent_on("worked-plan", "queen", false),
                agent_on("worked-plan", "worker", false),
                agent_on("ready-plan", "ghost", true), // stale → not counted
            ],
            pending: vec![],
        });
        app
    }

    fn render(app: &App, w: u16, h: u16) -> String {
        let backend = TestBackend::new(w, h);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw_plans_board(f, app, f.area())).unwrap();
        let buf = terminal.backend().buffer().clone();
        let mut out = String::new();
        for y in 0..buf.area.height {
            for x in 0..buf.area.width {
                out.push_str(buf.cell((x, y)).unwrap().symbol());
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn plans_sort_by_status_active_ready_draft_shipped() {
        let app = board_app();
        let rows = board_rows(&app);
        let order: Vec<&str> = rows.iter().map(|r| r.plan.slug.as_str()).collect();
        assert_eq!(order, vec!["worked-plan", "ready-plan", "draft-plan", "shipped-plan"]);
    }

    #[test]
    fn agent_count_is_prominent_in_list_header_and_detail() {
        let app = board_app(); // selection defaults to row 0 = worked-plan (2 agents)
        let s = render(&app, 150, 24);
        // Header: total live agents across plans (queen + worker = 2; ghost stale).
        assert!(s.contains("2 agent(s) active"), "header agent total: {s}");
        // Master row badge: the prominent "● N working".
        assert!(s.contains(&format!("{} 2 working", glyph::liveness::LIVE)), "row badge: {s}");
        // Idle plans read "idle", not a misleading agent count.
        assert!(s.contains(&format!("{} idle", glyph::liveness::STALE)), "idle badge: {s}");
        // Detail names the agents on the selected plan.
        assert!(s.contains("agents:  2"), "detail agent count: {s}");
        assert!(s.contains("queen") && s.contains("worker"), "detail agent names: {s}");
    }

    #[test]
    fn detail_shows_full_plan_info_and_progress() {
        let app = board_app();
        let s = render(&app, 150, 24);
        assert!(s.contains("worked-plan title"), "plan title in detail: {s}");
        assert!(s.contains("Plan "), "plan detail block title: {s}");
        assert!(s.contains("5/11 done"), "progress count: {s}");
        assert!(s.contains("3 in-progress"), "wip breakdown: {s}");
        assert!(s.contains("1 blocked"), "blocked breakdown: {s}");
        assert!(s.contains("do the next thing for worked-plan"), "next action: {s}");
    }

    #[test]
    fn work_items_pane_lists_items_and_who_is_on_them() {
        let mut app = board_app();
        // selection = worked-plan; supply its item states.
        app.set_plan_item_states(PlanItemStates {
            harness: "papercup".into(),
            plan: "worked-plan".into(),
            harness_liveness_mode: "activity".into(),
            items: vec![
                PlanItemState {
                    item_id: "P-001".into(),
                    item_status: Some("wip".into()),
                    in_plan: true,
                    disposition: "active".into(),
                    assignee_name: Some("worker".into()),
                    claim_owner: Some("worker".into()),
                    claim_owner_name: Some("worker".into()),
                    claim_intent: Some("porting the reducer".into()),
                    claim_liveness_mode: Some("activity".into()),
                    claim_expires_ts: None,
                },
                PlanItemState {
                    item_id: "P-002".into(),
                    item_status: Some("todo".into()),
                    in_plan: true,
                    disposition: "pooled".into(),
                    assignee_name: None,
                    claim_owner: None,
                    claim_owner_name: None,
                    claim_intent: None,
                    claim_liveness_mode: None,
                    claim_expires_ts: None,
                },
            ],
        });
        let s = render(&app, 150, 24);
        assert!(s.contains("Work items (2)"), "work-items title: {s}");
        assert!(s.contains("P-001"), "item id: {s}");
        assert!(s.contains("worker"), "who's on item: {s}");
        assert!(s.contains("porting the reducer"), "item intent: {s}");
        assert!(s.contains("liveness: activity"), "liveness mode: {s}");
    }

    #[test]
    fn work_items_pane_shows_loading_until_states_arrive() {
        let app = board_app(); // no plan_item_states set yet
        let s = render(&app, 150, 24);
        assert!(s.contains("loading…"), "work-items loading hint: {s}");
    }

    #[test]
    fn selection_highlight_follows_plans_board_sel() {
        let mut app = board_app();
        app.plans_board_sel = 2; // third row after the sort = draft-plan
        let s = render(&app, 150, 24);
        let marked: Vec<&str> = s.lines().filter(|l| l.contains('▸')).collect();
        assert_eq!(marked.len(), 1, "exactly one row marked: {s}");
        assert!(marked[0].contains("draft-plan"), "{s}");
    }

    #[test]
    fn empty_board_reads_clearly() {
        let mut app = App::new();
        app.tab = Tab::PlansBoard;
        let s = render(&app, 150, 12);
        assert!(s.contains("Plans — 0 total"), "{s}");
        assert!(s.contains("no plans in scope"), "{s}");
    }

    #[test]
    fn archived_plans_are_hidden() {
        let mut app = App::new();
        app.tab = Tab::PlansBoard;
        let mut archived = plan("archived-plan", "active", counts(1, 0, 0, 0, 0), None);
        archived.archived = true;
        app.set_plans(vec![archived, plan("live-plan", "active", counts(0, 1, 0, 0, 0), None)]);
        let rows = board_rows(&app);
        assert_eq!(rows.len(), 1, "archived plan filtered out");
        assert_eq!(rows[0].plan.slug, "live-plan");
    }

    #[test]
    fn progress_bar_fills_proportionally() {
        assert_eq!(progress_bar(0, 0, 4), "────");
        assert_eq!(progress_bar(0, 4, 4), "░░░░");
        assert_eq!(progress_bar(2, 4, 4), "██░░");
        assert_eq!(progress_bar(4, 4, 4), "████");
        assert_eq!(progress_bar(9, 9, 8), "████████");
    }
}
