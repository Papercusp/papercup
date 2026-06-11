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

use crate::app::{AgentView, App};
use crate::theme::Theme;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

/// A 1-line section header + a Tab hint, so the current zoom state + how to
/// change it read at a glance (mirrors the colony tab's `Tab: …` footer).
fn header(label: &str, hint: &str) -> Paragraph<'static> {
    Paragraph::new(Line::from(vec![
        Span::styled(format!(" {label}"), Theme::title()),
        Span::styled(format!("   {hint}"), Theme::dim()),
    ]))
}

pub fn draw_agent_pane(f: &mut Frame, app: &App, area: Rect) {
    match app.agent_view {
        // Chat fullscreen — `Tab` next zooms the wakes board.
        AgentView::ChatFull => {
            let rows = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Length(1), Constraint::Min(1)])
                .split(area);
            f.render_widget(header("chat", "Tab → ⏸ wakes fullscreen"), rows[0]);
            crate::ui::draw_chat(f, app, rows[1]);
        }
        // Wake board fullscreen — its review keys drive it; `Tab` returns to split.
        AgentView::WakesFull => {
            let rows = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Length(1), Constraint::Min(1)])
                .split(area);
            f.render_widget(header("⏸ wakes", "review keys active · Tab → split"), rows[0]);
            crate::wake_board::draw_wake_board(f, app, rows[1]);
        }
        // Split: both visible. Chat (larger left) takes keys; wakes is a live
        // read-only review — `Tab` zooms the chat. Mirrors the colony tab's
        // 58/42 roster|dossier split.
        AgentView::Split => {
            let cols = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(58), Constraint::Percentage(42)])
                .split(area);
            let chat = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Length(1), Constraint::Min(1)])
                .split(cols[0]);
            let wakes = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Length(1), Constraint::Min(1)])
                .split(cols[1]);
            f.render_widget(header("chat", "Tab → fullscreen"), chat[0]);
            f.render_widget(header("⏸ wakes", "Tab Tab → fullscreen"), wakes[0]);
            crate::ui::draw_chat(f, app, chat[1]);
            crate::wake_board::draw_wake_board(f, app, wakes[1]);
        }
    }
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
    fn split_shows_both_halves_and_zoom_states_show_one() {
        let mut app = App::new();
        app.tab = crate::app::Tab::Agent;
        app.wake_board.loading = false;
        // Split: both headers + the fullscreen hints.
        app.agent_view = AgentView::Split;
        let s = render(&app);
        assert!(s.contains("chat"), "chat half: {s}");
        assert!(s.contains("⏸ wakes"), "wakes half: {s}");
        assert!(s.contains("Tab → fullscreen"), "split hint: {s}");
        // ChatFull: chat header + the "next zooms wakes" hint; no side-by-side.
        app.agent_view = AgentView::ChatFull;
        let s = render(&app);
        assert!(s.contains("Tab → ⏸ wakes fullscreen"), "chat-full hint: {s}");
        // WakesFull: the wakes header notes its review keys are active.
        app.agent_view = AgentView::WakesFull;
        let s = render(&app);
        assert!(s.contains("review keys active"), "wakes-full hint: {s}");
        assert!(s.contains("Tab → split"), "wakes-full back hint: {s}");
    }
}
