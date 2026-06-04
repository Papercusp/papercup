//! Typed models for the operator API responses the panels consume.
//!
//! Field sets match the live-probed shapes (SP-TUI plan, iteration 4). Unknown
//! fields are ignored (serde default) and nullable/absent fields are
//! Option/defaulted so a shape drift never hard-fails a deserialize.
#![allow(dead_code)] // DTOs mirror the full API shape; not every field is displayed yet.

use serde::Deserialize;

/// One row of `/api/admin/plans/list` → `{ plans: [...] }`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSummary {
    pub slug: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub updated: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub next_action: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlansResponse {
    #[serde(default)]
    pub plans: Vec<PlanSummary>,
}

/// One row of `/api/adv/roster` → `{ active: [...] }`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterEntry {
    pub owner_id: String,
    #[serde(default)]
    pub label: String,
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
}

#[derive(Debug, Clone, Deserialize)]
pub struct RosterResponse {
    #[serde(default)]
    pub active: Vec<RosterEntry>,
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

/// One row of `/api/harness/all/recent-activity` → `{events:[...]}`.
#[derive(Debug, Clone, Deserialize)]
pub struct ActivityEvent {
    #[serde(default)]
    pub ts: String,
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub actor: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActivityResponse {
    #[serde(default)]
    pub events: Vec<ActivityEvent>,
}

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

/// `/api/harness/:slug/claude-settings` → `{content}` (read-only file body).
#[derive(Debug, Clone, Deserialize)]
pub struct ClaudeSettings {
    #[serde(default)]
    pub content: String,
}

/// `/api/harness/:slug/project-docs[?path=]` → docs file list + the active doc.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsResponse {
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub active_path: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parses_activity_shape() {
        let j = r#"{"events":[{"ts":"2026-06-03T05:38:30Z","action":"operator.accept_failed",
            "subject":"commit-plan-updates","actor":"system:operator"}]}"#;
        let r: ActivityResponse = serde_json::from_str(j).unwrap();
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.events[0].action, "operator.accept_failed");
        assert_eq!(r.events[0].actor, "system:operator");
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
    fn parses_claude_settings_shape() {
        let r: ClaudeSettings = serde_json::from_str(r#"{"content":"x=1"}"#).unwrap();
        assert_eq!(r.content, "x=1");
        let empty: ClaudeSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.content, "");
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
            serde_json::from_str::<PlansResponse>("{}").unwrap().plans.len(),
            0
        );
        assert_eq!(
            serde_json::from_str::<RosterResponse>("{}").unwrap().active.len(),
            0
        );
    }
}
