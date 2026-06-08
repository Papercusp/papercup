//! Hives tab (pui-hives-tab-2026-06-07) — the p2p swarm roster.
//!
//! Lists every remote Papercusp install ("hive") that has joined the Model-B
//! p2p substrate: peers announce into per-harness swarms, the peer-log projects
//! their announces into `harness_shared.shared_presence`, and `coord:presence`
//! surfaces those rows as `federated: true` records. One hive = one DEVICE
//! (machine), so the per-(user, harness) presence rows are grouped by device
//! pubkey here. Replaces the Cupboard in the dock MAIN pane's tab subset.
//!
//! State lives on `App` (`hives` raw rows + `hive_sel`); grouping happens at
//! render so the reducer stays a dumb store. Render is pure over `&App`.

use crate::app::App;
use crate::glyph;
use crate::models::PresenceRow;
use crate::theme::Theme;
use crate::ui::trunc;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    text::{Line, Span},
    widgets::{List, ListItem, ListState, Paragraph, Wrap},
    Frame,
};

/// One hive — a device joined to the swarm, aggregated from its per-(user,
/// harness) presence rows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HiveGroup {
    /// The machine label (the human half of the federation identity).
    pub machine: String,
    /// The device pubkey (raw-32-byte-base64 — the cryptographic identity).
    pub device_pubkey: String,
    /// gh user ids seen on this device, dedup'd in arrival order.
    pub users: Vec<String>,
    /// Harnesses this hive announced presence in, dedup'd in arrival order.
    pub harnesses: Vec<String>,
    /// The freshest row's declared intent (what the hive is doing).
    pub intent: String,
    /// The freshest row's current view.
    pub current_view: Option<String>,
    /// Freshest announce timestamp (ISO — sorts lexically).
    pub last_seen: String,
    /// True when EVERY row for this device is stale (the hive went quiet).
    pub stale: bool,
}

/// Group the raw federated presence rows into one entry per device. The
/// freshest row (by ISO `heartbeat_at`) wins the intent/view fields; a hive is
/// stale only when all its rows are. Live hives sort first, then by machine.
pub fn group_hives(rows: &[PresenceRow]) -> Vec<HiveGroup> {
    let mut groups: Vec<HiveGroup> = Vec::new();
    for r in rows {
        let key = r
            .device_pubkey
            .clone()
            .filter(|k| !k.is_empty())
            .unwrap_or_else(|| r.host.clone());
        let g = match groups
            .iter_mut()
            .find(|g| g.device_pubkey == key)
        {
            Some(g) => g,
            None => {
                groups.push(HiveGroup {
                    machine: if r.host.is_empty() {
                        key.clone()
                    } else {
                        r.host.clone()
                    },
                    device_pubkey: key,
                    stale: true,
                    ..Default::default()
                });
                groups.last_mut().expect("just pushed")
            }
        };
        if let Some(u) = r.user_id.clone().filter(|u| !u.is_empty()) {
            if !g.users.contains(&u) {
                g.users.push(u);
            }
        }
        if let Some(h) = r.harness_slug.clone().filter(|h| !h.is_empty()) {
            if !g.harnesses.contains(&h) {
                g.harnesses.push(h);
            }
        }
        let ts = r.heartbeat_at.clone().unwrap_or_default();
        if ts >= g.last_seen {
            g.last_seen = ts;
            g.intent = r.intent.clone();
            g.current_view = r.current_view.clone();
        }
        g.stale &= r.stale;
    }
    groups.sort_by(|a, b| a.stale.cmp(&b.stale).then(a.machine.cmp(&b.machine)));
    groups
}

/// Render the Hives tab: a 1-line headline + the per-device roster.
pub fn draw_hives(f: &mut Frame, app: &App, area: Rect) {
    let groups = group_hives(&app.hives);
    let live = groups.iter().filter(|g| !g.stale).count();

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(1)])
        .split(area);

    let headline = Line::from(vec![
        Span::styled(
            format!(" {} Hives ", glyph::nav::FLEET),
            Theme::title_active(),
        ),
        Span::raw(format!(
            " {} joined the swarm · {} live ",
            groups.len(),
            live
        )),
    ]);
    f.render_widget(
        Paragraph::new(headline).style(Theme::status_bar()),
        rows[0],
    );

    if groups.is_empty() && app.hive_directory.is_empty() {
        // The single-box reality until real peers announce: honest empty state.
        f.render_widget(
            Paragraph::new(
                "no remote hives in the p2p swarm yet — this hive flies solo\n\n\
                 A hive appears here once another Papercusp install joins the\n\
                 substrate (live roster), or announces a public hive on the\n\
                 directory topic (browse + join with J).",
            )
            .wrap(Wrap { trim: false })
            .style(Theme::panel())
            .block(Theme::block(Line::from(" p2p swarm "), false)),
            rows[1],
        );
        return;
    }

    let items: Vec<ListItem> = groups
        .iter()
        .map(|g| {
            let dot = Theme::liveness_marker(g.stale, if g.stale { "stale" } else { "live" });
            let users = if g.users.is_empty() {
                String::new()
            } else {
                format!("gh:{} ", g.users.join(","))
            };
            let doing = g
                .current_view
                .clone()
                .filter(|v| !v.is_empty())
                .or_else(|| Some(g.intent.clone()).filter(|i| !i.is_empty()))
                .unwrap_or_default();
            let harnesses = if g.harnesses.is_empty() {
                String::new()
            } else {
                format!(" [{}]", g.harnesses.join(", "))
            };
            ListItem::new(Line::from(vec![
                dot,
                Span::raw(format!(" {:<18} ", trunc(&g.machine, 18))),
                Span::styled(format!("{users:<12}"), Theme::dim()),
                Span::raw(format!("{:<34}", trunc(&doing, 34))),
                Span::styled(trunc(&harnesses, 28), Theme::info()),
            ]))
        })
        .collect();

    // Body layout: the browseable DIRECTORY (p2p-hive-directory P-006) on top
    // when non-empty, the live presence roster below. When the directory is
    // empty we hand the whole body to the roster (the pre-P-006 behavior).
    let (dir_area, roster_area) = if app.hive_directory.is_empty() {
        (None, rows[1])
    } else if groups.is_empty() {
        (Some(rows[1]), Rect { height: 0, ..rows[1] })
    } else {
        let split = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
            .split(rows[1]);
        (Some(split[0]), split[1])
    };

    if let Some(area) = dir_area {
        draw_directory(f, app, area);
    }

    if roster_area.height > 0 {
        let mut state = ListState::default();
        state.select(Some(app.hive_sel.min(groups.len().saturating_sub(1))));
        let body = crate::ui::block_with_header(
            f,
            roster_area,
            Theme::block(
                Line::from(format!(" p2p swarm — {} live ", groups.len())),
                groups.is_empty(),
            ),
            &format!("    {:<19}{:<12}{:<34}{}", "machine", "user", "doing", "harnesses"),
        );
        let list = List::new(items)
            .style(Theme::panel())
            .highlight_style(Theme::selected())
            .highlight_symbol("> ");
        f.render_stateful_widget(list, body, &mut state);
    }
}

/// Render the browseable hive DIRECTORY (p2p-hive-directory P-006): each verified
/// discovered hive (title · owner · N harnesses · visibility), `J` to join the
/// first joinable one. A topic-only hive (no member links) shows "topics-only".
fn draw_directory(f: &mut Frame, app: &App, area: Rect) {
    let items: Vec<ListItem> = app
        .hive_directory
        .iter()
        .map(|h| {
            let joinable = if h.member_links.is_empty() {
                Span::styled("  topics-only", Theme::dim())
            } else {
                Span::styled("  ⮐ J to join", Theme::info())
            };
            ListItem::new(Line::from(vec![
                Span::raw(format!(" {:<24} ", trunc(&h.title, 24))),
                Span::styled(format!("@{:<14}", trunc(&h.owner, 14)), Theme::dim()),
                Span::raw(format!("{:<28}", trunc(&h.description, 28))),
                Span::styled(format!("{} harness ", h.member_count), Theme::info()),
                joinable,
            ]))
        })
        .collect();
    let mut state = ListState::default();
    if !app.hive_directory.is_empty() {
        state.select(Some(app.hive_dir_sel.min(app.hive_directory.len() - 1)));
    }
    let body = crate::ui::block_with_header(
        f,
        area,
        Theme::block(
            Line::from(format!(" hive directory — {} to join (J) ", app.hive_directory.len())),
            true,
        ),
        &format!(" {:<25}{:<15}{:<28}{}", "hive", "owner", "description", "harnesses"),
    );
    let list = List::new(items)
        .style(Theme::panel())
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body, &mut state);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(host: &str, key: &str, user: &str, harness: &str, ts: &str, stale: bool) -> PresenceRow {
        PresenceRow {
            owner_id: format!("fed:{user}@{host}"),
            owner_label: format!("gh:{user} · {host}"),
            intent: format!("working on {harness}"),
            host: host.into(),
            user_id: Some(user.into()),
            stale,
            federated: true,
            device_pubkey: Some(key.into()),
            harness_slug: Some(harness.into()),
            current_view: None,
            heartbeat_at: Some(ts.into()),
        }
    }

    #[test]
    fn groups_by_device_and_unions_users_harnesses() {
        let rows = vec![
            row("mbp", "key-a", "111", "papercup", "2026-06-07T01:00:00Z", false),
            row("mbp", "key-a", "222", "restart", "2026-06-07T02:00:00Z", false),
            row("tower", "key-b", "111", "papercup", "2026-06-07T01:30:00Z", true),
        ];
        let groups = group_hives(&rows);
        assert_eq!(groups.len(), 2);
        // Live hive first.
        assert_eq!(groups[0].machine, "mbp");
        assert_eq!(groups[0].users, vec!["111", "222"]);
        assert_eq!(groups[0].harnesses, vec!["papercup", "restart"]);
        // Freshest row wins the intent.
        assert_eq!(groups[0].intent, "working on restart");
        assert!(!groups[0].stale);
        // All-stale device is stale.
        assert!(groups[1].stale);
        assert_eq!(groups[1].machine, "tower");
    }

    #[test]
    fn one_live_row_keeps_the_hive_live() {
        let rows = vec![
            row("mbp", "key-a", "111", "papercup", "2026-06-07T01:00:00Z", true),
            row("mbp", "key-a", "111", "restart", "2026-06-07T02:00:00Z", false),
        ];
        let groups = group_hives(&rows);
        assert_eq!(groups.len(), 1);
        assert!(!groups[0].stale);
    }

    #[test]
    fn renders_roster_and_empty_state() {
        use ratatui::{backend::TestBackend, Terminal};
        let render = |app: &App| -> String {
            let mut term = Terminal::new(TestBackend::new(100, 20)).unwrap();
            term.draw(|f| draw_hives(f, app, f.area())).unwrap();
            term.backend()
                .buffer()
                .content()
                .iter()
                .map(|c| c.symbol())
                .collect()
        };
        let mut app = App::new();
        // Empty: the solo-hive hint.
        let text = render(&app);
        assert!(text.contains("flies solo"));
        // Populated: machine + user + harness columns.
        app.hives = vec![row(
            "mbp",
            "key-a",
            "111",
            "papercup",
            "2026-06-07T01:00:00Z",
            false,
        )];
        let text = render(&app);
        assert!(text.contains("1 joined the swarm"));
        assert!(text.contains("mbp"));
        assert!(text.contains("gh:111"));
        assert!(text.contains("papercup"));
    }

    #[test]
    fn renders_the_hive_directory_with_join_affordances() {
        use ratatui::{backend::TestBackend, Terminal};
        let render = |app: &App| -> String {
            let mut term = Terminal::new(TestBackend::new(120, 24)).unwrap();
            term.draw(|f| draw_hives(f, app, f.area())).unwrap();
            term.backend().buffer().content().iter().map(|c| c.symbol()).collect()
        };
        let mut app = App::new();
        app.hive_directory = vec![
            crate::models::DiscoveredHiveRow {
                hive_id: "ash".into(),
                title: "Ash Hive".into(),
                description: "shop migration".into(),
                owner: "alice".into(),
                visibility: "public".into(),
                member_links: vec!["papercusp://harness?topic=a".into()],
                member_count: 1,
            },
            crate::models::DiscoveredHiveRow {
                hive_id: "topic-only".into(),
                title: "Topic Hive".into(),
                description: String::new(),
                owner: "bob".into(),
                visibility: "public".into(),
                member_links: vec![],
                member_count: 2,
            },
        ];
        let text = render(&app);
        // The directory section + both hives render; the joinable one shows the
        // Join affordance, the link-less one shows topics-only.
        assert!(text.contains("hive directory"));
        assert!(text.contains("Ash Hive"));
        assert!(text.contains("@alice"));
        assert!(text.contains("J to join"));
        assert!(text.contains("topics-only"));
    }
}
