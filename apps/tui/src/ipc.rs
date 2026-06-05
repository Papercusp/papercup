//! IPC client (SSE→IPC pivot). Connects to the operator's endpoint-ipc Unix
//! socket and invokes tools — including `sys:http` for `/api/*` routes.
//! Leaner mirror of `papercusp-desktop/src-tauri/src/endpoint_ipc.rs`
//! (mpsc + std Mutex map instead of Tauri Channels). No auth token: the Unix
//! socket is the trust boundary.
#![allow(dead_code)] // some surface (CallResult.result, generic invoke) is consumed as panels grow.

use crate::framing::{decode_event_bin_payload, encode_frame, Frame, FrameDecoder, FrameType};
use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixStream;
use tokio::sync::mpsc;

/// A non-terminal event frame for a call.
pub enum CallEvent {
    Json { name: String, data: Value },
    Bin { name: String, bytes: Vec<u8> },
}

/// Frames routed from the reader loop to a waiting call. Public so streaming
/// callers (e.g. an SSE subscription over `sys:http`) can drain them directly.
pub enum CallFrame {
    Event(CallEvent),
    Done(Value),
    Error { code: String, message: String },
    ConnLost,
}

/// Result of a completed call: the events seen + the DONE `result`.
pub struct CallResult {
    pub events: Vec<CallEvent>,
    pub result: Value,
}

type Sinks = Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<CallFrame>>>>;

pub struct IpcClient {
    writer: tokio::sync::Mutex<OwnedWriteHalf>,
    next_id: AtomicU64,
    sinks: Sinks,
}

impl IpcClient {
    /// Resolve the socket from `~/.papercusp/endpoint-ipc.json` and connect.
    pub async fn connect_discovered() -> Result<Self> {
        let path = discover_socket().context("resolve endpoint-ipc socket")?;
        Self::connect(&path).await
    }

    pub async fn connect(socket_path: &Path) -> Result<Self> {
        let stream = UnixStream::connect(socket_path)
            .await
            .with_context(|| format!("connect ipc socket {}", socket_path.display()))?;
        let (mut read_half, write_half) = stream.into_split();
        let sinks: Sinks = Arc::new(Mutex::new(HashMap::new()));
        let reader_sinks = sinks.clone();

        tokio::spawn(async move {
            let mut dec = FrameDecoder::new();
            let mut buf = [0u8; 64 * 1024];
            loop {
                match read_half.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if dec.push(&buf[..n]).is_err() {
                            break;
                        }
                        for frame in dec.drain() {
                            route_frame(&reader_sinks, frame);
                        }
                    }
                }
            }
            // Socket closed → fail every in-flight call.
            let mut g = reader_sinks.lock().unwrap();
            for (_, tx) in g.drain() {
                let _ = tx.send(CallFrame::ConnLost);
            }
        });

        Ok(Self {
            writer: tokio::sync::Mutex::new(write_half),
            next_id: AtomicU64::new(1),
            sinks,
        })
    }

    /// Open a streaming call: returns a receiver of `CallFrame`s for this call.
    /// It yields `Event(..)`s as they arrive then a terminal `Done`/`Error`
    /// (`ConnLost` on socket loss), after which it closes. For a long-lived
    /// stream (e.g. an SSE route via `sys:http`) there is no Done until the
    /// upstream stream ends — the caller processes events indefinitely.
    pub async fn invoke_stream(
        &self,
        tool: &str,
        input: Value,
    ) -> Result<mpsc::UnboundedReceiver<CallFrame>> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::unbounded_channel::<CallFrame>();
        self.sinks.lock().unwrap().insert(id, tx);

        let req = serde_json::json!({ "id": id, "toolName": tool, "input": input });
        let payload = serde_json::to_vec(&req)?;
        let frame =
            encode_frame(FrameType::Request, &payload).map_err(|e| anyhow!("encode: {e}"))?;
        let mut w = self.writer.lock().await;
        w.write_all(&frame).await.context("write request frame")?;
        let _ = w.flush().await;
        Ok(rx)
    }

    /// Invoke `tool` with `input`; collect events until DONE/ERROR.
    pub async fn invoke(&self, tool: &str, input: Value) -> Result<CallResult> {
        let mut rx = self.invoke_stream(tool, input).await?;
        let mut events: Vec<CallEvent> = Vec::new();
        while let Some(msg) = rx.recv().await {
            match msg {
                CallFrame::Event(ev) => events.push(ev),
                CallFrame::Done(result) => return Ok(CallResult { events, result }),
                CallFrame::Error { code, message } => {
                    return Err(anyhow!("ipc {tool} error [{code}]: {message}"))
                }
                CallFrame::ConnLost => return Err(anyhow!("ipc {tool}: connection lost")),
            }
        }
        Err(anyhow!("ipc {tool}: stream closed without terminal"))
    }

    /// Invoke `sys:http` for an `/api/*` route; reassemble the `body` EVENT_BIN
    /// chunks into the response bytes. Errors on a non-2xx/3xx status.
    pub async fn sys_http(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<Vec<u8>> {
        let mut input = serde_json::json!({ "method": method, "path": path });
        if let Some(b) = body {
            input["headers"] = serde_json::json!({ "content-type": "application/json" });
            input["body"] = Value::String(b);
        }
        let res = self.invoke("sys:http", input).await?;

        let mut status: i64 = 200;
        let mut body_bytes: Vec<u8> = Vec::new();
        for ev in &res.events {
            match ev {
                CallEvent::Json { name, data } if name == "head" => {
                    status = data.get("status").and_then(|s| s.as_i64()).unwrap_or(200);
                }
                CallEvent::Bin { name, bytes } if name == "body" => {
                    body_bytes.extend_from_slice(bytes)
                }
                _ => {}
            }
        }
        if !(200..400).contains(&status) {
            let txt: String = String::from_utf8_lossy(&body_bytes)
                .chars()
                .take(200)
                .collect();
            return Err(anyhow!("{method} {path} -> {status}: {txt}"));
        }
        Ok(body_bytes)
    }
}

fn route_frame(sinks: &Sinks, frame: Frame) {
    let (id, cf): (u64, CallFrame) = match frame.frame_type {
        FrameType::EventJson => {
            let v: Value = match serde_json::from_slice(&frame.payload) {
                Ok(v) => v,
                Err(_) => return,
            };
            let id = v.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
            let name = v
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let data = v.get("data").cloned().unwrap_or(Value::Null);
            (id, CallFrame::Event(CallEvent::Json { name, data }))
        }
        FrameType::EventBin => match decode_event_bin_payload(&frame.payload) {
            Ok(d) => (
                d.id,
                CallFrame::Event(CallEvent::Bin {
                    name: d.name,
                    bytes: d.binary,
                }),
            ),
            Err(_) => return,
        },
        FrameType::Done => {
            let v: Value = match serde_json::from_slice(&frame.payload) {
                Ok(v) => v,
                Err(_) => return,
            };
            let id = v.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
            (
                id,
                CallFrame::Done(v.get("result").cloned().unwrap_or(Value::Null)),
            )
        }
        FrameType::Error => {
            let v: Value = match serde_json::from_slice(&frame.payload) {
                Ok(v) => v,
                Err(_) => return,
            };
            let id = v.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
            let err = v.get("error").cloned().unwrap_or(Value::Null);
            let code = err
                .get("code")
                .and_then(|x| x.as_str())
                .unwrap_or("error")
                .to_string();
            let message = err
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            (id, CallFrame::Error { code, message })
        }
        // Client→server frame types never arrive here.
        FrameType::Request | FrameType::Cancel => return,
    };
    // Terminal frames free the sink (so streaming receivers close cleanly).
    let is_terminal = matches!(cf, CallFrame::Done(_) | CallFrame::Error { .. });
    let tx = {
        let mut g = sinks.lock().unwrap();
        if is_terminal {
            g.remove(&id)
        } else {
            g.get(&id).cloned()
        }
    };
    if let Some(tx) = tx {
        let _ = tx.send(cf);
    }
}

fn discover_socket() -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home dir")?;
    let disc = home.join(".papercusp").join("endpoint-ipc.json");
    let txt = std::fs::read_to_string(&disc).with_context(|| format!("read {}", disc.display()))?;
    let v: Value = serde_json::from_str(&txt).context("parse endpoint-ipc.json")?;
    let sp = v
        .get("socketPath")
        .and_then(|x| x.as_str())
        .context("endpoint-ipc.json missing socketPath")?;
    Ok(PathBuf::from(sp))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::UnixListener;

    fn event_bin_frame(id: u64, name: &str, bin: &[u8]) -> Vec<u8> {
        let mut p = Vec::new();
        p.extend_from_slice(&id.to_be_bytes());
        p.extend_from_slice(&(name.len() as u32).to_be_bytes());
        p.extend_from_slice(name.as_bytes());
        p.extend_from_slice(bin);
        encode_frame(FrameType::EventBin, &p).unwrap()
    }

    /// Fake operator: accept one connection, read a REQUEST, reply with the
    /// sys:http frame sequence (head EVENT_JSON + body EVENT_BIN + DONE).
    async fn spawn_fake(socket: PathBuf, status: i64, body: &'static [u8]) {
        let listener = UnixListener::bind(&socket).unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (mut r, mut w) = stream.into_split();
            // Read exactly one REQUEST frame.
            let mut hdr = [0u8; 5];
            if r.read_exact(&mut hdr).await.is_err() {
                return;
            }
            let len = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as usize;
            let mut payload = vec![0u8; len];
            let _ = r.read_exact(&mut payload).await;
            let req: Value = serde_json::from_slice(&payload).unwrap();
            let id = req["id"].as_u64().unwrap();

            let head =
                serde_json::json!({"id":id,"name":"head","data":{"status":status,"headers":{}}})
                    .to_string();
            let _ = w
                .write_all(&encode_frame(FrameType::EventJson, head.as_bytes()).unwrap())
                .await;
            let _ = w.write_all(&event_bin_frame(id, "body", body)).await;
            let done = serde_json::json!({"id":id,"result":{"content":[]}}).to_string();
            let _ = w
                .write_all(&encode_frame(FrameType::Done, done.as_bytes()).unwrap())
                .await;
            let _ = w.flush().await;
        });
        // Give bind a beat before the client connects.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    /// Fake operator that streams several EVENT_JSON frames before DONE — the
    /// shape `invoke_stream` consumes for the SSE-over-IPC subscription.
    async fn spawn_fake_stream(socket: PathBuf, chunks: Vec<&'static str>) {
        let listener = UnixListener::bind(&socket).unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (mut r, mut w) = stream.into_split();
            let mut hdr = [0u8; 5];
            if r.read_exact(&mut hdr).await.is_err() {
                return;
            }
            let len = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as usize;
            let mut payload = vec![0u8; len];
            let _ = r.read_exact(&mut payload).await;
            let req: Value = serde_json::from_slice(&payload).unwrap();
            let id = req["id"].as_u64().unwrap();
            for c in chunks {
                let f = serde_json::json!({"id":id,"name":"sse-chunk","data":c}).to_string();
                let _ = w
                    .write_all(&encode_frame(FrameType::EventJson, f.as_bytes()).unwrap())
                    .await;
            }
            let done = serde_json::json!({"id":id,"result":Value::Null}).to_string();
            let _ = w
                .write_all(&encode_frame(FrameType::Done, done.as_bytes()).unwrap())
                .await;
            let _ = w.flush().await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    #[tokio::test]
    async fn invoke_stream_yields_events_then_closes() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("op.sock");
        spawn_fake_stream(
            sock.clone(),
            vec!["event: a\ndata: 1\n\n", "event: b\ndata: 2\n\n"],
        )
        .await;
        let client = IpcClient::connect(&sock).await.unwrap();
        let mut rx = client
            .invoke_stream(
                "sys:http",
                serde_json::json!({"method":"GET","path":"/api/sse"}),
            )
            .await
            .unwrap();
        let mut chunks = 0;
        let mut saw_done = false;
        while let Some(f) = rx.recv().await {
            match f {
                CallFrame::Event(CallEvent::Json { name, .. }) if name == "sse-chunk" => {
                    chunks += 1
                }
                CallFrame::Done(_) => {
                    saw_done = true;
                    break;
                }
                _ => {}
            }
        }
        assert_eq!(chunks, 2);
        assert!(saw_done);
        // After the terminal frame the sink is freed, so the channel is closed.
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn sys_http_reassembles_body() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("op.sock");
        spawn_fake(sock.clone(), 200, br#"{"ok":true,"n":7}"#).await;
        let client = IpcClient::connect(&sock).await.unwrap();
        let bytes = client.sys_http("GET", "/api/x", None).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], serde_json::json!(true));
        assert_eq!(v["n"], serde_json::json!(7));
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_ipc_smoke() {
        let client = IpcClient::connect_discovered()
            .await
            .expect("connect via discovery");
        let bytes = client
            .sys_http("GET", "/api/admin/plans/list", None)
            .await
            .expect("sys_http GET");
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        let n = v["plans"].as_array().map(|a| a.len()).unwrap_or(0);
        eprintln!("live IPC sys:http → plans count = {n}");
        assert!(v.get("plans").is_some(), "expected a plans array");
        assert!(n > 0, "operator should have plans");
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_sse_subscription_smoke() {
        let client = IpcClient::connect_discovered()
            .await
            .expect("connect via discovery");
        let mut rx = client
            .invoke_stream(
                "sys:http",
                serde_json::json!({"method":"GET","path":"/api/zero-harness/sse"}),
            )
            .await
            .expect("open sse stream");
        // The route sends an initial heartbeat — we should see a sse-chunk frame
        // carrying SSE wire text within a few seconds.
        let got = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while let Some(f) = rx.recv().await {
                if let CallFrame::Event(CallEvent::Json { name, data }) = f {
                    if name == "sse-chunk" {
                        return data.as_str().map(|s| s.to_string());
                    }
                }
            }
            None
        })
        .await
        .expect("timed out waiting for first sse-chunk");
        let text = got.expect("first sse-chunk had string data");
        eprintln!("live SSE first chunk: {text:?}");
        let (frames, _rest) = crate::sse::parse_sse_frames(&text);
        // At least one parseable frame, and it should be a known sync event.
        assert!(
            frames.iter().any(|fr| matches!(
                fr.event.as_str(),
                "heartbeat" | "invalidate" | "update" | "message"
            )),
            "expected a recognisable SSE event, got {frames:?}"
        );
    }

    #[tokio::test]
    async fn sys_http_errors_on_non_2xx() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("op.sock");
        spawn_fake(sock.clone(), 404, b"not found").await;
        let client = IpcClient::connect(&sock).await.unwrap();
        let err = client
            .sys_http("GET", "/api/missing", None)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("404"));
    }
}
