use std::process::{Command, Stdio};

fn assert_help_is_side_effect_free(args: &[&str]) {
    let output = Command::new(env!("CARGO_BIN_EXE_pui"))
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
