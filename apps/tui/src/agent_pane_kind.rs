//! agent_pane_kind.rs — the pui Rust mirror of the backend AgentPaneKind taxonomy
//! (hive-agent-tabs-psu-tui-2026-06-09, P-001).
//!
//! The BACKEND is the source of truth (`packages/agent-mcp/src/agent-pane-kind.ts`
//! → `classifyAgentPane`), which stamps `agentPaneKind` / `driveMode` onto every
//! roster entry (`adv-roster.ts`). pui only PARSES the wire string to drive
//! per-type render + color (Phase 4, P-010/P-011). The contract test at the bottom
//! pins the four kind strings + two drive modes so a backend rename can't silently
//! drift this mirror.
//!
//! Allow dead_code: the parse/wire helpers are consumed in Phase 4 (P-010 color +
//! P-011 grouping); kept here so the contract is locked from P-001.
#![allow(dead_code)]

/// The six owner-facing dock pane kinds. Mirrors `AGENT_PANE_KINDS` (backend).
/// `Overwatch` = the autonomous system-health supervisor, a sibling to the Queen
/// (overwatch-role-2026-06-15 B-01). `Su` = the owner's own interactive psu session
/// (progress-tab-agents-convergence P-005): visible in the colony ROSTER, never dock-paned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentPaneKind {
    Queen,
    Overwatch,
    Bee,
    Sentinel,
    Planner,
    Su,
}

impl AgentPaneKind {
    /// Parse the backend wire string. Unknown / absent → None (pui falls back to
    /// an untyped pane render).
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "queen" => Some(Self::Queen),
            "overwatch" => Some(Self::Overwatch),
            "bee" => Some(Self::Bee),
            "sentinel" => Some(Self::Sentinel),
            "planner" => Some(Self::Planner),
            "su" => Some(Self::Su),
            _ => None,
        }
    }

    /// Parse an `Option<String>` roster field (the common call site).
    pub fn from_opt(s: &Option<String>) -> Option<Self> {
        s.as_deref().and_then(Self::from_wire)
    }

    /// The wire string (matches the backend literal).
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Queen => "queen",
            Self::Overwatch => "overwatch",
            Self::Bee => "bee",
            Self::Sentinel => "sentinel",
            Self::Planner => "planner",
            Self::Su => "su",
        }
    }

    /// A distinct glyph per kind for the pane title row (P-010). pui-DRAWS this —
    /// zellij has no per-pane styling (D-008) — and prefixes it into the zellij
    /// pane name. Cosmetic; tunable during live verify.
    pub fn glyph(self) -> &'static str {
        match self {
            // restore-pot-lexicon D-006 (owner 2026-07-04): the Papercup cup
            // characters. Queen=Mug 🍵, Overwatch=Kettle 🫖, Sentinel=Papercup 🥤;
            // the worker (Bee/Cup) keeps ☕. (Display only — wire strings unchanged.)
            Self::Queen => "🍵",
            Self::Overwatch => "🫖",
            Self::Bee => "☕",
            Self::Sentinel => "🥤",
            Self::Planner => "📋",
            Self::Su => "🛠",
        }
    }

    /// A distinct title-row color per kind, drawn by pui in the pane chrome
    /// (P-010 / D-008 — zellij theming is session-level, so per-type color is ours).
    pub fn color(self) -> ratatui::style::Color {
        use ratatui::style::Color;
        match self {
            Self::Queen => Color::Magenta,
            // Indigo (#6366f1) — mirrors the web AGENT_KIND table (theme.ts); distinct
            // from the queen's magenta so the dock separates the two sibling auto-roles.
            Self::Overwatch => Color::Rgb(99, 102, 241),
            Self::Bee => Color::Yellow,
            Self::Sentinel => Color::Cyan,
            Self::Planner => Color::Green,
            // Owner sessions render in the neutral fg family — present but not
            // competing with the worker-kind accents.
            Self::Su => Color::Gray,
        }
    }

    /// The active-lexicon cast TERM key for this pane-kind (queen→`brain`,
    /// overwatch→`overwatch`, bee→`contributor`, sentinel→`operator`), or None
    /// for kinds with no cast term (planner/su keep a static display word).
    /// This is the DISPLAY channel — the wire string (`as_wire`) is unchanged.
    pub fn lexicon_term(self) -> Option<&'static str> {
        match self {
            Self::Queen => Some("brain"),
            Self::Overwatch => Some("overwatch"),
            Self::Bee => Some("contributor"),
            Self::Sentinel => Some("operator"),
            Self::Planner | Self::Su => None,
        }
    }

    /// The static display word for a kind with no cast term (planner/su). Only
    /// meaningful when `lexicon_term()` is None.
    fn static_label(self) -> &'static str {
        match self {
            Self::Planner => "Planner",
            Self::Su => "SU",
            // Cast kinds route through the lexicon term instead.
            _ => "",
        }
    }

    /// The user-facing DISPLAY label for this kind under the active Hive lexicon
    /// (Mug/Kettle/Cup/Papercup under CLASSIC; the-hive → its own words) — NEVER
    /// the old wire word ("queen"/"bee"/…). Cast kinds resolve their term through
    /// `lex`; planner/su use their static word. Mirrors the pattern brain_view.rs
    /// uses for its header label.
    pub fn display_label(self, lex: &crate::lexicon::Lexicon) -> String {
        match self.lexicon_term() {
            Some(term) => lex.lex(term),
            None => self.static_label().to_string(),
        }
    }

    /// The dock-stack GROUP order (P-011): same-type panes stack together, in
    /// this rank order — Sentinel (owner-facing chat) leads, then Overwatch, then
    /// the Queen, then the worker Bees (colony), then Planners. Matches the static
    /// KDL order (sentinel · overwatch · queen · …) so appended panes extend it.
    pub fn group_rank(self) -> u8 {
        match self {
            Self::Sentinel => 0,
            // Owner reorder (2026-06-22): top-to-bottom sentinel · overwatch · queen
            // · colony. Overwatch ranks right after the Sentinel, ahead of the Queen.
            Self::Overwatch => 1,
            Self::Queen => 2,
            Self::Bee => 3,
            Self::Planner => 4,
            // su sessions are never dock-paned, but the roster sorts by rank —
            // the owner's own sessions list after the dock kinds.
            Self::Su => 5,
        }
    }

    /// Recover the kind from a glyph-prefixed pane NAME/title (the P-010
    /// contract: zellij carries no per-pane metadata, so the leading glyph in
    /// the name is the type channel — and the P-011 regrouper reads it back).
    /// None for unglyphed names (the colony driver, bars, user panes).
    pub fn from_glyph_prefix(title: &str) -> Option<Self> {
        let t = title.trim_start();
        [
            Self::Queen,
            Self::Overwatch,
            Self::Bee,
            Self::Sentinel,
            Self::Planner,
            Self::Su,
        ]
        .into_iter()
        .find(|&k| t.starts_with(k.glyph()))
    }
}

/// Prefix a pane title/name with the kind's glyph (P-010). An unknown/missing
/// kind → the base unchanged. Pure — unit-tested.
/// (zellij has no per-pane color, D-008, so the glyph in the pane NAME is how a type
/// reads at a glance; pui draws the color where it owns the chrome.)
pub fn glyph_prefixed_title(base: &str, kind: Option<AgentPaneKind>) -> String {
    match kind {
        Some(k) => format!("{} {base}", k.glyph()),
        None => base.to_string(),
    }
}

/// All kinds in display order — the order the legend and docs read (🍵 🫖 ☕ 🥤 📋 🛠).
pub const ALL_KINDS: [AgentPaneKind; 6] = [
    AgentPaneKind::Queen,
    AgentPaneKind::Overwatch,
    AgentPaneKind::Bee,
    AgentPaneKind::Sentinel,
    AgentPaneKind::Planner,
    AgentPaneKind::Su,
];

/// One compact legend line for the colony roster header (owner ask 2026-06-11):
/// `🍵 mug · 🫖 kettle · ☕ cup · 🥤 papercup · 📋 planner · 🛠 su`, each entry
/// tinted in its kind color (the same color the rows use), separators dim. The
/// LABEL routes through the active Hive lexicon (`display_label`) — never the old
/// wire word — so it reads the same vocabulary as the pane titles + brain view.
/// The caller passes its active `lex` (flag-on only; flag-off rows carry no
/// glyphs so a legend would explain nothing).
pub fn legend_line(lex: &crate::lexicon::Lexicon) -> ratatui::text::Line<'static> {
    use ratatui::style::{Color, Style};
    use ratatui::text::Span;
    let mut spans: Vec<Span<'static>> = vec![Span::raw(" ")];
    for (i, k) in ALL_KINDS.into_iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled(" · ", Style::default().fg(Color::DarkGray)));
        }
        spans.push(Span::styled(
            format!("{} {}", k.glyph(), k.display_label(lex)),
            Style::default().fg(k.color()),
        ));
    }
    ratatui::text::Line::from(spans)
}

/// Drive mode mirror: `auto` = the system auto-injects the next turn; `responsive`
/// = waits for the owner. Mirrors `DRIVE_MODES` (backend).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriveMode {
    Auto,
    Responsive,
}

impl DriveMode {
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(Self::Auto),
            "responsive" => Some(Self::Responsive),
            _ => None,
        }
    }

    pub fn from_opt(s: &Option<String>) -> Option<Self> {
        s.as_deref().and_then(Self::from_wire)
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Responsive => "responsive",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The string CONTRACT with the backend (agent-mcp src/agent-pane-kind.ts).
    // These literals MUST equal AGENT_PANE_KINDS / DRIVE_MODES exactly — if the
    // backend renames a kind, this test is the canary that the mirror drifted.
    #[test]
    fn pane_kind_wire_contract() {
        for (s, k) in [
            ("queen", AgentPaneKind::Queen),
            ("overwatch", AgentPaneKind::Overwatch),
            ("bee", AgentPaneKind::Bee),
            ("sentinel", AgentPaneKind::Sentinel),
            ("planner", AgentPaneKind::Planner),
            ("su", AgentPaneKind::Su),
        ] {
            assert_eq!(AgentPaneKind::from_wire(s), Some(k));
            assert_eq!(k.as_wire(), s);
        }
        // The `sentinel` WATCHER role is a `bee` kind on the backend, never a
        // pane-kind string "watcher" — guard against that mistaken value.
        assert_eq!(AgentPaneKind::from_wire("watcher"), None);
        assert_eq!(AgentPaneKind::from_wire(""), None);
        assert_eq!(
            AgentPaneKind::from_opt(&Some("queen".to_string())),
            Some(AgentPaneKind::Queen)
        );
        assert_eq!(AgentPaneKind::from_opt(&None), None);
    }

    #[test]
    fn glyph_prefixed_title_prefixes_known_kinds() {
        // known kind → glyph prefixed (P-010)
        assert_eq!(
            glyph_prefixed_title("worker · ab12", Some(AgentPaneKind::Bee)),
            "☕ worker · ab12"
        );
        assert_eq!(glyph_prefixed_title("Q", Some(AgentPaneKind::Queen)), "🍵 Q");
        // unknown/missing kind → unchanged
        assert_eq!(glyph_prefixed_title("x", None), "x");
    }

    #[test]
    fn pane_kind_glyph_and_color_are_distinct_per_kind() {
        let kinds = [
            AgentPaneKind::Queen,
            AgentPaneKind::Overwatch,
            AgentPaneKind::Bee,
            AgentPaneKind::Sentinel,
            AgentPaneKind::Planner,
            AgentPaneKind::Su,
        ];
        for k in kinds {
            assert!(!k.glyph().is_empty(), "every kind needs a glyph");
        }
        // The four colors must all differ so the dock visibly separates types.
        let colors: Vec<_> = kinds.iter().map(|k| k.color()).collect();
        for i in 0..colors.len() {
            for j in (i + 1)..colors.len() {
                assert_ne!(colors[i], colors[j], "pane-kind colors must be distinct");
            }
        }
    }

    #[test]
    fn group_rank_orders_sentinel_overwatch_queen_bee_planner() {
        // P-011: the dock-stack group order — and every rank distinct.
        assert!(AgentPaneKind::Sentinel.group_rank() < AgentPaneKind::Overwatch.group_rank());
        assert!(AgentPaneKind::Overwatch.group_rank() < AgentPaneKind::Queen.group_rank());
        assert!(AgentPaneKind::Queen.group_rank() < AgentPaneKind::Bee.group_rank());
        assert!(AgentPaneKind::Bee.group_rank() < AgentPaneKind::Planner.group_rank());
        assert!(AgentPaneKind::Planner.group_rank() < AgentPaneKind::Su.group_rank());
    }

    #[test]
    fn from_glyph_prefix_recovers_the_kind_from_a_pane_name() {
        // P-011 regrouper input: the P-010 glyph-prefixed zellij pane names.
        assert_eq!(
            AgentPaneKind::from_glyph_prefix("☕ claude · F-12"),
            Some(AgentPaneKind::Bee)
        );
        assert_eq!(
            AgentPaneKind::from_glyph_prefix("🍵 mug"),
            Some(AgentPaneKind::Queen)
        );
        assert_eq!(
            AgentPaneKind::from_glyph_prefix("🥤 papercup"),
            Some(AgentPaneKind::Sentinel)
        );
        assert_eq!(
            AgentPaneKind::from_glyph_prefix("📋 planner · my-plan"),
            Some(AgentPaneKind::Planner)
        );
        assert_eq!(
            AgentPaneKind::from_glyph_prefix("🫖 kettle"),
            Some(AgentPaneKind::Overwatch)
        );
        // Unglyphed (colony driver / user panes) → None.
        assert_eq!(AgentPaneKind::from_glyph_prefix("cups"), None);
        assert_eq!(AgentPaneKind::from_glyph_prefix("claude · ab12"), None);
        // Round-trip with the P-010 prefixer.
        let t = glyph_prefixed_title("worker", Some(AgentPaneKind::Bee));
        assert_eq!(
            AgentPaneKind::from_glyph_prefix(&t),
            Some(AgentPaneKind::Bee)
        );
    }

    #[test]
    fn legend_line_carries_every_kind_in_display_order_with_its_color() {
        // CLASSIC lexicon: brain→Mug · overwatch→Kettle · contributor→Cup ·
        // operator→Papercup · planner/su → their static word. NEVER the old wire
        // word ("queen"/"bee"/"sentinel"/"overwatch").
        let lex = crate::lexicon::Lexicon::default();
        let line = legend_line(&lex);
        let text: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        // The old wire words must NOT leak into the display legend.
        for wire in ["queen", "bee", "sentinel", "overwatch"] {
            assert!(!text.contains(wire), "legend leaked wire word {wire:?}: {text}");
        }
        // Every kind appears as "<glyph> <lexicon-label>", in ALL_KINDS order.
        let mut last = 0usize;
        for k in ALL_KINDS {
            let entry = format!("{} {}", k.glyph(), k.display_label(&lex));
            let pos = text
                .find(&entry)
                .unwrap_or_else(|| panic!("legend missing {entry:?}: {text}"));
            assert!(pos >= last, "legend out of order at {entry:?}: {text}");
            last = pos;
            // The entry span is tinted with the kind's row color.
            assert!(
                line.spans
                    .iter()
                    .any(|s| s.content == entry && s.style.fg == Some(k.color())),
                "legend entry {entry:?} not tinted {:?}",
                k.color()
            );
        }
        // The cast labels resolve to the classic vessel words.
        assert!(text.contains("🍵 Mug"), "{text}");
        assert!(text.contains("🫖 Kettle"), "{text}");
        assert!(text.contains("☕ Cup"), "{text}");
        assert!(text.contains("🥤 Papercup"), "{text}");
        // Dim separators between entries (5 gaps for 6 kinds).
        assert_eq!(line.spans.iter().filter(|s| s.content == " · ").count(), 5);
    }

    #[test]
    fn drive_mode_wire_contract() {
        assert_eq!(DriveMode::from_wire("auto"), Some(DriveMode::Auto));
        assert_eq!(
            DriveMode::from_wire("responsive"),
            Some(DriveMode::Responsive)
        );
        assert_eq!(DriveMode::Auto.as_wire(), "auto");
        assert_eq!(DriveMode::Responsive.as_wire(), "responsive");
        assert_eq!(DriveMode::from_wire("manual"), None);
    }
}
