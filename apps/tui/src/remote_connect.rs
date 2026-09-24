//! `pui --connect` — run PUI on a remote Papercusp host the way psu does
//! (pui-first-party-public-release P-017 / D-025, owner #468).
//!
//! PUI keeps no list of remote hosts and no transport of its own. psu's
//! connection front controller
//! (`apps/operator/scripts/psu-connection-front-controller.mjs`) owns the saved
//! profiles, the picker, both transports (OpenSSH over IAP, the Papercusp cloud
//! workspace terminal) and the reattach keys. `pui --connect…` hands the whole
//! command line to `psu --connect-program=pui`, so the SAME profile runs `pui`
//! on the remote host, against that host's own operator and store.
//!
//! Every `--connect*` cell is psu's to interpret — PUI only recognises the
//! namespace so it knows to hand off, and never parses a value out of it. The
//! non-transport cells (subcommand, `--fleet`, `--seat`) reach the remote `pui`
//! unchanged. `pui --connect` always means a remote host: psu's picker offers no
//! "this computer" entry for `--connect-program=pui`, so there is no local
//! fallback to agree on (the remote program's exit status passes straight
//! through psu, so no status value could signal one unambiguously).

use anyhow::{Context, Result};
use std::process::Command;

/// The launcher that owns saved connection profiles.
pub const PSU_PROGRAM: &str = "psu";
/// Tells psu's front controller to launch `pui` (not `psu`) on the chosen host.
pub const CONNECT_PROGRAM_ARG: &str = "--connect-program=pui";
/// Set by psu's front controller on the program it launches on the remote host.
pub const FORWARDED_ENV: &str = "PAPERCUSP_PSU_CONNECTION_FORWARDED";

/// True when the command line uses psu's connection namespace (`--connect`,
/// `--connect=<name>`, `--connect-list`, `--connect-login`, …). A literal `--`
/// closes the namespace, exactly as it does for psu.
pub fn requests_connection(args: &[String]) -> bool {
    args.iter()
        .take_while(|arg| arg.as_str() != "--")
        .any(|arg| {
            let key = arg.split_once('=').map_or(arg.as_str(), |(key, _)| key);
            key == "--connect" || key.starts_with("--connect-")
        })
}

/// psu's argv for this PUI command line: the program selector, then every cell
/// in its original order so psu's own parser sees exactly what the user typed.
pub fn psu_args(args: &[String]) -> Vec<String> {
    std::iter::once(CONNECT_PROGRAM_ARG.to_string())
        .chain(args.iter().cloned())
        .collect()
}

/// Refuse a nested hand-off: a `pui` that psu already launched on a remote host
/// connecting onward would stack one remote terminal inside another.
pub fn refuse_when_forwarded(forwarded: Option<&str>) -> Result<()> {
    if forwarded == Some("1") {
        anyhow::bail!(
            "this pui is already running on a remote host through `pui --connect`; run --connect from your own computer instead"
        );
    }
    Ok(())
}

fn psu_missing() -> anyhow::Error {
    anyhow::anyhow!(
        "`pui --connect` uses the remote hosts psu saves, but `{PSU_PROGRAM}` is not on PATH. Install psu, or open a terminal on the remote host and run `pui` there"
    )
}

/// Hand the terminal to psu. On Unix this replaces the PUI process, so psu (and
/// through it the remote `pui`) owns the terminal and the exit status; it
/// returns only when psu could not be started.
pub fn hand_off(args: &[String]) -> Result<i32> {
    refuse_when_forwarded(std::env::var(FORWARDED_ENV).ok().as_deref())?;
    let mut command = Command::new(PSU_PROGRAM);
    command.args(psu_args(args));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Err(psu_missing());
        }
        Err(error).context("start psu for `pui --connect`")
    }
    #[cfg(not(unix))]
    {
        let status = command.status().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                psu_missing()
            } else {
                anyhow::Error::new(error).context("start psu for `pui --connect`")
            }
        })?;
        Ok(status.code().unwrap_or(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(cells: &[&str]) -> Vec<String> {
        cells.iter().map(|cell| cell.to_string()).collect()
    }

    #[test]
    fn every_form_of_the_connect_namespace_hands_off() {
        for cells in [
            &["--connect"][..],
            &["--connect=avi-test"],
            &["--connect", "avi-test"],
            &["--connect=cloud/ws-1", "workbench"],
            &["--fleet=f", "--connect-list"],
            &["--connect-login"],
            &["--connect-login=https://portal.example"],
            &["--connect-logout=cloud"],
            &["--connect-session=abc", "--connect=cloud"],
        ] {
            assert!(requests_connection(&args(cells)), "{cells:?}");
        }
    }

    #[test]
    fn ordinary_command_lines_stay_local() {
        for cells in [
            &[][..],
            &["workbench"],
            &["doctor"],
            &["--fleet=connect", "--seat=s"],
            &["hive-pane", "connect"],
            &["--connection"],
            &["-c"],
            // `--` closes psu's namespace; what follows is not a transport flag.
            &["hud", "--", "--connect=x"],
        ] {
            assert!(!requests_connection(&args(cells)), "{cells:?}");
        }
    }

    #[test]
    fn psu_receives_the_program_selector_then_the_command_line_verbatim() {
        let line = args(&[
            "--fleet=f",
            "--connect",
            "cloud/ws-1",
            "workbench",
            "--seat=s",
        ]);
        assert_eq!(
            psu_args(&line),
            args(&[
                "--connect-program=pui",
                "--fleet=f",
                "--connect",
                "cloud/ws-1",
                "workbench",
                "--seat=s",
            ])
        );
    }

    #[test]
    fn a_forwarded_pui_refuses_to_connect_onward() {
        let refused = refuse_when_forwarded(Some("1")).unwrap_err().to_string();
        assert!(
            refused.contains("already running on a remote host"),
            "{refused}"
        );
        assert!(refuse_when_forwarded(None).is_ok());
        assert!(refuse_when_forwarded(Some("0")).is_ok());
    }
}
