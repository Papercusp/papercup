//! `pui` — Papercusp terminal workbench (SP-TUI, tui-workbench-ratatui-2026-06-04).
//!
//! Architecture: `App` holds state, `event` normalises inputs onto one mpsc
//! channel, `App::update` is the single reducer, `ui::draw` is a pure renderer.
//! A background poller fetches plans + roster from the operator and forwards
//! them as `Event`s. P1 = the Create tab (Plans / Inbox / Sessions).

mod app;
mod client;
mod event;
mod models;
mod mux;
mod theme;
mod ui;

use anyhow::Result;
use crossterm::{
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::Backend, backend::CrosstermBackend, Terminal};
use std::io::stdout;
use std::time::Duration;
use tokio::sync::mpsc::{self, UnboundedSender};

use app::{Action, App};
use event::{spawn_input_listener, Event};
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
    spawn_input_listener(tx.clone());
    spawn_backend_poller(tx.clone(), app.active_harness.clone());

    terminal.draw(|f| ui::draw(f, &app))?;

    while let Some(ev) = rx.recv().await {
        match app.update(ev) {
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

/// Poll the operator for plans + roster every few seconds, forwarding deltas
/// (or errors) as `Event`s. Targets the currently-running operator via the
/// discovery resolution in `client`.
fn spawn_backend_poller(
    tx: UnboundedSender<Event>,
    active_harness: std::sync::Arc<std::sync::Mutex<String>>,
) {
    tokio::spawn(async move {
        let client = match client::OperatorClient::from_discovery() {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(Event::Error(format!("client init: {e}")));
                return;
            }
        };
        loop {
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
            // Features + issues for whichever harness is active (shared cell,
            // updated by the reducer when the user cycles with [ / ]).
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
            if tx.is_closed() {
                break;
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}
