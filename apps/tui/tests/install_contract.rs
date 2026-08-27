use std::path::PathBuf;
use std::process::Command;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .expect("apps/tui lives below repo root")
        .to_path_buf()
}

#[test]
fn canonical_installer_owns_both_artifacts_and_never_kills_sessions() {
    let root = repo_root();
    let canonical_path = root.join("apps/tui/scripts/install-update.sh");
    let canonical = std::fs::read_to_string(&canonical_path).unwrap();
    assert!(canonical.contains("cargo install --path \"$ROOT/apps/tui\""));
    assert!(canonical.contains("apps/pui-zellij-plugin/Cargo.toml"));
    assert!(canonical.contains("pui-install.json"));
    for forbidden in ["pkill", "killall", "kill-session"] {
        assert!(
            !canonical.contains(forbidden),
            "installer must not contain {forbidden}"
        );
    }

    let legacy =
        std::fs::read_to_string(root.join("apps/pui-zellij-plugin/scripts/build-install.sh"))
            .unwrap();
    assert!(legacy.contains("tui/scripts/install-update.sh"));
    assert!(!legacy.contains("cargo build"));

    let launcher = std::fs::read_to_string(
        root.join("packages/operator-core/lib/endpoint-route/routes/adv/launch-pui.ts"),
    )
    .unwrap();
    assert!(launcher.contains("./apps/tui/scripts/install-update.sh"));
    assert!(!launcher.contains("cd apps/tui && cargo install --path ."));
}

#[test]
fn installer_help_is_side_effect_free_and_names_the_generation_manifest() {
    let script = repo_root().join("apps/tui/scripts/install-update.sh");
    let output = Command::new("bash")
        .arg(script)
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("pui-install.json"));
    assert!(stdout.contains("never stops a process or zellij session"));
    assert!(output.stderr.is_empty());
}
