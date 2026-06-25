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

/// Kind segment of an app-managed session name (`pui-<kind>-<pid>` → `<kind>`):
/// `dock`, `wb`, … . `None` for any session pui does not own.
pub fn session_kind(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("pui-")?;
    Some(rest.rsplit_once('-')?.0)
}

/// Decide what to reap from `zellij list-sessions --no-formatting` output before
/// launching the session named `own`. `is_alive` is injected so the decision
/// logic is unit-testable.
///
/// Three rules, in order:
///  1. EXITED husk → `Delete` (just clears resurrection metadata).
///  2. Live server whose owning pui pid is dead → `KillAndDelete` (EI-186 leak).
///  3. SINGLE-DOCK invariant (owner 2026-06-25, supersedes the per-window-dock
///     decision of 2026-06-17): when WE are launching a chat **dock**, any OTHER
///     live `pui-dock-*` session is superseded → `KillAndDelete`, so exactly one
///     chat dock exists at a time. This is the dock the Sentinel voice-in path
///     targets (`~/.papercusp/sentinel-pane`), so a single dock removes the
///     last-writer-wins race that sent voice to a background window's pane.
///     Scoped to `own` being a dock — a `wb`/`reap` pass never reaps live docks,
///     and `pui-wb-*` / foreign sessions are never touched by this rule.
pub fn plan(list_output: &str, own: &str, is_alive: impl Fn(u32) -> bool) -> Vec<Action> {
    let launching_dock = session_kind(own) == Some("dock");
    let mut actions = Vec::new();
    for line in list_output.lines() {
        let Some(name) = line.split_whitespace().next() else {
            continue;
        };
        let Some(pid) = owner_pid(name) else { continue };
        // Our own (not-yet-created) session is handled by the pid-reuse block in
        // `reap_stale`, never here.
        if name == own {
            continue;
        }
        if line.contains("EXITED") {
            actions.push(Action::Delete(name.to_string()));
        } else if !is_alive(pid) {
            actions.push(Action::KillAndDelete(name.to_string()));
        } else if launching_dock && session_kind(name) == Some("dock") {
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
    for action in plan(&list, own, pid_alive) {
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
    fn session_kind_parses_app_managed_names() {
        assert_eq!(session_kind("pui-dock-123"), Some("dock"));
        assert_eq!(session_kind("pui-wb-7"), Some("wb"));
        assert_eq!(session_kind("pui-reap-9"), Some("reap"));
        assert_eq!(session_kind("likable-petunia"), None);
        assert_eq!(session_kind("pui-nodash"), None);
    }

    #[test]
    fn plan_reaps_only_dead_owned_sessions() {
        // Mirrors real `list-sessions --no-formatting` output: name, age,
        // and an EXITED marker on resurrectable husks. `own` is a non-dock
        // (`reap`) pass, so the single-dock rule does not fire.
        let list = "\
pui-dock-100 [Created 2days ago]
pui-dock-200 [Created 1h ago]
pui-wb-300 [Created 3h ago] (EXITED - attach to resurrect)
likable-petunia [Created 2days ago]
quadratic-duck [Created 1day ago] (EXITED - attach to resurrect)
";
        let alive = |pid: u32| pid == 200;
        assert_eq!(
            plan(list, "pui-reap-999", alive),
            vec![
                Action::KillAndDelete("pui-dock-100".into()),
                Action::Delete("pui-wb-300".into()),
            ]
        );
    }

    #[test]
    fn plan_enforces_single_dock_when_launching_a_dock() {
        // Launching a fresh dock supersedes every OTHER live dock — even ones
        // whose owner is still alive (a background window / dev orphan) — but
        // leaves live workbench + foreign sessions alone, and still reaps husks.
        let list = "\
pui-dock-100 [Created 2days ago]
pui-dock-200 [Created 1h ago]
pui-wb-300 [Created 3h ago]
pui-dock-400 [Created 5h ago] (EXITED - attach to resurrect)
likable-petunia [Created 2days ago]
";
        let alive = |_pid: u32| true; // all owners alive
        assert_eq!(
            plan(list, "pui-dock-500", alive),
            vec![
                Action::KillAndDelete("pui-dock-100".into()),
                Action::KillAndDelete("pui-dock-200".into()),
                Action::Delete("pui-dock-400".into()),
            ]
        );
    }

    #[test]
    fn plan_does_not_kill_live_docks_from_a_workbench_launch() {
        // A `wb` launch keeps the existing dead-owner-only behaviour: a live
        // dock from another window is NOT a workbench's business to reap.
        let list = "\
pui-dock-100 [Created 2days ago]
pui-wb-200 [Created 1h ago]
";
        let alive = |_pid: u32| true;
        assert!(plan(list, "pui-wb-500", alive).is_empty());
    }

    #[test]
    fn plan_skips_own_session_name() {
        // `own` (pid-reuse collision) is handled by reap_stale's tail block, not here.
        let list = "pui-dock-500 [Created 1h ago]\n";
        assert!(plan(list, "pui-dock-500", |_| true).is_empty());
    }

    #[test]
    fn plan_handles_empty_and_no_session_output() {
        assert!(plan("", "pui-dock-1", |_| true).is_empty());
        // zellij prints this to stderr normally, but be robust to it on stdout.
        assert!(plan("No active zellij sessions found.\n", "pui-dock-1", |_| true).is_empty());
    }
}
