//! Source-level guards for the documented pui test commands.
//!
//! `pui` is a binary-only crate. Keeping the live HTTP smoke's command in a
//! source contract test prevents a future documentation edit from restoring
//! Cargo's invalid `--lib` target selection.

use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .expect("apps/tui lives below repo root")
        .to_path_buf()
}

#[test]
fn live_http_smoke_targets_the_pui_binary() {
    let source = std::fs::read_to_string(repo_root().join("apps/tui/src/http.rs"))
        .expect("read HTTP client source");
    let command = source
        .lines()
        .find(|line| line.contains("cargo test") && line.contains("http_live"))
        .expect("http.rs must document the live HTTP smoke command");

    assert!(
        command.contains("cargo test --bin pui http_live -- --ignored"),
        "the live HTTP smoke must target pui's binary target: {command}"
    );
    assert!(
        !command.contains("--lib"),
        "pui has no library target; --lib makes the documented smoke fail: {command}"
    );
}
