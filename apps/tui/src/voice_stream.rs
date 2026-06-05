//! Continuous voice-channel streaming to the LOCAL operator voice node
//! (holepunch-voice-channels-2026-06-05 P-005 / D-010).
//!
//! The operator owns the Opus codec + the P2P swarm; this client streams raw
//! 48 kHz mono PCM16 both ways over the dedicated voice unix socket
//! (`~/.papercusp/voice-ipc.json` discovery; `[4B len BE][1B type][payload]`):
//!   0x01 CTRL (JSON both ways) · 0x02 MIC (client→operator PCM) · 0x03 MIX
//!   (operator→client mixed PCM, one 20ms frame at a time).
//!
//! Mic capture (cpal) and playback (rodio) live on dedicated OS threads like
//! `voice.rs`; the testable seam is `push_pcm()` — tests inject synthetic PCM
//! and a mock unix server, no audio hardware involved.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};

pub const CTRL: u8 = 0x01;
pub const MIC: u8 = 0x02;
pub const MIX: u8 = 0x03;
pub const VOICE_RATE: u32 = 48_000;
pub const FRAME_SAMPLES: usize = 960; // 20ms @ 48k mono

// ---------------------------------------------------------------- framing

pub fn encode_frame(ty: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.push(ty);
    out.extend_from_slice(payload);
    out
}

/// Incremental frame parser — tolerates arbitrary chunk boundaries.
#[derive(Default)]
pub struct FrameParser {
    buf: Vec<u8>,
}

impl FrameParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<(u8, Vec<u8>)> {
        self.buf.extend_from_slice(chunk);
        let mut frames = Vec::new();
        loop {
            if self.buf.len() < 5 {
                break;
            }
            let len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
            if self.buf.len() < 5 + len {
                break;
            }
            let ty = self.buf[4];
            let payload = self.buf[5..5 + len].to_vec();
            self.buf.drain(..5 + len);
            frames.push((ty, payload));
        }
        frames
    }
}

// ---------------------------------------------------------------- DSP

/// Linear-interpolation resample (mono f32). Identity when rates match.
pub fn resample_linear(mono: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if src_rate == dst_rate || mono.is_empty() {
        return mono.to_vec();
    }
    let ratio = src_rate as f64 / dst_rate as f64;
    let out_len = ((mono.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let i0 = pos.floor() as usize;
        let frac = (pos - i0 as f64) as f32;
        let a = mono[i0.min(mono.len() - 1)];
        let b = mono[(i0 + 1).min(mono.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}

fn f32_to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * 32767.0) as i16
}

// ---------------------------------------------------------------- status

/// Mirror of the operator's voice status payload (subset the UI needs).
#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
pub struct VoicePeer {
    pub id: String,
    pub label: String,
    pub muted: bool,
    pub speaking: bool,
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
pub struct VoiceChannelInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
pub struct VoiceStatus {
    pub channel: Option<VoiceChannelInfo>,
    pub muted: bool,
    #[serde(default)]
    pub peers: Vec<VoicePeer>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum VoiceEvent {
    Status(VoiceStatus),
    Error(String),
    Disconnected,
}

// ---------------------------------------------------------------- client

#[derive(serde::Deserialize)]
struct Discovery {
    #[serde(rename = "socketPath")]
    socket_path: String,
}

/// Resolve the operator's voice socket path from the discovery file.
pub fn discover_socket_path() -> Result<std::path::PathBuf> {
    let home = std::env::var("HOME").context("HOME unset")?;
    let p = Path::new(&home).join(".papercusp").join("voice-ipc.json");
    let raw = std::fs::read_to_string(&p).with_context(|| format!("voice discovery missing at {}", p.display()))?;
    let d: Discovery = serde_json::from_str(&raw).context("bad voice-ipc.json")?;
    Ok(std::path::PathBuf::from(d.socket_path))
}

/// Holds only Sync members (Mutex/atomics) so `Arc<VoiceStream>` is Send —
/// the cpal capture callback requires it. Event/mix receivers are returned by
/// `connect_to` instead of stored here (mpsc::Receiver is !Sync).
pub struct VoiceStream {
    writer: Arc<Mutex<UnixStream>>,
    mic_level_bits: Arc<AtomicU32>,
    mic_acc: Mutex<Vec<f32>>,
    alive: Arc<AtomicBool>,
}

impl VoiceStream {
    /// Connect via the discovery file.
    pub fn connect() -> Result<(Self, Receiver<VoiceEvent>, Receiver<Vec<i16>>)> {
        Self::connect_to(&discover_socket_path()?)
    }

    pub fn connect_to(path: &Path) -> Result<(Self, Receiver<VoiceEvent>, Receiver<Vec<i16>>)> {
        let stream = UnixStream::connect(path).with_context(|| format!("voice socket connect {}", path.display()))?;
        let reader = stream.try_clone().context("voice socket clone")?;
        let writer = Arc::new(Mutex::new(stream));
        let (ev_tx, ev_rx) = channel::<VoiceEvent>();
        let (mix_tx, mix_rx) = channel::<Vec<i16>>();
        let alive = Arc::new(AtomicBool::new(true));
        let alive_r = alive.clone();
        std::thread::Builder::new()
            .name("pui-voice-stream-read".into())
            .spawn(move || read_loop(reader, ev_tx, mix_tx, alive_r))
            .context("spawn voice reader")?;
        Ok((
            Self {
                writer,
                mic_level_bits: Arc::new(AtomicU32::new(0)),
                mic_acc: Mutex::new(Vec::new()),
                alive,
            },
            ev_rx,
            mix_rx,
        ))
    }

    fn send_ctrl(&self, msg: &serde_json::Value) -> Result<()> {
        let wire = encode_frame(CTRL, msg.to_string().as_bytes());
        self.writer
            .lock()
            .map_err(|_| anyhow!("voice writer poisoned"))?
            .write_all(&wire)
            .context("voice ctrl write")
    }

    pub fn join(&self, channel: &str) -> Result<()> {
        self.send_ctrl(&serde_json::json!({ "op": "join", "channel": channel }))
    }

    pub fn leave(&self) -> Result<()> {
        self.send_ctrl(&serde_json::json!({ "op": "leave" }))
    }

    pub fn set_muted(&self, muted: bool) -> Result<()> {
        self.send_ctrl(&serde_json::json!({ "op": "mute", "muted": muted }))
    }

    pub fn request_status(&self) -> Result<()> {
        self.send_ctrl(&serde_json::json!({ "op": "status" }))
    }

    /// Mic level 0..1 (RMS of the last pushed chunk) — status-line meter feed.
    pub fn mic_level(&self) -> f32 {
        f32::from_bits(self.mic_level_bits.load(Ordering::Relaxed))
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    /// The testable mic seam: push interleaved f32 PCM at any rate/channels.
    /// Mixes to mono, resamples to 48k, accumulates exact 20ms frames, and
    /// ships each as one MIC frame. `start_mic()` feeds this from cpal.
    pub fn push_pcm(&self, samples: &[f32], channels: u16, src_rate: u32) -> Result<()> {
        let mono = crate::voice::mix_to_mono(samples, channels);
        self.mic_level_bits
            .store(crate::voice::rms(&mono).to_bits(), Ordering::Relaxed);
        let at48k = resample_linear(&mono, src_rate, VOICE_RATE);
        let mut acc = self.mic_acc.lock().map_err(|_| anyhow!("mic acc poisoned"))?;
        acc.extend_from_slice(&at48k);
        while acc.len() >= FRAME_SAMPLES {
            let frame: Vec<f32> = acc.drain(..FRAME_SAMPLES).collect();
            let mut bytes = Vec::with_capacity(FRAME_SAMPLES * 2);
            for s in frame {
                bytes.extend_from_slice(&f32_to_i16(s).to_le_bytes());
            }
            let wire = encode_frame(MIC, &bytes);
            self.writer
                .lock()
                .map_err(|_| anyhow!("voice writer poisoned"))?
                .write_all(&wire)
                .context("voice mic write")?;
        }
        Ok(())
    }
}

fn read_loop(mut sock: UnixStream, ev_tx: Sender<VoiceEvent>, mix_tx: Sender<Vec<i16>>, alive: Arc<AtomicBool>) {
    let mut parser = FrameParser::default();
    let mut buf = [0u8; 16 * 1024];
    loop {
        match sock.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for (ty, payload) in parser.push(&buf[..n]) {
                    match ty {
                        CTRL => {
                            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&payload) {
                                match v.get("ev").and_then(|e| e.as_str()) {
                                    Some("status") => {
                                        if let Some(s) = v.get("status") {
                                            if let Ok(st) = serde_json::from_value::<VoiceStatus>(s.clone()) {
                                                let _ = ev_tx.send(VoiceEvent::Status(st));
                                            }
                                        }
                                    }
                                    Some("error") => {
                                        let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("?");
                                        let _ = ev_tx.send(VoiceEvent::Error(msg.to_string()));
                                    }
                                    _ => {}
                                }
                            }
                        }
                        MIX => {
                            let mut frame = Vec::with_capacity(payload.len() / 2);
                            for ch in payload.chunks_exact(2) {
                                frame.push(i16::from_le_bytes([ch[0], ch[1]]));
                            }
                            let _ = mix_tx.send(frame);
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    alive.store(false, Ordering::Relaxed);
    let _ = ev_tx.send(VoiceEvent::Disconnected);
}

// ---------------------------------------------------------------- audio I/O
// cpal capture + rodio playback wrappers — same dedicated-OS-thread model as
// voice.rs. Hardware-dependent; exercised by #[ignore] smokes, not unit tests.

/// Drop to stop the continuous mic capture.
pub struct MicHandle {
    stop: Arc<AtomicBool>,
}

impl Drop for MicHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub fn start_mic(vs: Arc<VoiceStream>) -> Result<MicHandle> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let stop = Arc::new(AtomicBool::new(false));
    let stop_t = stop.clone();
    let (ready_tx, ready_rx) = channel::<Result<()>>();
    std::thread::Builder::new()
        .name("pui-voice-stream-capture".into())
        .spawn(move || {
            let host = cpal::default_host();
            let device = match host.default_input_device() {
                Some(d) => d,
                None => {
                    let _ = ready_tx.send(Err(anyhow!("no input device")));
                    return;
                }
            };
            let config = match device.default_input_config() {
                Ok(c) => c,
                Err(e) => {
                    let _ = ready_tx.send(Err(anyhow!("input config: {e}")));
                    return;
                }
            };
            let rate = config.sample_rate().0;
            let channels = config.channels();
            let vs_cb = vs.clone();
            let stream = device.build_input_stream(
                &config.into(),
                move |data: &[f32], _| {
                    let _ = vs_cb.push_pcm(data, channels, rate);
                },
                |e| eprintln!("voice mic stream error: {e}"),
                None,
            );
            match stream {
                Ok(s) => {
                    if s.play().is_err() {
                        let _ = ready_tx.send(Err(anyhow!("mic play failed")));
                        return;
                    }
                    let _ = ready_tx.send(Ok(()));
                    while !stop_t.load(Ordering::Relaxed) {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    drop(s);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(anyhow!("mic stream: {e}")));
                }
            }
        })
        .context("spawn voice capture")?;
    ready_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .context("mic thread no answer")??;
    Ok(MicHandle { stop })
}

/// Spawn the playback thread: mixed frames → rodio sink. Returns when the
/// output device is open. The thread ends when the mix channel closes.
pub fn start_playback(mix_rx: Receiver<Vec<i16>>) -> Result<()> {
    let (ready_tx, ready_rx) = channel::<Result<()>>();
    std::thread::Builder::new()
        .name("pui-voice-stream-playback".into())
        .spawn(move || {
            let (stream, handle) = match rodio::OutputStream::try_default() {
                Ok(x) => x,
                Err(e) => {
                    let _ = ready_tx.send(Err(anyhow!("output device: {e}")));
                    return;
                }
            };
            let sink = match rodio::Sink::try_new(&handle) {
                Ok(s) => s,
                Err(e) => {
                    let _ = ready_tx.send(Err(anyhow!("sink: {e}")));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(()));
            while let Ok(frame) = mix_rx.recv() {
                // Jitter guard: if playback falls behind (queue growing), drop
                // the oldest queued audio by skipping — keep latency bounded.
                if sink.len() > 6 {
                    continue;
                }
                sink.append(rodio::buffer::SamplesBuffer::new(1, VOICE_RATE, frame));
            }
            drop(stream);
        })
        .context("spawn voice playback")?;
    ready_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .context("playback thread no answer")?
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn resample_identity_and_ratio() {
        let mono: Vec<f32> = (0..480).map(|i| (i as f32) / 480.0).collect();
        assert_eq!(resample_linear(&mono, 48_000, 48_000).len(), 480);
        let up = resample_linear(&mono, 24_000, 48_000);
        assert!((up.len() as i64 - 960).abs() <= 1, "24k→48k doubles: {}", up.len());
        let down = resample_linear(&mono, 48_000, 16_000);
        assert!((down.len() as i64 - 160).abs() <= 1, "48k→16k thirds: {}", down.len());
        // monotone ramp stays monotone under linear interp
        assert!(up.windows(2).all(|w| w[1] >= w[0] - f32::EPSILON));
    }

    #[test]
    fn frame_parser_handles_fragmentation_and_coalescing() {
        let a = encode_frame(CTRL, br#"{"op":"status"}"#);
        let b = encode_frame(MIC, &[1, 2, 3, 4]);
        let mut joined = a.clone();
        joined.extend_from_slice(&b);
        // byte-at-a-time
        let mut p = FrameParser::default();
        let mut got = Vec::new();
        for byte in &joined {
            got.extend(p.push(&[*byte]));
        }
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].0, CTRL);
        assert_eq!(got[1], (MIC, vec![1, 2, 3, 4]));
    }

    /// Mock-operator loopback: CTRL join answered with a status, MIC frames
    /// echoed back as MIX — the full client pipeline without audio hardware.
    #[test]
    fn loopback_against_mock_operator() {
        let dir = std::env::temp_dir().join(format!("pui-voice-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("voice.sock");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();

        // mock operator: parse frames; join → status; MIC → echo as MIX
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut writer = sock.try_clone().unwrap();
            let mut parser = FrameParser::default();
            let mut buf = [0u8; 4096];
            let mut mic_frames = 0usize;
            loop {
                let n = match sock.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                for (ty, payload) in parser.push(&buf[..n]) {
                    match ty {
                        CTRL => {
                            let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
                            if v["op"] == "join" {
                                let status = serde_json::json!({
                                    "ev": "status",
                                    "status": {
                                        "channel": { "id": "vc-1", "name": v["channel"] },
                                        "muted": false,
                                        "peers": [{ "id": "B", "label": "Bob", "muted": false, "speaking": true }],
                                    }
                                });
                                writer.write_all(&encode_frame(CTRL, status.to_string().as_bytes())).unwrap();
                            }
                        }
                        MIC => {
                            mic_frames += 1;
                            writer.write_all(&encode_frame(MIX, &payload)).unwrap();
                        }
                        _ => {}
                    }
                }
                if mic_frames >= 2 {
                    break;
                }
            }
            mic_frames
        });

        let (vs, events, mix) = VoiceStream::connect_to(&path).unwrap();
        vs.join("standup").unwrap();

        let ev = events.recv_timeout(std::time::Duration::from_secs(3)).unwrap();
        match ev {
            VoiceEvent::Status(st) => {
                assert_eq!(st.channel.as_ref().unwrap().id, "vc-1");
                assert_eq!(st.peers.len(), 1);
                assert!(st.peers[0].speaking);
            }
            other => panic!("expected status, got {other:?}"),
        }

        // push 2.5 frames of 48k mono; expect exactly 2 MIC frames shipped,
        // echoed back as 2 MIX frames of FRAME_SAMPLES each.
        let pcm: Vec<f32> = (0..(FRAME_SAMPLES * 5 / 2)).map(|i| ((i % 100) as f32) / 200.0).collect();
        vs.push_pcm(&pcm, 1, VOICE_RATE).unwrap();
        assert!(vs.mic_level() > 0.0);

        let f1 = mix.recv_timeout(std::time::Duration::from_secs(3)).unwrap();
        let f2 = mix.recv_timeout(std::time::Duration::from_secs(3)).unwrap();
        assert_eq!(f1.len(), FRAME_SAMPLES);
        assert_eq!(f2.len(), FRAME_SAMPLES);
        assert_eq!(server.join().unwrap(), 2);

        // half-frame remainder completes on the next push → a third frame
        // would need another server loop; parser-side already covered above.
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn push_pcm_resamples_foreign_rates_into_exact_frames() {
        // 44.1k stereo in → 48k mono frames out; verify via a mock socket pair.
        let dir = std::env::temp_dir().join(format!("pui-voice-test2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("voice.sock");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut parser = FrameParser::default();
            let mut buf = [0u8; 8192];
            let mut frames = Vec::new();
            // 4410 mono samples @44.1k resample to exactly 4800 @48k = 5 frames.
            while frames.len() < 5 {
                let n = match sock.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                for (ty, payload) in parser.push(&buf[..n]) {
                    if ty == MIC {
                        frames.push(payload.len());
                    }
                }
            }
            frames
        });
        let (vs, _events, _mix) = VoiceStream::connect_to(&path).unwrap();
        // 44.1k stereo: 2 interleaved channels → 4410 mono samples → 4800 @48k
        let stereo: Vec<f32> = (0..(4410 * 2)).map(|i| ((i % 7) as f32) / 10.0).collect();
        vs.push_pcm(&stereo, 2, 44_100).unwrap();
        let sizes = server.join().unwrap();
        assert_eq!(sizes.len(), 5, "expected exactly 5 MIC frames, got {}", sizes.len());
        assert!(sizes.iter().all(|s| *s == FRAME_SAMPLES * 2), "exact 1920B frames: {sizes:?}");
        let _ = std::fs::remove_file(&path);
    }
}
