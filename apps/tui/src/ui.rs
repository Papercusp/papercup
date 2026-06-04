//! Rendering — a pure function of `&App`. No state mutation, so every view is
//! snapshot-testable against a ratatui `TestBackend`.

use crate::app::{App, HarnessFocus, Tab};
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

    // P7: an always-visible presence sidebar (who's online + intent), toggled
    // with `p`. Suppressed on narrow terminals so it never crowds the body.
    let (body, presence) = if app.show_presence && root[1].width >= 80 {
        let cols = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(48), Constraint::Length(30)])
            .split(root[1]);
        (cols[0], Some(cols[1]))
    } else {
        (root[1], None)
    };

    match app.tab {
        Tab::Plans => draw_plans(f, app, body),
        Tab::Inbox => draw_inbox(f, app, body),
        Tab::Sessions => draw_sessions(f, app, body),
        Tab::Harnesses => draw_harnesses(f, app, body),
        Tab::Docs => draw_docs(f, app, body),
        Tab::Activity => draw_activity(f, app, body),
        Tab::Testing => draw_testing(f, app, body),
        Tab::Config => draw_config(f, app, body),
    }
    if let Some(area) = presence {
        draw_presence(f, app, area);
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

/// P7 presence sidebar: a glanceable, always-visible list of who's online and
/// what they're doing, rendered from the coord_presence-primary roster. No
/// selection — it's a HUD, not a navigable list; the Sessions tab is the detail.
fn draw_presence(f: &mut Frame, app: &App, area: Rect) {
    let online = app.roster.iter().filter(|r| !r.stale).count();
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
            let who = r.agent.clone().unwrap_or_else(|| r.label.clone());
            // Prefer live intent; fall back to feature, then role.
            let detail = r
                .intent
                .clone()
                .filter(|s| !s.is_empty())
                .or_else(|| r.feature.clone().filter(|s| !s.is_empty()))
                .or_else(|| r.role.clone().filter(|s| !s.is_empty()))
                .unwrap_or_default();
            ListItem::new(Line::from(vec![
                Span::raw(format!("{dot} {:<10} ", trunc(&who, 10))),
                Span::styled(trunc(&detail, 14), Theme::dim()),
            ]))
        })
        .collect();
    let body = if app.roster.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "(nobody online)",
            Theme::dim(),
        )))]
    } else {
        items
    };
    let list = List::new(body).block(
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(format!(" Presence {}/{} ", online, app.roster.len()))),
    );
    f.render_widget(list, area);
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

fn draw_harnesses(f: &mut Frame, app: &App, area: Rect) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(8)])
        .split(area);
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(55), Constraint::Percentage(45)])
        .split(rows[0]);

    let feat_focused = app.harness_focus == HarnessFocus::Features;
    let focus_hl = |on: bool| if on { Theme::selected() } else { Theme::dim() };

    // Features (left).
    let fitems: Vec<ListItem> = app
        .features
        .iter()
        .map(|ft| {
            ListItem::new(Line::from(format!(
                "{:<10} {:<8} {}",
                trunc(&ft.id, 10),
                trunc(&ft.status, 8),
                trunc(&ft.title, 28),
            )))
        })
        .collect();
    let mut fstate = ListState::default();
    if !app.features.is_empty() {
        fstate.select(Some(app.feat_sel));
    }
    let flist = List::new(fitems)
        .block(Block::default().borders(Borders::ALL).title(Line::from(format!(
            " {}{} ({}/{}) [/] · features ({}) ",
            if feat_focused { "▸ " } else { "" },
            app.harness,
            app.harness_sel + 1,
            app.harnesses.len().max(1),
            app.features.len()
        ))))
        .highlight_style(focus_hl(feat_focused))
        .highlight_symbol("> ");
    f.render_stateful_widget(flist, cols[0], &mut fstate);

    // Issues (right) — selectable when focused (Tab toggles focus).
    let ititle = Line::from(format!(
        " {}issues ({}) ",
        if !feat_focused { "▸ " } else { "" },
        app.issues.len()
    ));
    if app.issues.is_empty() {
        f.render_widget(
            Paragraph::new("(no open issues)")
                .block(Block::default().borders(Borders::ALL).title(ititle)),
            cols[1],
        );
    } else {
        let iitems: Vec<ListItem> = app
            .issues
            .iter()
            .map(|is| {
                let fix = is.linked_feature_id.clone().unwrap_or_default();
                ListItem::new(Line::from(format!(
                    "{:<8} {:<11} {} {}",
                    trunc(&is.severity, 8),
                    trunc(&is.status, 11),
                    trunc(&is.title, 22),
                    if fix.is_empty() { String::new() } else { format!("→{fix}") },
                )))
            })
            .collect();
        let mut istate = ListState::default();
        istate.select(Some(app.issue_sel));
        let ilist = List::new(iitems)
            .block(Block::default().borders(Borders::ALL).title(ititle))
            .highlight_style(focus_hl(!feat_focused))
            .highlight_symbol("> ");
        f.render_stateful_widget(ilist, cols[1], &mut istate);
    }

    // Detail (bottom) — follows the focused column.
    let (dtitle, detail) = if feat_focused {
        (
            " feature ",
            match app.selected_feature() {
                Some(ft) => format!(
                    "{}\n\nid: {}    status: {}    attempts: {}",
                    ft.title, ft.id, ft.status, ft.attempts
                ),
                None => "No features.".to_string(),
            },
        )
    } else {
        (
            " issue ",
            match app.selected_issue() {
                Some(is) => format!(
                    "{}\n\nid: {}    severity: {}    status: {}\nsource: {}    foundDuring: {}    →fix: {}    attempts: {}",
                    is.title,
                    is.id,
                    is.severity,
                    is.status,
                    is.source,
                    is.found_during.clone().unwrap_or_default(),
                    is.linked_feature_id.clone().unwrap_or_default(),
                    is.attempts,
                ),
                None => "No issues.".to_string(),
            },
        )
    };
    f.render_widget(
        Paragraph::new(detail)
            .wrap(Wrap { trim: false })
            .block(Block::default().borders(Borders::ALL).title(dtitle)),
        rows[1],
    );
}

fn draw_docs(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(34), Constraint::Percentage(66)])
        .split(area);

    let items: Vec<ListItem> = app
        .docs_files
        .iter()
        .map(|p| ListItem::new(Line::from(trunc(p, 34))))
        .collect();
    let mut state = ListState::default();
    if !app.docs_files.is_empty() {
        state.select(Some(app.doc_sel));
    }
    let list = List::new(items)
        .block(Block::default().borders(Borders::ALL).title(Line::from(format!(
            " {} · docs ({}) ",
            app.harness,
            app.docs_files.len()
        ))))
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, cols[0], &mut state);

    let title = app.docs_files.get(app.doc_sel).cloned().unwrap_or_default();
    let body = if app.doc_content.is_empty() {
        "(no docs — select a file)".to_string()
    } else {
        app.doc_content.clone()
    };
    let reader_title = if title.is_empty() {
        " reader ".to_string()
    } else {
        format!(" {} ", trunc(&title, 60))
    };
    let para = Paragraph::new(body)
        .wrap(Wrap { trim: false })
        .scroll((app.doc_scroll, 0))
        .block(Block::default().borders(Borders::ALL).title(Line::from(reader_title)));
    f.render_widget(para, cols[1]);
}

fn draw_activity(f: &mut Frame, app: &App, area: Rect) {
    let items: Vec<ListItem> = app
        .activity
        .iter()
        .map(|e| {
            ListItem::new(Line::from(format!(
                "{:<20} {:<28} {:<26} {}",
                trunc(&e.ts, 20),
                trunc(&e.action, 28),
                trunc(&e.subject, 26),
                trunc(&e.actor, 18),
            )))
        })
        .collect();
    let mut state = ListState::default();
    if !app.activity.is_empty() {
        state.select(Some(app.activity_sel));
    }
    let list = List::new(items)
        .block(Block::default().borders(Borders::ALL).title(Line::from(format!(
            " Recent activity ({}) ",
            app.activity.len()
        ))))
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, area, &mut state);
}

fn draw_testing(f: &mut Frame, app: &App, area: Rect) {
    let items: Vec<ListItem> = app
        .testing
        .iter()
        .map(|d| {
            ListItem::new(Line::from(format!(
                "{:<10} {:<22} {}",
                trunc(&d.tier, 10),
                trunc(&d.label, 22),
                trunc(&d.description, 50),
            )))
        })
        .collect();
    let mut state = ListState::default();
    if !app.testing.is_empty() {
        state.select(Some(app.testing_sel));
    }
    let list = List::new(items)
        .block(Block::default().borders(Borders::ALL).title(Line::from(format!(
            " {} · test domains ({}) ",
            app.harness,
            app.testing.len()
        ))))
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, area, &mut state);
}

fn draw_config(f: &mut Frame, app: &App, area: Rect) {
    let body = if app.config.is_empty() {
        "(no claude-settings for this harness)".to_string()
    } else {
        app.config.clone()
    };
    let para = Paragraph::new(body).wrap(Wrap { trim: false }).block(
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(format!(" {} · claude-settings (read-only) ", app.harness))),
    );
    f.render_widget(para, area);
}

fn draw_status(f: &mut Frame, app: &App, area: Rect) {
    let (text, style) = match &app.last_error {
        Some(e) => (format!("⚠ {e}"), Theme::warn()),
        None => (app.status.clone(), Theme::dim()),
    };
    f.render_widget(Paragraph::new(Line::from(text)).style(style), area);
}

fn draw_help(f: &mut Frame) {
    let area = centered_rect(64, 84, f.area());
    let text = "pui — keys\n\n  1..8        switch tab\n  j / k  ↑/↓  move selection\n  [ / ]       cycle harness\n  Tab         switch column (Harnesses)\n  PgUp/PgDn   scroll (Docs)\n  n           launch agent pane (Sessions)\n  g           launch git (lazygit)\n  p           toggle presence sidebar\n  :           command palette\n  ?           toggle this help\n  q / Ctrl-C  quit\n\n  (press any key to close)";
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

    fn presence_entry(agent: &str, intent: &str) -> RosterEntry {
        RosterEntry {
            owner_id: "su-1".into(),
            label: "su · su-1".into(),
            intent: if intent.is_empty() { None } else { Some(intent.into()) },
            current_files: vec![],
            liveness: "live".into(),
            stale: false,
            agent: Some(agent.into()),
            role: Some("worker".into()),
            feature: None,
            current_plan_slug: None,
            heartbeat_at: None,
        }
    }

    #[test]
    fn presence_sidebar_renders_when_wide() {
        let mut app = App::new(); // Plans tab — so the only roster render is the sidebar
        app.set_roster(vec![presence_entry("claude", "porting tui")]);
        let text = render(&app, 100, 12);
        assert!(text.contains("Presence 1/1"));
        assert!(text.contains("claude"));
        assert!(text.contains("porting tui")); // intent shown in the sidebar
    }

    #[test]
    fn presence_sidebar_hidden_when_toggled_off() {
        let mut app = App::new();
        app.show_presence = false;
        app.set_roster(vec![presence_entry("ghostxyz", "secret")]);
        let text = render(&app, 100, 12); // Plans tab doesn't render the roster itself
        assert!(!text.contains("Presence "));
        assert!(!text.contains("ghostxyz"));
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
    fn harnesses_view_renders_features_and_issues() {
        use crate::models::{HarnessFeature, HarnessIssue};
        let mut app = App::new();
        app.tab = Tab::Harnesses;
        app.set_features(vec![HarnessFeature {
            id: "F-001".into(),
            title: "Build X".into(),
            status: "todo".into(),
            attempts: 0,
        }]);
        app.set_issues(vec![HarnessIssue {
            id: "I-1".into(),
            title: "Crash".into(),
            severity: "major".into(),
            status: "open".into(),
            source: "validator".into(),
            found_during: None,
            linked_feature_id: Some("F-FIX-1".into()),
            attempts: 0,
        }]);
        let text = render(&app, 110, 18);
        assert!(text.contains("papercup"));
        assert!(text.contains("features (1)"));
        assert!(text.contains("F-001"));
        assert!(text.contains("Build X"));
        assert!(text.contains("issues (1)"));
        assert!(text.contains("Crash"));
        assert!(text.contains("attempts")); // feature detail pane renders
    }

    #[test]
    fn docs_view_renders_files_and_content() {
        use crate::models::DocsResponse;
        let mut app = App::new();
        app.tab = Tab::Docs;
        app.set_docs(DocsResponse {
            files: vec!["readme.md".into(), "spec/x.md".into()],
            active_path: Some("readme.md".into()),
            content: Some("# Hello docs".into()),
        });
        let text = render(&app, 100, 12);
        assert!(text.contains("docs (2)"));
        assert!(text.contains("readme.md"));
        assert!(text.contains("Hello docs"));
    }

    #[test]
    fn activity_view_renders_events() {
        use crate::models::ActivityEvent;
        let mut app = App::new();
        app.tab = Tab::Activity;
        app.set_activity(vec![ActivityEvent {
            ts: "2026-06-03T05:38:30Z".into(),
            action: "operator.accept_failed".into(),
            subject: "commit-plan-updates".into(),
            actor: "system:operator".into(),
        }]);
        let text = render(&app, 110, 8);
        assert!(text.contains("Recent activity (1)"));
        assert!(text.contains("accept_failed"));
        assert!(text.contains("commit-plan-updates"));
    }

    #[test]
    fn testing_and_config_views_render() {
        use crate::models::TestingDomain;
        let mut app = App::new();
        app.tab = Tab::Testing;
        app.set_testing(vec![TestingDomain {
            id: "unit".into(),
            label: "Unit tests".into(),
            description: "fast vitest".into(),
            tier: "universal".into(),
        }]);
        let t = render(&app, 100, 8);
        assert!(t.contains("test domains (1)"));
        assert!(t.contains("Unit tests"));
        assert!(t.contains("universal"));

        app.tab = Tab::Config;
        app.set_config("permissions: allow".into());
        let c = render(&app, 100, 8);
        assert!(c.contains("claude-settings"));
        assert!(c.contains("permissions: allow"));
    }

    #[test]
    fn help_overlay_renders_when_shown() {
        let mut app = App::new();
        app.show_help = true;
        let text = render(&app, 84, 28);
        assert!(text.contains("Help"));
        assert!(text.contains("command palette"));
        assert!(text.contains("launch agent pane"));
        assert!(text.contains("toggle presence sidebar"));
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_presence_sidebar_render() {
        let client = crate::client::OperatorClient::from_discovery()
            .await
            .expect("connect via discovery");
        let roster = client.roster_typed().await.expect("roster over IPC");
        let n = roster.len();
        let mut app = App::new();
        app.set_roster(roster);
        let text = render(&app, 120, 30);
        eprintln!("--- live presence sidebar render ({n} roster entries) ---\n{text}");
        assert!(text.contains("Presence"), "sidebar title should render");
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
