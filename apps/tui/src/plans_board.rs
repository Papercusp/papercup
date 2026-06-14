//! The Plans status board pane (pui-plans-status-board-2026-06-14) — the dock's
//! at-a-glance summary of every plan.
//!
//! Rendered by the pinned `pui plans-pane` dock tab: one row per plan with its
//! status, whether it is being worked on, how many agents are on it (roster
//! rows whose `current_plan_slug` matches), and its item progress — completed
//! (`done`) / in-progress (`wip`) / not-started (`todo`), plus `blocked` +
//! `needs-human` attention chips and the plan's `## Now` next-action line.
//!
//! No new backend: the board joins two datasets the pui already fetches in
//! `refetch_all` (`plans_typed` + `roster_typed`), so a pinned pane gets them
//! push-driven for free (startup + SSE invalidation + the 60s safety net). The
//! keymap (j/k highlight · g refresh) lives in `app.rs::plans_board_key`; this
//! module is the pure row-join (`board_rows`) + the renderer (the wake_board.rs
//! convention).

use crate::app::App;
use crate::glyph;
use crate::models::{PlanSummary, RosterEntry};
use crate::theme::Theme;
use crate::ui::trunc;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::{List, ListItem, Paragraph},
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

/// Sort rank for a plan status — actively-running first, terminal states last.
fn status_rank(status: &str) -> u8 {
    match status.trim().to_ascii_lowercase().as_str() {
        "active" => 0,
        "ready" => 1,
        "draft" => 2,
        "superseded" => 4,
        "shipped" => 5,
        _ => 3,
    }
}

/// The board rows in render order: every in-scope, non-archived plan joined
/// with its live agents, sorted worked-on-first → status → priority → recency.
/// Pure (reads `app.plans` + `app.roster`) so `app.rs` can reuse it for the
/// selection-clamp count and the tests can assert the ordering.
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
                    !r.stale
                        && r.current_plan_slug.as_deref() == Some(plan.slug.as_str())
                })
                .collect::<Vec<_>>();
            PlanBoardRow { plan, agents }
        })
        .collect();
    rows.sort_by(|a, b| {
        // worked-on first (true sorts ahead of false), then status, then higher
        // priority, then more-recently updated, then slug for a stable order.
        b.worked()
            .cmp(&a.worked())
            .then(status_rank(&a.plan.status).cmp(&status_rank(&b.plan.status)))
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

/// One plan's render line: selection marker · status glyph · status · slug
/// (+ title) · agents · progress bar · done/total · in-progress/attention chips
/// · the `## Now` next-action.
fn row_line<'a>(row: &PlanBoardRow<'a>, selected: bool) -> Line<'a> {
    let p = row.plan;
    let c = &p.item_counts;
    let sel_style = if selected {
        Theme::selected()
    } else {
        Style::default()
    };
    let mut spans = vec![
        Span::styled(if selected { " ▸ " } else { "   " }.to_string(), sel_style),
        Theme::status_marker(&p.status),
        Span::styled(format!(" {:<10}", trunc(&p.status, 10)), Theme::status_style(&p.status)),
        Span::styled(format!("{:<32}", trunc(&p.slug, 31)), sel_style),
    ];

    // Agents on the plan — the live-dot glyph + count, success-coloured when
    // anyone is on it (the "being worked on" signal), dim at zero.
    if row.agents.is_empty() {
        spans.push(Span::styled(format!("  {} 0 ", glyph::liveness::STALE), Theme::dim()));
    } else {
        spans.push(Span::styled(
            format!("  {} {} ", glyph::liveness::LIVE, row.agents.len()),
            Theme::success(),
        ));
    }

    // Progress: a bar + done/total. The bar reads green-ish via success; the
    // count keeps done in success and the denominator dim.
    spans.push(Span::styled(format!(" {} ", progress_bar(c.done, c.total(), 10)), Theme::info()));
    spans.push(Span::styled(format!("{}", c.done), Theme::success()));
    spans.push(Span::styled(format!("/{} ", c.total()), Theme::dim()));

    // In-progress + not-started + attention chips (only when non-zero).
    if c.wip > 0 {
        spans.push(Span::styled(format!(" {}{}", glyph::status::WIP, c.wip), Theme::info()));
    }
    if c.todo > 0 {
        spans.push(Span::styled(format!(" {}{}", glyph::status::TODO, c.todo), Theme::dim()));
    }
    if c.blocked > 0 {
        spans.push(Span::styled(
            format!(" {}{}", glyph::status::BLOCKED, c.blocked),
            Theme::danger(),
        ));
    }
    if c.needs_human > 0 {
        spans.push(Span::styled(
            format!(" {}{}", glyph::status::NEEDS_HUMAN, c.needs_human),
            Theme::status_style("needs-human"),
        ));
    }

    // The `## Now` next-action, dim — truncated; ratatui clips the tail at the
    // pane edge so a long line never wraps.
    if let Some(next) = p.next_action.as_deref().filter(|s| !s.trim().is_empty()) {
        spans.push(Span::styled(format!("  · {}", trunc(next.trim(), 60)), Theme::dim()));
    }

    Line::from(spans)
}

pub fn draw_plans_board(f: &mut Frame, app: &App, body: Rect) {
    let rows = board_rows(app);
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // title / summary
            Constraint::Min(1),    // the board
            Constraint::Length(1), // keymap footer
        ])
        .split(body);

    // Title: total plans, how many are being worked on, and the live-agent total.
    let worked = rows.iter().filter(|r| r.worked()).count();
    let agents_total: usize = rows.iter().map(|r| r.agents.len()).sum();
    let mut title = vec![Span::styled(
        format!(" Plans — {} total", rows.len()),
        Theme::title(),
    )];
    title.push(Span::styled(
        format!(" · {worked} being worked on"),
        if worked > 0 { Theme::info() } else { Theme::dim() },
    ));
    title.push(Span::styled(
        format!(" · {agents_total} agent(s) active"),
        if agents_total > 0 { Theme::success() } else { Theme::dim() },
    ));
    f.render_widget(Paragraph::new(Line::from(title)), chunks[0]);

    if rows.is_empty() {
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(
                " no plans in scope — create one from the Plans tab",
                Theme::dim(),
            ))),
            chunks[1],
        );
    } else {
        let sel = app.plans_board_sel.min(rows.len() - 1);
        let items: Vec<ListItem> = rows
            .iter()
            .enumerate()
            .map(|(i, row)| ListItem::new(row_line(row, i == sel)))
            .collect();
        f.render_widget(List::new(items), chunks[1]);
    }

    // Footer: legend + keymap. The chips' meaning is spelled out so the glyphs
    // read without a guess.
    let footer = Line::from(vec![Span::styled(
        format!(
            " j/k select · g refresh   {}=in-progress {}=not-started {}=blocked {}=needs-human · {} N=agents",
            glyph::status::WIP,
            glyph::status::TODO,
            glyph::status::BLOCKED,
            glyph::status::NEEDS_HUMAN,
            glyph::liveness::LIVE,
        ),
        Theme::dim(),
    )]);
    f.render_widget(Paragraph::new(footer), chunks[2]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Tab;
    use crate::models::ItemCounts;
    use ratatui::{backend::TestBackend, Terminal};

    fn plan(slug: &str, status: &str, counts: ItemCounts, priority: Option<i64>) -> PlanSummary {
        PlanSummary {
            slug: slug.into(),
            title: format!("{slug} title"),
            status: status.into(),
            updated: "2026-06-14".into(),
            owner: None,
            harness: Some("papercup".into()),
            archived: false,
            next_action: Some(format!("do the next thing for {slug}")),
            item_counts: counts,
            priority,
        }
    }

    fn counts(todo: u32, wip: u32, done: u32, blocked: u32, needs_human: u32) -> ItemCounts {
        ItemCounts {
            todo,
            wip,
            blocked,
            needs_human,
            done,
            dropped: 0,
            unknown: 0,
        }
    }

    fn agent_on(plan_slug: &str, stale: bool) -> RosterEntry {
        RosterEntry {
            owner_id: format!("su-{plan_slug}"),
            current_plan_slug: Some(plan_slug.into()),
            stale,
            liveness: "live".into(),
            ..Default::default()
        }
    }

    fn board_app() -> App {
        let mut app = App::new();
        app.tab = Tab::PlansBoard;
        app.set_plans(vec![
            plan("idle-plan", "active", counts(4, 0, 1, 0, 0), Some(1)),
            plan("worked-plan", "active", counts(2, 3, 5, 1, 0), Some(2)),
            plan("shipped-plan", "shipped", counts(0, 0, 9, 0, 0), None),
        ]);
        // Two live agents on worked-plan, one stale (ignored), none elsewhere.
        app.update(crate::event::Event::Roster {
            active: vec![
                agent_on("worked-plan", false),
                agent_on("worked-plan", false),
                agent_on("idle-plan", true), // stale → not counted
            ],
            pending: vec![],
        });
        app
    }

    fn render(app: &App) -> String {
        let backend = TestBackend::new(140, 12);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|f| draw_plans_board(f, app, f.area()))
            .unwrap();
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
    fn worked_on_plans_sort_first_with_agent_counts_and_progress() {
        let app = board_app();
        let rows = board_rows(&app);
        // worked-plan (live agents + wip) leads, idle-plan next (active, no
        // agents), shipped-plan last (terminal status).
        assert_eq!(rows[0].plan.slug, "worked-plan");
        assert_eq!(rows[0].agents.len(), 2);
        assert!(rows[0].worked());
        assert_eq!(rows[1].plan.slug, "idle-plan");
        assert!(!rows[1].worked());
        assert_eq!(rows[2].plan.slug, "shipped-plan");

        let s = render(&app);
        // Title summarises totals: 3 plans, 1 being worked on, 2 agents.
        assert!(s.contains("Plans — 3 total"), "{s}");
        assert!(s.contains("1 being worked on"), "{s}");
        assert!(s.contains("2 agent(s) active"), "{s}");
        // worked-plan shows its live-agent count + done/total (5/11).
        assert!(s.contains("worked-plan"), "{s}");
        assert!(s.contains(&format!("{} 2", glyph::liveness::LIVE)), "agent count: {s}");
        assert!(s.contains("5/11"), "progress done/total: {s}");
        // In-progress + attention chips render for worked-plan (wip 3, blocked 1).
        assert!(s.contains(&format!("{}3", glyph::status::WIP)), "wip chip: {s}");
        assert!(s.contains(&format!("{}1", glyph::status::BLOCKED)), "blocked chip: {s}");
        // The next-action line shows through.
        assert!(s.contains("do the next thing for worked-plan"), "{s}");
    }

    #[test]
    fn selection_marker_follows_plans_board_sel() {
        let mut app = board_app();
        app.plans_board_sel = 1; // second row (idle-plan after the sort)
        let s = render(&app);
        let marked: Vec<&str> = s.lines().filter(|l| l.contains('▸')).collect();
        assert_eq!(marked.len(), 1, "exactly one row marked: {s}");
        assert!(marked[0].contains("idle-plan"), "{s}");
    }

    #[test]
    fn empty_board_reads_clearly() {
        let mut app = App::new();
        app.tab = Tab::PlansBoard;
        let s = render(&app);
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
        assert_eq!(progress_bar(0, 0, 4), "────"); // no items → placeholder
        assert_eq!(progress_bar(0, 4, 4), "░░░░");
        assert_eq!(progress_bar(2, 4, 4), "██░░");
        assert_eq!(progress_bar(4, 4, 4), "████");
        assert_eq!(progress_bar(9, 9, 8), "████████"); // full
    }
}
