//! Typed models for the operator API responses the panels consume.
//!
//! Field sets match the live-probed shapes (SP-TUI plan, iteration 4). Unknown
//! fields are ignored (serde default) and nullable/absent fields are
//! Option/defaulted so a shape drift never hard-fails a deserialize.
#![allow(dead_code)] // DTOs mirror the full API shape; not every field is displayed yet.

use serde::{Deserialize, Serialize};

/// One row of `/api/admin/plans/list` → `{ plans: [...] }`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSummary {
    pub slug: String,
    // title / status / updated are non-Option strings, but the wire sends them as
    // `string | null` for legacy plans — tolerate null → "" (a plain
    // `#[serde(default)]` only covers an ABSENT key, so a null would otherwise sink
    // the whole plans decode and blank the Plans + Fleet tabs).
    #[serde(default, deserialize_with = "null_as_default")]
    pub title: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub status: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub updated: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub next_action: Option<String>,
    /// Item counts by effectiveStatus (`itemCounts`) — the fleet view aggregates
    /// these into plan progress (done/total). The wire sends `object | null`
    /// (legacy/empty plans report `null`), so tolerate null → all-zero default
    /// (a plain `#[serde(default)]` only covers an ABSENT key, NOT explicit null,
    /// and a null would otherwise hard-fail the whole plans decode).
    #[serde(default, deserialize_with = "null_as_default")]
    pub item_counts: ItemCounts,
    /// Plan priority (higher first); the fleet view orders active plans by it.
    #[serde(default)]
    pub priority: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlansResponse {
    #[serde(default)]
    pub plans: Vec<PlanSummary>,
}

/// One row of `/api/adv/roster` → `{ active: [...] }`. Presence (primary) +
/// adv_sessions enrichment; field set mirrors `adv-roster.ts`'s `RosterEntry`.
/// The location/handle fields (pid/pidAlive/host/windowId/ompThreadId/cwd/mode/
/// advSessionId/hasLaunchRecord) drive Enter-by-location routing (pui-workbench-
/// usability D-001): they tell where the agent lives so Enter reaches it instead
/// of silently focusing an empty pane.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterEntry {
    pub owner_id: String,
    #[serde(default)]
    pub label: String,
    /// client/source: claude · codex · omp · …
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub intent: Option<String>,
    #[serde(default)]
    pub current_files: Vec<String>,
    #[serde(default)]
    pub liveness: String,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub feature: Option<String>,
    #[serde(default)]
    pub current_plan_slug: Option<String>,
    #[serde(default)]
    pub heartbeat_at: Option<String>,
    // ── location / control handles (D-001) ──
    /// OS pid of the agent process; null for a remote/console row.
    #[serde(default)]
    pub pid: Option<i64>,
    /// Is the OS process alive? `Some(false)` = fresh heartbeat but dead process
    /// (a zombie — do NOT focus, it's resumable). `None` = unknown (remote/stale).
    #[serde(default)]
    pub pid_alive: Option<bool>,
    /// Hostname the agent runs on ("" = unknown/local); window-focus only works
    /// same-host.
    #[serde(default)]
    pub host: String,
    /// X11 window id of the agent's external terminal window (console launches).
    #[serde(default)]
    pub window_id: Option<String>,
    /// OMP thread id (resume handle for omp sessions).
    #[serde(default)]
    pub omp_thread_id: Option<String>,
    /// Working directory the session was launched in (resume cd target).
    #[serde(default)]
    pub cwd: Option<String>,
    /// Launch mode: "omp" | "console" (null = plain presence, no launch record).
    #[serde(default)]
    pub mode: Option<String>,
    /// adv_sessions row id — the `psu --resume <id>` handle (D-001 ended-session
    /// route) and the `/api/adv/sessions/focus` `id` lookup.
    #[serde(default)]
    pub adv_session_id: Option<i64>,
    /// Whether a joinable adv_sessions launch row exists (resume/focus eligible).
    #[serde(default)]
    pub has_launch_record: bool,
    // ── reactive workbench-pane hints (pui-reactive-session-panes D-002/D-006) ──
    /// Pane-worthiness hint: `Some("workbench")` on a PENDING launch the pui
    /// should reactively open a work-area pane for; `None` on a normal entry.
    /// The pui panes only `display == "workbench"` entries (the `pending` tier).
    #[serde(default)]
    pub display: Option<String>,
    /// The argv the pui pane runs for a pending workbench launch (a fresh
    /// `psu …`); empty for a normal entry.
    #[serde(default)]
    pub launch_argv: Vec<String>,
}

impl RosterEntry {
    /// Is the agent's process running right now? A live/idle heartbeat AND not a
    /// known zombie (`pid_alive == Some(false)` is a fresh heartbeat over a dead
    /// process). Used to decide focus-vs-resume so a resume never double-spawns a
    /// still-live session (D-001 liveness-first).
    pub fn is_live(&self) -> bool {
        self.pid_alive != Some(false) && !self.stale && self.liveness != "stale"
    }

    /// Can this agent be resumed by id? It needs an adv_sessions launch record
    /// (the `psu --resume <adv_session_id>` handle) and a known agent CLI.
    pub fn is_resumable(&self) -> bool {
        self.adv_session_id.is_some() && self.agent.is_some()
    }

    /// Does it carry a same-host external-window handle the focus route can use
    /// (an explicit window id, or a pid the route can resolve via wmctrl)?
    /// Cross-host pids can't be focused locally (and could collide), so they
    /// don't count.
    pub fn has_window_handle(&self, local_host: &str) -> bool {
        let same_host = self.host.is_empty() || self.host == local_host;
        let has_wid = self
            .window_id
            .as_deref()
            .map(|w| !w.is_empty())
            .unwrap_or(false);
        has_wid || (same_host && self.pid.is_some())
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RosterResponse {
    #[serde(default)]
    pub active: Vec<RosterEntry>,
    /// Pending workbench launches (pui-reactive-session-panes D-006): recorded but
    /// not-yet-running sessions, in a SEPARATE tier from `active`. The pui reads
    /// these to reactively open work-area panes; they never render in the roster.
    #[serde(default)]
    pub pending: Vec<RosterEntry>,
}

/// One attention item from `/api/admin/plans/attention` (Inbox). Covers all
/// three kinds (plan-item / coord-escalation / coord-message).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub harness_slug: Option<String>,
    #[serde(default)]
    pub plan_slug: Option<String>,
    #[serde(default)]
    pub item_ref: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub importance: Option<f64>,
    #[serde(default)]
    pub needs_human: bool,
    /// Inbox tier (inbox-tiering-and-message-agent D-006): decision | handled |
    /// alert | activity. Optional for back-compat with older payloads.
    #[serde(default)]
    pub tier: Option<String>,
    /// The owning agent (drives "Message owner").
    #[serde(default)]
    pub owner_agent_id: Option<String>,
    #[serde(default)]
    pub owner_label: Option<String>,
    /// Operator-triage overlay.
    #[serde(default)]
    pub triage_state: Option<String>,
    #[serde(default)]
    pub triage_note: Option<String>,
    /// Structured report payload (kind `operator-report` only) — the operator's
    /// `<report>` block, rendered natively as a two-tier plan→item list in the
    /// Inbox detail (report-cards-inbox-reconciliation-2026-06-05; chat is
    /// conversation-only).
    #[serde(default)]
    pub report: Option<crate::chat_tags::Report>,
}

/// The four inbox tiers (inbox-tiering-and-message-agent D-006), in display
/// order: Decisions ▸ Handled-by-operator ▸ Alerts ▸ Activity.
pub const INBOX_TIERS: [&str; 4] = ["decision", "handled", "alert", "activity"];

/// Human label for a tier string.
pub fn tier_label(tier: &str) -> &'static str {
    match tier {
        "decision" => "Decisions",
        "handled" => "Handled by operator",
        "alert" => "Alerts",
        _ => "Activity",
    }
}

/// Single-width, alignment-safe marker glyph for a tier (TUI in-line use).
/// Glyphs come from the shared vocabulary (`crate::glyph`, Brief 27) so a
/// vocabulary swap propagates here automatically.
pub fn tier_glyph(tier: &str) -> &'static str {
    match tier {
        "decision" => crate::glyph::status::NEEDS_HUMAN,
        "handled" => crate::glyph::status::DONE,
        "alert" => crate::glyph::severity::ALERT,
        _ => crate::glyph::severity::INFO,
    }
}

impl AttentionItem {
    /// Effective tier (older payloads without a tier read as activity).
    pub fn tier_str(&self) -> &str {
        self.tier.as_deref().unwrap_or("activity")
    }
    /// Sort rank — decision(0) ▸ handled(1) ▸ alert(2) ▸ activity(3).
    pub fn tier_rank(&self) -> u8 {
        match self.tier_str() {
            "decision" => 0,
            "handled" => 1,
            "alert" => 2,
            _ => 3,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionGroup {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub plan_slug: Option<String>,
    #[serde(default)]
    pub items: Vec<AttentionItem>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AttentionResponse {
    #[serde(default)]
    pub groups: Vec<AttentionGroup>,
}

/// One feature from the `list_features` agent-tool payload.
#[derive(Debug, Clone, Deserialize)]
pub struct HarnessFeature {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub attempts: u32,
}

/// Inner JSON of the `list_features` MCP envelope (`content[0].text`).
#[derive(Debug, Clone, Deserialize)]
pub struct FeaturesPayload {
    #[serde(default)]
    pub features: Vec<HarnessFeature>,
}

/// One issue from `/api/harness/:slug/issues` (mirrors `app/harness/issues/types` Issue).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessIssue {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub found_during: Option<String>,
    #[serde(default)]
    pub linked_feature_id: Option<String>,
    #[serde(default)]
    pub attempts: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IssuesResponse {
    #[serde(default)]
    pub issues: Vec<HarnessIssue>,
}

/// One harness from `/api/harness/projects/lite`.
#[derive(Debug, Clone, Deserialize)]
pub struct HarnessRef {
    pub slug: String,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectsResponse {
    #[serde(default)]
    pub projects: Vec<HarnessRef>,
}

// ─── Create / share pot (D-010) ───

/// `POST /api/harness/projects` result — the registered project on success;
/// `error` carries the backend's message (e.g. "slug already exists") on 4xx.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateProjectResponse {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub project: Option<HarnessRef>,
    #[serde(default)]
    pub error: Option<String>,
}

/// `POST /api/harness/binding/resolve` — a GitHub remote resolved to its
/// canonical repo identity (the share flow's first step). `github_repo` is the
/// bare repo NAME (it pairs with `github_owner`; publish calls it `github_name`).
#[derive(Debug, Clone, Deserialize)]
pub struct BindingResolveResponse {
    #[serde(default)]
    pub github_repository_id: i64,
    #[serde(default)]
    pub github_owner: String,
    #[serde(default)]
    pub github_repo: String,
    /// Repo visibility — Cupboard publish refuses private repos.
    #[serde(default)]
    pub private: bool,
    #[serde(default)]
    pub error: Option<String>,
}

// ─── Cupboard tab (D-011) ───

/// One marketplace listing from `GET /api/cupboard/listings` (the operator's
/// proxy onto the Cupboard worker). Field-tolerant: every field defaults so a
/// worker-side schema addition never breaks the tab.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
pub struct CupboardListing {
    #[serde(default)]
    pub id: String,
    /// harness | blueprint | snapshot | plugin (D-005 listing kinds).
    #[serde(default)]
    pub listing_kind: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// The Pot rollup key (D-008).
    #[serde(default)]
    pub project_ref: Option<String>,
    /// Within-project discriminator (blueprint/snapshot/plugin name).
    #[serde(default)]
    pub listing_ref: Option<String>,
    #[serde(default)]
    pub github_repository_id: Option<i64>,
    #[serde(default)]
    pub github_owner: Option<String>,
    #[serde(default)]
    pub github_name: Option<String>,
    #[serde(default)]
    pub github_url: Option<String>,
    /// 64-char hex Hypercore topic (harness listings).
    #[serde(default)]
    pub topic_hex: Option<String>,
    #[serde(default)]
    pub publisher_github_login: Option<String>,
    #[serde(default)]
    pub claim_status: Option<String>,
    #[serde(default)]
    pub stars: Option<i64>,
    #[serde(default)]
    pub contributor_count: Option<i64>,
    #[serde(default)]
    pub last_activity_at: Option<i64>,
    /// Ready-made `papercusp://harness?…` join link (harness listings; when
    /// absent the join flow derives it from topic/github/repo-id).
    #[serde(default)]
    pub harness_link: Option<String>,
}

impl CupboardListing {
    /// Display name: title > listing_ref > github repo > id.
    pub fn display_name(&self) -> &str {
        self.title
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(self.listing_ref.as_deref())
            .or(self.github_name.as_deref())
            .unwrap_or(&self.id)
    }

    /// The `papercusp://harness?…` join link for a harness listing — the
    /// published one, else derived from topic + github + repo id (the same
    /// fields `buildHarnessJoinLink` uses on the desktop).
    pub fn join_link(&self) -> Option<String> {
        if let Some(l) = self.harness_link.as_deref().filter(|s| !s.is_empty()) {
            return Some(l.to_string());
        }
        let topic = self.topic_hex.as_deref().filter(|s| !s.is_empty())?;
        let owner = self.github_owner.as_deref().filter(|s| !s.is_empty())?;
        let name = self.github_name.as_deref().filter(|s| !s.is_empty())?;
        let repo_id = self.github_repository_id?;
        Some(format!(
            "papercusp://harness?topic={topic}&github={owner}/{name}&repo_id={repo_id}"
        ))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct CupboardListingsResponse {
    #[serde(default)]
    pub listings: Vec<CupboardListing>,
}

// NOTE: the old Activity tab's `/api/harness/all/recent-activity` DTOs
// (ActivityEvent/ActivityResponse) were removed with the tab (D-004b) — the
// Fleet tab's `ActivityRow` (agent_activity) is the live activity surface.

/// One testing domain from `/api/harness/:slug/testing/domains`.
#[derive(Debug, Clone, Deserialize)]
pub struct TestingDomain {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tier: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TestingResponse {
    #[serde(default)]
    pub domains: Vec<TestingDomain>,
}

// ── Testing run-on-click (D-004a, pui-completion-and-polish-2026-06-05) ─────
//
// `GET /api/harness/:slug/testing/domain-detail?domainId=` resolves a domain's
// sections + their glob-walked files; the PUI flattens them into the runnable
// file list. `POST /api/harness/:slug/testing/run` runs one file (vitest,
// synchronous server-side) and returns the status + tail output.

/// One resolved file inside a testing-domain section (`{path,sizeBytes,mtimeMs}`;
/// only the path is rendered).
#[derive(Debug, Clone, Deserialize)]
pub struct TestingFileHit {
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TestingDomainSection {
    #[serde(default)]
    pub files: Vec<TestingFileHit>,
}

/// `GET /api/harness/:slug/testing/domain-detail` (only the file lists are kept).
#[derive(Debug, Clone, Deserialize)]
pub struct TestingDomainDetail {
    #[serde(default)]
    pub sections: Vec<TestingDomainSection>,
}

/// `POST /api/harness/:slug/testing/run` → the synchronous run result.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunResult {
    #[serde(default)]
    pub run_id: String,
    /// "pass" | "fail".
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub exit_code: i32,
    /// Tail of the runner output (server clips to the last 8000 chars).
    #[serde(default)]
    pub output: String,
}

/// `/api/harness/:slug/claude-settings/effective` → the editable Config-tab
/// view (D-013): the raw file body (`content` — what `:set`/`:unset` edit and
/// PUT back), the *effective* settings (Claude Code defaults overlaid by the
/// file), which top-level keys the file provides, and a parse error when the
/// on-disk file is broken (the tab then shows defaults + the error).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveClaudeSettings {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub effective: serde_json::Value,
    #[serde(default)]
    pub file_keys: Vec<String>,
    #[serde(default)]
    pub parse_error: Option<String>,
}

/// One row of the merged docs tree (`/api/harness/:slug/docs`, harness-docs-
/// integration-2026-06-05 P-009): per-doc source + drift status for the badges.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DocEntry {
    #[serde(default)]
    pub doc_id: String,
    /// generated | manual | augmented
    #[serde(default)]
    pub source: String,
    /// fresh | stale | review | untracked | unknown
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub subject_label: String,
}

/// The active doc's full entry — adds the human augmented overlay.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActiveDocEntry {
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub status_detail: Option<String>,
    #[serde(default)]
    pub subject_label: String,
    #[serde(default)]
    pub overlay: Option<String>,
}

/// `/api/harness/:slug/docs[?path=]` → the MERGED docs tree (generated · manual ·
/// augmented) with per-doc source + freshness + the active doc's overlay.
/// (Superset of the legacy project-docs shape, so old fields still deserialise.)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsResponse {
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub active_path: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub entries: Vec<DocEntry>,
    #[serde(default)]
    pub active_entry: Option<ActiveDocEntry>,
}

/// One row of `/api/toast-log` → `{ toasts: [...] }` (notification history, P8).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToastRow {
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub harness_slug: Option<String>,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToastsResponse {
    #[serde(default)]
    pub toasts: Vec<ToastRow>,
}

/// One pane the `plugins:tui_panes` agent-tool contributes (D-002, revive-plugin-
/// system-2026-06-04). `command` is the argv to run in a zellij pane (command[0]
/// is a PATH basename, e.g. `["sh","render.sh"]`); `cwd` is the dir to run it in.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TuiPaneContribution {
    #[serde(default)]
    pub plugin_name: String,
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub cwd: String,
}

/// Inner JSON of the `plugins:tui_panes` MCP envelope (`content[0].text`).
#[derive(Debug, Clone, Deserialize)]
pub struct TuiPanesPayload {
    #[serde(default)]
    pub panes: Vec<TuiPaneContribution>,
}

/// One plugin manifest from `GET /api/plugins/global` (D-007/D-014) — the
/// fields the Plugins tab renders: identity, the frontend/backend contribution
/// surfaces, and the `configSchema` driving the settings view. Contribution
/// fields are deliberately loose `Value`s (manifests vary; the tab only counts
/// + names them via [`contribution_count`]/[`contribution_names`]).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    // Frontend contributions.
    #[serde(default)]
    pub ui: serde_json::Value,
    #[serde(default)]
    pub dashboard_tabs: serde_json::Value,
    #[serde(default)]
    pub sidebar_items: serde_json::Value,
    // Backend contributions.
    #[serde(default)]
    pub tools: serde_json::Value,
    #[serde(default)]
    pub actions: serde_json::Value,
    #[serde(default)]
    pub api_routes: serde_json::Value,
    #[serde(default)]
    pub routines: serde_json::Value,
    // Settings (D-014).
    #[serde(default)]
    pub config_schema: Option<serde_json::Value>,
    #[serde(default)]
    pub default_config: Option<serde_json::Value>,
}

impl PluginManifest {
    /// Frontend contribution count: ui[] + dashboardTabs[] + sidebarItems[].
    pub fn frontend_count(&self) -> usize {
        contribution_count(&self.ui)
            + contribution_count(&self.dashboard_tabs)
            + contribution_count(&self.sidebar_items)
    }

    /// Backend contribution count: tools + actions + apiRoutes + routines.
    pub fn backend_count(&self) -> usize {
        contribution_count(&self.tools)
            + contribution_count(&self.actions)
            + contribution_count(&self.api_routes)
            + contribution_count(&self.routines)
    }
}

/// How many contributions a loose manifest field declares — array length,
/// object key count, or 0 for anything else (absent/null/scalar).
pub fn contribution_count(v: &serde_json::Value) -> usize {
    match v {
        serde_json::Value::Array(a) => a.len(),
        serde_json::Value::Object(o) => o.len(),
        _ => 0,
    }
}

/// Human labels for a loose contribution field: array items' `name`/`label`/
/// `id`/`type` (first present), or object keys. Used by the detail pane.
pub fn contribution_names(v: &serde_json::Value) -> Vec<String> {
    match v {
        serde_json::Value::Array(a) => a
            .iter()
            .map(|item| {
                for k in ["name", "label", "id", "type"] {
                    if let Some(s) = item.get(k).and_then(|x| x.as_str()) {
                        return s.to_string();
                    }
                }
                if let Some(s) = item.as_str() {
                    return s.to_string();
                }
                "(unnamed)".to_string()
            })
            .collect(),
        serde_json::Value::Object(o) => o.keys().cloned().collect(),
        _ => Vec::new(),
    }
}

/// `GET /api/plugins/global` → `{plugins}`.
#[derive(Debug, Clone, Deserialize)]
pub struct PluginsGlobalResponse {
    #[serde(default)]
    pub plugins: Vec<PluginManifest>,
}

/// `GET /api/plugins/config?harness=&plugin=` → `{config}` (D-014).
#[derive(Debug, Clone, Deserialize)]
pub struct PluginConfigResponse {
    #[serde(default)]
    pub config: serde_json::Value,
}

/// One human-facing entry from `GET /api/coord/inbox` (P-002 / D-003b) — the
/// coord messages/escalations/handoffs addressed to the human. Field names match
/// the route's `HistoryItem` JSON (snake_case).
#[derive(Debug, Clone, Deserialize)]
pub struct CoordMsg {
    #[serde(default)]
    pub ts: String,
    #[serde(default)]
    pub msg_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub harness_slug: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CoordInboxResponse {
    #[serde(default)]
    pub items: Vec<CoordMsg>,
}

/// An in-app notification (P8), built from either a live `attention.notify` SSE
/// event or a `/api/toast-log` history row. Not deserialized directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notif {
    /// Severity/importance ("urgent"/"high"/… or a toast level like "error").
    pub level: String,
    pub message: String,
    pub harness: Option<String>,
    /// Source timestamp for history rows; `None` for a live ("now") event.
    pub ts: Option<String>,
}

// ─── Workbench persistence (P12 / D-002): tui_view_state / tui_layouts / tui_crews ───

/// The quiet UI/nav state the workbench persists + restores (one row per user,
/// `harness_shared.tui_view_state`). Every field defaults so an older/newer
/// shape never hard-fails a load. Round-trips both ways (sent on PUT, read on
/// GET); the empty `{}` the server returns when nothing's saved deserializes to
/// `ViewState::default()`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewState {
    /// Active tab by its title ("Plans", "Sessions", …) — title not index so a
    /// tab reorder doesn't move the user to the wrong place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
    /// Active harness slug.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    /// POTS scope axis (D-003): "all" | "pot". `None` (an older snapshot)
    /// keeps the app default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Which Harnesses column had focus ("features" | "issues").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_focus: Option<String>,
    #[serde(default)]
    pub plan_sel: usize,
    #[serde(default)]
    pub inbox_sel: usize,
    #[serde(default)]
    pub harness_sel: usize,
    #[serde(default)]
    pub feat_sel: usize,
    #[serde(default)]
    pub issue_sel: usize,
    #[serde(default)]
    pub doc_sel: usize,
    #[serde(default)]
    pub doc_scroll: u16,
    #[serde(default)]
    pub testing_sel: usize,
    #[serde(default)]
    pub pane_sel: usize,
    #[serde(default)]
    pub show_presence: bool,
    /// Operator dock (operator-always-visible-2026-06-05, Brief 24): whether the
    /// operator chat is docked beside the active tab. Persisted so the dock
    /// survives a restart; an older snapshot (absent) defaults closed.
    #[serde(default)]
    pub operator_dock_open: bool,
    /// Fleet tab (pui-fleet-status-view): the selected agent + the view mode
    /// ("curated" | "mirror"), so the dashboard restores where it was left.
    #[serde(default)]
    pub fleet_agent_sel: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fleet_mode: Option<String>,
    /// Plans filter (D-009): the selected plan slugs narrowing the Inbox list
    /// and the Fleet roster (empty = no filtering), plus whether the
    /// collapsible left rail is open.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plan_filter: Vec<String>,
    #[serde(default)]
    pub plan_filter_open: bool,
}

/// `GET /api/tui/view-state` → `{ state: {...} }`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ViewStateResponse {
    #[serde(default)]
    pub state: ViewState,
}

/// One saved agent session inside a crew (`tui_crews.members[]`). All optional —
/// a pane may be a bare shell with no bound agent/harness/plan.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrewMember {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// A layout list row (`GET /api/tui/layouts` — summary, no kdl).
#[derive(Debug, Clone, Deserialize)]
pub struct LayoutSummary {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct LayoutsResponse {
    #[serde(default)]
    pub layouts: Vec<LayoutSummary>,
}

/// A full layout (`GET /api/tui/layouts/:name`).
#[derive(Debug, Clone, Deserialize)]
pub struct LayoutRow {
    pub name: String,
    #[serde(default)]
    pub kdl: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

/// A crew list row (`GET /api/tui/crews` — summary, no members).
#[derive(Debug, Clone, Deserialize)]
pub struct CrewSummary {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub layout_name: Option<String>,
    #[serde(default)]
    pub member_count: u32,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CrewsResponse {
    #[serde(default)]
    pub crews: Vec<CrewSummary>,
}

/// A full crew (`GET /api/tui/crews/:name`).
#[derive(Debug, Clone, Deserialize)]
pub struct CrewRow {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub layout_name: Option<String>,
    #[serde(default)]
    pub members: Vec<CrewMember>,
}

/// `GET /api/flags/bootstrap` → `{ flags: {key: bool}, source, evaluatedAt }`.
/// The read-only Settings tab (P10) renders these. BTreeMap keeps the display
/// order stable (and tests deterministic).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FlagsResponse {
    #[serde(default)]
    pub flags: std::collections::BTreeMap<String, bool>,
    #[serde(default)]
    pub source: String,
}

// ─── Plan-item assignment / claim / liveness (P-005a, tui-workbench-ratatui) ───
//
// `GET /api/tui/plan-item-states?harness=&plan=` → the merged per-item disposition
// from plan-item-assignment-claim-liveness-2026-06-04 (assignment ⋈ live claim).
// Read-only surface: who a plan item is assigned to + who holds the live lease +
// whether the harness leases on availability (LOCAL) or activity (SHARED). camelCase
// wire (the operator DTO's field names).

/// One plan item's merged assignment+claim disposition.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItemState {
    pub item_id: String,
    /// The plan item's effective status (todo/wip/…); null for an orphan record.
    #[serde(default)]
    pub item_status: Option<String>,
    #[serde(default)]
    pub in_plan: bool,
    /// pooled | assigned-idle | active | claimed-pooled | claimed-mismatch.
    #[serde(default)]
    pub disposition: String,
    /// Durable assignment (the stable agent-NAME the item belongs to), or null.
    #[serde(default)]
    pub assignee_name: Option<String>,
    /// Live claim holder's display label (ownerLabel ?? owner), or null.
    #[serde(default)]
    pub claim_owner: Option<String>,
    /// Live claim holder's agent-NAME, or null.
    #[serde(default)]
    pub claim_owner_name: Option<String>,
    /// Live claim's declared intent, or null.
    #[serde(default)]
    pub claim_intent: Option<String>,
    /// availability (LOCAL) | activity (SHARED), or null if no live claim.
    #[serde(default)]
    pub claim_liveness_mode: Option<String>,
    /// Live claim's lease expiry (ISO), or null.
    #[serde(default)]
    pub claim_expires_ts: Option<String>,
}

/// `GET /api/tui/plan-item-states` → `{ harness, plan, harnessLivenessMode, items }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItemStates {
    #[serde(default)]
    pub harness: String,
    #[serde(default)]
    pub plan: String,
    /// availability (LOCAL) | activity (SHARED) — the harness's claim-liveness split.
    #[serde(default)]
    pub harness_liveness_mode: String,
    #[serde(default)]
    pub items: Vec<PlanItemState>,
}

// ─── Operator config overview (P10b — read-only slice of the settings port) ───
//
// The Settings tab surfaces a READ-ONLY view of the operator's running config: the
// AI backend + per-role model routing (/api/agent-config) and which speech providers
// are connected (operator:credentials_status — booleans only, never secret values).
// The write-side settings (credential entry, OAuth sign-in, device pairing, wake-word)
// are interactive/desktop-native and intentionally NOT ported to the TUI.

/// The inner `config` of `/api/agent-config`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigInner {
    #[serde(default)]
    pub backend: String,
    #[serde(default)]
    pub cmd: String,
    /// Per-pipeline-role model overrides (worker → opus, merge-resolver → opus:xhigh).
    #[serde(default)]
    pub models: std::collections::BTreeMap<String, String>,
    /// Per-chat-surface model (operator → sonnet).
    #[serde(default)]
    pub surface_models: std::collections::BTreeMap<String, String>,
}

/// `GET /api/agent-config` → `{ config: {...}, effectiveBackend, binaries, envOverrides }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigResponse {
    #[serde(default)]
    pub config: AgentConfigInner,
    #[serde(default)]
    pub effective_backend: String,
}

/// One provider's credential status from `operator:credentials_status` — whether a
/// key is set. `masked` is a display hint, never the secret itself.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CredStatus {
    #[serde(default)]
    pub set: bool,
    #[serde(default)]
    pub masked: Option<String>,
}

/// The assembled operator-config overview the Settings tab renders. Built in the
/// client from the agent-config GET + the credentials-status tool (NOT one wire
/// shape); `providers` is sorted (name, set) for a stable display.
#[derive(Debug, Clone, Default)]
pub struct OperatorConfig {
    pub agent: Option<AgentConfigResponse>,
    pub providers: Vec<(String, bool)>,
}

// ─── Fleet status view (pui-fleet-status-view-2026-06-04) ───────────────────────
//
// The Fleet tab is a unified, fleet-wide dashboard: plan/work_item progress +
// subagent status + a live activity overlay (the worker-integration bridge). The
// DTOs below back it; the view state + render live in `fleet.rs`.

/// Deserialize a possibly-`null` field as its `Default`. serde's
/// `#[serde(default)]` only fills an ABSENT key — an explicit `null` would still
/// hard-fail. Used for `itemCounts` (`object | null` on the wire).
fn null_as_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// Per-plan item counts by effectiveStatus, from `/api/admin/plans/list`'s
/// `itemCounts`. All optional — an empty plan reports `{}` → all-zero.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct ItemCounts {
    #[serde(default)]
    pub todo: u32,
    #[serde(default)]
    pub wip: u32,
    #[serde(default)]
    pub blocked: u32,
    #[serde(default, rename = "needs-human")]
    pub needs_human: u32,
    #[serde(default)]
    pub done: u32,
    #[serde(default)]
    pub dropped: u32,
    #[serde(default)]
    pub unknown: u32,
}

impl ItemCounts {
    /// All items across every status.
    pub fn total(&self) -> u32 {
        self.todo
            + self.wip
            + self.blocked
            + self.needs_human
            + self.done
            + self.dropped
            + self.unknown
    }
    /// Items still to do (everything that isn't done or dropped).
    pub fn remaining(&self) -> u32 {
        self.total().saturating_sub(self.done + self.dropped)
    }
}

/// One row of `work_items:list` (unify-work-items-2026-06-04). The tool wraps
/// `{ ok, count, items: [...] }` in an MCP envelope (`content[0].text`); the
/// client unwraps it. Only the fields the fleet view renders are kept.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub id: String,
    /// feature | research-task | chunk | bug | change.
    #[serde(default)]
    pub kind: String,
    /// feature | issue.
    #[serde(default)]
    pub family: String,
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub title: String,
    /// Kind-specific lifecycle state (feature: status; issue: open|resolved|closed).
    #[serde(default)]
    pub state: String,
    /// Claimable owner (feature → taken_by; issue → assignee).
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub severity: Option<String>,
}

/// Inner JSON of the `work_items:list` envelope (`content[0].text`).
#[derive(Debug, Clone, Deserialize)]
pub struct WorkItemsPayload {
    #[serde(default)]
    pub items: Vec<WorkItem>,
}

/// One worker-activity row (papercusp-worker-integration-2026-06-04). Emitted by
/// both `activity:recent` (`{activity:[...]}`) and the `/api/activity/stream` SSE
/// (`event: activity`). The wire is snake_case; `summary` is already server-side
/// enriched (e.g. `✎ generated.ts`, `▶ npm test`).
#[derive(Debug, Clone, Deserialize)]
pub struct ActivityRow {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub owner_id: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub harness_slug: Option<String>,
    /// tool | lifecycle | todos.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    /// JSONB detail — for a `kind:"todos"` row this is `{count,done,todos:[...]}`.
    #[serde(default)]
    pub detail: Option<serde_json::Value>,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActivityRecentPayload {
    #[serde(default)]
    pub activity: Vec<ActivityRow>,
}

/// One todo from a worker's TodoWrite/TaskCreate snapshot (D-004 worker-todo
/// mirroring), stored in `agent_activity.detail.todos` for a `kind:"todos"` row.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct TodoItem {
    #[serde(default)]
    pub content: String,
    /// pending | in_progress | completed | …
    #[serde(default)]
    pub status: Option<String>,
}

/// A worker's todo snapshot (the `detail` of a `kind:"todos"` activity row).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TodoSnapshot {
    #[serde(default)]
    pub count: u32,
    #[serde(default)]
    pub done: u32,
    #[serde(default)]
    pub todos: Vec<TodoItem>,
}

// ─── Memory tab (D-006 Step 2, pui-completion-and-polish-2026-06-05) ────────
//
// The PUI Memory tab reads the `memory:list` / `memory:search` agent tools
// (MCP envelope, `content[0].text` JSON = `{ok, reason?, results}`). The tab
// shows whatever the configured memory BACKEND holds (mem0 today, the
// MemoryBackend interface once D-006 Step 1 lands) — `ok:false` renders the
// backend-unavailable empty state rather than an error.

/// One memory entry (mem0 shape: `memory` is the fact text; `metadata.kind`
/// is identity|preference|project|correction; `score` only on search hits).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MemoryEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub memory: String,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub score: Option<f64>,
}

impl MemoryEntry {
    /// The entry's kind from metadata (empty when unset).
    pub fn kind(&self) -> String {
        self.metadata
            .as_ref()
            .and_then(|m| m.get("kind"))
            .and_then(|k| k.as_str())
            .unwrap_or("")
            .to_string()
    }
}

/// Inner JSON of the `memory:list` / `memory:search` envelopes.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MemoriesPayload {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub results: Vec<MemoryEntry>,
}

// ─── Operator chat pane (tui-operator-surface-2026-06-04) ───

/// A tool the operator called mid-turn — rendered as a chip under its message.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatToolCall {
    pub name: String,
}

/// One rendered chat message in the operator pane. Built from a persisted turn
/// (history load) or live during a turn — NOT deserialized directly. While an
/// assistant message is `streaming`, `content` holds the raw accumulated delta
/// text (rendered through `chat_tags::live_preview`); once the turn finalizes it
/// holds the user-visible `<say>` body (`chat_tags::finalize`).
#[derive(Debug, Clone, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    pub tools: Vec<ChatToolCall>,
    pub streaming: bool,
}

impl ChatMessage {
    pub fn user(text: &str) -> Self {
        Self {
            role: "user".into(),
            content: text.into(),
            tools: Vec::new(),
            streaming: false,
        }
    }
    pub fn assistant(text: &str) -> Self {
        Self {
            role: "assistant".into(),
            content: text.into(),
            tools: Vec::new(),
            streaming: false,
        }
    }
    /// The in-flight assistant bubble — empty, `streaming`, accumulates deltas.
    pub fn streaming_assistant() -> Self {
        Self {
            role: "assistant".into(),
            content: String::new(),
            tools: Vec::new(),
            streaming: true,
        }
    }
}

/// `GET /api/operator/conversations?limit=N` → the workspace's active operator
/// conversation + recent turns (oldest first). Only the fields the pane needs;
/// the rest of the conversation/turn shape is ignored.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationLoad {
    pub conversation: ConversationRef,
    #[serde(default)]
    pub turns: Vec<TurnDto>,
    #[serde(default)]
    pub has_more_earlier: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConversationRef {
    pub id: String,
}

/// One persisted operator turn (`operator_turns`). seq/role/text/tools are what
/// the pane renders; el_conv_id/audio_url/created_at/source are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct TurnDto {
    #[serde(default)]
    pub seq: i64,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub tools: Option<Vec<TurnToolDto>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TurnToolDto {
    #[serde(default)]
    pub name: String,
}

/// `GET /api/operator/conversations/:id/turns?beforeSeq=N&limit=M` → an older
/// page of turns (oldest first within the page) + whether more exist before it.
/// The chat pane's load-earlier cursor reads `turns` + `has_more_earlier`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnsPage {
    #[serde(default)]
    pub turns: Vec<TurnDto>,
    #[serde(default)]
    pub has_more_earlier: bool,
}

// ── Conversations (Brief 25, conversations-tab-2026-06-05) ───────────────────
// The coord conversations browse surface. Shapes match the snake_case JSON the
// `conversations:*` tools return (NO camelCase rename, unlike the plan/issue
// DTOs above): conversations:list → ConvListResponse, conversations:get →
// ConvGetResponse (the conversation fields are nested under `conversation`,
// with topics/posts/subscriber_count as top-level siblings).

/// One row of `conversations:list` → `{ conversations: [...] }`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConvSummary {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub harness_slug: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub asker_id: String,
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub promoted_issue_id: Option<String>,
    #[serde(default)]
    pub created_ts: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConvListResponse {
    #[serde(default)]
    pub conversations: Vec<ConvSummary>,
}

/// The conversation object nested under `conversation` in conversations:get.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConvCore {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub harness_slug: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub asker_id: String,
    #[serde(default)]
    pub accepted_answer: Option<String>,
    #[serde(default)]
    pub promoted_issue_id: Option<String>,
    #[serde(default)]
    pub created_ts: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConvPost {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub author_id: Option<String>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub created_ts: String,
}

/// `conversations:get` → conversation + topics + posts + subscriber_count as
/// top-level siblings. Stored whole as the selected-conversation detail.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ConvDetail {
    #[serde(default)]
    pub conversation: Option<ConvCore>,
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub posts: Vec<ConvPost>,
    #[serde(default)]
    pub subscriber_count: i64,
}

/// Fleet rate/usage read-model (rate-limit-layer-v2 P-013/D-004): the `status`
/// half of GET `/api/operator/rate-limit-config` (`buildFleetRateStatus`).
/// Rendered in the Overview top-bar (overview-dashboard Brief 23 P-005);
/// `config.max_simultaneous_agents` is the user-editable hard cap (`+`/`-`
/// on the Overview tab → PUT).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FleetRateStatus {
    #[serde(default)]
    pub config: FleetRateConfig,
    #[serde(default)]
    pub fleet: FleetRateFleet,
    #[serde(default)]
    pub buckets: Vec<FleetRateBucket>,
    #[serde(default)]
    pub usage: FleetRateUsage,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FleetRateConfig {
    #[serde(default)]
    pub max_simultaneous_agents: u32,
    #[serde(default)]
    pub concurrency_floor: u32,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FleetRateFleet {
    #[serde(default)]
    pub cap: u32,
    #[serde(default)]
    pub in_flight: u32,
    #[serde(default)]
    pub effective: u32,
    #[serde(default)]
    pub floor: u32,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FleetRateBucket {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub paused: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FleetRateUsage {
    #[serde(default)]
    pub spend_usd: f64,
    #[serde(default)]
    pub calls: u64,
    #[serde(default)]
    pub buckets: Vec<FleetRateUsageBucket>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FleetRateUsageBucket {
    #[serde(default)]
    pub key: String,
    /// Bucket usage 0..100; None when the provider exposes no ceiling
    /// (subscription paths) — never fabricated (rate-limit v2 D-002).
    #[serde(default)]
    pub usage_pct: Option<f64>,
}

impl FleetRateStatus {
    /// Headline usage%: the WORST known bucket. None when no bucket exposes a
    /// ceiling — render a dash, never fabricate. Mirrors the desktop's
    /// `headlineUsagePct`.
    pub fn headline_usage_pct(&self) -> Option<f64> {
        self.usage
            .buckets
            .iter()
            .filter_map(|b| b.usage_pct)
            .filter(|p| p.is_finite())
            .fold(None, |worst: Option<f64>, p| {
                Some(match worst {
                    Some(w) if w >= p => w,
                    _ => p,
                })
            })
    }
    /// Count of currently rate-limit-paused governor buckets.
    pub fn paused_count(&self) -> usize {
        self.buckets.iter().filter(|b| b.paused).count()
    }
}

// ─── Bee-dossier dock pane (pui-bee-dossier-pane-2026-06-06) ─────────────────

/// One item on a bee's ordered work-list — a `queued`/`doing` entry from the
/// `fleet:assignments` view (the externalized per-bee TodoWrite the Queen reads).
/// Wire is camelCase (`itemKind`, `rankWriter`).
#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BeeWorkItem {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub item_kind: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: Option<String>,
    /// Position in the holder's ordered work-list (rank ASC; NULL = unranked, last).
    #[serde(default)]
    pub rank: Option<i64>,
    /// Who placed it — "bee" (self) | "queen" (overlay) | null (unranked).
    #[serde(default)]
    pub rank_writer: Option<String>,
}

/// One agent's assignment from `fleet:assignments` (`agents[]`) — the dossier's
/// top region. Only the fields the bee pane renders are kept.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BeeAssignment {
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub alive: bool,
    #[serde(default)]
    pub intent: String,
    /// The bee's work-items in rank order (head-of-line first; unranked last).
    #[serde(default)]
    pub queued: Vec<BeeWorkItem>,
    /// Work-item count — the load signal.
    #[serde(default)]
    pub load: i64,
    /// Self-declared current plan (presence) — feeds the per-agent plan filter
    /// (pui-dock-consolidation-2026-06-07 #2).
    #[serde(default)]
    pub declared_plan_slug: Option<String>,
    /// The agent's claims (plan-item + work-item) — only the plan linkage is
    /// kept; the rest of the wire claim is ignored.
    #[serde(default)]
    pub claims: Vec<BeeClaim>,
}

/// One claim row on a `fleet:assignments` agent — trimmed to the plan linkage
/// the Fleet plan-progress filter needs (#2).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BeeClaim {
    #[serde(default)]
    pub plan_slug: Option<String>,
}

impl BeeAssignment {
    /// Every plan slug this agent is linked to — its declared plan + any plan
    /// its claims touch. Backs the agent-filtered plan-progress view (#2).
    pub fn plan_slugs(&self) -> std::collections::HashSet<&str> {
        let mut set: std::collections::HashSet<&str> = self
            .claims
            .iter()
            .filter_map(|c| c.plan_slug.as_deref())
            .collect();
        if let Some(p) = self.declared_plan_slug.as_deref() {
            set.insert(p);
        }
        set
    }
}

/// Inner JSON of the `fleet:assignments` envelope (`content[0].text`).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct FleetAssignmentsPayload {
    #[serde(default)]
    pub agents: Vec<BeeAssignment>,
}

/// One coord-mail entry on the bee-dossier pane (a `fleet:bee_mail` envelope
/// inbox/outbox line). The wire is the raw coord envelope (snake_case).
#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
pub struct BeeMailEntry {
    #[serde(default)]
    pub ts: String,
    #[serde(default)]
    pub msg_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub from: Option<String>,
    /// Recipients (["*"] = broadcast, ["human"] = surfaced to the user).
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
}

/// One side (inbox/outbox) of `fleet:bee_mail`.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct BeeMailSide {
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub entries: Vec<BeeMailEntry>,
}

/// Inner JSON of the `fleet:bee_mail` envelope (`content[0].text`).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct BeeMailPayload {
    #[serde(default)]
    pub owner_id: String,
    #[serde(default)]
    pub inbox: BeeMailSide,
    #[serde(default)]
    pub outbox: BeeMailSide,
}

// ─── Hives tab (p2p swarm roster — pui-hives-tab-2026-06-07) ─────────────────

/// One unified `coord:presence` row — only the fields the Hives tab reads.
/// Federated rows (remote peers projected from `shared_presence` announces)
/// carry `federated: true` plus the machine/device identity; local session
/// rows are filtered out client-side. Wire is camelCase.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PresenceRow {
    #[serde(default)]
    pub owner_id: String,
    #[serde(default)]
    pub owner_label: String,
    #[serde(default)]
    pub intent: String,
    /// The peer's machine label (federation identity half; `host` on the wire).
    #[serde(default)]
    pub host: String,
    /// The gh user id (stringified) for federated rows.
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub stale: bool,
    /// True for a row sourced from the p2p swarm (`shared_presence`).
    #[serde(default)]
    pub federated: bool,
    /// The peer's device pubkey (raw-32-byte-base64 Ed25519 — the hive identity).
    #[serde(default)]
    pub device_pubkey: Option<String>,
    /// The harness the peer announced presence in (shared_presence is per-harness).
    #[serde(default)]
    pub harness_slug: Option<String>,
    /// The peer's current view (the federated analogue of currentPlanSlug).
    #[serde(default)]
    pub current_view: Option<String>,
    /// ISO timestamp of the peer's last announce (freshness; ISO sorts lexically).
    #[serde(default)]
    pub heartbeat_at: Option<String>,
}

/// Inner JSON of the `coord:presence` envelope (`content[0].text`). `stale`
/// is only present when the call passes `include_stale: true`.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct PresencePayload {
    #[serde(default)]
    pub active: Vec<PresenceRow>,
    #[serde(default)]
    pub stale: Vec<PresenceRow>,
}

// ─── Hive lexicon (pui-hive-lexicon-2026-06-06) ──────────────────────────────

/// Singular/plural display forms for one lexicon term.
#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
pub struct TermForms {
    #[serde(default)]
    pub one: String,
    #[serde(default)]
    pub other: String,
}

/// Inner JSON of the `lexicon:active_pack` envelope (`content[0].text`): the
/// active brand pack id + the full term → forms map (presentation only).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct LexiconPackPayload {
    #[serde(default, rename = "packId")]
    pub pack_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub terms: std::collections::HashMap<String, TermForms>,
}

#[cfg(test)]
mod fleet_rate_tests {
    use super::*;

    #[test]
    fn fleet_rate_status_decodes_wire_and_derives() {
        let json = r#"{
          "config": {"maxSimultaneousAgents": 6, "concurrencyFloor": 1},
          "fleet": {"cap": 6, "inFlight": 3, "effective": 4, "floor": 1},
          "buckets": [
            {"key":"anthropic:big","paused":true,"pausedUntil":null},
            {"key":"openai:big","paused":false}
          ],
          "usage": {"spendUsd": 1.234, "calls": 42, "buckets":[
            {"key":"a","usagePct":37.5},
            {"key":"b","usagePct":null},
            {"key":"c","usagePct":80.0}
          ]}
        }"#;
        let s: FleetRateStatus = serde_json::from_str(json).unwrap();
        assert_eq!(s.config.max_simultaneous_agents, 6);
        assert_eq!(s.fleet.in_flight, 3);
        assert_eq!(s.fleet.effective, 4);
        assert_eq!(s.paused_count(), 1);
        // Headline = the WORST known bucket; null-ceiling buckets ignored.
        assert_eq!(s.headline_usage_pct(), Some(80.0));
    }

    #[test]
    fn fleet_rate_headline_is_none_when_no_ceiling_known() {
        // Subscription paths expose no ceiling → None, never fabricated.
        let s: FleetRateStatus =
            serde_json::from_str(r#"{"usage":{"buckets":[{"key":"x","usagePct":null}]}}"#).unwrap();
        assert_eq!(s.headline_usage_pct(), None);
        // And a fully-empty payload decodes via defaults.
        let empty: FleetRateStatus = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.paused_count(), 0);
        assert_eq!(empty.headline_usage_pct(), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_coord_inbox_shape() {
        // Trimmed from the /api/coord/inbox HistoryItem shape (snake_case).
        let j = r#"{"items":[
            {"ts":"2026-06-04T16:00:00Z","msg_id":"m-1","source":"message","kind":"message",
             "from":"su-30a41","to":["human"],"plan_slug":null,"harness_slug":"papercup",
             "summary":"please review the carve","payload":{}},
            {"ts":"2026-06-04T15:00:00Z","msg_id":"m-2","source":"escalation","kind":"coord-escalation",
             "from":"su-9e6b8","to":["human"],"summary":"needs a decision","payload":{}}
        ]}"#;
        let r: CoordInboxResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.items.len(), 2);
        assert_eq!(r.items[0].msg_id, "m-1");
        assert_eq!(r.items[0].from.as_deref(), Some("su-30a41"));
        assert_eq!(r.items[0].harness_slug.as_deref(), Some("papercup"));
        assert_eq!(r.items[1].kind, "coord-escalation");
    }

    #[test]
    fn parses_toast_log_shape() {
        let j = r#"{"toasts":[
            {"id":7,"level":"error","message":"build failed","description":null,
             "harnessSlug":"papercup","createdAt":1780560000000},
            {"id":6,"level":"default","message":"ok","harnessSlug":null,"createdAt":1780559000000}
        ]}"#;
        let r: ToastsResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.toasts.len(), 2);
        assert_eq!(r.toasts[0].level, "error");
        assert_eq!(r.toasts[0].message, "build failed");
        assert_eq!(r.toasts[0].harness_slug.as_deref(), Some("papercup"));
        assert_eq!(r.toasts[1].harness_slug, None);
    }

    #[test]
    fn parses_plans_list_shape() {
        // Trimmed from the live /api/admin/plans/list probe.
        let j = r#"{"plans":[
            {"slug":"a-2026-05-14","title":"Plan A","status":"shipped","updated":"2026-05-30",
             "owner":"x@y.z","archived":false,"isLegacy":false,"itemCounts":{},
             "nextAction":"review state","harness":"papercup","startStatus":null}
        ]}"#;
        let r: PlansResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.plans.len(), 1);
        let p = &r.plans[0];
        assert_eq!(p.slug, "a-2026-05-14");
        assert_eq!(p.status, "shipped");
        assert_eq!(p.harness.as_deref(), Some("papercup"));
        assert_eq!(p.next_action.as_deref(), Some("review state"));
        assert!(!p.archived);
    }

    #[test]
    fn parses_roster_shape_with_nulls() {
        // Trimmed from the live /api/adv/roster probe (nulls + extra fields).
        let j = r#"{"active":[
            {"ownerId":"su-c8859","label":"su · su-c8859","source":"omp-hook-session",
             "intent":"work","currentFiles":[],"host":"","pid":null,
             "startedAt":"2026-06-03 21:06:01-04","heartbeatAt":"2026-06-04 02:01:56-04",
             "liveness":"live","stale":false,"workspaceId":"*","userId":null,"revoked":false,
             "pidAlive":null,"hasLaunchRecord":true,"advSessionId":341,"currentPlanSlug":null,
             "role":null,"feature":null,"agent":"claude","mode":"console"}
        ]}"#;
        let r: RosterResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.active.len(), 1);
        let e = &r.active[0];
        assert_eq!(e.owner_id, "su-c8859");
        assert_eq!(e.liveness, "live");
        assert_eq!(e.agent.as_deref(), Some("claude"));
        assert_eq!(e.role, None);
        assert!(e.current_files.is_empty());
        assert!(!e.stale);
    }

    #[test]
    fn parses_attention_shape() {
        // Trimmed from the live /api/admin/plans/attention probe.
        let j = r#"{"groups":[
            {"key":"p-1","kind":"plan","planSlug":"p-1","harnessSlug":null,"title":"P 1","maxImportance":5,
             "items":[
               {"id":"plan-item:p-1:P-001","kind":"plan-item","source":"plan","harnessSlug":null,
                "planSlug":"p-1","itemRef":"P-001","title":"Do X","body":"Body of X","status":"todo",
                "importance":3,"needsHuman":false,"actions":[],"ref":"x"},
               {"id":"coord:esc:9","kind":"coord-escalation","source":"coord","harnessSlug":null,
                "planSlug":null,"itemRef":null,"title":"Escalation!","body":null,"status":"needs-human",
                "importance":9,"needsHuman":true}
             ]}
        ]}"#;
        let r: AttentionResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.groups.len(), 1);
        assert_eq!(r.groups[0].items.len(), 2);
        let first = &r.groups[0].items[0];
        assert_eq!(first.item_ref.as_deref(), Some("P-001"));
        assert_eq!(first.status, "todo");
        assert!(!first.needs_human);
        let esc = &r.groups[0].items[1];
        assert_eq!(esc.kind, "coord-escalation");
        assert!(esc.needs_human);
    }

    #[test]
    fn parses_features_payload() {
        let j = r#"{"slug":"papercup","count":2,"features":[
            {"id":"F-001","title":"A","status":"todo","attempts":0},
            {"id":"F-002","title":"B","status":"passed","attempts":3}]}"#;
        let r: FeaturesPayload = serde_json::from_str(j).unwrap();
        assert_eq!(r.features.len(), 2);
        assert_eq!(r.features[1].status, "passed");
        assert_eq!(r.features[1].attempts, 3);
    }

    #[test]
    fn parses_tui_panes_payload() {
        // Mirrors the documented `plugins:tui_panes` inner JSON (camelCase wire).
        let j = r#"{"panes":[
            {"pluginName":"my-plugin","slug":"papercup","label":"Logs","icon":"📜",
             "command":["sh","render.sh"],"cwd":"/repo/papercup"},
            {"pluginName":"other","slug":"papercup","label":"Watch",
             "command":["watch","-n1","ls"],"cwd":"/tmp"}
        ]}"#;
        let r: TuiPanesPayload = serde_json::from_str(j).unwrap();
        assert_eq!(r.panes.len(), 2);
        let p = &r.panes[0];
        assert_eq!(p.plugin_name, "my-plugin");
        assert_eq!(p.slug, "papercup");
        assert_eq!(p.label, "Logs");
        assert_eq!(p.icon.as_deref(), Some("📜"));
        assert_eq!(p.command, vec!["sh", "render.sh"]);
        assert_eq!(p.cwd, "/repo/papercup");
        // icon is optional; absent → None.
        assert_eq!(r.panes[1].icon, None);
        assert_eq!(r.panes[1].command, vec!["watch", "-n1", "ls"]);
    }

    #[test]
    fn parses_plugin_manifest_loosely() {
        // Backend-only manifest (github-repo shape): no ui/tools, actions list,
        // configSchema object — and unknown extra keys are ignored.
        let j = r#"{"plugins":[{
            "name":"@papercupai/github-repo","version":"0.1.0",
            "description":"Create a GitHub repo","icon":"GitBranch",
            "actions":[{"name":"create-repo"}],
            "configSchema":{"type":"object","required":["github_token"],
                "properties":{"github_token":{"type":"string","secret":true},"owner":{"type":"string"}}},
            "capabilities":["net"],"provision":{},"oauth":[{"provider":"github"}]
        },{
            "name":"ui-plugin","version":"1.0.0",
            "ui":[{"type":"tui-pane","label":"Logs"}],
            "dashboardTabs":[{"id":"x","label":"X"}],
            "tools":{"my_tool":{}}
        }]}"#;
        let r: PluginsGlobalResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.plugins.len(), 2);
        let gh = &r.plugins[0];
        assert_eq!(gh.frontend_count(), 0);
        assert_eq!(gh.backend_count(), 1); // 1 action
        assert!(gh.config_schema.is_some());
        assert_eq!(contribution_names(&gh.actions), vec!["create-repo"]);
        let uip = &r.plugins[1];
        assert_eq!(uip.frontend_count(), 2); // 1 ui + 1 dashboardTab
        assert_eq!(uip.backend_count(), 1); // tools as an OBJECT counts keys
        assert_eq!(contribution_names(&uip.tools), vec!["my_tool"]);
        assert!(uip.config_schema.is_none());
        // PluginConfigResponse default-tolerates an empty body.
        let c: PluginConfigResponse = serde_json::from_str(r#"{"config":{"owner":"me"}}"#).unwrap();
        assert_eq!(c.config["owner"], "me");
    }

    #[test]
    fn parses_issues_shape() {
        let j = r#"{"issues":[{"id":"I-1","title":"Bug","severity":"major","source":"validator",
            "foundAt":"t","foundDuring":"F-3","status":"open","linkedFeatureId":"F-FIX-1",
            "attempts":1,"notes":[]}],"nextId":2}"#;
        let r: IssuesResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.issues.len(), 1);
        let i = &r.issues[0];
        assert_eq!(i.severity, "major");
        assert_eq!(i.found_during.as_deref(), Some("F-3"));
        assert_eq!(i.linked_feature_id.as_deref(), Some("F-FIX-1"));
    }

    #[test]
    fn parses_projects_shape() {
        let j = r#"{"projects":[
            {"slug":"papercup","path":"/repo/papercup","harness_kind":null,"is_shared":true},
            {"slug":"restart","path":"/repo/restart"}]}"#;
        let r: ProjectsResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.projects.len(), 2);
        assert_eq!(r.projects[0].slug, "papercup");
        assert_eq!(r.projects[0].path.as_deref(), Some("/repo/papercup"));
    }

    #[test]
    fn parses_testing_domains_shape() {
        let j = r#"{"domains":[{"id":"unit","label":"Unit","description":"fast","tier":"universal","sections":[]},
            {"id":"e2e","label":"E2E","description":"browser","tier":"project"}],
            "tierLabels":{"universal":"Universal"}}"#;
        let r: TestingResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.domains.len(), 2);
        assert_eq!(r.domains[0].id, "unit");
        assert_eq!(r.domains[1].tier, "project");
    }

    #[test]
    fn parses_testing_domain_detail_and_run_result() {
        // domain-detail (D-004a): only the per-section file paths are kept.
        let j = r#"{"id":"unit","label":"Unit","tier":"universal","totalFiles":2,"sections":[
            {"id":"s1","label":"S1","files":[{"path":"a.test.ts","sizeBytes":10,"mtimeMs":1}],"runners":[]},
            {"id":"s2","label":"S2","files":[{"path":"b.test.ts"}],"runners":[]}
        ]}"#;
        let d: TestingDomainDetail = serde_json::from_str(j).unwrap();
        let files: Vec<String> = d
            .sections
            .into_iter()
            .flat_map(|s| s.files)
            .map(|f| f.path)
            .collect();
        assert_eq!(files, vec!["a.test.ts", "b.test.ts"]);

        // run result (camelCase wire).
        let r: TestRunResult = serde_json::from_str(
            r#"{"runId":"h-1","status":"fail","exitCode":1,"output":"1 failed","finishedAt":2}"#,
        )
        .unwrap();
        assert_eq!(r.run_id, "h-1");
        assert_eq!(r.status, "fail");
        assert_eq!(r.exit_code, 1);
        assert_eq!(r.output, "1 failed");
        // Empty body decodes to defaults (defensive).
        let e: TestRunResult = serde_json::from_str("{}").unwrap();
        assert!(e.status.is_empty());
    }

    #[test]
    fn parses_effective_claude_settings_shape() {
        let r: EffectiveClaudeSettings = serde_json::from_str(
            r#"{"ok":true,"content":"{\"model\":\"opus\"}","effective":{"model":"opus","env":{}},"fileKeys":["model"]}"#,
        )
        .unwrap();
        assert_eq!(r.content, "{\"model\":\"opus\"}");
        assert_eq!(r.file_keys, vec!["model"]);
        assert_eq!(r.effective["model"], "opus");
        assert!(r.parse_error.is_none());
        // Empty body decodes to defaults (defensive) — effective is Null until fetched.
        let empty: EffectiveClaudeSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.content, "");
        assert!(empty.effective.is_null());
        // A broken file surfaces parseError.
        let bad: EffectiveClaudeSettings =
            serde_json::from_str(r#"{"parseError":"invalid JSON: x","effective":{}}"#).unwrap();
        assert_eq!(bad.parse_error.as_deref(), Some("invalid JSON: x"));
    }

    #[test]
    fn parses_docs_shape() {
        let j = r##"{"ok":true,"projectPath":"/r","files":["a.md","sub/b.md"],
            "activePath":"a.md","content":"# A\nbody"}"##;
        let r: DocsResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.files.len(), 2);
        assert_eq!(r.active_path.as_deref(), Some("a.md"));
        assert!(r.content.unwrap().contains("# A"));
        // no_docs case (nulls)
        let e: DocsResponse =
            serde_json::from_str(r#"{"ok":true,"files":[],"activePath":null,"content":null}"#)
                .unwrap();
        assert!(e.files.is_empty());
        assert!(e.content.is_none());
    }

    #[test]
    fn empty_and_missing_arrays_default() {
        assert_eq!(
            serde_json::from_str::<PlansResponse>("{}")
                .unwrap()
                .plans
                .len(),
            0
        );
        assert_eq!(
            serde_json::from_str::<RosterResponse>("{}")
                .unwrap()
                .active
                .len(),
            0
        );
    }

    #[test]
    fn view_state_empty_object_is_default() {
        // The server returns { state: {} } when nothing's saved.
        let r: ViewStateResponse = serde_json::from_str(r#"{"state":{}}"#).unwrap();
        assert_eq!(r.state, ViewState::default());
        // A missing `state` key also defaults.
        let r2: ViewStateResponse = serde_json::from_str("{}").unwrap();
        assert_eq!(r2.state, ViewState::default());
    }

    #[test]
    fn view_state_round_trips_and_skips_none() {
        let vs = ViewState {
            tab: Some("Sessions".into()),
            harness: Some("papercup".into()),
            harness_focus: Some("issues".into()),
            plan_sel: 2,
            doc_scroll: 7,
            show_presence: true,
            ..Default::default()
        };
        let json = serde_json::to_string(&vs).unwrap();
        // None fields are omitted; defaulted scalars round-trip.
        assert!(!json.contains("\"harness_focus\":null") || json.contains("issues"));
        let back: ViewState = serde_json::from_str(&json).unwrap();
        assert_eq!(back, vs);
    }

    #[test]
    fn parses_layouts_crews_shapes() {
        let l: LayoutsResponse = serde_json::from_str(
            r#"{"layouts":[{"name":"main","description":"my main","updated_at":"2026-06-04T16:00:00Z"}]}"#,
        )
        .unwrap();
        assert_eq!(l.layouts.len(), 1);
        assert_eq!(l.layouts[0].name, "main");

        let lr: LayoutRow = serde_json::from_str(
            r#"{"name":"main","kdl":"layout {}","description":null,"updated_at":"t"}"#,
        )
        .unwrap();
        assert_eq!(lr.kdl, "layout {}");

        let c: CrewsResponse = serde_json::from_str(
            r#"{"crews":[{"name":"morning","description":null,"layout_name":"main","member_count":2,"updated_at":"t"}]}"#,
        )
        .unwrap();
        assert_eq!(c.crews[0].member_count, 2);
        assert_eq!(c.crews[0].layout_name.as_deref(), Some("main"));

        let cr: CrewRow = serde_json::from_str(
            r#"{"name":"morning","layout_name":"main","members":[{"slot":0,"agent":"claude","resume_id":"r1","harness":"papercup"}]}"#,
        )
        .unwrap();
        assert_eq!(cr.members.len(), 1);
        assert_eq!(cr.members[0].agent.as_deref(), Some("claude"));
        assert_eq!(cr.members[0].plan, None);
    }

    #[test]
    fn empty_crew_members_default() {
        let cr: CrewRow = serde_json::from_str(r#"{"name":"empty"}"#).unwrap();
        assert!(cr.members.is_empty());
        assert_eq!(cr.layout_name, None);
    }

    #[test]
    fn parses_flags_bootstrap_shape() {
        let f: FlagsResponse = serde_json::from_str(
            r#"{"flags":{"papercusp-oracle":false,"papercusp-snapshots":true},"evaluatedAt":1,"source":"defaults"}"#,
        )
        .unwrap();
        assert_eq!(f.source, "defaults");
        assert_eq!(f.flags.get("papercusp-snapshots"), Some(&true));
        assert_eq!(f.flags.get("papercusp-oracle"), Some(&false));
        // Missing flags map defaults to empty.
        assert!(serde_json::from_str::<FlagsResponse>("{}")
            .unwrap()
            .flags
            .is_empty());
    }

    #[test]
    fn parses_plan_item_states_shape() {
        // Mirrors the /api/tui/plan-item-states DTO (camelCase wire): one pooled
        // item (no assignment/claim) + one active (assigned + live claim by the
        // assignee, with a liveness mode + intent).
        let j = r#"{"harness":"papercup","plan":"my-plan","harnessLivenessMode":"availability","items":[
            {"itemId":"P-001","itemStatus":"todo","inPlan":true,"disposition":"pooled",
             "assigneeName":null,"claimOwner":null,"claimOwnerName":null,"claimIntent":null,
             "claimLivenessMode":null,"claimExpiresTs":null},
            {"itemId":"P-002","itemStatus":"wip","inPlan":true,"disposition":"active",
             "assigneeName":"builder-1","claimOwner":"su · abc","claimOwnerName":"builder-1",
             "claimIntent":"building","claimLivenessMode":"activity","claimExpiresTs":"2026-06-04T00:20:00Z"}
        ]}"#;
        let r: PlanItemStates = serde_json::from_str(j).unwrap();
        assert_eq!(r.harness, "papercup");
        assert_eq!(r.harness_liveness_mode, "availability");
        assert_eq!(r.items.len(), 2);
        assert_eq!(r.items[0].item_id, "P-001");
        assert_eq!(r.items[0].disposition, "pooled");
        assert_eq!(r.items[0].assignee_name, None);
        assert_eq!(r.items[1].disposition, "active");
        assert_eq!(r.items[1].assignee_name.as_deref(), Some("builder-1"));
        assert_eq!(r.items[1].claim_owner_name.as_deref(), Some("builder-1"));
        assert_eq!(r.items[1].claim_liveness_mode.as_deref(), Some("activity"));
        // Missing keys default cleanly (no hard-fail).
        let e: PlanItemStates = serde_json::from_str("{}").unwrap();
        assert!(e.items.is_empty());
    }

    #[test]
    fn parses_agent_config_shape() {
        // Trimmed from the live /api/agent-config probe.
        let j = r#"{"config":{"backend":"claude-code","cmd":"claude -p --model haiku",
            "models":{"worker":"opus","merge-resolver":"opus:xhigh"},"backends":{},
            "surfaceModels":{"operator":"sonnet"}},"binaries":{"claude":"/x/claude"},
            "effectiveBackend":"claude-code","envOverrides":{"AGENT_BACKEND":"claude-code"}}"#;
        let r: AgentConfigResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.config.backend, "claude-code");
        assert_eq!(r.effective_backend, "claude-code");
        assert_eq!(r.config.cmd, "claude -p --model haiku");
        assert_eq!(
            r.config.models.get("worker").map(String::as_str),
            Some("opus")
        );
        assert_eq!(
            r.config.models.get("merge-resolver").map(String::as_str),
            Some("opus:xhigh")
        );
        assert_eq!(
            r.config.surface_models.get("operator").map(String::as_str),
            Some("sonnet")
        );
        // Empty shape defaults cleanly.
        assert!(serde_json::from_str::<AgentConfigResponse>("{}")
            .unwrap()
            .config
            .backend
            .is_empty());
    }

    #[test]
    fn parses_credentials_status_shape() {
        // Inner JSON of the operator:credentials_status envelope (no secret values).
        let j = r#"{"openai":{"set":true,"masked":"sk-…abc"},"elevenlabs":{"set":false,"masked":null}}"#;
        let m: std::collections::BTreeMap<String, CredStatus> = serde_json::from_str(j).unwrap();
        assert!(m.get("openai").unwrap().set);
        assert!(!m.get("elevenlabs").unwrap().set);
        assert_eq!(m.get("openai").unwrap().masked.as_deref(), Some("sk-…abc"));
        assert_eq!(m.get("elevenlabs").unwrap().masked, None);
    }

    // --- Fleet status view (pui-fleet-status-view-2026-06-04) ---

    #[test]
    fn parses_work_items_list_shape() {
        // Trimmed from the live work_items:list envelope inner JSON.
        let j = r#"{"ok":true,"count":2,"items":[
            {"id":"EI-7","kind":"bug","family":"issue","harness":null,"title":"role pin",
             "summary":"found while…","state":"open","assignee":null,"severity":"major",
             "parent":null,"payload":null,"createdAt":"2026-06-04T00:00:00Z","updatedAt":"t"},
            {"id":"F-9","kind":"feature","family":"feature","harness":"papercup","title":"A",
             "summary":"","state":"passed","assignee":"su-x","severity":null,
             "createdAt":"t","updatedAt":"t"}
        ]}"#;
        let r: WorkItemsPayload = serde_json::from_str(j).unwrap();
        assert_eq!(r.items.len(), 2);
        assert_eq!(r.items[0].family, "issue");
        assert_eq!(r.items[0].state, "open");
        assert_eq!(r.items[0].severity.as_deref(), Some("major"));
        assert!(r.items[0].harness.is_none());
        assert_eq!(r.items[1].family, "feature");
        assert_eq!(r.items[1].state, "passed");
        assert_eq!(r.items[1].assignee.as_deref(), Some("su-x"));
        assert_eq!(r.items[1].harness.as_deref(), Some("papercup"));
    }

    #[test]
    fn parses_activity_recent_shape() {
        // Trimmed from the live activity:recent envelope inner JSON (snake_case);
        // extra fields (session_id/phase/tool_use_id) are ignored.
        let j = r#"{"activity":[
            {"id":"9","owner_id":"su-c8ca5-smoke","agent":"claude","session_id":"live-1",
             "harness_slug":"papercup","kind":"tool","tool_name":"Bash","phase":"post",
             "tool_use_id":null,"summary":"▶ npm run test:affected","status":"ok",
             "detail":{"command":"npm run test:affected"},"cwd":null,
             "created_at":"2026-06-04 18:53:58.46-04"},
            {"id":"8","owner_id":"omp-x","agent":"omp","kind":"tool","tool_name":"write",
             "phase":"pre","summary":"✎ x.ts","detail":null,"created_at":"t"}
        ],"count":2}"#;
        let r: ActivityRecentPayload = serde_json::from_str(j).unwrap();
        assert_eq!(r.activity.len(), 2);
        assert_eq!(r.activity[0].owner_id, "su-c8ca5-smoke");
        assert_eq!(r.activity[0].agent.as_deref(), Some("claude"));
        assert_eq!(r.activity[0].kind, "tool");
        assert_eq!(
            r.activity[0].summary.as_deref(),
            Some("▶ npm run test:affected")
        );
        assert!(r.activity[0].detail.is_some());
        assert_eq!(r.activity[1].agent.as_deref(), Some("omp"));
    }

    #[test]
    fn parses_todos_snapshot_detail() {
        let j = r#"{"count":3,"done":1,"todos":[
            {"content":"build fleet.rs","status":"in_progress"},
            {"content":"wire pollers","status":"pending"}
        ]}"#;
        let s: TodoSnapshot = serde_json::from_str(j).unwrap();
        assert_eq!(s.count, 3);
        assert_eq!(s.done, 1);
        assert_eq!(s.todos.len(), 2);
        assert_eq!(s.todos[0].content, "build fleet.rs");
        assert_eq!(s.todos[0].status.as_deref(), Some("in_progress"));
    }

    #[test]
    fn item_counts_total_and_remaining() {
        let c = ItemCounts {
            todo: 3,
            wip: 1,
            blocked: 0,
            needs_human: 1,
            done: 2,
            dropped: 0,
            unknown: 0,
        };
        assert_eq!(c.total(), 7);
        assert_eq!(c.remaining(), 5); // total - (done + dropped)
                                      // An empty `{}` (a plan with no items) → all-zero.
        let empty: ItemCounts = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.total(), 0);
        assert_eq!(empty.remaining(), 0);
    }

    #[test]
    fn plan_summary_parses_item_counts_and_priority() {
        // The plans:list row carries itemCounts (camelCase) + priority; the
        // `needs-human` key maps to `needs_human`.
        let j = r#"{"slug":"p","title":"P","status":"active","updated":"t","archived":false,
            "nextAction":"do","harness":"papercup","priority":5,
            "itemCounts":{"todo":2,"done":3,"needs-human":1}}"#;
        let p: PlanSummary = serde_json::from_str(j).unwrap();
        assert_eq!(p.priority, Some(5));
        assert_eq!(p.item_counts.done, 3);
        assert_eq!(p.item_counts.needs_human, 1);
        assert_eq!(p.item_counts.total(), 6);
        // A plan list row without itemCounts defaults to all-zero.
        let q: PlanSummary = serde_json::from_str(r#"{"slug":"q","status":"draft"}"#).unwrap();
        assert_eq!(q.item_counts.total(), 0);
        assert_eq!(q.priority, None);
    }

    #[test]
    fn plan_summary_tolerates_null_legacy_fields() {
        // The EXACT live legacy-plan shape that broke plans_typed: title / updated
        // / itemCounts all null. A non-Option field with only #[serde(default)]
        // chokes on explicit null and sinks the WHOLE plans list → the Plans +
        // Fleet tabs blank on real data. Must decode to all-empty defaults.
        let p: PlanSummary = serde_json::from_str(
            r#"{"archived":false,"harness":"papercup","isLegacy":true,"itemCounts":null,
                "nextAction":null,"owner":null,"priority":null,"slug":"legacy-plan",
                "startStatus":null,"status":"draft","title":null,"updated":null}"#,
        )
        .unwrap();
        assert_eq!(p.slug, "legacy-plan");
        assert_eq!(p.title, "");
        assert_eq!(p.updated, "");
        assert_eq!(p.status, "draft");
        assert_eq!(p.item_counts.total(), 0);
        assert_eq!(p.priority, None);
        // A list mixing null + object itemCounts decodes fully (no row sinks it).
        let r: PlansResponse = serde_json::from_str(
            r#"{"plans":[
                {"slug":"a","status":"active","itemCounts":null},
                {"slug":"b","status":"active","itemCounts":{"todo":1,"done":2}}
            ]}"#,
        )
        .unwrap();
        assert_eq!(r.plans.len(), 2);
        assert_eq!(r.plans[0].item_counts.total(), 0);
        assert_eq!(r.plans[1].item_counts.done, 2);
    }

    #[test]
    fn parses_memory_payloads() {
        // memory:list / memory:search inner JSON (D-006 Step 2).
        let j = r#"{"ok":true,"results":[
            {"id":"m-1","memory":"prefers rust","metadata":{"kind":"preference"},"score":0.91},
            {"id":"m-2","memory":"tz is ET","metadata":{"kind":"identity"}}
        ]}"#;
        let p: MemoriesPayload = serde_json::from_str(j).unwrap();
        assert!(p.ok);
        assert_eq!(p.results.len(), 2);
        assert_eq!(p.results[0].kind(), "preference");
        assert_eq!(p.results[0].score, Some(0.91));
        assert_eq!(p.results[1].kind(), "identity");
        // The unavailable shape ({ok:false, reason}) decodes cleanly.
        let u: MemoriesPayload =
            serde_json::from_str(r#"{"ok":false,"reason":"mem0_unavailable","results":[]}"#)
                .unwrap();
        assert!(!u.ok);
        assert_eq!(u.reason.as_deref(), Some("mem0_unavailable"));
        // Metadata-less entries report an empty kind.
        let bare: MemoryEntry = serde_json::from_str(r#"{"id":"x","memory":"y"}"#).unwrap();
        assert_eq!(bare.kind(), "");
    }

    #[test]
    fn parses_conversation_load_shape() {
        // Trimmed from GET /api/operator/conversations (conversation = ConversationRow,
        // turns = TurnRow[]; both camelCase, hasMoreEarlier camelCase).
        let j = r#"{
            "conversation": {"id":"conv-1","workspaceId":"ws","harnessSlug":null,
                "title":null,"status":"active","startedAt":1,"endedAt":null,
                "elConversationIds":[],"hasAudio":false},
            "turns": [
                {"id":"t1","conversationId":"conv-1","seq":0,"role":"user","text":"hi",
                 "source":"text_typed","elConvId":null,"audioUrl":null,"createdAt":1,"tools":null},
                {"id":"t2","conversationId":"conv-1","seq":1,"role":"assistant","text":"hello there",
                 "source":"text_typed","createdAt":2,
                 "tools":[{"name":"harness:list","input":{}}]}
            ],
            "hasMoreEarlier": true
        }"#;
        let r: ConversationLoad = serde_json::from_str(j).unwrap();
        assert_eq!(r.conversation.id, "conv-1");
        assert!(r.has_more_earlier);
        assert_eq!(r.turns.len(), 2);
        assert_eq!(r.turns[0].role, "user");
        assert_eq!(r.turns[1].text, "hello there");
        assert_eq!(r.turns[1].tools.as_ref().unwrap()[0].name, "harness:list");
        assert!(r.turns[0].tools.is_none());
        // Empty shape (force-created conversation, no turns) still decodes.
        let e: ConversationLoad =
            serde_json::from_str(r#"{"conversation":{"id":"c2"},"turns":[]}"#).unwrap();
        assert_eq!(e.conversation.id, "c2");
        assert!(!e.has_more_earlier);
        assert!(e.turns.is_empty());
    }

    #[test]
    fn parses_turns_page_shape() {
        // GET /api/operator/conversations/:id/turns?beforeSeq=N → TurnsPage.
        let j = r#"{"turns":[
            {"id":"t","conversationId":"c","seq":3,"role":"user","text":"older","createdAt":1,"tools":null}
        ],"hasMoreEarlier":true}"#;
        let p: TurnsPage = serde_json::from_str(j).unwrap();
        assert!(p.has_more_earlier);
        assert_eq!(p.turns.len(), 1);
        assert_eq!(p.turns[0].seq, 3);
        assert_eq!(p.turns[0].text, "older");
        // Empty page (tail reached) decodes to defaults.
        let e: TurnsPage = serde_json::from_str("{}").unwrap();
        assert!(e.turns.is_empty());
        assert!(!e.has_more_earlier);
    }

    #[test]
    fn parses_conversations_list_shape() {
        // conversations:list (snake_case) → rows carry topics + promoted link.
        let j = r#"{"ok":true,"count":2,"conversations":[
            {"id":"conv-1","kind":"question","state":"open","scope":"operator","harness_slug":null,
             "title":"why freeze?","asker_id":"agA","topics":["zero-cache","firefox"],
             "promoted_issue_id":null,"created_ts":"2026-06-05T00:00:00.000Z","resolved":false},
            {"id":"conv-2","kind":"discussion","state":"closed","scope":"harness","harness_slug":"papercup",
             "title":null,"asker_id":"agB","topics":[],"promoted_issue_id":"EI-9","created_ts":"x"}
        ]}"#;
        let p: ConvListResponse = serde_json::from_str(j).unwrap();
        assert_eq!(p.conversations.len(), 2);
        assert_eq!(p.conversations[0].topics, vec!["zero-cache", "firefox"]);
        assert_eq!(
            p.conversations[1].promoted_issue_id.as_deref(),
            Some("EI-9")
        );
        assert_eq!(p.conversations[1].harness_slug.as_deref(), Some("papercup"));
        assert!(p.conversations[1].title.is_none());
    }

    #[test]
    fn parses_conversation_detail_shape() {
        // conversations:get — conversation nested; topics/posts/subscriber_count siblings.
        let j = r#"{"ok":true,"conversation":{"id":"conv-1","kind":"question","state":"resolved",
            "scope":"operator","harness_slug":null,"title":"q","body":"the body","asker_id":"agA",
            "accepted_answer":"because X","promoted_issue_id":null,"created_ts":"x"},
            "topics":["zero-cache"],"posts":[{"id":7,"author_id":"agB","body":"a reply","created_ts":"x"}],
            "subscriber_count":3}"#;
        let d: ConvDetail = serde_json::from_str(j).unwrap();
        let c = d.conversation.expect("conversation present");
        assert_eq!(c.id, "conv-1");
        assert_eq!(c.accepted_answer.as_deref(), Some("because X"));
        assert_eq!(d.topics, vec!["zero-cache"]);
        assert_eq!(d.posts.len(), 1);
        assert_eq!(d.posts[0].id, 7);
        assert_eq!(d.subscriber_count, 3);
        // not_found shape decodes to an empty detail (no conversation).
        let nf: ConvDetail = serde_json::from_str(r#"{"ok":false,"reason":"not_found"}"#).unwrap();
        assert!(nf.conversation.is_none());
    }
}
