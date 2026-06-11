//! The agent pane (owner ask 2026-06-11) — ONE pui pane that internally splits
//! into [agent chat | agent wake queue], the same single-pane-internal-split
//! shape as the colony tab (roster | dossier). So an agent's chat and its
//! staged wakes sit side by side in one pane, rendered entirely by pui, instead
//! of two separate zellij panes (zellij can't split a stacked member, and the
//! split belongs to pui anyway — the colony-tab pattern).
//!
//! Rendered by the dock's pinned `pui agent-pane --queen|<owner>`. The left half
//! reuses the operator chat (`ui::draw_chat`); the right half reuses the
//! per-agent wake board (`wake_board::draw_wake_board`, scoped by `wake_filter`).
//! `agent_focus` (Tab toggles) decides which half drives the keymap; a tinted
//! header marks the focused half.

use crate::app::{AgentHalf, App};
use crate::theme::Theme;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

pub fn draw_agent_pane(f: &mut Frame, app: &App, area: Rect) {
    // Chat takes the larger left share (you read/type there); wakes a compact
    // right column — mirrors the colony tab's 46/54 roster|dossier split.
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(58), Constraint::Percentage(42)])
        .split(area);

    // Each half: a 1-line focus header + the body. The focused half's header is
    // highlighted so it's clear which side the keys drive (Tab switches).
    let chat = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(1)])
        .split(cols[0]);
    let wakes = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(1)])
        .split(cols[1]);

    let chat_focused = app.agent_focus == AgentHalf::Chat;
    let header = |label: &str, focused: bool| {
        let style = if focused { Theme::title() } else { Theme::dim() };
        let marker = if focused { "▌ " } else { "  " };
        Paragraph::new(Line::from(Span::styled(format!("{marker}{label}"), style)))
    };
    f.render_widget(header(" chat", chat_focused), chat[0]);
    f.render_widget(header(" ⏸ wakes  ·  Tab switches half", !chat_focused), wakes[0]);

    crate::ui::draw_chat(f, app, chat[1]);
    crate::wake_board::draw_wake_board(f, app, wakes[1]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{backend::TestBackend, Terminal};

    fn render(app: &App) -> String {
        let backend = TestBackend::new(120, 16);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw_agent_pane(f, app, f.area())).unwrap();
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
    fn renders_both_halves_with_a_focus_marker_that_follows_agent_focus() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Agent;
        app.wake_board.loading = false;
        // Chat-focused: the chat header carries the ▌ marker, wakes is dim.
        app.agent_focus = AgentHalf::Chat;
        let s = render(&app);
        assert!(s.contains("chat"), "chat half: {s}");
        assert!(s.contains("⏸ wakes"), "wakes half: {s}");
        assert!(s.contains("Tab switches half"), "focus hint: {s}");
        let chat_line = s.lines().find(|l| l.contains("chat")).unwrap();
        assert!(chat_line.contains('▌'), "chat focused → marker on chat: {s}");
        // Wakes-focused: the marker moves to the wakes header.
        app.agent_focus = AgentHalf::Wakes;
        let s = render(&app);
        let wakes_line = s.lines().find(|l| l.contains("⏸ wakes")).unwrap();
        assert!(wakes_line.contains('▌'), "wakes focused → marker on wakes: {s}");
    }
}
