//! Workbench persistence glue (P12 / D-002): the per-user owner key + the pure
//! command/spec builders for SAVING the current zellij layout and RESTORING a
//! saved crew into panes. The backend CRUD is in `client.rs` (the `/api/tui/*`
//! routes); this module is the local, zellij-facing half.
//!
//! The live spawn (running `zellij action dump-layout`, `zellij --layout`, and
//! `psu --resume`) is wired into the command palette in a supervised follow-on
//! (it needs a real zellij session, which the shared-box no-keystroke rule keeps
//! out of automated tests). These builders are pure + unit-tested so that wiring
//! stays mechanical.
#![allow(dead_code)]

use crate::models::{CrewMember, CrewRow};
use crate::mux::PaneSpec;

/// A stable per-user owner key for workbench rows. Prefers an explicit override
/// (`PAPERCUSP_TUI_OWNER`), then `$USER@$HOSTNAME`, then a constant — never empty
/// (the `/api/tui/*` routes reject a blank owner).
pub fn workbench_owner() -> String {
    if let Ok(o) = std::env::var("PAPERCUSP_TUI_OWNER") {
        let o = o.trim();
        if !o.is_empty() {
            return o.to_string();
        }
    }
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    let user = user.trim();
    if user.is_empty() {
        return "pui-local".to_string();
    }
    let host = std::env::var("HOSTNAME").unwrap_or_default();
    let host = host.trim();
    if host.is_empty() {
        user.to_string()
    } else {
        format!("{user}@{host}")
    }
}

/// argv that captures the current zellij layout to stdout (for SAVE — the caller
/// stores the captured KDL via `client.save_layout`).
pub fn dump_layout_argv() -> Vec<String> {
    ["zellij", "action", "dump-layout"]
        .into_iter()
        .map(String::from)
        .collect()
}

/// argv that starts a session from a saved layout file (for RESTORE).
pub fn restore_layout_argv(kdl_path: &str) -> Vec<String> {
    vec![
        "zellij".to_string(),
        "--layout".to_string(),
        kdl_path.to_string(),
    ]
}

/// Build the `psu` pane specs that relaunch a saved crew's agents (RESTORE).
/// A member with a `resume_id` resumes that session; otherwise a fresh agent is
/// launched. Harness/plan/cwd are threaded through when present.
pub fn crew_pane_specs(crew: &CrewRow) -> Vec<PaneSpec> {
    crew.members.iter().map(member_pane_spec).collect()
}

/// Derive a `CrewMember` from a launched `PaneSpec`, if it's a `psu` agent
/// session (the thing a crew restores). Non-agent panes (git/plugin) → None.
/// The inverse of `member_pane_spec`; handles both `--resume X` and `--k=v`.
pub fn crew_member_from_spec(spec: &PaneSpec) -> Option<CrewMember> {
    if spec.argv.first().map(String::as_str) != Some("psu") {
        return None;
    }
    let mut m = CrewMember::default();
    let mut i = 1;
    while i < spec.argv.len() {
        let a = &spec.argv[i];
        if let Some(v) = a.strip_prefix("--agent=") {
            m.agent = Some(v.to_string());
        } else if let Some(v) = a.strip_prefix("--harness=") {
            m.harness = Some(v.to_string());
        } else if let Some(v) = a.strip_prefix("--plan=") {
            m.plan = Some(v.to_string());
        } else if let Some(v) = a.strip_prefix("--resume=") {
            m.resume_id = Some(v.to_string());
        } else if a == "--resume" {
            if let Some(v) = spec.argv.get(i + 1) {
                m.resume_id = Some(v.clone());
                i += 1;
            }
        }
        i += 1;
    }
    m.cwd = spec.cwd.clone();
    Some(m)
}

/// Capture the current zellij layout as KDL (`zellij action dump-layout`). Only
/// works inside a zellij session — returns None otherwise. LIVE (a subprocess);
/// invoked only by the palette `:save-layout` command in a running pui.
pub fn capture_zellij_layout() -> Option<String> {
    let out = std::process::Command::new("zellij")
        .args(["action", "dump-layout"])
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        None
    }
}

fn member_pane_spec(m: &CrewMember) -> PaneSpec {
    let mut argv = vec!["psu".to_string()];
    match (&m.resume_id, &m.agent) {
        (Some(rid), _) => {
            argv.push("--resume".to_string());
            argv.push(rid.clone());
        }
        (None, Some(agent)) => argv.push(format!("--agent={agent}")),
        (None, None) => {}
    }
    if let Some(h) = &m.harness {
        argv.push(format!("--harness={h}"));
    }
    if let Some(p) = &m.plan {
        argv.push(format!("--plan={p}"));
    }
    let title = match (&m.agent, &m.harness) {
        (Some(a), Some(h)) => format!("{a} · {h}"),
        (Some(a), None) => a.clone(),
        _ => "session".to_string(),
    };
    let mut spec = PaneSpec::new(argv).titled(title);
    if let Some(cwd) = &m.cwd {
        spec = spec.cwd(cwd.clone());
    }
    spec
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_is_never_blank_or_spaced() {
        let o = workbench_owner();
        assert!(!o.is_empty());
        assert!(!o.contains(' '));
    }

    #[test]
    fn dump_and_restore_argv() {
        assert_eq!(dump_layout_argv(), vec!["zellij", "action", "dump-layout"]);
        assert_eq!(
            restore_layout_argv("/tmp/x.kdl"),
            vec!["zellij", "--layout", "/tmp/x.kdl"]
        );
    }

    #[test]
    fn crew_member_with_resume_id_resumes() {
        let crew = CrewRow {
            name: "c".into(),
            description: None,
            layout_name: None,
            members: vec![CrewMember {
                slot: Some(0),
                agent: Some("claude".into()),
                resume_id: Some("r1".into()),
                harness: Some("papercup".into()),
                plan: Some("plan-x".into()),
                cwd: Some("/repo".into()),
            }],
        };
        let specs = crew_pane_specs(&crew);
        assert_eq!(specs.len(), 1);
        let argv = &specs[0].argv;
        assert_eq!(argv[0], "psu");
        assert!(argv.iter().any(|a| a == "--resume"));
        assert!(argv.iter().any(|a| a == "r1"));
        assert!(argv.iter().any(|a| a == "--harness=papercup"));
        assert!(argv.iter().any(|a| a == "--plan=plan-x"));
        assert_eq!(specs[0].cwd.as_deref(), Some("/repo"));
    }

    #[test]
    fn crew_member_without_resume_launches_fresh() {
        let crew = CrewRow {
            name: "c".into(),
            description: None,
            layout_name: None,
            members: vec![CrewMember {
                agent: Some("codex".into()),
                ..Default::default()
            }],
        };
        let argv = &crew_pane_specs(&crew)[0].argv;
        assert!(argv.iter().any(|a| a == "--agent=codex"));
        assert!(!argv.iter().any(|a| a == "--resume"));
    }

    #[test]
    fn empty_crew_has_no_specs() {
        let crew = CrewRow {
            name: "e".into(),
            description: None,
            layout_name: None,
            members: vec![],
        };
        assert!(crew_pane_specs(&crew).is_empty());
    }

    #[test]
    fn crew_member_from_spec_parses_psu_launch() {
        let spec = PaneSpec::new(vec![
            "psu".to_string(),
            "--no-picker".to_string(),
            "--agent=claude".to_string(),
            "--harness=papercup".to_string(),
            "--plan=plan-x".to_string(),
        ])
        .cwd("/repo");
        let m = crew_member_from_spec(&spec).unwrap();
        assert_eq!(m.agent.as_deref(), Some("claude"));
        assert_eq!(m.harness.as_deref(), Some("papercup"));
        assert_eq!(m.plan.as_deref(), Some("plan-x"));
        assert_eq!(m.cwd.as_deref(), Some("/repo"));
        assert_eq!(m.resume_id, None);
    }

    #[test]
    fn crew_member_from_spec_resume_forms_and_rejects_nonpsu() {
        let s1 = PaneSpec::new(vec![
            "psu".to_string(),
            "--resume".to_string(),
            "r1".to_string(),
        ]);
        assert_eq!(
            crew_member_from_spec(&s1).unwrap().resume_id.as_deref(),
            Some("r1")
        );
        let s2 = PaneSpec::new(vec!["psu".to_string(), "--resume=r2".to_string()]);
        assert_eq!(
            crew_member_from_spec(&s2).unwrap().resume_id.as_deref(),
            Some("r2")
        );
        assert!(crew_member_from_spec(&PaneSpec::new(vec!["lazygit".to_string()])).is_none());
    }

    #[test]
    fn crew_member_round_trips_through_pane_spec() {
        // An agent-only (fresh) launch round-trips fully.
        let m = CrewMember {
            slot: Some(0),
            agent: Some("codex".into()),
            resume_id: None,
            harness: Some("h".into()),
            plan: Some("p".into()),
            cwd: Some("/c".into()),
        };
        let back = crew_member_from_spec(&member_pane_spec(&m)).unwrap();
        assert_eq!(back.agent, m.agent);
        assert_eq!(back.harness, m.harness);
        assert_eq!(back.plan, m.plan);
        assert_eq!(back.cwd, m.cwd);
        // A resume launch recovers the resume_id; agent is implied by the session
        // (intentionally not in argv), so it doesn't round-trip.
        let r = CrewMember {
            resume_id: Some("rid".into()),
            agent: Some("codex".into()),
            ..Default::default()
        };
        let rb = crew_member_from_spec(&member_pane_spec(&r)).unwrap();
        assert_eq!(rb.resume_id.as_deref(), Some("rid"));
    }
}
