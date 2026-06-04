//! Application state + the single update reducer (SP-TUI A2).
//!
//! `App` is the whole UI state; `update` is the only mutator. Rendering is a
//! pure function of `&App` (see `ui.rs`). Keeping state/update/draw separated
//! makes the views unit-testable against a ratatui `TestBackend`.

use crate::event::Event;
use crossterm::event::{KeyCode, KeyModifiers};

/// What the run-loop should do after handling one event.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    /// Nothing changed; skip the redraw.
    None,
    /// State changed; redraw.
    Render,
    /// Tear down and exit.
    Quit,
}

/// Root application state. Grows with each ported panel (plans/inbox/sessions).
pub struct App {
    pub should_quit: bool,
    pub status: String,
}

impl App {
    pub fn new() -> Self {
        Self {
            should_quit: false,
            status: "pui — Papercusp workbench · q: quit".to_string(),
        }
    }

    /// The single reducer. Pure w.r.t. I/O so it is unit-testable.
    pub fn update(&mut self, ev: Event) -> Action {
        match ev {
            Event::Key(key) => self.on_key(key.code, key.modifiers),
            Event::Tick => Action::None,
        }
    }

    fn on_key(&mut self, code: KeyCode, mods: KeyModifiers) -> Action {
        let ctrl_c = code == KeyCode::Char('c') && mods.contains(KeyModifiers::CONTROL);
        if code == KeyCode::Char('q') || ctrl_c {
            self.should_quit = true;
            return Action::Quit;
        }
        Action::Render
    }
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    fn key(c: char, mods: KeyModifiers) -> Event {
        Event::Key(KeyEvent::new(KeyCode::Char(c), mods))
    }

    #[test]
    fn q_quits() {
        let mut app = App::new();
        assert_eq!(app.update(key('q', KeyModifiers::NONE)), Action::Quit);
        assert!(app.should_quit);
    }

    #[test]
    fn ctrl_c_quits() {
        let mut app = App::new();
        assert_eq!(app.update(key('c', KeyModifiers::CONTROL)), Action::Quit);
        assert!(app.should_quit);
    }

    #[test]
    fn plain_c_does_not_quit() {
        let mut app = App::new();
        assert_eq!(app.update(key('c', KeyModifiers::NONE)), Action::Render);
        assert!(!app.should_quit);
    }

    #[test]
    fn tick_is_noop() {
        let mut app = App::new();
        assert_eq!(app.update(Event::Tick), Action::None);
    }
}
