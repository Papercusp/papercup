//! Workbench zellij layout (D-001). The workbench is a zellij session whose
//! `pui` HUD pane rides alongside a "work" area where native agent panes
//! (claude/codex/omp) open via `zellij action new-pane` (see `mux::MuxAction`).
//! pui is NOT a zellij plugin — the WASM plugin sandbox can't reach our
//! Unix-socket IPC — so it runs as a normal pane and drives the session from
//! the outside. Live launching is exercised manually (the deferred live part);
//! here we own the KDL + the launch command + materialising the file.

use std::path::{Path, PathBuf};

/// The workbench layout in zellij KDL. A vertical split: a focused "work" area
/// (where agent panes open) beside the `pui` HUD, with zellij's own tab/status
/// bars kept.
pub const WORKBENCH_KDL: &str = r#"// Papercusp workbench — pui HUD + a work area for native agent panes (D-001).
layout {
    pane size=1 borderless=true {
        plugin location="zellij:tab-bar"
    }
    pane split_direction="vertical" {
        pane name="work" focus=true size="60%"
        pane name="pui" size="40%" {
            command "pui"
            args "hud"
        }
    }
    pane size=2 borderless=true {
        plugin location="zellij:status-bar"
    }
}
"#;

/// Argv to start a zellij session with the workbench layout.
pub fn launch_argv(layout_path: &str) -> Vec<String> {
    vec![
        "zellij".to_string(),
        "--layout".to_string(),
        layout_path.to_string(),
    ]
}

fn base_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".papercusp"))
}

/// Write the workbench KDL to `~/.papercusp/pui-workbench.kdl` and return it.
pub fn materialize() -> std::io::Result<PathBuf> {
    let base = base_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?;
    materialize_at(&base)
}

fn materialize_at(base: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(base)?;
    let path = base.join("pui-workbench.kdl");
    std::fs::write(&path, WORKBENCH_KDL)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kdl_defines_pui_and_work_panes() {
        assert!(WORKBENCH_KDL.contains("command \"pui\""));
        assert!(WORKBENCH_KDL.contains("args \"hud\"")); // HUD pane runs `pui hud`, never bare `pui` (no nesting)
        assert!(WORKBENCH_KDL.contains("name=\"work\""));
        assert!(WORKBENCH_KDL.contains("name=\"pui\""));
        assert!(WORKBENCH_KDL.contains("layout {"));
    }

    #[test]
    fn launch_argv_shape() {
        assert_eq!(
            launch_argv("/home/u/.papercusp/pui-workbench.kdl"),
            vec!["zellij", "--layout", "/home/u/.papercusp/pui-workbench.kdl"]
        );
    }

    #[test]
    fn materialize_writes_the_kdl() {
        let d = tempfile::tempdir().unwrap();
        let p = materialize_at(d.path()).unwrap();
        assert!(p.ends_with("pui-workbench.kdl"));
        let written = std::fs::read_to_string(&p).unwrap();
        assert_eq!(written, WORKBENCH_KDL);
    }
}
