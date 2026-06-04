//! Backend client (SSE→IPC pivot): every call goes through the operator's IPC
//! transport — `/api/*` routes via the `sys:http` tool over the Unix socket.
//! No HTTP, no SSE, no bearer token (the socket is the trust boundary).
#![allow(dead_code)] // some typed methods are consumed as the panels grow.

use crate::ipc::IpcClient;
use crate::models::{
    ActivityEvent, ActivityResponse, AttentionItem, AttentionResponse, ClaudeSettings, DocsResponse,
    FeaturesPayload, HarnessFeature, HarnessIssue, HarnessRef, IssuesResponse, PlanSummary,
    PlansResponse, ProjectsResponse, RosterEntry, RosterResponse, TestingDomain, TestingResponse,
};
use anyhow::{Context, Result};
use std::sync::Arc;

/// Thin typed client over the operator API, transported via IPC `sys:http`.
pub struct OperatorClient {
    ipc: Arc<IpcClient>,
}

impl OperatorClient {
    /// Connect to the operator via endpoint-ipc discovery.
    pub async fn from_discovery() -> Result<Self> {
        Ok(Self {
            ipc: Arc::new(IpcClient::connect_discovered().await?),
        })
    }

    /// Construct over an existing IPC client (tests / shared client).
    pub fn new(ipc: Arc<IpcClient>) -> Self {
        Self { ipc }
    }

    async fn get_json(&self, path: &str) -> Result<serde_json::Value> {
        let bytes = self.ipc.sys_http("GET", path, None).await?;
        serde_json::from_slice(&bytes).with_context(|| format!("parse JSON from {path}"))
    }

    async fn post_json(&self, path: &str, body: serde_json::Value) -> Result<serde_json::Value> {
        let bytes = self
            .ipc
            .sys_http("POST", path, Some(body.to_string()))
            .await?;
        serde_json::from_slice(&bytes).with_context(|| format!("parse JSON from {path}"))
    }

    // --- raw ---
    pub async fn roster(&self) -> Result<serde_json::Value> {
        self.get_json("/api/adv/roster").await
    }
    pub async fn plans_list(&self) -> Result<serde_json::Value> {
        self.get_json("/api/admin/plans/list").await
    }

    // --- typed ---
    pub async fn roster_typed(&self) -> Result<Vec<RosterEntry>> {
        let v = self.roster().await?;
        Ok(serde_json::from_value::<RosterResponse>(v)
            .context("decode roster")?
            .active)
    }

    pub async fn plans_typed(&self) -> Result<Vec<PlanSummary>> {
        let v = self.plans_list().await?;
        Ok(serde_json::from_value::<PlansResponse>(v)
            .context("decode plans")?
            .plans)
    }

    pub async fn attention_typed(&self) -> Result<Vec<AttentionItem>> {
        let v = self.get_json("/api/admin/plans/attention").await?;
        let groups = serde_json::from_value::<AttentionResponse>(v)
            .context("decode attention")?
            .groups;
        Ok(groups.into_iter().flat_map(|g| g.items).collect())
    }

    /// Features via the `list_features` agent-tool (MCP envelope unwrapped).
    pub async fn features_for(&self, slug: &str) -> Result<Vec<HarnessFeature>> {
        let env = self
            .post_json(
                "/api/agent-tools/harness/list_features",
                serde_json::json!({ "slug": slug }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("list_features: missing content[0].text")?;
        Ok(serde_json::from_str::<FeaturesPayload>(text)
            .context("parse features payload")?
            .features)
    }

    pub async fn issues_for(&self, slug: &str) -> Result<Vec<HarnessIssue>> {
        let v = self.get_json(&format!("/api/harness/{slug}/issues")).await?;
        Ok(serde_json::from_value::<IssuesResponse>(v)
            .context("decode issues")?
            .issues)
    }

    pub async fn harnesses(&self) -> Result<Vec<HarnessRef>> {
        let v = self.get_json("/api/harness/projects/lite").await?;
        Ok(serde_json::from_value::<ProjectsResponse>(v)
            .context("decode projects")?
            .projects)
    }

    pub async fn docs_for(&self, slug: &str, path: Option<&str>) -> Result<DocsResponse> {
        let p = match path {
            Some(rel) => format!("/api/harness/{slug}/project-docs?path={}", urlencode(rel)),
            None => format!("/api/harness/{slug}/project-docs"),
        };
        let v = self.get_json(&p).await?;
        serde_json::from_value::<DocsResponse>(v).context("decode docs")
    }

    pub async fn recent_activity(&self) -> Result<Vec<ActivityEvent>> {
        let v = self.get_json("/api/harness/all/recent-activity").await?;
        Ok(serde_json::from_value::<ActivityResponse>(v)
            .context("decode activity")?
            .events)
    }

    pub async fn testing_domains(&self, slug: &str) -> Result<Vec<TestingDomain>> {
        let v = self
            .get_json(&format!("/api/harness/{slug}/testing/domains"))
            .await?;
        Ok(serde_json::from_value::<TestingResponse>(v)
            .context("decode testing domains")?
            .domains)
    }

    pub async fn claude_settings(&self, slug: &str) -> Result<String> {
        let v = self
            .get_json(&format!("/api/harness/{slug}/claude-settings"))
            .await?;
        Ok(serde_json::from_value::<ClaudeSettings>(v)
            .context("decode claude-settings")?
            .content)
    }
}

/// Minimal percent-encoding for a docs relative path.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_keeps_path_chars_escapes_specials() {
        assert_eq!(
            urlencode("decisions/routine-durability.md"),
            "decisions/routine-durability.md"
        );
        assert_eq!(urlencode("a b.md"), "a%20b.md");
        assert_eq!(urlencode("x?y&z"), "x%3Fy%26z");
    }

    // End-to-end IPC round-trips for the client live in ipc.rs (fake Unix-socket
    // server). Here we just cover the pure path-encoding; the typed decoders are
    // covered by models.rs serde tests.
}
