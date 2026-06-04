//! `pui` — Papercusp terminal workbench (SP-TUI, tui-workbench-ratatui-2026-06-04).
//!
//! P0 skeleton: the state/event/update/draw loop on ratatui + crossterm + tokio.
//! `App` holds state, `event` normalises inputs onto one mpsc channel,
//! `App::update` is the single reducer, and `ui::draw` is a pure renderer.
//! Backend client, UX kit, and the Create-tab panels land in subsequent steps.

mod app;
mod client;
mod event;
mod ui;

use anyhow::Result;
use crossterm::{
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::Backend, backend::CrosstermBackend, Terminal};
use std::io::stdout;
use tokio::sync::mpsc;

use app::{Action, App};
use event::{spawn_input_listener, Event};

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
    spawn_input_listener(tx.clone());

    let mut app = App::new();
    terminal.draw(|f| ui::draw(f, &app))?;

    while let Some(ev) = rx.recv().await {
        match app.update(ev) {
            Action::Render => {
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::Quit => break,
            Action::None => {}
        }
    }
    Ok(())
}
