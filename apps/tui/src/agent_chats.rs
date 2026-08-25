//! Typed wire contract for the operator's native `agent-chats` session API.
//!
//! The operator owns the transport and the agent loop. The TUI is a client of
//! that existing surface: lifecycle calls use REST and a turn uses the
//! `engine:"loop"` streaming POST. This module deliberately contains no ACP or
//! external-engine compatibility layer.

use crate::sse::SseFrame;
use anyhow::{anyhow, bail, Context, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentChatListOptions {
    pub include_archived: bool,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NewAgentChat {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feature_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentChatTurnRequest {
    pub content: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentChatApprovalDecision {
    pub approved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentChatSummary {
    pub id: String,
    pub role: String,
    #[serde(default)]
    pub feature_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub turn_count: u32,
    #[serde(default)]
    pub total_input_tokens: u64,
    #[serde(default)]
    pub total_output_tokens: u64,
    #[serde(default)]
    pub total_cost_usd_cents: f64,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentChatListResponse {
    #[serde(default)]
    pub chats: Vec<AgentChatSummary>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentChat {
    pub id: String,
    pub role: String,
    #[serde(default)]
    pub feature_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub transcript: Vec<AgentChatTranscriptTurn>,
    #[serde(default)]
    pub total_input_tokens: u64,
    #[serde(default)]
    pub total_output_tokens: u64,
    #[serde(default)]
    pub total_cost_usd_cents: f64,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub archived_at: Option<String>,
    #[serde(default)]
    pub feature_lock: Option<AgentChatFeatureLock>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentChatTranscriptTurn {
    pub role: String,
    pub content: String,
    pub ts: String,
    #[serde(default)]
    pub tokens_in: Option<u64>,
    #[serde(default)]
    pub tokens_out: Option<u64>,
    #[serde(default)]
    pub cost_cents: Option<f64>,
    #[serde(default)]
    pub tools: Vec<AgentChatTranscriptToolCall>,
    #[serde(default)]
    pub error: bool,
    #[serde(default, rename = "unreportedFrames")]
    pub unreported_frames: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentChatTranscriptToolCall {
    pub name: String,
    #[serde(default)]
    pub input: Option<Value>,
    #[serde(default)]
    pub answered: Option<AgentChatTranscriptAnswer>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentChatTranscriptAnswer {
    #[serde(default)]
    pub picks: Vec<AgentChatTranscriptPick>,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AgentChatTranscriptPick {
    pub option_id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AgentChatFeatureLock {
    #[serde(default)]
    pub taken_by: Option<String>,
    #[serde(default)]
    pub taken_at: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAgentChatApproval {
    pub chat_id: String,
    pub call_id: String,
    pub workspace_id: String,
    pub tool_name: String,
    pub tool_input: Value,
    pub step_index: u32,
    pub requested_at: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentChatApprovalsResponse {
    #[serde(default)]
    pub approvals: Vec<PendingAgentChatApproval>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: Option<u64>,
    #[serde(default)]
    pub cache_creation_tokens: Option<u64>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentChatToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentChatEvent {
    /// Transport keepalive emitted by the shared SSE response helper.
    Heartbeat {
        ts_ms: Option<u64>,
    },
    StepStart {
        step_index: u32,
    },
    TextDelta {
        step_index: u32,
        text: String,
    },
    ReasoningDelta {
        step_index: u32,
        text: String,
    },
    ToolCall {
        step_index: u32,
        call: AgentChatToolCall,
        needs_approval: bool,
    },
    ApprovalResolved {
        step_index: u32,
        call_id: String,
        approved: bool,
        reason: Option<String>,
    },
    ToolResult {
        step_index: u32,
        call_id: String,
        name: String,
        result: Option<Value>,
        error: Option<String>,
        denied: bool,
    },
    StepEnd {
        step_index: u32,
        usage: Option<AgentChatUsage>,
        stop_reason: Option<String>,
        tool_call_count: u32,
    },
    Done {
        stop_reason: String,
        final_text: String,
        usage: AgentChatUsage,
        step_count: u32,
    },
    Error {
        message: String,
    },
}

pub type AgentChatEventStream = mpsc::UnboundedReceiver<Result<AgentChatEvent>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatPayload {
    #[serde(default)]
    ts_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StepStartPayload {
    step_index: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeltaPayload {
    step_index: u32,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolCallPayload {
    step_index: u32,
    call: AgentChatToolCall,
    needs_approval: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalResolvedPayload {
    step_index: u32,
    call_id: String,
    approved: bool,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolResultPayload {
    step_index: u32,
    call_id: String,
    name: String,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    denied: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StepEndPayload {
    step_index: u32,
    #[serde(default)]
    usage: Option<AgentChatUsage>,
    #[serde(default)]
    stop_reason: Option<String>,
    #[serde(default)]
    tool_call_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    stop_reason: String,
    final_text: String,
    usage: AgentChatUsage,
    step_count: u32,
}

#[derive(Deserialize)]
struct ErrorPayload {
    message: String,
}

fn parse_payload<T: DeserializeOwned>(value: Value, event: &str) -> Result<T> {
    serde_json::from_value(value).with_context(|| format!("decode agent-chat `{event}` payload"))
}

fn validate_payload_type(value: &Value, event: &str, allow_missing: bool) -> Result<()> {
    match value.get("type") {
        Some(Value::String(payload_type)) if payload_type == event => Ok(()),
        Some(Value::String(payload_type)) => bail!(
            "agent-chat SSE event name `{event}` does not match payload type `{payload_type}`"
        ),
        Some(_) => bail!("agent-chat SSE `{event}` payload has a non-string `type`"),
        None if allow_missing => Ok(()),
        None => bail!("agent-chat SSE `{event}` payload is missing `type`"),
    }
}

/// Decode one frame from the owned-loop session protocol. Unknown event names
/// and name/type disagreement are errors instead of silent drops; otherwise
/// serde remains forward-compatible with additive payload fields.
pub fn decode_agent_chat_event(frame: &SseFrame) -> Result<AgentChatEvent> {
    let value: Value = serde_json::from_str(&frame.data)
        .with_context(|| format!("parse agent-chat SSE `{}` JSON", frame.event))?;

    match frame.event.as_str() {
        "heartbeat" => {
            let payload: HeartbeatPayload = parse_payload(value, "heartbeat")?;
            Ok(AgentChatEvent::Heartbeat {
                ts_ms: payload.ts_ms,
            })
        }
        "step_start" => {
            validate_payload_type(&value, "step_start", false)?;
            let payload: StepStartPayload = parse_payload(value, "step_start")?;
            Ok(AgentChatEvent::StepStart {
                step_index: payload.step_index,
            })
        }
        "text_delta" | "reasoning_delta" => {
            validate_payload_type(&value, &frame.event, false)?;
            let payload: DeltaPayload = parse_payload(value, &frame.event)?;
            if frame.event == "text_delta" {
                Ok(AgentChatEvent::TextDelta {
                    step_index: payload.step_index,
                    text: payload.text,
                })
            } else {
                Ok(AgentChatEvent::ReasoningDelta {
                    step_index: payload.step_index,
                    text: payload.text,
                })
            }
        }
        "tool_call" => {
            validate_payload_type(&value, "tool_call", false)?;
            let payload: ToolCallPayload = parse_payload(value, "tool_call")?;
            Ok(AgentChatEvent::ToolCall {
                step_index: payload.step_index,
                call: payload.call,
                needs_approval: payload.needs_approval,
            })
        }
        "approval_resolved" => {
            validate_payload_type(&value, "approval_resolved", false)?;
            let payload: ApprovalResolvedPayload = parse_payload(value, "approval_resolved")?;
            Ok(AgentChatEvent::ApprovalResolved {
                step_index: payload.step_index,
                call_id: payload.call_id,
                approved: payload.approved,
                reason: payload.reason,
            })
        }
        "tool_result" => {
            validate_payload_type(&value, "tool_result", false)?;
            let payload: ToolResultPayload = parse_payload(value, "tool_result")?;
            Ok(AgentChatEvent::ToolResult {
                step_index: payload.step_index,
                call_id: payload.call_id,
                name: payload.name,
                result: payload.result,
                error: payload.error,
                denied: payload.denied,
            })
        }
        "step_end" => {
            validate_payload_type(&value, "step_end", false)?;
            let payload: StepEndPayload = parse_payload(value, "step_end")?;
            Ok(AgentChatEvent::StepEnd {
                step_index: payload.step_index,
                usage: payload.usage,
                stop_reason: payload.stop_reason,
                tool_call_count: payload.tool_call_count,
            })
        }
        "done" => {
            validate_payload_type(&value, "done", false)?;
            let payload: DonePayload = parse_payload(value, "done")?;
            Ok(AgentChatEvent::Done {
                stop_reason: payload.stop_reason,
                final_text: payload.final_text,
                usage: payload.usage,
                step_count: payload.step_count,
            })
        }
        "error" => {
            // The loop wire carries type:"error"; the shared SSE wrapper's
            // setup-failure fallback predates that vocabulary and omits it.
            validate_payload_type(&value, "error", true)?;
            let payload: ErrorPayload = parse_payload(value, "error")?;
            Ok(AgentChatEvent::Error {
                message: payload.message,
            })
        }
        other => Err(anyhow!("unsupported agent-chat SSE event `{other}`")),
    }
}

pub(crate) fn decode_agent_chat_stream(
    mut frames: mpsc::UnboundedReceiver<SseFrame>,
) -> AgentChatEventStream {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(frame) = frames.recv().await {
            let decoded = decode_agent_chat_event(&frame);
            let done = matches!(decoded, Ok(AgentChatEvent::Done { .. }));
            if tx.send(decoded).is_err() {
                return;
            }
            if done {
                // The terminal event is authoritative; do not wait for the
                // transport to close before handing it to the caller.
                return;
            }
        }
        // A closed SSE channel without `done` is a failed turn, not a
        // successful empty response. The stream task surfaces this as the
        // same typed error path as a decoder failure.
        let _ = tx.send(Err(anyhow!(
            "agent-chat SSE stream closed before done"
        )));
    });
    rx
}

pub(crate) fn agent_chats_list_path(harness: &str, options: &AgentChatListOptions) -> String {
    let mut path = format!("/api/harness/{}/agent-chats", encode_segment(harness));
    let mut query = Vec::new();
    if options.include_archived {
        query.push("include=archived".to_string());
    }
    if let Some(limit) = options.limit {
        query.push(format!("limit={limit}"));
    }
    if let Some(offset) = options.offset {
        query.push(format!("offset={offset}"));
    }
    if !query.is_empty() {
        path.push('?');
        path.push_str(&query.join("&"));
    }
    path
}

pub(crate) fn agent_chat_path(harness: &str, chat_id: &str) -> String {
    format!(
        "/api/harness/{}/agent-chats/{}",
        encode_segment(harness),
        encode_segment(chat_id)
    )
}

pub(crate) fn agent_chat_messages_path(harness: &str, chat_id: &str) -> String {
    format!("{}/messages", agent_chat_path(harness, chat_id))
}

pub(crate) fn agent_chat_approvals_path(harness: &str, chat_id: &str) -> String {
    format!("{}/approvals", agent_chat_path(harness, chat_id))
}

pub(crate) fn agent_chat_approval_path(harness: &str, chat_id: &str, call_id: &str) -> String {
    format!(
        "{}/{}",
        agent_chat_approvals_path(harness, chat_id),
        encode_segment(call_id)
    )
}

pub(crate) fn loop_message_body(request: &AgentChatTurnRequest) -> Value {
    let mut body = serde_json::json!({
        "content": request.content,
        "engine": "loop",
    });
    if let Some(model) = &request.model {
        body["model"] = Value::String(model.clone());
    }
    body
}

fn encode_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(event: &str, data: Value) -> SseFrame {
        SseFrame {
            event: event.to_string(),
            data: data.to_string(),
        }
    }

    #[test]
    fn decodes_lifecycle_payloads() {
        let list: AgentChatListResponse = serde_json::from_value(json!({
            "chats": [{
                "id": "chat-1",
                "role": "worker",
                "feature_id": "WI-1",
                "title": "Native chat",
                "turn_count": 2,
                "total_input_tokens": 11,
                "total_output_tokens": 7,
                "total_cost_usd_cents": 1.25,
                "created_at": "2026-08-24T00:00:00.000Z",
                "updated_at": "2026-08-24T00:01:00.000Z",
                "archived_at": null
            }]
        }))
        .expect("decode list");
        assert_eq!(list.chats[0].turn_count, 2);
        assert_eq!(list.chats[0].feature_id.as_deref(), Some("WI-1"));

        let chat: AgentChat = serde_json::from_value(json!({
            "id": "chat-1",
            "role": "worker",
            "feature_id": "WI-1",
            "title": "Native chat",
            "transcript": [{
                "role": "assistant",
                "content": "done",
                "ts": "2026-08-24T00:01:00.000Z",
                "tokens_in": 11,
                "tokens_out": 7,
                "cost_cents": 1.25,
                "unreportedFrames": 1,
                "tools": [{
                    "name": "chat:ask_choice",
                    "input": {"question": "ship?"},
                    "answered": {"picks": [{"option_id": "yes", "label": "Yes"}], "at": 1}
                }]
            }],
            "total_input_tokens": 11,
            "total_output_tokens": 7,
            "total_cost_usd_cents": 1.25,
            "created_at": "2026-08-24T00:00:00.000Z",
            "updated_at": "2026-08-24T00:01:00.000Z",
            "archived_at": null,
            "feature_lock": {"taken_by": "su-1", "taken_at": null, "expires_at": null, "active": true}
        }))
        .expect("decode chat");
        assert_eq!(chat.transcript[0].unreported_frames, Some(1));
        assert_eq!(
            chat.transcript[0].tools[0].answered.as_ref().unwrap().picks[0].option_id,
            "yes"
        );
        assert!(chat.feature_lock.unwrap().active);
    }

    #[test]
    fn decodes_every_owned_loop_event_variant() {
        let cases = vec![
            frame("heartbeat", json!({"tsMs": 7})),
            frame("step_start", json!({"type": "step_start", "stepIndex": 0})),
            frame(
                "text_delta",
                json!({"type": "text_delta", "stepIndex": 0, "text": "hi"}),
            ),
            frame(
                "reasoning_delta",
                json!({"type": "reasoning_delta", "stepIndex": 0, "text": "hmm"}),
            ),
            frame(
                "tool_call",
                json!({
                    "type": "tool_call", "stepIndex": 0,
                    "call": {"id": "c1", "name": "capability:read", "input": {"path": "x"}},
                    "needsApproval": true
                }),
            ),
            frame(
                "approval_resolved",
                json!({
                    "type": "approval_resolved", "stepIndex": 0, "callId": "c1",
                    "approved": false, "reason": "not now"
                }),
            ),
            frame(
                "tool_result",
                json!({
                    "type": "tool_result", "stepIndex": 0, "callId": "c1",
                    "name": "capability:read", "error": "denied", "denied": true
                }),
            ),
            frame(
                "step_end",
                json!({
                    "type": "step_end", "stepIndex": 0,
                    "usage": {"inputTokens": 3, "outputTokens": 2, "costUsd": 0.01},
                    "stopReason": "tool_use", "toolCallCount": 1
                }),
            ),
            frame(
                "done",
                json!({
                    "type": "done", "stopReason": "complete", "finalText": "hi",
                    "usage": {"inputTokens": 3, "outputTokens": 2}, "stepCount": 1
                }),
            ),
            frame(
                "error",
                json!({"type": "error", "message": "provider unavailable"}),
            ),
        ];

        let decoded = cases
            .iter()
            .map(decode_agent_chat_event)
            .collect::<Result<Vec<_>>>()
            .expect("all variants decode");
        assert!(matches!(
            decoded[0],
            AgentChatEvent::Heartbeat { ts_ms: Some(7) }
        ));
        assert!(matches!(
            decoded[1],
            AgentChatEvent::StepStart { step_index: 0 }
        ));
        assert!(matches!(decoded[2], AgentChatEvent::TextDelta { ref text, .. } if text == "hi"));
        assert!(
            matches!(decoded[3], AgentChatEvent::ReasoningDelta { ref text, .. } if text == "hmm")
        );
        assert!(matches!(
            decoded[4],
            AgentChatEvent::ToolCall {
                needs_approval: true,
                ..
            }
        ));
        assert!(matches!(
            decoded[5],
            AgentChatEvent::ApprovalResolved {
                approved: false,
                ..
            }
        ));
        assert!(matches!(
            decoded[6],
            AgentChatEvent::ToolResult { denied: true, .. }
        ));
        assert!(matches!(
            decoded[7],
            AgentChatEvent::StepEnd {
                tool_call_count: 1,
                ..
            }
        ));
        assert!(
            matches!(decoded[8], AgentChatEvent::Done { ref final_text, .. } if final_text == "hi")
        );
        assert!(
            matches!(decoded[9], AgentChatEvent::Error { ref message } if message == "provider unavailable")
        );
    }

    #[test]
    fn rejects_event_name_type_mismatch_and_unknown_events() {
        let mismatch = decode_agent_chat_event(&frame(
            "text_delta",
            json!({"type": "reasoning_delta", "stepIndex": 0, "text": "hmm"}),
        ))
        .unwrap_err()
        .to_string();
        assert!(mismatch.contains("does not match"), "{mismatch}");

        let unknown =
            decode_agent_chat_event(&frame("mystery", json!({"type": "mystery", "value": 1})))
                .unwrap_err()
                .to_string();
        assert!(unknown.contains("unsupported"), "{unknown}");

        let infrastructure_error = decode_agent_chat_event(&frame(
            "error",
            json!({"phase": "setup", "message": "setup exploded"}),
        ))
        .expect("shared SSE wrapper error remains readable");
        assert!(
            matches!(infrastructure_error, AgentChatEvent::Error { ref message } if message == "setup exploded")
        );
    }

    #[tokio::test]
    async fn stream_reports_early_eof_without_done() {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut events = decode_agent_chat_stream(rx);
        tx.send(frame(
            "text_delta",
            json!({"type": "text_delta", "stepIndex": 0, "text": "partial"}),
        ))
        .expect("send frame");
        drop(tx);

        assert!(matches!(
            events.recv().await.expect("text event").expect("decode text"),
            AgentChatEvent::TextDelta { ref text, .. } if text == "partial"
        ));
        let error = events
            .recv()
            .await
            .expect("early EOF error")
            .expect_err("EOF must not decode as success");
        assert!(error.to_string().contains("closed before done"));
    }

    #[test]
    fn builds_loop_and_approval_wire_exactly() {
        assert_eq!(
            agent_chats_list_path(
                "hive one",
                &AgentChatListOptions {
                    include_archived: true,
                    limit: Some(25),
                    offset: Some(50),
                }
            ),
            "/api/harness/hive%20one/agent-chats?include=archived&limit=25&offset=50"
        );
        assert_eq!(
            agent_chat_messages_path("hive/one", "chat/a"),
            "/api/harness/hive%2Fone/agent-chats/chat%2Fa/messages"
        );
        assert_eq!(
            agent_chat_approval_path("hive", "chat-1", "call/1"),
            "/api/harness/hive/agent-chats/chat-1/approvals/call%2F1"
        );

        let body = loop_message_body(&AgentChatTurnRequest {
            content: "do the work".to_string(),
            model: Some("claude-sonnet-4-6".to_string()),
        });
        assert_eq!(
            body,
            json!({"content": "do the work", "engine": "loop", "model": "claude-sonnet-4-6"})
        );
        let without_model = loop_message_body(&AgentChatTurnRequest {
            content: "continue".to_string(),
            model: None,
        });
        assert_eq!(
            without_model,
            json!({"content": "continue", "engine": "loop"})
        );

        let decision = serde_json::to_value(AgentChatApprovalDecision {
            approved: false,
            reason: Some("unsafe".to_string()),
        })
        .unwrap();
        assert_eq!(decision, json!({"approved": false, "reason": "unsafe"}));
    }

    #[test]
    fn decodes_pending_approvals_camel_case_contract() {
        let response: AgentChatApprovalsResponse = serde_json::from_value(json!({
            "approvals": [{
                "chatId": "chat-1",
                "callId": "call-1",
                "workspaceId": "ws-1",
                "toolName": "capability:write",
                "toolInput": {"path": "x"},
                "stepIndex": 2,
                "requestedAt": "2026-08-24T00:00:00.000Z"
            }]
        }))
        .expect("decode approvals");
        assert_eq!(response.approvals[0].call_id, "call-1");
        assert_eq!(response.approvals[0].step_index, 2);
    }
}
