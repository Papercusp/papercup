//! Backend client over a **pluggable transport** (D-009): `/api/*` routes go
//! through either the operator's IPC `sys:http` tool (local Unix socket,
//! zero-auth) or direct HTTP+bearer (remote / Claude Code plugin). The typed
//! method surface + the UI are transport-agnostic; only `Transport` knows the
//! wire. Selection happens at `from_discovery()`: IPC if the socket connects,
//! else HTTP from `operator.json`.
#![allow(dead_code)] // some typed methods are consumed as the panels grow.

use crate::http::HttpClient;
use crate::ipc::{CallEvent, CallFrame, IpcClient};
use crate::models;
use crate::models::{
    ActivityRecentPayload, ActivityRow, AgentConfigResponse, AttentionItem, AttentionResponse,
    BeeAssignment, BeeMailPayload, ConvDetail, ConvListResponse, ConvSummary, ConversationLoad,
    CoordInboxResponse, CoordMsg, CrewMember, CrewRow, CrewSummary, CrewsResponse,
    DocsResponse, FeaturesPayload, FleetAssignmentsPayload, FlagsResponse,
    HarnessFeature, HarnessIssue, HarnessRef, IssuesResponse, LayoutRow, LayoutSummary,
    LayoutsResponse, LexiconPackPayload, Notif, OperatorConfig, PlanItemStates, PlanSummary,
    PlansResponse, ProjectsResponse, RosterEntry, RosterResponse,
    TestingDomain, TestingResponse, ToastsResponse, TuiPanesPayload, TurnsPage, ViewState,
    ViewStateResponse, WorkItem, WorkItemsPayload,
};
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
fn ipc_sse_pipe(
    mut frames: mpsc::UnboundedReceiver<CallFrame>,
) -> mpsc::UnboundedReceiver<SseFrame> {
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

    /// Invoke any palette-eligible server tool over the loopback run-tool route
    /// (POST /api/agent-mcp/run-tool → `{ ok, result }`, where `result` holds the
    /// tool's content). The generic pui→server-tool bridge: the wake-mode UI
    /// (`coord:wake-mode` / `coord:wake-queue`, hive-agent-tabs P-008/P-009) + any
    /// future pui tool-call go through it.
    pub async fn run_tool(
        &self,
        name: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.post_json("/api/agent-mcp/run-tool", run_tool_body(name, args))
            .await
    }
    pub async fn plans_list(&self) -> Result<serde_json::Value> {
        self.get_json("/api/admin/plans/list").await
    }

    /// Bring an agent's external terminal window to the foreground via the
    /// `/api/adv/sessions/focus` route (wmctrl `-ia`). The route resolves a
    /// window id from (in order) an explicit `windowId`, the adv_sessions row's
    /// stored `window_id` (looked up by `id`), the `pid` (`wmctrl -lp`), or the
    /// `[adv:<id>]` title fragment. Best-effort: `Ok(false)` when no window can
    /// be resolved (no wmctrl / no DISPLAY / pid has no window) — the caller
    /// surfaces a "couldn't focus" toast rather than treating it as a hard error.
    /// Enter-by-location external-window route (pui-workbench-usability D-001).
    pub async fn focus_session(
        &self,
        adv_session_id: Option<i64>,
        pid: Option<i64>,
        window_id: Option<String>,
    ) -> Result<bool> {
        let mut body = serde_json::Map::new();
        if let Some(id) = adv_session_id {
            body.insert("id".into(), serde_json::json!(id));
        }
        if let Some(p) = pid {
            body.insert("pid".into(), serde_json::json!(p));
        }
        if let Some(w) = window_id.filter(|w| !w.is_empty()) {
            body.insert("windowId".into(), serde_json::json!(w));
        }
        // The route returns 404 (window unresolvable) / 500 (wmctrl failed) with
        // a JSON `{status:'error'}` body; the transport surfaces non-2xx as an
        // Err, so treat any failure as "couldn't focus" (Ok(false)) — only a
        // parsed `{status:'ok'}` is success.
        match self
            .post_json("/api/adv/sessions/focus", serde_json::Value::Object(body))
            .await
        {
            Ok(v) => Ok(v.get("status").and_then(|s| s.as_str()) == Some("ok")),
            Err(_) => Ok(false),
        }
    }

    /// Atomically CLAIM a pending workbench launch (EI-358 claim-then-open):
    /// the route stamps `launched_at` only when unset, so `stamped == true`
    /// for exactly ONE caller across every pui process — the claim winner
    /// opens the pane; losers skip. A transport error is `Err` (retryable —
    /// the caller un-tracks the id so a later roster tick can retry), distinct
    /// from a LOST claim (`Ok(false)` — another instance owns it, skip forever).
    pub async fn mark_session_launched(&self, adv_session_id: i64) -> Result<bool> {
        let body = serde_json::json!({ "id": adv_session_id });
        let v = self
            .post_json("/api/adv/sessions/mark-launched", body)
            .await?;
        Ok(v.get("stamped").and_then(|s| s.as_bool()).unwrap_or(false))
    }

    // --- typed ---
    /// The live roster: `(active, pending)`. `active` is the presence-primary
    /// roster (rendered); `pending` is the recorded-but-not-running workbench-
    /// launch tier the reducer diffs to reactively open panes (D-006).
    pub async fn roster_typed(&self) -> Result<(Vec<RosterEntry>, Vec<RosterEntry>)> {
        let v = self.roster().await?;
        let resp = serde_json::from_value::<RosterResponse>(v).context("decode roster")?;
        Ok((resp.active, resp.pending))
    }

    pub async fn plans_typed(&self) -> Result<Vec<PlanSummary>> {
        let v = self.plans_list().await?;
        Ok(serde_json::from_value::<PlansResponse>(v)
            .context("decode plans")?
            .plans)
    }

    /// Deployed cloud frames (`/api/deploy/frames`) — the per-frame-tab roster
    /// (hive-agent-tabs P-013).
    pub async fn deploy_frames(&self) -> Result<Vec<crate::models::DeployFrameRow>> {
        let v = self.get_json("/api/deploy/frames").await?;
        Ok(
            serde_json::from_value::<crate::models::DeployFramesResponse>(v)
                .context("decode deploy frames")?
                .frames,
        )
    }

    pub async fn attention_typed(&self) -> Result<Vec<AttentionItem>> {
        let v = self.get_json("/api/admin/plans/attention").await?;
        let groups = serde_json::from_value::<AttentionResponse>(v)
            .context("decode attention")?
            .groups;
        Ok(groups.into_iter().flat_map(|g| g.items).collect())
    }

    /// Fleet rate/usage read-model for the Overview top-bar (Brief 23 P-005;
    /// rate-limit-layer-v2 P-013). The `status` half of
    /// GET `/api/operator/rate-limit-config`.
    pub async fn fleet_rate_status(&self) -> Result<models::FleetRateStatus> {
        let v = self.get_json("/api/operator/rate-limit-config").await?;
        let status = v.get("status").cloned().unwrap_or(serde_json::Value::Null);
        serde_json::from_value(status).context("decode fleet rate status")
    }

    /// Edit the user-editable hard cap (`maxSimultaneousAgents`) — persists to
    /// PG and propagates live to the governor + dispatcher (no restart).
    pub async fn set_max_agents(&self, n: u32) -> Result<()> {
        self.put_json(
            "/api/operator/rate-limit-config",
            serde_json::json!({ "maxSimultaneousAgents": n }),
        )
        .await?;
        Ok(())
    }

    // ─── Realtime operator voice (voice-realtime-tui-2026-06-05) ───

    /// Init a raw-WS EL Conv-AI session: mints the signed URL server-side and
    /// claims the fleet voice lease (kind 'tui'). `force` = the user explicitly
    /// toggled (pre-empts another surface's lease — the desktop/mobile
    /// claim-on-tap contract). Non-2xx (409 lease-held / 429 cooldown / 404
    /// not-enabled) surfaces as an error carrying the route's JSON hint.
    pub async fn elevenlabs_ws_init(
        &self,
        owner: &str,
        force: bool,
    ) -> Result<crate::voice_convai::WsInitPayload> {
        let v = self
            .get_json(&format!(
                "/api/agent-mcp/operator-elevenlabs-ws-init?owner={}{}",
                urlencode(owner),
                if force { "&force=1" } else { "" },
            ))
            .await?;
        serde_json::from_value(v).context("decode ws-init payload")
    }

    /// Refresh the tui voice lease. `Ok(false)` = LOST it (another surface
    /// force-claimed) — the session must tear down.
    pub async fn voice_lease_heartbeat(&self, owner: &str) -> Result<bool> {
        let v = self
            .post_json(
                "/api/agent-mcp/operator-voice-lease/heartbeat",
                serde_json::json!({ "owner": owner }),
            )
            .await?;
        Ok(v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false))
    }

    pub async fn voice_lease_release(&self, owner: &str) -> Result<()> {
        self.delete_json(&format!(
            "/api/agent-mcp/operator-voice-lease?owner={}",
            urlencode(owner)
        ))
        .await?;
        Ok(())
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

    /// P2P voice channel registry via the `voice:channels` agent-tool
    /// (holepunch-voice-channels P-008). MCP envelope → inner `{ok,channels}`.
    pub async fn voice_channels_list(&self) -> Result<Vec<crate::voice_ui::VoiceChannelRow>> {
        let env = self
            .post_json("/api/agent-tools/voice/channels", serde_json::json!({ "op": "list" }))
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("voice:channels: missing content[0].text")?;
        #[derive(serde::Deserialize)]
        struct P {
            channels: Vec<crate::voice_ui::VoiceChannelRow>,
        }
        Ok(serde_json::from_str::<P>(text).context("parse voice channels")?.channels)
    }

    /// Create a voice channel by name, returning the refreshed list.
    pub async fn voice_channel_create(
        &self,
        name: &str,
    ) -> Result<Vec<crate::voice_ui::VoiceChannelRow>> {
        let _ = self
            .post_json(
                "/api/agent-tools/voice/channels",
                serde_json::json!({ "op": "create", "name": name }),
            )
            .await?;
        self.voice_channels_list().await
    }

    /// Read the operator voice-prefs (the Voice Settings overlay, P-017).
    pub async fn voice_prefs_get(&self) -> Result<crate::voice_ui::VoicePrefsView> {
        let env = self
            .post_json("/api/agent-tools/operator/voice_prefs", serde_json::json!({ "op": "get" }))
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("voice_prefs: missing content[0].text")?;
        serde_json::from_str::<crate::voice_ui::VoicePrefsView>(text).context("parse voice prefs")
    }

    /// Patch one voice-pref field, returning the refreshed view.
    pub async fn voice_prefs_set(
        &self,
        key: &str,
        value: serde_json::Value,
    ) -> Result<crate::voice_ui::VoicePrefsView> {
        let _ = self
            .post_json(
                "/api/agent-tools/operator/voice_prefs",
                serde_json::json!({ "op": "set", "patch": { key: value } }),
            )
            .await?;
        self.voice_prefs_get().await
    }

    pub async fn issues_for(&self, slug: &str) -> Result<Vec<HarnessIssue>> {
        let v = self
            .get_json(&format!("/api/harness/{slug}/issues"))
            .await?;
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
            .post_json(
                "/api/agent-tools/conversations/list",
                serde_json::Value::Object(body),
            )
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
            let reason = v
                .get("reason")
                .and_then(|r| r.as_str())
                .unwrap_or("promote_failed");
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
    pub async fn message_agent(
        &self,
        to: Option<&str>,
        harness: Option<&str>,
        plan_slug: Option<&str>,
        item_ref: Option<&str>,
        title: &str,
        body: &str,
    ) -> Result<String> {
        let mut payload = serde_json::Map::new();
        if let Some(t) = to {
            payload.insert("to".into(), serde_json::json!(t));
        }
        payload.insert("body".into(), serde_json::json!(body));
        if let Some(h) = harness {
            payload.insert("harness".into(), serde_json::json!(h));
        }
        if let Some(p) = plan_slug {
            payload.insert("plan_slug".into(), serde_json::json!(p));
        }
        if let Some(r) = item_ref {
            payload.insert("item_ref".into(), serde_json::json!(r));
        }
        let title_trunc: String = title.chars().take(120).collect();
        payload.insert("title".into(), serde_json::json!(title_trunc));
        let v = self
            .post_json(
                "/api/admin/coord/message-agent",
                serde_json::Value::Object(payload),
            )
            .await?;
        if v.get("ok").and_then(|b| b.as_bool()) == Some(false) {
            let err = v
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("message_failed");
            return Err(anyhow!("message owner failed: {err}"));
        }
        Ok(v.get("conversation_id")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string())
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

    /// Put a picked-up plan item back (P-005b release half — the `:pickup`
    /// inverse). POSTs /api/tui/plan-item-release, which releases the
    /// converted work_item via `work_items:release` (server-side reflect rules
    /// flip the item back to todo + drop the lease) or, with no live execution
    /// record, drops the bare plan-item lease via `plan_items:release`.
    /// Returns the tool's JSON payload stamped with `via`:
    /// `{ ok, via, workItem?, released?, note?, … }`.
    pub async fn plan_item_release(
        &self,
        owner: &str,
        harness: &str,
        plan: &str,
        item: &str,
    ) -> Result<serde_json::Value> {
        self.post_json(
            "/api/tui/plan-item-release",
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
            .post_json(
                "/api/agent-tools/operator/credentials_status",
                serde_json::json!({}),
            )
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
    pub async fn activity_recent(
        &self,
        kind: Option<&str>,
        limit: u32,
    ) -> Result<Vec<ActivityRow>> {
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

    // ─── Bee-dossier dock pane (pui-bee-dossier-pane-2026-06-06) ───
    // The bee pane (`pui bee-pane`) renders the swarm-selected bee's dossier:
    // its ranked work-list (fleet:assignments) + coord inbox/outbox
    // (fleet:bee_mail). The swarm pane publishes the cursor's bee via
    // fleet:selected_bee; the bee pane polls it (DB is NOT the transport — the
    // relay is an in-memory operator endpoint, see fleet/selected-bee.ts).

    /// The selected bee's ordered work-list via `fleet:assignments { agent }`
    /// (MCP envelope unwrapped). Returns the matching `AgentAssignment` (or None
    /// when the bee holds nothing / isn't present).
    pub async fn bee_assignment(&self, owner_id: &str) -> Result<Option<BeeAssignment>> {
        let env = self
            .post_json(
                "/api/agent-tools/fleet/assignments",
                serde_json::json!({ "agent": owner_id, "include_stale": true }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("fleet:assignments: missing content[0].text")?;
        let payload: FleetAssignmentsPayload =
            serde_json::from_str(text).context("parse fleet assignments payload")?;
        // The `agent` filter returns just this bee, but match defensively on id/name.
        Ok(payload.agents.into_iter().find(|a| {
            a.agent_id == owner_id || a.name.as_deref() == Some(owner_id)
        }))
    }

    /// The federated p2p roster — every remote hive announced into
    /// `shared_presence`, via `coord:presence { include_stale: true }` (MCP
    /// envelope unwrapped). Local (non-federated) session rows are dropped;
    /// stale federated rows are KEPT — a hive that joined the swarm but is
    /// currently quiet still lists, marked stale (pui-hives-tab-2026-06-07).
    pub async fn federated_hives(&self) -> Result<Vec<crate::models::PresenceRow>> {
        let env = self
            .post_json(
                "/api/agent-tools/coord/presence",
                serde_json::json!({ "include_stale": true }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("coord:presence: missing content[0].text")?;
        let p: crate::models::PresencePayload =
            serde_json::from_str(text).context("parse presence payload")?;
        Ok(p.active
            .into_iter()
            .chain(p.stale)
            .filter(|r| r.federated)
            .collect())
    }

    /// The P2P hive directory — verified hives announced on the well-known
    /// directory topic (`GET /api/discovery/hives`, p2p-hive-directory P-006).
    pub async fn discovered_hives(&self) -> Result<Vec<crate::models::DiscoveredHiveRow>> {
        let v = self.get_json("/api/discovery/hives").await?;
        let resp: crate::models::DiscoveredHivesResponse =
            serde_json::from_value(v).context("parse discovered-hives response")?;
        Ok(resp.rows)
    }

    /// The cross-Hive network board (hive-network-surface-2026-06-11 P-006):
    /// one pinned-C-3 row per hive-context over the capability ladder. The
    /// live surface is B-08's NAMED SYNC QUERY `network.board` over the
    /// zero-harness rest-query route (announced coord 2026-06-11 — there is
    /// deliberately no raw route); its invalidations ride the same
    /// `/api/zero-harness/sse` stream the refetch loop already subscribes, so
    /// freshness is the standard pui convention (SSE invalidate + 60s safety
    /// net). Response: `{ rows: NetworkBoardRow[], version }`.
    pub async fn network_board(&self) -> Result<Vec<crate::models::NetworkBoardRow>> {
        let v = self
            .get_json("/api/zero-harness/rest-query?name=network.board&args=%7B%7D")
            .await?;
        let resp: crate::models::NetworkBoardResponse =
            serde_json::from_value(v).context("parse network-board response")?;
        Ok(resp.rows)
    }

    /// One named sync query over the zero-harness rest-query route, returning
    /// its `rows` (`{ rows, version }` envelope — version unused; the SSE
    /// invalidate stream drives the refetch cadence, not row versions).
    async fn rest_query_rows<T: serde::de::DeserializeOwned>(
        &self,
        name: &str,
        args: &serde_json::Value,
    ) -> Result<Vec<T>> {
        let v = self
            .get_json(&format!(
                "/api/zero-harness/rest-query?name={}&args={}",
                name,
                urlencode(&args.to_string())
            ))
            .await?;
        let rows = v.get("rows").cloned().unwrap_or_else(|| serde_json::json!([]));
        serde_json::from_value(rows).with_context(|| format!("parse {name} rows"))
    }

    /// A foreign hive's beacon HISTORY (`network.hive.beacons`, hive-network-
    /// surface P-014 item 2): captured C-2 snapshots newest-first. `hive_key`
    /// is the C-3 tier-4 row key (pubkey-b64 or hiveId — either resolves).
    pub async fn hive_beacons(
        &self,
        hive_key: &str,
    ) -> Result<Vec<crate::models::HiveBeaconSnapshot>> {
        self.rest_query_rows(
            "network.hive.beacons",
            &serde_json::json!({ "hiveKey": hive_key }),
        )
        .await
    }

    /// The full C-1 ask log (`network.hive.asks`, P-014 item 2), newest-first,
    /// narrowed to one peer pubkey — the tier-4 dossier's traffic view.
    pub async fn hive_asks(
        &self,
        peer_pubkey: &str,
    ) -> Result<Vec<crate::models::CrossHiveAskRow>> {
        self.rest_query_rows(
            "network.hive.asks",
            &serde_json::json!({ "peerPubkey": peer_pubkey }),
        )
        .await
    }

    /// The hive-SCOPED staged-wake queue (`network.hive.wakes`, P-014 item 3 /
    /// D-007 GAP 1): every hive-attributed owner's pending wakes, filtered
    /// server-side (owner ASC, oldest-first — assemble groups per owner).
    pub async fn hive_wakes(&self, hive: &str) -> Result<Vec<crate::models::PendingWake>> {
        self.rest_query_rows("network.hive.wakes", &serde_json::json!({ "hive": hive }))
            .await
    }

    /// Join one member harness of a discovered hive (`POST /api/harness/join-link`).
    /// The joiner's GitHub identity + device keychain are resolved server-side.
    pub async fn join_hive_link(&self, slug: &str, harness_link_url: &str) -> Result<serde_json::Value> {
        self.post_json(
            "/api/harness/join-link",
            serde_json::json!({ "slug": slug, "harnessLinkUrl": harness_link_url }),
        )
        .await
    }

    /// Whole-fleet assignments — every bee's ranked work-list in one call
    /// (`fleet:assignments {}` with NO `agent` filter). Drives the default Swarm
    /// dossier (pui-dock-consolidation-2026-06-07 #2 "show all tasks from the
    /// fleet"); a roster selection narrows to one bee via `bee_assignment`.
    pub async fn fleet_assignments_all(&self) -> Result<Vec<BeeAssignment>> {
        let env = self
            .post_json(
                "/api/agent-tools/fleet/assignments",
                serde_json::json!({ "include_stale": true }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("fleet:assignments: missing content[0].text")?;
        let payload: FleetAssignmentsPayload =
            serde_json::from_str(text).context("parse fleet assignments payload")?;
        Ok(payload.agents)
    }

    /// The prompt an agent runs on (`GET /api/fleet/agent-prompt`, dock
    /// prompt-pane): a spawn's recorded prompt_body + brief/model/tier, or a
    /// live role-persona render when only a `role` hint is available (the
    /// interactive queen). Returns the raw JSON — the caller maps fields.
    pub async fn agent_prompt(
        &self,
        owner: Option<&str>,
        role: Option<&str>,
    ) -> Result<serde_json::Value> {
        let mut q: Vec<String> = Vec::new();
        if let Some(o) = owner {
            q.push(format!("owner={}", urlencode(o)));
        }
        if let Some(r) = role {
            q.push(format!("role={}", urlencode(r)));
        }
        self.get_json(&format!("/api/fleet/agent-prompt?{}", q.join("&")))
            .await
    }

    /// The selected bee's coord inbox + outbox via `fleet:bee_mail { owner_id }`
    /// (MCP envelope unwrapped).
    pub async fn bee_mail(&self, owner_id: &str, limit: u32) -> Result<BeeMailPayload> {
        let env = self
            .post_json(
                "/api/agent-tools/fleet/bee_mail",
                serde_json::json!({ "owner_id": owner_id, "limit": limit }),
            )
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("fleet:bee_mail: missing content[0].text")?;
        serde_json::from_str::<BeeMailPayload>(text).context("parse bee_mail payload")
    }

    /// Publish the swarm-pane selection. `fleet:selected_bee { select }`. An
    /// empty `owner_id` clears it. Best-effort — the result envelope is ignored.
    pub async fn selected_bee_set(&self, owner_id: Option<&str>, name: Option<&str>) -> Result<()> {
        self.post_json(
            "/api/agent-tools/fleet/selected_bee",
            serde_json::json!({
                "select": { "owner_id": owner_id, "name": name }
            }),
        )
        .await?;
        Ok(())
    }

    /// The active brand pack's term→label map via `lexicon:active_pack`
    /// (pui-hive-lexicon-2026-06-06; MCP envelope unwrapped). Fetched once at
    /// startup; the pui falls back to its built-in classic labels on any error.
    pub async fn lexicon_active_pack(&self) -> Result<LexiconPackPayload> {
        let env = self
            .post_json("/api/agent-tools/lexicon/active_pack", serde_json::json!({}))
            .await?;
        let text = env
            .get("content")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .context("lexicon:active_pack: missing content[0].text")?;
        serde_json::from_str::<LexiconPackPayload>(text).context("parse lexicon pack payload")
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
    pub async fn subscribe_intents(
        &self,
        owner: &str,
    ) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        self.subscribe_sse(&format!(
            "/api/tui/intents/stream?client_id={}",
            urlencode(owner)
        ))
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
        // Merged docs tree (harness-docs-integration-2026-06-05): generated · manual ·
        // augmented with per-doc source + drift status + the active overlay. Supersedes
        // the FS-only /project-docs read. Cached status (the git-sync sweep keeps it
        // fresh) — no per-fetch recompute, so the poller stays cheap.
        let p = match path {
            Some(rel) => format!("/api/harness/{slug}/docs?path={}", urlencode(rel)),
            None => format!("/api/harness/{slug}/docs"),
        };
        let v = self.get_json(&p).await?;
        serde_json::from_value::<DocsResponse>(v).context("decode docs")
    }

    /// POST a docs action (regenerate | verify) for one doc (P-009 actions).
    pub async fn docs_action(&self, slug: &str, action: &str, doc_id: &str) -> Result<serde_json::Value> {
        let path = format!("/api/harness/{slug}/docs/{action}");
        self.post_json(&path, serde_json::json!({ "docId": doc_id })).await
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
                v.get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("unknown error")
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
    pub async fn plugin_config(&self, harness: &str, plugin: &str) -> Result<serde_json::Value> {
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
                v.get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("unknown error")
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
        let env = self
            .post_json("/api/agent-tools/memory/search", body)
            .await?;
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
            let err = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("stt failed");
            return Err(anyhow!("{err}"));
        }
        Ok(v.get("text")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string())
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
            let err = v
                .get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("tts failed");
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
        let v = self
            .get_json(&format!("/api/toast-log?limit={limit}"))
            .await?;
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
        serde_json::from_value::<models::BindingResolveResponse>(v)
            .context("decode binding resolve")
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
        Ok(
            serde_json::from_value::<models::CupboardListingsResponse>(v)
                .context("decode cupboard listings")?
                .listings,
        )
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
/// Build the run-tool request body (POST /api/agent-mcp/run-tool). Pure —
/// unit-tested. `confirmed:false` so the server's §3 re-check still gates a
/// destructive/high-risk tool (it replies 409 confirmation_required if so).
fn run_tool_body(name: &str, args: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "name": name, "args": args, "confirmed": false })
}

/// Unwrap a run-tool envelope (`{ ok, result: { content: [{ text }] } }`) to the
/// tool's own inner JSON payload (every tooldef tool returns one JSON text
/// block). Pure — unit-tested; the P-009 wake-queue review parses through this.
pub fn run_tool_inner_json(v: &serde_json::Value) -> Result<serde_json::Value> {
    if v.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let msg = v
            .get("message")
            .or_else(|| v.get("error"))
            .map(|m| m.to_string())
            .unwrap_or_else(|| "run-tool failed".into());
        anyhow::bail!("{msg}");
    }
    let result = v.get("result").ok_or_else(|| anyhow::anyhow!("run-tool: no result"))?;
    if result.get("isError").and_then(serde_json::Value::as_bool) == Some(true) {
        let text = result
            .pointer("/content/0/text")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("tool error");
        anyhow::bail!("{text}");
    }
    let text = result
        .pointer("/content/0/text")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("run-tool: no content text"))?;
    serde_json::from_str(text).with_context(|| "run-tool: inner payload is not JSON")
}

/// Parse a `coord:wake-queue {action:'list'}` run-tool response into the staged
/// wakes (hive-agent-tabs P-009). Pure — unit-tested.
pub fn parse_wake_queue_list(v: &serde_json::Value) -> Result<Vec<crate::models::PendingWake>> {
    let inner = run_tool_inner_json(v)?;
    if inner.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        anyhow::bail!(
            "wake-queue: {}",
            inner.get("reason").and_then(serde_json::Value::as_str).unwrap_or("not ok")
        );
    }
    let pending = inner.get("pending").cloned().unwrap_or(serde_json::json!([]));
    serde_json::from_value(pending).with_context(|| "wake-queue: bad pending rows")
}

/// Assemble the fleet-wide wake board (the `pui wake-pane`, EI-312) from an
/// agent-LESS `coord:wake-queue` list (every owner's staged wakes) + the live
/// roster: one group per owner with a queue, labelled/kinded from the roster
/// when present (a stale owner falls back to its raw id), queen-rank first.
/// Pure — unit-tested.
pub fn assemble_wake_board(
    all_pending: Vec<crate::models::PendingWake>,
    roster: &[crate::models::RosterEntry],
) -> Vec<crate::models::WakeGroup> {
    use crate::agent_pane_kind::AgentPaneKind;
    let mut groups: Vec<crate::models::WakeGroup> = Vec::new();
    for pw in all_pending {
        if let Some(g) = groups.iter_mut().find(|g| g.agent == pw.owner_id) {
            g.pending.push(pw);
            continue;
        }
        let entry = roster.iter().find(|r| r.owner_id == pw.owner_id);
        groups.push(crate::models::WakeGroup {
            agent: pw.owner_id.clone(),
            label: entry
                .map(|r| r.label.clone())
                .filter(|l| !l.is_empty())
                .unwrap_or_else(|| pw.owner_id.clone()),
            kind: entry.and_then(|r| r.agent_pane_kind.clone()),
            wake_mode: entry.and_then(|r| r.wake_mode.clone()),
            pending: vec![pw],
        });
    }
    // Queen-rank first, then label — the queen's queue is what the dock pane
    // exists for, so it leads even when other agents have older rows.
    groups.sort_by(|a, b| {
        let rank = |g: &crate::models::WakeGroup| {
            AgentPaneKind::from_opt(&g.kind).map_or(u8::MAX, |k| k.group_rank())
        };
        rank(a).cmp(&rank(b)).then_with(|| a.label.cmp(&b.label))
    });
    groups
}

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

    #[test]
    fn run_tool_body_has_name_args_and_unconfirmed() {
        let b = super::run_tool_body(
            "coord:wake-mode",
            serde_json::json!({ "agent": "s-1", "mode": "manual" }),
        );
        assert_eq!(b["name"], "coord:wake-mode");
        assert_eq!(b["args"]["agent"], "s-1");
        assert_eq!(b["args"]["mode"], "manual");
        assert_eq!(b["confirmed"], false);
    }

    #[test]
    fn parse_wake_queue_list_unwraps_the_run_tool_envelope() {
        // The full envelope: route { ok, result } → MCP { content:[{text}] } →
        // the tool's own { ok, pending } JSON.
        let inner = serde_json::json!({
            "ok": true,
            "pending": [
                { "id": 7, "ownerId": "bee-1", "summary": "routine tick", "source": "routinesTick", "createdAt": "2026-06-09" },
                { "id": 9, "ownerId": "bee-1", "summary": null, "createdAt": "2026-06-09" },
            ],
        });
        let envelope = serde_json::json!({
            "ok": true,
            "result": { "content": [ { "type": "text", "text": inner.to_string() } ] },
        });
        let got = super::parse_wake_queue_list(&envelope).expect("parses");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].id, 7);
        assert_eq!(got[0].summary.as_deref(), Some("routine tick"));
        assert_eq!(got[1].summary, None);
        // A pre-coalescing payload (no count field) defaults to count 1.
        assert_eq!(got[0].count, 1);
    }

    #[test]
    fn assemble_wake_board_groups_by_owner_queen_first_with_roster_join() {
        // EI-312: three owners' wakes interleaved; the bee + queen are on the
        // roster, the third owner is stale (gone from the roster).
        let pw = |id: i64, owner: &str, summary: &str, count: i64| crate::models::PendingWake {
            id,
            owner_id: owner.into(),
            summary: Some(summary.into()),
            count,
            ..Default::default()
        };
        let roster = vec![
            crate::models::RosterEntry {
                owner_id: "su-bee".into(),
                label: "bee one".into(),
                agent_pane_kind: Some("bee".into()),
                wake_mode: Some("manual".into()),
                ..Default::default()
            },
            crate::models::RosterEntry {
                owner_id: "su-queen".into(),
                label: "the queen".into(),
                agent_pane_kind: Some("queen".into()),
                wake_mode: Some("manual".into()),
                ..Default::default()
            },
        ];
        let groups = super::assemble_wake_board(
            vec![
                pw(1, "su-bee", "placement", 1),
                pw(2, "su-gone", "orphaned tick", 2),
                pw(3, "su-queen", "boot storm", 11),
                pw(4, "su-queen", "cadence", 4),
            ],
            &roster,
        );
        // Queen rank leads; the stale owner (no kind) sorts last under its raw id.
        assert_eq!(
            groups.iter().map(|g| g.agent.as_str()).collect::<Vec<_>>(),
            ["su-queen", "su-bee", "su-gone"]
        );
        assert_eq!(groups[0].label, "the queen");
        assert_eq!(groups[0].kind.as_deref(), Some("queen"));
        assert_eq!(groups[0].pending.iter().map(|w| w.id).collect::<Vec<_>>(), [3, 4]);
        assert_eq!(groups[1].wake_mode.as_deref(), Some("manual"));
        // Stale owner: raw-id label, no kind/mode — still fully reviewable.
        assert_eq!(groups[2].label, "su-gone");
        assert_eq!(groups[2].kind, None);
        assert_eq!(groups[2].pending[0].count, 2);
    }

    #[test]
    fn parse_wake_queue_list_surfaces_tool_errors() {
        // Route-level failure.
        let denied = serde_json::json!({ "ok": false, "error": "forbidden" });
        assert!(super::parse_wake_queue_list(&denied).is_err());
        // MCP isError text block.
        let tool_err = serde_json::json!({
            "ok": true,
            "result": { "isError": true, "content": [ { "type": "text", "text": "handler_error: boom" } ] },
        });
        let err = super::parse_wake_queue_list(&tool_err).unwrap_err().to_string();
        assert!(err.contains("boom"), "{err}");
    }

    // End-to-end IPC round-trips for the client live in ipc.rs (fake Unix-socket
    // server). Here we just cover the pure path-encoding; the typed decoders are
    // covered by models.rs serde tests.
}
