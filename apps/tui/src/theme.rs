//! Central style palette (SP-TUI A5). The PUI runs in terminals first, so the
//! palette favors high-contrast ANSI-safe RGB values over subtle web tints.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;

use crate::glyph;

pub struct Theme;

impl Theme {
    const INK: Color = Color::Rgb(232, 238, 232);
    const MUTED: Color = Color::Rgb(134, 150, 146);
    const SUBTLE: Color = Color::Rgb(88, 106, 102);
    const PANEL: Color = Color::Rgb(9, 18, 20);
    const PANEL_ACTIVE: Color = Color::Rgb(15, 31, 34);
    const BORDER: Color = Color::Rgb(43, 67, 67);
    const BORDER_ACTIVE: Color = Color::Rgb(95, 219, 188);
    const ACCENT: Color = Color::Rgb(247, 181, 83);
    const ACCENT_HOT: Color = Color::Rgb(255, 211, 122);
    const SKY: Color = Color::Rgb(82, 183, 212);
    const SAGE: Color = Color::Rgb(104, 211, 145);
    const WARN: Color = Color::Rgb(247, 181, 83);
    const DANGER: Color = Color::Rgb(255, 111, 105);
    const HUMAN: Color = Color::Rgb(255, 139, 203);

    /// Base pane surface. Blocks use this so adjacent panes read as an intentional
    /// dashboard instead of raw terminal cells.
    pub fn panel() -> Style {
        Style::default().fg(Self::INK).bg(Self::PANEL)
    }

    /// Active pane surface.
    pub fn panel_active() -> Style {
        Style::default().fg(Self::INK).bg(Self::PANEL_ACTIVE)
    }

    pub fn border() -> Style {
        Style::default().fg(Self::BORDER)
    }

    pub fn border_active() -> Style {
        Style::default().fg(Self::BORDER_ACTIVE)
    }

    pub fn title() -> Style {
        Style::default().fg(Self::ACCENT_HOT).add_modifier(Modifier::BOLD)
    }

    pub fn title_active() -> Style {
        Style::default()
            .fg(Color::Black)
            .bg(Self::ACCENT_HOT)
            .add_modifier(Modifier::BOLD)
    }

    pub fn tab() -> Style {
        Style::default().fg(Self::MUTED).bg(Color::Rgb(6, 12, 14))
    }

    pub fn status_bar() -> Style {
        Style::default().fg(Self::MUTED).bg(Color::Rgb(5, 10, 12))
    }

    /// Selected list row / active tab.
    pub fn selected() -> Style {
        Style::default()
            .fg(Color::Black)
            .bg(Self::ACCENT_HOT)
            .add_modifier(Modifier::BOLD)
    }
    pub fn dim() -> Style {
        Style::default().fg(Self::MUTED)
    }
    pub fn warn() -> Style {
        Style::default().fg(Self::WARN).add_modifier(Modifier::BOLD)
    }
    pub fn danger() -> Style {
        Style::default().fg(Self::DANGER).add_modifier(Modifier::BOLD)
    }
    pub fn success() -> Style {
        Style::default().fg(Self::SAGE).add_modifier(Modifier::BOLD)
    }
    pub fn info() -> Style {
        Style::default().fg(Self::SKY).add_modifier(Modifier::BOLD)
    }
    pub fn accent() -> Style {
        Style::default().fg(Self::ACCENT).add_modifier(Modifier::BOLD)
    }
    /// Notification flash in the status bar (accent, not an error).
    pub fn notify() -> Style {
        Style::default()
            .fg(Self::SAGE)
            .add_modifier(Modifier::BOLD)
    }
    /// Column-header row above a list (D-005, pui-completion-and-polish).
    pub fn header() -> Style {
        Style::default()
            .fg(Self::ACCENT)
            .add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
    }
    pub fn quiet_header() -> Style {
        Style::default().fg(Self::SUBTLE).add_modifier(Modifier::BOLD)
    }

    // ---- Semantic glyph styling (Brief 27 / tui-glyph-vocabulary) ----
    // The glyph SHAPE comes from `crate::glyph`; the COLOUR is paired here.
    // Call sites render `Theme::*_marker(token)` to get a styled `Span` in
    // one go, instead of inlining a glyph + a colour separately.

    /// Colour for a work-item / plan-item status token.
    pub fn status_style(token: &str) -> Style {
        match token.trim().to_ascii_lowercase().as_str() {
            "wip" | "doing" | "in_progress" | "in-progress" | "active" | "validating"
            | "running" | "review" => Self::info(),
            "blocked" => Self::danger(),
            "done" | "completed" | "complete" | "passed" | "shipped" | "resolved" | "closed" => {
                Self::success()
            }
            "failing" | "failed" | "error" => Self::danger(),
            "needs-human" | "needs_human" | "needshuman" => Style::default()
                .fg(Self::HUMAN)
                .add_modifier(Modifier::BOLD),
            // todo / dropped / unknown read as de-emphasised.
            _ => Self::dim(),
        }
    }

    /// Colour for an agent-liveness dot.
    pub fn liveness_style(stale: bool, liveness: &str) -> Style {
        if stale {
            Self::dim()
        } else if liveness.eq_ignore_ascii_case("live") {
            Self::success()
        } else {
            Self::warn()
        }
    }

    /// Colour for a curated-signal kind (escalation/blocker/decision/…).
    pub fn signal_style(kind: &str) -> Style {
        match kind.trim().to_ascii_lowercase().as_str() {
            "escalation" => Self::warn(),
            "blocker" => Self::danger(),
            "completion" => Self::success(),
            "decision" => Style::default().fg(Self::HUMAN).add_modifier(Modifier::BOLD),
            _ => Self::dim(),
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
