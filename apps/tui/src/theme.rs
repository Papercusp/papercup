//! Central style palette (SP-TUI A5). The PUI runs in terminals first, so the
//! palette favors high-contrast ANSI-safe RGB values over subtle web tints.
//!
//! Themes-as-data (workbench-theme-system-2026-06-05 D-001). Every colour the
//! workbench renders lives in a [`ThemeSpec`] slot — there are **no colour
//! literals outside this file** (the call sites in `ui.rs`/`fleet.rs`/`glyph.rs`
//! draw exclusively through the named `Theme::*` accessors below). `theme.rs` is
//! a registry over `ThemeSpec`; the accessors read the *active* spec, so a future
//! `:theme` switcher (P1) only needs to flip which spec [`Theme::active`] returns.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders};

use crate::glyph;

/// A named semantic palette. Themes are data: one `ThemeSpec` per theme holds
/// every colour slot the workbench draws from. Adding a theme = adding a
/// `ThemeSpec` const + registering it in [`THEMES`]; no draw site changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThemeSpec {
    /// Stable theme id (used by `:theme <name>` and persistence in P1).
    pub name: &'static str,
    // ── base layers ──────────────────────────────────────────────────────
    /// Primary foreground text.
    pub ink: Color,
    /// De-emphasised / secondary text.
    pub muted: Color,
    /// Base pane surface.
    pub panel: Color,
    /// Active (focused) pane surface.
    pub panel_active: Color,
    /// Inactive pane border.
    pub border: Color,
    /// Active pane border.
    pub border_active: Color,
    /// Accent (titles, headers).
    pub accent: Color,
    /// Hot accent (selected row / active title fill).
    pub accent_hot: Color,
    /// Foreground rendered on top of an `accent_hot` fill (selected / title_active).
    pub on_accent: Color,
    // ── semantic hues (status / liveness / signal map onto these) ─────────
    /// Informational / in-progress hue.
    pub sky: Color,
    /// Success / live / done hue.
    pub sage: Color,
    /// Warning / idle hue.
    pub warn: Color,
    /// Danger / blocked / failure hue.
    pub danger: Color,
    /// Human-attention hue (needs-human, decisions).
    pub human: Color,
    // ── chrome surfaces ──────────────────────────────────────────────────
    /// Modal / floating overlay surface.
    pub popup: Color,
    /// Text-input / command-line surface.
    pub input: Color,
    /// Status-bar surface.
    pub status: Color,
    /// Tab-bar surface.
    pub tab_bar_bg: Color,
}

/// Blue Frost — the operator's default theme, adapted to terminal RGB slots.
/// Honeycomb remains selectable, but new sessions should open on the classic
/// frost baseline unless a future persisted theme switcher says otherwise.
pub const BLUE_FROST: ThemeSpec = ThemeSpec {
    name: "frost",
    ink: Color::Rgb(231, 247, 255),
    muted: Color::Rgb(185, 212, 232),
    panel: Color::Rgb(7, 16, 29),
    panel_active: Color::Rgb(11, 18, 32),
    border: Color::Rgb(42, 78, 103),
    border_active: Color::Rgb(125, 211, 252),
    accent: Color::Rgb(56, 189, 248),
    accent_hot: Color::Rgb(125, 211, 252),
    on_accent: Color::Rgb(5, 24, 39),
    sky: Color::Rgb(56, 189, 248),
    sage: Color::Rgb(52, 211, 153),
    warn: Color::Rgb(251, 191, 36),
    danger: Color::Rgb(251, 113, 133),
    human: Color::Rgb(244, 114, 182),
    popup: Color::Rgb(13, 24, 41),
    input: Color::Rgb(3, 10, 20),
    status: Color::Rgb(2, 6, 12),
    tab_bar_bg: Color::Rgb(3, 10, 20),
};

/// The original PUI theme — the styling pass's polished palette, ported byte-for-byte
/// (workbench-theme-system D-004). This is the single source of every colour the
/// workbench previously hardcoded as `Theme::*` consts.
pub const PAPERCUSP_DARK: ThemeSpec = ThemeSpec {
    name: "papercusp-dark",
    ink: Color::Rgb(232, 238, 232),
    muted: Color::Rgb(134, 150, 146),
    panel: Color::Rgb(9, 18, 20),
    panel_active: Color::Rgb(15, 31, 34),
    border: Color::Rgb(43, 67, 67),
    border_active: Color::Rgb(95, 219, 188),
    accent: Color::Rgb(247, 181, 83),
    accent_hot: Color::Rgb(255, 211, 122),
    on_accent: Color::Black,
    sky: Color::Rgb(82, 183, 212),
    sage: Color::Rgb(104, 211, 145),
    warn: Color::Rgb(247, 181, 83),
    danger: Color::Rgb(255, 111, 105),
    human: Color::Rgb(255, 139, 203),
    popup: Color::Rgb(13, 23, 26),
    input: Color::Rgb(3, 8, 10),
    status: Color::Rgb(5, 10, 12),
    tab_bar_bg: Color::Rgb(6, 12, 14),
};

/// Honeycomb — The Swarm terminal palette. Matches the operator Honeycomb token
/// theme: ominous charcoal surfaces, honey-amber signal, and restrained semantic
/// hues for status.
pub const HONEYCOMB: ThemeSpec = ThemeSpec {
    name: "honeycomb",
    ink: Color::Rgb(255, 247, 223),
    muted: Color::Rgb(185, 170, 134),
    panel: Color::Rgb(5, 5, 5),
    panel_active: Color::Rgb(16, 16, 11),
    border: Color::Rgb(93, 70, 18),
    border_active: Color::Rgb(234, 179, 8),
    accent: Color::Rgb(234, 179, 8),
    accent_hot: Color::Rgb(253, 230, 138),
    on_accent: Color::Rgb(19, 13, 3),
    sky: Color::Rgb(250, 204, 21),
    sage: Color::Rgb(74, 222, 128),
    warn: Color::Rgb(253, 230, 138),
    danger: Color::Rgb(248, 113, 113),
    human: Color::Rgb(251, 146, 60),
    popup: Color::Rgb(16, 16, 11),
    input: Color::Rgb(3, 3, 3),
    status: Color::Rgb(8, 8, 6),
    tab_bar_bg: Color::Rgb(5, 5, 5),
};

/// Registry of built-in themes. P1 — the `:theme` switcher — adds a
/// live-selectable, ViewState-persisted active theme.
pub const THEMES: &[&ThemeSpec] = &[&BLUE_FROST, &HONEYCOMB, &PAPERCUSP_DARK];

/// Default active theme id. P1 (the `:theme` switcher) overrides this with the
/// ViewState-persisted selection; P0 always resolves to it.
pub const DEFAULT_THEME: &str = "frost";

/// Resolve a theme by name, or `None` if unknown (callers list `THEMES` on a
/// miss rather than erroring silently — workbench-theme-system D-002).
pub fn theme_by_name(name: &str) -> Option<&'static ThemeSpec> {
    THEMES.iter().copied().find(|t| t.name == name)
}

pub struct Theme;

impl Theme {
    /// The active palette every accessor reads from — resolved *through* the
    /// registry (D-001). P0 always resolves `DEFAULT_THEME`; P1 swaps in the
    /// persisted `:theme` selection, at which point a full re-render re-themes
    /// the whole workbench. Falls back to the const if the name ever misses.
    #[inline]
    pub fn active() -> &'static ThemeSpec {
        theme_by_name(DEFAULT_THEME).unwrap_or(&PAPERCUSP_DARK)
    }

    /// Base pane surface. Blocks use this so adjacent panes read as an intentional
    /// dashboard instead of raw terminal cells.
    pub fn panel() -> Style {
        let t = Self::active();
        Style::default().fg(t.ink).bg(t.panel)
    }

    /// Active pane surface.
    pub fn panel_active() -> Style {
        let t = Self::active();
        Style::default().fg(t.ink).bg(t.panel_active)
    }

    /// Modal and floating overlay surface.
    pub fn popup() -> Style {
        let t = Self::active();
        Style::default().fg(t.ink).bg(t.popup)
    }

    /// Text input / command-line surface.
    pub fn input() -> Style {
        let t = Self::active();
        Style::default().fg(t.ink).bg(t.input)
    }

    pub fn border() -> Style {
        Style::default().fg(Self::active().border)
    }

    pub fn border_active() -> Style {
        Style::default().fg(Self::active().border_active)
    }

    pub fn title() -> Style {
        Style::default()
            .fg(Self::active().accent_hot)
            .add_modifier(Modifier::BOLD)
    }

    pub fn title_active() -> Style {
        let t = Self::active();
        Style::default()
            .fg(t.on_accent)
            .bg(t.accent_hot)
            .add_modifier(Modifier::BOLD)
    }

    pub fn status_bar() -> Style {
        let t = Self::active();
        Style::default().fg(t.muted).bg(t.status)
    }

    pub fn status_text(style: Style) -> Style {
        style.bg(Self::active().status)
    }

    pub fn tab_bar() -> Style {
        let t = Self::active();
        Style::default().fg(t.muted).bg(t.tab_bar_bg)
    }

    /// Selected list row / active tab.
    pub fn selected() -> Style {
        let t = Self::active();
        Style::default()
            .fg(t.on_accent)
            .bg(t.accent_hot)
            .add_modifier(Modifier::BOLD)
    }

    pub fn dim() -> Style {
        Style::default().fg(Self::active().muted)
    }
    pub fn warn() -> Style {
        Style::default()
            .fg(Self::active().warn)
            .add_modifier(Modifier::BOLD)
    }
    pub fn danger() -> Style {
        Style::default()
            .fg(Self::active().danger)
            .add_modifier(Modifier::BOLD)
    }
    pub fn success() -> Style {
        Style::default()
            .fg(Self::active().sage)
            .add_modifier(Modifier::BOLD)
    }
    pub fn info() -> Style {
        Style::default()
            .fg(Self::active().sky)
            .add_modifier(Modifier::BOLD)
    }
    /// Notification flash in the status bar (accent, not an error).
    pub fn notify() -> Style {
        Style::default()
            .fg(Self::active().sage)
            .add_modifier(Modifier::BOLD)
    }
    /// Column-header row above a list (D-005, pui-completion-and-polish).
    pub fn header() -> Style {
        Style::default()
            .fg(Self::active().accent)
            .add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
    }

    /// Standard bordered workbench pane. Use this instead of hand-rolled
    /// `Block::default()` so every tab participates in the same palette.
    pub fn block(title: Line<'static>, active: bool) -> Block<'static> {
        Block::default()
            .borders(Borders::ALL)
            .style(if active {
                Self::panel_active()
            } else {
                Self::panel()
            })
            .border_style(if active {
                Self::border_active()
            } else {
                Self::border()
            })
            .title_style(if active {
                Self::title_active()
            } else {
                Self::title()
            })
            .title(title)
    }

    /// Floating modal block. Popups get a distinct surface but share the active
    /// border/title treatment so they read as focused workbench chrome.
    pub fn popup_block(title: Line<'static>) -> Block<'static> {
        Block::default()
            .borders(Borders::ALL)
            .style(Self::popup())
            .border_style(Self::border_active())
            .title_style(Self::title_active())
            .title(title)
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
                .fg(Self::active().human)
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;
    use ratatui::text::Line;
    use ratatui::widgets::{Paragraph, Widget};

    /// Byte-identical pin: the active palette must equal the polished
    /// `papercusp-dark` values the consts encoded before the registry refactor.
    /// If a slot value drifts, this trips — the refactor is colour-preserving.
    #[test]
    fn papercusp_dark_slots_are_byte_identical() {
        let t = theme_by_name("papercusp-dark").expect("papercusp-dark theme");
        assert_eq!(t.name, "papercusp-dark");
        assert_eq!(t.ink, Color::Rgb(232, 238, 232));
        assert_eq!(t.muted, Color::Rgb(134, 150, 146));
        assert_eq!(t.panel, Color::Rgb(9, 18, 20));
        assert_eq!(t.panel_active, Color::Rgb(15, 31, 34));
        assert_eq!(t.border, Color::Rgb(43, 67, 67));
        assert_eq!(t.border_active, Color::Rgb(95, 219, 188));
        assert_eq!(t.accent, Color::Rgb(247, 181, 83));
        assert_eq!(t.accent_hot, Color::Rgb(255, 211, 122));
        assert_eq!(t.on_accent, Color::Black);
        assert_eq!(t.sky, Color::Rgb(82, 183, 212));
        assert_eq!(t.sage, Color::Rgb(104, 211, 145));
        assert_eq!(t.warn, Color::Rgb(247, 181, 83));
        assert_eq!(t.danger, Color::Rgb(255, 111, 105));
        assert_eq!(t.human, Color::Rgb(255, 139, 203));
        assert_eq!(t.popup, Color::Rgb(13, 23, 26));
        assert_eq!(t.input, Color::Rgb(3, 8, 10));
        assert_eq!(t.status, Color::Rgb(5, 10, 12));
        assert_eq!(t.tab_bar_bg, Color::Rgb(6, 12, 14));
    }

    #[test]
    fn blue_frost_is_the_default_active_palette() {
        let t = Theme::active();
        assert_eq!(t.name, "frost");
        assert_eq!(t.ink, Color::Rgb(231, 247, 255));
        assert_eq!(t.muted, Color::Rgb(185, 212, 232));
        assert_eq!(t.panel, Color::Rgb(7, 16, 29));
        assert_eq!(t.panel_active, Color::Rgb(11, 18, 32));
        assert_eq!(t.border, Color::Rgb(42, 78, 103));
        assert_eq!(t.border_active, Color::Rgb(125, 211, 252));
        assert_eq!(t.accent, Color::Rgb(56, 189, 248));
        assert_eq!(t.accent_hot, Color::Rgb(125, 211, 252));
        assert_eq!(t.on_accent, Color::Rgb(5, 24, 39));
        assert_eq!(t.sky, Color::Rgb(56, 189, 248));
        assert_eq!(t.sage, Color::Rgb(52, 211, 153));
        assert_eq!(t.warn, Color::Rgb(251, 191, 36));
        assert_eq!(t.danger, Color::Rgb(251, 113, 133));
        assert_eq!(t.human, Color::Rgb(244, 114, 182));
        assert_eq!(t.popup, Color::Rgb(13, 24, 41));
        assert_eq!(t.input, Color::Rgb(3, 10, 20));
        assert_eq!(t.status, Color::Rgb(2, 6, 12));
        assert_eq!(t.tab_bar_bg, Color::Rgb(3, 10, 20));
    }

    /// Pin the composed accessor styles (a regression here means a `Self::CONST`
    /// → `active().slot` conversion picked the wrong slot).
    #[test]
    fn accessor_styles_unchanged() {
        let t = Theme::active();
        assert_eq!(Theme::panel(), Style::default().fg(t.ink).bg(t.panel));
        assert_eq!(
            Theme::selected(),
            Style::default()
                .fg(t.on_accent)
                .bg(t.accent_hot)
                .add_modifier(Modifier::BOLD)
        );
        assert_eq!(
            Theme::title_active(),
            Style::default()
                .fg(t.on_accent)
                .bg(t.accent_hot)
                .add_modifier(Modifier::BOLD)
        );
        assert_eq!(Theme::tab_bar(), Style::default().fg(t.muted).bg(t.tab_bar_bg));
        assert_eq!(Theme::dim(), Style::default().fg(t.muted));
    }

    #[test]
    fn registry_resolves_by_name() {
        assert_eq!(theme_by_name("frost"), Some(&BLUE_FROST));
        assert_eq!(theme_by_name("honeycomb"), Some(&HONEYCOMB));
        assert_eq!(theme_by_name("papercusp-dark"), Some(&PAPERCUSP_DARK));
        assert!(theme_by_name("does-not-exist").is_none());
        assert!(!THEMES.is_empty());
    }

    /// Per-theme render snapshot: the needs-human marker must stay VISIBLE —
    /// rendered with the distinct human hue (bold), never dimmed away. Renders
    /// the styled glyph into a real ratatui buffer and inspects the cell.
    #[test]
    fn needs_human_marker_renders_visibly() {
        let t = Theme::active();
        let marker = Theme::status_marker("needs-human");
        // The glyph shape comes from the glyph vocabulary…
        assert_eq!(marker.content, glyph::status_for("needs-human"));
        // …and it carries the human hue + bold (NOT the de-emphasised dim style).
        assert_eq!(marker.style.fg, Some(t.human));
        assert!(marker.style.add_modifier.contains(Modifier::BOLD));
        assert_ne!(marker.style.fg, Some(t.muted), "needs-human must not be dimmed");

        // Render it into a buffer and confirm the glyph cell survives with its hue.
        let area = Rect::new(0, 0, 4, 1);
        let mut buf = Buffer::empty(area);
        Paragraph::new(Line::from(vec![marker])).render(area, &mut buf);
        let cell = buf.cell((0, 0)).expect("cell 0,0");
        assert_eq!(cell.symbol(), glyph::status_for("needs-human"));
        assert_eq!(cell.fg, t.human);
    }
}
