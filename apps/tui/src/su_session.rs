//! Typed client-side contract for the shared Papercusp SU-session host.
//!
//! The TUI deliberately consumes the backend-neutral `papercusp.su-session/v1`
//! wire contract instead of scraping provider terminals or inventing a second
//! conversation engine.  Identity, lifecycle, transcript, tool, card, and
//! refusal events are retained as typed values so the reducer can render the
//! same pane for Claude, Codex, and OMP.

use crate::models::NativeSessionHandle;
use crate::sse::SseFrame;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

pub const SU_SESSION_SCHEMA: &str = "papercusp.su-session/v1";
pub const SU_SESSION_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SuSessionBackend {
    Claude,
    Codex,
    Omp,
}

impl SuSessionBackend {
    pub const ALL: [Self; 3] = [Self::Claude, Self::Codex, Self::Omp];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Omp => "omp",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Omp => "OMP",
        }
    }
}

impl std::fmt::Display for SuSessionBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SuSessionLifecycleState {
    #[default]
    Starting,
    Ready,
    Running,
    #[serde(rename = "waiting-for-owner")]
    WaitingForOwner,
    Interrupted,
    Compacting,
    Resuming,
    Ended,
    Failed,
}

/// How a PUI process reconciled a durable SU session with the runtime it found
/// after startup or reconnect.  This is intentionally separate from the
/// backend lifecycle: `ended` is a provider/runtime state while
/// `ended-archived` tells the owner why the session remains selectable in the
/// PUI session picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SuSessionReconciliation {
    Pending,
    Attached,
    RuntimeReplaced,
    EndedArchived,
    FailedOrphaned,
}

impl SuSessionReconciliation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Attached => "attached",
            Self::RuntimeReplaced => "runtime-replaced",
            Self::EndedArchived => "ended-archived",
            Self::FailedOrphaned => "failed-orphaned",
        }
    }
}

impl std::fmt::Display for SuSessionReconciliation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl SuSessionLifecycleState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Running => "running",
            Self::WaitingForOwner => "waiting-for-owner",
            Self::Interrupted => "interrupted",
            Self::Compacting => "compacting",
            Self::Resuming => "resuming",
            Self::Ended => "ended",
            Self::Failed => "failed",
        }
    }
}

impl std::fmt::Display for SuSessionLifecycleState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuSessionIdentity {
    pub agent_chat_id: String,
    pub adv_session_id: i64,
    pub backend: SuSessionBackend,
    pub native_session_id: String,
    pub owner_id: String,
    pub workspace_id: String,
    pub harness_slug: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "backend", rename_all = "camelCase")]
pub enum SuSessionBackendExtension {
    Claude {
        #[serde(default)]
        #[serde(rename = "configDir")]
        config_dir: Option<String>,
        #[serde(default)]
        #[serde(rename = "configDirSource")]
        config_dir_source: Option<String>,
    },
    Codex {
        #[serde(default)]
        #[serde(rename = "codexHome")]
        codex_home: Option<String>,
    },
    Omp {
        #[serde(default)]
        #[serde(rename = "agentHome")]
        agent_home: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuSessionCapabilitySupport {
    pub state: String,
    #[serde(default)]
    pub implementation: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SuSessionCapabilities {
    #[serde(default)]
    pub commands: std::collections::BTreeMap<String, SuSessionCapabilitySupport>,
    #[serde(default)]
    pub features: std::collections::BTreeMap<String, SuSessionCapabilitySupport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuSessionDescriptor {
    pub identity: SuSessionIdentity,
    pub lifecycle: SuSessionLifecycleState,
    pub runtime_generation: u64,
    pub role: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub account_route: Option<String>,
    pub carry: String,
    #[serde(default)]
    pub modes: Vec<String>,
    pub capabilities: SuSessionCapabilities,
    pub backend_extension: SuSessionBackendExtension,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuSessionSnapshot {
    #[serde(default)]
    pub ok: bool,
    pub descriptor: SuSessionDescriptor,
    pub floor_sequence: u64,
    pub last_sequence: u64,
    pub terminal: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SuSessionCreateRequest {
    pub agent: SuSessionBackend,
    pub harness_slug: Option<String>,
    pub plan_slug: Option<String>,
    pub carry: String,
    pub defer_spawn: bool,
    pub agent_chat_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SuSessionAttachRequest {
    pub agent: SuSessionBackend,
    pub attach_adv_session_id: i64,
    pub harness_slug: Option<String>,
    pub plan_slug: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SuSessionOpenRequest {
    Create(SuSessionCreateRequest),
    Attach(SuSessionAttachRequest),
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuSessionBinding {
    pub operation: String,
    pub backend: SuSessionBackend,
    pub adv_session_id: i64,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub harness_slug: Option<String>,
    #[serde(default)]
    pub plan_slug: Option<String>,
    #[serde(default)]
    pub native_session: Option<NativeSessionHandle>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SuSessionState {
    pub binding: SuSessionBinding,
    pub identity: Option<SuSessionIdentity>,
    pub descriptor: Option<SuSessionDescriptor>,
    pub lifecycle: SuSessionLifecycleState,
    pub last_sequence: u64,
    pub stale: bool,
    pub error: Option<String>,
    /// Startup/reconnect outcome surfaced beside the lifecycle in the PUI.
    pub reconciliation: SuSessionReconciliation,
}

impl SuSessionState {
    pub fn from_binding(binding: SuSessionBinding) -> Self {
        Self {
            lifecycle: SuSessionLifecycleState::Starting,
            binding,
            identity: None,
            descriptor: None,
            last_sequence: 0,
            stale: false,
            error: None,
            reconciliation: SuSessionReconciliation::Pending,
        }
    }

    pub fn selection_label(&self) -> String {
        let identity = self.identity.as_ref();
        let backend = identity
            .map(|i| i.backend.as_str())
            .unwrap_or_else(|| self.binding.backend.as_str());
        let adv = identity
            .map(|i| i.adv_session_id)
            .unwrap_or(self.binding.adv_session_id);
        let chat = identity.map(|i| i.agent_chat_id.as_str()).unwrap_or("");
        let short_chat: String = chat.chars().take(12).collect();
        format!(
            "SU · {backend} · adv {adv} · chat {short_chat} · {}",
            self.lifecycle
        )
    }
}

/// A bounded inventory row used by the session picker.  Inventory is derived
/// from the canonical per-chat SU-session snapshot; ended rows remain present
/// so their transcript can be inspected after the runtime is gone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuSessionInventoryEntry {
    pub agent_chat_id: String,
    pub adv_session_id: i64,
    pub backend: SuSessionBackend,
    pub lifecycle: SuSessionLifecycleState,
    pub runtime_generation: u64,
    pub native_session_id: String,
    pub terminal: bool,
    pub reconciliation: SuSessionReconciliation,
}

impl SuSessionInventoryEntry {
    pub fn from_snapshot(snapshot: &SuSessionSnapshot) -> Self {
        let lifecycle = snapshot.descriptor.lifecycle;
        let reconciliation = if lifecycle == SuSessionLifecycleState::Failed {
            SuSessionReconciliation::FailedOrphaned
        } else if lifecycle == SuSessionLifecycleState::Ended || snapshot.terminal {
            SuSessionReconciliation::EndedArchived
        } else {
            SuSessionReconciliation::Attached
        };
        Self {
            agent_chat_id: snapshot.descriptor.identity.agent_chat_id.clone(),
            adv_session_id: snapshot.descriptor.identity.adv_session_id,
            backend: snapshot.descriptor.identity.backend,
            lifecycle,
            runtime_generation: snapshot.descriptor.runtime_generation,
            native_session_id: snapshot.descriptor.identity.native_session_id.clone(),
            terminal: snapshot.terminal,
            reconciliation,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuSessionRefusal {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// Owner-facing controls exposed by P-009.  The common command envelope is
/// built here so every control targets the exact durable identity selected by
/// the reducer; callers cannot accidentally substitute a chat id or provider
/// default from another session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SuSessionControl {
    Interrupt { reason: Option<String> },
    Resume { cause: String },
    Fork { from_sequence: Option<u64> },
    Focus,
    End { reason: Option<String> },
}

impl SuSessionControl {
    pub fn command_type(&self) -> &'static str {
        match self {
            Self::Interrupt { .. } => "interrupt",
            Self::Resume { .. } => "resume",
            Self::Fork { .. } => "fork",
            Self::Focus => "focus",
            Self::End { .. } => "end",
        }
    }

    pub fn command_json(
        &self,
        identity: &SuSessionIdentity,
        command_id: &str,
        issued_at: &str,
    ) -> Value {
        let mut body = serde_json::json!({
            "schema": SU_SESSION_SCHEMA,
            "protocolVersion": SU_SESSION_PROTOCOL_VERSION,
            "type": self.command_type(),
            "commandId": command_id,
            "issuedAt": issued_at,
            "target": identity,
        });
        match self {
            Self::Interrupt { reason } | Self::End { reason } => {
                if let Some(reason) = reason {
                    body["reason"] = Value::String(reason.clone());
                }
            }
            Self::Resume { cause } => body["cause"] = Value::String(cause.clone()),
            Self::Fork { from_sequence } => {
                if let Some(sequence) = from_sequence {
                    body["fromSequence"] = serde_json::json!(sequence);
                }
            }
            Self::Focus => {}
        }
        body
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuSessionEventEnvelope {
    pub schema: String,
    pub protocol_version: u32,
    pub event_id: String,
    pub sequence: u64,
    pub at: String,
    pub session: SuSessionIdentity,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SuSessionEvent {
    Session {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        // Boxed to keep the enum small: an inline descriptor made this variant
        // ~592 bytes against a ~385-byte next-largest, so every SuSessionEvent
        // (including the far more frequent Lifecycle/Tool ones) paid that cost.
        descriptor: Box<SuSessionDescriptor>,
    },
    Lifecycle {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        #[serde(rename = "previousState")]
        previous_state: Option<SuSessionLifecycleState>,
        state: SuSessionLifecycleState,
        #[serde(rename = "runtimeGeneration")]
        runtime_generation: u64,
        #[serde(default)]
        reason: Option<String>,
    },
    CommandResult {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "commandType")]
        command_type: String,
        status: String,
        #[serde(default)]
        refusal: Option<SuSessionRefusal>,
    },
    Transcript {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        phase: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        role: String,
        channel: String,
        #[serde(default)]
        content: Option<String>,
    },
    Tool {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        phase: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        #[serde(default)]
        input: Option<Value>,
        #[serde(default)]
        output: Option<Value>,
        #[serde(default)]
        #[serde(rename = "isError")]
        is_error: bool,
    },
    Card {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        phase: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        #[serde(default)]
        card: Option<Value>,
        #[serde(default)]
        #[serde(rename = "correlationId")]
        correlation_id: Option<String>,
        #[serde(default)]
        resolution: Option<String>,
    },
    Backend {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        extension: SuSessionBackendExtension,
    },
    Error {
        #[serde(flatten)]
        envelope: SuSessionEventEnvelope,
        scope: String,
        code: String,
        message: String,
        recoverable: bool,
        #[serde(default)]
        #[serde(rename = "commandId")]
        command_id: Option<String>,
        #[serde(default)]
        details: Option<Value>,
    },
}

impl SuSessionEvent {
    pub fn envelope(&self) -> &SuSessionEventEnvelope {
        match self {
            Self::Session { envelope, .. }
            | Self::Lifecycle { envelope, .. }
            | Self::CommandResult { envelope, .. }
            | Self::Transcript { envelope, .. }
            | Self::Tool { envelope, .. }
            | Self::Card { envelope, .. }
            | Self::Backend { envelope, .. }
            | Self::Error { envelope, .. } => envelope,
        }
    }
}

/// Decode one `session_event` SSE frame.  A mismatched schema/protocol is a
/// visible error; silently accepting it would make a restarted PUI render a
/// different contract as though it were the same durable session.
pub fn decode_su_session_event(frame: &SseFrame) -> Result<SuSessionEvent> {
    if frame.event != "session_event" && frame.event != "message" {
        bail!("unsupported SU-session SSE event `{}`", frame.event);
    }
    let event: SuSessionEvent =
        serde_json::from_str(&frame.data).with_context(|| "decode SU-session SSE payload")?;
    let envelope = event.envelope();
    if envelope.schema != SU_SESSION_SCHEMA {
        return Err(anyhow!(
            "unsupported SU-session schema `{}` (expected `{SU_SESSION_SCHEMA}`)",
            envelope.schema
        ));
    }
    if envelope.protocol_version != SU_SESSION_PROTOCOL_VERSION {
        return Err(anyhow!(
            "unsupported SU-session protocol {} (expected {})",
            envelope.protocol_version,
            SU_SESSION_PROTOCOL_VERSION
        ));
    }
    Ok(event)
}

pub type SuSessionEventStream = mpsc::UnboundedReceiver<Result<SuSessionEvent>>;

pub fn decode_su_session_stream(
    mut frames: mpsc::UnboundedReceiver<SseFrame>,
) -> SuSessionEventStream {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(frame) = frames.recv().await {
            if tx.send(decode_su_session_event(&frame)).is_err() {
                return;
            }
        }
        let _ = tx.send(Err(anyhow!("SU-session SSE stream closed")));
    });
    rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope(kind: &str, extra: Value) -> SseFrame {
        let mut value = json!({
            "type": kind,
            "schema": SU_SESSION_SCHEMA,
            "protocolVersion": 1,
            "eventId": "chat-1:1",
            "sequence": 1,
            "at": "2026-08-28T00:00:00Z",
            "session": {
                "agentChatId": "chat-1", "advSessionId": 7, "backend": "claude",
                "nativeSessionId": "native-1", "ownerId": "su-1", "workspaceId": "ws-1",
                "harnessSlug": "papercup"
            }
        });
        if let (Some(dst), Some(src)) = (value.as_object_mut(), extra.as_object()) {
            dst.extend(src.clone());
        }
        SseFrame {
            event: "session_event".into(),
            data: value.to_string(),
        }
    }

    #[test]
    fn decodes_lifecycle_transcript_tool_and_refusal_events() {
        let lifecycle = decode_su_session_event(&envelope(
            "lifecycle",
            json!({
                "previousState": "starting", "state": "ready", "runtimeGeneration": 2
            }),
        ))
        .unwrap();
        assert!(matches!(
            lifecycle,
            SuSessionEvent::Lifecycle {
                state: SuSessionLifecycleState::Ready,
                ..
            }
        ));

        let transcript = decode_su_session_event(&envelope("transcript", json!({
            "phase": "delta", "turnId": "turn-1", "role": "assistant", "channel": "text", "content": "hello"
        }))).unwrap();
        assert!(
            matches!(transcript, SuSessionEvent::Transcript { content: Some(ref c), .. } if c == "hello")
        );

        let tool = decode_su_session_event(&envelope("tool", json!({
            "phase": "completed", "turnId": "turn-1", "callId": "call-1", "name": "read", "output": {"ok": true}, "isError": false
        }))).unwrap();
        assert!(matches!(tool, SuSessionEvent::Tool { ref call_id, .. } if call_id == "call-1"));

        let refusal = decode_su_session_event(&envelope(
            "command_result",
            json!({
                "commandId": "cmd-1", "commandType": "fork", "status": "refused",
                "refusal": {"code": "unsupported", "message": "not available", "retryable": false}
            }),
        ))
        .unwrap();
        assert!(matches!(
            refusal,
            SuSessionEvent::CommandResult {
                refusal: Some(_),
                ..
            }
        ));
    }

    #[test]
    fn rejects_schema_drift_instead_of_silently_rendering() {
        let mut frame = envelope(
            "lifecycle",
            json!({
                "previousState": null, "state": "starting", "runtimeGeneration": 0
            }),
        );
        frame.data = frame.data.replace(SU_SESSION_SCHEMA, "other/v9");
        let error = decode_su_session_event(&frame).unwrap_err().to_string();
        assert!(error.contains("unsupported SU-session schema"));
    }

    #[test]
    fn backend_and_lifecycle_labels_are_stable() {
        assert_eq!(
            SuSessionBackend::ALL.map(SuSessionBackend::as_str),
            ["claude", "codex", "omp"]
        );
        assert_eq!(
            SuSessionLifecycleState::WaitingForOwner.to_string(),
            "waiting-for-owner"
        );
    }

    #[test]
    fn decodes_snapshot_with_backend_extension_and_capabilities() {
        let snapshot: SuSessionSnapshot = serde_json::from_value(json!({
            "ok": true,
            "descriptor": {
                "identity": {
                    "agentChatId":"chat-1", "advSessionId":7, "backend":"codex",
                    "nativeSessionId":"rollout-1", "ownerId":"su-1", "workspaceId":"ws-1", "harnessSlug":"papercup"
                },
                "lifecycle":"waiting-for-owner", "runtimeGeneration":2, "role":"su",
                "model":"gpt-5.5", "accountRoute":"auto", "carry":"warm", "modes":["auto"],
                "capabilities": {
                    "commands": {"owner_turn": {"state":"supported", "implementation":"native"}, "fork":{"state":"unsupported", "reason":"provider"}},
                    "features": {"tool-events": {"state":"supported", "implementation":"native"}}
                },
                "backendExtension": {"backend":"codex", "codexHome":"/tmp/codex"}
            },
            "floorSequence":1, "lastSequence":4, "terminal":false
        })).expect("decode snapshot");
        assert_eq!(
            snapshot.descriptor.identity.backend,
            SuSessionBackend::Codex
        );
        assert_eq!(
            snapshot.descriptor.lifecycle,
            SuSessionLifecycleState::WaitingForOwner
        );
        assert!(
            matches!(snapshot.descriptor.backend_extension, SuSessionBackendExtension::Codex { codex_home: Some(ref home) } if home == "/tmp/codex")
        );
        assert_eq!(snapshot.last_sequence, 4);
    }

    #[test]
    fn create_and_attach_requests_match_launch_su_wire_names() {
        let create = serde_json::to_value(SuSessionCreateRequest {
            agent: SuSessionBackend::Omp,
            harness_slug: Some("papercup".into()),
            plan_slug: None,
            carry: "warm".into(),
            defer_spawn: true,
            agent_chat_id: "chat-1".into(),
        })
        .unwrap();
        assert_eq!(create["agent"], "omp");
        assert_eq!(create["harness_slug"], "papercup");
        assert_eq!(create["defer_spawn"], true);
        assert_eq!(create["agent_chat_id"], "chat-1");
        assert!(create.get("harnessSlug").is_none());

        let attach = serde_json::to_value(SuSessionAttachRequest {
            agent: SuSessionBackend::Claude,
            attach_adv_session_id: 42,
            harness_slug: None,
            plan_slug: None,
        })
        .unwrap();
        assert_eq!(attach["attach_adv_session_id"], 42);
        assert!(attach.get("attachAdvSessionId").is_none());
    }

    #[test]
    fn controls_preserve_target_identity_and_explicit_refusal_shape() {
        let identity: SuSessionIdentity = serde_json::from_value(json!({
            "agentChatId":"chat-1", "advSessionId":7, "backend":"omp",
            "nativeSessionId":"thread-1", "ownerId":"su-1", "workspaceId":"ws-1", "harnessSlug":"papercup"
        })).unwrap();
        let command = SuSessionControl::Resume {
            cause: "pui-restart".into(),
        }
        .command_json(&identity, "cmd-1", "2026-08-28T00:00:00Z");
        assert_eq!(command["type"], "resume");
        assert_eq!(command["cause"], "pui-restart");
        assert_eq!(command["target"]["advSessionId"], 7);
        assert_eq!(command["target"]["backend"], "omp");

        let fork = SuSessionControl::Fork {
            from_sequence: Some(12),
        }
        .command_json(&identity, "cmd-2", "2026-08-28T00:00:00Z");
        assert_eq!(fork["fromSequence"], 12);
        assert_eq!(SuSessionControl::End { reason: None }.command_type(), "end");
    }
}
