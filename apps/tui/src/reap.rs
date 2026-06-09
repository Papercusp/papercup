//! Reap leaked app-managed zellij sessions (EI-186).
//!
//! Every `pui workbench` / `pui chat` launch creates a zellij session. When the
//! hosting terminal dies (desktop dock relaunch, pty close) the zellij client
//! dies with it but the detached SERVER survives — and a dead pane's PTY makes
//! the server busy-spin (observed 2026-06-09: ~85 leaked sessions, 11 spinning,
//! ~9 cores). App-managed sessions therefore carry their owner in the name
//! (`pui-<kind>-<pid>`, see [`crate::layout::session_name`]): on every launch we
//! sweep `pui-*` sessions whose owner pid is gone, and on clean exit we kill our
//! own. Sessions not named `pui-*` are never touched — they belong to humans or
//! other tools.

use std::process::Command;

/// One reap decision for a listed session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// EXITED husk — just delete the resurrection metadata.
    Delete(String),
    /// Live server whose owning pui pid is dead — kill, then delete.
    KillAndDelete(String),
}

/// Owner pid encoded in an app-managed session name (`pui-<kind>-<pid>`).
/// `None` for any session pui does not own.
pub fn owner_pid(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("pui-")?;
    rest.rsplit_once('-')?.1.parse().ok()
}

/// Decide what to reap from `zellij list-sessions --no-formatting` output.
/// `is_alive` is injected so the decision logic is unit-testable.
pub fn plan(list_output: &str, is_alive: impl Fn(u32) -> bool) -> Vec<Action> {
    let mut actions = Vec::new();
    for line in list_output.lines() {
        let Some(name) = line.split_whitespace().next() else {
            continue;
        };
        let Some(pid) = owner_pid(name) else { continue };
        if line.contains("EXITED") {
            actions.push(Action::Delete(name.to_string()));
        } else if !is_alive(pid) {
            actions.push(Action::KillAndDelete(name.to_string()));
        }
    }
    actions
}

/// A pid is alive iff `/proc/<pid>` exists. Non-Linux: assume alive, so
/// reaping degrades to exited-husk cleanup and can never wrongly kill.
fn pid_alive(pid: u32) -> bool {
    if cfg!(target_os = "linux") {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    } else {
        true
    }
}

fn zellij(args: &[&str]) {
    let _ = Command::new("zellij").args(args).output();
}

/// Kill + delete one session by name. Best-effort: errors ignored (the
/// session may already be gone, or zellij absent — neither may block pui).
pub fn kill_and_delete(name: &str) {
    zellij(&["kill-session", name]);
    zellij(&["delete-session", name]);
}

/// Sweep stale app-managed sessions, then free `own` if a pid-reuse collision
/// left a session with our exact name (it cannot be ours — we have not
/// launched yet, and `zellij --session` refuses a taken name).
pub fn reap_stale(own: &str) {
    let Ok(out) = Command::new("zellij")
        .args(["list-sessions", "--no-formatting"])
        .output()
    else {
        return;
    };
    let list = String::from_utf8_lossy(&out.stdout);
    for action in plan(&list, pid_alive) {
        match action {
            Action::Delete(n) => zellij(&["delete-session", &n]),
            Action::KillAndDelete(n) => kill_and_delete(&n),
        }
    }
    if list
        .lines()
        .any(|l| l.split_whitespace().next() == Some(own))
    {
        kill_and_delete(own);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_pid_parses_app_managed_names() {
        assert_eq!(owner_pid("pui-wb-12345"), Some(12345));
        assert_eq!(owner_pid("pui-dock-7"), Some(7));
        // Foreign sessions — auto-named, human-named, or malformed — are not ours.
        assert_eq!(owner_pid("likable-petunia"), None);
        assert_eq!(owner_pid("pui-wb-notapid"), None);
        assert_eq!(owner_pid("pui-nodash"), None);
        assert_eq!(owner_pid(""), None);
    }

    #[test]
    fn plan_reaps_only_dead_owned_sessions() {
        // Mirrors real `list-sessions --no-formatting` output: name, age,
        // and an EXITED marker on resurrectable husks.
        let list = "\
pui-dock-100 [Created 2days ago]
pui-dock-200 [Created 1h ago]
pui-wb-300 [Created 3h ago] (EXITED - attach to resurrect)
likable-petunia [Created 2days ago]
quadratic-duck [Created 1day ago] (EXITED - attach to resurrect)
";
        let alive = |pid: u32| pid == 200;
        assert_eq!(
            plan(list, alive),
            vec![
                Action::KillAndDelete("pui-dock-100".into()),
                Action::Delete("pui-wb-300".into()),
            ]
        );
    }

    #[test]
    fn plan_handles_empty_and_no_session_output() {
        assert!(plan("", |_| true).is_empty());
        // zellij prints this to stderr normally, but be robust to it on stdout.
        assert!(plan("No active zellij sessions found.\n", |_| true).is_empty());
    }
}
