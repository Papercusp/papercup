use std::process::{Command, Stdio};

#[test]
fn help_is_side_effect_free_without_a_controlling_tty() {
    let output = Command::new(env!("CARGO_BIN_EXE_pui"))
        .arg("--help")
        .stdin(Stdio::null())
        .output()
        .expect("run pui --help");

    assert!(output.status.success(), "pui --help failed: {output:?}");
    assert!(!output.stdout.is_empty(), "pui --help printed no help text");
    assert!(
        output.stderr.is_empty(),
        "pui --help wrote to stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("Usage:"),
        "help text did not include usage: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}
