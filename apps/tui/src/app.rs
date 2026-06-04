//! Application state + the single update reducer (SP-TUI A2 / P1 Create tab).
//!
//! `App` is the whole UI state; `update` is the only mutator. Rendering is a
//! pure function of `&App` (see `ui.rs`), so views are snapshot-testable.

use crate::event::Event;
use crate::models::{
    ActivityEvent, AttentionItem, DocsResponse, HarnessFeature, HarnessIssue, HarnessRef,
    PlanSummary, RosterEntry, TestingDomain,
};
use crate::mux::PaneSpec;
use crossterm::event::{KeyCode, KeyModifiers};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

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
    Harnesses,
    Docs,
    Activity,
    Testing,
    Config,
}

impl Tab {
    pub const ALL: [Tab; 8] = [
        Tab::Plans,
        Tab::Inbox,
        Tab::Sessions,
        Tab::Harnesses,
        Tab::Docs,
        Tab::Activity,
        Tab::Testing,
        Tab::Config,
    ];
    pub fn title(self) -> &'static str {
        match self {
            Tab::Plans => "Plans",
            Tab::Inbox => "Inbox",
            Tab::Sessions => "Sessions",
            Tab::Harnesses => "Harnesses",
            Tab::Docs => "Docs",
            Tab::Activity => "Activity",
            Tab::Testing => "Testing",
            Tab::Config => "Config",
        }
    }
    pub fn index(self) -> usize {
        Tab::ALL.iter().position(|t| *t == self).unwrap_or(0)
    }
}

/// Which column the Harnesses tab has keyboard focus on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HarnessFocus {
    Features,
    Issues,
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
    /// Harnesses tab: the harness list + selection + the active harness's data.
    pub harnesses: Vec<HarnessRef>,
    pub harness_sel: usize,
    /// Active harness slug (display copy of `active_harness`).
    pub harness: String,
    /// Shared active-harness slug the backend poller reads each loop.
    pub active_harness: Arc<Mutex<String>>,
    pub features: Vec<HarnessFeature>,
    pub feat_sel: usize,
    pub issues: Vec<HarnessIssue>,
    pub issue_sel: usize,
    /// Which Harnesses column has focus (j/k + detail follow it).
    pub harness_focus: HarnessFocus,
    /// Docs tab: file list + selection + the active doc's content + scroll.
    pub docs_files: Vec<String>,
    pub doc_sel: usize,
    pub doc_content: String,
    pub doc_scroll: u16,
    /// Shared selected-doc path the poller fetches (None → endpoint's default).
    pub active_doc: Arc<Mutex<Option<String>>>,
    /// Activity tab: cross-harness recent activity.
    pub activity: Vec<ActivityEvent>,
    pub activity_sel: usize,
    /// Testing tab: testing domains for the active harness.
    pub testing: Vec<TestingDomain>,
    pub testing_sel: usize,
    /// Config tab: the active harness's claude-settings content (read-only).
    pub config: String,
    pub last_error: Option<String>,
    /// Help overlay visible.
    pub show_help: bool,
    /// Command palette open + its current input buffer.
    pub palette_open: bool,
    pub palette_input: String,
    /// Always-on presence sidebar visible (P7 — who's online + intent). `p` toggles.
    pub show_presence: bool,
    /// First-run tutorial overlay visible (P9). Set true at startup when the
    /// device hasn't seen it; any key dismisses it. Default false so tests and
    /// the reducer aren't perturbed — `main` decides the initial value.
    pub show_tutorial: bool,
    /// Notifications (P8). `notif_flash` is the latest one-line message shown in
    /// the status bar; `unseen_notifs` is the Inbox-tab badge count (cleared on
    /// visit); `notif_seq` advances on each new notification so the run-loop can
    /// fire one OS notification per new event. `inbox_loaded` suppresses the
    /// first-load storm (don't notify for items already present at startup).
    pub notif_flash: Option<String>,
    pub unseen_notifs: usize,
    pub notif_seq: u64,
    inbox_loaded: bool,
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
            harnesses: Vec::new(),
            harness_sel: 0,
            harness: "papercup".to_string(),
            active_harness: Arc::new(Mutex::new("papercup".to_string())),
            features: Vec::new(),
            feat_sel: 0,
            issues: Vec::new(),
            issue_sel: 0,
            harness_focus: HarnessFocus::Features,
            docs_files: Vec::new(),
            doc_sel: 0,
            doc_content: String::new(),
            doc_scroll: 0,
            active_doc: Arc::new(Mutex::new(None)),
            activity: Vec::new(),
            activity_sel: 0,
            testing: Vec::new(),
            testing_sel: 0,
            config: String::new(),
            last_error: None,
            show_help: false,
            palette_open: false,
            palette_input: String::new(),
            show_presence: true,
            show_tutorial: false,
            notif_flash: None,
            unseen_notifs: 0,
            notif_seq: 0,
            inbox_loaded: false,
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
        // Notify on newly-arrived needs-human items (P8) — but never on the very
        // first load (those items predate the session; flagging them all would
        // be a startup storm). Diff by id against the currently-held inbox.
        if self.inbox_loaded {
            let old_ids: HashSet<&str> = self.inbox.iter().map(|i| i.id.as_str()).collect();
            let fresh: Vec<&AttentionItem> = inbox
                .iter()
                .filter(|i| i.needs_human && !old_ids.contains(i.id.as_str()))
                .collect();
            if let Some(first) = fresh.first() {
                let n = fresh.len();
                self.notif_flash = Some(if n == 1 {
                    format!("needs you: {}", first.title)
                } else {
                    format!("{n} items need you — {}", first.title)
                });
                self.unseen_notifs += n;
                self.notif_seq += 1;
            }
        }
        self.inbox = inbox;
        self.inbox_loaded = true;
        self.clamp_sel();
    }

    pub fn set_features(&mut self, features: Vec<HarnessFeature>) {
        self.features = features;
        self.clamp_sel();
    }

    pub fn set_issues(&mut self, issues: Vec<HarnessIssue>) {
        self.issues = issues;
        if self.issue_sel >= self.issues.len() {
            self.issue_sel = self.issues.len().saturating_sub(1);
        }
    }

    pub fn set_harnesses(&mut self, harnesses: Vec<HarnessRef>) {
        self.harnesses = harnesses;
        if self.harness_sel >= self.harnesses.len() {
            self.harness_sel = self.harnesses.len().saturating_sub(1);
        }
        // Keep the active slug pointing at a real harness if the current one
        // isn't in the (freshly fetched) list.
        if !self.harnesses.iter().any(|h| h.slug == self.harness) {
            if let Some(h) = self.harnesses.get(self.harness_sel) {
                self.harness = h.slug.clone();
                self.harness_sel =
                    self.harnesses.iter().position(|x| x.slug == self.harness).unwrap_or(0);
                self.publish_active();
            }
        } else {
            self.harness_sel = self
                .harnesses
                .iter()
                .position(|x| x.slug == self.harness)
                .unwrap_or(self.harness_sel);
        }
    }

    /// Cycle the active harness by `delta` (wrapping). Returns true if it changed.
    pub fn cycle_harness(&mut self, delta: isize) -> bool {
        let n = self.harnesses.len();
        if n == 0 {
            return false;
        }
        let cur = self.harness_sel as isize;
        let next = ((cur + delta).rem_euclid(n as isize)) as usize;
        if next == self.harness_sel {
            return false;
        }
        self.harness_sel = next;
        self.harness = self.harnesses[next].slug.clone();
        self.features.clear();
        self.issues.clear();
        self.feat_sel = 0;
        self.issue_sel = 0;
        self.harness_focus = HarnessFocus::Features;
        self.docs_files.clear();
        self.doc_content.clear();
        self.doc_sel = 0;
        self.doc_scroll = 0;
        self.testing.clear();
        self.testing_sel = 0;
        self.config.clear();
        if let Ok(mut g) = self.active_doc.lock() {
            *g = None;
        }
        self.publish_active();
        true
    }

    fn publish_active(&self) {
        if let Ok(mut g) = self.active_harness.lock() {
            *g = self.harness.clone();
        }
    }

    /// Filesystem path of the active harness repo (for git launch), if known.
    pub fn active_repo_path(&self) -> Option<String> {
        self.harnesses
            .get(self.harness_sel)
            .and_then(|h| h.path.clone())
    }

    /// Launch `lazygit` scoped to the active harness repo.
    pub fn git_spec(&self) -> PaneSpec {
        let mut argv = vec!["lazygit".to_string()];
        if let Some(p) = self.active_repo_path() {
            argv.push("-p".to_string());
            argv.push(p);
        }
        PaneSpec::new(argv).titled(format!("git · {}", self.harness))
    }

    pub fn set_docs(&mut self, docs: DocsResponse) {
        self.docs_files = docs.files;
        self.doc_content = docs.content.unwrap_or_default();
        // Until the user picks a doc, follow the server's chosen active path.
        let no_selection = self.active_doc.lock().map(|g| g.is_none()).unwrap_or(true);
        if no_selection {
            if let Some(ap) = docs.active_path {
                if let Some(i) = self.docs_files.iter().position(|f| *f == ap) {
                    self.doc_sel = i;
                }
            }
        }
        if self.doc_sel >= self.docs_files.len() {
            self.doc_sel = self.docs_files.len().saturating_sub(1);
        }
    }

    /// Publish the selected doc path so the poller fetches its content.
    pub fn publish_active_doc(&self) {
        if let Ok(mut g) = self.active_doc.lock() {
            *g = self.docs_files.get(self.doc_sel).cloned();
        }
    }

    pub fn set_activity(&mut self, activity: Vec<ActivityEvent>) {
        self.activity = activity;
        if self.activity_sel >= self.activity.len() {
            self.activity_sel = self.activity.len().saturating_sub(1);
        }
    }

    pub fn set_testing(&mut self, testing: Vec<TestingDomain>) {
        self.testing = testing;
        if self.testing_sel >= self.testing.len() {
            self.testing_sel = self.testing.len().saturating_sub(1);
        }
    }

    pub fn set_config(&mut self, content: String) {
        self.config = content;
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

    pub fn selected_feature(&self) -> Option<&HarnessFeature> {
        self.features.get(self.feat_sel)
    }

    pub fn selected_issue(&self) -> Option<&HarnessIssue> {
        self.issues.get(self.issue_sel)
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
        if self.feat_sel >= self.features.len() {
            self.feat_sel = self.features.len().saturating_sub(1);
        }
        if self.issue_sel >= self.issues.len() {
            self.issue_sel = self.issues.len().saturating_sub(1);
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
            Event::Features(fs) => {
                self.set_features(fs);
                self.last_error = None;
                Action::Render
            }
            Event::Issues(is) => {
                self.set_issues(is);
                self.last_error = None;
                Action::Render
            }
            Event::Harnesses(hs) => {
                self.set_harnesses(hs);
                self.last_error = None;
                Action::Render
            }
            Event::Docs(d) => {
                self.set_docs(d);
                self.last_error = None;
                Action::Render
            }
            Event::Activity(a) => {
                self.set_activity(a);
                self.last_error = None;
                Action::Render
            }
            Event::Testing(t) => {
                self.set_testing(t);
                self.last_error = None;
                Action::Render
            }
            Event::Config(c) => {
                self.set_config(c);
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
        // First-run tutorial: any key dismisses it (and does nothing else).
        if self.show_tutorial {
            self.show_tutorial = false;
            return Action::Render;
        }
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
                // Visiting the inbox acknowledges pending notifications.
                self.unseen_notifs = 0;
                self.notif_flash = None;
                Action::Render
            }
            KeyCode::Char('3') => {
                self.tab = Tab::Sessions;
                Action::Render
            }
            KeyCode::Char('4') => {
                self.tab = Tab::Harnesses;
                Action::Render
            }
            KeyCode::Char('5') => {
                self.tab = Tab::Docs;
                Action::Render
            }
            KeyCode::Char('6') => {
                self.tab = Tab::Activity;
                Action::Render
            }
            KeyCode::Char('7') => {
                self.tab = Tab::Testing;
                Action::Render
            }
            KeyCode::Char('8') => {
                self.tab = Tab::Config;
                Action::Render
            }
            KeyCode::Char('p') => {
                self.show_presence = !self.show_presence;
                Action::Render
            }
            KeyCode::Char('n') if self.tab == Tab::Sessions => Action::Launch(self.launch_spec()),
            KeyCode::Char('g') => Action::Launch(self.git_spec()),
            KeyCode::Char(']') => {
                self.cycle_harness(1);
                Action::Render
            }
            KeyCode::Char('[') => {
                self.cycle_harness(-1);
                Action::Render
            }
            KeyCode::Tab if self.tab == Tab::Harnesses => {
                self.harness_focus = match self.harness_focus {
                    HarnessFocus::Features => HarnessFocus::Issues,
                    HarnessFocus::Issues => HarnessFocus::Features,
                };
                Action::Render
            }
            KeyCode::PageDown if self.tab == Tab::Docs => {
                self.doc_scroll = self.doc_scroll.saturating_add(10);
                Action::Render
            }
            KeyCode::PageUp if self.tab == Tab::Docs => {
                self.doc_scroll = self.doc_scroll.saturating_sub(10);
                Action::Render
            }
            KeyCode::Char('j') | KeyCode::Down => {
                self.move_sel(1);
                if self.tab == Tab::Docs {
                    self.doc_scroll = 0; // reset scroll when the selected doc changes
                    self.publish_active_doc();
                }
                Action::Render
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.move_sel(-1);
                if self.tab == Tab::Docs {
                    self.doc_scroll = 0;
                    self.publish_active_doc();
                }
                Action::Render
            }
            _ => Action::None,
        }
    }

    fn move_sel(&mut self, delta: isize) {
        let (len, slot): (usize, &mut usize) = match self.tab {
            Tab::Plans => (self.plans.len(), &mut self.plan_sel),
            Tab::Inbox => (self.inbox.len(), &mut self.inbox_sel),
            Tab::Sessions => (self.roster.len(), &mut self.roster_sel),
            Tab::Harnesses => match self.harness_focus {
                HarnessFocus::Features => (self.features.len(), &mut self.feat_sel),
                HarnessFocus::Issues => (self.issues.len(), &mut self.issue_sel),
            },
            Tab::Docs => (self.docs_files.len(), &mut self.doc_sel),
            Tab::Activity => (self.activity.len(), &mut self.activity_sel),
            Tab::Testing => (self.testing.len(), &mut self.testing_sel),
            Tab::Config => return, // no list to navigate
        };
        if len == 0 {
            return;
        }
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
    fn harnesses_tab_navigates_features() {
        use crate::models::HarnessFeature;
        let f = |id: &str| HarnessFeature {
            id: id.into(),
            title: id.into(),
            status: "todo".into(),
            attempts: 0,
        };
        let mut a = App::new();
        assert_eq!(a.update(key('4', KeyModifiers::NONE)), Action::Render);
        assert_eq!(a.tab, Tab::Harnesses);
        a.set_features(vec![f("F-1"), f("F-2")]);
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.feat_sel, 1);
        assert_eq!(a.features[a.feat_sel].id, "F-2");
    }

    #[test]
    fn harness_cycle_and_git_spec() {
        use crate::models::HarnessRef;
        let mut a = App::new();
        assert!(!a.cycle_harness(1)); // empty → no-op
        a.set_harnesses(vec![
            HarnessRef { slug: "papercup".into(), path: Some("/r/papercup".into()) },
            HarnessRef { slug: "restart".into(), path: Some("/r/restart".into()) },
        ]);
        assert_eq!(a.harness, "papercup");
        assert!(a.cycle_harness(1));
        assert_eq!(a.harness, "restart");
        assert_eq!(*a.active_harness.lock().unwrap(), "restart"); // shared cell follows
        assert_eq!(a.git_spec().argv, vec!["lazygit", "-p", "/r/restart"]);
        assert!(a.cycle_harness(1)); // wraps
        assert_eq!(a.harness, "papercup");
    }

    #[test]
    fn docs_tab_navigates_and_publishes_selection() {
        use crate::models::DocsResponse;
        let mut a = App::new();
        a.update(key('5', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Docs);
        a.set_docs(DocsResponse {
            files: vec!["a.md".into(), "sub/b.md".into()],
            active_path: Some("a.md".into()),
            content: Some("# A".into()),
        });
        assert_eq!(a.doc_sel, 0); // followed the server's active path
        assert_eq!(a.doc_content, "# A");
        a.update(key('j', KeyModifiers::NONE)); // select sub/b.md + publish
        assert_eq!(a.doc_sel, 1);
        assert_eq!(*a.active_doc.lock().unwrap(), Some("sub/b.md".to_string()));
    }

    #[test]
    fn testing_and_config_tabs_switch_and_nav() {
        use crate::models::TestingDomain;
        let mut a = App::new();
        assert_eq!(a.update(key('7', KeyModifiers::NONE)), Action::Render);
        assert_eq!(a.tab, Tab::Testing);
        a.set_testing(vec![
            TestingDomain { id: "unit".into(), label: "Unit".into(), description: "d".into(), tier: "universal".into() },
            TestingDomain { id: "e2e".into(), label: "E2E".into(), description: "d".into(), tier: "project".into() },
        ]);
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.testing_sel, 1);
        assert_eq!(a.update(key('8', KeyModifiers::NONE)), Action::Render);
        assert_eq!(a.tab, Tab::Config);
        a.set_config("xterm=1".into());
        assert_eq!(a.config, "xterm=1");
        // Config has no list; j/k is a no-op there.
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.tab, Tab::Config);
    }

    #[test]
    fn g_launches_git() {
        let mut a = App::new();
        match a.update(key('g', KeyModifiers::NONE)) {
            Action::Launch(spec) => assert_eq!(spec.argv[0], "lazygit"),
            other => panic!("expected Launch, got {other:?}"),
        }
    }

    #[test]
    fn harness_focus_toggles_and_navigates_issues() {
        use crate::models::{HarnessFeature, HarnessIssue};
        let issue = |id: &str| HarnessIssue {
            id: id.into(),
            title: id.into(),
            severity: "minor".into(),
            status: "open".into(),
            source: "x".into(),
            found_during: None,
            linked_feature_id: None,
            attempts: 0,
        };
        let mut a = App::new();
        a.update(key('4', KeyModifiers::NONE)); // Harnesses
        a.set_features(vec![HarnessFeature {
            id: "F-1".into(),
            title: "f".into(),
            status: "todo".into(),
            attempts: 0,
        }]);
        a.set_issues(vec![issue("I-1"), issue("I-2")]);
        assert_eq!(a.harness_focus, HarnessFocus::Features);
        // Tab switches focus to issues; j then moves the issue list.
        a.update(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
        assert_eq!(a.harness_focus, HarnessFocus::Issues);
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.issue_sel, 1);
        assert_eq!(a.selected_issue().unwrap().id, "I-2");
        // Tab back to features.
        a.update(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
        assert_eq!(a.harness_focus, HarnessFocus::Features);
    }

    #[test]
    fn doc_scroll_pgupdn_and_reset_on_change() {
        use crate::models::DocsResponse;
        let mut a = App::new();
        a.update(key('5', KeyModifiers::NONE)); // Docs
        a.set_docs(DocsResponse {
            files: vec!["a.md".into(), "b.md".into()],
            active_path: Some("a.md".into()),
            content: Some("x".into()),
        });
        assert_eq!(a.doc_scroll, 0);
        a.update(Event::Key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE)));
        a.update(Event::Key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE)));
        assert_eq!(a.doc_scroll, 20);
        a.update(Event::Key(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE)));
        assert_eq!(a.doc_scroll, 10);
        // Selecting a different doc resets scroll to top.
        a.update(key('j', KeyModifiers::NONE));
        assert_eq!(a.doc_sel, 1);
        assert_eq!(a.doc_scroll, 0);
    }

    #[test]
    fn tick_is_noop() {
        let mut a = App::new();
        assert_eq!(a.update(Event::Tick), Action::None);
    }

    fn attn(id: &str, needs_human: bool) -> AttentionItem {
        AttentionItem {
            id: id.into(),
            kind: "coord-escalation".into(),
            source: "coord".into(),
            harness_slug: None,
            plan_slug: Some("p".into()),
            item_ref: Some("P-001".into()),
            title: format!("Title {id}"),
            body: None,
            status: "needs-human".into(),
            importance: None,
            needs_human,
        }
    }

    #[test]
    fn inbox_first_load_does_not_notify() {
        let mut a = App::new();
        a.set_inbox(vec![attn("e1", true), attn("e2", true)]);
        assert_eq!(a.notif_seq, 0);
        assert_eq!(a.unseen_notifs, 0);
        assert!(a.notif_flash.is_none());
    }

    #[test]
    fn new_needs_human_item_notifies() {
        let mut a = App::new();
        a.set_inbox(vec![attn("e1", true)]); // first load — no notify
        a.set_inbox(vec![attn("e1", true), attn("e2", true)]); // e2 is new
        assert_eq!(a.notif_seq, 1);
        assert_eq!(a.unseen_notifs, 1);
        assert_eq!(a.notif_flash.as_deref(), Some("needs you: Title e2"));
        // A new non-needs-human item does NOT notify.
        a.set_inbox(vec![attn("e1", true), attn("e2", true), attn("e3", false)]);
        assert_eq!(a.notif_seq, 1);
        assert_eq!(a.unseen_notifs, 1);
    }

    #[test]
    fn multiple_new_items_count_and_summarize() {
        let mut a = App::new();
        a.set_inbox(vec![attn("e1", true)]);
        a.set_inbox(vec![attn("e1", true), attn("e2", true), attn("e3", true)]);
        assert_eq!(a.unseen_notifs, 2);
        assert_eq!(a.notif_seq, 1);
        assert!(a.notif_flash.as_deref().unwrap().starts_with("2 items need you"));
    }

    #[test]
    fn visiting_inbox_clears_notifications() {
        let mut a = App::new();
        a.set_inbox(vec![attn("e1", true)]);
        a.set_inbox(vec![attn("e1", true), attn("e2", true)]);
        assert_eq!(a.unseen_notifs, 1);
        a.update(key('2', KeyModifiers::NONE)); // visit Inbox
        assert_eq!(a.tab, Tab::Inbox);
        assert_eq!(a.unseen_notifs, 0);
        assert!(a.notif_flash.is_none());
    }

    #[test]
    fn p_toggles_presence_sidebar() {
        let mut a = App::new();
        assert!(a.show_presence); // on by default
        assert_eq!(a.update(key('p', KeyModifiers::NONE)), Action::Render);
        assert!(!a.show_presence);
        a.update(key('p', KeyModifiers::NONE));
        assert!(a.show_presence);
    }
}
