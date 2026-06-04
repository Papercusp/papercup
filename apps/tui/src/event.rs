//! Event sources that feed the single update loop through one mpsc channel.
//!
//! Architecture (SP-TUI A2): all inputs — terminal keys, periodic ticks, and
//! (later) async backend deltas — are normalised into `Event` and drained by
//! one `App::update`. crossterm's `event::read` is blocking, so it lives on a
//! dedicated OS thread that forwards into the async channel.

use crossterm::event::{self, Event as CtEvent, KeyEvent};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

/// Everything the update loop reacts to.
#[derive(Debug, Clone)]
pub enum Event {
    /// A terminal key press.
    Key(KeyEvent),
    /// Idle tick (emitted when no input arrives within the poll window).
    Tick,
    // Backend(BackendDelta) — added with the client module (P0 step 3).
}

/// Spawn the blocking input reader. Emits `Key` on input and `Tick` otherwise,
/// so the loop stays responsive (and can later refresh on a cadence) without a
/// busy-wait. Returns when the channel receiver is dropped.
pub fn spawn_input_listener(tx: UnboundedSender<Event>) {
    std::thread::spawn(move || loop {
        match event::poll(Duration::from_millis(250)) {
            Ok(true) => {
                if let Ok(CtEvent::Key(key)) = event::read() {
                    if tx.send(Event::Key(key)).is_err() {
                        break;
                    }
                }
            }
            Ok(false) => {
                if tx.send(Event::Tick).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    });
}
