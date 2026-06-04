//! Application state + the single update reducer (SP-TUI A2 / P1 Create tab).
//!
//! `App` is the whole UI state; `update` is the only mutator. Rendering is a
//! pure function of `&App` (see `ui.rs`), so views are snapshot-testable.

use crate::event::Event;
use crate::models::{PlanSummary, RosterEntry};
use crossterm::event::{KeyCode, KeyModifiers};

/// What the run-loop should do after handling one event.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    None,
    Render,
    Quit,
}

/// The Create-tab views (the first ported tab).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Plans,
    Inbox,
    Sessions,
}

impl Tab {
    pub const ALL: [Tab; 3] = [Tab::Plans, Tab::Inbox, Tab::Sessions];
    pub fn title(self) -> &'static str {
        match self {
            Tab::Plans => "Plans",
            Tab::Inbox => "Inbox",
            Tab::Sessions => "Sessions",
        }
    }
    pub fn index(self) -> usize {
        Tab::ALL.iter().position(|t| *t == self).unwrap_or(0)
    }
}

/// Root application state. Grows as more panels are ported.
pub struct App {
    pub should_quit: bool,
    pub status: String,
    pub tab: Tab,
    pub plans: Vec<PlanSummary>,
    pub plan_sel: usize,
    pub roster: Vec<RosterEntry>,
    pub roster_sel: usize,
    pub last_error: Option<String>,
}

impl App {
    pub fn new() -> Self {
        Self {
            should_quit: false,
            status: "pui · 1/2/3 switch · j/k move · q quit".to_string(),
            tab: Tab::Plans,
            plans: Vec::new(),
            plan_sel: 0,
            roster: Vec::new(),
            roster_sel: 0,
            last_error: None,
        }
    }

    pub fn set_plans(&mut self, plans: Vec<PlanSummary>) {
        self.plans = plans;
        self.clamp_sel();
    }

    pub fn set_roster(&mut self, roster: Vec<RosterEntry>) {
        self.roster = roster;
        self.clamp_sel();
    }

    pub fn selected_plan(&self) -> Option<&PlanSummary> {
        self.plans.get(self.plan_sel)
    }

    fn clamp_sel(&mut self) {
        if self.plan_sel >= self.plans.len() {
            self.plan_sel = self.plans.len().saturating_sub(1);
        }
        if self.roster_sel >= self.roster.len() {
            self.roster_sel = self.roster.len().saturating_sub(1);
        }
    }

    /// The single reducer. Pure w.r.t. I/O, so it is unit-testable.
    pub fn update(&mut self, ev: Event) -> Action {
        match ev {
            Event::Key(key) => self.on_key(key.code, key.modifiers),
            Event::Tick => Action::None,
            Event::Plans(p) => {
                self.set_plans(p);
                self.last_error = None;
                Action::Render
            }
            Event::Roster(r) => {
                self.set_roster(r);
                self.last_error = None;
                Action::Render
            }
            Event::Error(e) => {
                self.last_error = Some(e);
                Action::Render
            }
        }
    }

    fn on_key(&mut self, code: KeyCode, mods: KeyModifiers) -> Action {
        let ctrl_c = code == KeyCode::Char('c') && mods.contains(KeyModifiers::CONTROL);
        if code == KeyCode::Char('q') || ctrl_c {
            self.should_quit = true;
            return Action::Quit;
        }
        match code {
            KeyCode::Char('1') => {
                self.tab = Tab::Plans;
                Action::Render
            }
            KeyCode::Char('2') => {
                self.tab = Tab::Inbox;
                Action::Render
            }
            KeyCode::Char('3') => {
                self.tab = Tab::Sessions;
                Action::Render
            }
            KeyCode::Char('j') | KeyCode::Down => {
                self.move_sel(1);
                Action::Render
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.move_sel(-1);
                Action::Render
            }
            _ => Action::None,
        }
    }

    fn move_sel(&mut self, delta: isize) {
        let len = match self.tab {
            Tab::Plans => self.plans.len(),
            Tab::Sessions => self.roster.len(),
            Tab::Inbox => return,
        };
        if len == 0 {
            return;
        }
        let slot = match self.tab {
            Tab::Plans => &mut self.plan_sel,
            Tab::Sessions => &mut self.roster_sel,
            Tab::Inbox => return,
        };
        let next = (*slot as isize + delta).clamp(0, len as isize - 1);
        *slot = next as usize;
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
    use crate::models::PlanSummary;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    fn key(c: char, mods: KeyModifiers) -> Event {
        Event::Key(KeyEvent::new(KeyCode::Char(c), mods))
    }

    fn plan(slug: &str) -> PlanSummary {
        PlanSummary {
            slug: slug.into(),
            title: slug.into(),
            status: "todo".into(),
            updated: "2026-06-04".into(),
            owner: None,
            harness: None,
            archived: false,
            next_action: None,
        }
    }

    #[test]
    fn q_and_ctrl_c_quit() {
        let mut a = App::new();
        assert_eq!(a.update(key('q', KeyModifiers::NONE)), Action::Quit);
        assert!(a.should_quit);
        let mut b = App::new();
        assert_eq!(b.update(key('c', KeyModifiers::CONTROL)), Action::Quit);
        assert!(b.should_quit);
    }

    #[test]
    fn plain_c_is_noop() {
        let mut a = App::new();
        assert_eq!(a.update(key('c', KeyModifiers::NONE)), Action::None);
        assert!(!a.should_quit);
    }

    #[test]
    fn number_keys_switch_tabs() {
        let mut a = App::new();
        assert_eq!(a.update(key('2', KeyModifiers::NONE)), Action::Render);
        assert_eq!(a.tab, Tab::Inbox);
        a.update(key('3', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Sessions);
        a.update(key('1', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Plans);
    }

    #[test]
    fn jk_navigates_and_clamps() {
        let mut a = App::new();
        a.set_plans(vec![plan("a"), plan("b"), plan("c")]);
        assert_eq!(a.plan_sel, 0);
        a.update(key('k', KeyModifiers::NONE)); // up at top → stays 0
        assert_eq!(a.plan_sel, 0);
        a.update(key('j', KeyModifiers::NONE));
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.plan_sel, 2);
        a.update(key('j', KeyModifiers::NONE)); // down at bottom → stays 2
        assert_eq!(a.plan_sel, 2);
    }

    #[test]
    fn set_plans_clamps_stale_selection() {
        let mut a = App::new();
        a.set_plans(vec![plan("a"), plan("b"), plan("c")]);
        a.plan_sel = 2;
        a.set_plans(vec![plan("a")]); // shrank
        assert_eq!(a.plan_sel, 0);
        assert_eq!(a.selected_plan().unwrap().slug, "a");
    }

    #[test]
    fn error_event_sets_status_and_renders() {
        let mut a = App::new();
        assert_eq!(a.update(Event::Error("boom".into())), Action::Render);
        assert_eq!(a.last_error.as_deref(), Some("boom"));
    }

    #[test]
    fn tick_is_noop() {
        let mut a = App::new();
        assert_eq!(a.update(Event::Tick), Action::None);
    }
}
