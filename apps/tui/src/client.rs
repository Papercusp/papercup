//! Backend client over a **pluggable transport** (D-009): `/api/*` routes go
//! through either the operator's IPC `sys:http` tool (local Unix socket,
//! zero-auth) or direct HTTP+bearer (remote / Claude Code plugin). The typed
//! method surface + the UI are transport-agnostic; only `Transport` knows the
//! wire. Selection happens at `from_discovery()`: IPC if the socket connects,
//! else HTTP from `operator.json`.
#![allow(dead_code)] // some typed methods are consumed as the panels grow.

use crate::http::HttpClient;
use crate::ipc::{CallEvent, CallFrame, IpcClient};
use crate::models::{
    ActivityRecentPayload, ActivityRow, AttentionItem, AttentionResponse,
    ConvDetail, ConvListResponse, ConvSummary,
    ConversationLoad, CoordInboxResponse, CuratedSignal, CurationFeedPayload,
    CoordMsg, CrewMember, CrewRow, CrewSummary, CrewsResponse, DocsResponse, FeaturesPayload, FlagsResponse,
    HarnessFeature, HarnessIssue, HarnessRef, IssuesResponse, LayoutRow, LayoutSummary, LayoutsResponse, Notif,
    AgentConfigResponse, OperatorConfig, PlanItemStates, PlanSummary,
    PlansResponse, ProjectsResponse, RosterEntry, RosterResponse, TestingDomain, TestingResponse,
    ToastsResponse, TuiPanesPayload, TurnsPage, ViewState, ViewStateResponse, WorkItem, WorkItemsPayload,
};
use crate::models;
use crate::sse::{parse_sse_frames, SseFrame};
use anyhow::{anyhow, Context, Result};
use std::sync::Arc;
use tokio::sync::mpsc;

/// The wire `OperatorClient` rides. `Ipc` is the local zero-auth Unix socket;
/// `Http` is remote HTTP+bearer. An enum (not a `dyn` trait) keeps the async
/// methods simple — no async-trait / object-safety dance.
enum Transport {
    Ipc(Arc<IpcClient>),
    Http(HttpClient),
}

impl Transport {
    async fn sys_http(&self, method: &str, path: &str, body: Option<String>) -> Result<Vec<u8>> {
        match self {
            Transport::Ipc(c) => c.sys_http(method, path, body).await,
            Transport::Http(c) => c.sys_http(method, path, body).await,
        }
    }

    /// Subscribe to an SSE route (GET); yields parsed `SseFrame`s regardless of wire.
    async fn subscribe_sse(&self, path: &str) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        match self {
            Transport::Http(c) => c.subscribe_sse(path).await,
            Transport::Ipc(c) => {
                // IPC: stream the `sys:http` tool, pull `sse-chunk` strings, and
                // parse them into frames so callers see the same SseFrame stream.
                let frames = c
                    .invoke_stream(
                        "sys:http",
                        serde_json::json!({ "method": "GET", "path": path }),
                    )
                    .await?;
                Ok(ipc_sse_pipe(frames))
            }
        }
    }

    /// Subscribe to an SSE route via a streaming POST + JSON body (the
    /// operator-converse turn). Same uniform `SseFrame` stream as the GET path,
    /// over either wire — HTTP streams the response; IPC forwards method+body to
    /// the `sys:http` bridge, which emits the upstream `text/event-stream` as
    /// `sse-chunk` frames regardless of method.
    async fn subscribe_sse_post(
        &self,
        path: &str,
        body: String,
    ) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        match self {
            Transport::Http(c) => c.subscribe_sse_post(path, body).await,
            Transport::Ipc(c) => {
                let frames = c
                    .invoke_stream(
                        "sys:http",
                        serde_json::json!({
                            "method": "POST",
                            "path": path,
                            "headers": { "content-type": "application/json" },
                            "body": body,
                        }),
                    )
                    .await?;
                Ok(ipc_sse_pipe(frames))
            }
        }
    }
}

/// Drain an IPC streaming call's `sse-chunk` frames into a uniform `SseFrame`
/// channel — the shared pipe for both GET (`subscribe_sse`) and streaming-POST
/// (`subscribe_sse_post`) over the `sys:http` bridge.
fn ipc_sse_pipe(mut frames: mpsc::UnboundedReceiver<CallFrame>) -> mpsc::UnboundedReceiver<SseFrame> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut buf = String::new();
        while let Some(cf) = frames.recv().await {
            match cf {
                CallFrame::Event(CallEvent::Json { name, data }) if name == "sse-chunk" => {
                    if let Some(s) = data.as_str() {
                        buf.push_str(s);
                    }
                    let (parsed, rest) = parse_sse_frames(&buf);
                    buf = rest;
                    for f in parsed {
                        if tx.send(f).is_err() {
                            return;
                        }
                    }
                }
                // Terminal frames end the upstream stream → close our side
                // promptly so the caller resubscribes (don't wait for the next
                // implicit sender-drop).
                CallFrame::Done(_) | CallFrame::Error { .. } | CallFrame::ConnLost => return,
                // `head` + other event names: ignore, keep reading.
                _ => {}
            }
        }
    });
    rx
}

/// Thin typed client over the operator API, transport-agnostic (D-009).
pub struct OperatorClient {
    transport: Transport,
}

impl OperatorClient {
    /// Resolve a backend: prefer local IPC (socket), fall back to HTTP+bearer.
    pub async fn from_discovery() -> Result<Self> {
        match IpcClient::connect_discovered().await {
            Ok(ipc) => Ok(Self {
                transport: Transport::Ipc(Arc::new(ipc)),
            }),
            Err(ipc_err) => match HttpClient::from_discovery() {
                Ok(http) => Ok(Self {
                    transport: Transport::Http(http),
                }),
                Err(http_err) => Err(anyhow!(
                    "no backend reachable — ipc: {ipc_err}; http: {http_err}"
                )),
            },
        }
    }

    /// Construct over an existing IPC client (tests / shared client).
    pub fn new(ipc: Arc<IpcClient>) -> Self {
        Self {
            transport: Transport::Ipc(ipc),
        }
    }

    /// Subscribe to an SSE route, yielding parsed frames (transport-agnostic).
    pub async fn subscribe_sse(&self, path: &str) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        self.transport.subscribe_sse(path).await
    }

    // ─── Operator chat (tui-operator-surface-2026-06-04) ───
    // Same backend path the desktop operator uses: POST /api/agent-mcp/operator-converse
    // for the streaming brain turn + /api/operator/conversations/* for history +
    // turn persistence. No persona fork — the TUI is a second client over the
    // existing `operator` role (D-001/D-002).

    /// Open the operator-converse SSE stream for a turn (streaming POST). `body`
    /// is the full converse payload (messages, trigger, modality, surface:"tui",
    /// uiClientId, conversationId). Yields `delta`/`tool_call`/`done`/`error`
    /// frames (+ `heartbeat`).
    pub async fn subscribe_converse(
        &self,
        body: serde_json::Value,
    ) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        self.transport
            .subscribe_sse_post("/api/agent-mcp/operator-converse", body.to_string())
            .await
    }

    /// Load the workspace's active operator conversation + recent turns (oldest
    /// first). Auto-creates the conversation server-side if none exists.
    pub async fn load_conversation(&self, limit: u32) -> Result<ConversationLoad> {
        let v = self
            .get_json(&format!("/api/operator/conversations?limit={limit}"))
            .await?;
        serde_json::from_value::<ConversationLoad>(v).context("decode conversation")
    }

    /// Append a turn to a conversation (persist the user message + the finalized
    /// assistant reply, so the thread stays consistent with the desktop surface).
    /// `tools` is the per-turn tool-call array (`[{name, input?}]`); pass `&[]`
    /// for none. `report` is the optional `<report>` payload (structured-report-protocol).
    pub async fn append_turn(
        &self,
        conversation_id: &str,
        role: &str,
        text: &str,
        tools: &[serde_json::Value],
        report: Option<&serde_json::Value>,
    ) -> Result<()> {
        let mut body = serde_json::json!({
            "role": role,
            "text": text,
            "source": "text_typed",
        });
        if !tools.is_empty() {
            body["tools"] = serde_json::Value::Array(tools.to_vec());
        }
        if let Some(r) = report {
            body["report"] = r.clone();
        }
        self.post_json(
            &format!("/api/operator/conversations/{conversation_id}/turns"),
            body,
        )
        .await?;
        Ok(())
    }

    /// Fetch an older page of turns (the load-earlier cursor): turns with
    /// `seq < before_seq`, oldest-first, plus whether more exist before them.
    pub async fn load_earlier_turns(
        &self,
        conversation_id: &str,
        before_seq: i64,
        limit: u32,
    ) -> Result<TurnsPage> {
        let v = self
            .get_json(&format!(
                "/api/operator/conversations/{}/turns?beforeSeq={before_seq}&limit={limit}",
                urlencode(conversation_id)
            ))
            .await?;
        serde_json::from_value::<TurnsPage>(v).context("decode earlier turns")
    }

    async fn get_json(&self, path: &str) -> Result<serde_json::Value> {
        let bytes = self.transport.sys_http("GET", path, None).await?;
        serde_json::from_slice(&bytes).with_context(|| format!("parse JSON from {path}"))
    }

    async fn post_json(&self, path: &str, body: serde_json::Value) -> Result<serde_json::Value> {
        let bytes = self
            .transport
            .sys_http("POST", path, Some(body.to_string()))
            .await?;
        serde_json::from_slice(&bytes).with_context(|| format!("parse JSON from {path}"))
    }

    async fn put_json(&self, path: &str, body: serde_json::Value) -> Result<serde_json::Value> {
        let bytes = self
            .transport
            .sys_http("PUT", path, Some(body.to_string()))
            .await?;
        serde_json::from_slice(&bytes).with_context(|| format!("parse JSON from {path}"))
    }

    async fn delete_json(&self, path: &str) -> Result<serde_json::Value> {
        let bytes = self.transport.sys_http("DELETE", path, None).await?;
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

    /// TUI panes plugins contribute (D-002) via the `plugins:tui_panes`
    /// agent-tool (MCP envelope unwrapped, exactly like `features_for`).
    pub async fn tui_panes_for(&self, slug: &str) -> Result<Vec<models::TuiPaneContribution>> {
        let env = self
            .post_json(
                "/api/agent-tools/plugins/tui_panes",
                serde_json::json!({ "harness": slug }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("tui_panes: missing content[0].text")?;
        Ok(serde_json::from_str::<TuiPanesPayload>(text)
            .context("parse tui_panes payload")?
            .panes)
    }

    pub async fn issues_for(&self, slug: &str) -> Result<Vec<HarnessIssue>> {
        let v = self.get_json(&format!("/api/harness/{slug}/issues")).await?;
        Ok(serde_json::from_value::<IssuesResponse>(v)
            .context("decode issues")?
            .issues)
    }

    /// Conversations (Brief 25) via the `conversations:list` agent-tool — optional
    /// state/kind/topic filters; MCP envelope unwrapped like `features_for`. Each
    /// row carries its topic tags + the promoted-issue link (D-002/D-004).
    pub async fn conversations_list(
        &self,
        state: Option<&str>,
        kind: Option<&str>,
        topic: Option<&str>,
    ) -> Result<Vec<ConvSummary>> {
        let mut body = serde_json::Map::new();
        if let Some(s) = state {
            body.insert("state".into(), serde_json::json!(s));
        }
        if let Some(k) = kind {
            body.insert("kind".into(), serde_json::json!(k));
        }
        if let Some(t) = topic {
            if !t.is_empty() {
                body.insert("topic".into(), serde_json::json!(t));
            }
        }
        let env = self
            .post_json("/api/agent-tools/conversations/list", serde_json::Value::Object(body))
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("conversations:list: missing content[0].text")?;
        Ok(serde_json::from_str::<ConvListResponse>(text)
            .context("parse conversations payload")?
            .conversations)
    }

    /// Full conversation detail (seed + topics + thread + accepted answer + the
    /// linked work-item) via the `conversations:get` agent-tool.
    pub async fn conversation_get(&self, id: &str) -> Result<ConvDetail> {
        let env = self
            .post_json(
                "/api/agent-tools/conversations/get",
                serde_json::json!({ "conversation_id": id }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("conversations:get: missing content[0].text")?;
        serde_json::from_str::<ConvDetail>(text).context("parse conversation detail")
    }

    /// Promote a conversation into an engineer issue (carries its thread). Returns
    /// the new issue id, or an Err carrying the tool's `reason` on failure.
    pub async fn conversation_promote(&self, id: &str) -> Result<String> {
        let env = self
            .post_json(
                "/api/agent-tools/conversations/promote",
                serde_json::json!({ "conversation_id": id }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("conversations:promote: missing content[0].text")?;
        let v: serde_json::Value = serde_json::from_str(text).context("parse promote result")?;
        if v.get("ok").and_then(|b| b.as_bool()) == Some(false) {
            let reason = v.get("reason").and_then(|r| r.as_str()).unwrap_or("promote_failed");
            return Err(anyhow!("promote failed: {reason}"));
        }
        Ok(v.get("issue")
            .and_then(|i| i.get("id"))
            .and_then(|i| i.as_str())
            .unwrap_or("")
            .to_string())
    }

    /// "Message owner" (inbox-tiering D-004): open a work-item-scoped conversation
    /// with an attention item's owning agent via the /api/admin/coord proxy
    /// (coord:message-agent). The admin proxy unwraps the MCP envelope, so the
    /// response is the plain `{ ok, conversation_id, … }`. Returns the new
    /// conversation id (browsable in the Conversations tab).
    pub async fn message_agent(&self, item: &AttentionItem, body: &str) -> Result<String> {
        let mut payload = serde_json::Map::new();
        if let Some(to) = item.owner_agent_id.as_deref() {
            payload.insert("to".into(), serde_json::json!(to));
        }
        payload.insert("body".into(), serde_json::json!(body));
        if let Some(h) = item.harness_slug.as_deref() {
            payload.insert("harness".into(), serde_json::json!(h));
        }
        if let Some(p) = item.plan_slug.as_deref() {
            payload.insert("plan_slug".into(), serde_json::json!(p));
        }
        if let Some(r) = item.item_ref.as_deref() {
            payload.insert("item_ref".into(), serde_json::json!(r));
        }
        let title: String = item.title.chars().take(120).collect();
        payload.insert("title".into(), serde_json::json!(title));
        let v = self
            .post_json("/api/admin/coord/message-agent", serde_json::Value::Object(payload))
            .await?;
        if v.get("ok").and_then(|b| b.as_bool()) == Some(false) {
            let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("message_failed");
            return Err(anyhow!("message owner failed: {err}"));
        }
        Ok(v.get("conversation_id").and_then(|c| c.as_str()).unwrap_or("").to_string())
    }

    pub async fn harnesses(&self) -> Result<Vec<HarnessRef>> {
        let v = self.get_json("/api/harness/projects/lite").await?;
        Ok(serde_json::from_value::<ProjectsResponse>(v)
            .context("decode projects")?
            .projects)
    }

    /// Operator feature flags + values for the read-only Settings tab (P10).
    pub async fn flags(&self) -> Result<FlagsResponse> {
        let v = self.get_json("/api/flags/bootstrap").await?;
        serde_json::from_value::<FlagsResponse>(v).context("decode flags")
    }

    /// Merged plan-item assignment/claim/liveness for one plan (P-005a). Read-only
    /// surface over plan-item-assignment-claim-liveness-2026-06-04 — backs the
    /// per-item disposition markers in the Plans detail pane.
    pub async fn plan_item_states(&self, harness: &str, plan: &str) -> Result<PlanItemStates> {
        let v = self
            .get_json(&format!(
                "/api/tui/plan-item-states?harness={}&plan={}",
                urlencode(harness),
                urlencode(plan)
            ))
            .await?;
        serde_json::from_value::<PlanItemStates>(v).context("decode plan-item states")
    }

    /// Convert-at-pickup (project-centric-harness-rethink D-015): pick up a plan
    /// item by converting it to a claimed work_item — the WRITE half of the
    /// plan-item surface (`plan_item_states` is the read half). POSTs
    /// /api/tui/plan-item-convert, which dispatches the `plan_items:convert`
    /// tool (lease + mint/resume + claim + back-link; emits fire server-side).
    /// Returns the tool's JSON payload: `{ ok, status, workItem, claim, … }` on
    /// success, `{ ok:false, status:'refused'|'conflict', … }` otherwise.
    pub async fn plan_item_convert(
        &self,
        owner: &str,
        harness: &str,
        plan: &str,
        item: &str,
    ) -> Result<serde_json::Value> {
        self.post_json(
            "/api/tui/plan-item-convert",
            serde_json::json!({ "owner": owner, "harness": harness, "plan": plan, "item": item }),
        )
        .await
    }

    /// Read-only operator-config overview (P10b): the AI backend + per-role models
    /// (`/api/agent-config`) and which speech providers are connected
    /// (`operator:credentials_status` — booleans, never secret values). Assembled
    /// from two reads; a partial failure still returns what loaded (a read-only
    /// overview degrades to "—" rather than erroring the whole Settings tab).
    pub async fn operator_config(&self) -> Result<OperatorConfig> {
        let agent = match self.get_json("/api/agent-config").await {
            Ok(v) => serde_json::from_value::<AgentConfigResponse>(v).ok(),
            Err(_) => None,
        };
        let providers = match self
            .post_json("/api/agent-tools/operator/credentials_status", serde_json::json!({}))
            .await
        {
            Ok(env) => {
                let text = env
                    .get("content")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("{}");
                let map: std::collections::BTreeMap<String, models::CredStatus> =
                    serde_json::from_str(text).unwrap_or_default();
                map.into_iter().map(|(k, v)| (k, v.set)).collect()
            }
            Err(_) => Vec::new(),
        };
        Ok(OperatorConfig { agent, providers })
    }

    // --- Fleet status view (pui-fleet-status-view-2026-06-04) ---

    /// Fleet-wide work items via the `work_items:list` agent-tool (unify-work-
    /// items; MCP envelope unwrapped, exactly like `features_for`). No filters →
    /// the whole fleet (features + issues + chunks).
    pub async fn work_items_list(&self) -> Result<Vec<WorkItem>> {
        let env = self
            .post_json(
                "/api/agent-tools/work_items/list",
                serde_json::json!({ "limit": 500 }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("work_items:list: missing content[0].text")?;
        Ok(serde_json::from_str::<WorkItemsPayload>(text)
            .context("parse work_items payload")?
            .items)
    }

    /// Recent worker-activity rows via the `activity:recent` agent-tool (worker-
    /// integration; the pull-side companion to the /api/activity/stream SSE; MCP
    /// envelope unwrapped). `kind` scopes to tool|lifecycle|todos; None → all.
    pub async fn activity_recent(&self, kind: Option<&str>, limit: u32) -> Result<Vec<ActivityRow>> {
        let mut body = serde_json::json!({ "limit": limit });
        if let Some(k) = kind {
            body["kind"] = serde_json::Value::String(k.to_string());
        }
        let env = self
            .post_json("/api/agent-tools/activity/recent", body)
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("activity:recent: missing content[0].text")?;
        Ok(serde_json::from_str::<ActivityRecentPayload>(text)
            .context("parse activity payload")?
            .activity)
    }

    /// Subscribe to the live worker-activity SSE (`/api/activity/stream`). Each
    /// `activity` frame's `data` is an `ActivityRow`. No filter → the whole fleet;
    /// the stream pushes only rows that arrive AFTER connect (seed history via
    /// `activity_recent`).
    pub async fn subscribe_activity(&self) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        self.subscribe_sse("/api/activity/stream").await
    }

    /// The curator's salience-ranked fleet signals via the `curation:feed`
    /// agent-tool (curator-operator; MCP envelope unwrapped). The Fleet curated
    /// mode shows these as "what matters". A 404/absent route (pre-restart, or the
    /// curator not built) surfaces as an Err the caller treats as "fall back to
    /// the local heuristic" — never fatal.
    pub async fn curation_feed(&self) -> Result<Vec<CuratedSignal>> {
        let env = self
            .post_json(
                "/api/agent-tools/curation/feed",
                serde_json::json!({ "limit": 50 }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("curation:feed: missing content[0].text")?;
        Ok(serde_json::from_str::<CurationFeedPayload>(text)
            .context("parse curation feed payload")?
            .signals)
    }

    // --- Workbench persistence (P12 / D-002): /api/tui/* ---

    /// The quiet UI/nav state for `owner` (`ViewState::default()` if none saved).
    pub async fn get_view_state(&self, owner: &str) -> Result<ViewState> {
        let v = self
            .get_json(&format!("/api/tui/view-state?owner={}", urlencode(owner)))
            .await?;
        Ok(serde_json::from_value::<ViewStateResponse>(v)
            .context("decode view-state")?
            .state)
    }

    /// Upsert the quiet UI/nav state for `owner`.
    pub async fn put_view_state(&self, owner: &str, state: &ViewState) -> Result<()> {
        self.put_json(
            "/api/tui/view-state",
            serde_json::json!({ "owner": owner, "state": state }),
        )
        .await?;
        Ok(())
    }

    pub async fn list_layouts(&self, owner: &str) -> Result<Vec<LayoutSummary>> {
        let v = self
            .get_json(&format!("/api/tui/layouts?owner={}", urlencode(owner)))
            .await?;
        Ok(serde_json::from_value::<LayoutsResponse>(v)
            .context("decode layouts")?
            .layouts)
    }

    pub async fn get_layout(&self, owner: &str, name: &str) -> Result<Option<LayoutRow>> {
        let v = self
            .get_json(&format!(
                "/api/tui/layouts/{}?owner={}",
                urlencode(name),
                urlencode(owner)
            ))
            .await?;
        if v.get("error").is_some() {
            return Ok(None);
        }
        Ok(Some(
            serde_json::from_value::<LayoutRow>(v).context("decode layout")?,
        ))
    }

    pub async fn save_layout(
        &self,
        owner: &str,
        name: &str,
        kdl: &str,
        description: Option<&str>,
    ) -> Result<()> {
        self.put_json(
            "/api/tui/layouts",
            serde_json::json!({ "owner": owner, "name": name, "kdl": kdl, "description": description }),
        )
        .await?;
        Ok(())
    }

    pub async fn delete_layout(&self, owner: &str, name: &str) -> Result<()> {
        self.delete_json(&format!(
            "/api/tui/layouts/{}?owner={}",
            urlencode(name),
            urlencode(owner)
        ))
        .await?;
        Ok(())
    }

    pub async fn list_crews(&self, owner: &str) -> Result<Vec<CrewSummary>> {
        let v = self
            .get_json(&format!("/api/tui/crews?owner={}", urlencode(owner)))
            .await?;
        Ok(serde_json::from_value::<CrewsResponse>(v)
            .context("decode crews")?
            .crews)
    }

    pub async fn get_crew(&self, owner: &str, name: &str) -> Result<Option<CrewRow>> {
        let v = self
            .get_json(&format!(
                "/api/tui/crews/{}?owner={}",
                urlencode(name),
                urlencode(owner)
            ))
            .await?;
        if v.get("error").is_some() {
            return Ok(None);
        }
        Ok(Some(
            serde_json::from_value::<CrewRow>(v).context("decode crew")?,
        ))
    }

    pub async fn save_crew(
        &self,
        owner: &str,
        name: &str,
        members: &[CrewMember],
        layout_name: Option<&str>,
        description: Option<&str>,
    ) -> Result<()> {
        self.put_json(
            "/api/tui/crews",
            serde_json::json!({
                "owner": owner,
                "name": name,
                "members": members,
                "layout_name": layout_name,
                "description": description,
            }),
        )
        .await?;
        Ok(())
    }

    pub async fn delete_crew(&self, owner: &str, name: &str) -> Result<()> {
        self.delete_json(&format!(
            "/api/tui/crews/{}?owner={}",
            urlencode(name),
            urlencode(owner)
        ))
        .await?;
        Ok(())
    }

    /// Subscribe to this pui's agent-intent SSE stream (P12b / tui:dispatch).
    pub async fn subscribe_intents(&self, owner: &str) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        self.subscribe_sse(&format!("/api/tui/intents/stream?client_id={}", urlencode(owner)))
            .await
    }

    /// POST an applied agent-intent result back (P12b / tui:dispatch). `result_json`
    /// is the JSON result payload; `error` is set on failure.
    pub async fn post_intent_result(
        &self,
        id: i64,
        result_json: &str,
        error: Option<&str>,
    ) -> Result<()> {
        let result: serde_json::Value =
            serde_json::from_str(result_json).unwrap_or(serde_json::Value::Null);
        self.post_json(
            &format!("/api/tui/intents/{id}/result"),
            serde_json::json!({ "result": result, "error": error }),
        )
        .await?;
        Ok(())
    }

    pub async fn docs_for(&self, slug: &str, path: Option<&str>) -> Result<DocsResponse> {
        let p = match path {
            Some(rel) => format!("/api/harness/{slug}/project-docs?path={}", urlencode(rel)),
            None => format!("/api/harness/{slug}/project-docs"),
        };
        let v = self.get_json(&p).await?;
        serde_json::from_value::<DocsResponse>(v).context("decode docs")
    }

    pub async fn testing_domains(&self, slug: &str) -> Result<Vec<TestingDomain>> {
        let v = self
            .get_json(&format!("/api/harness/{slug}/testing/domains"))
            .await?;
        Ok(serde_json::from_value::<TestingResponse>(v)
            .context("decode testing domains")?
            .domains)
    }

    /// The runnable file paths of one testing domain (D-004a): domain-detail's
    /// sections flattened to their glob-walked file paths.
    pub async fn testing_domain_files(&self, slug: &str, domain_id: &str) -> Result<Vec<String>> {
        let v = self
            .get_json(&format!(
                "/api/harness/{slug}/testing/domain-detail?domainId={}",
                urlencode(domain_id)
            ))
            .await?;
        let detail = serde_json::from_value::<models::TestingDomainDetail>(v)
            .context("decode domain detail")?;
        Ok(detail
            .sections
            .into_iter()
            .flat_map(|s| s.files)
            .map(|f| f.path)
            .collect())
    }

    /// Run one test file in the harness worktree (D-004a). The backend runs
    /// vitest SYNCHRONOUSLY (up to ~120s) and returns status + tail output.
    pub async fn testing_run(&self, slug: &str, file: &str) -> Result<models::TestRunResult> {
        let v = self
            .post_json(
                &format!("/api/harness/{slug}/testing/run"),
                serde_json::json!({ "runner": { "kind": "vitest", "filePath": file } }),
            )
            .await?;
        serde_json::from_value::<models::TestRunResult>(v).context("decode test run result")
    }

    /// The effective Config-tab view (D-013): Claude Code defaults overlaid by
    /// the harness's `.claude/settings.json`, plus the raw file body for edits.
    pub async fn claude_settings_effective(
        &self,
        slug: &str,
    ) -> Result<models::EffectiveClaudeSettings> {
        let v = self
            .get_json(&format!("/api/harness/{slug}/claude-settings/effective"))
            .await?;
        serde_json::from_value::<models::EffectiveClaudeSettings>(v)
            .context("decode claude-settings effective")
    }

    /// Write `.claude/settings.json` for a harness (D-013). Empty content
    /// deletes the file (the backend clears the PG row + unlinks the mirror).
    pub async fn put_claude_settings(&self, slug: &str, content: &str) -> Result<()> {
        let v = self
            .put_json(
                &format!("/api/harness/{slug}/claude-settings"),
                serde_json::json!({ "content": content }),
            )
            .await?;
        if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
            Ok(())
        } else {
            anyhow::bail!(
                "put claude-settings: {}",
                v.get("error").and_then(|e| e.as_str()).unwrap_or("unknown error")
            )
        }
    }

    // ─── Plugins tab (D-007 contributions + D-014 settings) ───

    /// All installed plugin manifests (`GET /api/plugins/global`) — identity +
    /// contribution surfaces + configSchema for the Plugins tab.
    pub async fn plugins_global(&self) -> Result<Vec<models::PluginManifest>> {
        let v = self.get_json("/api/plugins/global").await?;
        Ok(serde_json::from_value::<models::PluginsGlobalResponse>(v)
            .context("decode plugins global")?
            .plugins)
    }

    /// One plugin's saved per-harness config (D-014). Empty object when unset.
    pub async fn plugin_config(
        &self,
        harness: &str,
        plugin: &str,
    ) -> Result<serde_json::Value> {
        let v = self
            .get_json(&format!(
                "/api/plugins/config?harness={}&plugin={}",
                urlencode(harness),
                urlencode(plugin)
            ))
            .await?;
        Ok(serde_json::from_value::<models::PluginConfigResponse>(v)
            .context("decode plugin config")?
            .config)
    }

    /// Save a plugin's per-harness config (D-014) — the same `PUT
    /// /api/plugins/config` the desktop form uses (validates against the
    /// manifest's configSchema server-side; mirrors to PG encrypted).
    pub async fn put_plugin_config(
        &self,
        harness: &str,
        plugin: &str,
        config: &serde_json::Value,
    ) -> Result<()> {
        let v = self
            .put_json(
                "/api/plugins/config",
                serde_json::json!({ "harness": harness, "plugin": plugin, "config": config }),
            )
            .await?;
        if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
            Ok(())
        } else {
            anyhow::bail!(
                "put plugin config: {}",
                v.get("error").and_then(|e| e.as_str()).unwrap_or("unknown error")
            )
        }
    }

    // ─── Memory tab (D-006 Step 2) ───

    /// All memories for the current user (+ the active harness's pool) via the
    /// `memory:list` agent tool. `ok:false` (backend unavailable) is a VALID
    /// payload — the Memory tab renders its empty state from it, not an error.
    pub async fn memory_list(&self, harness: Option<&str>) -> Result<models::MemoriesPayload> {
        let mut body = serde_json::json!({});
        if let Some(h) = harness {
            body["harness_slug"] = serde_json::Value::String(h.to_string());
        }
        let env = self.post_json("/api/agent-tools/memory/list", body).await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("memory:list: missing content[0].text")?;
        serde_json::from_str::<models::MemoriesPayload>(text).context("parse memory list payload")
    }

    /// Semantic recall via the `memory:search` agent tool (same envelope).
    pub async fn memory_search(
        &self,
        query: &str,
        harness: Option<&str>,
        limit: u32,
    ) -> Result<models::MemoriesPayload> {
        let mut body = serde_json::json!({ "query": query, "limit": limit });
        if let Some(h) = harness {
            body["harness_slug"] = serde_json::Value::String(h.to_string());
        }
        let env = self.post_json("/api/agent-tools/memory/search", body).await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("memory:search: missing content[0].text")?;
        serde_json::from_str::<models::MemoriesPayload>(text).context("parse memory search payload")
    }

    /// Human-facing coord inbox (P-002) — messages/escalations/handoffs with
    /// 'human' in `to`. The pui consumer refetches this on a coord-inbox SSE wake.
    pub async fn coord_inbox(&self) -> Result<Vec<CoordMsg>> {
        let v = self.get_json("/api/coord/inbox").await?;
        Ok(serde_json::from_value::<CoordInboxResponse>(v)
            .context("decode coord inbox")?
            .items)
    }

    // ─── Voice mode (voice-mode-tui-port-2026-06-05 P1) ───
    // The TUI can't reach this box's localhost voicemode/kokoro services
    // directly (remote-HTTP deployment) and its IPC `sys:http` bridge is
    // binary-unsafe, so audio crosses as base64 JSON through two operator
    // proxy routes (D-006). Engine/voice defaults come from the operator's
    // voice prefs server-side — the TUI just sends audio + text.

    /// Transcribe a 16 kHz mono PCM16 WAV via the operator STT proxy
    /// (`POST /api/agent-mcp/operator-stt` → voicemode Whisper). Returns the
    /// recognized text (empty string when Whisper heard nothing).
    pub async fn stt_transcribe(&self, wav: &[u8]) -> Result<String> {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(wav);
        let v = self
            .post_json(
                "/api/agent-mcp/operator-stt",
                serde_json::json!({ "audioBase64": b64, "format": "wav" }),
            )
            .await?;
        if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
            let err = v.get("error").and_then(|x| x.as_str()).unwrap_or("stt failed");
            return Err(anyhow!("{err}"));
        }
        Ok(v.get("text").and_then(|x| x.as_str()).unwrap_or("").trim().to_string())
    }

    /// Synthesize `text` to speech via the operator TTS proxy
    /// (`POST /api/agent-mcp/operator-tts`). Engine + voice resolve from the
    /// operator's voice prefs server-side. Returns the decoded audio bytes
    /// (wav from kokoro, mp3 from the cloud engines) for `rodio` playback.
    pub async fn tts_speak(&self, text: &str) -> Result<Vec<u8>> {
        use base64::Engine as _;
        let v = self
            .post_json(
                "/api/agent-mcp/operator-tts",
                serde_json::json!({ "text": text }),
            )
            .await?;
        if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
            let err = v.get("error").and_then(|x| x.as_str()).unwrap_or("tts failed");
            return Err(anyhow!("{err}"));
        }
        let b64 = v
            .get("audioBase64")
            .and_then(|x| x.as_str())
            .context("operator-tts: missing audioBase64")?;
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .context("operator-tts: bad base64 audio")
    }

    /// Recent toast-log entries → notification history (P8).
    pub async fn recent_toasts(&self, limit: u32) -> Result<Vec<Notif>> {
        let v = self.get_json(&format!("/api/toast-log?limit={limit}")).await?;
        let toasts = serde_json::from_value::<ToastsResponse>(v)
            .context("decode toast-log")?
            .toasts;
        Ok(toasts
            .into_iter()
            .map(|t| Notif {
                level: t.level,
                message: t.message,
                harness: t.harness_slug,
                ts: Some(t.created_at.to_string()),
            })
            .collect())
    }

    // ─── Create / share pot (D-010) ───

    /// Register a new pot. `source` is either an existing local directory or a
    /// GitHub URL (`https://github.com/…` / `git@github.com:…`) to clone —
    /// `POST /api/harness/projects` supports both entry points. The backend's
    /// 4xx errors ("slug already exists", "path does not exist") come back as
    /// `error` in the decoded response, not a transport Err.
    pub async fn create_harness(
        &self,
        slug: &str,
        source: &str,
    ) -> Result<models::CreateProjectResponse> {
        let body = if source.starts_with("https://") || source.starts_with("git@") {
            serde_json::json!({ "slug": slug, "githubUrl": source })
        } else {
            serde_json::json!({ "slug": slug, "path": source })
        };
        let v = self.post_json("/api/harness/projects", body).await?;
        serde_json::from_value::<models::CreateProjectResponse>(v).context("decode create project")
    }

    /// Resolve a GitHub remote to its canonical repo identity — the share
    /// flow's first step (`POST /api/harness/binding/resolve`).
    pub async fn resolve_binding(
        &self,
        github_remote: &str,
    ) -> Result<models::BindingResolveResponse> {
        let v = self
            .post_json(
                "/api/harness/binding/resolve",
                serde_json::json!({ "github_remote": github_remote }),
            )
            .await?;
        serde_json::from_value::<models::BindingResolveResponse>(v).context("decode binding resolve")
    }

    /// Finalize sharing a pot (`POST /api/harness/:slug/share/finalize`):
    /// writes shared.json, boots the swarm, publishes the binding. `state`
    /// carries `{topic, github_remote, github_repository_id, privacy}` — the
    /// same shape the desktop ShareWizard submits.
    pub async fn share_finalize(
        &self,
        slug: &str,
        state: serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.post_json(
            &format!("/api/harness/{}/share/finalize", urlencode(slug)),
            serde_json::json!({ "state": state }),
        )
        .await
    }

    /// Publish a harness listing to the Cupboard
    /// (`POST /api/harness/cupboard/publish` — the gh-token-adding proxy).
    pub async fn cupboard_publish_harness(
        &self,
        body: serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.post_json("/api/harness/cupboard/publish", body).await
    }

    // ─── Cupboard tab (D-011) ───

    /// Browse/search marketplace listings (`GET /api/cupboard/listings`).
    /// `kind` narrows to harness|blueprint|snapshot|plugin; `q` is full-text.
    pub async fn cupboard_listings(
        &self,
        kind: Option<&str>,
        q: Option<&str>,
        limit: u32,
    ) -> Result<Vec<models::CupboardListing>> {
        let mut path = format!("/api/cupboard/listings?limit={limit}");
        if let Some(k) = kind.filter(|k| !k.is_empty() && *k != "all") {
            path.push_str(&format!("&kind={}", urlencode(k)));
        }
        if let Some(q) = q.filter(|q| !q.is_empty()) {
            path.push_str(&format!("&q={}", urlencode(q)));
        }
        let v = self.get_json(&path).await?;
        Ok(serde_json::from_value::<models::CupboardListingsResponse>(v)
            .context("decode cupboard listings")?
            .listings)
    }

    /// Install a plugin listing (`POST /api/cupboard/install-plugin`).
    /// `acceptCapabilities` auto-grants the manifest's capability requests —
    /// the TUI confirm step happens BEFORE this call (the `y` confirm).
    pub async fn cupboard_install_plugin(&self, listing_id: &str) -> Result<serde_json::Value> {
        self.post_json(
            "/api/cupboard/install-plugin",
            serde_json::json!({ "listingId": listing_id, "acceptCapabilities": true }),
        )
        .await
    }

    /// Install (fork) a blueprint listing (`POST /api/cupboard/install-blueprint`),
    /// auto-installing its declared plugin deps from the Cupboard.
    pub async fn cupboard_install_blueprint(&self, listing_id: &str) -> Result<serde_json::Value> {
        self.post_json(
            "/api/cupboard/install-blueprint",
            serde_json::json!({ "listingId": listing_id, "installPlugins": true }),
        )
        .await
    }

    /// Fork a snapshot listing into a new local harness
    /// (`POST /api/snapshots/fork-from-cupboard` — downloads + SHA-verifies the
    /// published tarball, then instantiates).
    pub async fn snapshot_fork_from_cupboard(&self, listing_id: &str) -> Result<serde_json::Value> {
        self.post_json(
            "/api/snapshots/fork-from-cupboard",
            serde_json::json!({ "listing_id": listing_id }),
        )
        .await
    }

    /// Join a shared harness from its `papercusp://harness?…` link
    /// (`POST /api/harness/join-link` — clones, registers, scaffolds).
    pub async fn harness_join_link(&self, slug: &str, link: &str) -> Result<serde_json::Value> {
        self.post_json(
            "/api/harness/join-link",
            serde_json::json!({ "slug": slug, "harnessLinkUrl": link }),
        )
        .await
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
