//! Application state + the single update reducer (SP-TUI A2 / P1 Create tab).
//!
//! `App` is the whole UI state; `update` is the only mutator. Rendering is a
//! pure function of `&App` (see `ui.rs`), so views are snapshot-testable.

use crate::event::Event;
use crate::models::{AttentionItem, PlanSummary, RosterEntry};
use crate::mux::PaneSpec;
use crossterm::event::{KeyCode, KeyModifiers};

/// What the run-loop should do after handling one event.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    None,
    Render,
    Quit,
    /// Open a native agent session in a new multiplexer pane.
    Launch(PaneSpec),
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
    pub inbox: Vec<AttentionItem>,
    pub inbox_sel: usize,
    pub last_error: Option<String>,
    /// Help overlay visible.
    pub show_help: bool,
    /// Command palette open + its current input buffer.
    pub palette_open: bool,
    pub palette_input: String,
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
            inbox: Vec::new(),
            inbox_sel: 0,
            last_error: None,
            show_help: false,
            palette_open: false,
            palette_input: String::new(),
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

    pub fn set_inbox(&mut self, inbox: Vec<AttentionItem>) {
        self.inbox = inbox;
        self.clamp_sel();
    }

    pub fn selected_plan(&self) -> Option<&PlanSummary> {
        self.plans.get(self.plan_sel)
    }

    pub fn selected_inbox(&self) -> Option<&AttentionItem> {
        self.inbox.get(self.inbox_sel)
    }

    pub fn selected_session(&self) -> Option<&RosterEntry> {
        self.roster.get(self.roster_sel)
    }

    /// Build the launch command for a new agent pane. Reuses the selected
    /// session's agent if any, else defaults to claude. (Harness/plan wiring
    /// follows once those are selectable in the TUI.)
    pub fn launch_spec(&self) -> PaneSpec {
        let agent = self
            .selected_session()
            .and_then(|r| r.agent.clone())
            .unwrap_or_else(|| "claude".to_string());
        let argv = vec![
            "psu".to_string(),
            "--no-picker".to_string(),
            format!("--agent={agent}"),
        ];
        PaneSpec::new(argv).titled(format!("pui · {agent}"))
    }

    fn clamp_sel(&mut self) {
        if self.plan_sel >= self.plans.len() {
            self.plan_sel = self.plans.len().saturating_sub(1);
        }
        if self.roster_sel >= self.roster.len() {
            self.roster_sel = self.roster.len().saturating_sub(1);
        }
        if self.inbox_sel >= self.inbox.len() {
            self.inbox_sel = self.inbox.len().saturating_sub(1);
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
            Event::Inbox(i) => {
                self.set_inbox(i);
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
        // Command palette captures all input while open.
        if self.palette_open {
            return match code {
                KeyCode::Esc => {
                    self.palette_open = false;
                    self.palette_input.clear();
                    Action::Render
                }
                KeyCode::Enter => {
                    // No commands wired yet; close on submit.
                    self.palette_open = false;
                    self.palette_input.clear();
                    Action::Render
                }
                KeyCode::Backspace => {
                    self.palette_input.pop();
                    Action::Render
                }
                KeyCode::Char(c) => {
                    self.palette_input.push(c);
                    Action::Render
                }
                _ => Action::None,
            };
        }
        // Help overlay: any key dismisses it.
        if self.show_help {
            self.show_help = false;
            return Action::Render;
        }

        let ctrl_c = code == KeyCode::Char('c') && mods.contains(KeyModifiers::CONTROL);
        if code == KeyCode::Char('q') || ctrl_c {
            self.should_quit = true;
            return Action::Quit;
        }
        match code {
            KeyCode::Char('?') => {
                self.show_help = true;
                Action::Render
            }
            KeyCode::Char(':') => {
                self.palette_open = true;
                self.palette_input.clear();
                Action::Render
            }
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
            KeyCode::Char('n') if self.tab == Tab::Sessions => Action::Launch(self.launch_spec()),
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
            Tab::Inbox => self.inbox.len(),
            Tab::Sessions => self.roster.len(),
        };
        if len == 0 {
            return;
        }
        let slot = match self.tab {
            Tab::Plans => &mut self.plan_sel,
            Tab::Inbox => &mut self.inbox_sel,
            Tab::Sessions => &mut self.roster_sel,
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
    fn inbox_tab_navigates_its_own_list() {
        use crate::models::AttentionItem;
        let item = |id: &str| AttentionItem {
            id: id.into(),
            kind: "plan-item".into(),
            source: "plan".into(),
            harness_slug: None,
            plan_slug: Some("p".into()),
            item_ref: Some("P-001".into()),
            title: id.into(),
            body: None,
            status: "todo".into(),
            importance: None,
            needs_human: false,
        };
        let mut a = App::new();
        a.update(key('2', KeyModifiers::NONE)); // Inbox tab
        assert_eq!(a.tab, Tab::Inbox);
        a.set_inbox(vec![item("x"), item("y")]);
        assert_eq!(a.inbox_sel, 0);
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.inbox_sel, 1);
        assert_eq!(a.selected_inbox().unwrap().id, "y");
        a.update(key('j', KeyModifiers::NONE)); // clamp at bottom
        assert_eq!(a.inbox_sel, 1);
    }

    fn roster_entry(agent: &str) -> RosterEntry {
        RosterEntry {
            owner_id: "su-1".into(),
            label: "su · su-1".into(),
            intent: None,
            current_files: vec![],
            liveness: "live".into(),
            stale: false,
            agent: Some(agent.into()),
            role: None,
            feature: None,
            current_plan_slug: None,
            heartbeat_at: None,
        }
    }

    #[test]
    fn launch_spec_uses_selected_agent_else_default() {
        let a = App::new(); // empty roster → default
        assert!(a.launch_spec().argv.contains(&"--agent=claude".to_string()));
        let mut b = App::new();
        b.set_roster(vec![roster_entry("codex")]);
        assert!(b.launch_spec().argv.contains(&"--agent=codex".to_string()));
    }

    #[test]
    fn n_launches_in_sessions_only() {
        let mut a = App::new();
        assert_eq!(a.update(key('n', KeyModifiers::NONE)), Action::None); // Plans tab
        a.update(key('3', KeyModifiers::NONE)); // Sessions
        match a.update(key('n', KeyModifiers::NONE)) {
            Action::Launch(spec) => assert_eq!(spec.argv[0], "psu"),
            other => panic!("expected Launch, got {other:?}"),
        }
    }

    #[test]
    fn help_toggles_and_any_key_dismisses() {
        let mut a = App::new();
        assert_eq!(a.update(key('?', KeyModifiers::NONE)), Action::Render);
        assert!(a.show_help);
        a.update(key('j', KeyModifiers::NONE)); // any key closes help
        assert!(!a.show_help);
    }

    #[test]
    fn palette_captures_input_until_esc() {
        let mut a = App::new();
        a.update(key(':', KeyModifiers::NONE));
        assert!(a.palette_open);
        a.update(key('h', KeyModifiers::NONE));
        a.update(key('i', KeyModifiers::NONE));
        assert_eq!(a.palette_input, "hi");
        a.update(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(!a.palette_open);
        assert_eq!(a.palette_input, "");
        a.update(key('2', KeyModifiers::NONE)); // tab keys work again
        assert_eq!(a.tab, Tab::Inbox);
    }

    #[test]
    fn tick_is_noop() {
        let mut a = App::new();
        assert_eq!(a.update(Event::Tick), Action::None);
    }
}
