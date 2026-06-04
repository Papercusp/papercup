//! Backend client (SP-TUI A3): resolve the operator endpoint + token and wrap
//! the operator HTTP API. Targets the currently-running operator during dev
//! (SP1's `serve` writes ~/.papercusp/operator.json; we fall back to the
//! superuser-token file + the default dev origin). HTTP-only — the operator is
//! local http://127.0.0.1, so no TLS.
#![allow(dead_code)] // surfaces are consumed by the P1 panels; keep check quiet until then.

use crate::models::{
    AttentionItem, AttentionResponse, FeaturesPayload, HarnessFeature, HarnessIssue, HarnessRef,
    IssuesResponse, PlanSummary, PlansResponse, ProjectsResponse, RosterEntry, RosterResponse,
};
use anyhow::{Context, Result};
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

/// Resolved operator endpoint: base URL + optional bearer token.
#[derive(Debug, Clone)]
pub struct OperatorEndpoint {
    pub base_url: String,
    pub token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OperatorJson {
    #[serde(rename = "httpUrl")]
    http_url: Option<String>,
    token: Option<String>,
}

fn papercusp_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".papercusp"))
}

impl OperatorEndpoint {
    /// Resolve from `~/.papercusp`.
    pub fn resolve() -> Self {
        Self::resolve_in(papercusp_dir())
    }

    /// Resolution with an explicit `.papercusp` dir (testable):
    ///   1. operator.json `httpUrl` (+ token) — written by `papercusp serve`.
    ///   2. else default origin (PAPERCUSP_OPERATOR_URL or http://127.0.0.1:3070)
    ///      + the superuser-token file if present.
    pub fn resolve_in(dir: Option<PathBuf>) -> Self {
        if let Some(ref d) = dir {
            if let Ok(txt) = fs::read_to_string(d.join("operator.json")) {
                if let Ok(j) = serde_json::from_str::<OperatorJson>(&txt) {
                    if let Some(url) = j.http_url.filter(|u| !u.is_empty()) {
                        return Self {
                            base_url: url,
                            token: j.token.filter(|t| !t.is_empty()),
                        };
                    }
                }
            }
        }
        let token = dir
            .as_ref()
            .and_then(|d| fs::read_to_string(d.join("superuser-token")).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Self {
            base_url: std::env::var("PAPERCUSP_OPERATOR_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:3070".to_string()),
            token,
        }
    }
}

/// Thin async HTTP client over the operator API.
pub struct OperatorClient {
    endpoint: OperatorEndpoint,
    http: reqwest::Client,
}

impl OperatorClient {
    pub fn new(endpoint: OperatorEndpoint) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .context("build http client")?;
        Ok(Self { endpoint, http })
    }

    pub fn from_discovery() -> Result<Self> {
        Self::new(OperatorEndpoint::resolve())
    }

    pub fn base_url(&self) -> &str {
        &self.endpoint.base_url
    }

    async fn get_json(&self, path: &str) -> Result<serde_json::Value> {
        let url = format!("{}{}", self.endpoint.base_url.trim_end_matches('/'), path);
        let mut req = self.http.get(&url);
        if let Some(ref t) = self.endpoint.token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.with_context(|| format!("GET {url}"))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("GET {url} -> {status}: {body}");
        }
        serde_json::from_str(&body).with_context(|| format!("parse JSON from {url}"))
    }

    /// GET /api/adv/roster — the live agent roster (Sessions panel).
    pub async fn roster(&self) -> Result<serde_json::Value> {
        self.get_json("/api/adv/roster").await
    }

    /// GET /api/admin/plans/list — the plans list (Plans panel).
    pub async fn plans_list(&self) -> Result<serde_json::Value> {
        self.get_json("/api/admin/plans/list").await
    }

    /// Typed roster (`{active:[...]}` → `Vec<RosterEntry>`).
    pub async fn roster_typed(&self) -> Result<Vec<RosterEntry>> {
        let v = self.roster().await?;
        Ok(serde_json::from_value::<RosterResponse>(v)
            .context("decode roster")?
            .active)
    }

    /// Typed plans list (`{plans:[...]}` → `Vec<PlanSummary>`).
    pub async fn plans_typed(&self) -> Result<Vec<PlanSummary>> {
        let v = self.plans_list().await?;
        Ok(serde_json::from_value::<PlansResponse>(v)
            .context("decode plans")?
            .plans)
    }

    /// Typed inbox: `/api/admin/plans/attention` groups flattened to items.
    pub async fn attention_typed(&self) -> Result<Vec<AttentionItem>> {
        let v = self.get_json("/api/admin/plans/attention").await?;
        let groups = serde_json::from_value::<AttentionResponse>(v)
            .context("decode attention")?
            .groups;
        Ok(groups.into_iter().flat_map(|g| g.items).collect())
    }

    async fn post_json(&self, path: &str, body: serde_json::Value) -> Result<serde_json::Value> {
        let url = format!("{}{}", self.endpoint.base_url.trim_end_matches('/'), path);
        let mut req = self.http.post(&url).json(&body);
        if let Some(ref t) = self.endpoint.token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.with_context(|| format!("POST {url}"))?;
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("POST {url} -> {status}: {txt}");
        }
        serde_json::from_str(&txt).with_context(|| format!("parse JSON from {url}"))
    }

    /// Features for a harness via the `list_features` agent-tool. The response is
    /// an MCP envelope `{content:[{type:"text",text:"<json>"}]}`; we unwrap +
    /// parse the inner payload.
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

    /// Issues for a harness: `GET /api/harness/:slug/issues`.
    pub async fn issues_for(&self, slug: &str) -> Result<Vec<HarnessIssue>> {
        let v = self.get_json(&format!("/api/harness/{slug}/issues")).await?;
        Ok(serde_json::from_value::<IssuesResponse>(v)
            .context("decode issues")?
            .issues)
    }

    /// The harness list: `GET /api/harness/projects/lite`.
    pub async fn harnesses(&self) -> Result<Vec<HarnessRef>> {
        let v = self.get_json("/api/harness/projects/lite").await?;
        Ok(serde_json::from_value::<ProjectsResponse>(v)
            .context("decode projects")?
            .projects)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Minimal one-shot HTTP/1.1 server returning `body` as JSON. Returns the
    /// base URL to point a client at.
    async fn fake_server(body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.flush().await;
            }
        });
        format!("http://{addr}")
    }

    #[test]
    fn resolve_reads_operator_json() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("operator.json"),
            r#"{"httpUrl":"http://127.0.0.1:4242","token":"abc"}"#,
        )
        .unwrap();
        let ep = OperatorEndpoint::resolve_in(Some(dir.path().to_path_buf()));
        assert_eq!(ep.base_url, "http://127.0.0.1:4242");
        assert_eq!(ep.token.as_deref(), Some("abc"));
    }

    #[test]
    fn resolve_falls_back_to_token_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("superuser-token"), "  tok-xyz \n").unwrap();
        let ep = OperatorEndpoint::resolve_in(Some(dir.path().to_path_buf()));
        assert_eq!(ep.token.as_deref(), Some("tok-xyz"));
        assert!(ep.base_url.starts_with("http"));
    }

    #[tokio::test]
    async fn fetches_and_parses_json_with_bearer() {
        let base = fake_server(r#"{"ok":true,"rows":[]}"#).await;
        let client =
            OperatorClient::new(OperatorEndpoint { base_url: base, token: Some("t".into()) })
                .unwrap();
        let v = client.roster().await.unwrap();
        assert_eq!(v["ok"], serde_json::json!(true));
        assert!(v["rows"].is_array());
    }

    #[tokio::test]
    async fn features_for_unwraps_mcp_envelope() {
        let inner = serde_json::json!({
            "slug":"x","count":1,
            "features":[{"id":"F-1","title":"t","status":"todo","attempts":0}]
        })
        .to_string();
        let env = serde_json::json!({ "content": [{ "type":"text", "text": inner }] }).to_string();
        let body: &'static str = Box::leak(env.into_boxed_str());
        let base = fake_server(body).await;
        let client =
            OperatorClient::new(OperatorEndpoint { base_url: base, token: None }).unwrap();
        let feats = client.features_for("x").await.unwrap();
        assert_eq!(feats.len(), 1);
        assert_eq!(feats[0].id, "F-1");
    }
}
