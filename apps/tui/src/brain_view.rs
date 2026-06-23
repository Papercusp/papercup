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
use crate::models::RosterEntry;
use crate::transcript::{locate_session_transcript, tail_transcript};
use std::io::Write;
use std::path::PathBuf;
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

/// Resolve the autonomous session this pane follows: the NEWEST session for
/// this scope (across the live `active` AND `ended` roster tiers) whose transcript
/// file actually exists on disk. Returns its native uuid + transcript path together
/// (we locate once), or None when no such session is up yet. The roster is the
/// SAME backend data every desktop instance reads, so all instances resolve the
/// same session.
///
/// The `ended` tier is ESSENTIAL, not optional: an autonomous wake's adv_sessions
/// row is markAdvSessionEnded the instant its invoke run returns, so a short wake
/// (every Overwatch fire; a Queen wake between cycles) is in `ended` by the time
/// this resolves — reading only `active` is exactly why the Overwatch pane was
/// stuck on "waiting…". See roster_brain_scoped (client.rs).
///
/// The Queen runs as a SERIES of short "wake" sessions, each a fresh uuid; the
/// roster accumulates dozens of past wakes (45 active + 24 ended is normal). We
/// sort by `adv_session_id` — a serial PK, so a higher id launched later — and
/// take the most recent wake that has turns on disk. This makes the pane show
/// her latest activity and roll forward to each new wake automatically, and it
/// never blanks between wakes (it keeps showing the last wake's transcript,
/// which persists on disk after the process exits). Taking the FIRST match
/// instead pinned the pane to the OLDEST stale wake — the wrong-session symptom.
async fn resolve_session(client: &OperatorClient, scope: &Scope) -> Option<(String, PathBuf)> {
    // Scope the roster to THIS desktop's ACTIVE workspace so the pane shows that
    // workspace's queen/overwatch — NOT the fleet-wide newest across every
    // workspace. Re-read each resolve (the run loop calls this ~every 1.5s) so a
    // workspace SWITCH (which rewrites registry.current) rolls the pane to the
    // new workspace's agent within a tick. A switch reloads the desktop webview
    // but does NOT re-spawn this pane, so the scope MUST be resolved live here,
    // not baked in at launch. Unknown workspace (dev / webapp with no registry)
    // → unscoped, preserving the prior fleet-wide behavior. A failed workspace
    // read also degrades to unscoped (never blanks the pane).
    let workspace = client.current_workspace().await.ok().flatten();
    // Read the `active` AND `ended` roster tiers (roster_brain_scoped): a
    // short-lived autonomous wake (every Overwatch invoke; a Queen wake between
    // cycles) is markAdvSessionEnded the instant its run returns, so it sits in
    // `ended`, not `active`. The OLD code read only `active` (+ the reactive-pane
    // `pending` tier, which never carries a queen/overwatch session) — so the
    // Overwatch pane resolved nothing and printed "not running right now —
    // waiting…" forever even though its transcript was on disk. Tailing the last
    // ended wake IS this pane's contract ("keeps showing the last wake's
    // transcript, which persists on disk after the process exits", below).
    let entries: Vec<RosterEntry> = client
        .roster_brain_scoped(workspace.as_deref())
        .await
        .ok()?;
    select_newest_with_transcript(entries, scope, locate_session_transcript)
}

/// Pure core of [`resolve_session`] (network + fs injected): among `entries`,
/// the NEWEST (by `adv_session_id`) entry whose role matches `scope`, has a
/// non-empty session id, AND whose uuid `locate`s to a real transcript file.
/// Returns the uuid + its path, or None. Separated out so the "newest wake with
/// turns, not the first stale match" selection is unit-testable.
fn select_newest_with_transcript(
    entries: Vec<RosterEntry>,
    scope: &Scope,
    locate: impl Fn(&str) -> Option<PathBuf>,
) -> Option<(String, PathBuf)> {
    let mut matches: Vec<RosterEntry> = entries
        .into_iter()
        .filter(|e| {
            e.role.as_deref().map(|r| scope.matches_role(r)).unwrap_or(false)
                && e.session_id.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false)
        })
        .collect();
    // Newest launch first (adv_session_id is a serial PK; higher = launched later).
    matches.sort_by(|a, b| b.adv_session_id.unwrap_or(0).cmp(&a.adv_session_id.unwrap_or(0)));
    for e in matches {
        if let Some(uuid) = e.session_id {
            if let Some(path) = locate(&uuid) {
                return Some((uuid, path));
            }
        }
    }
    None
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

    // Sentinel (an impossible empty uuid) so the FIRST resolve — whether it finds
    // the session or returns None — DIFFERS from this and always renders a status
    // line. (Plain `None` would make iteration 1's `uuid != current_uuid` be
    // `None != None` = false, skipping the status print and leaving a blank pane.)
    let mut current_uuid: Option<String> = Some(String::new());
    let mut offset: u64 = 0;
    let mut path: Option<PathBuf> = None;

    loop {
        // (Re)resolve the newest session + its transcript path; a new wake → new uuid.
        let resolved = resolve_session(&client, &scope).await;
        let uuid = resolved.as_ref().map(|(u, _)| u.clone());
        if uuid != current_uuid {
            current_uuid = uuid;
            offset = 0;
            path = resolved.map(|(_, p)| p);
            match &current_uuid {
                Some(u) if !u.is_empty() => {
                    let short = &u[..u.len().min(8)];
                    let _ = writeln!(out, "\n── attached: {} {} ──", scope.label(), short);
                }
                _ => {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(role: &str, adv: i64, sid: Option<&str>) -> RosterEntry {
        RosterEntry {
            role: Some(role.into()),
            adv_session_id: Some(adv),
            session_id: sid.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn scope_matches_role_aliases() {
        assert!(Scope::Queen.matches_role("queen"));
        assert!(Scope::Queen.matches_role("brain"));
        assert!(Scope::Queen.matches_role("QUEEN"));
        assert!(!Scope::Queen.matches_role("overwatch"));
        assert!(Scope::Overwatch.matches_role("overwatch"));
        assert!(!Scope::Overwatch.matches_role("queen"));
    }

    #[test]
    fn picks_newest_wake_with_a_transcript_not_the_first_stale_one() {
        // Three queen wakes; only the two newest have a transcript on disk.
        let entries = vec![
            entry("queen", 2915, Some("old-stale")),     // oldest — would win a `.find()`
            entry("overwatch", 3019, Some("ow")),        // wrong scope
            entry("queen", 3329, Some("newest")),        // newest, but no file yet
            entry("queen", 3328, Some("live")),          // 2nd-newest, HAS a file
        ];
        // `newest` (3329) has no transcript; `live` (3328) and `old-stale` do.
        let locate = |uuid: &str| -> Option<PathBuf> {
            match uuid {
                "live" | "old-stale" => Some(PathBuf::from(format!("/t/{uuid}.jsonl"))),
                _ => None,
            }
        };
        let got = select_newest_with_transcript(entries, &Scope::Queen, locate);
        // Rolls back from 3329 (no file) to 3328 (`live`) — NOT the oldest 2915.
        assert_eq!(got, Some(("live".into(), PathBuf::from("/t/live.jsonl"))));
    }

    #[test]
    fn overwatch_resolves_from_an_ended_wake_with_a_transcript() {
        // The regression this fix closes: every Overwatch wake is a short invoke
        // whose adv_sessions row is ENDED by the time the pane polls, so it arrives
        // ONLY via the roster's `ended` tier (now merged into `entries` by
        // roster_brain_scoped). select_newest_with_transcript is tier-agnostic, so
        // an overwatch entry with a sessionId + an on-disk transcript MUST resolve
        // — proving the pane attaches instead of printing "waiting…". (Before the
        // fix the ended tier was dropped client-side and `entries` was empty.)
        let entries = vec![
            entry("overwatch", 6929, Some("ow-old")),  // older ended wake, has a file
            entry("queen", 6940, Some("q")),           // wrong scope, newer
            entry("overwatch", 6946, Some("ow-new")),  // newest ended wake, has a file
        ];
        let locate = |uuid: &str| -> Option<PathBuf> {
            match uuid {
                "ow-old" | "ow-new" => Some(PathBuf::from(format!("/t/{uuid}.jsonl"))),
                _ => None,
            }
        };
        let got = select_newest_with_transcript(entries, &Scope::Overwatch, locate);
        assert_eq!(got, Some(("ow-new".into(), PathBuf::from("/t/ow-new.jsonl"))));
    }

    #[test]
    fn returns_none_when_no_matching_session_has_a_transcript() {
        let entries = vec![
            entry("queen", 3329, Some("a")),
            entry("queen", 3328, Some("")), // empty sid ignored
            entry("bee", 9000, Some("b")),  // wrong scope
        ];
        let got = select_newest_with_transcript(entries, &Scope::Queen, |_| None);
        assert_eq!(got, None);
    }
}
