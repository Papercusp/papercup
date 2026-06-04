//! Rendering — a pure function of `&App`. No state mutation, so every view is
//! snapshot-testable against a ratatui `TestBackend`.

use crate::app::{App, Tab};
use crate::theme::Theme;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Tabs, Wrap},
    Frame,
};

pub fn draw(f: &mut Frame, app: &App) {
    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // tab strip
            Constraint::Min(1),    // body
            Constraint::Length(1), // status bar
        ])
        .split(f.area());

    draw_tabs(f, app, root[0]);
    match app.tab {
        Tab::Plans => draw_plans(f, app, root[1]),
        Tab::Inbox => draw_inbox(f, app, root[1]),
        Tab::Sessions => draw_sessions(f, app, root[1]),
    }
    draw_status(f, app, root[2]);

    // Overlays render on top of the body.
    if app.show_help {
        draw_help(f);
    } else if app.palette_open {
        draw_palette(f, app);
    }
}

fn draw_tabs(f: &mut Frame, app: &App, area: Rect) {
    let titles: Vec<Line> = Tab::ALL
        .iter()
        .enumerate()
        .map(|(i, t)| Line::from(format!(" {}:{} ", i + 1, t.title())))
        .collect();
    let tabs = Tabs::new(titles)
        .select(app.tab.index())
        .highlight_style(Theme::selected());
    f.render_widget(tabs, area);
}

fn draw_plans(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(36), Constraint::Percentage(64)])
        .split(area);

    let items: Vec<ListItem> = app
        .plans
        .iter()
        .map(|p| {
            ListItem::new(Line::from(vec![
                Span::raw(format!("{:<9}", trunc(&p.status, 9))),
                Span::raw(p.slug.clone()),
            ]))
        })
        .collect();
    let mut state = ListState::default();
    if !app.plans.is_empty() {
        state.select(Some(app.plan_sel));
    }
    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(Line::from(format!(" Plans ({}) ", app.plans.len()))),
        )
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, cols[0], &mut state);

    let detail = match app.selected_plan() {
        Some(p) => format!(
            "{}\n\nstatus:  {}\nharness: {}\nowner:   {}\nupdated: {}\n\nnext: {}",
            p.title,
            p.status,
            p.harness.clone().unwrap_or_default(),
            p.owner.clone().unwrap_or_default(),
            p.updated,
            p.next_action.clone().unwrap_or_default(),
        ),
        None => "No plans loaded.".to_string(),
    };
    let para = Paragraph::new(detail)
        .wrap(Wrap { trim: false })
        .block(Block::default().borders(Borders::ALL).title(" Detail "));
    f.render_widget(para, cols[1]);
}

fn draw_sessions(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(62), Constraint::Percentage(38)])
        .split(area);

    let items: Vec<ListItem> = app
        .roster
        .iter()
        .map(|r| {
            let dot = if r.stale {
                "○"
            } else if r.liveness == "live" {
                "●"
            } else {
                "◐"
            };
            let agent = r.agent.clone().unwrap_or_else(|| "-".into());
            let role = r.role.clone().unwrap_or_default();
            let feat = r.feature.clone().unwrap_or_default();
            ListItem::new(Line::from(format!(
                "{} {:<7} {:<24} {:<10} {:<8} {:>2}f",
                dot,
                trunc(&agent, 7),
                trunc(&r.label, 24),
                trunc(&role, 10),
                trunc(&feat, 8),
                r.current_files.len(),
            )))
        })
        .collect();
    let mut state = ListState::default();
    if !app.roster.is_empty() {
        state.select(Some(app.roster_sel));
    }
    let list = List::new(items)
        .block(
            Block::default().borders(Borders::ALL).title(Line::from(format!(
                " Sessions ({}) · n: launch ",
                app.roster.len()
            ))),
        )
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, cols[0], &mut state);

    let dossier = match app.selected_session() {
        Some(r) => {
            let files = if r.current_files.is_empty() {
                "(none)".to_string()
            } else {
                r.current_files.join("\n  ")
            };
            format!(
                "{}\n\nagent:    {}\nrole:     {}\nfeature:  {}\nliveness: {}{}\nplan:     {}\nbeat:     {}\n\nintent: {}\n\nfiles:\n  {}",
                r.label,
                r.agent.clone().unwrap_or_default(),
                r.role.clone().unwrap_or_default(),
                r.feature.clone().unwrap_or_default(),
                r.liveness,
                if r.stale { " (stale)" } else { "" },
                r.current_plan_slug.clone().unwrap_or_default(),
                r.heartbeat_at.clone().unwrap_or_default(),
                r.intent.clone().unwrap_or_default(),
                files,
            )
        }
        None => "No active sessions.".to_string(),
    };
    let para = Paragraph::new(dossier)
        .wrap(Wrap { trim: false })
        .block(Block::default().borders(Borders::ALL).title(" Dossier "));
    f.render_widget(para, cols[1]);
}

fn draw_inbox(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(48), Constraint::Percentage(52)])
        .split(area);

    let items: Vec<ListItem> = app
        .inbox
        .iter()
        .map(|it| {
            let loc = it
                .plan_slug
                .clone()
                .or_else(|| it.harness_slug.clone())
                .unwrap_or_default();
            let r = it.item_ref.clone().unwrap_or_default();
            let flag = if it.needs_human { "!" } else { " " };
            ListItem::new(Line::from(format!(
                "{}{:<11} {:<26} {}",
                flag,
                trunc(&it.status, 11),
                trunc(&format!("{loc}/{r}"), 26),
                trunc(&it.title, 38),
            )))
        })
        .collect();
    let mut state = ListState::default();
    if !app.inbox.is_empty() {
        state.select(Some(app.inbox_sel));
    }
    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(Line::from(format!(" Inbox ({}) ", app.inbox.len()))),
        )
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, cols[0], &mut state);

    let preview = match app.selected_inbox() {
        Some(it) => format!(
            "{}\n\nkind:   {}\nstatus: {}\nplan:   {}\nref:    {}\nneedsHuman: {}\n\n{}",
            it.title,
            it.kind,
            it.status,
            it.plan_slug.clone().unwrap_or_default(),
            it.item_ref.clone().unwrap_or_default(),
            it.needs_human,
            it.body.clone().unwrap_or_default(),
        ),
        None => "Inbox empty — nothing needs attention.".to_string(),
    };
    let para = Paragraph::new(preview)
        .wrap(Wrap { trim: false })
        .block(Block::default().borders(Borders::ALL).title(" Preview "));
    f.render_widget(para, cols[1]);
}

fn draw_status(f: &mut Frame, app: &App, area: Rect) {
    let (text, style) = match &app.last_error {
        Some(e) => (format!("⚠ {e}"), Theme::warn()),
        None => (app.status.clone(), Theme::dim()),
    };
    f.render_widget(Paragraph::new(Line::from(text)).style(style), area);
}

fn draw_help(f: &mut Frame) {
    let area = centered_rect(62, 60, f.area());
    let text = "pui — keys\n\n  1 / 2 / 3   Plans / Inbox / Sessions\n  j / k  ↑/↓  move selection\n  n           launch agent pane (Sessions)\n  :           command palette\n  ?           toggle this help\n  q / Ctrl-C  quit\n\n  (press any key to close)";
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(text).block(Block::default().borders(Borders::ALL).title(" Help ")),
        area,
    );
}

fn draw_palette(f: &mut Frame, app: &App) {
    let area = centered_rect(60, 18, f.area());
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(format!("> {}", app.palette_input)).block(
            Block::default()
                .borders(Borders::ALL)
                .title(" Command (Esc to close) "),
        ),
        area,
    );
}

/// A centered rect `pct_w` × `pct_h` percent of `area`.
fn centered_rect(pct_w: u16, pct_h: u16, area: Rect) -> Rect {
    let v = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - pct_h) / 2),
            Constraint::Percentage(pct_h),
            Constraint::Percentage((100 - pct_h) / 2),
        ])
        .split(area);
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - pct_w) / 2),
            Constraint::Percentage(pct_w),
            Constraint::Percentage((100 - pct_w) / 2),
        ])
        .split(v[1])[1]
}

/// Truncate to `n` chars (cheap; ASCII-oriented labels).
fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{PlanSummary, RosterEntry};
    use ratatui::{backend::TestBackend, Terminal};

    fn render(app: &App, w: u16, h: u16) -> String {
        let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
        term.draw(|f| draw(f, app)).unwrap();
        term.backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect()
    }

    fn plan(slug: &str, status: &str) -> PlanSummary {
        PlanSummary {
            slug: slug.into(),
            title: format!("Title {slug}"),
            status: status.into(),
            updated: "2026-06-04".into(),
            owner: Some("o@x.z".into()),
            harness: Some("papercup".into()),
            archived: false,
            next_action: Some("do the thing".into()),
        }
    }

    #[test]
    fn plans_view_renders_list_and_detail() {
        let mut app = App::new();
        app.set_plans(vec![plan("alpha-2026", "todo"), plan("beta-2026", "shipped")]);
        let text = render(&app, 90, 16);
        assert!(text.contains("Plans (2)"));
        assert!(text.contains("alpha-2026"));
        assert!(text.contains("Detail"));
        assert!(text.contains("Title alpha-2026")); // selected plan detail
        assert!(text.contains("papercup"));
    }

    #[test]
    fn sessions_view_renders_roster() {
        let mut app = App::new();
        app.tab = Tab::Sessions;
        app.set_roster(vec![RosterEntry {
            owner_id: "su-1".into(),
            label: "su · su-1".into(),
            intent: None,
            current_files: vec!["a.rs".into()],
            liveness: "live".into(),
            stale: false,
            agent: Some("claude".into()),
            role: Some("worker".into()),
            feature: None,
            current_plan_slug: None,
            heartbeat_at: None,
        }]);
        let text = render(&app, 100, 18);
        assert!(text.contains("Sessions (1)"));
        assert!(text.contains("claude"));
        assert!(text.contains("worker"));
        assert!(text.contains("Dossier"));
        assert!(text.contains("a.rs")); // file listed in the dossier
    }

    #[test]
    fn inbox_view_renders_items_and_preview() {
        use crate::models::AttentionItem;
        let mut app = App::new();
        app.tab = Tab::Inbox;
        app.set_inbox(vec![AttentionItem {
            id: "coord:esc:9".into(),
            kind: "coord-escalation".into(),
            source: "coord".into(),
            harness_slug: None,
            plan_slug: Some("my-plan".into()),
            item_ref: Some("P-002".into()),
            title: "Needs a human decision".into(),
            body: Some("Details of the escalation.".into()),
            status: "needs-human".into(),
            importance: Some(9.0),
            needs_human: true,
        }]);
        let text = render(&app, 100, 14);
        assert!(text.contains("Inbox (1)"));
        assert!(text.contains("needs-human"));
        assert!(text.contains("my-plan/P-002"));
        assert!(text.contains("coord-escalation")); // preview
        assert!(text.contains("Details of the escalation")); // body in preview
    }

    #[test]
    fn tab_strip_shows_all_tabs() {
        let app = App::new();
        let text = render(&app, 60, 8);
        assert!(text.contains("Plans"));
        assert!(text.contains("Inbox"));
        assert!(text.contains("Sessions"));
    }

    #[test]
    fn error_shows_in_status_bar() {
        let mut app = App::new();
        app.last_error = Some("backend down".into());
        let text = render(&app, 60, 8);
        assert!(text.contains("backend down"));
    }

    #[test]
    fn help_overlay_renders_when_shown() {
        let mut app = App::new();
        app.show_help = true;
        let text = render(&app, 80, 20);
        assert!(text.contains("Help"));
        assert!(text.contains("command palette"));
        assert!(text.contains("launch agent pane"));
    }

    #[test]
    fn palette_renders_input() {
        let mut app = App::new();
        app.palette_open = true;
        app.palette_input = "deploy".into();
        let text = render(&app, 80, 20);
        assert!(text.contains("Command"));
        assert!(text.contains("> deploy"));
    }
}
