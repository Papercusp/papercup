//! Read-only transcript view of the autonomous Queen / Overwatch
//! (queen-overwatch-live-visibility-2026-06-16, D-003).
//!
//! The dock's old `♛ queen` (`psu --brain`) and `👁 overwatch`
//! (`psu --role=overwatch`) panes were INTERACTIVE sessions: a single Claude
//! session can't be attached in two places at once, so a second desktop
//! instance / a relaunch could not resume the live one — it spawned its OWN
//! parked per-window shell. Result: the owner never saw the SAME queen/overwatch
//! across instances, and a pane blanked when its shell exited ("she disappeared").
//!
//! This pane instead TAILS the one autonomous session's transcript file
//! read-only (the shared backend file, resolved from the live roster) — so every
//! instance renders the SAME live agent, identically, and it survives shell exit.
//! It never attaches to or drives the session; "take control" (interactive
//! `psu --brain`) is a separate action (TODO: bind a key on the dock).

use crate::client::OperatorClient;
use crate::transcript::{locate_session_transcript, tail_transcript};
use std::io::Write;
use std::time::Duration;

/// Which autonomous agent this pane follows.
pub enum Scope {
    Queen,
    Overwatch,
}

impl Scope {
    /// Parse the pane arg (`--queen` | `--overwatch`); defaults to Queen.
    pub fn from_arg(arg: Option<&str>) -> Self {
        match arg {
            Some("--overwatch") => Scope::Overwatch,
            _ => Scope::Queen,
        }
    }

    fn label(&self) -> &'static str {
        match self {
            Scope::Queen => "Queen",
            Scope::Overwatch => "Overwatch",
        }
    }

    /// Roster `role` values that identify this scope's autonomous session.
    /// (adv-roster falls back to the presence `agentRole`, so an invoke-route
    /// launch with no adv row still carries its role here.)
    fn matches_role(&self, role: &str) -> bool {
        let r = role.to_ascii_lowercase();
        match self {
            Scope::Queen => r == "queen" || r == "brain",
            Scope::Overwatch => r == "overwatch",
        }
    }
}

/// Resolve the autonomous session's native uuid from the live roster — the SAME
/// backend data every instance reads — or None when it isn't up yet.
async fn resolve_uuid(client: &OperatorClient, scope: &Scope) -> Option<String> {
    let (active, _ended) = client.roster_typed().await.ok()?;
    active
        .into_iter()
        .find(|e| {
            e.role
                .as_deref()
                .map(|r| scope.matches_role(r))
                .unwrap_or(false)
                && e.session_id.is_some()
        })
        .and_then(|e| e.session_id)
}

/// Run the read-only transcript pane: connect, resolve the autonomous session
/// uuid, locate its transcript file, and stream new turns to stdout (zellij
/// renders the scrolling pane). Re-resolves periodically so it follows a
/// recycled brain, and shows a clear placeholder when the agent isn't running —
/// it NEVER blanks or crashes. Loops until the pane is closed.
pub async fn run(scope: Scope) -> anyhow::Result<()> {
    let mut out = std::io::stdout();
    let _ = writeln!(out, "── {} · live transcript (read-only) ──", scope.label());
    let _ = out.flush();

    // Connect (retry until the operator is reachable — the pane outlives boot order).
    let client = loop {
        match OperatorClient::from_discovery().await {
            Ok(c) => break c,
            Err(_) => {
                let _ = writeln!(out, "  connecting to operator…");
                let _ = out.flush();
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    };

    let mut current_uuid: Option<String> = None;
    let mut offset: u64 = 0;
    let mut path: Option<std::path::PathBuf> = None;

    loop {
        // (Re)resolve the session + its transcript path; a recycled brain → new uuid.
        let uuid = resolve_uuid(&client, &scope).await;
        if uuid != current_uuid {
            current_uuid = uuid;
            offset = 0;
            path = current_uuid.as_deref().and_then(locate_session_transcript);
            match (&current_uuid, &path) {
                (Some(u), Some(_)) => {
                    let short = &u[..u.len().min(8)];
                    let _ = writeln!(out, "\n── attached: {} {} ──", scope.label(), short);
                }
                (Some(_), None) => {
                    let _ = writeln!(
                        out,
                        "\n  {} is up, but its transcript isn't on this host yet…",
                        scope.label()
                    );
                }
                (None, _) => {
                    let _ = writeln!(out, "\n  {} not running right now — waiting…", scope.label());
                }
            }
            let _ = out.flush();
        }

        // Tail the transcript file read-only and print any new turns.
        if let Some(p) = &path {
            if let Ok((new_offset, msgs)) = tail_transcript(p, offset) {
                offset = new_offset;
                for m in msgs {
                    let line = m.content.trim();
                    if !line.is_empty() {
                        let _ = writeln!(out, "[{}] {}", m.role, line);
                    }
                }
                let _ = out.flush();
            }
        }

        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
}
