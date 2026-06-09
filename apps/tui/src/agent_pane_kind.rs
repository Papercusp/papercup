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
    fn drive_mode_wire_contract() {
        assert_eq!(DriveMode::from_wire("auto"), Some(DriveMode::Auto));
        assert_eq!(DriveMode::from_wire("responsive"), Some(DriveMode::Responsive));
        assert_eq!(DriveMode::Auto.as_wire(), "auto");
        assert_eq!(DriveMode::Responsive.as_wire(), "responsive");
        assert_eq!(DriveMode::from_wire("manual"), None);
    }
}
