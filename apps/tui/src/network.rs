//! Network pane (hive-network-surface-2026-06-11, brief B-09) — the aggregate
//! cross-Hive board: one row per hive-context over the capability ladder
//! (D-001), rendered from the PINNED C-3 row contract (`models::NetworkBoardRow`).
//!
//! Tier model: 1 = this hive (trust `local`) · 2 = own/admin hives (`admin`) ·
//! 3 = shared-Hive peer swarms, substrate-verified (`federated`) · 4 = foreign
//! directory hives, self-reported beacon (`gossip`). C-3's rule is structural:
//! an ABSENT optional field means that tier lacks the data — sections are
//! HIDDEN, never painted as empties, so verified silence and gossip silence
//! stay distinguishable from a zero.
//!
//! Two render modes share this module:
//! - `pui network-pane` — the board: tier-badged list + selected-row detail.
//! - `pui hive-pane <key>` — ONE row's detail full-pane (the primary pane of
//!   B-10's per-hive drill-in tab; `App::network_focus` carries the key).
//!
//! State lives on `App` (`network_rows` + `network_sel` + `network_focus`);
//! render is pure over `&App` (the hives.rs convention). Enter on a row maps
//! through `drill_in()` → `Action::OpenNetworkDrillIn` → the `// B-10 SEAM:`
//! arm in main.rs, where B-10's `layout::hive_tab_kdl` generator plugs in
//! (agreed coord 2026-06-11; tab name format `⌕ <key>` is theirs).

use crate::app::App;
use crate::models::NetworkBoardRow;
use crate::theme::Theme;
use crate::ui::trunc;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::{List, ListItem, ListState, Paragraph, Wrap},
    Frame,
};

/// The Enter-to-open seam consumed by B-10's per-hive tab generator: the
/// minimal identity of the selected row, plus the per-bee `watch_owners`
/// the C-3 row carries for tiers 2/3 (P-014 item 1) — each becomes a
/// read-only `pui watch-pane <owner>` in the generated tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrillInRequest {
    pub tier: u8,
    pub key: String,
    pub title: String,
    pub trust: String,
    pub watch_owners: Vec<String>,
}

/// Map a board row to its drill-in request (the Enter seam).
pub fn drill_in(row: &NetworkBoardRow) -> DrillInRequest {
    DrillInRequest {
        tier: row.tier,
        key: row.key.clone(),
        title: row.title.clone(),
        trust: row.trust.clone(),
        watch_owners: row.watch_owners.clone(),
    }
}

/// The explicit tier badge (D-001 capability ladder), e.g. `T3·fed`. Trust is
/// echoed in compressed form so the ladder reads at a glance; an unknown trust
/// string passes through verbatim (forward-compatible with a C-3 plan edit).
pub fn tier_badge(row: &NetworkBoardRow) -> String {
    let trust = match row.trust.as_str() {
        "federated" => "fed",
        other => other,
    };
    format!("T{}·{}", row.tier, trust)
}

/// Badge style: substrate-verified data (local/admin/federated) renders in
/// confident colors; gossip — self-reported, unverified — renders in `warn`
/// so it can NEVER be mistaken for verified state (P-009's conflation fix;
/// B-11 mirrors this distinction on the HUD Hives tab).
pub fn tier_badge_style(row: &NetworkBoardRow) -> Style {
    match row.trust.as_str() {
        "local" | "admin" => Theme::success(),
        "federated" => Theme::info(),
        _ => Theme::warn(),
    }
}

/// Render the Network pane. `App::network_focus` (the `pui hive-pane <key>`
/// mode) short-circuits to one row's full-pane detail.
pub fn draw_network(f: &mut Frame, app: &App, area: Rect) {
    if let Some(key) = &app.network_focus {
        draw_focused_hive(f, app, area, key);
        return;
    }

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(1)])
        .split(area);

    let live_agents: u32 = app
        .network_rows
        .iter()
        .filter_map(|r| r.live_agents)
        .sum();
    let pending: u32 = app
        .network_rows
        .iter()
        .filter_map(|r| r.asks.as_ref().map(|a| a.pending))
        .sum();
    let headline = Line::from(vec![
        Span::styled(" ⬡ Network ", Theme::title_active()),
        Span::raw(format!(
            " {} hive-contexts · {} live agents · {} asks pending ",
            app.network_rows.len(),
            live_agents,
            pending
        )),
    ]);
    f.render_widget(Paragraph::new(headline).style(Theme::status_bar()), rows[0]);

    if app.network_rows.is_empty() {
        // Honest empty state: no board rows yet — either the data endpoint
        // hasn't landed/answered (B-08) or this install genuinely sees no
        // hive-contexts beyond... itself, which would still be one row, so
        // an empty board usually means the endpoint is absent.
        f.render_widget(
            Paragraph::new(
                "no hive-contexts on the network board yet\n\n\
                 Rows appear here per hive-context this install can see:\n\
                 your own hives (T1/T2), shared-Hive peer swarms (T3,\n\
                 substrate-verified), and foreign directory hives (T4,\n\
                 self-reported beacon). An empty board usually means the\n\
                 network data endpoint isn't reachable yet.",
            )
            .wrap(Wrap { trim: false })
            .style(Theme::panel())
            .block(Theme::block(Line::from(" network board "), false)),
            rows[1],
        );
        return;
    }

    // Body: the board list on top, the selected row's dossier below.
    let split = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
        .split(rows[1]);

    let items: Vec<ListItem> = app
        .network_rows
        .iter()
        .map(|r| {
            // Absent C-3 fields render BLANK in their column (hidden, not 0).
            let agents = r.live_agents.map(|n| n.to_string()).unwrap_or_default();
            let queue = r.queue_depth.map(|n| n.to_string()).unwrap_or_default();
            let focus = r.focus.clone().unwrap_or_default();
            let asks = r
                .asks
                .as_ref()
                .map(|a| format!("{}⌛", a.pending))
                .unwrap_or_default();
            let title = if r.title.is_empty() { &r.key } else { &r.title };
            ListItem::new(Line::from(vec![
                Span::styled(format!(" {:<10}", tier_badge(r)), tier_badge_style(r)),
                Span::raw(format!("{:<24} ", trunc(title, 23))),
                Span::styled(format!("{agents:>4} {queue:>4}  "), Theme::info()),
                Span::raw(format!("{:<30}", trunc(&focus, 30))),
                Span::styled(format!("{asks:<6}"), Theme::dim()),
            ]))
        })
        .collect();

    let sel = app.network_sel.min(app.network_rows.len().saturating_sub(1));
    let mut state = ListState::default();
    state.select(Some(sel));
    let body = crate::ui::block_with_header(
        f,
        split[0],
        Theme::block(
            Line::from(format!(" network board — {} ", app.network_rows.len())),
            false,
        ),
        &format!(
            "  {:<10}{:<25}{:>4} {:>4}  {:<30}{}",
            "tier", "hive", "agnt", "queue", "focus", "asks"
        ),
    );
    let list = List::new(items)
        .style(Theme::panel())
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body, &mut state);

    if let Some(row) = app.network_rows.get(sel) {
        draw_detail(f, split[1], row, false);
    }
}

/// The `pui hive-pane <key>` mode: one row's dossier, full-pane. A key not on
/// the board (yet) renders an honest waiting state — the row can appear on the
/// next refetch (the pane is opened close-on-exit by B-10's tab, so a user
/// just closes it if the hive is truly gone). When the dossier queries carry
/// data for this key (beacon history / the C-1 ask log, P-014 item 2), they
/// render below the detail; absent data hides its section (the C-3 rule).
fn draw_focused_hive(f: &mut Frame, app: &App, area: Rect, key: &str) {
    match app.network_rows.iter().find(|r| r.key == key) {
        Some(row) => {
            let beacons = !app.hive_beacons.is_empty();
            let asks = !app.hive_asks.is_empty();
            if !beacons && !asks {
                draw_detail(f, area, row, true);
                return;
            }
            // Detail header on top; the populated dossier sections share the rest.
            let mut constraints = vec![Constraint::Min(8)];
            if beacons {
                constraints.push(Constraint::Percentage(30));
            }
            if asks {
                constraints.push(Constraint::Percentage(30));
            }
            let split = Layout::default()
                .direction(Direction::Vertical)
                .constraints(constraints)
                .split(area);
            draw_detail(f, split[0], row, true);
            let mut next = 1;
            if beacons {
                draw_beacon_history(f, app, split[next]);
                next += 1;
            }
            if asks {
                draw_ask_log(f, app, split[next]);
            }
        }
        None => {
            f.render_widget(
                Paragraph::new(format!(
                    "hive '{key}' is not on the network board (yet)\n\n\
                     Waiting for the next board refresh — if it never appears,\n\
                     the hive left the directory/swarm or the board endpoint\n\
                     is unreachable.",
                ))
                .wrap(Wrap { trim: false })
                .style(Theme::panel())
                .block(Theme::block(Line::from(format!(" ⌕ {key} ")), false)),
                area,
            );
        }
    }
}

/// One row's dossier: identity always; every other C-3 section ONLY when
/// present (absent field = the tier lacks that data — hidden, not zeroed).
/// `full` is the hive-pane mode (adds the tier-2/3 status header semantics
/// B-10's drill-in tab relies on — queen/wake/live status ride here).
fn draw_detail(f: &mut Frame, area: Rect, row: &NetworkBoardRow, full: bool) {
    let mut lines: Vec<Line> = Vec::new();

    // Identity (always present per C-3).
    lines.push(Line::from(vec![
        Span::styled(format!(" {} ", tier_badge(row)), tier_badge_style(row)),
        Span::raw(" "),
        Span::styled(row.key.clone(), Theme::dim()),
    ]));
    let trust_note = match row.trust.as_str() {
        "local" => "this install",
        "admin" => "yours (admin)",
        "federated" => "substrate-verified peer",
        "gossip" => "self-reported (unverified beacon)",
        _ => "",
    };
    if !trust_note.is_empty() {
        lines.push(Line::from(vec![
            Span::raw(" trust: "),
            Span::styled(format!("{} — {}", row.trust, trust_note), tier_badge_style(row)),
        ]));
    }

    // Status section — only the fields this tier reported.
    let mut status: Vec<String> = Vec::new();
    if let Some(n) = row.live_agents {
        status.push(format!("{n} live agents"));
    }
    if let Some(n) = row.queue_depth {
        status.push(format!("queue {n}"));
    }
    if let Some(ts) = &row.last_seen {
        status.push(format!("last seen {ts}"));
    }
    if !status.is_empty() {
        lines.push(Line::from(format!(" {}", status.join(" · "))));
    }
    if let Some(fo) = row.focus.as_ref().filter(|s| !s.is_empty()) {
        lines.push(Line::from(vec![
            Span::raw(" focus: "),
            Span::styled(fo.clone(), Theme::info()),
        ]));
    }

    // Wake section (own hives) — the tier-2/3 drill-in header data.
    if let Some(w) = &row.wake {
        let mut s = format!(" wake: {}", if w.active { "active" } else { "inactive" });
        if let Some(t) = &w.next_fire_at {
            s.push_str(&format!(" · next fire {t}"));
        }
        lines.push(Line::from(s));
    }

    // Grants section (foreign peers with a cross-hive relationship).
    if let Some(g) = &row.grants {
        let fmt = |v: &Vec<String>| {
            if v.is_empty() {
                "—".to_string()
            } else {
                v.join(", ")
            }
        };
        lines.push(Line::from(format!(
            " grants — in: {} · out: {}",
            fmt(&g.inbound),
            fmt(&g.outbound)
        )));
    }

    // Asks section (the P-002 ledger counts for this peer).
    if let Some(a) = &row.asks {
        lines.push(Line::from(format!(
            " asks — {} pending · {} answered",
            a.pending, a.answered
        )));
    }

    // Key hints (the pane owns its whole keymap — pinned dock convention).
    lines.push(Line::from(""));
    let hint = if full {
        " g refresh".to_string()
    } else if row.tier <= 1 {
        " ⏎ go to the 'this hive' tab · g refresh".to_string()
    } else {
        " ⏎ open hive tab · g refresh".to_string()
    };
    lines.push(Line::from(Span::styled(hint, Theme::dim())));

    let title = if row.title.is_empty() { &row.key } else { &row.title };
    f.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .style(Theme::panel())
            .block(Theme::block(Line::from(format!(" {title} ")), full)),
        area,
    );
}

/// The dossier's beacon HISTORY (P-014 item 2, `network.hive.beacons`): one
/// line per captured C-2 snapshot, newest-first — how the foreign hive's
/// self-reported status evolved. Gossip trust: rendered data, never actions.
fn draw_beacon_history(f: &mut Frame, app: &App, area: Rect) {
    let lines: Vec<Line> = app
        .hive_beacons
        .iter()
        .map(|s| {
            let b = &s.beacon;
            let focus = if b.focus.is_empty() {
                String::new()
            } else {
                format!(" · {}", trunc(&b.focus, 40))
            };
            let last = if b.last_completed.is_empty() {
                String::new()
            } else {
                format!(" · last: {}", trunc(&b.last_completed, 30))
            };
            Line::from(vec![
                Span::styled(format!(" {} ", trunc(&s.captured_at, 19)), Theme::dim()),
                Span::raw(format!(
                    "{} agents · queue {}{focus}{last}",
                    b.live_agents, b.queue_depth
                )),
            ])
        })
        .collect();
    let n = app.hive_beacons.len();
    f.render_widget(
        Paragraph::new(lines)
            .style(Theme::panel())
            .block(Theme::block(Line::from(format!(" beacon history — {n} ")), false)),
        area,
    );
}

/// The dossier's ask/answer TRAFFIC log (P-014 item 2, `network.hive.asks`):
/// every C-1 ledger row with this peer, both directions, all states,
/// newest-first (the board row only carries pending/answered counts).
fn draw_ask_log(f: &mut Frame, app: &App, area: Rect) {
    let lines: Vec<Line> = app
        .hive_asks
        .iter()
        .map(|a| {
            let dir = if a.direction == "in" { "←" } else { "→" };
            let state_style = match a.state.as_str() {
                "answered" => Theme::success(),
                "declined" | "expired" => Theme::warn(),
                _ => Theme::info(),
            };
            let reply = a
                .reply_body
                .as_ref()
                .filter(|r| !r.is_empty())
                .map(|r| format!(" · {}", trunc(r, 36)))
                .unwrap_or_default();
            Line::from(vec![
                Span::styled(format!(" {} ", trunc(&a.created_at, 19)), Theme::dim()),
                Span::raw(format!("{dir} {} ", a.kind)),
                Span::styled(format!("{:<9}", a.state), state_style),
                Span::raw(format!(" {}{reply}", trunc(&a.subject, 36))),
            ])
        })
        .collect();
    let n = app.hive_asks.len();
    f.render_widget(
        Paragraph::new(lines)
            .style(Theme::panel())
            .block(Theme::block(Line::from(format!(" ask log — {n} ")), false)),
        area,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{NetworkAsks, NetworkGrants, NetworkWake};
    use ratatui::{backend::TestBackend, Terminal};

    /// A C-3 wire fixture exercising every field, incl. the `in` keyword
    /// rename and camelCase mappings — the row→model half of the contract.
    #[test]
    fn parses_the_pinned_c3_row_shape() {
        let json = r#"{
            "tier": 4,
            "key": "pk-b64-abc",
            "title": "Ash Hive",
            "trust": "gossip",
            "liveAgents": 3,
            "queueDepth": 7,
            "focus": "shop migration",
            "lastSeen": "2026-06-11T20:00:00Z",
            "watchOwners": ["su-aaa", "su-bbb"],
            "wake": { "active": true, "nextFireAt": "2026-06-11T21:00:00Z" },
            "grants": { "in": ["ask"], "out": ["ask", "work-request"] },
            "asks": { "pending": 2, "answered": 5 }
        }"#;
        let row: NetworkBoardRow = serde_json::from_str(json).unwrap();
        assert_eq!(row.tier, 4);
        assert_eq!(row.key, "pk-b64-abc");
        assert_eq!(row.trust, "gossip");
        assert_eq!(row.live_agents, Some(3));
        assert_eq!(row.queue_depth, Some(7));
        assert_eq!(row.last_seen.as_deref(), Some("2026-06-11T20:00:00Z"));
        assert_eq!(row.watch_owners, vec!["su-aaa", "su-bbb"]);
        let w = row.wake.unwrap();
        assert!(w.active);
        assert_eq!(w.next_fire_at.as_deref(), Some("2026-06-11T21:00:00Z"));
        let g = row.grants.unwrap();
        assert_eq!(g.inbound, vec!["ask"]);
        assert_eq!(g.outbound, vec!["ask", "work-request"]);
        let a = row.asks.unwrap();
        assert_eq!((a.pending, a.answered), (2, 5));
    }

    /// C-3's structural rule: absent optional field = the tier lacks the data.
    /// A minimal tier-1 row parses with every optional section None.
    #[test]
    fn absent_c3_fields_parse_as_none() {
        let json = r#"{ "tier": 1, "key": "papercup", "title": "papercup", "trust": "local" }"#;
        let row: NetworkBoardRow = serde_json::from_str(json).unwrap();
        assert_eq!(row.live_agents, None);
        assert_eq!(row.queue_depth, None);
        assert_eq!(row.focus, None);
        assert_eq!(row.last_seen, None);
        assert!(row.watch_owners.is_empty());
        assert!(row.wake.is_none() && row.grants.is_none() && row.asks.is_none());
    }

    fn t1() -> NetworkBoardRow {
        NetworkBoardRow {
            tier: 1,
            key: "papercup".into(),
            title: "papercup".into(),
            trust: "local".into(),
            live_agents: Some(12),
            queue_depth: Some(4),
            wake: Some(NetworkWake {
                active: true,
                next_fire_at: Some("2026-06-11T23:00:00Z".into()),
            }),
            ..Default::default()
        }
    }

    fn t3() -> NetworkBoardRow {
        NetworkBoardRow {
            tier: 3,
            key: "pk-peer-1".into(),
            title: "tower swarm".into(),
            trust: "federated".into(),
            live_agents: Some(2),
            last_seen: Some("2026-06-11T19:00:00Z".into()),
            watch_owners: vec!["fed:1@boxA".into(), "fed:2@boxA".into()],
            ..Default::default()
        }
    }

    fn t4() -> NetworkBoardRow {
        NetworkBoardRow {
            tier: 4,
            key: "pk-foreign".into(),
            title: "Ash Hive".into(),
            trust: "gossip".into(),
            focus: Some("shop migration".into()),
            grants: Some(NetworkGrants {
                inbound: vec!["ask".into()],
                outbound: vec![],
            }),
            asks: Some(NetworkAsks {
                pending: 2,
                answered: 5,
            }),
            ..Default::default()
        }
    }

    #[test]
    fn tier_badges_compress_trust_and_stay_distinct() {
        assert_eq!(tier_badge(&t1()), "T1·local");
        assert_eq!(tier_badge(&t3()), "T3·fed");
        assert_eq!(tier_badge(&t4()), "T4·gossip");
        // Federated (verified) and gossip (self-reported) must never share a
        // style — the P-009 conflation this surface exists to fix.
        assert_ne!(tier_badge_style(&t3()), tier_badge_style(&t4()));
    }

    #[test]
    fn drill_in_maps_the_selected_row() {
        let req = drill_in(&t4());
        assert_eq!(
            req,
            DrillInRequest {
                tier: 4,
                key: "pk-foreign".into(),
                title: "Ash Hive".into(),
                trust: "gossip".into(),
                watch_owners: vec![],
            }
        );
        // Tiers 2/3 carry the per-bee watch owners through (P-014 item 1) —
        // the B-10 generator turns each into a `pui watch-pane <owner>`.
        let req = drill_in(&t3());
        assert_eq!(req.watch_owners, vec!["fed:1@boxA", "fed:2@boxA"]);
    }

    fn render(app: &App, w: u16, h: u16) -> String {
        let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
        term.draw(|f| draw_network(f, app, f.area())).unwrap();
        term.backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect()
    }

    #[test]
    fn renders_the_empty_state() {
        let app = App::new();
        let text = render(&app, 100, 24);
        assert!(text.contains("no hive-contexts on the network board yet"));
    }

    #[test]
    fn renders_rows_with_tier_badges_and_headline() {
        let mut app = App::new();
        app.network_rows = vec![t1(), t3(), t4()];
        let text = render(&app, 120, 30);
        assert!(text.contains("3 hive-contexts"));
        // 12 + 2 live agents (t4 reports none — absent ≠ 0).
        assert!(text.contains("14 live agents"));
        assert!(text.contains("2 asks pending"));
        assert!(text.contains("T1·local"));
        assert!(text.contains("T3·fed"));
        assert!(text.contains("T4·gossip"));
        assert!(text.contains("tower swarm"));
        assert!(text.contains("Ash Hive"));
    }

    #[test]
    fn detail_hides_absent_sections_per_c3() {
        let mut app = App::new();
        // Selected tier-1 row: no grants/asks sections may render.
        app.network_rows = vec![t1(), t4()];
        app.network_sel = 0;
        let text = render(&app, 120, 30);
        assert!(text.contains("wake: active"));
        assert!(!text.contains("grants —"));
        assert!(!text.contains("asks —"));
        // Selected tier-4 row: grants/asks render, wake doesn't.
        app.network_sel = 1;
        let text = render(&app, 120, 30);
        assert!(text.contains("grants — in: ask · out: —"));
        assert!(text.contains("asks — 2 pending · 5 answered"));
        assert!(text.contains("self-reported"));
        assert!(!text.contains("wake:"));
    }

    #[test]
    fn focused_hive_pane_renders_one_dossier_or_waits() {
        let mut app = App::new();
        app.network_rows = vec![t1(), t4()];
        app.network_focus = Some("pk-foreign".into());
        let text = render(&app, 100, 24);
        // The focused dossier, not the board list.
        assert!(text.contains("Ash Hive"));
        assert!(text.contains("asks — 2 pending"));
        assert!(!text.contains("network board —"));
        // An unknown key waits honestly.
        app.network_focus = Some("pk-gone".into());
        let text = render(&app, 100, 24);
        assert!(text.contains("not on the network board"));
    }

    #[test]
    fn reducer_stores_rows_and_clamps_selection() {
        let mut app = App::new();
        app.network_rows = vec![t1(), t3(), t4()];
        app.network_sel = 2;
        app.update(crate::event::Event::NetworkBoard(vec![t1()]));
        assert_eq!(app.network_rows.len(), 1);
        assert_eq!(app.network_sel, 0);
    }

    #[test]
    fn focused_hive_pane_renders_dossier_sections_when_populated() {
        // P-014 item 2: the hive-pane grows beacon-history + ask-log sections
        // when the dossier queries return data — hidden otherwise (C-3 rule,
        // asserted by focused_hive_pane_renders_one_dossier_or_waits above).
        let mut app = App::new();
        app.network_rows = vec![t4()];
        app.network_focus = Some("pk-foreign".into());
        app.update(crate::event::Event::HiveDossier {
            beacons: vec![crate::models::HiveBeaconSnapshot {
                hive_id: "ash".into(),
                hive_pubkey: Some("pk-foreign".into()),
                beacon: crate::models::BeaconFields {
                    live_agents: 4,
                    queue_depth: 9,
                    focus: "shop migration".into(),
                    last_completed: "checkout revamp".into(),
                    ts: "2026-06-11T20:00:00Z".into(),
                },
                captured_at: "2026-06-11T20:00:01Z".into(),
            }],
            asks: vec![crate::models::CrossHiveAskRow {
                peer_pubkey: "pk-foreign".into(),
                direction: "out".into(),
                kind: "ask".into(),
                subject: "schema advice".into(),
                state: "answered".into(),
                reply_body: Some("use mig-196 conventions".into()),
                asked_by: Some("su-queen".into()),
                created_at: "2026-06-11T18:00:00Z".into(),
                updated_at: "2026-06-11T19:00:00Z".into(),
            }],
        });
        let text = render(&app, 120, 40);
        assert!(text.contains("beacon history — 1"));
        assert!(text.contains("4 agents · queue 9"));
        assert!(text.contains("shop migration"));
        assert!(text.contains("ask log — 1"));
        assert!(text.contains("answered"));
        assert!(text.contains("schema advice"));
        assert!(text.contains("use mig-196 conventions"));
        // The detail header still leads the pane.
        assert!(text.contains("T4·gossip"));
    }
}
