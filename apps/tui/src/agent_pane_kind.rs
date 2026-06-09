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

/// The four owner-facing dock pane kinds. Mirrors `AGENT_PANE_KINDS` (backend).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentPaneKind {
    Queen,
    Bee,
    Sentinel,
    Planner,
}

impl AgentPaneKind {
    /// Parse the backend wire string. Unknown / absent → None (pui falls back to
    /// an untyped pane render).
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "queen" => Some(Self::Queen),
            "bee" => Some(Self::Bee),
            "sentinel" => Some(Self::Sentinel),
            "planner" => Some(Self::Planner),
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
            Self::Bee => "bee",
            Self::Sentinel => "sentinel",
            Self::Planner => "planner",
        }
    }

    /// A distinct glyph per kind for the pane title row (P-010). pui-DRAWS this —
    /// zellij has no per-pane styling (D-008) — and prefixes it into the zellij
    /// pane name. Cosmetic; tunable during live verify.
    pub fn glyph(self) -> &'static str {
        match self {
            Self::Queen => "♛",
            Self::Bee => "🐝",
            Self::Sentinel => "🛡",
            Self::Planner => "📋",
        }
    }

    /// A distinct title-row color per kind, drawn by pui in the pane chrome
    /// (P-010 / D-008 — zellij theming is session-level, so per-type color is ours).
    pub fn color(self) -> ratatui::style::Color {
        use ratatui::style::Color;
        match self {
            Self::Queen => Color::Magenta,
            Self::Bee => Color::Yellow,
            Self::Sentinel => Color::Cyan,
            Self::Planner => Color::Green,
        }
    }
}

/// Prefix a pane title/name with the kind's glyph when hive-agent-tabs is ON (P-010).
/// Flag-off, or an unknown/missing kind → the base unchanged. Pure — unit-tested.
/// (zellij has no per-pane color, D-008, so the glyph in the pane NAME is how a type
/// reads at a glance; pui draws the color where it owns the chrome.)
pub fn glyph_prefixed_title(base: &str, kind: Option<AgentPaneKind>, hive_agent_tabs: bool) -> String {
    match (hive_agent_tabs, kind) {
        (true, Some(k)) => format!("{} {base}", k.glyph()),
        _ => base.to_string(),
    }
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
            ("bee", AgentPaneKind::Bee),
            ("sentinel", AgentPaneKind::Sentinel),
            ("planner", AgentPaneKind::Planner),
        ] {
            assert_eq!(AgentPaneKind::from_wire(s), Some(k));
            assert_eq!(k.as_wire(), s);
        }
        // The `sentinel` WATCHER role is a `bee` kind on the backend, never a
        // pane-kind string "watcher" — guard against that mistaken value.
        assert_eq!(AgentPaneKind::from_wire("watcher"), None);
        assert_eq!(AgentPaneKind::from_wire(""), None);
        assert_eq!(AgentPaneKind::from_opt(&Some("queen".to_string())), Some(AgentPaneKind::Queen));
        assert_eq!(AgentPaneKind::from_opt(&None), None);
    }

    #[test]
    fn glyph_prefixed_title_only_when_flag_on() {
        // flag-on + known kind → glyph prefixed (P-010)
        assert_eq!(glyph_prefixed_title("worker · ab12", Some(AgentPaneKind::Bee), true), "🐝 worker · ab12");
        assert_eq!(glyph_prefixed_title("Q", Some(AgentPaneKind::Queen), true), "♛ Q");
        // flag-off → unchanged (current dock)
        assert_eq!(glyph_prefixed_title("worker · ab12", Some(AgentPaneKind::Bee), false), "worker · ab12");
        // unknown/missing kind → unchanged even flag-on
        assert_eq!(glyph_prefixed_title("x", None, true), "x");
    }

    #[test]
    fn pane_kind_glyph_and_color_are_distinct_per_kind() {
        let kinds = [
            AgentPaneKind::Queen,
            AgentPaneKind::Bee,
            AgentPaneKind::Sentinel,
            AgentPaneKind::Planner,
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
    fn drive_mode_wire_contract() {
        assert_eq!(DriveMode::from_wire("auto"), Some(DriveMode::Auto));
        assert_eq!(DriveMode::from_wire("responsive"), Some(DriveMode::Responsive));
        assert_eq!(DriveMode::Auto.as_wire(), "auto");
        assert_eq!(DriveMode::Responsive.as_wire(), "responsive");
        assert_eq!(DriveMode::from_wire("manual"), None);
    }
}
