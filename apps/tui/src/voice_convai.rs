//! Realtime operator voice — the raw ElevenLabs Conv-AI WebSocket session
//! (voice-realtime-tui-2026-06-05 P-003/P-005/P-006; D-001/D-003/D-009).
//!
//! Topology (D-001): the pui connects DIRECTLY to EL over the raw-WS protocol
//! using a time-boxed signed URL minted server-side by
//! `GET /api/agent-mcp/operator-elevenlabs-ws-init` (which also claims the
//! fleet voice lease, kind `tui`). Audio in = the existing cpal capture
//! pipeline streamed as ~250 ms `pcm_16000` chunks; audio out = `audio`
//! events appended to the shared rodio `Player` (interruption = stop, that IS
//! barge-in — EL's server VAD detects it). The operator BRAIN stays in the
//! loop via the `ask_operator` client tool (D-003): EL forwards every user
//! turn as a `client_tool_call`, we answer over the existing
//! operator-converse SSE and return the `<say>` body for EL to speak —
//! byte-the-same contract as the desktop's browser clientTool.
//!
//! Protocol shapes mirror the official Python SDK's raw client
//! (`conversation_initiation_client_data` → `user_audio_chunk` /
//! `audio` / `ping`→`pong` / `user_transcript` / `agent_response` /
//! `interruption` / `client_tool_call`→`client_tool_result`); unknown event
//! types are tolerated so EL-side protocol additions never wedge the session.
//!
//! Threading mirrors `voice.rs`: the session is a tokio task owned by the
//! run loop (`main.rs` holds the [`ConvAiHandle`]); `App` stays pure and only
//! sees [`ConvAiUpdate`] events.

use crate::client::OperatorClient;
use crate::event::Event;
use crate::voice::{self, Player};
use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

/// Mic chunk cadence. ~250 ms balances EL VAD latency against JSON/base64
/// framing overhead (the Python SDK defaults to a similar window).
pub const MIC_CHUNK_MS: u32 = 250;
/// Lease heartbeat cadence — well under the 12 s lease TTL.
const LEASE_HEARTBEAT_SECS: u64 = 5;

// ───────────────────────── ws-init payload ─────────────────────────

/// The `operator-elevenlabs-ws-init` route's 200 body (P-001).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsInitPayload {
    pub signed_url: String,
    #[serde(default)]
    pub agent_id: String,
    /// Shell mode (D-009): at most `{ agent: { language } }`.
    #[serde(default)]
    pub overrides: Option<serde_json::Value>,
    #[serde(default)]
    pub dynamic_variables: serde_json::Value,
}

// ───────────────────────── protocol codec (pure) ─────────────────────────

/// Server→client events we act on. Anything else parses to `Unknown`.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerEvent {
    InitMetadata {
        conversation_id: String,
        agent_output_audio_format: String,
    },
    Audio {
        audio_b64: String,
    },
    Ping {
        event_id: i64,
    },
    UserTranscript(String),
    AgentResponse(String),
    Interruption,
    ClientToolCall {
        tool_name: String,
        tool_call_id: String,
        parameters: serde_json::Value,
    },
    Unknown,
}

/// Tolerant event parse — never errors, unknown shapes become `Unknown`.
pub fn parse_server_event(raw: &str) -> ServerEvent {
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return ServerEvent::Unknown,
    };
    let s = |x: &serde_json::Value, k: &str| x.get(k).and_then(|y| y.as_str()).map(str::to_string);
    match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        "conversation_initiation_metadata" => {
            let e = &v["conversation_initiation_metadata_event"];
            ServerEvent::InitMetadata {
                conversation_id: s(e, "conversation_id").unwrap_or_default(),
                agent_output_audio_format: s(e, "agent_output_audio_format")
                    .unwrap_or_else(|| "pcm_16000".into()),
            }
        }
        "audio" => match s(&v["audio_event"], "audio_base_64") {
            Some(audio_b64) => ServerEvent::Audio { audio_b64 },
            None => ServerEvent::Unknown,
        },
        "ping" => ServerEvent::Ping {
            event_id: v["ping_event"]["event_id"].as_i64().unwrap_or(0),
        },
        "user_transcript" => ServerEvent::UserTranscript(
            s(&v["user_transcription_event"], "user_transcript").unwrap_or_default(),
        ),
        "agent_response" => ServerEvent::AgentResponse(
            s(&v["agent_response_event"], "agent_response").unwrap_or_default(),
        ),
        "interruption" => ServerEvent::Interruption,
        "client_tool_call" => {
            let e = &v["client_tool_call"];
            ServerEvent::ClientToolCall {
                tool_name: s(e, "tool_name").unwrap_or_default(),
                tool_call_id: s(e, "tool_call_id").unwrap_or_default(),
                parameters: e.get("parameters").cloned().unwrap_or(serde_json::json!({})),
            }
        }
        _ => ServerEvent::Unknown,
    }
}

/// The session-opening message (shell mode: overrides = language pin or absent).
pub fn initiation_message(
    overrides: Option<&serde_json::Value>,
    dynamic_variables: &serde_json::Value,
) -> String {
    let mut m = serde_json::json!({ "type": "conversation_initiation_client_data" });
    if let Some(o) = overrides {
        if !o.is_null() {
            m["conversation_config_override"] = o.clone();
        }
    }
    if dynamic_variables.is_object() {
        m["dynamic_variables"] = dynamic_variables.clone();
    }
    m.to_string()
}

/// One outbound mic chunk (16 kHz mono PCM16 LE bytes → base64).
pub fn user_audio_chunk_message(pcm16le: &[u8]) -> String {
    serde_json::json!({
        "user_audio_chunk": base64::engine::general_purpose::STANDARD.encode(pcm16le),
    })
    .to_string()
}

pub fn pong_message(event_id: i64) -> String {
    serde_json::json!({ "type": "pong", "event_id": event_id }).to_string()
}

pub fn client_tool_result_message(tool_call_id: &str, result: &str, is_error: bool) -> String {
    serde_json::json!({
        "type": "client_tool_result",
        "tool_call_id": tool_call_id,
        "result": result,
        "is_error": is_error,
    })
    .to_string()
}

/// `"pcm_16000"` → `Some(16000)`; non-PCM formats (mp3_…) → `None` (the
/// playback path decodes those through rodio instead).
pub fn pcm_rate_from_format(fmt: &str) -> Option<u32> {
    fmt.strip_prefix("pcm_").and_then(|r| r.parse().ok())
}

/// Decode one `audio` event's payload into i16 samples (little-endian pairs).
pub fn b64_to_pcm16(audio_b64: &str) -> Result<Vec<i16>> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_b64)
        .context("audio_base_64 decode")?;
    Ok(bytes
        .chunks_exact(2)
        .map(|p| i16::from_le_bytes([p[0], p[1]]))
        .collect())
}

/// `<set_mode>…</set_mode>` from an utterance — the one voice side effect the
/// TUI surfaces (as a toast; the mode itself is a desktop-session concept).
/// Mirrors operator-converse-voice.ts: `<say>` is never re-rendered (EL spoke
/// it), `<sleep>` is ignored on this surface.
pub fn utterance_set_mode(raw: &str) -> Option<String> {
    let start = raw.find("<set_mode>")? + "<set_mode>".len();
    let end = raw[start..].find("</set_mode>")? + start;
    let mode = raw[start..end].trim();
    (!mode.is_empty()).then(|| mode.to_string())
}

// ───────────────────────── session updates → App ─────────────────────────

/// Reducer-facing session updates (wrapped in `Event::ConvAi`).
#[derive(Debug, Clone)]
pub enum ConvAiUpdate {
    /// Connected + initiation metadata received.
    Connected { conversation_id: String },
    /// EL's STT transcript of what the user said (a finished user turn).
    UserTranscript(String),
    /// The agent's utterance text (raw — may carry tags; reducer strips).
    AgentText(String),
    /// The session ended (user stop, ws close, lease loss). Terminal.
    Ended { reason: String },
    /// Setup or mid-session failure. Terminal.
    Error(String),
}

/// Run-loop handle (main.rs owns it; `stop()` tears the session down).
pub struct ConvAiHandle {
    stop_tx: UnboundedSender<()>,
}

impl ConvAiHandle {
    pub fn stop(&self) {
        let _ = self.stop_tx.send(());
    }
}

/// Spawn the realtime session. `owner` is the pui's coordination identity
/// (the voice-lease owner id); `player` is the shared playback handle.
pub fn start_session(owner: String, player: Player, tx: UnboundedSender<Event>) -> ConvAiHandle {
    let (stop_tx, stop_rx) = unbounded_channel::<()>();
    tokio::spawn(session_task(owner, player, tx, stop_rx));
    ConvAiHandle { stop_tx }
}

async fn session_task(
    owner: String,
    player: Player,
    tx: UnboundedSender<Event>,
    mut stop_rx: tokio::sync::mpsc::UnboundedReceiver<()>,
) {
    let end = |reason: String| {
        let _ = tx.send(Event::ConvAi(ConvAiUpdate::Ended { reason }));
    };
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::ConvAi(ConvAiUpdate::Error(format!("voice: {e}"))));
            return;
        }
    };

    // The user pressed the toggle — that's the explicit pre-emption signal
    // (force=1), same contract as the desktop/mobile claim-on-tap.
    let init = match client.elevenlabs_ws_init(&owner, true).await {
        Ok(p) => p,
        Err(e) => {
            let _ = tx.send(Event::ConvAi(ConvAiUpdate::Error(format!("voice init: {e}"))));
            return;
        }
    };

    // The shared operator conversation id — voice turns persist into the SAME
    // thread text uses (D-007). Best-effort: a missing backend still talks.
    let op_conversation_id = client
        .load_conversation(1)
        .await
        .ok()
        .map(|l| l.conversation.id);

    let (ws, _resp) = match tokio_tungstenite::connect_async(&init.signed_url).await {
        Ok(x) => x,
        Err(e) => {
            release_lease_quiet(&owner).await;
            let _ = tx.send(Event::ConvAi(ConvAiUpdate::Error(format!("voice connect: {e}"))));
            return;
        }
    };
    let (mut sink, mut stream) = ws.split();

    // Single writer: every outbound frame (init, mic chunks, pongs, tool
    // results) rides one channel so the sink never sees interleaved writers.
    let (out_tx, mut out_rx) = unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            if sink.send(m).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let _ = out_tx.send(Message::Text(initiation_message(
        init.overrides.as_ref(),
        &init.dynamic_variables,
    )));

    // Continuous mic → user_audio_chunk frames. The capture handle stops the
    // cpal stream on drop/stop; the bridge thread ends with the channel.
    let capture = match voice::start_stream_capture(MIC_CHUNK_MS) {
        Ok(c) => c,
        Err(e) => {
            let _ = out_tx.send(Message::Close(None));
            writer.abort();
            release_lease_quiet(&owner).await;
            let _ = tx.send(Event::ConvAi(ConvAiUpdate::Error(format!("voice mic: {e}"))));
            return;
        }
    };
    {
        let out_tx = out_tx.clone();
        let chunks = capture.chunks();
        // std mpsc → tokio bridge on a blocking thread (cpal callbacks are sync).
        tokio::task::spawn_blocking(move || {
            while let Ok(chunk) = chunks.recv() {
                if out_tx
                    .send(Message::Text(user_audio_chunk_message(&chunk)))
                    .is_err()
                {
                    break;
                }
            }
        });
    }

    // Lease heartbeat — losing it (a forced desktop/mobile claim) ends us.
    let (lease_lost_tx, mut lease_lost_rx) = unbounded_channel::<String>();
    let hb_owner = owner.clone();
    let heartbeat = tokio::spawn(async move {
        let client = match OperatorClient::from_discovery().await {
            Ok(c) => c,
            Err(_) => return,
        };
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(LEASE_HEARTBEAT_SECS)).await;
            match client.voice_lease_heartbeat(&hb_owner).await {
                Ok(true) => {}
                Ok(false) => {
                    let _ = lease_lost_tx.send("voice moved to another surface".into());
                    return;
                }
                Err(_) => { /* transient — keep the session, retry next tick */ }
            }
        }
    });

    let _ = tx.send(Event::ConvAi(ConvAiUpdate::Connected {
        conversation_id: String::new(), // refined by InitMetadata below
    }));

    let mut output_pcm_rate: Option<u32> = Some(16_000);
    let reason: String = loop {
        tokio::select! {
            _ = stop_rx.recv() => break "voice off".into(),
            Some(lost) = lease_lost_rx.recv() => break lost,
            frame = stream.next() => {
                let msg = match frame {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => break format!("voice link error: {e}"),
                    None => break "voice session closed".into(),
                };
                let text = match msg {
                    Message::Text(t) => t,
                    Message::Close(_) => break "voice session closed".into(),
                    _ => continue,
                };
                match parse_server_event(&text) {
                    ServerEvent::InitMetadata { conversation_id, agent_output_audio_format } => {
                        output_pcm_rate = pcm_rate_from_format(&agent_output_audio_format);
                        let _ = tx.send(Event::ConvAi(ConvAiUpdate::Connected { conversation_id }));
                    }
                    ServerEvent::Audio { audio_b64 } => {
                        match output_pcm_rate {
                            Some(rate) => {
                                if let Ok(samples) = b64_to_pcm16(&audio_b64) {
                                    player.append_pcm(samples, rate);
                                }
                            }
                            None => {
                                // Encoded (mp3_…) agent output — decode via rodio.
                                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&audio_b64) {
                                    player.append_encoded(bytes);
                                }
                            }
                        }
                    }
                    ServerEvent::Ping { event_id } => {
                        let _ = out_tx.send(Message::Text(pong_message(event_id)));
                    }
                    ServerEvent::Interruption => {
                        // Barge-in: EL's VAD heard the user — cut playback NOW.
                        player.stop();
                    }
                    ServerEvent::UserTranscript(t) if !t.trim().is_empty() => {
                        let _ = tx.send(Event::ConvAi(ConvAiUpdate::UserTranscript(t.clone())));
                        persist_turn_quiet(&op_conversation_id, "user", &t).await;
                    }
                    ServerEvent::AgentResponse(t) if !t.trim().is_empty() => {
                        let _ = tx.send(Event::ConvAi(ConvAiUpdate::AgentText(t.clone())));
                        // Persist the SPOKEN text (tags stripped) — raw tags in
                        // the shared thread are the bug su-73278 is fixing on
                        // the device path; don't reintroduce it here.
                        let spoken = crate::chat_tags::finalize(&t);
                        if !spoken.trim().is_empty() {
                            persist_turn_quiet(&op_conversation_id, "assistant", &spoken).await;
                        }
                    }
                    ServerEvent::ClientToolCall { tool_name, tool_call_id, parameters } => {
                        let out_tx = out_tx.clone();
                        let conv_id = op_conversation_id.clone();
                        tokio::spawn(async move {
                            let reply = if tool_name == "ask_operator" {
                                ask_operator(&parameters, conv_id.as_deref()).await
                            } else {
                                Err(anyhow!("tool '{tool_name}' is not available on the tui surface"))
                            };
                            let m = match reply {
                                Ok(text) => client_tool_result_message(&tool_call_id, &text, false),
                                Err(e) => client_tool_result_message(&tool_call_id, &format!("{e}"), true),
                            };
                            let _ = out_tx.send(Message::Text(m));
                        });
                    }
                    ServerEvent::UserTranscript(_) | ServerEvent::AgentResponse(_) | ServerEvent::Unknown => {}
                }
            }
        }
    };

    capture.stop();
    player.stop();
    heartbeat.abort();
    let _ = out_tx.send(Message::Close(None));
    drop(out_tx);
    let _ = writer.await;
    release_lease_quiet(&owner).await;
    end(reason);
}

/// The operator BRAIN delegate (D-003). Mirrors the browser's
/// `askOperatorViaSse`: recent PG history + the spoken question → the
/// operator-converse SSE → the `<say>` body EL will speak. Never propagates
/// a raw stack into the agent's mouth — errors map to a graceful line.
async fn ask_operator(
    parameters: &serde_json::Value,
    op_conversation_id: Option<&str>,
) -> Result<String> {
    let question = parameters
        .get("question")
        .or_else(|| parameters.get("message"))
        .or_else(|| parameters.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let client = OperatorClient::from_discovery().await?;

    // Same context contract as the browser tool: the shared PG history (the
    // route slices to its own HISTORY_KEEP anyway) + the question appended
    // unless the parallel transcript persist already landed it at the tail.
    let mut messages: Vec<serde_json::Value> = Vec::new();
    if let Ok(load) = client.load_conversation(30).await {
        for t in &load.turns {
            if (t.role == "user" || t.role == "assistant") && !t.text.trim().is_empty() {
                messages.push(serde_json::json!({ "role": t.role, "content": t.text }));
            }
        }
    }
    let tail_is_question = messages
        .last()
        .and_then(|m| m.get("content").and_then(|c| c.as_str()))
        .is_some_and(|c| c.trim() == question);
    if !question.is_empty() && !tail_is_question {
        messages.push(serde_json::json!({ "role": "user", "content": question }));
    }

    let mut body = serde_json::json!({
        "messages": messages,
        "trigger": "user_message",
        "modality": "voice",
        "mayAskActive": false,
        "surface": "tui",
    });
    if let Some(id) = op_conversation_id {
        body["conversationId"] = serde_json::Value::String(id.to_string());
    }

    let mut sub = client.subscribe_converse(body).await?;
    let mut raw = String::new();
    while let Some(fr) = sub.recv().await {
        match fr.event.as_str() {
            "delta" => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&fr.data) {
                    if let Some(t) = v.get("text").and_then(|x| x.as_str()) {
                        raw.push_str(t);
                    }
                }
            }
            "done" | "error" => break,
            _ => {}
        }
    }
    let say = crate::chat_tags::extract_say(&raw)
        .unwrap_or_else(|| crate::chat_tags::finalize(&raw));
    if say.trim().is_empty() {
        return Ok("I had trouble just then — say that again?".into());
    }
    Ok(say)
}

async fn persist_turn_quiet(conversation_id: &Option<String>, role: &str, text: &str) {
    let Some(id) = conversation_id else { return };
    if let Ok(client) = OperatorClient::from_discovery().await {
        let _ = client.append_turn(id, role, text, &[], None).await;
    }
}

async fn release_lease_quiet(owner: &str) {
    if let Ok(client) = OperatorClient::from_discovery().await {
        let _ = client.voice_lease_release(owner).await;
    }
}

// ───────────────────────────────── tests ─────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_core_server_events() {
        let init = r#"{"type":"conversation_initiation_metadata","conversation_initiation_metadata_event":{"conversation_id":"conv_1","agent_output_audio_format":"pcm_16000","user_input_audio_format":"pcm_16000"}}"#;
        assert_eq!(
            parse_server_event(init),
            ServerEvent::InitMetadata {
                conversation_id: "conv_1".into(),
                agent_output_audio_format: "pcm_16000".into(),
            }
        );

        let audio = r#"{"type":"audio","audio_event":{"audio_base_64":"AAA=","event_id":7}}"#;
        assert_eq!(parse_server_event(audio), ServerEvent::Audio { audio_b64: "AAA=".into() });

        let ping = r#"{"type":"ping","ping_event":{"event_id":42,"ping_ms":120}}"#;
        assert_eq!(parse_server_event(ping), ServerEvent::Ping { event_id: 42 });

        let ut = r#"{"type":"user_transcript","user_transcription_event":{"user_transcript":"hello there"}}"#;
        assert_eq!(parse_server_event(ut), ServerEvent::UserTranscript("hello there".into()));

        let ar = r#"{"type":"agent_response","agent_response_event":{"agent_response":"<say>hi</say>"}}"#;
        assert_eq!(parse_server_event(ar), ServerEvent::AgentResponse("<say>hi</say>".into()));

        assert_eq!(parse_server_event(r#"{"type":"interruption","interruption_event":{"event_id":3}}"#), ServerEvent::Interruption);

        let tool = r#"{"type":"client_tool_call","client_tool_call":{"tool_name":"ask_operator","tool_call_id":"tc_9","parameters":{"question":"status?"}}}"#;
        match parse_server_event(tool) {
            ServerEvent::ClientToolCall { tool_name, tool_call_id, parameters } => {
                assert_eq!(tool_name, "ask_operator");
                assert_eq!(tool_call_id, "tc_9");
                assert_eq!(parameters["question"], "status?");
            }
            other => panic!("expected tool call, got {other:?}"),
        }

        // Unknown types + non-JSON degrade, never panic.
        assert_eq!(parse_server_event(r#"{"type":"vad_score","vad_score_event":{"vad_score":0.9}}"#), ServerEvent::Unknown);
        assert_eq!(parse_server_event("not json"), ServerEvent::Unknown);
    }

    #[test]
    fn outbound_messages_have_the_sdk_shapes() {
        let dv = serde_json::json!({ "workspace_id": "ws-1", "surface": "tui" });
        let ov = serde_json::json!({ "agent": { "language": "en" } });
        let init: serde_json::Value =
            serde_json::from_str(&initiation_message(Some(&ov), &dv)).unwrap();
        assert_eq!(init["type"], "conversation_initiation_client_data");
        assert_eq!(init["conversation_config_override"]["agent"]["language"], "en");
        assert_eq!(init["dynamic_variables"]["surface"], "tui");

        // Null overrides stay absent (the route returns overrides: null).
        let bare: serde_json::Value =
            serde_json::from_str(&initiation_message(Some(&serde_json::Value::Null), &dv)).unwrap();
        assert!(bare.get("conversation_config_override").is_none());

        let chunk: serde_json::Value =
            serde_json::from_str(&user_audio_chunk_message(&[0x01, 0x02])).unwrap();
        assert_eq!(chunk["user_audio_chunk"], "AQI=");

        let pong: serde_json::Value = serde_json::from_str(&pong_message(42)).unwrap();
        assert_eq!(pong["type"], "pong");
        assert_eq!(pong["event_id"], 42);

        let res: serde_json::Value =
            serde_json::from_str(&client_tool_result_message("tc_9", "done", false)).unwrap();
        assert_eq!(res["type"], "client_tool_result");
        assert_eq!(res["tool_call_id"], "tc_9");
        assert_eq!(res["is_error"], false);
    }

    #[test]
    fn pcm_helpers_round_trip() {
        assert_eq!(pcm_rate_from_format("pcm_16000"), Some(16_000));
        assert_eq!(pcm_rate_from_format("pcm_44100"), Some(44_100));
        assert_eq!(pcm_rate_from_format("mp3_44100_128"), None);
        assert_eq!(pcm_rate_from_format("ulaw_8000"), None);

        // i16 LE round trip: [-2, 300] → bytes → base64 → samples.
        let bytes: Vec<u8> = [-2i16, 300i16].iter().flat_map(|s| s.to_le_bytes()).collect();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        assert_eq!(b64_to_pcm16(&b64).unwrap(), vec![-2, 300]);
    }

    #[test]
    fn set_mode_extraction_is_strict() {
        assert_eq!(
            utterance_set_mode("<say>ok</say><set_mode>passive</set_mode>"),
            Some("passive".into())
        );
        assert_eq!(utterance_set_mode("<say>ok</say>"), None);
        assert_eq!(utterance_set_mode("<set_mode></set_mode>"), None);
    }
}
