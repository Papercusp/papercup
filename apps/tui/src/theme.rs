//! Central style palette (SP-TUI A5). Kept generic for now; brand/design-phase
//! tokens can replace these constants later without touching the views.

use ratatui::style::{Color, Modifier, Style};

pub struct Theme;

impl Theme {
    /// Selected list row / active tab.
    pub fn selected() -> Style {
        Style::default()
            .fg(Color::Black)
            .bg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    }
    pub fn dim() -> Style {
        Style::default().add_modifier(Modifier::DIM)
    }
    pub fn warn() -> Style {
        Style::default().fg(Color::Yellow)
    }
    /// Notification flash in the status bar (accent, not an error).
    pub fn notify() -> Style {
        Style::default()
            .fg(Color::Green)
            .add_modifier(Modifier::BOLD)
    }
    /// Column-header row above a list (D-005, pui-completion-and-polish).
    pub fn header() -> Style {
        Style::default().add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
    }
}
