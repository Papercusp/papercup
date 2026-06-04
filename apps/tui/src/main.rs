//! `pui` — Papercusp terminal workbench (SP-TUI, tui-workbench-ratatui-2026-06-04).
//!
//! Architecture: `App` holds state, `event` normalises inputs onto one mpsc
//! channel, `App::update` is the single reducer, `ui::draw` is a pure renderer.
//! Data is **push-driven (D-003, no polling)**: we fetch once on startup, then
//! subscribe to the operator's `/api/zero-harness/sse` invalidation stream OVER
//! IPC and refetch the affected views when an `invalidate`/`update` arrives. A
//! slow (60s) safety-net refetch is the only timer, and it is a fallback — not a
//! poll. P1 = the Create tab (Plans / Inbox / Sessions).

mod app;
mod client;
mod event;
mod framing;
mod ipc;
mod models;
mod mux;
mod notify;
mod sse;
mod theme;
mod tutorial;
mod ui;

use anyhow::Result;
use crossterm::{
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::Backend, backend::CrosstermBackend, Terminal};
use std::io::stdout;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use app::{Action, App};
use client::OperatorClient;
use event::{spawn_input_listener, Event};
use ipc::{CallEvent, CallFrame};
use mux::{Multiplexer, Zellij};

#[tokio::main]
async fn main() -> Result<()> {
    enable_raw_mode()?;
    let mut out = stdout();
    execute!(out, EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(out))?;

    let result = run(&mut terminal).await;

    // Always restore the terminal, even on error.
    disable_raw_mode().ok();
    execute!(terminal.backend_mut(), LeaveAlternateScreen).ok();
    terminal.show_cursor().ok();
    result
}

async fn run<B: Backend>(terminal: &mut Terminal<B>) -> Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();
    let mut app = App::new();
    // Show the first-run tutorial until this device has dismissed it once (P9).
    app.show_tutorial = !tutorial::seen();
    spawn_input_listener(tx.clone());
    spawn_sync(tx.clone(), app.active_harness.clone(), app.active_doc.clone());

    terminal.draw(|f| ui::draw(f, &app))?;

    // Tracks the last notification we surfaced to the OS so we fire exactly one
    // system notification per new event (the reducer bumps notif_seq).
    let mut last_notif_seq = app.notif_seq;
    // Persist the tutorial dismissal exactly once, the first time it closes.
    let mut tutorial_persisted = !app.show_tutorial;

    while let Some(ev) = rx.recv().await {
        let action = app.update(ev);

        // Best-effort OS notification on each new needs-human event (P8).
        if app.notif_seq != last_notif_seq {
            last_notif_seq = app.notif_seq;
            if let Some(msg) = app.notif_flash.clone() {
                notify::os_notify("Papercusp", &msg);
            }
        }

        // Record the first-run tutorial as seen the moment it's dismissed (P9).
        if !tutorial_persisted && !app.show_tutorial {
            tutorial_persisted = true;
            tutorial::mark_seen();
        }

        match action {
            Action::Render => {
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::Launch(spec) => {
                // Best-effort: only succeeds inside a running zellij session.
                if let Err(e) = Zellij.open_pane(&spec) {
                    app.update(Event::Error(format!("launch: {e}")));
                }
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::Quit => break,
            Action::None => {}
        }
    }
    Ok(())
}

/// Wire up the push-driven data layer (D-003, no polling). `refetch_loop` fetches
/// everything once on startup, then again whenever the invalidation loop signals
/// (debounced) or the slow safety timer fires. `invalidation_loop` subscribes to
/// `/api/zero-harness/sse` over IPC and pings the refetch loop on each
/// `invalidate`/`update`. They run as two tasks over two IPC connections; the
/// refetch loop is the only thing that touches `active_harness`/`active_doc`.
fn spawn_sync(
    tx: UnboundedSender<Event>,
    active_harness: Arc<Mutex<String>>,
    active_doc: Arc<Mutex<Option<String>>>,
) {
    // Internal signal channel: invalidation_loop → refetch_loop ("something changed").
    let (sig_tx, sig_rx) = mpsc::unbounded_channel::<()>();
    tokio::spawn(refetch_loop(tx.clone(), active_harness, active_doc, sig_rx));
    tokio::spawn(invalidation_loop(tx, sig_tx));
}

/// Owns an `OperatorClient`; fetches the full view set on startup, then on each
/// debounced signal from the invalidation loop and on a slow safety interval.
async fn refetch_loop(
    tx: UnboundedSender<Event>,
    active_harness: Arc<Mutex<String>>,
    active_doc: Arc<Mutex<Option<String>>>,
    mut sig_rx: UnboundedReceiver<()>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("client init: {e}")));
            return;
        }
    };

    // Initial load.
    refetch_all(&client, &tx, &active_harness, &active_doc).await;

    // Safety net only — a slow fallback in case we ever miss an SSE invalidate.
    // This is NOT a poll: it fires once a minute, not on a tight loop.
    let mut safety = tokio::time::interval(Duration::from_secs(60));
    safety.tick().await; // consume the immediate first tick.

    loop {
        tokio::select! {
            sig = sig_rx.recv() => {
                if sig.is_none() {
                    break; // invalidation loop gone → nothing left to drive us.
                }
                // Debounce a burst of invalidations into one refetch.
                tokio::time::sleep(Duration::from_millis(250)).await;
                while sig_rx.try_recv().is_ok() {}
                refetch_all(&client, &tx, &active_harness, &active_doc).await;
            }
            _ = safety.tick() => {
                refetch_all(&client, &tx, &active_harness, &active_doc).await;
            }
        }
        if tx.is_closed() {
            break;
        }
    }
}

/// Subscribe to `/api/zero-harness/sse` over IPC (the `sys:http` streaming path
/// delivers the upstream SSE text as repeated `sse-chunk` events). On each
/// `invalidate`/`update` frame, ping `sig_tx` so the refetch loop reloads. The
/// stream is long-lived; if it ends or the socket drops we resubscribe.
async fn invalidation_loop(tx: UnboundedSender<Event>, sig_tx: UnboundedSender<()>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("sync client init: {e}")));
            return;
        }
    };
    let ipc = client.ipc();

    loop {
        if sig_tx.is_closed() {
            return;
        }
        let mut sub = match ipc
            .invoke_stream(
                "sys:http",
                serde_json::json!({ "method": "GET", "path": "/api/zero-harness/sse" }),
            )
            .await
        {
            Ok(rx) => rx,
            Err(e) => {
                let _ = tx.send(Event::Error(format!("sse subscribe: {e}")));
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };

        // Accumulate sse-chunk text across IPC events; parse complete frames out.
        let mut buf = String::new();
        while let Some(msg) = sub.recv().await {
            match msg {
                CallFrame::Event(CallEvent::Json { name, data }) if name == "sse-chunk" => {
                    if let Some(s) = data.as_str() {
                        buf.push_str(s);
                    }
                    let (frames, rest) = sse::parse_sse_frames(&buf);
                    buf = rest;
                    let changed = frames
                        .iter()
                        .any(|f| f.event == "invalidate" || f.event == "update");
                    if changed && sig_tx.send(()).is_err() {
                        return; // refetch loop gone.
                    }
                }
                // Other event frames (e.g. the `head` for the SSE response) and
                // terminal frames (Done/Error/ConnLost) just end this stream;
                // we drop out and resubscribe.
                _ => {}
            }
        }

        // Stream ended (upstream closed or socket lost) → resubscribe shortly.
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Fetch every panel's data and forward as `Event`s. Errors per-query become
/// `Event::Error` so one failing endpoint doesn't sink the rest.
async fn refetch_all(
    client: &OperatorClient,
    tx: &UnboundedSender<Event>,
    active_harness: &Arc<Mutex<String>>,
    active_doc: &Arc<Mutex<Option<String>>>,
) {
    match client.plans_typed().await {
        Ok(p) => {
            let _ = tx.send(Event::Plans(p));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("plans: {e}")));
        }
    }
    match client.roster_typed().await {
        Ok(r) => {
            let _ = tx.send(Event::Roster(r));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("roster: {e}")));
        }
    }
    match client.attention_typed().await {
        Ok(i) => {
            let _ = tx.send(Event::Inbox(i));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("inbox: {e}")));
        }
    }
    // Harness list (for the selector).
    match client.harnesses().await {
        Ok(hs) => {
            let _ = tx.send(Event::Harnesses(hs));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("harnesses: {e}")));
        }
    }
    // Features + issues for whichever harness is active (shared cell, updated by
    // the reducer when the user cycles with [ / ]).
    let slug = active_harness
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| "papercup".to_string());
    match client.features_for(&slug).await {
        Ok(fs) => {
            let _ = tx.send(Event::Features(fs));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("features: {e}")));
        }
    }
    match client.issues_for(&slug).await {
        Ok(is) => {
            let _ = tx.send(Event::Issues(is));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("issues: {e}")));
        }
    }
    // Docs for the active harness + selected doc (None → server default).
    let doc = active_doc.lock().ok().and_then(|g| g.clone());
    match client.docs_for(&slug, doc.as_deref()).await {
        Ok(d) => {
            let _ = tx.send(Event::Docs(d));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("docs: {e}")));
        }
    }
    match client.recent_activity().await {
        Ok(a) => {
            let _ = tx.send(Event::Activity(a));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("activity: {e}")));
        }
    }
    match client.testing_domains(&slug).await {
        Ok(t) => {
            let _ = tx.send(Event::Testing(t));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("testing: {e}")));
        }
    }
    match client.claude_settings(&slug).await {
        Ok(c) => {
            let _ = tx.send(Event::Config(c));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("config: {e}")));
        }
    }
}
