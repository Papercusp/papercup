//! HTTP+bearer backend transport (D-009). The remote counterpart to the IPC
//! transport: when there's no local Unix socket (a remote box / the SP3 Claude
//! Code plugin), `pui` talks to the operator over HTTP, reading the base URL +
//! bearer token from `~/.papercusp/operator.json` (the file SP1's `serve`
//! writes). `/api/*` calls are direct requests; SSE is a streaming GET whose
//! bytes feed the shared `sse.rs` parser. No raw-IPC assumptions — same typed
//! client surface, different wire.
#![allow(dead_code)] // selected at runtime; unused on a box that resolves IPC.

use crate::sse::{parse_sse_frames, SseFrame};
use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use tokio::sync::mpsc;

pub struct HttpClient {
    base: String, // operator httpUrl, no trailing slash
    token: Option<String>,
    http: reqwest::Client,
}

impl HttpClient {
    /// Resolve base URL + bearer from `~/.papercusp/operator.json`.
    pub fn from_discovery() -> Result<Self> {
        let (base, token) = discover_operator()?;
        Ok(Self::new(base, token))
    }

    pub fn new(base: String, token: Option<String>) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            token,
            http: reqwest::Client::new(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<reqwest::Response> {
        let mut req = match method {
            "GET" => self.http.get(self.url(path)),
            "POST" => self.http.post(self.url(path)),
            "DELETE" => self.http.delete(self.url(path)),
            other => return Err(anyhow!("unsupported method {other}")),
        };
        if let Some(t) = &self.token {
            req = req.bearer_auth(t);
        }
        if let Some(b) = body {
            req = req.header("content-type", "application/json").body(b);
        }
        req.send().await.with_context(|| format!("{method} {path}"))
    }

    /// `/api/*` request; returns the body bytes, erroring on non-2xx/3xx.
    pub async fn sys_http(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<Vec<u8>> {
        let resp = self.send(method, path, body).await?;
        let status = resp.status();
        let bytes = resp.bytes().await.context("read body")?;
        if !(status.is_success() || status.is_redirection()) {
            let txt: String = String::from_utf8_lossy(&bytes).chars().take(200).collect();
            return Err(anyhow!("{method} {path} -> {}: {txt}", status.as_u16()));
        }
        Ok(bytes.to_vec())
    }

    /// Subscribe to an SSE route (GET); yields parsed `SseFrame`s until the
    /// stream ends.
    pub async fn subscribe_sse(&self, path: &str) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        let resp = self.send("GET", path, None).await?;
        if !resp.status().is_success() {
            return Err(anyhow!("sse {path} -> {}", resp.status().as_u16()));
        }
        Ok(stream_response(resp))
    }

    /// Subscribe to an SSE route via a streaming POST (the operator-converse
    /// turn rides POST + a request body and replies `text/event-stream`). Same
    /// chunk → `SseFrame` pipeline as the GET path.
    pub async fn subscribe_sse_post(
        &self,
        path: &str,
        body: String,
    ) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        let resp = self.send("POST", path, Some(body)).await?;
        if !resp.status().is_success() {
            return Err(anyhow!("sse {path} -> {}", resp.status().as_u16()));
        }
        Ok(stream_response(resp))
    }
}

/// Drain a streaming `reqwest::Response` into a uniform `SseFrame` channel,
/// handling chunk boundaries that split multi-byte UTF-8 and partial frames.
fn stream_response(mut resp: reqwest::Response) -> mpsc::UnboundedReceiver<SseFrame> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut pending = String::new(); // text not yet forming complete frames
        let mut tail: Vec<u8> = Vec::new(); // incomplete trailing UTF-8 bytes
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    tail.extend_from_slice(&chunk);
                    let (decoded, rest) = decode_utf8_prefix(std::mem::take(&mut tail));
                    tail = rest;
                    pending.push_str(&decoded);
                    let (frames, rest) = parse_sse_frames(&pending);
                    pending = rest;
                    for f in frames {
                        if tx.send(f).is_err() {
                            return;
                        }
                    }
                }
                Ok(None) | Err(_) => return, // stream ended / dropped
            }
        }
    });
    rx
}

/// Decode the valid UTF-8 prefix of `buf`, returning it plus any trailing bytes
/// of an incomplete multi-byte sequence (to prepend to the next network chunk).
fn decode_utf8_prefix(buf: Vec<u8>) -> (String, Vec<u8>) {
    match std::str::from_utf8(&buf) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) => {
            let valid = e.valid_up_to();
            // The prefix is valid by construction, so lossy == exact here.
            let s = String::from_utf8_lossy(&buf[..valid]).into_owned();
            (s, buf[valid..].to_vec())
        }
    }
}

fn discover_operator() -> Result<(String, Option<String>)> {
    let home = dirs::home_dir().context("no home dir")?;
    let p = home.join(".papercusp").join("operator.json");
    let txt = std::fs::read_to_string(&p).with_context(|| format!("read {}", p.display()))?;
    let v: Value = serde_json::from_str(&txt).context("parse operator.json")?;
    let base = v
        .get("httpUrl")
        .and_then(|x| x.as_str())
        .context("operator.json missing httpUrl")?
        .to_string();
    let token = v
        .get("token")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Ok((base, token))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn decode_utf8_prefix_splits_multibyte() {
        // "é" = 0xC3 0xA9; feed it split across two chunks.
        let (s1, tail1) = decode_utf8_prefix(vec![b'a', 0xC3]);
        assert_eq!(s1, "a");
        assert_eq!(tail1, vec![0xC3]);
        let mut next = tail1;
        next.push(0xA9);
        let (s2, tail2) = decode_utf8_prefix(next);
        assert_eq!(s2, "é");
        assert!(tail2.is_empty());
    }

    /// Minimal one-shot HTTP server; returns its addr + a channel delivering the
    /// raw request text (for header assertions).
    async fn spawn_http(
        status_line: &'static str,
        headers: &'static str,
        body: &'static str,
    ) -> (String, tokio::sync::oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = format!("http://{}", listener.local_addr().unwrap());
        let (rtx, rrx) = tokio::sync::oneshot::channel::<String>();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap_or(0);
            let _ = rtx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
            let resp = format!(
                "HTTP/1.1 {status_line}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = s.write_all(resp.as_bytes()).await;
            let _ = s.flush().await;
        });
        (addr, rrx)
    }

    #[tokio::test]
    async fn sys_http_get_sends_bearer_and_returns_body() {
        let (addr, req_rx) = spawn_http(
            "200 OK",
            "Content-Type: application/json\r\n",
            r#"{"ok":true}"#,
        )
        .await;
        let client = HttpClient::new(addr, Some("secret-token".into()));
        let bytes = client.sys_http("GET", "/api/x", None).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], serde_json::json!(true));
        let req = req_rx.await.unwrap();
        assert!(req.starts_with("GET /api/x "));
        assert!(
            req.contains("authorization: Bearer secret-token")
                || req.contains("Authorization: Bearer secret-token")
        );
    }

    #[tokio::test]
    async fn sys_http_errors_on_non_2xx() {
        let (addr, _r) = spawn_http("404 Not Found", "", "nope").await;
        let client = HttpClient::new(addr, None);
        let err = client
            .sys_http("GET", "/api/missing", None)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("404"));
    }

    #[tokio::test]
    async fn subscribe_sse_parses_streamed_frames() {
        let (addr, _r) = spawn_http(
            "200 OK",
            "Content-Type: text/event-stream\r\n",
            "event: heartbeat\ndata: {}\n\nevent: invalidate\ndata: {\"name\":\"roster\"}\n\n",
        )
        .await;
        let client = HttpClient::new(addr, None);
        let mut rx = client.subscribe_sse("/api/zero-harness/sse").await.unwrap();
        let f1 = rx.recv().await.unwrap();
        let f2 = rx.recv().await.unwrap();
        assert_eq!(f1.event, "heartbeat");
        assert_eq!(f2.event, "invalidate");
        assert_eq!(f2.data, "{\"name\":\"roster\"}");
    }
}
