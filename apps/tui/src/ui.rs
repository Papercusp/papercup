//! Rendering — a pure function of `&App`. No state mutation, so every view is
//! snapshot-testable against a ratatui `TestBackend`.

use crate::app::{App, HarnessFocus, Tab};
use crate::models::Notif;
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
        Tab::Operator => draw_chat(f, app, body),
        Tab::Inbox => draw_inbox(f, app, body),
        Tab::Plans => draw_plans(f, app, body),
        // Brew — the fleet view, which absorbed the old Sessions launcher (D-002b).
        Tab::Fleet => crate::fleet::draw_fleet(f, app, body),
        Tab::Harnesses => draw_harnesses(f, app, body),
        Tab::Docs => draw_docs(f, app, body),
        Tab::Activity => draw_activity(f, app, body),
        Tab::Testing => draw_testing(f, app, body),
        Tab::Config => draw_config(f, app, body),
        Tab::Plugins => draw_plugins(f, app, body),
        Tab::Settings => draw_settings(f, app, body),
    }
    if let Some(area) = presence {
        draw_presence(f, app, area);
    }
    draw_status(f, app, root[2]);

    // A transient toast for the latest notification sits above the body but
    // below the modal overlays (it shouldn't fight the help/palette/tutorial).
    if let Some(t) = &app.toast {
        if !app.show_tutorial && !app.show_help && !app.palette_open && !app.show_notifs {
            draw_toast(f, t);
        }
    }

    // Overlays render on top of the body (tutorial wins on first run).
    if app.show_tutorial {
        draw_tutorial(f, app.tutorial_step);
    } else if app.show_notifs {
        draw_notifs(f, app);
    } else if app.show_help {
        draw_help(f);
    } else if app.palette_open {
        draw_palette(f, app);
    }
}

fn draw_tabs(f: &mut Frame, app: &App, area: Rect) {
    let titles: Vec<Line> = Tab::ALL
        .iter()
        .map(|t| {
            // The switch shortcut: digit (1-9, 0) for the first 10 tabs, a letter
            // for appended tabs — each tab owns its key via `Tab::switch_key`.
            let k = t.switch_key();
            // Inbox carries a notification badge when items need attention (P8).
            if *t == Tab::Inbox && app.unseen_notifs > 0 {
                Line::from(format!(" {}:{} ({}) ", k, t.title(), app.unseen_notifs))
            } else {
                Line::from(format!(" {}:{} ", k, t.title()))
            }
        })
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

    // Right column: plan meta (top) + per-item assignment/claim/liveness (bottom, P-005a).
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(8), Constraint::Min(0)])
        .split(cols[1]);

    let detail = match app.selected_plan() {
        Some(p) => format!(
            "{}\n\nstatus:  {}\nharness: {}\nowner:   {}\nupdated: {}\nnext: {}",
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
    f.render_widget(para, right[0]);

    draw_plan_item_states(f, app, right[1]);
}

/// Per-item assignment/claim/liveness for the selected plan (P-005a). Renders only
/// when the loaded states belong to the SELECTED plan (a guard so a stale fetch from
/// a prior selection never paints the wrong plan). The block title carries the
/// harness's claim-liveness split (availability=LOCAL vs activity=SHARED); each row
/// is one item's disposition glyph + id + who's on it + the claim's liveness + intent.
fn draw_plan_item_states(f: &mut Frame, app: &App, area: Rect) {
    let sel = app.selected_plan().map(|p| p.slug.as_str());
    let states = app
        .plan_item_states
        .as_ref()
        .filter(|s| Some(s.plan.as_str()) == sel);
    let (title, items): (String, Vec<ListItem>) = match states {
        Some(s) => {
            let mode = if s.harness_liveness_mode.is_empty() {
                "—"
            } else {
                s.harness_liveness_mode.as_str()
            };
            let rows = s
                .items
                .iter()
                .map(|it| ListItem::new(Line::from(plan_item_line(it))))
                .collect();
            (format!(" Items ({}) · liveness: {mode} ", s.items.len()), rows)
        }
        None => (" Items ".to_string(), Vec::new()),
    };
    let list =
        List::new(items).block(Block::default().borders(Borders::ALL).title(Line::from(title)));
    f.render_widget(list, area);
}

/// One plan-item row: `<glyph> <id> <disposition> <who> <liveness> <intent>` (P-005a).
/// `who` is the live-claim holder's agent-name, falling back to the durable assignee.
fn plan_item_line(it: &crate::models::PlanItemState) -> String {
    let (glyph, label) = match it.disposition.as_str() {
        "active" => ("●", "active"),
        "assigned-idle" => ("◐", "assigned"),
        "claimed-pooled" => ("◆", "claimed"),
        "claimed-mismatch" => ("⚠", "MISMATCH"),
        "pooled" => ("·", "pooled"),
        other => ("?", other),
    };
    let who = it
        .claim_owner_name
        .as_deref()
        .or(it.assignee_name.as_deref())
        .unwrap_or("");
    let live = match it.claim_liveness_mode.as_deref() {
        Some("availability") => "avail",
        Some("activity") => "activ",
        _ => "",
    };
    let intent = it.claim_intent.as_deref().unwrap_or("");
    format!(
        "{glyph} {:<7} {:<9} {:<14} {:<6} {}",
        trunc(&it.item_id, 7),
        label,
        trunc(who, 14),
        live,
        trunc(intent, 40),
    )
}

/// P7 presence sidebar: a glanceable, always-visible list of who's online and
/// what they're doing, rendered from the coord_presence-primary roster. No
/// selection — it's a HUD, not a navigable list; the Sessions tab is the detail.
fn draw_presence(f: &mut Frame, app: &App, area: Rect) {
    // "Who's online" — only non-stale presence (the roster carries the whole
    // fleet incl. long-dead heartbeats; those would drown the live ones). The
    // title still shows online/total so the offline tail is visible at a glance.
    let online: Vec<&crate::models::RosterEntry> =
        app.roster.iter().filter(|r| !r.stale).collect();
    let items: Vec<ListItem> = online
        .iter()
        .map(|r| {
            let dot = if r.liveness == "live" { "●" } else { "◐" };
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
    let body = if items.is_empty() {
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
            .title(Line::from(format!(" Presence {}/{} ", online.len(), app.roster.len()))),
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

fn draw_plugins(f: &mut Frame, app: &App, area: Rect) {
    // Plugin-contributed TUI panes (D-002). Each row shows the icon (if any),
    // label, owning plugin, and the command that Enter launches.
    let items: Vec<ListItem> = app
        .panes
        .iter()
        .map(|p| {
            let icon = p.icon.as_deref().unwrap_or("•");
            ListItem::new(Line::from(format!(
                "{:<2} {:<22} {:<18} {}",
                trunc(icon, 2),
                trunc(&p.label, 22),
                trunc(&p.plugin_name, 18),
                trunc(&p.command.join(" "), 40),
            )))
        })
        .collect();
    let mut state = ListState::default();
    if !app.panes.is_empty() {
        state.select(Some(app.pane_sel));
    }
    let list = List::new(items)
        .block(Block::default().borders(Borders::ALL).title(Line::from(format!(
            " {} · plugin panes ({}) — Enter to launch ",
            app.harness,
            app.panes.len()
        ))))
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, area, &mut state);
}

fn draw_settings(f: &mut Frame, app: &App, area: Rect) {
    // Read-only settings: the operator-config overview (P10b — AI backend + models +
    // connected providers) above the feature-flag state (P10). The write-side settings
    // (Profile/Voice/Keys/OAuth/pairing/wake-word) are interactive and live on the desktop.
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(9), Constraint::Min(0)])
        .split(area);
    draw_operator_config(f, app, rows[0]);

    let items: Vec<ListItem> = app
        .flags
        .iter()
        .map(|(key, on)| {
            let mark = if *on { "[x]" } else { "[ ]" };
            ListItem::new(Line::from(format!("{mark}  {}", trunc(key, 56))))
        })
        .collect();
    let mut state = ListState::default();
    if !app.flags.is_empty() {
        state.select(Some(app.flag_sel));
    }
    let source = if app.flags_source.is_empty() {
        "—"
    } else {
        app.flags_source.as_str()
    };
    let list = List::new(items)
        .block(Block::default().borders(Borders::ALL).title(Line::from(format!(
            " feature flags ({}) · source: {source} — read-only ",
            app.flags.len()
        ))))
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, rows[1], &mut state);
}

/// The read-only operator-config overview (P10b): AI backend + cmd + per-role &
/// per-surface model routing + which speech providers are connected (✓/✗, no
/// secrets). Write-side settings (credentials/OAuth/pairing/wake-word) are
/// interactive/desktop-native and intentionally NOT surfaced here.
fn draw_operator_config(f: &mut Frame, app: &App, area: Rect) {
    let cfg = &app.operator_config;
    let mut lines: Vec<Line> = Vec::new();
    match &cfg.agent {
        Some(a) => {
            let backend = if a.effective_backend.is_empty() {
                a.config.backend.as_str()
            } else {
                a.effective_backend.as_str()
            };
            lines.push(Line::from(format!("backend:  {}  ·  {}", backend, trunc(&a.config.cmd, 50))));
            if !a.config.models.is_empty() {
                let models = a
                    .config
                    .models
                    .iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join("  ");
                lines.push(Line::from(format!("models:   {}", trunc(&models, 70))));
            }
            if !a.config.surface_models.is_empty() {
                let surf = a
                    .config
                    .surface_models
                    .iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join("  ");
                lines.push(Line::from(format!("surfaces: {}", trunc(&surf, 70))));
            }
        }
        None => lines.push(Line::from("backend:  —")),
    }
    if !cfg.providers.is_empty() {
        let provs = cfg
            .providers
            .iter()
            .map(|(name, set)| format!("{name} {}", if *set { "✓" } else { "✗" }))
            .collect::<Vec<_>>()
            .join("  ");
        lines.push(Line::from(format!("providers: {}", trunc(&provs, 70))));
    }
    let para = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .block(Block::default().borders(Borders::ALL).title(" operator config (read-only) "));
    f.render_widget(para, area);
}

fn draw_config(f: &mut Frame, app: &App, area: Rect) {
    let block = Block::default()
        .borders(Borders::ALL)
        .title(Line::from(format!(" {} · .claude/settings.json (read-only) ", app.harness)));
    // D-004d: a clear, dim placeholder when the harness has no settings file
    // (genuinely empty for some pots — distinguish "empty" from "not loaded").
    let para = if app.config.is_empty() {
        Paragraph::new(Line::from(Span::styled(
            "(no .claude/settings.json for this pot — nothing to show)",
            Theme::dim(),
        )))
        .block(block)
    } else {
        Paragraph::new(app.config.clone())
            .wrap(Wrap { trim: false })
            .block(block)
    };
    f.render_widget(para, area);
}

/// Operator chat pane (tui-operator-surface-2026-06-04): a scrollable transcript
/// over a composer box. The transcript is **pre-wrapped** to the inner width so
/// the bottom-anchored scroll offset is exact; `chat_scroll` counts lines UP from
/// the latest (0 = pinned to the newest). The in-flight assistant bubble shows a
/// live `<say>` preview via `chat_tags::live_preview`.
fn draw_chat(f: &mut Frame, app: &App, area: Rect) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(3)])
        .split(area);
    let transcript_area = rows[0];
    let composer_area = rows[1];

    let inner_w = transcript_area.width.saturating_sub(2).max(1) as usize; // minus borders
    let mut lines: Vec<Line> = Vec::new();
    if app.chat_messages.is_empty() {
        lines.push(Line::from(Span::styled(
            "No messages yet — press i to talk to the operator.",
            Theme::dim(),
        )));
    }
    for m in &app.chat_messages {
        let (who, who_style) = match m.role.as_str() {
            "user" => ("you", Theme::selected()),
            "assistant" => ("operator", Theme::notify()),
            other => (other, Theme::dim()),
        };
        let header = if m.streaming {
            format!("{who} ▌")
        } else {
            who.to_string()
        };
        lines.push(Line::from(Span::styled(header, who_style)));
        let body = if m.streaming {
            let p = crate::chat_tags::live_preview(&m.content);
            if p.is_empty() { "…".to_string() } else { p }
        } else {
            m.content.clone()
        };
        for wl in wrap_text(&body, inner_w) {
            lines.push(Line::from(wl));
        }
        for tc in &m.tools {
            lines.push(Line::from(Span::styled(format!("  ⚙ {}", tc.name), Theme::dim())));
        }
        lines.push(Line::from("")); // blank separator between turns
    }

    let total = lines.len() as u16;
    let visible = transcript_area.height.saturating_sub(2); // block borders
    let max_top = total.saturating_sub(visible);
    // chat_scroll = lines up from the bottom; clamp so it never overscrolls.
    let top = max_top.saturating_sub(app.chat_scroll.min(max_top));

    let earlier = if app.chat_loading_earlier {
        " · ↑ loading…"
    } else if app.chat_has_more_earlier {
        " · ↑ earlier (PgUp)"
    } else {
        ""
    };
    let title = format!(
        " Operator{}{} ",
        earlier,
        if app.chat_streaming { " · …thinking" } else { "" },
    );
    let para = Paragraph::new(lines)
        .scroll((top, 0))
        .block(Block::default().borders(Borders::ALL).title(Line::from(title)));
    f.render_widget(para, transcript_area);

    let (ctitle, ctext, cstyle) = if app.chat_composing {
        (
            " Message — Enter send · Esc cancel ",
            format!("> {}", app.chat_input),
            Theme::selected(),
        )
    } else {
        (
            " Composer — i to type · j/k scroll ",
            "press i to talk to the operator".to_string(),
            Theme::dim(),
        )
    };
    let cpara = Paragraph::new(Line::from(Span::styled(ctext, cstyle)))
        .block(Block::default().borders(Borders::ALL).title(Line::from(ctitle)));
    f.render_widget(cpara, composer_area);
}

fn draw_status(f: &mut Frame, app: &App, area: Rect) {
    let (text, style) = match &app.last_error {
        Some(e) => (format!("⚠ {e}"), Theme::warn()),
        None => (app.status.clone(), Theme::dim()),
    };
    f.render_widget(Paragraph::new(Line::from(text)).style(style), area);
    // Companion workbench indicator (P-004): right-aligned "⚡ N panes" when the
    // companion zellij plugin is linked. Drawn into a right sub-rect so it never
    // clobbers the status/error text on the left.
    if let Some(summary) = app.workbench_summary() {
        let w = (summary.chars().count() as u16 + 1).min(area.width);
        let sub = Rect {
            x: area.x + area.width.saturating_sub(w),
            y: area.y,
            width: w,
            height: area.height,
        };
        f.render_widget(Paragraph::new(Line::from(summary)).style(Theme::dim()), sub);
    }
}

fn draw_help(f: &mut Frame) {
    let area = centered_rect(64, 84, f.area());
    let text = "pui — keys\n\n  1..0 / s    switch tab (1 Operator · 4 Brew · 5 Pots · s Settings)\n  i / Enter   compose a message (on Operator) · Esc cancels\n  < / >       cycle tabs\n  Tab         Brew: curated / mirror  ·  Pots: switch column\n  j / k  ↑/↓  move selection / scroll chat\n  [ / ]       cycle pot\n  PgUp/PgDn   scroll (Docs / Operator)\n  n           launch agent pane (Brew)\n  Enter       launch plugin pane (Plugins)\n  g           launch git (lazygit)\n  r           relaunch last-exited agent pane\n  p           toggle presence sidebar\n  N           notifications history\n  Esc         dismiss toast\n  F1          tutorial\n  :           command palette\n  ?           toggle this help\n  q / Ctrl-C  quit\n\n  (press any key to close)";
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(text).block(Block::default().borders(Borders::ALL).title(" Help ")),
        area,
    );
}

/// A transient toast for the latest notification, bottom-right above the status
/// bar (P8).
fn draw_toast(f: &mut Frame, n: &Notif) {
    let full = f.area();
    let w = 50.min(full.width.saturating_sub(2));
    let h = 4u16;
    let area = Rect {
        x: full.width.saturating_sub(w + 1),
        y: full.height.saturating_sub(h + 1),
        width: w,
        height: h,
    };
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(n.message.clone())
            .wrap(Wrap { trim: false })
            .style(Theme::notify())
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(format!(" 🔔 {} · Esc ", trunc(&n.level, 12))),
            ),
        area,
    );
}

/// The notifications history overlay (P8) — newest first.
fn draw_notifs(f: &mut Frame, app: &App) {
    let area = centered_rect(72, 70, f.area());
    let items: Vec<ListItem> = if app.notifs.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "(no notifications)",
            Theme::dim(),
        )))]
    } else {
        app.notifs
            .iter()
            .map(|n| {
                let h = n
                    .harness
                    .clone()
                    .map(|s| format!(" [{s}]"))
                    .unwrap_or_default();
                ListItem::new(Line::from(vec![
                    Span::styled(format!("{:<8} ", trunc(&n.level, 8)), Theme::warn()),
                    Span::raw(trunc(&n.message, 56)),
                    Span::styled(h, Theme::dim()),
                ]))
            })
            .collect()
    };
    f.render_widget(Clear, area);
    f.render_widget(
        List::new(items).block(
            Block::default().borders(Borders::ALL).title(Line::from(format!(
                " Notifications ({}) · any key to close ",
                app.notifs.len()
            ))),
        ),
        area,
    );
}

/// The guided multi-step tutorial (P9). `step` is clamped to the last page.
fn draw_tutorial(f: &mut Frame, step: usize) {
    const STEPS: [(&str, &str); 3] = [
        (
            "Welcome to pui — the Papercusp workbench",
            "pui is your terminal HUD over the operator. Everything here is live —\n\
             it reads + reacts to the same backend the desktop app uses.\n\n\
             Tabs (press 1‑0 / s, or  <  /  >  to cycle):\n\
             \x20 Operator · Inbox · Plans · Brew · Pots · Docs · Activity · Testing · Config · Plugins · Settings\n\
             \x20 Brew is the whole fleet at a glance (agents + plan progress + launch).\n\n\
             Pick the pot you're working in with  [  /  ] .",
        ),
        (
            "Moving around & launching agents",
            "Move:    j / k   (or ↑ / ↓)        Scroll docs:  PgUp / PgDn\n\
             Switch a split's focus (Harnesses):  Tab\n\n\
             Launch a native agent into a pane:   n   (on the Brew tab)\n\
             Open git for the active harness:     g   (lazygit)\n\n\
             Agents run at full fidelity in their own zellij panes — pui never\n\
             wraps or reimplements them.",
        ),
        (
            "Staying in the loop",
            "Presence:      p   toggles the who's‑online sidebar (right)\n\
             Notifications: a toast pops when something needs you; Esc dismisses,\n\
             \x20              N opens the history.\n\
             Command bar:   :        Full keymap:  ?        Quit:  q\n\n\
             You can re‑open this guide any time with  F1 .\n\n\
             That's it — press any key to start.",
        ),
    ];
    let i = step.min(STEPS.len() - 1);
    let (title, body) = STEPS[i];
    let area = centered_rect(72, 70, f.area());
    let footer = format!(
        "\n\n— step {}/{} · any key ▸  ·  Esc skips —",
        i + 1,
        STEPS.len()
    );
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(format!("{body}{footer}"))
            .wrap(Wrap { trim: false })
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(format!(" {title} ")),
            ),
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

/// Greedy word-wrap `s` to `width` columns, returning display rows. Preserves
/// explicit '\n' breaks; hard-splits a word longer than `width`. The chat
/// transcript pre-wraps with this so its scroll offset is exact (vs. letting
/// Paragraph's own Wrap reflow at unknown line counts).
fn wrap_text(s: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![s.to_string()];
    }
    let mut out = Vec::new();
    for raw_line in s.split('\n') {
        let mut cur = String::new();
        let mut cur_w = 0usize;
        for word in raw_line.split(' ') {
            let wlen = word.chars().count();
            if wlen > width {
                // Flush the current line, then hard-split the over-long word.
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                let mut chunk = String::new();
                for ch in word.chars() {
                    if chunk.chars().count() == width {
                        out.push(std::mem::take(&mut chunk));
                    }
                    chunk.push(ch);
                }
                cur = chunk;
                cur_w = cur.chars().count();
                continue;
            }
            let add = if cur.is_empty() { wlen } else { wlen + 1 };
            if cur_w + add > width {
                out.push(std::mem::take(&mut cur));
                cur.push_str(word);
                cur_w = wlen;
            } else {
                if !cur.is_empty() {
                    cur.push(' ');
                }
                cur.push_str(word);
                cur_w += add;
            }
        }
        out.push(cur);
    }
    out
}

/// Truncate to `n` chars (cheap; ASCII-oriented labels).
pub(crate) fn trunc(s: &str, n: usize) -> String {
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
    use crate::models::{Notif, PlanSummary, RosterEntry};
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
            item_counts: Default::default(),
            priority: None,
        }
    }

    #[test]
    fn plans_view_renders_list_and_detail() {
        let mut app = App::new();
        app.tab = Tab::Plans; // the default landing tab is now Operator
        app.set_plans(vec![plan("alpha-2026", "todo"), plan("beta-2026", "shipped")]);
        let text = render(&app, 90, 16);
        assert!(text.contains("Plans (2)"));
        assert!(text.contains("alpha-2026"));
        assert!(text.contains("Detail"));
        assert!(text.contains("Title alpha-2026")); // selected plan detail
        assert!(text.contains("papercup"));
    }

    #[test]
    fn workbench_indicator_shows_when_companion_linked() {
        use pui_companion_proto::{PaneNode, Topology};
        let mut app = App::new();
        // Hidden until the companion plugin links (P-004).
        assert!(!render(&app, 90, 12).contains("panes"));

        app.companion_version = Some("0.1.0".into());
        app.topology = Some(Topology {
            tabs: vec![],
            panes: vec![
                PaneNode { id: 1, tab: 0, title: "claude".into(), focused: true, is_plugin: false, exited: false, command: None },
                PaneNode { id: 2, tab: 0, title: "pui".into(), focused: false, is_plugin: false, exited: false, command: None },
            ],
        });
        let text = render(&app, 90, 12);
        assert!(text.contains("⚡"));
        assert!(text.contains("2 panes"));
    }

    #[test]
    fn brew_view_renders_roster_and_dossier() {
        // The Sessions roster + dossier folded into Brew (D-002b): the Brew
        // (Fleet) tab shows the agent list + a dossier for the selected agent,
        // including its open files.
        let mut app = App::new();
        app.tab = Tab::Fleet;
        app.show_presence = false; // full width for the dashboard
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
        let text = render(&app, 120, 40);
        assert!(text.contains("Brew")); // headline
        assert!(text.contains("Agents (1)"));
        assert!(text.contains("claude"));
        assert!(text.contains("Dossier"));
        assert!(text.contains("worker"));
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
    fn tab_strip_shows_leading_tabs() {
        // The lead tabs after the D-002 reorder: Operator, Inbox, Plans. (At a
        // narrow width the Tabs widget truncates the tail.)
        let app = App::new();
        let text = render(&app, 60, 8);
        assert!(text.contains("Operator"));
        assert!(text.contains("Inbox"));
        assert!(text.contains("Plans"));
    }

    #[test]
    fn plans_view_renders_item_assignment_claim_liveness() {
        use crate::models::{PlanItemState, PlanItemStates};
        let mut app = App::new();
        app.tab = Tab::Plans;
        app.set_plans(vec![plan("my-plan", "wip")]);
        app.set_plan_item_states(PlanItemStates {
            harness: "papercup".into(),
            plan: "my-plan".into(),
            harness_liveness_mode: "activity".into(),
            items: vec![
                PlanItemState {
                    item_id: "P-001".into(),
                    disposition: "pooled".into(),
                    ..Default::default()
                },
                PlanItemState {
                    item_id: "P-002".into(),
                    disposition: "active".into(),
                    assignee_name: Some("builder-1".into()),
                    claim_owner_name: Some("builder-1".into()),
                    claim_liveness_mode: Some("activity".into()),
                    claim_intent: Some("building it".into()),
                    ..Default::default()
                },
            ],
        });
        let text = render(&app, 110, 22);
        assert!(text.contains("Items (2)"));
        assert!(text.contains("liveness: activity")); // the harness-level split
        assert!(text.contains("P-001"));
        assert!(text.contains("pooled"));
        assert!(text.contains("P-002"));
        assert!(text.contains("active"));
        assert!(text.contains("builder-1")); // who's on it

        // States for a DIFFERENT plan must NOT render against this selection.
        app.set_plan_item_states(PlanItemStates {
            plan: "other-plan".into(),
            items: vec![PlanItemState {
                item_id: "Z-9".into(),
                disposition: "pooled".into(),
                ..Default::default()
            }],
            ..Default::default()
        });
        let text2 = render(&app, 110, 22);
        assert!(!text2.contains("Z-9"));
    }

    #[test]
    fn settings_tab_renders_flags() {
        let mut app = App::new();
        let mut m = std::collections::BTreeMap::new();
        m.insert("papercusp-oracle".to_string(), false);
        m.insert("papercusp-snapshots".to_string(), true);
        app.set_flags(crate::models::FlagsResponse { flags: m, source: "defaults".into() });
        app.tab = Tab::Settings;
        // Taller now that Settings stacks the config overview (P10b) above the flags.
        let text = render(&app, 90, 22);
        assert!(text.contains("feature flags"));
        assert!(text.contains("papercusp-oracle"));
        assert!(text.contains("[x]"));
        assert!(text.contains("[ ]"));
        assert!(text.contains("defaults"));
    }

    #[test]
    fn settings_tab_renders_operator_config_overview() {
        use crate::models::{AgentConfigInner, AgentConfigResponse, OperatorConfig};
        let mut app = App::new();
        app.tab = Tab::Settings;
        let mut models = std::collections::BTreeMap::new();
        models.insert("worker".to_string(), "opus".to_string());
        let mut surf = std::collections::BTreeMap::new();
        surf.insert("operator".to_string(), "sonnet".to_string());
        app.set_operator_config(OperatorConfig {
            agent: Some(AgentConfigResponse {
                config: AgentConfigInner {
                    backend: "claude-code".into(),
                    cmd: "claude -p".into(),
                    models,
                    surface_models: surf,
                },
                effective_backend: "claude-code".into(),
            }),
            providers: vec![("openai".into(), true), ("elevenlabs".into(), false)],
        });
        let text = render(&app, 100, 22);
        assert!(text.contains("operator config")); // the section header
        assert!(text.contains("claude-code")); // backend
        assert!(text.contains("worker=opus")); // per-role model
        assert!(text.contains("operator=sonnet")); // per-surface model
        assert!(text.contains("openai")); // a connected-provider marker
    }

    fn ui_notif(level: &str, msg: &str, harness: Option<&str>) -> Notif {
        Notif {
            level: level.into(),
            message: msg.into(),
            harness: harness.map(|s| s.into()),
            ts: None,
        }
    }

    #[test]
    fn inbox_badge_and_toast_render() {
        let mut app = App::new();
        app.unseen_notifs = 2;
        app.toast = Some(ui_notif("high", "Decide P-002", None));
        let text = render(&app, 90, 12);
        assert!(text.contains("Inbox (2)")); // badge on the tab strip
        assert!(text.contains("🔔")); // toast box title
        assert!(text.contains("Decide P-002")); // toast message
    }

    #[test]
    fn notifs_history_overlay_renders() {
        let mut app = App::new();
        app.show_notifs = true;
        app.notifs = vec![
            ui_notif("error", "build failed", Some("papercup")),
            ui_notif("high", "needs you", None),
        ];
        let text = render(&app, 90, 16);
        assert!(text.contains("Notifications (2)"));
        assert!(text.contains("build failed"));
        assert!(text.contains("[papercup]"));
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
        assert!(c.contains("settings.json"));
        assert!(c.contains("permissions: allow"));
        // D-004d: the empty state shows a clear placeholder.
        app.set_config(String::new());
        let empty = render(&app, 100, 8);
        assert!(empty.contains("no .claude/settings.json"));
    }

    #[test]
    fn plugins_view_renders_panes() {
        use crate::models::TuiPaneContribution;
        let mut app = App::new();
        app.tab = Tab::Plugins;
        app.set_panes(vec![TuiPaneContribution {
            plugin_name: "logs-plugin".into(),
            slug: "papercup".into(),
            label: "Server logs".into(),
            icon: Some("📜".into()),
            command: vec!["sh".into(), "tail.sh".into()],
            cwd: "/repo/papercup".into(),
        }]);
        let text = render(&app, 110, 8);
        assert!(text.contains("plugin panes (1)"));
        assert!(text.contains("Enter to launch"));
        assert!(text.contains("Server logs"));
        assert!(text.contains("logs-plugin"));
        assert!(text.contains("sh tail.sh"));
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
    async fn live_coord_inbox_sse() {
        // P-002 end-to-end: the coord_inbox SSE producer route + the reader.
        let client = crate::client::OperatorClient::from_discovery()
            .await
            .expect("connect via discovery");
        let mut rx = client
            .subscribe_sse("/api/coord/inbox/sse")
            .await
            .expect("subscribe coord-inbox sse");
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
            .await
            .expect("timed out")
            .expect("a frame");
        eprintln!("live coord-inbox SSE frame: {} | {}", frame.event, frame.data);
        assert!(matches!(frame.event.as_str(), "heartbeat" | "invalidate"));
        let inbox = client.coord_inbox().await.expect("coord inbox read");
        eprintln!("coord inbox: {} human-facing entries", inbox.len());
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_client_subscribe_sse() {
        // Exercises the new transport-agnostic subscribe_sse over the live
        // (IPC) backend end-to-end — the route sends an initial heartbeat.
        let client = crate::client::OperatorClient::from_discovery()
            .await
            .expect("connect via discovery");
        let mut rx = client
            .subscribe_sse("/api/zero-harness/sse")
            .await
            .expect("subscribe");
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
            .await
            .expect("timed out")
            .expect("a frame");
        eprintln!("live client SSE frame: {} | {}", frame.event, frame.data);
        assert!(matches!(
            frame.event.as_str(),
            "heartbeat" | "invalidate" | "update" | "message"
        ));
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_all_tabs_render() {
        // Read-only QA: fetch real data, render EVERY tab to a TestBackend. No
        // live pui process, no keystrokes, no launch path (see the
        // feedback-no-live-keystroke-drive-pui rule).
        let c = crate::client::OperatorClient::from_discovery()
            .await
            .expect("connect via discovery");
        let slug = "papercup";
        let mut app = App::new();
        if let Ok(v) = c.plans_typed().await {
            app.set_plans(v);
        }
        if let Ok(v) = c.roster_typed().await {
            app.set_roster(v);
        }
        if let Ok(v) = c.attention_typed().await {
            app.set_inbox(v);
        }
        if let Ok(v) = c.harnesses().await {
            app.set_harnesses(v);
        }
        if let Ok(v) = c.features_for(slug).await {
            app.set_features(v);
        }
        if let Ok(v) = c.issues_for(slug).await {
            app.set_issues(v);
        }
        if let Ok(v) = c.docs_for(slug, None).await {
            app.set_docs(v);
        }
        if let Ok(v) = c.recent_activity().await {
            app.set_activity(v);
        }
        if let Ok(v) = c.testing_domains(slug).await {
            app.set_testing(v);
        }
        if let Ok(v) = c.claude_settings(slug).await {
            app.set_config(v);
        }
        if let Ok(v) = c.tui_panes_for(slug).await {
            app.set_panes(v);
        }
        if let Ok(v) = c.recent_toasts(20).await {
            app.set_notif_history(v);
        }
        for tab in Tab::ALL {
            app.tab = tab;
            let text = render(&app, 200, 50);
            let nonblank = text.chars().filter(|ch| !ch.is_whitespace()).count();
            eprintln!("--- tab {:?}: {nonblank} non-blank chars ---", tab);
            // Optional visual dump for manual QA: PUI_DUMP=1 writes each render.
            if std::env::var("PUI_DUMP").is_ok() {
                let _ = std::fs::create_dir_all("/tmp/puiqa-render");
                // 200-wide buffer of cell symbols, no newlines → re-wrap per row.
                let chars: Vec<char> = text.chars().collect();
                let wrapped: String = chars
                    .chunks(200)
                    .map(|c| c.iter().collect::<String>())
                    .collect::<Vec<_>>()
                    .join("\n");
                let _ = std::fs::write(format!("/tmp/puiqa-render/{tab:?}.txt"), wrapped);
            }
            assert!(nonblank > 0, "tab {tab:?} rendered blank");
            assert!(
                text.contains(tab.title()),
                "tab {tab:?} title missing from strip"
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_toast_log_fetch() {
        let client = crate::client::OperatorClient::from_discovery()
            .await
            .expect("connect via discovery");
        let toasts = client.recent_toasts(10).await.expect("toast-log over IPC");
        eprintln!("live toast-log: {} entries", toasts.len());
        // Shape parsed; an empty log is valid, so just assert the call succeeded.
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
    fn tutorial_overlay_renders_and_outranks_help() {
        let mut app = App::new();
        app.show_tutorial = true;
        app.show_help = true; // tutorial should win
        let text = render(&app, 90, 26);
        assert!(text.contains("Welcome to pui"));
        assert!(text.contains("step 1/3"));
        assert!(!text.contains("pui — keys")); // help overlay suppressed
    }

    #[test]
    fn tutorial_last_step_renders() {
        let mut app = App::new();
        app.show_tutorial = true;
        app.tutorial_step = 2;
        let text = render(&app, 90, 26);
        assert!(text.contains("Staying in the loop"));
        assert!(text.contains("step 3/3"));
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

    // --- Fleet status view (pui-fleet-status-view-2026-06-04) ---

    fn fleet_roster(owner: &str, agent: &str, intent: &str) -> RosterEntry {
        RosterEntry {
            owner_id: owner.into(),
            label: format!("su · {owner}"),
            intent: Some(intent.into()),
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

    fn fleet_activity(owner: &str, agent: &str, summary: &str, ts: &str) -> crate::models::ActivityRow {
        crate::models::ActivityRow {
            id: "1".into(),
            owner_id: owner.into(),
            agent: Some(agent.into()),
            harness_slug: Some("papercup".into()),
            kind: "tool".into(),
            tool_name: None,
            summary: Some(summary.into()),
            status: None,
            detail: None,
            created_at: ts.into(),
        }
    }

    #[test]
    fn fleet_curated_renders_headline_agents_and_plan_progress() {
        use crate::models::{ItemCounts, WorkItem};
        let mut app = App::new();
        app.tab = Tab::Fleet;
        app.show_presence = false; // full width for the headline assertions
        app.set_roster(vec![fleet_roster("su-a", "claude", "building fleet view")]);
        let mut p = plan("fleet-view-2026", "active");
        p.item_counts = ItemCounts { todo: 2, done: 3, ..Default::default() };
        app.set_plans(vec![p]);
        app.fleet.set_work_items(vec![WorkItem {
            id: "F-1".into(),
            kind: "feature".into(),
            family: "feature".into(),
            harness: Some("papercup".into()),
            title: "t".into(),
            state: "passed".into(),
            assignee: None,
            severity: None,
        }]);
        app.update(crate::event::Event::ActivitySeed(vec![fleet_activity(
            "su-a",
            "claude",
            "✎ fleet.rs",
            "2026-06-04 18:53:58-04",
        )]));
        let text = render(&app, 120, 24);
        assert!(text.contains("Brew")); // D-001 label-only rename of Fleet
        assert!(text.contains("1/1 online")); // headline agent count
        assert!(text.contains("Agents (1)"));
        assert!(text.contains("claude"));
        assert!(text.contains("fleet.rs")); // joined live activity summary
        assert!(text.contains("Plan progress"));
        assert!(text.contains("fleet-view-2026"));
        assert!(text.contains("3/5")); // plan items done/total
        assert!(text.contains("[curated]"));
    }

    #[test]
    fn fleet_curated_renders_selected_agent_todos() {
        let mut app = App::new();
        app.tab = Tab::Fleet;
        app.show_presence = false;
        app.set_roster(vec![fleet_roster("su-a", "claude", "x")]);
        let mut todos = fleet_activity("su-a", "claude", "⇄ todos", "2026-06-04 18:00:00-04");
        todos.kind = "todos".into();
        todos.detail = Some(serde_json::json!({
            "count": 3, "done": 1,
            "todos": [
                {"content": "build fleet.rs", "status": "in_progress"},
                {"content": "wire pollers", "status": "pending"},
            ],
        }));
        app.update(crate::event::Event::ActivityTodos(vec![todos]));
        // A realistic terminal height so the detail pane shows the todo list
        // (in a short pane the preamble can push it below the fold).
        let text = render(&app, 120, 44);
        assert!(text.contains("todos (1/3)"));
        assert!(text.contains("build fleet.rs"));
        assert!(text.contains("▸")); // in_progress marker
    }

    #[test]
    fn fleet_mirror_renders_activity_feed() {
        let mut app = App::new();
        app.tab = Tab::Fleet;
        app.show_presence = false;
        app.fleet.mode = crate::fleet::FleetMode::Mirror;
        app.update(crate::event::Event::ActivityLive(fleet_activity(
            "su-a",
            "codex",
            "▶ cargo test",
            "2026-06-04 19:01:02-04",
        )));
        let text = render(&app, 120, 16);
        assert!(text.contains("Activity mirror (1)"));
        assert!(text.contains("19:01:02"));
        assert!(text.contains("codex"));
        assert!(text.contains("cargo test"));
        assert!(text.contains("[mirror]"));
    }

    #[test]
    fn brew_tab_shows_in_strip_with_digit_key() {
        // Fleet titles as "Brew" (D-001) on digit '4' (D-002).
        let app = App::new();
        let text = render(&app, 160, 8);
        assert!(text.contains("4:Brew"));
    }

    // --- Operator chat pane (tui-operator-surface-2026-06-04) ---

    #[test]
    fn operator_leads_strip_on_digit_one() {
        let app = App::new(); // default tab = Operator, now on digit '1' (D-002)
        let text = render(&app, 220, 8);
        assert!(text.contains("1:Operator"));
    }

    #[test]
    fn chat_view_renders_transcript_and_composer() {
        let mut app = App::new(); // lands on the Operator tab
        // Empty state prompts the user to compose.
        let empty = render(&app, 100, 16);
        assert!(empty.contains("Operator"));
        assert!(empty.contains("press i to talk to the operator"));
        // A seeded transcript renders both roles' bodies.
        app.set_chat_history(
            "c1".into(),
            vec![
                crate::models::ChatMessage::user("how is the carve going"),
                crate::models::ChatMessage::assistant("It landed green."),
            ],
            false,
            None,
        );
        let text = render(&app, 100, 20);
        assert!(text.contains("you"));
        assert!(text.contains("how is the carve"));
        assert!(text.contains("operator"));
        assert!(text.contains("It landed green."));
        // Composing surfaces the input box.
        app.chat_composing = true;
        app.chat_input = "hello".into();
        let typing = render(&app, 100, 20);
        assert!(typing.contains("Enter send"));
        assert!(typing.contains("> hello"));
    }

    #[test]
    fn chat_streaming_bubble_shows_live_say_preview() {
        let mut app = App::new();
        app.begin_user_send("hi");
        // The in-flight bubble holds raw tag text; it renders through live_preview.
        if let Some(m) = app.chat_messages.last_mut() {
            m.content = "<say>typing in pro".into();
        }
        let text = render(&app, 100, 16);
        assert!(text.contains("typing in pro"));
        assert!(!text.contains("<say>")); // tags stripped from the preview
        assert!(text.contains("thinking")); // streaming indicator in the title
    }

    #[test]
    fn wrap_text_wraps_words_and_preserves_breaks() {
        assert_eq!(wrap_text("a b c", 3), vec!["a b", "c"]);
        assert_eq!(wrap_text("line1\nline2", 80), vec!["line1", "line2"]);
        // A word longer than the width is hard-split.
        assert_eq!(wrap_text("abcdef", 3), vec!["abc", "def"]);
        // An empty line is preserved (paragraph break).
        assert_eq!(wrap_text("x\n\ny", 80), vec!["x", "", "y"]);
    }
}
