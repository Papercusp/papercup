//! Read bridge for OS-native Workbench widgets. Reuse PUI's selected-operator
//! discovery, IPC/HTTP transports and canonical GUI queries rather than adding
//! another bearer store, local HTTP service or private search implementation.

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::io::Read;
use std::time::Duration;
use std::io::Write;

const MAX_REQUEST_BYTES: u64 = 64 * 1024;

#[derive(Debug, Deserialize)]
pub enum ReadModel {
    #[serde(rename = "plans.list")]
    Plans,
    #[serde(rename = "plans.get")]
    Plan,
    #[serde(rename = "advRoster.list")]
    Agents,
    #[serde(rename = "reports.list")]
    Reports,
    #[serde(rename = "reports.get")]
    Report,
    #[serde(rename = "goals.list")]
    Goals,
    #[serde(rename = "goals.detail")]
    Goal,
    #[serde(rename = "planSessions.list")]
    PlanSessions,
    #[serde(rename = "operator.identity")]
    Environment,
    #[serde(rename = "accounts.pool")]
    Accounts,
    #[serde(rename = "accounts.sessionOverride")]
    AccountOverride,
    #[serde(rename = "operatorConversations.current")]
    OperatorConversation,
    #[serde(rename = "operatorTurns.page")]
    OperatorTurns,
    #[serde(rename = "plans.attention")]
    Attention,
    #[serde(rename = "plans.attentionItem")]
    AttentionItem,
    #[serde(rename = "plans.attentionBulkRun")]
    AttentionBulkRun,
}

impl ReadModel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Plans => "plans.list",
            Self::Plan => "plans.get",
            Self::Agents => "advRoster.list",
            Self::Reports => "reports.list",
            Self::Report => "reports.get",
            Self::Goals => "goals.list",
            Self::Goal => "goals.detail",
            Self::PlanSessions => "planSessions.list",
            Self::Environment => "operator.identity",
            Self::Accounts => "accounts.pool",
            Self::AccountOverride => "accounts.sessionOverride",
            Self::OperatorConversation => "operatorConversations.current",
            Self::OperatorTurns => "operatorTurns.page",
            Self::Attention => "plans.attention",
            Self::AttentionItem => "plans.attentionItem",
            Self::AttentionBulkRun => "plans.attentionBulkRun",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadRequest {
    pub name: ReadModel,
    #[serde(default)]
    pub args: Map<String, Value>,
    #[serde(default)]
    pub environment: Option<crate::client::BackendIdentity>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ChatOperation { Send, Reconnect, Cancel }

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CardsOperation { Subscribe, Respond }

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CardsRequest {
    pub environment: crate::client::BackendIdentity,
    pub conversation_id: String,
    pub operation: CardsOperation,
    pub correlation_id: Option<String>,
    pub action: Option<String>,
    pub payload: Option<Value>,
}

impl CardsRequest {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(uuid(&self.conversation_id), "select an exact card conversation");
        match self.operation {
            CardsOperation::Subscribe => anyhow::ensure!(self.correlation_id.is_none()
                && self.action.is_none() && self.payload.is_none(), "invalid card subscription"),
            CardsOperation::Respond => {
                anyhow::ensure!(self.correlation_id.as_deref().is_some_and(|id| !id.is_empty()
                    && id.len() <= 512 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.' || b == b'_' || b == b':')),
                    "select an exact pending card");
                anyhow::ensure!(matches!(self.action.as_deref(), Some("submit" | "decline" | "cancel"))
                    && (self.action.as_deref() == Some("submit") || self.payload.is_none()), "invalid card response");
            }
        }
        Ok(())
    }
    /// The canonical feed spans a workspace. Never forward another
    /// conversation's card (or an unbound legacy card) into this panel.
    pub fn snapshot(&self, value: &Value) -> Result<Value> {
        anyhow::ensure!(value["workspaceId"] == self.environment.workspace_id
            && value["runId"].as_str().is_some_and(|id| !id.is_empty())
            && value["version"].as_u64().is_some_and(|n| n <= 9_007_199_254_740_991), "invalid card snapshot scope");
        let cards = value["snapshot"]["openCards"].as_array().context("invalid open card snapshot")?;
        Ok(json!({"workspaceId":value["workspaceId"],"runId":value["runId"],"version":value["version"],
            "snapshot":{"openCards":cards.iter().filter(|card| card["conversationId"] == self.conversation_id).collect::<Vec<_>>()}}))
    }
}

fn uuid(s: &str) -> bool {
    s.len() == 36 && s.bytes().enumerate().all(|(i, c)|
        if matches!(i, 8 | 13 | 18 | 23) { c == b'-' } else { c.is_ascii_hexdigit() })
}

/// Extend the native bridge over the existing operator conversation protocol.
/// Native callers cannot inject a persona, workspace authority or chat history.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ChatRequest {
    pub environment: crate::client::BackendIdentity,
    pub conversation_id: String,
    pub operation: ChatOperation,
    pub text: Option<String>,
    pub user_turn_id: Option<String>,
    pub turn_id: Option<String>,
    pub after_sequence: Option<u64>,
    pub modality: Option<String>,
}

impl ChatRequest {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(uuid(&self.conversation_id), "select an exact conversation");
        anyhow::ensure!(self.modality.as_deref().is_none_or(|m| matches!(m, "text" | "voice"))
            && (self.operation == ChatOperation::Send || self.modality.is_none()), "invalid native message modality");
        match self.operation {
            ChatOperation::Send => anyhow::ensure!(
                self.text.as_deref().is_some_and(|s| !s.trim().is_empty() && s.len() <= 32 * 1024)
                && self.user_turn_id.as_deref().is_some_and(uuid)
                && self.turn_id.is_none() && self.after_sequence.is_none(), "invalid native message"),
            _ => anyhow::ensure!(self.turn_id.as_deref().is_some_and(uuid)
                && self.text.is_none() && self.user_turn_id.is_none()
                && self.after_sequence.unwrap_or(0) <= 9_007_199_254_740_991
                && (self.operation != ChatOperation::Cancel || self.after_sequence.is_none()),
                "invalid native reply control"),
        }
        Ok(())
    }
    pub fn control_body(&self) -> Value {
        let mut body = json!({"chatProtocolVersion":1,"conversationId":self.conversation_id,
            "turnId":self.turn_id,"operation":if self.operation == ChatOperation::Cancel {"cancel"} else {"reconnect"}});
        if self.operation == ChatOperation::Reconnect { body["afterSequence"] = json!(self.after_sequence.unwrap_or(0)); }
        body
    }
}

/// Native devices use the existing operator STT/TTS proxies over PUI transport.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum VoiceOperation { Transcribe, Speak }

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VoiceRequest {
    pub environment: crate::client::BackendIdentity,
    pub conversation_id: String,
    pub operation: VoiceOperation,
    pub request_id: String,
    pub audio_base64: Option<String>,
    pub text: Option<String>,
}

impl VoiceRequest {
    pub fn audio(&self) -> Result<Option<Vec<u8>>> {
        use base64::Engine as _;
        anyhow::ensure!(uuid(&self.conversation_id) && uuid(&self.request_id), "select an exact voice conversation/request");
        match self.operation {
            VoiceOperation::Transcribe => {
                anyhow::ensure!(self.text.is_none(), "transcription cannot inject text");
                let encoded = self.audio_base64.as_deref().context("record audio first")?;
                anyhow::ensure!(encoded.len() <= 2_600_000, "voice recording exceeds 60 seconds");
                let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).context("invalid voice audio")?;
                let mut wav = hound::WavReader::new(std::io::Cursor::new(&bytes)).context("voice requires PCM WAV")?;
                let spec = wav.spec();
                anyhow::ensure!(spec.channels == 1 && spec.sample_rate == 16_000 && spec.bits_per_sample == 16
                    && spec.sample_format == hound::SampleFormat::Int && wav.duration() > 0
                    && wav.duration() <= 60 * 16_000, "voice requires up to 60 seconds of 16 kHz mono PCM16");
                for sample in wav.samples::<i16>() { sample.context("incomplete voice recording")?; }
                Ok(Some(bytes))
            }
            VoiceOperation::Speak => {
                anyhow::ensure!(self.audio_base64.is_none() && self.text.as_deref().is_some_and(|s|
                    !s.trim().is_empty() && s.len() <= 32 * 1024), "invalid spoken reply");
                Ok(None)
            }
        }
    }
}

fn bounded_request<T: serde::de::DeserializeOwned>(input: impl Read) -> Result<T> {
    let mut bytes = Vec::new();
    input.take(MAX_REQUEST_BYTES + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_REQUEST_BYTES,
        "native panel request exceeds 64 KiB"
    );
    serde_json::from_slice(&bytes).context("native panel expects one typed JSON request")
}

pub fn read_request(input: impl Read) -> Result<ReadRequest> {
    bounded_request(input)
}

pub async fn run_voice() -> Result<()> {
    // Sixty seconds of mono PCM16 at 16 kHz is 1.92 MB before base64.
    let mut bytes = Vec::new();
    std::io::stdin().lock().take(2_700_001).read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() <= 2_700_000, "voice request is too large");
    let request: VoiceRequest = serde_json::from_slice(&bytes).context("native voice expects one typed JSON request")?;
    tokio::time::timeout(Duration::from_secs(90), async {
        let client = crate::client::OperatorClient::from_discovery().await?;
        println!("{}", client.native_voice(&request).await?);
        Ok(())
    }).await.context("native voice timed out; retry explicitly")?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountAction { Default, Force, Exclude, Auto }

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AccountRequest {
    pub environment: crate::client::BackendIdentity,
    pub action: AccountAction,
    pub account_id: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum InboxOperation { Start, Stop, Resume, Apply, Resolve }

/// Extend the existing native/PUI boundary; the operator remains the sole run
/// store and resolver. The seed is the concrete list the owner saw at click time.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InboxRequest {
    pub environment: crate::client::BackendIdentity,
    pub operation: InboxOperation,
    pub confirmed: bool,
    pub items: Option<Vec<Value>>,
    pub filter: Option<Value>,
    pub run_id: Option<String>,
    pub item_ids: Option<Vec<String>>,
    pub expected: Option<Value>,
    pub action_id: Option<String>,
    pub answer: Option<String>,
}

impl InboxRequest {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(self.confirmed, "confirm the Inbox action first");
        let run = self.run_id.as_deref().is_some_and(|s| !s.is_empty() && s.len() <= 512);
        match self.operation {
            InboxOperation::Start => {
                let items = self.items.as_ref().context("select an exact visible batch")?;
                let mut seen = std::collections::HashSet::new();
                anyhow::ensure!(!items.is_empty() && items.len() <= 2000 && self.filter.as_ref().is_some_and(Value::is_object),
                    "select a nonempty visible batch and filter");
                for row in items {
                    let id = row["itemId"].as_str().filter(|s| !s.is_empty()).context("batch item identity missing")?;
                    anyhow::ensure!(seen.insert(id) && row["kind"].as_str().is_some_and(|s| !s.is_empty())
                        && row["ref"].is_object(), "batch contains duplicate or incomplete identities");
                }
                anyhow::ensure!(self.run_id.is_none() && self.item_ids.is_none() && self.expected.is_none()
                    && self.action_id.is_none() && self.answer.is_none(), "invalid start fields");
            }
            InboxOperation::Stop | InboxOperation::Resume => {
                anyhow::ensure!(run && self.items.is_none() && self.filter.is_none() && self.expected.is_none()
                    && self.action_id.is_none() && self.answer.is_none(), "select an exact saved run");
                if self.operation == InboxOperation::Resume {
                    let ids = self.item_ids.as_ref().context("select retryable items")?;
                    let unique: std::collections::HashSet<_> = ids.iter().collect();
                    anyhow::ensure!(!ids.is_empty() && ids.len() <= 2000 && unique.len() == ids.len()
                        && ids.iter().all(|s| !s.is_empty()), "select distinct retryable items");
                } else { anyhow::ensure!(self.item_ids.is_none(), "Stop does not accept item ids"); }
            }
            InboxOperation::Apply | InboxOperation::Resolve => {
                let item = self.expected.as_ref().context("select a current question")?;
                anyhow::ensure!(item["id"].as_str().is_some_and(|s| !s.is_empty())
                    && item["kind"].as_str().is_some_and(|s| !s.is_empty()) && item["ref"].is_object()
                    && self.action_id.as_deref().is_some_and(|s| !s.is_empty())
                    && self.items.is_none() && self.filter.is_none() && self.item_ids.is_none(), "invalid question action");
                anyhow::ensure!((self.operation == InboxOperation::Apply && run)
                    || (self.operation == InboxOperation::Resolve && self.run_id.is_none()), "invalid recommendation run");
                anyhow::ensure!(self.answer.as_ref().is_none_or(|s| s.len() <= 32 * 1024), "reply is too large");
            }
        }
        Ok(())
    }
    pub fn retryable(row: &Value) -> bool {
        matches!(row["outcome"].as_str(), Some("pending" | "failed")) ||
            (row["outcome"] == "skipped" && (row.get("disposition").is_none()
                || row["disposition"] == "retry_needed"))
    }
    pub fn reviewable(row: &Value) -> bool {
        let disposition = row["recommendation"]["kind"].as_str()
            .filter(|kind| !kind.is_empty()).or_else(|| row["disposition"].as_str());
        row["outcome"] == "recommended" && matches!(disposition, None | Some("recommended"))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GoalAction { Pause, Resume, Start, Reopen, Achieve, Kill }

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GoalRequest {
    pub environment: crate::client::BackendIdentity,
    pub goal_id: String,
    pub action: GoalAction,
    pub expected_status: String,
    pub expected_effective_status: String,
    pub expected_holder_liveness: String,
    pub confirmed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentFocusRequest {
    pub environment: crate::client::BackendIdentity,
    pub adv_session_id: i64,
    pub owner_id: String,
    pub host: String,
    pub window_id: String,
}

impl AgentFocusRequest {
    pub fn target(&self, payload: &Value, local_host: &str) -> Result<Value> {
        anyhow::ensure!(self.adv_session_id > 0 && self.adv_session_id <= 9_007_199_254_740_991
            && !self.owner_id.is_empty() && !local_host.is_empty()
            && self.host.eq_ignore_ascii_case(local_host), "select an exact local agent session");
        anyhow::ensure!(payload["ok"] != false && payload["partial"] != true
            && payload.get("error").is_none_or(Value::is_null), "agent roster is unavailable");
        let rows = payload["rows"].as_array().context("agent roster is unavailable")?;
        anyhow::ensure!(rows.len() == 1, "agent roster is unavailable");
        let roster = &rows[0];
        for field in ["partial", "truncatedByLimit"] {
            anyhow::ensure!(roster[field] != true, "agent roster is incomplete");
        }
        for field in ["errors", "unavailable", "degradedFields"] {
            anyhow::ensure!(roster.get(field).is_none_or(|v| v.is_null() || v == false
                || v == "" || v.as_array().is_some_and(Vec::is_empty)
                || v.as_object().is_some_and(Map::is_empty)), "agent roster is degraded");
        }
        let active = roster["active"].as_array().context("active roster unavailable")?;
        let ended = roster["ended"].as_array().context("ended roster unavailable")?;
        let id = |v: &Value| v["advSessionId"].as_i64().or_else(|| v["id"].as_i64());
        let matches: Vec<_> = active.iter().chain(ended.iter())
            .filter(|row| id(row) == Some(self.adv_session_id)).collect();
        anyhow::ensure!(matches.len() == 1, "selected agent is unavailable or ambiguous");
        let row = matches[0];
        let host = row["host"].as_str().filter(|s| !s.is_empty()).or_else(|| row["hostname"].as_str());
        anyhow::ensure!(active.iter().any(|v| std::ptr::eq(v, row))
            && matches!(row["sessionState"].as_str(), Some("live" | "parked"))
            && row["ownerId"].as_str() == Some(self.owner_id.as_str())
            && host == Some(self.host.as_str()) && row["isLocal"] != false
            && row["revoked"] != true && row["stale"] != true
            && row.get("endedAt").is_none_or(|v| v.is_null() || v == "")
            && row["windowId"].as_str().unwrap_or("") == self.window_id,
            "selected agent changed or its local terminal is unavailable");
        Ok(row.clone())
    }
}

/// The native terminal launcher pins the complete rendezvous across the delay
/// between selecting a result and PUI starting inside the terminal.
pub fn validate_resume_environment(expected: Option<&str>, current: &crate::client::BackendIdentity) -> Result<()> {
    if let Some(expected) = expected {
        let expected: crate::client::BackendIdentity = serde_json::from_str(expected)
            .context("invalid native resume environment")?;
        anyhow::ensure!(expected.same_rendezvous(current), "selected environment changed before session resume");
    }
    Ok(())
}

impl GoalRequest {
    /// Revalidate the displayed selection against the canonical detail before
    /// choosing the same status/activation route used by GoalStatusControl.
    pub fn write(&self, detail: &Value) -> Result<(&'static str, Value, &'static str)> {
        let goal = &detail["goal"];
        anyhow::ensure!(self.confirmed, "confirm the goal action first");
        anyhow::ensure!(!self.goal_id.trim().is_empty() && goal["id"].as_str() == Some(self.goal_id.as_str()),
            "selected goal is unavailable or changed");
        let status = goal["status"].as_str().context("goal status is unavailable")?;
        let effective = detail["effectiveStatus"].as_str().context("goal effective status is unavailable")?;
        let liveness = detail["holderLiveness"].as_str().context("goal holder liveness is unavailable")?;
        anyhow::ensure!(status == self.expected_status && effective == self.expected_effective_status
            && liveness == self.expected_holder_liveness, "selected goal changed; refresh before applying a control");
        anyhow::ensure!(matches!(liveness, "held" | "unheld" | "lost"), "goal holder liveness is unknown");
        let holderless = effective == "dormant" || matches!(liveness, "unheld" | "lost");
        let (start, target, allowed) = match self.action {
            GoalAction::Pause => (false, "paused", status == "active" && !holderless),
            GoalAction::Resume => (false, "active", status == "paused"),
            GoalAction::Start => (true, "active", status == "active" && holderless),
            GoalAction::Reopen => (true, "active", matches!(status, "achieved" | "killed")),
            GoalAction::Achieve => (false, "achieved", matches!(status, "active" | "paused")),
            GoalAction::Kill => (false, "killed", matches!(status, "active" | "paused")),
        };
        anyhow::ensure!(allowed, "goal action is unavailable in the current state");
        Ok(if start {
            ("/api/admin/goals/start-existing", json!({"id":self.goal_id}), target)
        } else {
            ("/api/admin/goals/update", json!({"id":self.goal_id,"status":target}), target)
        })
    }
}

impl AccountRequest {
    // Patch only the selected axis. The existing server owns validation,
    // persistence and Auto's preservation of the independent default.
    pub fn patch(&self, current: &Value, pool: &[Value]) -> Result<Value> {
        if matches!(self.action, AccountAction::Auto) {
            anyhow::ensure!(self.account_id.is_none(), "Auto does not select an account");
            return Ok(json!({"clear":true}));
        }
        let id = self.account_id.as_deref().filter(|id| !id.is_empty())
            .context("select an exact account")?;
        anyhow::ensure!(pool.iter().filter(|row| row["id"].as_str() == Some(id)).count() == 1,
            "selected account is unavailable or ambiguous");
        if matches!(self.action, AccountAction::Default) {
            return Ok(json!({"defaultAccountId": if current["defaultAccountId"].as_str() == Some(id) { Value::Null } else { json!(id) }}));
        }
        let field = if matches!(self.action, AccountAction::Force) { "forcedAccounts" } else { "excludeAccounts" };
        let values = current[field].as_array().context("account steering is unavailable")?;
        anyhow::ensure!(values.iter().all(Value::is_string), "invalid account steering");
        let contains = values.iter().any(|value| value.as_str() == Some(id));
        let mut next: Vec<Value> = values.iter().filter(|value| value.as_str() != Some(id)).cloned().collect();
        if !contains { next.push(json!(id)); }
        Ok(json!({field:next}))
    }
}

pub async fn run() -> Result<()> {
    let result = async {
        let request = read_request(std::io::stdin().lock())?;
        let client = crate::client::OperatorClient::from_discovery().await?;
        client.native_panel_read(&request).await
    };
    let result = match tokio::time::timeout(Duration::from_secs(20), result).await {
        Ok(result) => result,
        Err(_) => Err(anyhow::anyhow!("native-read operator request timed out")),
    };
    match result {
        Ok(payload) => {
            println!("{}", serde_json::to_string(&payload)?);
            Ok(())
        }
        Err(error) => {
            println!("{}", json!({"ok":false,"error":format!("{error:#}")}));
            Err(error)
        }
    }
}

pub async fn run_account() -> Result<()> {
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let request: AccountRequest = bounded_request(std::io::stdin().lock())?;
        let client = crate::client::OperatorClient::from_discovery().await?;
        client.native_account_action(&request).await
    }).await.context("native account action timed out; refresh to verify server state")?;
    match result {
        Ok(payload) => { println!("{}", payload); Ok(()) }
        Err(error) => { println!("{}", json!({"ok":false,"error":format!("{error:#}")})); Err(error) }
    }
}

pub async fn run_goal() -> Result<()> {
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let request: GoalRequest = bounded_request(std::io::stdin().lock())?;
        let client = crate::client::OperatorClient::from_discovery().await?;
        client.native_goal_action(&request).await
    }).await.context("native goal action timed out; refresh to verify server state")?;
    match result {
        Ok(payload) => { println!("{}", payload); Ok(()) }
        Err(error) => { println!("{}", json!({"ok":false,"error":format!("{error:#}")})); Err(error) }
    }
}

pub async fn run_inbox() -> Result<()> {
    let result = tokio::time::timeout(Duration::from_secs(60), async {
        let request: InboxRequest = bounded_request(std::io::stdin().lock())?;
        request.validate()?;
        let client = crate::client::OperatorClient::from_discovery().await?;
        client.native_inbox_action(&request).await
    }).await.context("Inbox action timed out; refresh to verify server state before retrying")?;
    match result {
        Ok(payload) => { println!("{}", payload); Ok(()) }
        Err(error) => { println!("{}", json!({"ok":false,"error":format!("{error:#}")})); Err(error) }
    }
}

pub async fn run_agent_focus() -> Result<()> {
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let request: AgentFocusRequest = bounded_request(std::io::stdin().lock())?;
        let client = crate::client::OperatorClient::from_discovery().await?;
        client.native_agent_focus(&request).await
    }).await.context("native agent focus timed out; focus was not verified")?;
    match result {
        Ok(payload) => { println!("{}", payload); Ok(()) }
        Err(error) => { println!("{}", json!({"ok":false,"error":format!("{error:#}")})); Err(error) }
    }
}

/// Newline JSON carries canonical SSE frames without buffering the full reply.
/// Closing this pipe never claims to cancel a durable server-side turn.
pub async fn run_chat() -> Result<()> {
    tokio::time::timeout(Duration::from_secs(610), async {
        let request: ChatRequest = bounded_request(std::io::stdin().lock())?;
        let client = crate::client::OperatorClient::from_discovery().await?;
        let (environment, body, saved) = client.native_chat_prepare(&request).await?;
        let emit = |event: &str, data: Value| -> Result<()> {
            let mut out = std::io::stdout().lock();
            writeln!(out, "{}", json!({"environment":environment,"event":event,"data":data}))?;
            out.flush()?; Ok(())
        };
        if let Some(saved) = saved { emit("user-saved", saved)?; }
        if request.operation == ChatOperation::Cancel {
            emit("cancelled", client.native_chat_cancel(body).await?)?;
            return Ok(());
        }
        let mut stream = client.subscribe_converse(body).await?;
        while let Some(frame) = stream.recv().await {
            if frame.event == "heartbeat" { continue; }
            let data: Value = serde_json::from_str(&frame.data).context("invalid canonical chat frame")?;
            let terminal = matches!(frame.event.as_str(), "done" | "error");
            emit(&frame.event, data)?;
            if terminal { return Ok(()); }
        }
        anyhow::bail!("reply stream disconnected; recover the saved reply before sending again")
    }).await.context("native chat deadline; reconcile the saved reply")?
}

pub async fn run_cards() -> Result<()> {
    let request: CardsRequest = bounded_request(std::io::stdin().lock())?;
    request.validate()?;
    let limit = if request.operation == CardsOperation::Respond { 20 } else { 610 };
    tokio::time::timeout(Duration::from_secs(limit), async {
        let client = crate::client::OperatorClient::from_discovery().await?;
        if request.operation == CardsOperation::Respond {
            println!("{}", client.native_cards_respond(&request).await?);
            return Ok(());
        }
        let environment = client.native_conversation(&request.environment, &request.conversation_id).await?;
        let mut stream = client.subscribe_state_snapshot().await?;
        while let Some(frame) = stream.recv().await {
            if !matches!(frame.event.as_str(), "reset" | "snapshot") { continue; }
            let data: Value = serde_json::from_str(&frame.data).context("invalid card stream frame")?;
            anyhow::ensure!(environment.same_rendezvous(&client.backend_identity().await?), "selected card environment changed");
            let data = if frame.event == "snapshot" { request.snapshot(&data)? } else {
                anyhow::ensure!(data["workspaceId"] == environment.workspace_id, "card reset scope changed"); data
            };
            let mut out = std::io::stdout().lock();
            writeln!(out, "{}", json!({"environment":environment,"event":frame.event,"data":data}))?;
            out.flush()?;
        }
        anyhow::bail!("card connection ended; reconnect before answering")
    }).await.context("native card connection deadline; reconnect before answering")?
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_inbox_reads_reuse_canonical_models_and_literal_coordinates() {
        use super::*;
        for name in ["plans.attention", "plans.attentionItem", "plans.attentionBulkRun"] {
            let args = json!({"id":"literal +/=& λ", "runId":"saved +/=& λ"});
            let request = read_request(json!({"name":name,"args":args}).to_string().as_bytes()).unwrap();
            assert_eq!(request.name.as_str(), name);
            assert_eq!(Value::Object(request.args), args);
        }
        assert!(read_request(br#"{"name":"plans.attentionBulkRun.write"}"#.as_slice()).is_err());
    }

    #[test]
    fn native_inbox_start_preserves_literal_snapshot_and_rejects_ambiguous_batches() {
        let base = json!({"environment":{"schemaVersion":1,"endpoint":"http://selected","selectionSource":"test",
            "transport":"http","workspaceId":"w","store":{"id":"s","target":"test","source":"test"},
            "build":{"version":"test","sha":null},"agentChat":{"scope":"workspace:w","route":"test"},"capabilities":{}},
            "operation":"start","confirmed":true,"items":[{"itemId":"literal +/=& λ","kind":"coord-message",
                "title":"Question","ref":{"kind":"coord-message","msgId":"exact +/=& λ"},"ownerAgentId":"asker"}],
            "filter":{"query":"λ","shownCount":1}});
        let parse = |value: Value| serde_json::from_value::<InboxRequest>(value);
        let request = parse(base.clone()).unwrap(); request.validate().unwrap();
        assert_eq!(request.items.unwrap()[0]["ref"]["msgId"], "exact +/=& λ");
        for field in ["duplicate", "empty", "missing-ref", "unconfirmed", "mixed-op"] {
            let mut bad = base.clone();
            match field {
                "duplicate" => bad["items"].as_array_mut().unwrap().push(base["items"][0].clone()),
                "empty" => bad["items"] = json!([]),
                "missing-ref" => bad["items"][0]["ref"] = Value::Null,
                "unconfirmed" => bad["confirmed"] = json!(false),
                _ => bad["runId"] = json!("different run"),
            }
            assert!(parse(bad).unwrap().validate().is_err(), "accepted {field}");
        }
        let mut unknown = base; unknown["command"] = json!("arbitrary");
        assert!(parse(unknown).is_err());
    }

    #[test]
    fn native_inbox_continuation_and_review_keep_owner_decisions_out_of_automation() {
        for outcome in ["pending", "failed"] {
            assert!(InboxRequest::retryable(&json!({"outcome":outcome})));
        }
        assert!(InboxRequest::retryable(&json!({"outcome":"skipped"})));
        assert!(InboxRequest::retryable(&json!({"outcome":"skipped","disposition":"retry_needed"})));
        for disposition in ["owner_action", "cleanup_candidate", "routed", "investigate", "legacy_skipped"] {
            assert!(!InboxRequest::retryable(&json!({"outcome":"skipped","disposition":disposition})));
            assert!(!InboxRequest::reviewable(&json!({"outcome":"recommended","disposition":disposition})));
            assert!(!InboxRequest::reviewable(&json!({"outcome":"recommended","disposition":"recommended",
                "recommendation":{"kind":disposition}})));
        }
        for outcome in ["auto_resolved", "dismissed", "recommended"] {
            assert!(!InboxRequest::retryable(&json!({"outcome":outcome})));
        }
        assert!(InboxRequest::reviewable(&json!({"outcome":"recommended","disposition":"recommended"})));
    }
    #[test]
    fn native_voice_validates_audio_identity_and_operation_before_transport() {
        use super::*;
        use base64::Engine as _;
        let mut wav = std::io::Cursor::new(Vec::new());
        let mut writer = hound::WavWriter::new(&mut wav, hound::WavSpec { channels: 1, sample_rate: 16_000,
            bits_per_sample: 16, sample_format: hound::SampleFormat::Int }).unwrap();
        writer.write_sample(12i16).unwrap(); writer.finalize().unwrap();
        let environment = json!({"schemaVersion":1,"endpoint":"http://selected:3170","selectionSource":"test","transport":"http",
            "workspaceId":"selected","store":{"id":"store","target":"test","source":"test"},
            "build":{"version":"test","sha":null},"agentChat":{"scope":"workspace:selected","route":"test"},"capabilities":{}});
        let base = json!({"environment":environment,"conversationId":"c88bf103-8399-42ee-93ae-19e73114e3fd",
            "requestId":"15138297-1c15-4a94-8d70-e6bfdb15ae01","operation":"transcribe",
            "audioBase64":base64::engine::general_purpose::STANDARD.encode(wav.get_ref())});
        assert_eq!(serde_json::from_value::<VoiceRequest>(base.clone()).unwrap().audio().unwrap(), Some(wav.into_inner()));
        for (key, value) in [("requestId", json!("latest")), ("conversationId", json!("active")),
            ("audioBase64", json!("not base64")), ("audioBase64", json!("UklGRg==")), ("text", json!("injected"))] {
            let mut bad = base.clone(); bad[key] = value;
            assert!(serde_json::from_value::<VoiceRequest>(bad).unwrap().audio().is_err(), "accepted {key}");
        }
        let mut speak = base; speak["operation"] = json!("speak"); speak["text"] = json!("literal ' $() λ");
        assert!(serde_json::from_value::<VoiceRequest>(speak.clone()).unwrap().audio().is_err());
        speak.as_object_mut().unwrap().remove("audioBase64");
        assert!(serde_json::from_value::<VoiceRequest>(speak.clone()).unwrap().audio().unwrap().is_none());
        speak["text"] = json!(" "); assert!(serde_json::from_value::<VoiceRequest>(speak).unwrap().audio().is_err());
    }
    #[test]
    fn native_cards_enforce_scope_and_preserve_empty_run_removals() {
        use super::*;
        let environment = json!({"schemaVersion":1,"endpoint":"http://selected:3170","selectionSource":"test","transport":"http",
            "workspaceId":"selected","store":{"id":"store","target":"test","source":"test"},
            "build":{"version":"test","sha":null},"agentChat":{"scope":"workspace:selected","route":"test"},"capabilities":{}});
        let base = json!({"environment":environment,"conversationId":"c88bf103-8399-42ee-93ae-19e73114e3fd","operation":"subscribe"});
        let request: CardsRequest = serde_json::from_value(base.clone()).unwrap(); request.validate().unwrap();
        let own = json!({"correlationId":"own","conversationId":request.conversation_id});
        let snapshot = json!({"workspaceId":"selected","runId":"run","version":1,"snapshot":{"openCards":[
            own,{"correlationId":"foreign","conversationId":"other"},{"correlationId":"unbound"}]}});
        assert_eq!(request.snapshot(&snapshot).unwrap()["snapshot"]["openCards"], json!([own]));
        let mut empty = snapshot.clone(); empty["snapshot"]["openCards"] = json!([]);
        assert_eq!(request.snapshot(&empty).unwrap()["snapshot"]["openCards"], json!([]));
        for (key, value) in [("workspaceId",json!("foreign")),("runId",json!("")),("version",json!(-1))] {
            let mut bad = snapshot.clone(); bad[key] = value; assert!(request.snapshot(&bad).is_err());
        }
        for (key, value) in [("conversationId",json!("current")),("action",json!("submit")),("payload",json!({}))] {
            let mut bad = base.clone(); bad[key] = value;
            assert!(serde_json::from_value::<CardsRequest>(bad).unwrap().validate().is_err());
        }
        let mut response = base; response["operation"] = json!("respond");
        response["correlationId"] = json!("card-1"); response["action"] = json!("submit"); response["payload"] = json!({"picks":["yes"]});
        serde_json::from_value::<CardsRequest>(response.clone()).unwrap().validate().unwrap();
        response["action"] = json!("decline");
        assert!(serde_json::from_value::<CardsRequest>(response).unwrap().validate().is_err());
    }
    #[test]
    fn native_chat_rejects_unscoped_and_ambiguous_operations() {
        use super::*;
        let base = json!({"environment":{"schemaVersion":1,"endpoint":"http://selected:3170","selectionSource":"test","transport":"http",
            "workspaceId":"selected","store":{"id":"store","target":"test","source":"test"},
            "build":{"version":"test","sha":null},"agentChat":{"scope":"workspace:selected","route":"test"},"capabilities":{}},
            "conversationId":"c88bf103-8399-42ee-93ae-19e73114e3fd","operation":"send","text":"literal ' $() λ",
            "userTurnId":"15138297-1c15-4a94-8d70-e6bfdb15ae01"});
        assert!(serde_json::from_value::<ChatRequest>(base.clone()).unwrap().validate().is_ok());
        let mut voice = base.clone(); voice["modality"] = json!("voice");
        assert!(serde_json::from_value::<ChatRequest>(voice.clone()).unwrap().validate().is_ok());
        voice["modality"] = json!("external");
        assert!(serde_json::from_value::<ChatRequest>(voice).unwrap().validate().is_err());
        for (key, value) in [("conversationId", json!("active")), ("text", json!("  ")),
            ("userTurnId", json!("invalid")), ("turnId", json!("15138297-1c15-4a94-8d70-e6bfdb15ae01"))] {
            let mut bad = base.clone(); bad[key] = value;
            assert!(serde_json::from_value::<ChatRequest>(bad).unwrap().validate().is_err(), "accepted {key}");
        }
        let mut injected = base.clone(); injected["messages"] = json!([]);
        assert!(serde_json::from_value::<ChatRequest>(injected).is_err());
        let mut replay = base; replay.as_object_mut().unwrap().remove("text"); replay.as_object_mut().unwrap().remove("userTurnId");
        replay["operation"] = json!("reconnect"); replay["turnId"] = json!("15138297-1c15-4a94-8d70-e6bfdb15ae01");
        replay["afterSequence"] = json!(7);
        let request: ChatRequest = serde_json::from_value(replay.clone()).unwrap();
        request.validate().unwrap(); assert_eq!(request.control_body()["afterSequence"], 7);
        replay["operation"] = json!("cancel");
        assert!(serde_json::from_value::<ChatRequest>(replay).unwrap().validate().is_err());
    }
    use super::*;

    #[test]
    fn native_agent_focus_rejects_changed_remote_partial_and_duplicate_targets() {
        let environment = json!({"schemaVersion":1,"endpoint":"http://selected:3170","selectionSource":"test","transport":"http",
            "workspaceId":"selected","store":{"id":"store","target":"test","source":"test"},
            "build":{"version":"test","sha":null},"agentChat":{"scope":"workspace:selected","route":"test"},"capabilities":{}});
        let request: AgentFocusRequest = serde_json::from_value(json!({"environment":environment,"advSessionId":41,
            "ownerId":"exact","host":"mac","windowId":"macos:exact"})).unwrap();
        let row = json!({"advSessionId":41,"ownerId":"exact","host":"mac","windowId":"macos:exact","sessionState":"live"});
        let payload = json!({"rows":[{"active":[row],"ended":[]}]});
        assert_eq!(request.target(&payload, "MAC").unwrap(), row);
        assert!(request.target(&payload, "other").is_err());
        for (field, value) in [("ownerId",json!("replacement")), ("host",json!("other")),
            ("windowId",json!("macos:other")), ("sessionState",json!("ended")),
            ("revoked",json!(true)), ("stale",json!(true)), ("isLocal",json!(false)), ("endedAt",json!("now"))] {
            let mut bad = payload.clone(); bad["rows"][0]["active"][0][field] = value;
            assert!(request.target(&bad, "mac").is_err(), "accepted {field}");
        }
        let mut bad = payload.clone(); bad["rows"][0]["ended"] = json!([row]);
        assert!(request.target(&bad, "mac").is_err());
        for field in ["partial", "truncatedByLimit", "errors", "unavailable", "degradedFields"] {
            let mut bad = payload.clone(); bad["rows"][0][field] = json!(true);
            assert!(request.target(&bad, "mac").is_err(), "accepted {field}");
        }
        let current: crate::client::BackendIdentity = serde_json::from_value(environment.clone()).unwrap();
        assert!(validate_resume_environment(Some(&environment.to_string()), &current).is_ok());
        for field in ["endpoint", "workspaceId", "store", "agentChat"] {
            let mut changed = environment.clone(); changed[field] = match field {
                "store" => json!({"id":"other","target":"test","source":"test"}),
                "agentChat" => json!({"scope":"other","route":"test"}), _ => json!("other"),
            };
            assert!(validate_resume_environment(Some(&changed.to_string()), &current).is_err());
        }
        assert!(validate_resume_environment(Some("malformed"), &current).is_err());
    }

    #[test]
    fn native_goal_controls_validate_fresh_selection_confirmation_and_route() {
        let environment = json!({"schemaVersion":1,"endpoint":"http://selected:3170","selectionSource":"test","transport":"http",
            "workspaceId":"selected","store":{"id":"store","target":"test","source":"test"},
            "build":{"version":"test","sha":null},"agentChat":{"scope":"workspace:selected","route":"test"},"capabilities":{}});
        for (action, status, effective, holder, route, target) in [
            ("pause", "active", "active", "held", "update", "paused"),
            ("resume", "paused", "paused", "unheld", "update", "active"),
            ("start", "active", "dormant", "lost", "start-existing", "active"),
            ("reopen", "achieved", "achieved", "unheld", "start-existing", "active"),
            ("reopen", "killed", "killed", "unheld", "start-existing", "active"),
            ("achieve", "paused", "paused", "unheld", "update", "achieved"),
            ("kill", "active", "active", "held", "update", "killed"),
        ] {
            let value = json!({"environment":environment,"goalId":"literal +/=& λ","action":action,
                "expectedStatus":status,"expectedEffectiveStatus":effective,"expectedHolderLiveness":holder,"confirmed":true});
            let request: GoalRequest = serde_json::from_value(value.clone()).unwrap();
            let detail = json!({"goal":{"id":"literal +/=& λ","status":status},"effectiveStatus":effective,"holderLiveness":holder});
            let (path, body, next) = request.write(&detail).unwrap();
            assert_eq!(path, format!("/api/admin/goals/{route}"));
            assert_eq!(body["id"], "literal +/=& λ"); assert_eq!(next, target);
            assert_eq!(body, if route == "update" { json!({"id":"literal +/=& λ","status":target}) }
                else { json!({"id":"literal +/=& λ"}) });
            for field in ["goal", "effectiveStatus", "holderLiveness"] {
                let mut changed = detail.clone(); changed[field] = Value::Null;
                assert!(request.write(&changed).is_err(), "accepted changed {field}");
            }
            let mut unconfirmed = value; unconfirmed["confirmed"] = json!(false);
            assert!(serde_json::from_value::<GoalRequest>(unconfirmed).unwrap().write(&detail).is_err());
        }
        for (action, status, effective, holder) in [
            ("pause","active","dormant","lost"), ("resume","active","active","held"),
            ("start","active","active","held"), ("reopen","paused","paused","unheld"),
            ("kill","killed","killed","unheld"), ("pause","active","active","unknown"),
        ] {
            let request: GoalRequest = serde_json::from_value(json!({"environment":environment,"goalId":"same","action":action,
                "expectedStatus":status,"expectedEffectiveStatus":effective,"expectedHolderLiveness":holder,"confirmed":true})).unwrap();
            assert!(request.write(&json!({"goal":{"id":"same","status":status},"effectiveStatus":effective,"holderLiveness":holder})).is_err());
        }
    }

    #[test]
    fn native_account_controls_patch_only_one_axis_and_preserve_exact_identity() {
        let environment = json!({"schemaVersion":1,"endpoint":"http://selected:3170","selectionSource":"test","transport":"http",
            "workspaceId":"selected","store":{"id":"store","target":"test","source":"test"},
            "build":{"version":"test","sha":null},"agentChat":{"scope":"workspace:selected","route":"test"},"capabilities":{}});
        let prior = json!({"forcedAccounts":["one"],"excludeAccounts":["other"],"defaultAccountId":"default"});
        let pool = vec![json!({"id":"one"}), json!({"id":"other"}), json!({"id":"literal +/=& λ"})];
        for (action, id, expected) in [
            ("default", Some("one"), json!({"defaultAccountId":"one"})),
            ("force", Some("one"), json!({"forcedAccounts":[]})),
            ("exclude", Some("literal +/=& λ"), json!({"excludeAccounts":["other","literal +/=& λ"]})),
            ("auto", None, json!({"clear":true})),
        ] {
            let request: AccountRequest = serde_json::from_value(json!({"environment":environment,"action":action,"accountId":id})).unwrap();
            assert_eq!(request.patch(&prior, &pool).unwrap(), expected);
        }
        let request: AccountRequest = serde_json::from_value(json!({"environment":environment,"action":"default","accountId":"default"})).unwrap();
        assert_eq!(request.patch(&prior, &[json!({"id":"default"})]).unwrap(), json!({"defaultAccountId":null}));
        assert!(request.patch(&prior, &pool).is_err());
        assert!(request.patch(&prior, &[json!({"id":"default"}),json!({"id":"default"})]).is_err());
        for value in [json!({"action":"force","accountId":"one"}),
            json!({"environment":environment,"action":"shell","accountId":"one"}),
            json!({"environment":environment,"action":"force","accountId":"one","path":"/arbitrary"})] {
            assert!(serde_json::from_value::<AccountRequest>(value).is_err());
        }
    }

    #[test]
    fn native_panel_read_rejects_tools_mutations_and_unstructured_input() {
        for input in [
            r#"{"name":"goals.pause","args":{}}"#,
            r#"{"name":"sys:http","args":{}}"#,
            r#"{"name":"plans.list","args":[],"method":"POST"}"#,
            r#"{"name":"plans.list","args":{}} {"name":"reports.list"}"#,
            r#"{"name":"plans.list","args":null}"#,
            "",
        ] {
            assert!(read_request(input.as_bytes()).is_err(), "accepted {input}");
        }
    }

    #[test]
    fn native_panel_read_bounds_input_without_losing_exact_scope() {
        let query = br#"{"name":"reports.get","args":{"reportId":"r+/=& exact","harness":"same","workspaceId":"private"}}"#;
        let request = read_request(query.as_slice()).unwrap();
        assert_eq!(request.name.as_str(), "reports.get");
        assert_eq!(request.args["reportId"], "r+/=& exact");
        assert_eq!(request.args["workspaceId"], "private");
        for (name, args) in [
            ("operatorConversations.current", json!({"workspaceId":"selected"})),
            ("operatorTurns.page", json!({"conversationId":"literal +/=& λ","beforeSeq":17,"limit":200})),
        ] {
            let input = json!({"name":name,"args":args}).to_string();
            let request = read_request(input.as_bytes()).unwrap();
            assert_eq!(request.name.as_str(), name);
            assert_eq!(Value::Object(request.args), args);
        }
        assert!(
            read_request(vec![b' '; MAX_REQUEST_BYTES as usize + 1].as_slice())
                .unwrap_err()
                .to_string()
                .contains("64 KiB")
        );
    }
}
