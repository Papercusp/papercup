//! Rendering — a pure function of `&App`. No state mutation, so every view is
//! snapshot-testable against a ratatui `TestBackend`.

use crate::app::{App, HarnessFocus, PluginsFocus, Tab, TestingFocus};
use crate::models::{
    contribution_count, contribution_names, tier_glyph, tier_label, Notif, INBOX_TIERS,
};
use crate::theme::Theme;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::Style,
    text::{Line, Span, Text},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Tabs, Wrap},
    Frame,
};

pub fn draw(f: &mut Frame, app: &App) {
    // Pinned single-pane dock mode (native-terminal-desktop P-013 / D-011): the
    // desktop-docked native terminal's panes render JUST one tab's body — no
    // tab strip, no HUD, no work area. The tab's state + data wiring are
    // unchanged; only the rendering is reduced to that body full-screen (the
    // tab is re-pinned in main.rs). Help + the latest toast still overlay.
    if let Some(pinned) = app.pinned {
        draw_tab_body(f, app, pinned, f.area());
        if app.show_notifs {
            // The history overlay must render in pinned dock panes too — the
            // toast flashes here, and without this branch 'N' opened an
            // overlay that never drew (owner report 2026-06-11).
            draw_notifs(f, app);
        } else if app.show_help {
            draw_help(f);
        } else if app.notify_enabled {
            if let Some(t) = &app.toast {
                draw_toast(f, t);
            }
        }
        // The detail popup is modal — render it on top of everything else in the
        // pinned dock pane (mail/conversation/plan detail, depending on focus).
        if app.fleet_detail_open {
            draw_fleet_detail(f, app);
        }
        return;
    }

    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // tab strip
            Constraint::Min(1),    // body
            Constraint::Length(1), // status bar
        ])
        .split(f.area());

    draw_tabs(f, app, root[0]);

    // Operator dock (operator-always-visible-2026-06-05, Brief 24): the operator
    // chat, docked on the RIGHT of every tab EXCEPT the tabs that already host the
    // operator themselves — the Operator tab (the whole tab IS the chat) and the
    // Overview tab (its draw_overview renders draw_operator_dock as the always-on
    // bottom strip, Brief 23; a right-dock there would show the chat twice).
    // Reuses `draw_operator_dock`/`draw_chat` and the shared `chat_*` state — one
    // conversation, multiple render sites — so the operator is usable on any tab
    // via the `o` summon/focus key. Default-closed; width-gated so narrow
    // terminals keep the tab full-width (the operator is reached via the Operator
    // tab there). Carved off root[1] BEFORE the presence and plans-filter splits
    // so the panes never overlap.
    let (work, op_dock) = if app.operator_dock_open
        && app.tab != Tab::Operator
        && app.tab != Tab::Overview
        && root[1].width >= 100
    {
        let cols = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(56), Constraint::Length(40)])
            .split(root[1]);
        (cols[0], Some(cols[1]))
    } else {
        (root[1], None)
    };

    // P7: an always-visible presence sidebar (who's online + intent), toggled
    // with `p`. Suppressed on narrow terminals so it never crowds the body.
    let (body, presence) = if app.show_presence && work.width >= 80 {
        let cols = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(48), Constraint::Length(30)])
            .split(work);
        (cols[0], Some(cols[1]))
    } else {
        (work, None)
    };

    // D-009: the collapsible plans-filter rail, carved off the LEFT of the body
    // on the two tabs it narrows (Inbox + Fleet). Suppressed on narrow bodies so
    // the lists stay usable; the filter itself still applies when hidden.
    let (rail, body) =
        if app.plan_filter_open && matches!(app.tab, Tab::Inbox | Tab::Fleet) && body.width >= 70 {
            let cols = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Length(32), Constraint::Min(38)])
                .split(body);
            (Some(cols[0]), cols[1])
        } else {
            (None, body)
        };

    draw_tab_body(f, app, app.tab, body);
    if let Some(area) = rail {
        draw_plan_filter(f, app, area);
    }
    if let Some(area) = presence {
        draw_presence(f, app, area);
    }
    // Operator dock (operator-always-visible-2026-06-05): render last of the
    // right-side panes so it owns its carved column outright.
    if let Some(area) = op_dock {
        draw_operator_dock(f, app, area);
    }
    draw_status(f, app, root[2]);

    // A transient toast for the latest notification sits above the body but
    // below the modal overlays (it shouldn't fight the help/palette/tutorial).
    if let Some(t) = &app.toast {
        if app.notify_enabled
            && !app.show_tutorial
            && !app.show_help
            && !app.palette_open
            && !app.show_notifs
            && !app.pot_picker_open
            && app.fleet_action_menu.is_none()
            && app.wake_review.is_none()
        {
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
    } else if app.pot_picker_open {
        draw_pot_picker(f, app);
    } else if let Some(menu) = &app.fleet_action_menu {
        draw_fleet_menu(f, menu);
    } else if let Some(rev) = &app.wake_review {
        draw_wake_review(f, rev);
    }
    // The detail popup (Fleet mail/conversation/plan, or the Plans-tab plan)
    // floats above the body + the other overlays.
    if app.fleet_detail_open {
        draw_fleet_detail(f, app);
    }
}

/// One tab's body. The single dispatch shared by the full workbench layout and
/// the pinned single-pane dock modes (P-013 / D-011), so a pinned pane renders
/// exactly what the tab renders in the workbench — just full-screen.
fn draw_tab_body(f: &mut Frame, app: &App, tab: Tab, body: Rect) {
    match tab {
        Tab::Overview => draw_overview(f, app, body),
        Tab::Operator => draw_chat(f, app, body),
        Tab::Inbox => draw_inbox(f, app, body),
        Tab::Plans => draw_plans(f, app, body),
        // Fleet — the fleet view, which absorbed the old Sessions launcher (D-002b).
        Tab::Fleet => crate::fleet::draw_fleet(f, app, body),
        Tab::Harnesses => draw_harnesses(f, app, body),
        Tab::Docs => draw_docs(f, app, body),
        Tab::Testing => draw_testing(f, app, body),
        Tab::Config => draw_config(f, app, body),
        Tab::Plugins => draw_plugins(f, app, body),
        Tab::Settings => draw_settings(f, app, body),
        Tab::Memory => draw_memory(f, app, body),
        Tab::Cupboard => draw_cupboard(f, app, body),
        Tab::Conversations => draw_conversations(f, app, body),
        Tab::Voice => crate::voice_ui::draw_voice(f, &app.voice_ui, body),
        Tab::Hives => crate::hives::draw_hives(f, app, body),
        // Pane-only (EI-312): the pinned `pui wake-pane` staged-wake board.
        Tab::Wake => crate::wake_board::draw_wake_board(f, app, body),
        // Pane-only (dock 4-pane split): the pinned brief/mail/work boards.
        Tab::AgentCtx => crate::agent_ctx::draw_agent_ctx(f, app, body),
        // Pane-only (pui-plans-status-board): the pinned `pui plans-pane`
        // plans status board.
        Tab::PlansBoard => crate::plans_board::draw_plans_board(f, app, body),
        // Pane-only (hive-network-surface B-09): the pinned `pui network-pane`
        // cross-Hive board / `pui hive-pane <key>` dossier.
        Tab::Network => crate::network::draw_network(f, app, body),
    }
}

fn draw_tabs(f: &mut Frame, app: &App, area: Rect) {
    // The dock main pane confines the strip to its subset
    // (pui-dock-consolidation-2026-06-07); otherwise it's the full Tab::ALL.
    let visible = app.visible_tabs();
    let titles: Vec<Line> = visible
        .iter()
        .map(|t| {
            // The switch shortcut: digit (1-9, 0) for the first 10 tabs, a letter
            // for appended tabs — each tab owns its key via `Tab::switch_key`.
            let k = t.switch_key();
            // The DISPLAY label routes through the active Hive lexicon
            // (pui-hive-lexicon-2026-06-06) — Fleet→Swarm, Pots→Hives, Cupboard→
            // Comb, Operator→Queen when the-hive is on; today's labels otherwise.
            // `title()` (the stable identity) is unchanged for persistence/state.
            let label = t.label(&app.lexicon);
            // Inbox badge = the Decisions count (inbox-tiering D-006) — the only
            // tier that demands the user. Falls back to the unseen-notification
            // count when nothing is in the Decisions tier.
            if *t == Tab::Inbox {
                let decisions = app
                    .visible_inbox()
                    .iter()
                    .filter(|it| it.tier_rank() == 0)
                    .count();
                let badge = if decisions > 0 {
                    decisions
                } else {
                    app.unseen_notifs
                };
                if badge > 0 {
                    Line::from(format!(" {}:{} ({}) ", k, label, badge))
                } else {
                    Line::from(format!(" {}:{} ", k, label))
                }
            } else {
                Line::from(format!(" {}:{} ", k, label))
            }
        })
        .collect();
    // Selection index is the position within the VISIBLE list (which differs
    // from Tab::index() when a subset is active).
    let sel = visible.iter().position(|t| *t == app.tab).unwrap_or(0);
    let tabs = Tabs::new(titles)
        .style(Theme::tab_bar())
        .select(sel)
        .highlight_style(Theme::selected());
    f.render_widget(tabs, area);
}

fn draw_plans(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(36), Constraint::Percentage(64)])
        .split(area);

    // The pot-scope-filtered list (D-003) — `plan_sel` indexes THIS list.
    let plans = app.visible_plans();
    let items: Vec<ListItem> = plans
        .iter()
        .map(|p| {
            ListItem::new(Line::from(vec![
                Span::raw(format!("{:<9}", trunc(&p.status, 9))),
                Span::raw(p.slug.clone()),
            ]))
        })
        .collect();
    let mut state = ListState::default();
    if !plans.is_empty() {
        state.select(Some(app.plan_sel.min(plans.len() - 1)));
    }
    // Two-level pane nav (owner ask 2026-06-16): the focused pane wears the active
    // border + a cursor/inside tag; ←/→ (or ↑/↓ browsing) switch list ↔ items.
    let list_focused = app.plans_focus == crate::app::PlansFocus::List;
    let items_focused = app.plans_focus == crate::app::PlansFocus::Items;
    let body_area = block_with_header(
        f,
        cols[0],
        Theme::block(
            Line::from(format!(
                " {}Plans ({}) ",
                focus_cursor(list_focused, app.plans_entered),
                plans.len()
            )),
            list_focused,
        ),
        &format!("  {:<9}{}", "status", "slug"),
    );
    let list = List::new(items)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);

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

    let item_cursor = items_focused.then_some(app.plan_items_sel);
    draw_plan_item_states(f, app, right[1], items_focused, item_cursor);
}

/// Per-item assignment/claim/liveness for the selected plan (P-005a). Renders only
/// when the loaded states belong to the SELECTED plan (a guard so a stale fetch from
/// a prior selection never paints the wrong plan). The block title carries the
/// harness's claim-liveness split (availability=LOCAL vs activity=SHARED); each row
/// is one item's disposition glyph + id + who's on it + the claim's liveness + intent.
fn draw_plan_item_states(
    f: &mut Frame,
    app: &App,
    area: Rect,
    focused: bool,
    cursor: Option<usize>,
) {
    let sel = app.selected_plan().map(|p| p.slug.as_str());
    let states = app
        .plan_item_states
        .as_ref()
        .filter(|s| Some(s.plan.as_str()) == sel);
    let mut item_count = 0usize;
    let (title, items): (String, Vec<ListItem>) = match states {
        Some(s) => {
            item_count = s.items.len();
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
            // `:pickup` = convert-at-pickup (D-015) and `:release` its inverse
            // (P-005b write surface) — advertised here so both claim actions
            // are discoverable from the pane they act on.
            (
                format!(
                    " {}Items ({}) · liveness: {mode} · :pickup/:release <item> ",
                    focus_cursor(focused, app.plans_entered),
                    s.items.len()
                ),
                rows,
            )
        }
        None => (
            format!(" {}Items ", focus_cursor(focused, app.plans_entered)),
            Vec::new(),
        ),
    };
    let body_area = block_with_header(
        f,
        area,
        Theme::block(Line::from(title), focused),
        &format!(
            "{:<2}{:<8}{:<10}{:<15}{:<7}{}",
            "", "item", "state", "who", "live", "intent"
        ),
    );
    // The items here have NO header row in the list body (the column header is a
    // separate band), so the cursor maps directly to the item index.
    let mut state = ListState::default();
    if let Some(c) = cursor {
        if item_count > 0 {
            state.select(Some(c.min(item_count - 1)));
        }
    }
    let list = List::new(items)
        .highlight_style(Theme::selected())
        .highlight_symbol("▸ ");
    f.render_stateful_widget(list, body_area, &mut state);
}

/// Focus-cursor prefix for pane titles (`▸ ` on the focused pane, empty
/// otherwise). Single source for the cursor glyph (Brief 27 vocabulary).
/// The marker prefixed to a column's title. Empty when the column is not
/// focused; the cursor glyph when it's focused-but-browsing; the cursor plus an
/// "inside" tag once you've drilled in (two-level nav, owner ask 2026-06-15 #2),
/// so browsing vs inside reads at a glance.
fn focus_cursor(focused: bool, entered: bool) -> String {
    if !focused {
        String::new()
    } else if entered {
        format!("{} inside · ", crate::glyph::nav::CURSOR)
    } else {
        format!("{} ", crate::glyph::nav::CURSOR)
    }
}

/// One plan-item row: `<glyph> <id> <disposition> <who> <liveness> <intent>` (P-005a).
/// `who` is the live-claim holder's agent-name, falling back to the durable assignee.
/// Glyphs ride the shared vocabulary (cross-category reuse per its D-004:
/// liveness fill = activity, `◆` = demands routing, `▲` = warn).
fn plan_item_line(it: &crate::models::PlanItemState) -> String {
    use crate::glyph::{liveness, severity, status};
    let (glyph, label) = match it.disposition.as_str() {
        "active" => (liveness::LIVE, "active"),
        "assigned-idle" => (liveness::IDLE, "assigned"),
        "claimed-pooled" => (status::NEEDS_HUMAN, "claimed"),
        "claimed-mismatch" => (severity::WARN, "MISMATCH"),
        "pooled" => (severity::INFO, "pooled"),
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
    let online: Vec<&crate::models::RosterEntry> = app.roster.iter().filter(|r| !r.stale).collect();
    let items: Vec<ListItem> = online
        .iter()
        .map(|r| {
            let dot = crate::glyph::liveness_dot(r.stale, &r.liveness);
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
    let list = List::new(body).block(Block::default().borders(Borders::ALL).title(Line::from(
        format!(" Presence {}/{} ", online.len(), app.roster.len()),
    )));
    f.render_widget(list, area);
}

/// D-009: the collapsible plans-filter rail (Inbox + Fleet). Lists the
/// pot-scoped plans with a checkbox glyph per slug; while the rail is open,
/// j/k move its cursor, Space/Enter toggles the plan in/out of the filter,
/// `c` clears it, and F/Esc closes the rail (the filter keeps applying when
/// hidden — the list titles carry a badge so it's never invisible).
fn draw_plan_filter(f: &mut Frame, app: &App, area: Rect) {
    let plans = app.visible_plans();
    let items: Vec<ListItem> = plans
        .iter()
        .map(|p| {
            let mark = if app.plan_filter.contains(&p.slug) {
                "[x]"
            } else {
                "[ ]"
            };
            ListItem::new(Line::from(format!("{mark} {}", trunc(&p.slug, 25))))
        })
        .collect();
    let mut state = ListState::default();
    if !plans.is_empty() {
        state.select(Some(app.plan_filter_sel.min(plans.len() - 1)));
    }
    let body_area = block_with_header(
        f,
        area,
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(format!(
                " Filter: plans ({} on) ",
                app.plan_filter.len()
            ))),
        "  ␣ toggle · c clear · F close",
    );
    if items.is_empty() {
        f.render_widget(
            Paragraph::new(Span::styled("(no plans loaded)", Theme::dim())),
            body_area,
        );
        return;
    }
    let list = List::new(items)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);
}

/// Two-tier plan→item lines for a structured `<report>` block — the ONE TUI
/// renderer for report payloads. Lifted verbatim from the old draw_chat
/// rendering; its mount point is now the Inbox detail (an operator report is
/// inbox content, not chat content — report-cards-inbox-reconciliation
/// D-001/D-002). Width-aware; status glyphs ride the shared
/// `Theme::status_marker` vocabulary.
fn report_block_lines(rep: &crate::chat_tags::Report, inner_w: usize) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    if let Some(t) = &rep.title {
        lines.push(Line::from(Span::styled(
            format!("  {} {t}", crate::glyph::nav::EXPANDED),
            Theme::header(),
        )));
    }
    for p in &rep.plans {
        let mut head = vec![
            Span::raw("  "),
            Theme::status_marker(p.status.as_deref().unwrap_or("")),
            Span::raw(" "),
            Span::styled(p.title.clone(), Theme::selected()),
        ];
        if let Some(st) = &p.status {
            head.push(Span::styled(format!("  {st}"), Theme::dim()));
        }
        lines.push(Line::from(head));
        if let Some(sum) = &p.summary {
            for wl in wrap_text(sum, inner_w.saturating_sub(6).max(8)) {
                lines.push(Line::from(Span::styled(
                    format!("      {wl}"),
                    Theme::dim(),
                )));
            }
        }
        for it in &p.items {
            let id_prefix = it
                .id
                .as_deref()
                .map(|i| format!("{i} "))
                .unwrap_or_default();
            let wrapped = wrap_text(&it.text, inner_w.saturating_sub(8).max(8));
            for (li, wl) in wrapped.iter().enumerate() {
                let mut row = vec![Span::raw("    ")];
                if li == 0 {
                    row.push(Theme::status_marker(it.status.as_deref().unwrap_or("")));
                    row.push(Span::raw(" "));
                    if !id_prefix.is_empty() {
                        row.push(Span::styled(id_prefix.clone(), Theme::dim()));
                    }
                } else {
                    row.push(Span::raw("  ")); // align continuation under the text
                }
                row.push(Span::raw(wl.clone()));
                lines.push(Line::from(row));
            }
        }
    }
    lines
}

fn draw_inbox(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(48), Constraint::Percentage(52)])
        .split(area);

    // The pot-scope-filtered inbox (D-003) — `inbox_sel` indexes THIS list.
    // Items are rendered in four tier SECTIONS (inbox-tiering D-006): Decisions ▸
    // Handled ▸ Alerts ▸ Activity. Each tier gets a header row + its items; the
    // selected item (by id) is highlighted at its display position so selection
    // survives the regrouping regardless of the underlying list order.
    let inbox = app.visible_inbox();
    let mut counts = [0usize; 4];
    for it in &inbox {
        counts[it.tier_rank() as usize] += 1;
    }
    let sel_id = app.selected_inbox().map(|it| it.id.clone());
    let mut list_items: Vec<ListItem> = Vec::new();
    let mut sel_display: Option<usize> = None;
    for tier in INBOX_TIERS {
        let tier_items: Vec<&&crate::models::AttentionItem> =
            inbox.iter().filter(|it| it.tier_str() == tier).collect();
        if tier_items.is_empty() {
            continue;
        }
        list_items.push(ListItem::new(Line::from(Span::styled(
            format!(
                "{} {} ({})",
                tier_glyph(tier),
                tier_label(tier),
                tier_items.len()
            ),
            Theme::header(),
        ))));
        for it in tier_items {
            if sel_id.as_deref() == Some(it.id.as_str()) {
                sel_display = Some(list_items.len());
            }
            let loc = it
                .plan_slug
                .clone()
                .or_else(|| it.harness_slug.clone())
                .unwrap_or_default();
            let r = it.item_ref.clone().unwrap_or_default();
            list_items.push(ListItem::new(Line::from(format!(
                "  {} {:<10} {:<22} {}",
                tier_glyph(tier),
                trunc(&it.status, 10),
                trunc(&format!("{loc}/{r}"), 22),
                trunc(&it.title, 32),
            ))));
        }
    }
    let mut state = ListState::default();
    state.select(sel_display);
    // Title headlines the Decisions count (the only tier that demands the user);
    // the full per-tier counts live in the section headers below. The plans-
    // filter badge (D-009) stays visible. Kept compact so it never truncates the
    // badge in a narrowed (rail-open) pane.
    let mut title = format!(" Inbox {}{} ", crate::glyph::status::NEEDS_HUMAN, counts[0]);
    if !app.plan_filter.is_empty() {
        title.push_str(&format!("· F:plans({}) ", app.plan_filter.len()));
    }
    let body_area = block_with_header(
        f,
        cols[0],
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(title)),
        &format!(
            "  {} Decisions · {} Handled · {} Alerts · {} Activity",
            crate::glyph::status::NEEDS_HUMAN,
            crate::glyph::status::DONE,
            crate::glyph::severity::ALERT,
            crate::glyph::severity::INFO,
        ),
    );
    let list = List::new(list_items)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);

    let preview: Vec<Line<'static>> = match app.selected_inbox() {
        Some(it) => {
            let owner = it
                .owner_label
                .clone()
                .or_else(|| it.owner_agent_id.clone())
                .unwrap_or_else(|| "—".to_string());
            let triage = match (it.triage_state.as_deref(), it.triage_note.as_deref()) {
                (Some(s), Some(n)) if s != "untriaged" => format!("\ntriage: {s} — {n}"),
                (Some(s), None) if s != "untriaged" => format!("\ntriage: {s}"),
                _ => String::new(),
            };
            // An operator-report item renders its payload as the styled
            // two-tier block (the one report renderer) instead of the plain
            // body text (which duplicates it for text-only surfaces).
            let body = if it.report.is_some() {
                String::new()
            } else {
                it.body.clone().unwrap_or_default()
            };
            let head = format!(
                "{}\n\ntier:   {} ({})\nkind:   {}\nstatus: {}\nplan:   {}\nref:    {}\nowner:  {}\nneedsHuman: {}{}\n\n{}",
                it.title,
                tier_label(it.tier_str()),
                it.tier_str(),
                it.kind,
                it.status,
                it.plan_slug.clone().unwrap_or_default(),
                it.item_ref.clone().unwrap_or_default(),
                owner,
                it.needs_human,
                triage,
                body,
            );
            let mut lines: Vec<Line<'static>> = head
                .split('\n')
                .map(|l| Line::from(l.to_string()))
                .collect();
            if let Some(rep) = &it.report {
                let inner_w = cols[1].width.saturating_sub(2) as usize;
                lines.extend(report_block_lines(rep, inner_w));
            }
            lines.push(Line::from(String::new()));
            lines.push(Line::from("[m] message owner".to_string()));
            lines
        }
        None => vec![Line::from(
            "Inbox empty — nothing needs attention.".to_string(),
        )],
    };
    let para = Paragraph::new(preview)
        .wrap(Wrap { trim: false })
        .block(Block::default().borders(Borders::ALL).title(" Preview "));
    f.render_widget(para, cols[1]);
}

/// Conversations tab (Brief 25) — the coord conversations browse surface. List
/// (left) of questions/discussions under the active state/kind/topic filter +
/// detail (right): the seed, topics, the thread, the accepted answer, the
/// linked work-item, and the promote hint. Mirrors `draw_inbox`'s split.
fn draw_conversations(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(40), Constraint::Percentage(60)])
        .split(area);

    let convs = app.visible_conversations();
    let topic_badge = app
        .conv_topic
        .as_ref()
        .map(|t| format!(" T:#{t}"))
        .unwrap_or_default();
    let title = if app.conversations_loading {
        " Conversations (loading…) ".to_string()
    } else {
        format!(
            " Conversations ({}) · s:{} t:{}{} ",
            convs.len(),
            app.conv_state(),
            app.conv_kind(),
            topic_badge,
        )
    };
    let body_area = block_with_header(
        f,
        cols[0],
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(title)),
        "  k  state    title / topics",
    );
    let title_width = body_area.width.saturating_sub(21) as usize;
    let items: Vec<ListItem> = if convs.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "(no conversations)",
            Theme::dim(),
        )))]
    } else {
        convs
            .iter()
            .map(|c| {
                let (kind, kind_style) = match c.kind.as_str() {
                    "question" => ("Q", Theme::warn()),
                    "discussion" => ("D", Theme::info()),
                    _ => ("·", Theme::dim()),
                };
                let title = c.title.clone().unwrap_or_else(|| c.id.clone());
                let tags = if c.topics.is_empty() {
                    String::new()
                } else {
                    format!(
                        " {}",
                        c.topics
                            .iter()
                            .map(|t| format!("#{t}"))
                            .collect::<Vec<_>>()
                            .join(" ")
                    )
                };
                let promoted = if c.promoted_issue_id.is_some() {
                    " issue"
                } else {
                    ""
                };
                ListItem::new(Line::from(vec![
                    Span::styled(format!("{kind} "), kind_style),
                    Span::styled(format!("{:<8} ", trunc(&c.state, 8)), Theme::dim()),
                    Span::raw(trunc(&title, title_width.max(12))),
                    Span::styled(trunc(&tags, 22), Theme::dim()),
                    Span::styled(promoted, Theme::info()),
                ]))
            })
            .collect()
    };
    let mut state = ListState::default();
    if !convs.is_empty() {
        state.select(Some(app.conversation_sel.min(convs.len() - 1)));
    }
    let list = List::new(items)
        .style(Theme::panel())
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);

    // Detail: the loaded ConvDetail if it matches the selected row, else a
    // summary placeholder prompting Enter to load the thread.
    let selected = app.selected_conversation();
    let detail_matches = matches!(
        (&app.conversation_detail, selected),
        (Some(d), Some(sel)) if d.conversation.as_ref().map(|c| c.id.as_str()) == Some(sel.id.as_str())
    );
    let preview: Vec<Line<'static>> =
        if let (true, Some(d)) = (detail_matches, app.conversation_detail.as_ref()) {
            let c = d.conversation.as_ref();
            let title = c
                .and_then(|c| c.title.clone())
                .unwrap_or_else(|| selected.map(|s| s.id.clone()).unwrap_or_default());
            let kind = c.map(|c| c.kind.as_str()).unwrap_or("");
            let st = c.map(|c| c.state.as_str()).unwrap_or("");
            let asker = c.map(|c| c.asker_id.as_str()).unwrap_or("");
            let scope = c.map(|c| c.scope.as_str()).unwrap_or("");
            let harness = c.and_then(|c| c.harness_slug.clone()).unwrap_or_default();
            let topics = if d.topics.is_empty() {
                "—".to_string()
            } else {
                d.topics
                    .iter()
                    .map(|t| format!("#{t}"))
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            let scope_label = if scope == "harness" && !harness.is_empty() {
                format!(" · {harness}")
            } else {
                String::new()
            };
            let mut lines = vec![
                Line::from(Span::styled(title, Theme::title_active())),
                Line::from(vec![
                    Span::styled(format!("{kind} "), Theme::dim()),
                    Span::raw(st.to_string()),
                    Span::styled(
                        format!(" · {} follower(s){scope_label}", d.subscriber_count),
                        Theme::dim(),
                    ),
                    Span::styled(" · asked by ", Theme::dim()),
                    Span::raw(asker.to_string()),
                ]),
                Line::from(vec![
                    Span::styled("topics ", Theme::dim()),
                    Span::raw(topics),
                ]),
            ];
            if let Some(body) = c.map(|c| c.body.as_str()).filter(|b| !b.is_empty()) {
                lines.push(Line::from(""));
                for l in body.lines() {
                    lines.push(Line::from(l.to_string()));
                }
            }
            if let Some(ans) = c.and_then(|c| c.accepted_answer.clone()) {
                lines.push(Line::from(""));
                lines.push(Line::from(vec![
                    Span::styled(crate::glyph::status::DONE.to_string(), Theme::info()),
                    Span::styled(" accepted ", Theme::info()),
                    Span::raw(ans),
                ]));
            }
            if let Some(issue) = c.and_then(|c| c.promoted_issue_id.clone()) {
                lines.push(Line::from(""));
                lines.push(Line::from(vec![
                    Span::styled("linked work-item ", Theme::dim()),
                    Span::styled(issue, Theme::info()),
                    Span::styled(" (promoted; discussion continues there)", Theme::dim()),
                ]));
            } else if c.map(|c| c.state.as_str()) != Some("closed") {
                lines.push(Line::from(""));
                lines.push(Line::from(vec![
                    Span::styled("[i] ", Theme::title_active()),
                    Span::raw("promote to an issue"),
                ]));
            }
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(
                format!("thread ({})", d.posts.len()),
                Theme::header(),
            )));
            if d.posts.is_empty() {
                lines.push(Line::from(Span::styled("(no replies yet)", Theme::dim())));
            } else {
                for p in &d.posts {
                    let who = p.author_id.clone().unwrap_or_else(|| "unknown".to_string());
                    lines.push(Line::from(""));
                    lines.push(Line::from(Span::styled(who, Theme::dim())));
                    for l in p.body.lines() {
                        lines.push(Line::from(l.to_string()));
                    }
                }
            }
            lines
        } else if let Some(sel) = selected {
            let title = sel.title.clone().unwrap_or_else(|| sel.id.clone());
            let topics = if sel.topics.is_empty() {
                "—".to_string()
            } else {
                sel.topics
                    .iter()
                    .map(|t| format!("#{t}"))
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            vec![
                Line::from(Span::styled(title, Theme::title_active())),
                Line::from(vec![
                    Span::raw(sel.kind.clone()),
                    Span::styled(" · ", Theme::dim()),
                    Span::raw(sel.state.clone()),
                    Span::styled(" · asked by ", Theme::dim()),
                    Span::raw(sel.asker_id.clone()),
                ]),
                Line::from(vec![
                    Span::styled("topics ", Theme::dim()),
                    Span::raw(topics),
                ]),
                Line::from(""),
                Line::from(vec![
                    Span::styled("[Enter] ", Theme::title_active()),
                    Span::raw("load the thread + accepted answer"),
                ]),
            ]
        } else if app.conversations_loading {
            vec![Line::from(Span::styled(
                "Loading conversations…",
                Theme::dim(),
            ))]
        } else {
            vec![
                Line::from(Span::styled(
                    "No conversations under this filter.",
                    Theme::dim(),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "s: state · t: kind · T: topic · r: refresh",
                    Theme::dim(),
                )),
            ]
        };
    let para = Paragraph::new(Text::from(preview))
        .style(Theme::panel())
        .wrap(Wrap { trim: false })
        .block(Block::default().borders(Borders::ALL).title(" Detail "));
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
    let fbody = block_with_header(
        f,
        cols[0],
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(format!(
                " {}{} ({}/{}) [/] · features ({}) ",
                focus_cursor(feat_focused, app.pane_entered),
                app.harness,
                app.harness_sel + 1,
                app.harnesses.len().max(1),
                app.features.len()
            ))),
        &format!("  {:<11}{:<9}{}", "id", "status", "title"),
    );
    let flist = List::new(fitems)
        .highlight_style(focus_hl(feat_focused))
        .highlight_symbol("> ");
    f.render_stateful_widget(flist, fbody, &mut fstate);

    // Issues (right) — selectable when focused (Tab toggles focus).
    let ititle = Line::from(format!(
        " {}issues ({}) ",
        focus_cursor(!feat_focused, app.pane_entered),
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
                    if fix.is_empty() {
                        String::new()
                    } else {
                        format!("→{fix}")
                    },
                )))
            })
            .collect();
        let mut istate = ListState::default();
        istate.select(Some(app.issue_sel));
        let ibody = block_with_header(
            f,
            cols[1],
            Block::default().borders(Borders::ALL).title(ititle),
            &format!("  {:<9}{:<12}{}", "severity", "status", "title"),
        );
        let ilist = List::new(iitems)
            .highlight_style(focus_hl(!feat_focused))
            .highlight_symbol("> ");
        f.render_stateful_widget(ilist, ibody, &mut istate);
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

/// Source tag + style for a doc badge (harness-docs-integration P-009).
fn doc_source_tag(source: &str) -> (&'static str, Style) {
    match source {
        "generated" => ("G ", Theme::info()),
        "augmented" => ("A ", Theme::notify()),
        _ => ("M ", Theme::dim()),
    }
}
/// Freshness marker + style: ⚠ stale/review · ○ not-drift-tracked · blank fresh.
fn doc_status_marker(status: &str) -> (&'static str, Style) {
    match status {
        "stale" | "review" => ("⚠ ", Theme::warn()),
        "untracked" => ("○ ", Theme::dim()),
        "unknown" => ("? ", Theme::dim()),
        _ => ("  ", Theme::dim()),
    }
}

fn draw_docs(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(34), Constraint::Percentage(66)])
        .split(area);

    // Merged model (P-009): each row carries a source tag (G/M/A) + a freshness
    // marker (⚠ / ○), so generated vs human and stale vs fresh are visible at a glance.
    let items: Vec<ListItem> = app
        .docs_files
        .iter()
        .map(|p| {
            let entry = app.doc_entries.iter().find(|e| &e.doc_id == p);
            let (src_tag, src_style) =
                doc_source_tag(entry.map(|e| e.source.as_str()).unwrap_or("manual"));
            let (mark, mark_style) =
                doc_status_marker(entry.map(|e| e.status.as_str()).unwrap_or("untracked"));
            ListItem::new(Line::from(vec![
                Span::styled(mark, mark_style),
                Span::styled(src_tag, src_style),
                Span::raw(trunc(p, 26)),
            ]))
        })
        .collect();
    let mut state = ListState::default();
    if !app.docs_files.is_empty() {
        state.select(Some(app.doc_sel));
    }
    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(Line::from(format!(
                    " {} · docs ({}) · R:regen V:verify ",
                    app.harness,
                    app.docs_files.len()
                ))),
        )
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, cols[0], &mut state);

    let title = app.docs_files.get(app.doc_sel).cloned().unwrap_or_default();
    // The active doc's source · status, appended to the reader title.
    let meta = app
        .doc_active
        .as_ref()
        .map(|a| {
            let st = if a.status.is_empty() || a.status == "fresh" {
                String::new()
            } else {
                format!(" · {}", a.status)
            };
            let src = if a.source.is_empty() {
                String::new()
            } else {
                format!(" · {}", a.source)
            };
            format!("{src}{st}")
        })
        .unwrap_or_default();
    let reader_title = if title.is_empty() {
        " reader ".to_string()
    } else {
        format!(" {}{} ", trunc(&title, 46), meta)
    };

    // The augmented human overlay (the "why") rides above the generated body.
    let mut body = if app.doc_content.is_empty() {
        "(no docs — select a file)".to_string()
    } else {
        app.doc_content.clone()
    };
    if let Some(ov) = app.doc_active.as_ref().and_then(|a| a.overlay.as_ref()) {
        if !ov.trim().is_empty() {
            let quoted = ov.replace('\n', "\n┃ ");
            body =
                format!("┃ Human note (augmented · survives regeneration)\n┃ {quoted}\n\n{body}");
        }
    }
    let para = Paragraph::new(body)
        .wrap(Wrap { trim: false })
        .scroll((app.doc_scroll, 0))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(Line::from(reader_title)),
        );
    f.render_widget(para, cols[1]);
}

fn draw_testing(f: &mut Frame, app: &App, area: Rect) {
    // Run-on-click (D-004a): domains (left) ▸ the selected domain's runnable
    // files (right, fetched on Enter), with a run-result pane below once a run
    // has started. Tab hops the column focus; Enter/r runs the selected file.
    let rows = if app.test_run.is_some() {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(1), Constraint::Percentage(45)])
            .split(area)
    } else {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(1)])
            .split(area)
    };
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(44), Constraint::Percentage(56)])
        .split(rows[0]);

    let dom_focused = app.testing_focus == TestingFocus::Domains;
    let focus_hl = |on: bool| if on { Theme::selected() } else { Theme::dim() };

    // Domains (left).
    let items: Vec<ListItem> = app
        .testing
        .iter()
        .map(|d| {
            ListItem::new(Line::from(format!(
                "{:<10} {:<20} {}",
                trunc(&d.tier, 10),
                trunc(&d.label, 20),
                trunc(&d.description, 28),
            )))
        })
        .collect();
    let mut state = ListState::default();
    if !app.testing.is_empty() {
        state.select(Some(app.testing_sel));
    }
    let dbody = block_with_header(
        f,
        cols[0],
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(format!(
                " {}{} · domains ({}) ",
                focus_cursor(dom_focused, app.pane_entered),
                app.harness,
                app.testing.len()
            ))),
        &format!("  {:<11}{:<21}{}", "tier", "domain", "description"),
    );
    let list = List::new(items)
        .highlight_style(focus_hl(dom_focused))
        .highlight_symbol("> ");
    f.render_stateful_widget(list, dbody, &mut state);

    // Files of the selected domain (right).
    let ftitle = Line::from(format!(
        " {}files ({}) — Enter/r: run ",
        focus_cursor(!dom_focused, app.pane_entered),
        app.testing_files.len()
    ));
    if app.testing_files.is_empty() {
        let hint = if app.testing_files_loading {
            "loading files…"
        } else {
            "(Enter on a domain loads its runnable files)"
        };
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(hint, Theme::dim())))
                .block(Block::default().borders(Borders::ALL).title(ftitle)),
            cols[1],
        );
    } else {
        let fitems: Vec<ListItem> = app
            .testing_files
            .iter()
            .map(|p| ListItem::new(Line::from(trunc(p, 64))))
            .collect();
        let mut fstate = ListState::default();
        fstate.select(Some(app.testing_file_sel.min(app.testing_files.len() - 1)));
        let flist = List::new(fitems)
            .block(Block::default().borders(Borders::ALL).title(ftitle))
            .highlight_style(focus_hl(!dom_focused))
            .highlight_symbol("> ");
        f.render_stateful_widget(flist, cols[1], &mut fstate);
    }

    // Run result (bottom) — present from the moment a run starts.
    if let Some(run) = &app.test_run {
        let (status_label, style) = if run.running {
            ("running…".to_string(), Theme::dim())
        } else {
            let s = run.status.clone();
            let style = match s.as_str() {
                "pass" => Theme::notify(),
                _ => Theme::warn(),
            };
            (s, style)
        };
        // Tail the output so the verdict + failures are visible without scroll.
        let tail: Vec<&str> = run.output.lines().rev().take(40).collect();
        let body: String = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        let para = Paragraph::new(if run.running && body.is_empty() {
            "vitest is running in the harness worktree — output lands here.".to_string()
        } else {
            body
        })
        .wrap(Wrap { trim: false })
        .style(if run.running {
            Theme::dim()
        } else {
            Style::default()
        })
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(Line::from(vec![
                    Span::raw(format!(
                        " {} {} · ",
                        crate::glyph::action::RUN,
                        trunc(&run.file, 48)
                    )),
                    Span::styled(status_label, style),
                    Span::raw(" "),
                ])),
        );
        f.render_widget(para, rows[1]);
    }
}

fn draw_plugins(f: &mut Frame, app: &App, area: Rect) {
    // Two sub-views, Tab toggles (D-007/D-014): the installed-plugin list
    // (contributions + settings) and the launchable tui-panes (D-002).
    match app.plugins_focus {
        PluginsFocus::List => draw_plugins_list(f, app, area),
        PluginsFocus::Panes => draw_plugin_panes(f, app, area),
    }
}

/// The installed-plugin list + a detail pane surfacing each plugin's frontend
/// vs backend contributions (D-007) and its schema-driven settings (D-014).
fn draw_plugins_list(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(42), Constraint::Percentage(58)])
        .split(area);

    // Left: plugin list — name vX, FE/BE contribution counts, ⚙ if configurable.
    let items: Vec<ListItem> = app
        .plugins
        .iter()
        .map(|p| {
            let gear = if p.config_schema.is_some() {
                "⚙"
            } else {
                " "
            };
            ListItem::new(Line::from(format!(
                "{:<24} {:>6} FE:{:<2} BE:{:<2} {}",
                trunc(&p.name, 24),
                trunc(&p.version, 6),
                p.frontend_count(),
                p.backend_count(),
                gear,
            )))
        })
        .collect();
    let mut state = ListState::default();
    if !app.plugins.is_empty() {
        state.select(Some(app.plugin_sel));
    }
    let left_body = block_with_header(
        f,
        cols[0],
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(format!(
                " plugins ({}) — Tab→panes ",
                app.plugins.len()
            ))),
        &format!(
            "  {:<24} {:>6} {:<6}{:<6}{}",
            "name", "ver", "front", "back", "cfg"
        ),
    );
    f.render_stateful_widget(
        List::new(items)
            .highlight_style(Theme::selected())
            .highlight_symbol("> "),
        left_body,
        &mut state,
    );

    // Right: detail for the selected plugin.
    let block = Block::default()
        .borders(Borders::ALL)
        .title(Line::from(" detail "));
    let detail: Vec<Line> = match app.selected_plugin() {
        None => vec![Line::from(Span::styled(
            "(no plugins installed)",
            Theme::dim(),
        ))],
        Some(p) => {
            let mut lines = vec![
                Line::from(Span::styled(p.name.clone(), Theme::header())),
                Line::from(format!("v{}", p.version)),
            ];
            if let Some(d) = &p.description {
                lines.push(Line::from(""));
                lines.push(Line::from(d.clone()));
            }
            // Frontend contributions (D-007).
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled("frontend", Theme::header())));
            push_contrib(&mut lines, "ui", &p.ui);
            push_contrib(&mut lines, "dashboardTabs", &p.dashboard_tabs);
            push_contrib(&mut lines, "sidebarItems", &p.sidebar_items);
            if p.frontend_count() == 0 {
                lines.push(Line::from(Span::styled("  (none)", Theme::dim())));
            }
            // Backend contributions (D-007).
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled("backend", Theme::header())));
            push_contrib(&mut lines, "tools", &p.tools);
            push_contrib(&mut lines, "actions", &p.actions);
            push_contrib(&mut lines, "apiRoutes", &p.api_routes);
            push_contrib(&mut lines, "routines", &p.routines);
            if p.backend_count() == 0 {
                lines.push(Line::from(Span::styled("  (none)", Theme::dim())));
            }
            // Settings (D-014).
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled("settings", Theme::header())));
            if p.config_schema.is_none() {
                lines.push(Line::from(Span::styled(
                    "  (this plugin declares no configSchema)",
                    Theme::dim(),
                )));
            } else {
                match app.selected_plugin_config() {
                    None => lines.push(Line::from(Span::styled(
                        "  press Enter to load this pot's config",
                        Theme::dim(),
                    ))),
                    Some(cfg) => {
                        let rendered = serde_json::to_string_pretty(cfg)
                            .unwrap_or_else(|_| "(unrenderable)".into());
                        if rendered == "{}" {
                            lines.push(Line::from(Span::styled(
                                "  (no config set — defaults apply)",
                                Theme::dim(),
                            )));
                        } else {
                            for l in rendered.lines() {
                                lines.push(Line::from(format!("  {l}")));
                            }
                        }
                        lines.push(Line::from(""));
                        lines.push(Line::from(Span::styled(
                            "  :pset <key.path> <value> · :punset <key.path>",
                            Theme::dim(),
                        )));
                    }
                }
            }
            lines
        }
    };
    f.render_widget(
        Paragraph::new(detail)
            .wrap(Wrap { trim: false })
            .block(block),
        cols[1],
    );
}

/// Append a `  <field>: name, name (+N)` line for a contribution field, or
/// nothing when the field is empty (D-007).
fn push_contrib(lines: &mut Vec<Line>, field: &str, v: &serde_json::Value) {
    let n = contribution_count(v);
    if n == 0 {
        return;
    }
    let mut names = contribution_names(v);
    let extra = names.len().saturating_sub(4);
    names.truncate(4);
    let mut s = format!("  {field}: {}", names.join(", "));
    if extra > 0 {
        s.push_str(&format!(" (+{extra})"));
    }
    lines.push(Line::from(s));
}

/// The launchable plugin-contributed TUI panes (the original D-002 view).
fn draw_plugin_panes(f: &mut Frame, app: &App, area: Rect) {
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
    let body_area = block_with_header(
        f,
        area,
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(format!(
                " {} · plugin panes ({}) — Enter to launch · Tab→list ",
                app.harness,
                app.panes.len()
            ))),
        &format!("  {:<3}{:<23}{:<19}{}", "", "pane", "plugin", "command"),
    );
    let list = List::new(items)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);
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
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(Line::from(format!(
                    " feature flags ({}) · source: {source} — read-only ",
                    app.flags.len()
                ))),
        )
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
            lines.push(Line::from(format!(
                "backend:  {}  ·  {}",
                backend,
                trunc(&a.config.cmd, 50)
            )));
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
            .map(|(name, set)| {
                format!(
                    "{name} {}",
                    if *set {
                        crate::glyph::status::DONE
                    } else {
                        crate::glyph::status::FAILED
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("  ");
        lines.push(Line::from(format!("providers: {}", trunc(&provs, 70))));
    }
    let para = Paragraph::new(lines).wrap(Wrap { trim: false }).block(
        Block::default()
            .borders(Borders::ALL)
            .title(" operator config (read-only) "),
    );
    f.render_widget(para, area);
}

/// Config tab (D-013): renders the *effective* settings — Claude Code defaults
/// overlaid by the harness's `.claude/settings.json` — so an empty file shows
/// the real editable structure instead of a blank. A provenance line says
/// which top-level keys the file provides (or that everything is defaults),
/// and the footer hints the `:set`/`:unset` palette editor.
fn draw_config(f: &mut Frame, app: &App, area: Rect) {
    let block = Block::default()
        .borders(Borders::ALL)
        .title(Line::from(format!(
            " {} · .claude/settings.json (effective) ",
            app.harness
        )));
    let mut lines: Vec<Line> = Vec::new();
    if let Some(err) = &app.config.parse_error {
        lines.push(Line::from(Span::styled(
            format!("file invalid: {err} — showing defaults"),
            Theme::warn(),
        )));
    } else if app.config.file_keys.is_empty() {
        lines.push(Line::from(Span::styled(
            "(no settings file for this pot — showing Claude Code defaults)",
            Theme::dim(),
        )));
    } else {
        lines.push(Line::from(Span::styled(
            format!(
                "file sets: {} (rest = defaults)",
                app.config.file_keys.join(", ")
            ),
            Theme::dim(),
        )));
    }
    lines.push(Line::from(""));
    let rendered = if app.config.effective.is_null() {
        "(loading…)".to_string()
    } else {
        serde_json::to_string_pretty(&app.config.effective)
            .unwrap_or_else(|_| "(unrenderable)".into())
    };
    lines.extend(rendered.lines().map(|l| Line::from(l.to_string())));
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        ":set <key.path> <value> · :unset <key.path> — edits write .claude/settings.json",
        Theme::dim(),
    )));
    let para = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .block(block);
    f.render_widget(para, area);
}

/// Operator chat pane (tui-operator-surface-2026-06-04): a scrollable transcript
/// over a composer box. The transcript is **pre-wrapped** to the inner width so
/// the bottom-anchored scroll offset is exact; `chat_scroll` counts lines UP from
/// the latest (0 = pinned to the newest). The in-flight assistant bubble shows a
/// live `<say>` preview via `chat_tags::live_preview`.
fn draw_chat(f: &mut Frame, app: &App, area: Rect) {
    // Inline card (sentinel-tui-shared-backend-and-cards Phase 2a): when the
    // operator brain has an open `chat:ask_choice` card, reserve a bottom strip
    // for it (between the transcript and the composer) and render it there. The
    // card's height scales with its content, clamped so the transcript stays
    // visible. No card → the transcript fills the space as before.
    let card_h = card_block_height(app, area);
    let constraints = if card_h > 0 {
        vec![
            Constraint::Min(1),
            Constraint::Length(card_h),
            Constraint::Length(3),
        ]
    } else {
        vec![Constraint::Min(1), Constraint::Length(3)]
    };
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(area);
    let transcript_area = rows[0];
    let (card_area, composer_area) = if card_h > 0 {
        (Some(rows[1]), rows[2])
    } else {
        (None, rows[1])
    };

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
            if p.is_empty() {
                "…".to_string()
            } else {
                p
            }
        } else {
            m.content.clone()
        };
        for wl in wrap_text(&body, inner_w) {
            lines.push(Line::from(wl));
        }
        for tc in &m.tools {
            lines.push(Line::from(Span::styled(
                format!("  ⚙ {}", tc.name),
                Theme::dim(),
            )));
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
    // When draw_chat renders the DOCKED pane (every tab except Operator, where
    // the full tab IS the chat), show a focus marker so the user can tell whether
    // keystrokes reach the dock (● focused) or the active tab (○ — press o to
    // focus). On the Operator tab this is empty, so existing renders are unchanged.
    let dock_focus = if app.tab != Tab::Operator {
        if app.operator_dock_focused {
            format!("{} ", crate::glyph::toggle::ON)
        } else {
            format!("{} o ", crate::glyph::toggle::OFF)
        }
    } else {
        String::new()
    };
    let title = format!(
        " {}Operator{}{} ",
        dock_focus,
        earlier,
        if app.chat_streaming {
            " · …thinking"
        } else {
            ""
        },
    );
    let para = Paragraph::new(lines).scroll((top, 0)).block(
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(title)),
    );
    f.render_widget(para, transcript_area);

    // Inline card (Phase 2a): render the focused card into its reserved strip.
    if let Some(ca) = card_area {
        draw_card(f, app, ca);
    }

    let (ctitle, ctext, cstyle) = if app.card_state.has_card() {
        // A blocking card is open — the composer is suspended; the card owns the
        // keys (arrows/number/space/Enter). Tell the user where to act.
        (
            " Card — answer above ",
            "↑↓ move · Enter/number pick · Space toggle · Esc skip".to_string(),
            Theme::notify(),
        )
    } else if app.voice_phase.is_active() {
        // Voice PTT in flight (voice-mode-tui-port-2026-06-05 P2) — the composer
        // line becomes the voice status: phase badge, plus a live mic meter while
        // recording (key-up / `v` / Esc to end).
        use crate::app::VoicePhase;
        let badge = app.voice_phase.badge();
        let body = if app.voice_phase == VoicePhase::Recording {
            format!(
                "{badge}  {}   (v / release to send · Esc cancel)",
                mic_meter(app.voice_level)
            )
        } else {
            badge.to_string()
        };
        (" Voice ", body, Theme::notify())
    } else if app.chat_composing {
        (
            " Message — Enter send · Esc cancel ",
            format!("> {}", app.chat_input),
            Theme::selected(),
        )
    } else if app.convai_phase != crate::app::ConvAiPhase::Off {
        // Realtime Conv-AI session (voice-realtime-tui-2026-06-05 P-007): the
        // composer becomes the live-session status — no PTT, just talk.
        let owner = if app.convai_is_player {
            "host"
        } else {
            "attached"
        };
        let mic = if app.convai_muted { "muted" } else { "live" };
        let mode = if app.convai_mode.is_empty() {
            "always-on"
        } else {
            app.convai_mode.as_str()
        };
        let ptt_hint = if mode == "push-to-talk" {
            " · v hold-talk"
        } else {
            ""
        };
        (
            " Voice — realtime ",
            format!(
                "{} · {owner} · {mode} · mic {mic}{ptt_hint} · A mode · M mute · H host · V stops",
                app.convai_phase.badge()
            ),
            Theme::notify(),
        )
    } else {
        let hint = match &app.voice_error {
            Some(e) => format!("press i to talk · v to speak — last voice: {e}"),
            None => "press i to talk · v PTT · V realtime voice".to_string(),
        };
        (
            " Composer — i type · v speak · j/k scroll ",
            hint,
            Theme::dim(),
        )
    };
    let cpara = Paragraph::new(Line::from(Span::styled(ctext, cstyle))).block(
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(ctitle)),
    );
    f.render_widget(cpara, composer_area);
}

/// The height (rows, incl. borders) to reserve for the inline card strip, or 0
/// when no card is open. Scales with the rendered card line count, clamped to
/// at most ~60% of the pane so the transcript stays visible.
fn card_block_height(app: &App, area: Rect) -> u16 {
    if !app.card_state.has_card() {
        return 0;
    }
    let inner_w = area.width.saturating_sub(2).max(1) as usize;
    let lines = card_lines(app, inner_w);
    let content = lines.len() as u16;
    let want = content.saturating_add(2); // borders
    let cap = (area.height as f32 * 0.6) as u16;
    want.min(cap.max(4)).max(4)
}

/// Build the rendered lines of the focused card (prompt · optional report ·
/// the presentation-specific body: radio/checkbox rows, text/date/slider input).
fn card_lines(app: &App, inner_w: usize) -> Vec<Line<'static>> {
    use crate::card_view::CardPresentation;
    let mut lines: Vec<Line<'static>> = Vec::new();
    let Some(card) = app.card_state.focused() else {
        return lines;
    };
    // Prompt (wrapped).
    for wl in wrap_text(&card.prompt, inner_w.saturating_sub(2).max(8)) {
        lines.push(Line::from(Span::styled(wl, Theme::header())));
    }
    // Optional structured report block (the same two-tier render the inbox uses).
    if let Some(rep) = &card.report {
        lines.extend(report_block_lines(rep, inner_w));
    }
    lines.push(Line::from(""));
    match &card.presentation {
        CardPresentation::Radio { options } | CardPresentation::Checkbox { options } => {
            let is_checkbox = matches!(card.presentation, CardPresentation::Checkbox { .. });
            for (i, opt) in options.iter().enumerate() {
                let selected = i == app.card_state.sel;
                // marker: radio → ›/space; checkbox → [x]/[ ]
                let marker = if is_checkbox {
                    if app.card_state.is_checked(i) {
                        "[x]"
                    } else {
                        "[ ]"
                    }
                } else if selected {
                    "›"
                } else {
                    " "
                };
                let label = if let Some(hint) = &opt.hint {
                    format!("{}. {} — {}", i + 1, opt.label, hint)
                } else {
                    format!("{}. {}", i + 1, opt.label)
                };
                let style = if selected {
                    Theme::selected()
                } else {
                    Style::default()
                };
                let row = format!("  {marker} {label}");
                for (li, wl) in wrap_text(&row, inner_w).into_iter().enumerate() {
                    // Indent continuation lines under the label.
                    let text = if li == 0 { wl } else { format!("      {wl}") };
                    lines.push(Line::from(Span::styled(text, style)));
                }
            }
        }
        CardPresentation::Text { placeholder, .. } => {
            let shown = if app.card_state.input.is_empty() {
                placeholder
                    .clone()
                    .or_else(|| card.fallback_text.clone())
                    .unwrap_or_else(|| "type your answer".to_string())
            } else {
                app.card_state.input.clone()
            };
            let style = if app.card_state.input.is_empty() {
                Theme::dim()
            } else {
                Theme::selected()
            };
            lines.push(Line::from(vec![
                Span::raw("  > "),
                Span::styled(shown, style),
                Span::styled(" ▌", Theme::notify()),
            ]));
        }
        CardPresentation::Date { .. } => {
            let shown = if app.card_state.input.is_empty() {
                "YYYY-MM-DD".to_string()
            } else {
                app.card_state.input.clone()
            };
            lines.push(Line::from(vec![
                Span::raw("  date: "),
                Span::styled(shown, Theme::selected()),
                Span::styled(" ▌", Theme::notify()),
            ]));
        }
        CardPresentation::Slider { min, max, step } => {
            // A simple text gauge: value plus a bar across [min,max].
            let v = app.card_state.slider;
            let frac = if (max - min).abs() < f64::EPSILON {
                0.0
            } else {
                ((v - min) / (max - min)).clamp(0.0, 1.0)
            };
            let bar_w = inner_w.saturating_sub(20).clamp(8, 40);
            let filled = (frac * bar_w as f64).round() as usize;
            let bar: String = std::iter::repeat('█')
                .take(filled)
                .chain(std::iter::repeat('░').take(bar_w.saturating_sub(filled)))
                .collect();
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(bar, Theme::notify()),
                Span::styled(
                    format!("  {v}  ({min}–{max}, ±{step})  ←/→ adjust"),
                    Theme::dim(),
                ),
            ]));
        }
        CardPresentation::Unknown => {
            let fb = card
                .fallback_text
                .clone()
                .unwrap_or_else(|| "No renderer for this card type.".to_string());
            for wl in wrap_text(&fb, inner_w) {
                lines.push(Line::from(Span::styled(wl, Theme::dim())));
            }
        }
    }
    lines
}

/// Render the focused inline card into `area` (Phase 2a). A bordered block whose
/// title carries the queue indicator (N more after this). The card is a blocking
/// modal on the operator surface — the composer is suspended while it's open.
fn draw_card(f: &mut Frame, app: &App, area: Rect) {
    let inner_w = area.width.saturating_sub(2).max(1) as usize;
    let lines = card_lines(app, inner_w);
    let remaining = app.card_state.remaining();
    let title = if remaining > 0 {
        format!(
            " {} Operator asks · {remaining} more ",
            crate::glyph::nav::EXPANDED
        )
    } else {
        format!(" {} Operator asks ", crate::glyph::nav::EXPANDED)
    };
    // Clear under the strip so the transcript doesn't bleed through.
    f.render_widget(Clear, area);
    let para = Paragraph::new(lines).wrap(Wrap { trim: false }).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Theme::notify())
            .title(Line::from(Span::styled(title, Theme::notify()))),
    );
    f.render_widget(para, area);
}

/// Render the operator chat into an arbitrary rectangle — the public, render-only
/// entry point for the docked operator pane (operator-always-visible-2026-06-05,
/// Brief 24). It carries NO layout-split logic: the caller owns the geometry (the
/// workbench `draw()` carves a right-hand column; Brief 23's Overview reserves a
/// bottom strip) and this fills it with the SAME transcript + composer the
/// Operator tab shows — one conversation rendered at multiple sites. The focus
/// marker in the title is driven by `app.operator_dock_focused` (see draw_chat).
pub fn draw_operator_dock(f: &mut Frame, app: &App, area: Rect) {
    draw_chat(f, app, area);
}

/// Overview — the dashboard landing surface (Brief 23,
/// overview-dashboard-2026-06-05). Top bar (usage/spend/max — stub slots until
/// rate-limit-layer-v2 lands its read-model route, D-004) + four tiles
/// (Plans · Needs-you · Agents · Activity; j/k cycle, Enter opens the full
/// tab, D-007) + the always-on operator strip at the bottom (Brief 24's
/// `draw_operator_dock`, D-008). Tiles read the SAME pot-scoped app state the
/// full tabs render (D-002/D-005) — no Overview-private fetches.
fn draw_overview(f: &mut Frame, app: &App, area: Rect) {
    // The operator strip yields on short terminals — the tiles win, and the
    // operator stays reachable via the Operator tab / the `o` dock.
    let strip_h: u16 = if area.height >= 24 { 9 } else { 0 };
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),       // fleet top bar
            Constraint::Min(8),          // tiles
            Constraint::Length(strip_h), // operator strip
        ])
        .split(area);

    draw_overview_topbar(f, app, rows[0]);

    // 2×2 grid on wide bodies; a 1×4 stack on narrow ones.
    let tiles: [Rect; 4] = if area.width >= 96 {
        let halves = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
            .split(rows[1]);
        let top = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
            .split(halves[0]);
        let bot = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
            .split(halves[1]);
        [top[0], top[1], bot[0], bot[1]]
    } else {
        let quarters = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Percentage(25),
                Constraint::Percentage(25),
                Constraint::Percentage(25),
                Constraint::Percentage(25),
            ])
            .split(rows[1]);
        [quarters[0], quarters[1], quarters[2], quarters[3]]
    };

    draw_overview_plans_tile(f, app, tiles[0], app.overview_sel == 0);
    draw_overview_needs_you_tile(f, app, tiles[1], app.overview_sel == 1);
    draw_overview_agents_tile(f, app, tiles[2], app.overview_sel == 2);
    draw_overview_activity_tile(f, app, tiles[3], app.overview_sel == 3);

    if strip_h > 0 {
        draw_operator_dock(f, app, rows[2]);
    }
}

/// The Overview tile chrome: bordered block, title styled selected/dim so the
/// j/k tile cursor is visible (the focus_hl idiom the column panes use).
fn overview_tile_block(title: String, selected: bool) -> Block<'static> {
    let style = if selected {
        Theme::selected()
    } else {
        Theme::header()
    };
    Block::default()
        .borders(Borders::ALL)
        .title(Line::from(Span::styled(title, style)))
}

/// Top bar: the fleet rate/usage/max read-model (rate-limit-layer-v2 P-013,
/// GET /api/operator/rate-limit-config — live once the poller has fetched it;
/// dashes before that / on a pre-route host) + a live alerts count off the
/// inbox alert tier. `+`/`-` edit the hard cap (P-005).
fn draw_overview_topbar(f: &mut Frame, app: &App, area: Rect) {
    let alerts = app
        .visible_inbox()
        .iter()
        .filter(|i| i.tier_rank() == 2)
        .count();
    let mut spans: Vec<Span> = vec![Span::styled(" usage ", Theme::dim())];
    match &app.fleet_rate {
        Some(s) => {
            // Usage%: the worst known bucket; a dash when no provider exposes
            // a ceiling (never fabricated — rate-limit v2 D-002).
            match s.headline_usage_pct() {
                Some(p) => spans.push(Span::raw(format!("{p:.0}%"))),
                None => spans.push(Span::styled("—%", Theme::dim())),
            }
            spans.push(Span::styled("  ·  spend ", Theme::dim()));
            let spend = s.usage.spend_usd;
            spans.push(Span::raw(if spend <= 0.0 {
                "$0".to_string()
            } else if spend < 0.01 {
                format!("${spend:.4}")
            } else {
                format!("${spend:.2}")
            }));
            spans.push(Span::styled("  ·  agents ", Theme::dim()));
            // in-flight / AIMD-effective / editable max (eff shown only when
            // the adaptive layer sits under the cap) — mirrors the desktop.
            let fleet = &s.fleet;
            if fleet.effective < fleet.cap {
                spans.push(Span::raw(format!(
                    "{} / eff {} / {}",
                    fleet.in_flight, fleet.effective, fleet.cap
                )));
            } else {
                spans.push(Span::raw(format!("{} / {}", fleet.in_flight, fleet.cap)));
            }
            spans.push(Span::styled("  +/- max", Theme::dim()));
            let paused = s.paused_count();
            if paused > 0 {
                spans.push(Span::styled(
                    format!("  ·  {} {paused} rate-paused", crate::glyph::severity::WARN),
                    Theme::warn(),
                ));
            }
        }
        None => {
            spans.push(Span::styled("—%", Theme::dim()));
            spans.push(Span::styled("  ·  spend ", Theme::dim()));
            spans.push(Span::styled("$—", Theme::dim()));
            spans.push(Span::styled("  ·  agents ", Theme::dim()));
            spans.push(Span::styled("—", Theme::dim()));
            spans.push(Span::styled("  (connecting…)", Theme::dim()));
        }
    }
    spans.push(Span::styled("  ·  ", Theme::dim()));
    if alerts > 0 {
        spans.push(Span::styled(
            format!("{} {} alerts", crate::glyph::severity::WARN, alerts),
            Theme::warn(),
        ));
    } else {
        spans.push(Span::styled("no alerts", Theme::dim()));
    }
    let p = Paragraph::new(Line::from(spans))
        .block(Block::default().borders(Borders::ALL).title(" Fleet "));
    f.render_widget(p, area);
}

/// Plans tile: in-flight plans (pot-scoped, non-archived, non-shipped) with a
/// done/total progress bar per plan — the same `item_counts` aggregation the
/// fleet view uses.
fn draw_overview_plans_tile(f: &mut Frame, app: &App, area: Rect, selected: bool) {
    let plans: Vec<&crate::models::PlanSummary> = app
        .visible_plans()
        .into_iter()
        .filter(|p| !p.archived && p.status != "shipped" && p.status != "superseded")
        .collect();
    let rows_avail = area.height.saturating_sub(2) as usize;
    let items: Vec<ListItem> = plans
        .iter()
        .take(rows_avail.max(1))
        .map(|p| {
            let c = &p.item_counts;
            let done = c.done;
            let total = c.todo + c.wip + c.blocked + c.needs_human + c.done;
            let bar = progress_bar(done, total, 10);
            let title = if p.title.is_empty() {
                &p.slug
            } else {
                &p.title
            };
            ListItem::new(Line::from(vec![
                Theme::status_marker(&p.status),
                Span::raw(format!(" {:<28} ", trunc(title, 28))),
                Span::styled(bar, Theme::notify()),
                Span::styled(format!(" {done}/{total}"), Theme::dim()),
            ]))
        })
        .collect();
    let n = plans.len();
    let list = List::new(items).block(overview_tile_block(
        format!(" Plans ({n}) · Enter: open "),
        selected,
    ));
    f.render_widget(list, area);
}

/// Needs-you tile: the inbox DECISIONS tier only (inbox-tiering D-006) — the
/// items that genuinely demand the user, not the activity firehose.
fn draw_overview_needs_you_tile(f: &mut Frame, app: &App, area: Rect, selected: bool) {
    let decisions: Vec<&crate::models::AttentionItem> = app_decisions(app);
    let rows_avail = area.height.saturating_sub(2) as usize;
    let items: Vec<ListItem> = decisions
        .iter()
        .take(rows_avail.max(1))
        .map(|it| {
            let loc = it
                .plan_slug
                .clone()
                .or_else(|| it.harness_slug.clone())
                .unwrap_or_default();
            ListItem::new(Line::from(vec![
                Span::styled(crate::glyph::status::NEEDS_HUMAN, Theme::warn()),
                Span::raw(format!(" {:<34} ", trunc(&it.title, 34))),
                Span::styled(trunc(&loc, 16), Theme::dim()),
            ]))
        })
        .collect();
    let n = decisions.len();
    let list = List::new(items).block(overview_tile_block(format!(" Needs you ({n}) "), selected));
    f.render_widget(list, area);
}

/// Agents tile: live (non-stale) roster entries — who's on, what each is doing.
fn draw_overview_agents_tile(f: &mut Frame, app: &App, area: Rect, selected: bool) {
    // The same plan-filtered roster the Fleet tab renders (D-002/D-005).
    let live: Vec<&crate::models::RosterEntry> = app
        .visible_roster()
        .into_iter()
        .filter(|r| !r.stale)
        .collect();
    let rows_avail = area.height.saturating_sub(2) as usize;
    let items: Vec<ListItem> = live
        .iter()
        .take(rows_avail.max(1))
        .map(|r| {
            let what = r.intent.clone().unwrap_or_default();
            let who = if r.label.is_empty() {
                &r.owner_id
            } else {
                &r.label
            };
            ListItem::new(Line::from(vec![
                Theme::liveness_marker(r.stale, &r.liveness),
                Span::raw(format!(" {:<14} ", trunc(who, 14))),
                Span::styled(trunc(&what, 40), Theme::dim()),
            ]))
        })
        .collect();
    let n = live.len();
    let list = List::new(items).block(overview_tile_block(
        format!(" Agents ({n} live) "),
        selected,
    ));
    f.render_widget(list, area);
}

/// Activity tile: the most-recent fleet activity rows (the live stream the
/// Fleet tab mirrors; `summary` arrives server-enriched with its own glyph).
fn draw_overview_activity_tile(f: &mut Frame, app: &App, area: Rect, selected: bool) {
    let rows_avail = area.height.saturating_sub(2) as usize;
    let items: Vec<ListItem> = app
        .visible_fleet_activity()
        .into_iter()
        .take(rows_avail.max(1))
        .map(|a| {
            let agent = a.agent.clone().unwrap_or_default();
            let what = a.summary.clone().unwrap_or_else(|| a.kind.clone());
            ListItem::new(Line::from(vec![
                Span::styled(format!("{:<6} ", trunc(&agent, 6)), Theme::dim()),
                Span::raw(trunc(&what, 52)),
            ]))
        })
        .collect();
    let list = List::new(items).block(overview_tile_block(
        " Activity · live ".to_string(),
        selected,
    ));
    f.render_widget(list, area);
}

/// The inbox decisions tier (tier_rank 0), pot-scoped. Split out so the tile
/// and tests share one definition.
fn app_decisions(app: &App) -> Vec<&crate::models::AttentionItem> {
    app.visible_inbox()
        .into_iter()
        .filter(|i| i.tier_rank() == 0)
        .collect()
}

/// A `done/total` progress bar of `cells` single-width blocks. Pure.
pub(crate) fn progress_bar(done: u32, total: u32, cells: usize) -> String {
    let filled = if total == 0 {
        0
    } else {
        ((done as f32 / total as f32) * cells as f32).round() as usize
    };
    let mut s = String::with_capacity(cells);
    for i in 0..cells {
        s.push(if i < filled.min(cells) { '█' } else { '·' });
    }
    s
}

/// A small fixed-width mic-level meter for the voice composer line. `level` is
/// an RMS amplitude (0..~1); we map it (with a little gain, since speech RMS sits
/// low) onto a 12-cell bar. Pure — unit-tested.
fn mic_meter(level: f32) -> String {
    const CELLS: usize = 12;
    let filled = ((level * 4.0).clamp(0.0, 1.0) * CELLS as f32).round() as usize;
    let mut s = String::with_capacity(CELLS + 2);
    s.push('[');
    for i in 0..CELLS {
        s.push(if i < filled { '▮' } else { '·' });
    }
    s.push(']');
    s
}

/// Memory tab (D-006 Step 2): the backend's memories, two-pane like Inbox —
/// list (left: kind + fact) + detail (right: full text + metadata). `/` opens
/// the semantic-search composer; an active query shows its hits instead of the
/// list (Esc returns). The tab shows whatever the configured memory BACKEND
/// holds; an unavailable backend renders a clear empty state.
fn draw_memory(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(52), Constraint::Percentage(48)])
        .split(area);

    let entries = app.visible_memories();
    let title = match &app.memory_hits {
        Some((q, hits)) => format!(
            " Memory · \"{}\" ({}) · Esc: back ",
            trunc(q, 24),
            hits.len()
        ),
        None => format!(" Memory ({}) · /: search ", entries.len()),
    };
    let items: Vec<ListItem> = entries
        .iter()
        .map(|m| {
            ListItem::new(Line::from(format!(
                "{:<11} {}",
                trunc(&m.kind(), 11),
                trunc(&m.memory, 52),
            )))
        })
        .collect();
    let body = if items.is_empty() {
        let hint = if !app.memory_available {
            "(memory backend unavailable — not configured yet)"
        } else if app.memory_hits.is_some() {
            "(no hits — Esc returns to the list)"
        } else {
            "(no memories stored yet)"
        };
        vec![ListItem::new(Line::from(Span::styled(hint, Theme::dim())))]
    } else {
        items
    };
    let mut state = ListState::default();
    if !entries.is_empty() {
        state.select(Some(app.memory_sel.min(entries.len() - 1)));
    }
    let body_area = block_with_header(
        f,
        cols[0],
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(title)),
        &format!("  {:<12}{}", "kind", "fact"),
    );
    let list = List::new(body)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);

    // Detail (right): the full fact + its metadata.
    let detail = match app.selected_memory() {
        Some(m) => {
            let meta = m
                .metadata
                .as_ref()
                .map(|v| serde_json::to_string_pretty(v).unwrap_or_default())
                .unwrap_or_default();
            let score = m
                .score
                .map(|s| format!("\nscore: {s:.3}"))
                .unwrap_or_default();
            format!(
                "{}\n\nid: {}{}\n\nmetadata:\n{}",
                m.memory, m.id, score, meta
            )
        }
        None => "No memory selected.".to_string(),
    };
    f.render_widget(
        Paragraph::new(detail)
            .wrap(Wrap { trim: false })
            .block(Block::default().borders(Borders::ALL).title(" Detail ")),
        cols[1],
    );

    // The `/` search composer floats over the tab while open.
    if app.memory_search_open {
        let overlay = centered_rect(60, 18, f.area());
        f.render_widget(Clear, overlay);
        f.render_widget(
            Paragraph::new(format!("> {}", app.memory_search_input)).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(" Search memory (Enter run · Esc cancel) "),
            ),
            overlay,
        );
    }
}

/// The Cupboard tab (D-011): the marketplace listings under the active kind
/// filter + search, with a detail pane and per-kind action dispatch
/// (harness→join · blueprint→fork · snapshot→fork · plugin→install). The kind
/// filter row renders above the list; the armed confirm shows in the detail
/// title (Enter arms, `y` fires).
fn draw_cupboard(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(52), Constraint::Percentage(48)])
        .split(area);

    // Kind-filter row + search status in the list title.
    let kinds = crate::app::CUPBOARD_KINDS
        .iter()
        .enumerate()
        .map(|(i, k)| {
            if i == app.cupboard_kind {
                format!("[{k}]")
            } else {
                k.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let title = if app.cupboard_query.is_empty() {
        format!(" Cupboard · {kinds} · f:kind /:search ")
    } else {
        format!(
            " Cupboard · {kinds} · \"{}\" ({}) ",
            trunc(&app.cupboard_query, 18),
            app.cupboard.len()
        )
    };

    let items: Vec<ListItem> = app
        .cupboard
        .iter()
        .map(|l| {
            ListItem::new(Line::from(format!(
                "{:<10} {:<28} {}",
                trunc(&l.listing_kind, 10),
                trunc(l.display_name(), 28),
                trunc(l.description.as_deref().unwrap_or(""), 40),
            )))
        })
        .collect();
    let body = if items.is_empty() {
        let hint = if app.cupboard_loading {
            "(loading the Cupboard…)"
        } else if !app.cupboard_query.is_empty() {
            "(no listings match — /: edit the search, f: change kind)"
        } else {
            "(no listings — r refetches)"
        };
        vec![ListItem::new(Line::from(Span::styled(hint, Theme::dim())))]
    } else {
        items
    };
    let mut state = ListState::default();
    if !app.cupboard.is_empty() {
        state.select(Some(app.cupboard_sel.min(app.cupboard.len() - 1)));
    }
    let body_area = block_with_header(
        f,
        cols[0],
        Block::default()
            .borders(Borders::ALL)
            .title(Line::from(title)),
        &format!("  {:<11}{:<29}{}", "kind", "name", "description"),
    );
    let list = List::new(body)
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body_area, &mut state);

    // Detail (right): the selected listing + its per-kind action.
    let sel = app
        .cupboard
        .get(app.cupboard_sel.min(app.cupboard.len().saturating_sub(1)));
    let (detail, action_label) = match sel {
        Some(l) => {
            let action = match l.listing_kind.as_str() {
                "harness" => "join",
                "blueprint" => "fork (install)",
                "snapshot" => "fork",
                "plugin" => "install",
                _ => "—",
            };
            let gh = l.github_url.as_deref().unwrap_or("—");
            let by = l.publisher_github_login.as_deref().unwrap_or("—");
            let claim = l.claim_status.as_deref().unwrap_or("—");
            let pot = l.project_ref.as_deref().unwrap_or("—");
            (
                format!(
                    "{}\n\n{}\n\nkind: {}\npot: {}\ngithub: {}\npublisher: {}\nclaim: {}\n\nEnter: arm {} · y: confirm",
                    l.display_name(),
                    l.description.as_deref().unwrap_or("(no description)"),
                    l.listing_kind,
                    pot,
                    gh,
                    by,
                    claim,
                    action,
                ),
                action,
            )
        }
        None => ("No listing selected.".to_string(), "—"),
    };
    let armed = sel
        .map(|l| app.cupboard_confirm.as_deref() == Some(l.id.as_str()))
        .unwrap_or(false);
    let detail_title = if armed {
        format!(" Detail — press y to {action_label} ")
    } else {
        " Detail ".to_string()
    };
    f.render_widget(
        Paragraph::new(detail)
            .wrap(Wrap { trim: false })
            .block(Block::default().borders(Borders::ALL).title(detail_title)),
        cols[1],
    );

    // The `/` search composer floats over the tab while open (Memory's pattern).
    if app.cupboard_search_open {
        let overlay = centered_rect(60, 18, f.area());
        f.render_widget(Clear, overlay);
        f.render_widget(
            Paragraph::new(format!("> {}", app.cupboard_search_input)).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(" Search the Cupboard (Enter run · Esc cancel) "),
            ),
            overlay,
        );
    }
}

fn draw_status(f: &mut Frame, app: &App, area: Rect) {
    let (text, style) = match &app.last_error {
        Some(e) => (
            format!("{} {e}", crate::glyph::severity::WARN),
            Theme::warn(),
        ),
        // The POTS scope indicator (D-003) leads the status line.
        None => (
            format!("{} · {}", app.scope_label(), app.status),
            Theme::dim(),
        ),
    };
    f.render_widget(
        Paragraph::new(Line::from(text)).style(Theme::status_text(style)),
        area,
    );
    // The right edge carries one of two right-aligned indicators (each in its
    // own sub-rect so it never clobbers the left status text):
    //   • the companion workbench indicator (P-004) when the zellij plugin is
    //     linked ("▦ N panes", glyph::nav::PANES), else
    //   • a standing discoverability hint (D-012) so the help overlay + the
    //     re-openable tutorial stay visible regardless of how long the status
    //     hint-string is (it would otherwise clip off the right edge).
    let right = app.workbench_summary().unwrap_or_else(|| {
        // Advertise the operator dock when it's available but not yet shown, so
        // it's discoverable without opening help (operator-always-visible-2026-06-05).
        if app.tab != Tab::Operator && !app.operator_dock_open {
            "o:operator · ?:help".to_string()
        } else {
            "?:help · F1/:tutorial".to_string()
        }
    });
    let w = (right.chars().count() as u16 + 1).min(area.width);
    let sub = Rect {
        x: area.x + area.width.saturating_sub(w),
        y: area.y,
        width: w,
        height: area.height,
    };
    f.render_widget(
        Paragraph::new(Line::from(right)).style(Theme::status_bar()),
        sub,
    );
}

fn draw_help(f: &mut Frame) {
    let area = centered_rect(64, 84, f.area());
    let text = "pui — keys\n\n  1..0 / m c  switch tab (1 Operator · 4 Fleet · 5 Pots · m Memory · c Cupboard)\n  /           search (Memory · Cupboard)\n  i / Enter   compose a message (Operator tab or focused dock) · Esc cancels\n  < / >       cycle tabs   ·   Tab  Fleet mode / Pots column\n  j / k  ↑/↓  move selection / scroll chat\n  [ / ]       cycle pot   ·   P  pot selector (All Pots / one)\n  F           plans filter rail (Inbox / Fleet)\n  f Enter y   Cupboard: cycle kind · arm · confirm (join/fork/install)\n  n / Enter   launch agent pane (Fleet) / plugin pane (Plugins)\n  g           launch git (lazygit)\n  r           relaunch last-exited pane · Cupboard: refetch\n  p / N       toggle presence sidebar · notifications history\n  o / O       focus / hide the operator dock (any tab) · Esc unfocus\n  V           realtime operator voice on/off (EL Conv-AI · any tab)\n  M / A / H   realtime mute · mode toggle · force host (while live)\n  PgUp/PgDn   scroll (Docs / Operator)   ·   Esc  dismiss toast\n  F1          tutorial (also `:tutorial` in the palette)\n  :           command palette (:create · :share · :theme · dock: :stack :float :dock :layout)\n  Alt+[ / ]   cycle workbench layout preset (stacked · split · grid)\n  ?           toggle this help\n  q / Ctrl-C  quit\n\n  (press any key to close)";
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(text)
            .style(Theme::popup())
            .block(Theme::popup_block(Line::from(" Help "))),
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
            .block(Theme::popup_block(Line::from(format!(
                " {} {} · N history · Esc ",
                crate::glyph::header::BELL,
                trunc(&n.level, 12)
            )))),
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
        List::new(items)
            .style(Theme::popup())
            .block(Theme::popup_block(Line::from(format!(
                " Notifications ({}) · any key to close ",
                app.notifs.len()
            )))),
        area,
    );
}

/// The guided multi-step tutorial (P9). `step` is clamped to the last page.
fn draw_tutorial(f: &mut Frame, step: usize) {
    const STEPS: [(&str, &str); 4] = [
        (
            "Welcome to pui — the Papercusp workbench",
            "pui is your terminal HUD over the operator. Everything here is live —\n\
             it reads + reacts to the same backend the desktop app uses.\n\n\
             Tabs (press 1‑0 / m, or  <  /  >  to cycle):\n\
             \x20 Operator · Inbox · Plans · Fleet · Pots · Docs · Testing · Config · Plugins · Settings · Memory\n\
             \x20 Fleet shows every live agent + plan progress at a glance (and launches new ones).\n\n\
             Pick the pot you're working in with  [  /  ] .",
        ),
        (
            "Moving around & launching agents",
            "Move:    j / k   (or ↑ / ↓)        Scroll docs:  PgUp / PgDn\n\
             Switch a split's focus (Harnesses):  Tab\n\n\
             Launch a native agent into a pane:   n   (on the Fleet tab)\n\
             Open git for the active harness:     g   (lazygit)\n\n\
             Agents run at full fidelity in their own zellij panes — pui never\n\
             wraps or reimplements them.",
        ),
        (
            "Your workbench is zellij",
            "pui is one pane — the HUD. Your agents live in the WORK AREA beside\n\
             it, and that whole window is a zellij session. These keys drive the\n\
             layer pui doesn't:\n\n\
             Move focus:   Alt + ← ↓ ↑ →   (or Alt + h j k l)\n\
             Layouts:      Alt + [  /  Alt + ]   (stacked · split · grid)\n\
             Back to HUD:  Alt-move toward the pui pane\n\n\
             Command bar ( : ):  :stack · :float · :dock <side> · :layout next|prev\n\
             New agents ( n ) stack tab-like; when one exits,  r  relaunches it.",
        ),
        (
            "Staying in the loop",
            "Presence:      p   toggles the who's‑online sidebar (right)\n\
             Notifications: muted by default — the Inbox badge + N history\n\
             \x20              keep you posted (PUI_NOTIFY=1 re-enables pops).\n\
             Command bar:   :        Full keymap:  ?        Quit:  q\n\n\
             You can re‑open this guide any time with  F1 .\n\n\
             That's it — press any key to start.",
        ),
    ];
    let i = step.min(STEPS.len() - 1);
    let (title, body) = STEPS[i];
    let area = centered_rect(72, 70, f.area());
    let footer = format!(
        "\n\n— step {}/{} · any key {}  ·  Esc skips —",
        i + 1,
        STEPS.len(),
        crate::glyph::nav::CURSOR
    );
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(format!("{body}{footer}"))
            .wrap(Wrap { trim: false })
            .style(Theme::popup())
            .block(Theme::popup_block(Line::from(format!(" {title} ")))),
        area,
    );
}

/// The pot-selector overlay (D-003): "All Pots" + each pot. The current choice
/// carries a filled marker; Enter applies, Esc closes.
fn draw_pot_picker(f: &mut Frame, app: &App) {
    let area = centered_rect(50, 60, f.area());
    let mut items: Vec<ListItem> = Vec::with_capacity(app.harnesses.len() + 1);
    let all_marker = if app.all_pots {
        crate::glyph::toggle::ON
    } else {
        crate::glyph::toggle::OFF
    };
    items.push(ListItem::new(Line::from(format!("{all_marker} All Pots"))));
    for h in &app.harnesses {
        let marker = if !app.all_pots && h.slug == app.harness {
            crate::glyph::toggle::ON
        } else {
            crate::glyph::toggle::OFF
        };
        items.push(ListItem::new(Line::from(format!("{marker} {}", h.slug))));
    }
    let mut state = ListState::default();
    state.select(Some(app.pot_picker_sel.min(app.harnesses.len())));
    let list = List::new(items)
        .style(Theme::popup())
        .block(Theme::popup_block(Line::from(
            " Pot — Enter select · Esc close ",
        )))
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_widget(Clear, area);
    f.render_stateful_widget(list, area, &mut state);
}

/// The Fleet `[r]/[n]/[f]` no-session action menu (pui-workbench-usability
/// D-002). Surfaced when Enter on a roster agent finds no single reachable
/// session, so Enter never silently focuses empty space. Only the viable choices
/// render; `[n] launch` is always offered.
fn draw_fleet_menu(f: &mut Frame, menu: &crate::app::FleetActionMenu) {
    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled(menu.note.clone(), Theme::dim())),
        Line::from(""),
    ];
    if menu.can_resume {
        lines.push(Line::from(vec![
            Span::styled("[r]", Theme::title_active()),
            Span::raw(" resume the ended session"),
        ]));
    }
    lines.push(Line::from(vec![
        Span::styled("[n]", Theme::title_active()),
        Span::raw(" launch a new agent here"),
    ]));
    if menu.can_focus_window {
        lines.push(Line::from(vec![
            Span::styled("[f]", Theme::title_active()),
            Span::raw(" focus its terminal window"),
        ]));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled("Esc to cancel", Theme::dim())));

    // Height: note + blank + the rendered choices + blank + esc, +2 for borders.
    let h = (lines.len() as u16 + 2).min(f.area().height);
    let full = f.area();
    let w = (full.width as u32 * 56 / 100).clamp(36, 72) as u16;
    let area = Rect {
        x: full.x + (full.width.saturating_sub(w)) / 2,
        y: full.y + (full.height.saturating_sub(h)) / 2,
        width: w.max(1),
        height: h,
    };
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .style(Theme::popup())
            .block(Theme::popup_block(Line::from(format!(
                " {} · reach agent ",
                trunc(&menu.label, 28)
            )))),
        area,
    );
}

/// The staged-wake review overlay (hive-agent-tabs P-009 / D-005): a manual-mode
/// agent's pending wakes, oldest-first, with per-wake release / edit & release /
/// skip. The edit layer swaps the footer for a live input line.
fn draw_wake_review(f: &mut Frame, rev: &crate::app::WakeReview) {
    let mut lines: Vec<Line> = Vec::new();
    if rev.loading {
        lines.push(Line::from(Span::styled(
            "(loading staged wakes…)",
            Theme::dim(),
        )));
    } else if let Some(err) = &rev.error {
        lines.push(Line::from(Span::styled(
            format!("error: {err}"),
            Theme::danger(),
        )));
        lines.push(Line::from(""));
    }
    if !rev.loading && rev.pending.is_empty() {
        lines.push(Line::from(Span::styled(
            "(no staged wakes — incoming wakes stage here while the agent is in manual mode)",
            Theme::dim(),
        )));
    }
    for (i, pw) in rev.pending.iter().enumerate() {
        let marker = if i == rev.sel { "> " } else { "  " };
        let summary = pw.summary.clone().unwrap_or_else(|| "(no summary)".into());
        let src = pw.source.clone().unwrap_or_default();
        let mut spans = vec![
            Span::raw(marker.to_string()),
            Span::styled(format!("#{} ", pw.id), Theme::dim()),
            Span::raw(trunc(&summary, 48).to_string()),
        ];
        if !src.is_empty() {
            spans.push(Span::styled(
                format!("  · {}", trunc(&src, 16)),
                Theme::dim(),
            ));
        }
        let line = Line::from(spans);
        lines.push(if i == rev.sel {
            line.style(Theme::selected())
        } else {
            line
        });
    }
    lines.push(Line::from(""));
    if let Some(buf) = &rev.edit {
        // Edit layer: the input line + its own footer.
        lines.push(Line::from(vec![
            Span::styled("edit: ", Theme::title_active()),
            Span::raw(buf.clone()),
            Span::styled("▌", Theme::dim()),
        ]));
        lines.push(Line::from(Span::styled(
            "Enter release edited · Esc cancel edit",
            Theme::dim(),
        )));
    } else {
        let busy = if rev.busy { " · working…" } else { "" };
        lines.push(Line::from(Span::styled(
            format!("r/Enter release · e edit & release · s skip · j/k select · Esc close{busy}"),
            Theme::dim(),
        )));
    }

    let h = (lines.len() as u16 + 2).min(f.area().height);
    let full = f.area();
    let w = (full.width as u32 * 64 / 100).clamp(44, 84) as u16;
    let area = Rect {
        x: full.x + (full.width.saturating_sub(w)) / 2,
        y: full.y + (full.height.saturating_sub(h)) / 2,
        width: w.max(1),
        height: h,
    };
    f.render_widget(Clear, area);
    f.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .style(Theme::popup())
            .block(Theme::popup_block(Line::from(format!(
                " {} · staged wakes ({}) ",
                trunc(&rev.label, 24),
                rev.pending.len()
            )))),
        area,
    );
}

fn draw_palette(f: &mut Frame, app: &App) {
    // A fixed-height box (input + the command/dock-verb hints), centered — a
    // percentage height would over-grow on tall terminals and still clip on
    // short ones. Width tracks the terminal; height is constant.
    let full = f.area();
    let h = 9u16.min(full.height);
    let w = (full.width as u32 * 70 / 100) as u16;
    let area = Rect {
        x: full.x + (full.width.saturating_sub(w)) / 2,
        y: full.y + (full.height.saturating_sub(h)) / 2,
        width: w.max(1),
        height: h,
    };
    f.render_widget(Clear, area);
    // The active swap-layout preset (Brief 50 / D-008) rides the companion
    // topology; absent a companion link we just show the cycle from the KDL.
    let active_preset = app
        .topology
        .as_ref()
        .and_then(|t| t.tabs.iter().find(|x| x.active))
        .and_then(|x| x.swap_layout.clone());
    let presets = crate::layout::SWAP_PRESETS.join(" · ");
    let layout_line = match active_preset {
        Some(p) => format!("Layout [{p}] of {presets}  (Alt+[ / ] or :layout next|prev|<name>)"),
        None => format!("Layout presets: {presets}  (Alt+[ / ] or :layout next|prev|<name>)"),
    };
    // Input on the first line; the command + dock-verb hints wrap below so they
    // stay visible (a single long block title would truncate them off, D-008).
    let body = Text::from(vec![
        Line::from(Span::styled(format!("> {}", app.palette_input), Theme::input())),
        Line::from(""),
        Line::from(Span::styled(
            "tutorial · layouts · crews · save/restore-crew|layout · create <slug> <path|gh-url> · share <slug> [public] · theme <name> · themes",
            Theme::dim(),
        )),
        Line::from(Span::styled(
            "dock — :stack · :float [pane] · :dock left|right",
            Theme::dim(),
        )),
        Line::from(Span::styled(layout_line, Theme::dim())),
    ]);
    f.render_widget(
        Paragraph::new(body)
            .wrap(Wrap { trim: true })
            .block(Theme::popup_block(Line::from(" Command (Esc closes) "))),
        area,
    );
}

/// Render `block` over `area`, paint a styled column-header line at the top of
/// its inner area (D-005 — the PUI's lists bake column labels into row format
/// strings, so the header is an explicit extra line), and return the remaining
/// rect for the list body. Callers render their `List` WITHOUT a block into
/// the returned rect. Headers start with two spaces to stay aligned with the
/// "> " highlight-symbol indent of stateful lists.
pub(crate) fn block_with_header(f: &mut Frame, area: Rect, block: Block, header: &str) -> Rect {
    block_with_header_rows(
        f,
        area,
        block,
        vec![Line::from(Span::styled(
            header.to_string(),
            Theme::header(),
        ))],
    )
}

/// `block_with_header` for N pre-styled header lines (e.g. the colony roster's
/// kind legend above its column header). Same contract: callers render their
/// list WITHOUT a block into the returned rect.
pub(crate) fn block_with_header_rows(
    f: &mut Frame,
    area: Rect,
    block: Block,
    rows_above: Vec<Line<'static>>,
) -> Rect {
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.height == 0 {
        return inner;
    }
    let n = rows_above.len() as u16;
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(n), Constraint::Min(0)])
        .split(inner);
    f.render_widget(Paragraph::new(rows_above), rows[0]);
    rows[1]
}

/// The Fleet comms detail popup (owner ask 2026-06-14): the full mail message or
/// conversation thread under the comms cursor, centered over the dock. Modal —
/// the key handler closes it on Esc/`q`/Enter and steps the item with `j`/`k`.
fn draw_fleet_detail(f: &mut Frame, app: &App) {
    let area = centered_rect(70, 70, f.area());
    f.render_widget(Clear, area);
    let (title, lines): (&str, Vec<Line<'static>>) = fleet_detail_content(app);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(title)
        .style(Theme::panel_active());
    let inner = block.inner(area);
    f.render_widget(block, area);
    // Clamp the scroll offset to the wrapped content so PageDown can't run past
    // the end (owner ask 2026-06-14). Wrapped-row estimate: each logical line
    // occupies ceil(display_width / inner_width) rows.
    let inner_w = inner.width.max(1) as u32;
    let total_rows: u32 = lines
        .iter()
        .map(|l| (l.width() as u32).div_ceil(inner_w).max(1))
        .sum();
    let max_scroll = (total_rows.min(u32::from(u16::MAX)) as u16).saturating_sub(inner.height);
    let scroll = app.fleet_detail_scroll.min(max_scroll);
    f.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((scroll, 0)),
        inner,
    );
}

/// The title + body for the detail popup. The Plans tab shows the selected
/// plan's full detail (owner ask 2026-06-15 #1 — the same rich body as the Fleet
/// plan-progress popup); otherwise the focused Fleet panel decides (mail /
/// conversation / plan).
fn fleet_detail_content(app: &App) -> (&'static str, Vec<Line<'static>>) {
    use crate::app::PlansFocus;
    use crate::fleet::FleetPanel;
    // Both Plans surfaces (in-app tab + dock plans-pane) reuse this popup. The
    // focused pane decides the body: the LIST pane → the selected plan's full
    // detail (owner ask 2026-06-15 #1); the ITEMS pane → the selected work item's
    // detail (owner ask 2026-06-16).
    if matches!(
        app.tab,
        crate::app::Tab::Plans | crate::app::Tab::PlansBoard
    ) {
        if app.plans_focus == PlansFocus::Items {
            let lines = match app.selected_plan_item() {
                Some(it) => crate::plans_board::item_detail_lines(it),
                None => vec![Line::from(Span::styled(
                    "(no work item selected)",
                    Theme::dim(),
                ))],
            };
            return (" work item · Esc close · j/k item · PgUp/Dn scroll ", lines);
        }
        let selected_plan = if app.tab == crate::app::Tab::PlansBoard {
            let rows = crate::plans_board::board_rows(app);
            rows.get(app.plans_board_sel.min(rows.len().saturating_sub(1)))
                .map(|r| crate::fleet::plan_detail_lines_for(r.plan))
        } else {
            app.selected_plan().map(crate::fleet::plan_detail_lines_for)
        };
        let lines = selected_plan
            .unwrap_or_else(|| vec![Line::from(Span::styled("(no plan selected)", Theme::dim()))]);
        return (" plan · Esc close · j/k plan · PgUp/Dn scroll ", lines);
    }
    match app.fleet.fleet_focus {
        FleetPanel::Inbox | FleetPanel::Outbox => {
            let is_inbox = app.fleet.fleet_focus == FleetPanel::Inbox;
            let title = if is_inbox {
                " inbox · Esc close · j/k item · PgUp/Dn scroll "
            } else {
                " outbox · Esc close · j/k item · PgUp/Dn scroll "
            };
            let lines = match app.selected_comms_mail() {
                Some(e) => mail_detail_lines(e, is_inbox),
                None => vec![Line::from(Span::styled(
                    "(no message selected)",
                    Theme::dim(),
                ))],
            };
            (title, lines)
        }
        FleetPanel::Conversations => (
            " conversation · Esc close · j/k item · PgUp/Dn scroll ",
            conv_detail_lines(app),
        ),
        FleetPanel::PlanProgress => (
            " plan · Esc close · j/k plan · PgUp/Dn scroll ",
            crate::fleet::plan_detail_lines(app),
        ),
        // Dossier (worklist): the selected work item's detail (owner ask 2026-06-16).
        FleetPanel::Dossier => (
            " work item · Esc close · j/k item · PgUp/Dn scroll ",
            crate::fleet::dossier_detail_lines(app),
        ),
        FleetPanel::Roster => (" detail ", Vec::new()),
    }
}

/// The header + full body of one coord-mail entry (the list truncates the body;
/// the popup shows all of it).
fn mail_detail_lines(e: &crate::models::BeeMailEntry, is_inbox: bool) -> Vec<Line<'static>> {
    let (peer_label, peer) = if is_inbox {
        ("from", e.from.clone().unwrap_or_else(|| "?".into()))
    } else if e.to.iter().any(|t| t == "*") {
        ("to", "* (broadcast)".to_string())
    } else {
        ("to", e.to.join(", "))
    };
    let body = e
        .body
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| e.summary.clone())
        .unwrap_or_else(|| "(no body)".to_string());
    let mut out = vec![
        Line::from(vec![
            Span::styled(format!("{peer_label:<5} "), Theme::dim()),
            Span::raw(peer),
        ]),
        Line::from(vec![
            Span::styled("time  ", Theme::dim()),
            Span::raw(e.ts.clone()),
            Span::styled("   kind  ", Theme::dim()),
            Span::raw(e.kind.clone()),
        ]),
        Line::from(Span::styled("─".repeat(40), Theme::dim())),
    ];
    for l in body.lines() {
        out.push(Line::from(l.to_string()));
    }
    out
}

/// The loaded conversation thread (header + body + accepted answer + posts), or a
/// loading placeholder while the fetch is in flight.
fn conv_detail_lines(app: &App) -> Vec<Line<'static>> {
    let Some(d) = app.conversation_detail.as_ref() else {
        return vec![Line::from(Span::styled("loading…", Theme::dim()))];
    };
    let mut out = Vec::new();
    if let Some(c) = &d.conversation {
        out.push(Line::from(Span::styled(
            c.title.clone().unwrap_or_else(|| c.id.clone()),
            Theme::title_active(),
        )));
        out.push(Line::from(vec![
            Span::styled("state ", Theme::dim()),
            Span::raw(c.state.clone()),
            Span::styled("   asker ", Theme::dim()),
            Span::raw(c.asker_id.clone()),
        ]));
        if !c.body.is_empty() {
            out.push(Line::from(""));
            for l in c.body.lines() {
                out.push(Line::from(l.to_string()));
            }
        }
        if let Some(ans) = &c.accepted_answer {
            out.push(Line::from(""));
            out.push(Line::from(Span::styled("✓ accepted answer", Theme::info())));
            for l in ans.lines() {
                out.push(Line::from(l.to_string()));
            }
        }
    }
    if !d.posts.is_empty() {
        out.push(Line::from(""));
        out.push(Line::from(Span::styled(
            format!("─ {} posts ─", d.posts.len()),
            Theme::dim(),
        )));
        for p in &d.posts {
            let who = p.author_id.clone().unwrap_or_else(|| "?".into());
            let first = p.body.lines().next().unwrap_or("").to_string();
            out.push(Line::from(vec![
                Span::styled(format!("{} ", trunc(&who, 12)), Theme::dim()),
                Span::raw(first),
            ]));
        }
    }
    out
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
    fn plans_tab_plan_detail_popup_renders() {
        // Owner ask 2026-06-15 #1: the Plans tab's Enter→popup renders the
        // selected plan's full detail via the shared `draw` path.
        let mut app = App::new();
        app.tab = Tab::Plans;
        let mut p = plan("plan-popup-demo", "active");
        p.item_counts = crate::models::ItemCounts {
            todo: 2,
            wip: 1,
            done: 4,
            ..Default::default()
        };
        app.set_plans(vec![p]);
        app.fleet_detail_open = true;
        let text = render(&app, 120, 30);
        assert!(text.contains("Esc close"), "popup title missing: {text}");
        assert!(
            text.contains("plan-popup-demo"),
            "plan slug missing from popup"
        );
        assert!(text.contains("progress"), "progress row missing from popup");
        assert!(
            text.contains("remaining"),
            "remaining count missing from popup"
        );
    }

    #[test]
    fn fleet_plan_detail_popup_renders_selected_plan() {
        // Owner ask 2026-06-15: the plan-progress panel's Enter opens a detail
        // popup. Verify the popup chrome + plan_detail_lines render together via
        // the real `draw` path (not just the pure line builder).
        use crate::fleet::FleetPanel;
        let mut app = App::new();
        app.tab = Tab::Fleet;
        let mut p = plan("plan-detail-demo", "active");
        p.item_counts = crate::models::ItemCounts {
            todo: 4,
            wip: 1,
            done: 3,
            ..Default::default()
        };
        app.set_plans(vec![p]);
        app.fleet.fleet_focus = FleetPanel::PlanProgress;
        app.fleet_detail_open = true;
        let text = render(&app, 120, 30);
        assert!(text.contains("Esc close"), "popup title missing: {text}");
        assert!(
            text.contains("plan-detail-demo"),
            "plan slug missing from popup"
        );
        assert!(text.contains("progress"), "progress row missing from popup");
        assert!(
            text.contains("remaining"),
            "remaining count missing from popup"
        );
    }

    // --- Overview dashboard (Brief 23, overview-dashboard-2026-06-05) ---

    fn overview_attention(id: &str, tier: &str) -> crate::models::AttentionItem {
        crate::models::AttentionItem {
            id: id.into(),
            kind: "plan-item".into(),
            source: "plan".into(),
            harness_slug: Some("papercup".into()),
            plan_slug: Some("overview-dashboard".into()),
            item_ref: Some("P-001".into()),
            title: format!("decide {id}"),
            body: None,
            status: "todo".into(),
            importance: None,
            needs_human: tier == "decision",
            tier: Some(tier.into()),
            owner_agent_id: None,
            owner_label: None,
            triage_state: None,
            triage_note: None,
            report: None,
        }
    }

    #[test]
    fn overview_renders_topbar_tiles_and_operator_strip() {
        use crate::models::{ActivityRow, ItemCounts};
        let mut app = App::new();
        assert_eq!(app.tab, Tab::Overview); // the default landing surface (D-001)
        let mut p = plan("overview-dashboard", "active");
        p.item_counts = ItemCounts {
            todo: 1,
            wip: 1,
            done: 2,
            ..Default::default()
        };
        app.set_plans(vec![p, plan("shipped-one", "shipped")]);
        app.set_inbox(vec![
            overview_attention("d1", "decision"),
            overview_attention("a1", "alert"),
            overview_attention("ac1", "activity"),
        ]);
        app.set_roster(vec![presence_entry("claude", "building the overview")]);
        app.fleet.activity.push(ActivityRow {
            id: "1".into(),
            owner_id: "su-1".into(),
            agent: Some("claude".into()),
            harness_slug: Some("papercup".into()),
            kind: "tool".into(),
            tool_name: None,
            summary: Some("✎ edited ui.rs".into()),
            status: None,
            detail: None,
            created_at: "2026-06-05".into(),
        });

        let text = render(&app, 120, 32);
        // Top bar: no fleet_rate seeded here → the connecting slots render
        // (the LIVE branch is covered by overview_topbar_renders_live_fleet_rate)
        // + the LIVE alert-tier count.
        assert!(text.contains("usage"), "topbar usage slot missing");
        assert!(text.contains("agents"), "topbar agents slot missing");
        assert!(
            text.contains("connecting"),
            "pre-fetch topbar state missing"
        );
        assert!(text.contains("1 alerts"), "alert count missing");
        // Plans tile: shipped plans excluded; progress off item_counts (2 done
        // of 4 active — dropped/unknown excluded from the denominator).
        assert!(
            text.contains("Plans (1)"),
            "plans tile header wrong: {text:?}"
        );
        assert!(text.contains("Title overview-dashboard"));
        assert!(text.contains("2/4"), "plan progress fraction missing");
        // Needs-you tile: ONLY the decision tier (alert/activity stay out).
        assert!(
            text.contains("Needs you (1)"),
            "needs-you should count decisions only"
        );
        assert!(text.contains("decide d1"));
        assert!(
            !text.contains("decide ac1"),
            "activity-tier item leaked into needs-you"
        );
        // Agents tile: live roster + what each is doing.
        assert!(text.contains("Agents (1 live)"));
        assert!(text.contains("building the overview"));
        // Activity tile: server-enriched summary rows.
        assert!(text.contains("edited ui.rs"));
        // Operator strip at the bottom (Brief 24's render-only dock, D-008).
        assert!(
            text.contains("press i to talk to the operator"),
            "operator strip missing"
        );
    }

    #[test]
    fn overview_narrow_stack_and_short_terminal_drop_strip() {
        let mut app = App::new();
        app.set_plans(vec![plan("p1", "active")]);
        // Narrow (80 cols): the 1×4 stack still renders every tile.
        let narrow = render(&app, 80, 30);
        assert!(narrow.contains("Plans"));
        assert!(narrow.contains("Needs you"));
        assert!(narrow.contains("Agents"));
        assert!(narrow.contains("Activity"));
        // Short terminal (<24 body rows): the operator strip yields to the
        // tiles; the operator stays reachable via the tab / `o` dock.
        let short = render(&app, 120, 18);
        assert!(short.contains("Plans"));
        assert!(!short.contains("press i to talk to the operator"));
    }

    #[test]
    fn overview_topbar_renders_live_fleet_rate() {
        use crate::models::{FleetRateFleet, FleetRateStatus, FleetRateUsageBucket};
        let mut app = App::new();
        // Before the read-model lands: dashes + the connecting hint.
        let connecting = render(&app, 120, 30);
        assert!(connecting.contains("connecting"));
        // Live: usage% (worst known bucket) + spend + in/eff/max + edit hint.
        let mut s = FleetRateStatus::default();
        s.config.max_simultaneous_agents = 6;
        s.fleet = FleetRateFleet {
            cap: 6,
            in_flight: 3,
            effective: 4,
            floor: 1,
        };
        s.usage.spend_usd = 1.23;
        s.usage.buckets.push(FleetRateUsageBucket {
            key: "a".into(),
            usage_pct: Some(42.0),
        });
        app.fleet_rate = Some(s);
        let text = render(&app, 120, 30);
        assert!(text.contains("42%"), "headline usage missing");
        assert!(text.contains("$1.23"), "spend missing");
        assert!(text.contains("3 / eff 4 / 6"), "in/eff/max missing");
        assert!(text.contains("+/- max"), "edit hint missing");
        assert!(!text.contains("connecting"));
    }

    #[test]
    fn overview_progress_bar_is_pure_and_clamped() {
        assert_eq!(progress_bar(0, 0, 10), "··········");
        assert_eq!(progress_bar(1, 2, 10), "█████·····");
        assert_eq!(progress_bar(2, 2, 10), "██████████");
        assert_eq!(progress_bar(5, 2, 10), "██████████"); // over-done clamps
    }

    #[test]
    fn mic_meter_scales_and_is_fixed_width() {
        // 12 cells + 2 brackets = 14 chars, always.
        assert_eq!(mic_meter(0.0).chars().count(), 14);
        assert_eq!(mic_meter(5.0).chars().count(), 14);
        assert_eq!(mic_meter(0.0), "[············]");
        // Full scale at level 0.25 (the 4× gain ceiling).
        assert_eq!(mic_meter(0.25), "[▮▮▮▮▮▮▮▮▮▮▮▮]");
        assert!(mic_meter(0.05).contains('▮')); // quiet speech still registers
        assert!(mic_meter(0.05).contains('·'));
    }

    #[test]
    fn voice_recording_shows_meter_in_composer() {
        use crate::app::VoicePhase;
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.voice_phase = VoicePhase::Recording;
        app.voice_level = 0.2;
        let text = render(&app, 90, 16);
        assert!(text.contains("REC"), "recording badge missing: {text:?}");
        assert!(text.contains('▮'), "mic meter missing");
    }

    #[test]
    fn voice_idle_hint_mentions_v_to_speak() {
        let mut app = App::new();
        app.tab = Tab::Operator;
        // Idle hint advertises BOTH voice modes (PTT + the realtime session,
        // voice-realtime-tui-2026-06-05).
        let text = render(&app, 90, 16);
        assert!(text.contains("v PTT"));
        assert!(text.contains("V realtime voice"));
    }

    #[test]
    fn convai_live_composer_shows_realtime_badge() {
        // The realtime session replaces the composer with its status line
        // (voice-realtime-tui-2026-06-05 P-007).
        use crate::app::ConvAiPhase;
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.convai_phase = ConvAiPhase::Live;
        let text = render(&app, 140, 16);
        assert!(text.contains("● voice"), "live badge missing");
        assert!(text.contains("V stops"), "stop hint missing");
        app.convai_phase = ConvAiPhase::Connecting;
        assert!(
            render(&app, 100, 16).contains("◐ voice…"),
            "connecting badge missing"
        );
    }

    #[test]
    fn voice_speaking_phase_badge_renders() {
        use crate::app::VoicePhase;
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.voice_phase = VoicePhase::Speaking;
        assert!(render(&app, 90, 16).contains("speaking"));
    }

    #[test]
    fn plans_view_renders_list_and_detail() {
        let mut app = App::new();
        app.tab = Tab::Plans; // the default landing tab is now Operator
        app.set_plans(vec![
            plan("alpha-2026", "todo"),
            plan("beta-2026", "shipped"),
        ]);
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
                PaneNode {
                    id: 1,
                    tab: 0,
                    title: "claude".into(),
                    focused: true,
                    is_plugin: false,
                    exited: false,
                    command: None,
                },
                PaneNode {
                    id: 2,
                    tab: 0,
                    title: "pui".into(),
                    focused: false,
                    is_plugin: false,
                    exited: false,
                    command: None,
                },
            ],
        });
        let text = render(&app, 90, 12);
        assert!(text.contains(crate::glyph::nav::PANES));
        assert!(text.contains("2 panes"));
    }

    #[test]
    fn brew_view_renders_roster_and_dossier() {
        // The Sessions roster + dossier folded into Fleet (D-002b): the Fleet
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
            ..Default::default()
        }]);
        // Default (no selection): the whole-fleet task list leads (#2).
        let text = render(&app, 120, 40);
        assert!(text.contains("Fleet")); // headline
        assert!(text.contains("Agents (1)"));
        assert!(text.contains("claude"));
        assert!(text.contains("fleet task list"));
        // Selecting a bee swaps in ITS dossier (the bee tasklist).
        app.bee
            .set_selection(Some("su-1".into()), Some("claude".into()));
        app.bee.set_dossier(
            "su-1",
            Some(crate::models::BeeAssignment {
                agent_id: "su-1".into(),
                intent: "porting handlers".into(),
                load: 1,
                queued: vec![crate::models::BeeWorkItem {
                    id: "WI-1".into(),
                    title: "port the handler".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            None,
        );
        let text = render(&app, 120, 40);
        assert!(text.contains("task list (1 claimed)"));
        assert!(text.contains("port the handler"));
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
            tier: Some("decision".into()),
            owner_agent_id: None,
            owner_label: None,
            triage_state: None,
            triage_note: None,
            report: None,
        }]);
        let text = render(&app, 100, 28);
        assert!(text.contains("Inbox"));
        assert!(text.contains("◆1")); // title headlines the Decisions count
        assert!(text.contains("Decisions (1)")); // the Decisions tier section header
        assert!(text.contains("needs-human"));
        assert!(text.contains("my-plan/P-002"));
        assert!(text.contains("coord-escalation")); // preview
        assert!(text.contains("Details of the escalation")); // body in preview
        assert!(text.contains("tier:")); // preview shows the tier line
    }

    #[test]
    fn inbox_renders_four_tier_sections() {
        // inbox-tiering D-006: items group into Decisions ▸ Handled ▸ Alerts ▸
        // Activity sections, each with a header + count.
        use crate::models::AttentionItem;
        let mk = |id: &str, tier: &str, needs_human: bool| AttentionItem {
            id: id.into(),
            kind: "coord-message".into(),
            source: "coord".into(),
            harness_slug: Some("papercup".into()),
            plan_slug: None,
            item_ref: None,
            title: format!("item {id}"),
            body: None,
            status: "message".into(),
            importance: None,
            needs_human,
            tier: Some(tier.into()),
            owner_agent_id: Some("su-worker".into()),
            owner_label: Some("worker".into()),
            triage_state: if tier == "handled" {
                Some("downgraded".into())
            } else {
                None
            },
            triage_note: if tier == "handled" {
                Some("auto lifecycle, not a decision".into())
            } else {
                None
            },
            report: None,
        };
        let mut app = App::new();
        app.tab = Tab::Inbox;
        app.set_inbox(vec![
            mk("d1", "decision", true),
            mk("h1", "handled", false),
            mk("a1", "alert", false),
            mk("v1", "activity", false),
            mk("v2", "activity", false),
        ]);
        let text = render(&app, 110, 30);
        // All four tier sections render with their counts.
        assert!(text.contains("Decisions (1)"));
        assert!(text.contains("Handled by operator (1)"));
        assert!(text.contains("Alerts (1)"));
        assert!(text.contains("Activity (2)"));
        // The title headlines the Decisions count.
        assert!(text.contains("Inbox ◆1"));
    }

    fn presence_entry(agent: &str, intent: &str) -> RosterEntry {
        RosterEntry {
            owner_id: "su-1".into(),
            label: "su · su-1".into(),
            intent: if intent.is_empty() {
                None
            } else {
                Some(intent.into())
            },
            current_files: vec![],
            liveness: "live".into(),
            stale: false,
            agent: Some(agent.into()),
            role: Some("worker".into()),
            feature: None,
            current_plan_slug: None,
            heartbeat_at: None,
            ..Default::default()
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
        assert!(text.contains("Papercup")); // classic operator label (restore-pot-lexicon D-006)
        assert!(text.contains("Inbox"));
        assert!(text.contains("Plans"));
    }

    /// Hive lexicon (pui-hive-lexicon-2026-06-06): with the-hive active the tab
    /// strip shows the bee labels (Operator→Queen, Fleet→Swarm, Pots→Hives,
    /// Cupboard→Comb); other tabs (Inbox/Plans/…) are unchanged.
    #[test]
    fn tab_strip_uses_the_hive_lexicon_when_active() {
        use crate::models::{LexiconPackPayload, TermForms};
        use std::collections::HashMap;
        let mut terms = HashMap::new();
        for (k, one, other) in [
            ("operator", "Queen", "Queens"),
            ("fleet", "Swarm", "Swarms"),
            ("pot", "Hive", "Hives"),
            ("cupboard", "Comb", "Combs"),
        ] {
            terms.insert(
                k.to_string(),
                TermForms {
                    one: one.into(),
                    other: other.into(),
                },
            );
        }
        let mut app = App::new();
        app.lexicon = crate::lexicon::Lexicon::from_payload(&LexiconPackPayload {
            pack_id: "the-hive".into(),
            label: "The Hive".into(),
            terms,
        });
        // Wide enough that the Tabs widget doesn't truncate the renamed tabs.
        let text = render(&app, 200, 8);
        assert!(text.contains("Queen"), "Operator→Queen");
        assert!(text.contains("Swarm"), "Fleet→Swarm");
        assert!(text.contains("Hives"), "Pots→Hives");
        assert!(text.contains("Comb"), "Cupboard→Comb");
        // A tab with no lexicon term keeps its classic title.
        assert!(text.contains("Inbox"));
        assert!(text.contains("Plans"));
    }

    /// Flag-off / unreachable operator: the tab strip shows today's classic
    /// labels (the default empty lexicon falls back to CLASSIC).
    #[test]
    fn tab_strip_uses_classic_labels_by_default() {
        let app = App::new(); // empty lexicon = classic fallback
        let text = render(&app, 200, 8);
        assert!(text.contains("Papercup")); // classic operator label (restore-pot-lexicon D-006)
        assert!(text.contains("Fleet"));
        assert!(text.contains("Pots"));
        assert!(text.contains("Cupboard"));
        // The bee labels must NOT appear with the flag off.
        assert!(!text.contains("Queen"));
        assert!(!text.contains("Swarm"));
    }

    /// Brief 27 / P-010: buffer-level width safety for the Plans tab. Renders
    /// a plan list whose items cover every disposition glyph at 80 and 120
    /// cols; asserts no double-width symbol leaks into the frame (only
    /// `glyph::header::SET` may be wide) and the item-id column stays aligned
    /// across rows (a wide disposition glyph would shift it).
    #[test]
    fn plans_render_width_safe_and_aligned_at_80_and_120() {
        use crate::models::{PlanItemState, PlanItemStates};
        use unicode_width::UnicodeWidthStr;

        let mut app = App::new();
        app.tab = Tab::Plans;
        app.set_plans(vec![plan("my-plan", "wip")]);
        let item = |id: &str, disp: &str| PlanItemState {
            item_id: id.into(),
            disposition: disp.into(),
            assignee_name: Some("builder-1".into()),
            ..Default::default()
        };
        app.set_plan_item_states(PlanItemStates {
            harness: "papercup".into(),
            plan: "my-plan".into(),
            harness_liveness_mode: "activity".into(),
            items: vec![
                item("P-001", "pooled"),
                item("P-002", "active"),
                item("P-003", "assigned-idle"),
                item("P-004", "claimed-pooled"),
                item("P-005", "claimed-mismatch"),
            ],
        });

        for &(w, h) in &[(80u16, 24u16), (120, 24)] {
            let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
            term.draw(|f| draw(f, &app)).unwrap();
            let buf = term.backend().buffer().clone();
            let mut rows: Vec<String> = Vec::with_capacity(h as usize);
            for y in 0..h {
                let mut row = String::with_capacity(w as usize);
                for x in 0..w {
                    let sym = buf.cell((x, y)).unwrap().symbol();
                    if UnicodeWidthStr::width(sym) > 1 {
                        assert!(
                            crate::glyph::header::SET.contains(&sym),
                            "width-2 symbol {sym:?} leaked into the Plans frame \
                             at ({x},{y}) width {w}"
                        );
                    }
                    row.push_str(sym);
                }
                rows.push(row);
            }
            let cols: Vec<usize> = rows.iter().filter_map(|r| r.find("P-00")).collect();
            assert!(
                cols.len() >= 5,
                "expected 5 item rows at width {w}, got {cols:?}"
            );
            assert!(
                cols.windows(2).all(|p| p[0] == p[1]),
                "item-id column drifted at width {w}: {cols:?}"
            );
        }
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
        app.set_flags(crate::models::FlagsResponse {
            flags: m,
            source: "defaults".into(),
        });
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
        app.notify_enabled = true; // the transient toast only pops when enabled
        app.unseen_notifs = 2;
        app.toast = Some(ui_notif("high", "Decide P-002", None));
        let text = render(&app, 90, 12);
        assert!(text.contains("Inbox (2)")); // badge on the tab strip
        assert!(text.contains("🔔")); // toast box title
        assert!(text.contains("Decide P-002")); // toast message
    }

    #[test]
    fn muted_by_default_suppresses_toast_but_keeps_badge() {
        // notify_enabled defaults to false (owner ask 2026-06-14): the transient
        // toast must not render, but the Inbox badge — a separate surface — stays.
        let mut app = App::new();
        app.unseen_notifs = 2;
        app.toast = Some(ui_notif("high", "Decide P-002", None));
        let text = render(&app, 90, 12);
        assert!(text.contains("Inbox (2)")); // badge unaffected by the mute
        assert!(!text.contains("Decide P-002")); // toast suppressed
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
    fn notifs_history_renders_in_pinned_panes() {
        // Owner report 2026-06-11: in the zellij dock the alert toast flashed
        // but 'N' opened an overlay that never drew — the pinned render path
        // skipped draw_notifs. Pin it.
        let mut app = App::new();
        app.pinned = Some(crate::app::Tab::Wake);
        app.tab = crate::app::Tab::Wake;
        app.show_notifs = true;
        app.notifs = vec![ui_notif("error", "bee crashed", None)];
        let text = render(&app, 90, 16);
        assert!(
            text.contains("Notifications (1)"),
            "pinned pane must render the history: {text}"
        );
        assert!(text.contains("bee crashed"));
    }

    #[test]
    fn toast_title_advertises_the_history_key() {
        let mut app = App::new();
        app.notify_enabled = true; // the transient toast only pops when enabled
        app.pinned = Some(crate::app::Tab::Wake);
        app.tab = crate::app::Tab::Wake;
        app.toast = Some(ui_notif("high", "Decide P-009", None));
        let text = render(&app, 90, 12);
        assert!(text.contains("N history"), "toast must advertise N: {text}");
    }

    #[test]
    fn agent_ctx_panes_render_brief_mail_work() {
        use crate::app::AgentCtxMode;
        let mut app = App::new();
        app.pinned = Some(crate::app::Tab::AgentCtx);
        app.tab = crate::app::Tab::AgentCtx;

        // Prompt mode: brief led first, recorded full prompt below.
        app.agent_ctx_mode = AgentCtxMode::Prompt;
        app.agent_ctx = Some(Ok(crate::models::AgentCtxData {
            owner: Some("s-17".into()),
            label: Some("bee-7".into()),
            brief: Some("Watch for the flaky sync test".into()),
            prompt: Some("You are a bee.\nDo the work.".into()),
            source: Some("recorded".into()),
            model: Some("opus:high".into()),
            tier: Some("deep".into()),
            ..Default::default()
        }));
        let text = render(&app, 80, 16);
        assert!(text.contains("brief"));
        assert!(text.contains("bee-7"));
        assert!(text.contains("Watch for the flaky sync test"));
        assert!(text.contains("opus:high"));
        assert!(text.contains("deep"));
        assert!(text.contains("recorded"));
        assert!(text.contains("You are a bee."));

        // Mail mode.
        app.agent_ctx_mode = AgentCtxMode::Mail;
        app.agent_ctx = Some(Ok(crate::models::AgentCtxData {
            owner: Some("s-17".into()),
            mail: Some(crate::models::BeeMailPayload {
                owner_id: "s-17".into(),
                inbox: crate::models::BeeMailSide {
                    total: 1,
                    entries: vec![crate::models::BeeMailEntry {
                        kind: "message".into(),
                        from: Some("queen".into()),
                        summary: Some("pick up WI-9".into()),
                        ..Default::default()
                    }],
                },
                outbox: crate::models::BeeMailSide::default(),
            }),
            ..Default::default()
        }));
        let text = render(&app, 80, 12);
        assert!(text.contains("inbox (1)"));
        assert!(text.contains("pick up WI-9"));

        // Work mode: items + plan linkage.
        app.agent_ctx_mode = AgentCtxMode::Work;
        app.agent_ctx = Some(Ok(crate::models::AgentCtxData {
            owner: Some("s-17".into()),
            assignment: Some(crate::models::BeeAssignment {
                agent_id: "s-17".into(),
                intent: "fixing the sync test".into(),
                declared_plan_slug: Some("sync-fix-2026".into()),
                queued: vec![crate::models::BeeWorkItem {
                    id: "WI-9".into(),
                    title: "deflake sync".into(),
                    status: Some("claimed".into()),
                    rank: Some(1),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        }));
        let text = render(&app, 80, 12);
        assert!(text.contains("work items (1)"));
        assert!(text.contains("WI-9"));
        assert!(text.contains("sync-fix-2026"));
        assert!(text.contains("fixing the sync test"));
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
            entries: vec![],
            active_entry: None,
        });
        let text = render(&app, 100, 12);
        assert!(text.contains("docs (2)"));
        assert!(text.contains("readme.md"));
        assert!(text.contains("Hello docs"));
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
        app.show_presence = false; // full width for the two-column testing layout
        let t = render(&app, 100, 8);
        assert!(t.contains("domains (1)"));
        assert!(t.contains("Unit tests"));
        assert!(t.contains("universal"));

        // The empty file pane hints at the Enter-to-load affordance (D-004a).
        assert!(t.contains("Enter on a domain loads"));

        app.tab = Tab::Config;
        // D-013: the Config tab renders the EFFECTIVE settings view — a
        // provenance line (which file keys are set) over the merged JSON.
        app.set_config(crate::models::EffectiveClaudeSettings {
            content: r#"{"permissions":{"defaultMode":"plan"}}"#.into(),
            effective: serde_json::json!({ "permissions": { "defaultMode": "plan" } }),
            file_keys: vec!["permissions".into()],
            parse_error: None,
        });
        // render() is the full frame (tab strip + body + status bar), so a short
        // height clips the Config pane to a few rows; render tall enough that the
        // deep JSON lines + the footer hint land inside the body.
        let c = render(&app, 100, 20);
        assert!(c.contains("settings.json"));
        assert!(c.contains("defaultMode"));
        assert!(c.contains("file sets: permissions"));
        // Empty file → defaults-only provenance line + the :set/:unset hint.
        app.set_config(crate::models::EffectiveClaudeSettings::default());
        let empty = render(&app, 100, 20);
        assert!(empty.contains("showing Claude Code defaults"));
        assert!(empty.contains(":set"));
    }

    #[test]
    fn memory_tab_renders_entries_states_and_composer() {
        use crate::models::MemoryEntry;
        let mut app = App::new();
        app.tab = Tab::Memory;
        app.show_presence = false;
        // Backend unavailable → the clear empty state (mem0 unconfigured today).
        let unavailable = render(&app, 110, 16);
        assert!(unavailable.contains("memory backend unavailable"));
        // Available but empty.
        app.memory_available = true;
        let empty = render(&app, 110, 16);
        assert!(empty.contains("no memories stored yet"));
        // Entries render with kind + detail pane metadata.
        app.memories = vec![MemoryEntry {
            id: "m1".into(),
            memory: "user prefers rust for systems work".into(),
            metadata: Some(serde_json::json!({ "kind": "preference" })),
            score: None,
        }];
        let text = render(&app, 110, 18);
        assert!(text.contains("Memory (1)"));
        assert!(text.contains("preference"));
        assert!(text.contains("prefers rust"));
        assert!(text.contains("Detail"));
        assert!(text.contains("m1"));
        // The `/` composer overlays.
        app.memory_search_open = true;
        app.memory_search_input = "rust".into();
        let composing = render(&app, 110, 18);
        assert!(composing.contains("Search memory"));
        assert!(composing.contains("> rust"));
        // An active query titles the list with its hit count.
        app.memory_search_open = false;
        app.memory_hits = Some(("rust".into(), vec![]));
        let hits = render(&app, 110, 18);
        assert!(hits.contains("\"rust\" (0)"));
        assert!(hits.contains("no hits"));
    }

    #[test]
    fn cupboard_tab_renders_listings_filter_row_and_detail() {
        use crate::models::CupboardListing;
        let mut app = App::new();
        app.tab = Tab::Cupboard;
        // Empty state first (not loading → the refetch hint).
        let empty = render(&app, 110, 16);
        assert!(empty.contains("Cupboard"));
        assert!(empty.contains("no listings"));
        // A plugin listing renders in the list + detail, with the kind row.
        app.cupboard = vec![CupboardListing {
            id: "11111111-1111-1111-1111-111111111111".into(),
            listing_kind: "plugin".into(),
            title: Some("Papercusp Worker".into()),
            description: Some("Cross-CLI activity bridge".into()),
            publisher_github_login: Some("papercupai".into()),
            ..Default::default()
        }];
        let text = render(&app, 110, 18);
        assert!(text.contains("[all]")); // active kind filter marker
        assert!(text.contains("Papercusp Worker"));
        assert!(text.contains("install")); // the plugin action label in detail
        assert!(text.contains("papercupai"));
        // Arming the confirm flips the detail title.
        app.cupboard_confirm = Some("11111111-1111-1111-1111-111111111111".into());
        let armed = render(&app, 110, 18);
        assert!(armed.contains("press y to install"));
        // The search composer floats while open.
        app.cupboard_search_open = true;
        app.cupboard_search_input = "worker".into();
        let search = render(&app, 110, 18);
        assert!(search.contains("Search the Cupboard"));
    }

    #[test]
    fn pot_picker_overlay_and_scope_indicator_render() {
        use crate::models::HarnessRef;
        let mut app = App::new();
        app.set_harnesses(vec![
            HarnessRef {
                slug: "papercup".into(),
                path: None,
            },
            HarnessRef {
                slug: "restart".into(),
                path: None,
            },
        ]);
        // The status bar carries the scope indicator (D-003).
        let base = render(&app, 100, 12);
        assert!(base.contains("⊙ all pots"));
        // The picker overlay lists All Pots + each pot.
        app.pot_picker_open = true;
        let picker = render(&app, 100, 14);
        assert!(picker.contains("All Pots"));
        assert!(picker.contains("papercup"));
        assert!(picker.contains("restart"));
        assert!(picker.contains("Enter select"));
        // Pot scope narrows the Plans list + flips the indicator.
        app.pot_picker_open = false;
        app.all_pots = false;
        app.tab = Tab::Plans;
        let mut p1 = plan("papercup-plan", "todo");
        p1.harness = Some("papercup".into());
        let mut p2 = plan("restart-plan", "todo");
        p2.harness = Some("restart".into());
        app.set_plans(vec![p1, p2]);
        let scoped = render(&app, 100, 14);
        assert!(scoped.contains("⊙ papercup"));
        assert!(scoped.contains("Plans (1)"));
        assert!(scoped.contains("papercup-plan"));
        assert!(!scoped.contains("restart-plan"));
    }

    #[test]
    fn lists_render_column_headers() {
        // D-005: explicit styled header rows above the column lists (the PUI
        // bakes column labels into row format strings, so headers are added
        // lines). Fleet (agents) leads; Plans/Inbox follow the same helper.
        let mut app = App::new();
        app.show_presence = false;
        app.tab = Tab::Fleet;
        app.set_roster(vec![presence_entry("claude", "working")]);
        let brew = render(&app, 120, 24);
        assert!(brew.contains("doing now")); // agents header
        app.tab = Tab::Plans;
        app.set_plans(vec![plan("alpha-2026", "todo")]);
        let plans = render(&app, 100, 14);
        assert!(plans.contains("status"));
        assert!(plans.contains("slug"));
        app.tab = Tab::Inbox;
        let inbox = render(&app, 100, 14);
        assert!(inbox.contains("Decisions")); // inbox tier-legend header (D-006)
                                              // Mirror firehose header.
        app.tab = Tab::Fleet;
        app.fleet.mode = crate::fleet::FleetMode::Mirror;
        let mirror = render(&app, 120, 16);
        assert!(mirror.contains("time"));
        assert!(mirror.contains("summary"));
    }

    #[test]
    fn testing_run_pane_renders_files_and_result() {
        use crate::app::{TestRunState, TestingFocus};
        use crate::models::TestingDomain;
        let mut app = App::new();
        app.tab = Tab::Testing;
        app.show_presence = false;
        app.set_testing(vec![TestingDomain {
            id: "unit".into(),
            label: "Unit".into(),
            description: "d".into(),
            tier: "universal".into(),
        }]);
        app.testing_files = vec!["lib/a.test.ts".into()];
        app.testing_focus = TestingFocus::Files;
        app.test_run = Some(TestRunState {
            running: false,
            file: "lib/a.test.ts".into(),
            status: "pass".into(),
            output: "✓ 3 tests passed".into(),
        });
        let text = render(&app, 110, 24);
        assert!(text.contains("files (1)"));
        assert!(text.contains("lib/a.test.ts"));
        assert!(text.contains("pass"));
        assert!(text.contains("3 tests passed"));
        // The in-flight state labels the pane as running.
        app.test_run = Some(TestRunState {
            running: true,
            file: "lib/a.test.ts".into(),
            status: String::new(),
            output: String::new(),
        });
        let running = render(&app, 110, 24);
        assert!(running.contains("running…"));
    }

    #[test]
    fn plugins_view_renders_panes() {
        use crate::app::PluginsFocus;
        use crate::models::TuiPaneContribution;
        let mut app = App::new();
        app.tab = Tab::Plugins;
        // The Plugins tab now defaults to the List sub-view (D-007); the panes
        // launcher is the Panes focus (Tab toggles).
        app.plugins_focus = PluginsFocus::Panes;
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
    fn plugins_list_view_renders_contributions_and_settings() {
        use crate::models::PluginsGlobalResponse;
        let mut app = App::new();
        app.tab = Tab::Plugins; // List is the default focus (D-007).
        app.show_presence = false; // full width for the two-column plugins layout
        let resp: PluginsGlobalResponse = serde_json::from_str(
            r#"{"plugins":[{
                "name":"github-repo","version":"0.1.0","description":"GitHub repo plugin",
                "actions":[{"name":"create-repo"}],
                "configSchema":{"type":"object","properties":{"owner":{"type":"string"}}}
            }]}"#,
        )
        .unwrap();
        app.set_plugins(resp.plugins);
        let text = render(&app, 120, 24);
        assert!(text.contains("github-repo"));
        assert!(text.contains("BE:1")); // one backend action
        assert!(text.contains("create-repo")); // contribution name in detail
        assert!(text.contains("backend"));
        assert!(text.contains("settings")); // configSchema → settings section
                                            // No config loaded yet → the Enter-to-load affordance.
        assert!(text.contains("press Enter to load"));
    }

    #[test]
    fn plugins_list_view_renders_loaded_config() {
        use crate::models::PluginsGlobalResponse;
        let mut app = App::new();
        app.tab = Tab::Plugins;
        app.show_presence = false; // full width for the two-column plugins layout
        let resp: PluginsGlobalResponse = serde_json::from_str(
            r#"{"plugins":[{"name":"github-repo","version":"0.1.0",
                "configSchema":{"type":"object"}}]}"#,
        )
        .unwrap();
        app.set_plugins(resp.plugins);
        app.plugin_config = Some(("github-repo".into(), serde_json::json!({ "owner": "acme" })));
        let text = render(&app, 120, 24);
        assert!(text.contains("acme")); // the loaded config value renders
        assert!(text.contains(":pset")); // the edit hint
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
        eprintln!(
            "live coord-inbox SSE frame: {} | {}",
            frame.event, frame.data
        );
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
        if let Ok((active, _pending)) = c.roster_typed().await {
            app.set_roster(active);
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
        if let Ok(v) = c.testing_domains(slug).await {
            app.set_testing(v);
        }
        if let Ok(v) = c.claude_settings_effective(slug).await {
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
        let (roster, _pending) = client.roster_typed().await.expect("roster over IPC");
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
        assert!(text.contains("step 1/4"));
        assert!(!text.contains("pui — keys")); // help overlay suppressed
    }

    #[test]
    fn tutorial_zellij_layer_step_renders() {
        // D-003: the zellij-layer step teaches the window-manager layer pui runs
        // in (HUD vs work area, layout cycling, the dock verbs).
        let mut app = App::new();
        app.show_tutorial = true;
        app.tutorial_step = 2; // the new third step
        let text = render(&app, 90, 28);
        assert!(text.contains("Your workbench is zellij")); // block title
        assert!(text.contains("step 3/4"));
        assert!(text.contains("Alt")); // the zellij keybinds
        assert!(text.contains("relaunches")); // r-to-relaunch teaching
    }

    #[test]
    fn tutorial_last_step_renders() {
        let mut app = App::new();
        app.show_tutorial = true;
        app.tutorial_step = 3; // "Staying in the loop" is now the 4th/last step
        let text = render(&app, 90, 26);
        assert!(text.contains("Staying in the loop"));
        assert!(text.contains("step 4/4"));
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

    #[test]
    fn palette_shows_dock_verbs_and_layout_presets() {
        // The dockview dock-verbs + the swap-preset cycle are discoverable in
        // the palette (Brief 50 / D-008). Render wide so nothing truncates.
        let mut app = App::new();
        app.palette_open = true;
        let text = render(&app, 120, 22);
        assert!(text.contains(":stack"), "palette lists :stack");
        assert!(text.contains(":dock"), "palette lists :dock");
        // The KDL preset names are surfaced from layout::SWAP_PRESETS.
        for p in crate::layout::SWAP_PRESETS {
            assert!(text.contains(p), "palette lists preset {p}");
        }
    }

    #[test]
    fn palette_shows_active_swap_preset_when_known() {
        use pui_companion_proto::{TabNode, Topology};
        let mut app = App::new();
        app.palette_open = true;
        app.topology = Some(Topology {
            tabs: vec![TabNode {
                pos: 0,
                name: "papercup".into(),
                active: true,
                swap_layout: Some("grid".into()),
                swap_dirty: false,
            }],
            panes: vec![],
        });
        let text = render(&app, 120, 22);
        assert!(text.contains("[grid]"), "palette shows the active preset");
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
            ..Default::default()
        }
    }

    fn fleet_activity(
        owner: &str,
        agent: &str,
        summary: &str,
        ts: &str,
    ) -> crate::models::ActivityRow {
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
        p.item_counts = ItemCounts {
            todo: 2,
            done: 3,
            ..Default::default()
        };
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
        assert!(text.contains("Fleet")); // D-001 label-only rename of Fleet
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
    fn fleet_agents_title_advertises_enter_and_launch() {
        // The work-area pane is gone (dock consolidation) — the launch + reach
        // affordances live on the Agents column title now.
        let mut app = App::new();
        app.tab = Tab::Fleet;
        app.show_presence = false;
        app.set_roster(vec![fleet_roster("su-a", "claude", "x")]);
        let text = render(&app, 120, 24);
        // D-001: Enter-by-location routing is advertised on the Agents column.
        assert!(text.contains("Enter: reach"));
        assert!(text.contains("n: launch"));
    }

    #[test]
    fn fleet_no_session_menu_overlay_renders() {
        use crate::app::FleetActionMenu;
        let mut app = App::new();
        app.tab = Tab::Fleet;
        // The [r]/[n]/[f] no-session menu (D-002) renders as a modal overlay.
        app.fleet_action_menu = Some(FleetActionMenu {
            label: "su · remote".into(),
            note: "agent is live but not reachable from this workbench".into(),
            can_resume: true,
            can_focus_window: true,
            resume_spec: None,
            focus: None,
        });
        let text = render(&app, 120, 24);
        assert!(text.contains("reach agent")); // overlay title
        assert!(text.contains("resume")); // [r] choice
        assert!(text.contains("launch a new agent")); // [n] choice
        assert!(text.contains("focus its terminal window")); // [f] choice
        assert!(text.contains("Esc to cancel"));
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
        // The roster row carries the mirrored todo progress cell (the old
        // per-agent detail panel folded into the roster — dock consolidation).
        let text = render(&app, 120, 44);
        assert!(text.contains("\u{21c4}1/3")); // ⇄done/count
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
        // Fleet titles as "Fleet" (D-001) on digit '4' (D-002).
        let app = App::new();
        let text = render(&app, 160, 8);
        assert!(text.contains("4:Fleet"));
    }

    // --- Operator chat pane (tui-operator-surface-2026-06-04) ---

    #[test]
    fn operator_leads_strip_on_digit_one() {
        let app = App::new(); // default tab = Operator, now on digit '1' (D-002)
        let text = render(&app, 220, 8);
        assert!(text.contains("1:Papercup"));
    }

    #[test]
    fn chat_view_renders_transcript_and_composer() {
        let mut app = App::new();
        app.tab = Tab::Operator; // chat view — Overview is the default landing now (Brief 23)
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
        app.tab = Tab::Operator; // chat view — Overview is the default landing now (Brief 23)
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
    fn inbox_detail_renders_two_tier_report_block() {
        // report-cards-inbox-reconciliation D-002/D-003: an operator <report>
        // is INBOX content — the detail pane renders the structured two-tier
        // plan→item block natively (the body text fallback is suppressed so
        // the payload doesn't double-render).
        use crate::models::AttentionItem;
        let report = crate::chat_tags::Report {
            title: Some("Fleet status".into()),
            plans: vec![crate::chat_tags::ReportPlan {
                slug: Some("rate-limit-layer-v2".into()),
                title: "Rate-limit v2".into(),
                status: Some("active".into()),
                summary: Some("top half of the layer".into()),
                items: vec![
                    crate::chat_tags::ReportItem {
                        id: Some("P-001".into()),
                        text: "Error classifier".into(),
                        status: Some("done".into()),
                    },
                    crate::chat_tags::ReportItem {
                        id: Some("P-003".into()),
                        text: "Per-call pacing".into(),
                        status: Some("wip".into()),
                    },
                ],
            }],
        };
        let mut app = App::new();
        app.tab = Tab::Inbox;
        app.set_inbox(vec![AttentionItem {
            id: "operator-report:t-1".into(),
            kind: "operator-report".into(),
            source: "operator".into(),
            harness_slug: None,
            plan_slug: Some("rate-limit-layer-v2".into()),
            item_ref: None,
            title: "Fleet status".into(),
            body: Some("[active] Rate-limit v2 — duplicated text body".into()),
            status: "report".into(),
            importance: None,
            needs_human: false,
            tier: Some("activity".into()),
            owner_agent_id: None,
            owner_label: Some("Operator".into()),
            triage_state: None,
            triage_note: None,
            report: Some(report),
        }]);
        let text = render(&app, 110, 30);
        // The detail pane renders the structured block (two tiers).
        assert!(text.contains("Fleet status"));
        assert!(text.contains("Rate-limit v2"));
        assert!(text.contains("Error classifier"));
        assert!(text.contains("Per-call pacing"));
        assert!(text.contains("P-001"));
        // The plain-text body fallback is suppressed when the block renders.
        assert!(!text.contains("duplicated text body"));
    }

    #[test]
    fn chat_transcript_carries_no_report_block() {
        // Chat is conversation-only (D-002): a finalized assistant bubble is
        // just the say text — ChatMessage no longer carries a report payload.
        let mut app = App::new();
        app.tab = Tab::Operator;
        app.set_chat_history(
            "c1".into(),
            vec![crate::models::ChatMessage::assistant(
                "Three things need you — they're in your Inbox.",
            )],
            false,
            None,
        );
        let text = render(&app, 100, 24);
        assert!(text.contains("they're in your Inbox."));
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

    #[test]
    fn plan_filter_rail_renders_with_check_marks_on_inbox() {
        // D-009: the open rail lists the pot-scoped plans with a checkbox per
        // slug + the toggle/clear/close hint, and the Inbox title carries the
        // active-filter badge.
        let mut app = App::new();
        app.tab = Tab::Inbox;
        app.set_plans(vec![
            plan("alpha-2026", "todo"),
            plan("beta-2026", "shipped"),
        ]);
        app.plan_filter_open = true;
        app.plan_filter.insert("alpha-2026".to_string());
        let text = render(&app, 120, 16);
        assert!(
            text.contains("Filter: plans (1 on)"),
            "rail title missing: {text:?}"
        );
        assert!(text.contains("[x]"), "checked plan glyph missing");
        assert!(text.contains("[ ]"), "unchecked plan glyph missing");
        assert!(text.contains("toggle"), "rail hint missing");
        assert!(text.contains("F:plans(1)"), "inbox filter badge missing");
        // Closing the rail hides it but keeps the badge (filter still applies).
        app.plan_filter_open = false;
        let closed = render(&app, 120, 16);
        assert!(
            !closed.contains("Filter: plans"),
            "rail should be hidden when closed"
        );
        assert!(
            closed.contains("F:plans(1)"),
            "badge should persist while rail hidden"
        );
    }

    #[test]
    fn status_bar_shows_help_and_tutorial_hint() {
        // D-012: the footer always advertises the help overlay. On non-Operator
        // tabs (incl. the default Overview landing, Brief 23) the right edge
        // advertises the operator dock instead of the tutorial
        // (operator-always-visible-2026-06-05).
        let mut app = App::new();
        let text = render(&app, 100, 12);
        assert!(
            text.contains("o:operator"),
            "dock hint missing on the Overview landing"
        );
        assert!(text.contains("?:help"), "help hint missing from status bar");
        app.tab = Tab::Operator;
        let text = render(&app, 100, 12);
        assert!(text.contains("?:help"), "help hint missing from status bar");
        assert!(
            text.contains("F1/:tutorial"),
            "tutorial hint missing from status bar"
        );
    }

    #[test]
    fn help_overlay_lists_tutorial_and_plans_filter() {
        // D-012 + D-009: the `?` help overlay documents both the re-openable
        // tutorial and the plans-filter rail.
        let mut app = App::new();
        app.show_help = true;
        // Tall enough that the full help text (incl. the F1/:tutorial line near
        // the bottom) renders without clipping.
        let text = render(&app, 100, 40);
        assert!(
            text.contains(":tutorial"),
            "help should mention the :tutorial palette command"
        );
        assert!(
            text.contains("plans filter"),
            "help should mention the plans filter rail"
        );
    }

    // ─── Operator dock (operator-always-visible-2026-06-05, Brief 24) ───

    #[test]
    fn operator_dock_renders_beside_tab_content_when_open() {
        let mut app = App::new();
        app.tab = Tab::Plans;
        app.plans = vec![plan("alpha", "todo")];
        app.operator_dock_open = true;
        app.set_chat_history(
            "c1".into(),
            vec![crate::models::ChatMessage::assistant("docked reply here")],
            false,
            None,
        );
        // Wide enough (>=100) → the dock is carved on the right alongside Plans.
        let text = render(&app, 120, 20);
        assert!(
            text.contains("Title alpha"),
            "the Plans tab content still renders"
        );
        assert!(
            text.contains("Operator"),
            "the operator dock renders its title"
        );
        assert!(
            text.contains("docked reply here"),
            "the dock shows the transcript"
        );
    }

    #[test]
    fn operator_card_renders_radio_options_inline() {
        // sentinel-tui-shared-backend-and-cards Phase 2a: an open chat:ask_choice
        // card renders inline over the operator pane with its prompt + numbered
        // options + a queue/action hint in the composer.
        let mut app = App::new();
        app.tab = Tab::Operator;
        let snap = serde_json::json!({
            "runId": "run-1",
            "workspaceId": "ws-1",
            "version": 1,
            "snapshot": { "openCards": [{
                "correlationId": "corr-1",
                "prompt": "Approve the deploy?",
                "presentation": { "kind": "radio", "options": [
                    { "id": "yes", "label": "Approve" },
                    { "id": "no", "label": "Reject" }
                ]},
                "allowDecline": true,
                "createdAt": 1.0
            }]}
        })
        .to_string();
        app.card_state
            .apply_snapshot(crate::card_view::SnapshotEnvelope::from_json(&snap).unwrap());
        let text = render(&app, 100, 24);
        assert!(text.contains("Approve the deploy?"), "card prompt renders");
        assert!(text.contains("1. Approve"), "option 1 renders numbered");
        assert!(text.contains("2. Reject"), "option 2 renders numbered");
        assert!(text.contains("Operator asks"), "card block title renders");
        assert!(
            text.contains("answer above") || text.contains("pick"),
            "composer steers the user to the card"
        );
    }

    #[test]
    fn operator_dock_hidden_on_narrow_terminal() {
        let mut app = App::new();
        app.tab = Tab::Plans;
        app.plans = vec![plan("alpha", "todo")];
        app.operator_dock_open = true;
        // Below the width gate (<100) the dock is suppressed; Plans gets full width.
        let text = render(&app, 80, 20);
        assert!(text.contains("Title alpha"));
        // The dock's focus marker ("○ o" / "●") never appears when it isn't drawn.
        assert!(!text.contains("○ o"));
    }

    #[test]
    fn operator_dock_not_shown_on_operator_tab() {
        let mut app = App::new();
        app.tab = Tab::Operator; // the full tab IS the chat; no extra dock
        app.operator_dock_open = true;
        let text = render(&app, 120, 20);
        // The full-tab Operator render carries no dock focus marker.
        assert!(!text.contains("○ o"));
        assert!(!text.contains("● Operator"));
    }

    #[test]
    fn operator_dock_focus_marker_reflects_focus_state() {
        let mut app = App::new();
        app.tab = Tab::Plans;
        app.operator_dock_open = true;
        // Unfocused → "○ o" hint (press o to focus).
        let unfocused = render(&app, 120, 20);
        assert!(
            unfocused.contains("○ o"),
            "unfocused dock advertises the o key"
        );
        // Focused → "●" marker.
        app.operator_dock_focused = true;
        let focused = render(&app, 120, 20);
        assert!(focused.contains('●'), "focused dock shows the ● marker");
    }

    #[test]
    fn operator_dock_hint_in_status_bar_when_closed() {
        let mut app = App::new();
        app.tab = Tab::Plans; // not the Operator tab, dock closed by default
        let text = render(&app, 120, 20);
        assert!(
            text.contains("o:operator"),
            "status bar advertises the dock when closed"
        );
    }

    #[test]
    fn operator_dock_right_carve_suppressed_on_overview() {
        // P-008: the Overview tab already hosts the operator (draw_overview
        // renders draw_operator_dock as its bottom strip, Brief 23), so the
        // right-dock carve must NOT also fire there — the chat renders exactly
        // once even with the dock explicitly opened.
        let mut app = App::new(); // Overview is the default landing (Brief 23)
        assert_eq!(app.tab, Tab::Overview);
        app.operator_dock_open = true; // user-opened right-dock…
        let text = render(&app, 120, 30);
        // …still exactly ONE unfocused dock marker (the strip's); a second one
        // would mean the right-dock double-rendered the conversation.
        assert_eq!(
            text.matches("○ o").count(),
            1,
            "operator must render exactly once on Overview"
        );
    }
}
