//! Multiplexer driver (SP-TUI A1): open native agent sessions in REAL panes so
//! `claude`/`codex`/`omp` run at full fidelity. Decision: ride zellij; the trait
//! keeps a tmux impl possible later. This module BUILDS the command and exposes
//! `open_pane`; actually spawning/driving a live zellij is exercised manually
//! (the deferred live part) — the unit tests cover command construction only.
#![allow(dead_code)] // wired into the Sessions panel's launch action in a later step.

use std::process::Command;

/// A request to open a command in a new pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneSpec {
    /// Argv of the command to run in the pane (e.g. ["psu","--no-picker","--agent=claude"]).
    pub argv: Vec<String>,
    /// Optional pane title.
    pub title: Option<String>,
}

impl PaneSpec {
    pub fn new(argv: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            argv: argv.into_iter().map(Into::into).collect(),
            title: None,
        }
    }
    pub fn titled(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }
}

pub trait Multiplexer {
    /// Build the argv that opens a new pane running `spec` (pure; no spawn).
    fn new_pane_argv(&self, spec: &PaneSpec) -> Vec<String>;

    /// Spawn it via the OS. Default impl runs `new_pane_argv`.
    fn open_pane(&self, spec: &PaneSpec) -> std::io::Result<()> {
        let argv = self.new_pane_argv(spec);
        let (prog, rest) = argv
            .split_first()
            .expect("multiplexer argv is never empty");
        Command::new(prog).args(rest).status().map(|_| ())
    }
}

/// zellij driver: `zellij action new-pane [--name <title>] -- <argv...>`.
pub struct Zellij;

impl Multiplexer for Zellij {
    fn new_pane_argv(&self, spec: &PaneSpec) -> Vec<String> {
        let mut v = vec![
            "zellij".to_string(),
            "action".to_string(),
            "new-pane".to_string(),
        ];
        if let Some(t) = &spec.title {
            v.push("--name".to_string());
            v.push(t.clone());
        }
        v.push("--".to_string());
        v.extend(spec.argv.iter().cloned());
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_zellij_new_pane_command() {
        let spec = PaneSpec::new(["psu", "--no-picker", "--agent=claude"]);
        let argv = Zellij.new_pane_argv(&spec);
        assert_eq!(
            argv,
            vec![
                "zellij",
                "action",
                "new-pane",
                "--",
                "psu",
                "--no-picker",
                "--agent=claude"
            ]
        );
    }

    #[test]
    fn includes_pane_title_when_set() {
        let spec = PaneSpec::new(["psu", "--agent=codex"]).titled("codex · F-12");
        let argv = Zellij.new_pane_argv(&spec);
        // title sits before the `--` separator
        let dd = argv.iter().position(|a| a == "--").unwrap();
        assert_eq!(argv[dd - 2], "--name");
        assert_eq!(argv[dd - 1], "codex · F-12");
        assert_eq!(&argv[dd + 1..], &["psu", "--agent=codex"]);
    }
}
