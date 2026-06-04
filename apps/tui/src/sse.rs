//! Minimal SSE (text/event-stream) support (SP-TUI). The frame parser is pure
//! and thoroughly unit-tested; `spawn_sse` is the live consumer, ready to back
//! agent-run-log / chat streaming. It is not fed by the poller yet because the
//! operator's live log streams are runId/chat-scoped (need a running agent),
//! so wiring a concrete source is a follow-up — the reusable infra is here.
#![allow(dead_code)]

use crate::event::Event;
use tokio::sync::mpsc::UnboundedSender;

/// Extract complete SSE `data:` payloads from `buf`. Returns one payload per
/// blank-line-terminated frame (multi-line `data:` joined with '\n'), plus the
/// unconsumed remainder (an incomplete trailing frame to prepend next time).
/// `event:` / `id:` / comment (`:`) lines don't contribute to the payload.
pub fn parse_sse(buf: &str) -> (Vec<String>, String) {
    let norm = buf.replace("\r\n", "\n");
    let mut events = Vec::new();
    let mut rest = norm.as_str();
    while let Some(idx) = rest.find("\n\n") {
        if let Some(data) = frame_data(&rest[..idx]) {
            events.push(data);
        }
        rest = &rest[idx + 2..];
    }
    (events, rest.to_string())
}

/// Join the `data:` lines of one frame (None if the frame carries no data).
fn frame_data(frame: &str) -> Option<String> {
    let data: Vec<&str> = frame
        .split('\n')
        .filter_map(|line| line.strip_prefix("data:"))
        .map(|v| v.strip_prefix(' ').unwrap_or(v))
        .collect();
    if data.is_empty() {
        None
    } else {
        Some(data.join("\n"))
    }
}

/// Connect to an SSE endpoint and forward each frame's data payload as an
/// `Event` (via `wrap`). Runs until the stream ends or the receiver drops.
/// Uses `Response::chunk()` so no extra stream/futures dependency is needed.
pub fn spawn_sse(
    url: String,
    token: Option<String>,
    tx: UnboundedSender<Event>,
    wrap: fn(String) -> Event,
) {
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        let mut req = client.get(&url).header("Accept", "text/event-stream");
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let mut resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                let _ = tx.send(Event::Error(format!("sse connect: {e}")));
                return;
            }
        };
        let mut buf = String::new();
        loop {
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    let (events, rest) = parse_sse(&buf);
                    buf = rest;
                    for ev in events {
                        if tx.send(wrap(ev)).is_err() {
                            return;
                        }
                    }
                }
                Ok(None) => break, // stream ended cleanly
                Err(_) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_frame() {
        let (ev, rest) = parse_sse("data: hello\n\n");
        assert_eq!(ev, vec!["hello".to_string()]);
        assert_eq!(rest, "");
    }

    #[test]
    fn multiline_data_joined() {
        let (ev, _) = parse_sse("data: a\ndata: b\n\n");
        assert_eq!(ev, vec!["a\nb".to_string()]);
    }

    #[test]
    fn partial_frame_kept_as_remainder() {
        let (ev, rest) = parse_sse("data: x");
        assert!(ev.is_empty());
        assert_eq!(rest, "data: x");
    }

    #[test]
    fn two_frames_plus_partial() {
        let (ev, rest) = parse_sse("data: one\n\ndata: two\n\ndata: par");
        assert_eq!(ev, vec!["one".to_string(), "two".to_string()]);
        assert_eq!(rest, "data: par");
    }

    #[test]
    fn crlf_and_event_lines() {
        // mirrors the real /api/flags/stream framing: an `event:` line + data.
        let (ev, _) = parse_sse("event: heartbeat\r\ndata: {\"tsMs\":1}\r\n\r\n");
        assert_eq!(ev, vec!["{\"tsMs\":1}".to_string()]);
    }

    #[test]
    fn comment_only_frame_yields_nothing() {
        let (ev, _) = parse_sse(": keep-alive\n\n");
        assert!(ev.is_empty());
    }

    #[test]
    fn incremental_reassembly() {
        // Simulate two chunks splitting a frame mid-way.
        let (ev1, rest1) = parse_sse("data: hel");
        assert!(ev1.is_empty());
        let combined = format!("{rest1}lo\n\n");
        let (ev2, rest2) = parse_sse(&combined);
        assert_eq!(ev2, vec!["hello".to_string()]);
        assert_eq!(rest2, "");
    }
}
