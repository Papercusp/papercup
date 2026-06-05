//! Central style palette (SP-TUI A5). Kept generic for now; brand/design-phase
//! tokens can replace these constants later without touching the views.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;

use crate::glyph;

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

    // ---- Semantic glyph styling (Brief 27 / tui-glyph-vocabulary) ----
    // The glyph SHAPE comes from `crate::glyph`; the COLOUR is paired here.
    // Call sites render `Theme::*_marker(token)` to get a styled `Span` in
    // one go, instead of inlining a glyph + a colour separately.

    /// Colour for a work-item / plan-item status token.
    pub fn status_style(token: &str) -> Style {
        match token.trim().to_ascii_lowercase().as_str() {
            "wip" | "doing" | "in_progress" | "in-progress" | "active" | "validating"
            | "running" | "review" => Style::default().fg(Color::Cyan),
            "blocked" => Style::default().fg(Color::Red),
            "done" | "completed" | "complete" | "passed" | "shipped" | "resolved" | "closed" => {
                Style::default().fg(Color::Green)
            }
            "failing" | "failed" | "error" => Style::default().fg(Color::Red),
            "needs-human" | "needs_human" | "needshuman" => Style::default().fg(Color::Magenta),
            // todo / dropped / unknown read as de-emphasised.
            _ => Style::default().add_modifier(Modifier::DIM),
        }
    }

    /// Colour for an agent-liveness dot.
    pub fn liveness_style(stale: bool, liveness: &str) -> Style {
        if stale {
            Style::default().add_modifier(Modifier::DIM)
        } else if liveness.eq_ignore_ascii_case("live") {
            Style::default().fg(Color::Green)
        } else {
            Style::default().fg(Color::Yellow)
        }
    }

    /// Colour for a curated-signal kind (escalation/blocker/decision/…).
    pub fn signal_style(kind: &str) -> Style {
        match kind.trim().to_ascii_lowercase().as_str() {
            "escalation" => Style::default().fg(Color::Yellow),
            "blocker" => Style::default().fg(Color::Red),
            "completion" => Style::default().fg(Color::Green),
            _ => Style::default().add_modifier(Modifier::DIM),
        }
    }

    /// A status glyph + its colour as a ready-to-render `Span`.
    pub fn status_marker(token: &str) -> Span<'static> {
        Span::styled(glyph::status_for(token), Self::status_style(token))
    }

    /// An agent-liveness dot + its colour as a `Span`.
    pub fn liveness_marker(stale: bool, liveness: &str) -> Span<'static> {
        Span::styled(
            glyph::liveness_dot(stale, liveness),
            Self::liveness_style(stale, liveness),
        )
    }

    /// A curated-signal glyph + its colour as a `Span`.
    pub fn signal_marker(kind: &str) -> Span<'static> {
        Span::styled(glyph::signal_for(kind), Self::signal_style(kind))
    }
}
