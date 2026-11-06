use std::process::{Command, Stdio};

fn pui_binary() -> std::ffi::OsString {
    // Cargo's compiled path belongs to the build host. Native runners can
    // supply the same variable at runtime after copying the binary.
    std::env::var_os("CARGO_BIN_EXE_pui").unwrap_or_else(|| env!("CARGO_BIN_EXE_pui").into())
}

fn assert_help_is_side_effect_free(args: &[&str]) {
    let output = Command::new(pui_binary())
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("run pui help command");

    assert!(output.status.success(), "pui {args:?} failed: {output:?}");
    assert!(
        !output.stdout.is_empty(),
        "pui {args:?} printed no help text"
    );
    assert!(
        output.stderr.is_empty(),
        "pui {args:?} wrote to stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("Usage:"),
        "help text did not include usage: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[test]
fn help_is_side_effect_free_without_a_controlling_tty() {
    assert_help_is_side_effect_free(&["--help"]);
}

#[test]
fn workbench_help_is_side_effect_free_without_a_controlling_tty() {
    assert_help_is_side_effect_free(&["workbench", "--help"]);
}

#[test]
fn version_is_side_effect_free_without_a_controlling_tty() {
    let output = Command::new(pui_binary())
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .expect("run pui version command");

    assert!(output.status.success(), "pui --version failed: {output:?}");
    assert!(output.stderr.is_empty(), "pui --version wrote to stderr");
    assert!(
        String::from_utf8_lossy(&output.stdout).starts_with("pui "),
        "version output was unexpected: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}
