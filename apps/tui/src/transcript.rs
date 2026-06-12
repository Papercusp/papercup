//! Claude session transcript tailing (owner ask 2026-06-11) — the agent-pane's
//! QUEEN CHAT data source.
//!
//! The queen is the pinned brain: a real Claude session (`brain_session_id` in
//! operator_settings, served by GET bootstrap-su/brain). Her actual
//! conversation lives in the session's project transcript on disk
//! (`~/.claude/projects/<munged-cwd>/<uuid>.jsonl`) — there is no server route
//! for it, and the dock is local, so pui tails the file directly (the same
//! files the flight-recorder preserves). We locate by GLOBBING every project
//! dir for `<uuid>.jsonl` (the uuid is unique; the cwd munge is unknowable
//! from here), then offset-tail: parse only appended complete lines per tick,
//! with a bounded backfill on first read so a long-lived brain doesn't cost a
//! full-file parse.
//!
//! Parsing keeps the CONVERSATION only: user text + assistant text blocks.
//! Tool calls/results, thinking, sidechains (subagents), and harness records
//! (queue-operation / attachment / last-prompt / ai-title / summary) are
//! skipped — the pane is a chat, not a debugger.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::models::ChatMessage;

/// First-read backfill bound: parse at most this many trailing bytes of an
/// existing transcript (a long brain session's jsonl can be tens of MB).
const BACKFILL_BYTES: u64 = 400 * 1024;

/// Find `<uuid>.jsonl` under `~/.claude/projects/*/` — the session transcript.
/// The project-dir name is the munged cwd of the session, which we can't
/// reconstruct reliably, so we scan the one directory level instead.
pub fn locate_session_transcript(uuid: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let projects = home.join(".claude").join("projects");
    let want = format!("{uuid}.jsonl");
    for entry in fs::read_dir(projects).ok()?.flatten() {
        let candidate = entry.path().join(&want);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Tail the transcript from `offset`: parse appended COMPLETE lines into chat
/// messages and return them with the new offset (always at a line boundary, so
/// a partial trailing write is re-read next tick). `offset == 0` on a large
/// file backfills only the trailing [`BACKFILL_BYTES`].
pub fn tail_transcript(path: &Path, offset: u64) -> std::io::Result<(u64, Vec<ChatMessage>)> {
    let mut f = fs::File::open(path)?;
    let len = f.metadata()?.len();
    if len <= offset {
        // Unchanged — or truncated/rotated (a re-pinned brain): restart.
        return if len < offset { tail_transcript(path, 0) } else { Ok((offset, Vec::new())) };
    }
    let mut start = offset;
    let mut skip_first_partial = false;
    if start == 0 && len > BACKFILL_BYTES {
        start = len - BACKFILL_BYTES;
        skip_first_partial = true; // we landed mid-line — drop up to the first '\n'
    }
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf)?;
    // Only consume through the last complete line.
    let consumed = match buf.iter().rposition(|&b| b == b'\n') {
        Some(i) => i + 1,
        None => return Ok((start, Vec::new())), // no complete line yet
    };
    let text = String::from_utf8_lossy(&buf[..consumed]);
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if i == 0 && skip_first_partial && start > 0 {
            continue;
        }
        if let Some(m) = parse_transcript_line(line) {
            out.push(m);
        }
    }
    Ok((start + consumed as u64, out))
}

/// One transcript jsonl line → a displayable chat message, or None for
/// everything that isn't conversation (tool traffic, thinking, sidechains,
/// harness records). Pure — unit-tested.
pub fn parse_transcript_line(line: &str) -> Option<ChatMessage> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    // Subagent sidechains are their own conversations — not the queen's.
    if v.get("isSidechain").and_then(serde_json::Value::as_bool) == Some(true) {
        return None;
    }
    let kind = v.get("type").and_then(serde_json::Value::as_str)?;
    if kind != "user" && kind != "assistant" {
        return None;
    }
    let content = v.pointer("/message/content")?;
    let text = match content {
        // A plain-string user message.
        serde_json::Value::String(s) => s.clone(),
        // Block array: keep `text` blocks only (skip tool_use/tool_result/thinking).
        serde_json::Value::Array(blocks) => {
            let parts: Vec<&str> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(serde_json::Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(serde_json::Value::as_str))
                .collect();
            parts.join("\n")
        }
        _ => return None,
    };
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    // Harness-injected user records (caveats, command echoes, reminders) are
    // not the human speaking — drop the obvious ones.
    if kind == "user" && (text.starts_with("<local-command") || text.starts_with("<command-name>") || text.starts_with("<system-reminder>")) {
        return None;
    }
    Some(ChatMessage {
        role: kind.to_string(),
        content: text.to_string(),
        tools: Vec::new(),
        streaming: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_user_and_assistant_text_and_skips_everything_else() {
        // Plain-string user message.
        let m = parse_transcript_line(
            r#"{"type":"user","message":{"role":"user","content":"hello queen"}}"#,
        )
        .expect("user msg");
        assert_eq!((m.role.as_str(), m.content.as_str()), ("user", "hello queen"));

        // Assistant: text blocks concatenated; thinking + tool_use skipped.