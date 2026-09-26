//! ALSA-free PUI-side voice API. Audio hardware lives in the sibling
//! `pui-audio` process and is reached through the framed stdio protocol.
#![allow(dead_code)]

use crate::audio_proto::{self, Frame};
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc as smpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const WHISPER_RATE: u32 = 16_000;

pub fn mix_to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    let channels = channels.max(1) as usize;
    if channels == 1 {
        return samples.to_vec();
    }
    samples
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

pub fn resample_to_16k(mono: &[f32], src_rate: u32) -> Vec<f32> {
    if mono.is_empty() || src_rate == 0 {
        return Vec::new();
    }
    if src_rate == WHISPER_RATE {
        return mono.to_vec();
    }
    if src_rate > WHISPER_RATE && src_rate.is_multiple_of(WHISPER_RATE) {
        let ratio = (src_rate / WHISPER_RATE) as usize;
        return mono
            .chunks(ratio)
            .map(|chunk| chunk.iter().sum::<f32>() / chunk.len() as f32)
            .collect();
    }
    let ratio = src_rate as f64 / WHISPER_RATE as f64;
    let out_len = (mono.len() as f64 / ratio).floor() as usize;
    (0..out_len)
        .map(|index| {
            let position = index as f64 * ratio;
            let lower = position.floor() as usize;
            let fraction = (position - lower as f64) as f32;
            let a = mono[lower.min(mono.len() - 1)];
            let b = mono[(lower + 1).min(mono.len() - 1)];
            a + (b - a) * fraction
        })
        .collect()
}

pub fn encode_wav_pcm16(samples: &[f32], rate: u32) -> Vec<u8> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec).expect("wav writer");
        for &sample in samples {
            writer
                .write_sample((sample.clamp(-1.0, 1.0) * 32767.0) as i16)
                .expect("wav sample");
        }
        writer.finalize().expect("wav finalize");
    }
    cursor.into_inner()
}

pub fn sine(freq: f32, secs: f32, rate: u32, amp: f32) -> Vec<f32> {
    (0..(secs * rate as f32) as usize)
        .map(|index| (index as f32 / rate as f32 * freq * std::f32::consts::TAU).sin() * amp)
        .collect()
}

pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
}

#[derive(Default, Clone)]
struct Signals {
    level_bits: Option<Arc<AtomicU32>>,
    playing: Option<Arc<AtomicBool>>,
    last_error: Option<Arc<Mutex<Option<String>>>>,
}

type HelperInput = Arc<Mutex<Option<ChildStdin>>>;
type FrameReceiver = smpsc::Receiver<Result<Frame, String>>;

struct HelperPipe {
    input: HelperInput,
    frames: Option<FrameReceiver>,
    close_on_drop: bool,
}

impl HelperPipe {
    fn send(&self, kind: u8, payload: &[u8]) -> Result<()> {
        let mut guard = self
            .input
            .lock()
            .map_err(|_| anyhow!("pui-audio input lock poisoned"))?;
        let input = guard.as_mut().context("pui-audio has already stopped")?;
        audio_proto::write_frame(input, kind, payload).context("write to pui-audio")
    }

    fn close(&self) {
        if let Ok(mut input) = self.input.lock() {
            input.take();
        }
    }

    fn recv_timeout(&self, timeout: Duration) -> Result<Frame> {
        match self
            .frames
            .as_ref()
            .context("pui-audio frame receiver is detached")?
            .recv_timeout(timeout)
        {
            Ok(Ok(frame)) => Ok(frame),
            Ok(Err(error)) => Err(anyhow!(error)),
            Err(smpsc::RecvTimeoutError::Timeout) => Err(anyhow!("pui-audio did not answer")),
            Err(smpsc::RecvTimeoutError::Disconnected) => Err(anyhow!("pui-audio stopped")),
        }
    }

    fn expect_ready(&self) -> Result<()> {
        let frame = self.recv_timeout(Duration::from_secs(5))?;
        match frame.kind {
            audio_proto::READY => Ok(()),
            audio_proto::ERROR => {
                Err(anyhow!(String::from_utf8_lossy(&frame.payload).into_owned()))
            }
            other => Err(anyhow!("pui-audio sent frame {other} before READY")),
        }
    }

    fn detach(mut self) -> (HelperInput, FrameReceiver) {
        self.close_on_drop = false;
        (
            self.input.clone(),
            self.frames.take().expect("frame receiver present"),
        )
    }
}

impl Drop for HelperPipe {
    fn drop(&mut self) {
        if self.close_on_drop {
            self.close();
        }
    }
}

fn helper_path() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("PUI_AUDIO_HELPER").filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let exe = std::env::current_exe().context("resolve the running pui path")?;
    let mut directory = exe.parent().context("the running pui path has no parent")?;
    if directory.file_name().is_some_and(|name| name == "deps") {
        directory = directory
            .parent()
            .context("the Cargo deps path has no target parent")?;
    }
    Ok(directory.join("pui-audio"))
}

fn format_helper_failure(path: &Path, code: Option<i32>, stderr: &str) -> String {
    if code == Some(127) || stderr.contains("libasound.so") {
        return "voice is unavailable because the ALSA sound library is missing; install libasound2 (Debian/Ubuntu: sudo apt install libasound2t64), then retry".into();
    }
    let detail = stderr.trim();
    if detail.is_empty() {
        format!(
            "pui-audio at {} exited with status {:?}",
            path.display(),
            code
        )
    } else {
        format!("pui-audio at {} failed: {detail}", path.display())
    }
}

fn spawn_helper_at(path: &Path, args: &[String], signals: Signals) -> Result<HelperPipe> {
    let mut child = Command::new(path)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| {
            format!(
                "voice is unavailable because pui-audio could not start at {}; reinstall PUI",
                path.display()
            )
        })?;
    let input = Arc::new(Mutex::new(child.stdin.take()));
    let mut output = child
        .stdout
        .take()
        .context("pui-audio stdout was not piped")?;
    let mut stderr = child
        .stderr
        .take()
        .context("pui-audio stderr was not piped")?;
    let (frames_tx, frames_rx) = smpsc::channel();
    let path = path.to_path_buf();
    std::thread::Builder::new()
        .name("pui-audio-reader".into())
        .spawn(move || {
            let stderr_reader = std::thread::spawn(move || {
                let mut text = String::new();
                let _ = stderr.read_to_string(&mut text);
                text
            });
            loop {
                match audio_proto::read_frame(&mut output) {
                    Ok(Some(frame)) => {
                        match frame.kind {
                            audio_proto::LEVEL if frame.payload.len() == 4 => {
                                if let Some(level) = &signals.level_bits {
                                    level.store(
                                        u32::from_le_bytes(frame.payload[..4].try_into().unwrap()),
                                        Ordering::Relaxed,
                                    );
                                }
                                continue;
                            }
                            audio_proto::STATE => {
                                if let Some(playing) = &signals.playing {
                                    playing.store(frame.payload == b"playing", Ordering::Relaxed);
                                }
                                continue;
                            }
                            audio_proto::ERROR => {
                                if let Some(last_error) = &signals.last_error {
                                    if let Ok(mut slot) = last_error.lock() {
                                        *slot = Some(
                                            String::from_utf8_lossy(&frame.payload).into_owned(),
                                        );
                                    }
                                }
                            }
                            audio_proto::READY => {
                                if let Some(last_error) = &signals.last_error {
                                    if let Ok(mut slot) = last_error.lock() {
                                        *slot = None;
                                    }
                                }
                            }
                            _ => {}
                        }
                        if frames_tx.send(Ok(frame)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = frames_tx.send(Err(format!("read pui-audio frame: {error}")));
                        break;
                    }
                }
            }
            let status = child.wait().ok();
            let stderr = stderr_reader.join().unwrap_or_default();
            if status.as_ref().is_some_and(|status| !status.success()) {
                let message =
                    format_helper_failure(&path, status.and_then(|status| status.code()), &stderr);
                if let Some(last_error) = &signals.last_error {
                    if let Ok(mut slot) = last_error.lock() {
                        *slot = Some(message.clone());
                    }
                }
                let _ = frames_tx.send(Err(message));
            }
        })
        .context("spawn pui-audio reader")?;
    Ok(HelperPipe {
        input,
        frames: Some(frames_rx),
        close_on_drop: true,
    })
}

fn spawn_helper(args: &[String], signals: Signals) -> Result<HelperPipe> {
    spawn_helper_at(&helper_path()?, args, signals)
}

#[derive(Debug)]
pub struct CaptureResult {
    pub wav: Vec<u8>,
    pub seconds: f32,
    pub src_rate: u32,
    pub device: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureMeta {
    seconds: f32,
    src_rate: u32,
    device: String,
}

pub struct CaptureSession {
    helper: HelperPipe,
    level_bits: Arc<AtomicU32>,
    started: Instant,
}

impl CaptureSession {
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level_bits.load(Ordering::Relaxed))
    }
    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }
    pub fn finish(self) -> Result<CaptureResult> {
        self.helper.close();
        let mut meta = None;
        let mut wav = None;
        while meta.is_none() || wav.is_none() {
            let frame = self.helper.recv_timeout(Duration::from_secs(10))?;
            match frame.kind {
                audio_proto::CAPTURE_META => {
                    meta = Some(serde_json::from_slice::<CaptureMeta>(&frame.payload)?)
                }
                audio_proto::CAPTURE_WAV => wav = Some(frame.payload),
                audio_proto::ERROR => {
                    return Err(anyhow!(String::from_utf8_lossy(&frame.payload).into_owned()))
                }
                _ => {}
            }
        }
        let meta = meta.unwrap();
        Ok(CaptureResult {
            wav: wav.unwrap(),
            seconds: meta.seconds,
            src_rate: meta.src_rate,
            device: meta.device,
        })
    }
    pub fn cancel(self) {
        self.helper.close();
    }
}

pub fn start_capture() -> Result<CaptureSession> {
    let level_bits = Arc::new(AtomicU32::new(0));
    let helper = spawn_helper(
        &["capture-ptt".into()],
        Signals {
            level_bits: Some(level_bits.clone()),
            ..Signals::default()
        },
    )?;
    helper.expect_ready()?;
    Ok(CaptureSession {
        helper,
        level_bits,
        started: Instant::now(),
    })
}

pub struct StreamCapture {
    input: Arc<Mutex<Option<ChildStdin>>>,
    level_bits: Arc<AtomicU32>,
    chunks_rx: Option<smpsc::Receiver<Vec<u8>>>,
}

impl StreamCapture {
    pub fn take_chunks(&mut self) -> Option<smpsc::Receiver<Vec<u8>>> {
        self.chunks_rx.take()
    }
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level_bits.load(Ordering::Relaxed))
    }
    pub fn stop(&self) {
        if let Ok(mut input) = self.input.lock() {
            input.take();
        }
    }
}

impl Drop for StreamCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn start_stream_capture(chunk_ms: u32) -> Result<StreamCapture> {
    let level_bits = Arc::new(AtomicU32::new(0));
    let helper = spawn_helper(
        &["capture-stream".into(), chunk_ms.max(20).to_string()],
        Signals {
            level_bits: Some(level_bits.clone()),
            ..Signals::default()
        },
    )?;
    helper.expect_ready()?;
    let (input, frames) = helper.detach();
    let (chunks_tx, chunks_rx) = smpsc::channel();
    std::thread::spawn(move || {
        while let Ok(event) = frames.recv() {
            match event {
                Ok(frame) if frame.kind == audio_proto::PCM16_CHUNK => {
                    if chunks_tx.send(frame.payload).is_err() {
                        return;
                    }
                }
                Ok(_) => {}
                Err(_) => return,
            }
        }
    });
    Ok(StreamCapture {
        input,
        level_bits,
        chunks_rx: Some(chunks_rx),
    })
}

enum PlayerCmd {
    Play(Vec<u8>),
    AppendPcm { samples: Vec<i16>, rate: u32 },
    AppendEncoded(Vec<u8>),
    Stop,
}

#[derive(Clone)]
pub struct Player {
    tx: smpsc::Sender<PlayerCmd>,
    playing: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl Player {
    pub fn spawn() -> Self {
        let (tx, rx) = smpsc::channel();
        let playing = Arc::new(AtomicBool::new(false));
        let last_error = Arc::new(Mutex::new(None));
        let thread_playing = playing.clone();
        let thread_error = last_error.clone();
        std::thread::spawn(move || player_proxy_thread(rx, thread_playing, thread_error));
        Self {
            tx,
            playing,
            last_error,
        }
    }
    pub fn play(&self, bytes: Vec<u8>) {
        let _ = self.tx.send(PlayerCmd::Play(bytes));
    }
    pub fn append_pcm(&self, samples: Vec<i16>, rate: u32) {
        let _ = self.tx.send(PlayerCmd::AppendPcm { samples, rate });
    }
    pub fn append_encoded(&self, bytes: Vec<u8>) {
        let _ = self.tx.send(PlayerCmd::AppendEncoded(bytes));
    }
    pub fn stop(&self) {
        let _ = self.tx.send(PlayerCmd::Stop);
    }
    pub fn is_playing(&self) -> bool {
        self.playing.load(Ordering::Relaxed)
    }
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|error| error.clone())
    }
}

fn player_proxy_thread(
    commands: smpsc::Receiver<PlayerCmd>,
    playing: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
) {
    let signals = Signals {
        playing: Some(playing.clone()),
        last_error: Some(last_error.clone()),
        ..Signals::default()
    };
    let mut helper: Option<HelperPipe> = None;
    while let Ok(command) = commands.recv() {
        if helper.is_none() {
            match spawn_helper(&["play".into()], signals.clone()).and_then(|pipe| {
                pipe.expect_ready()?;
                Ok(pipe)
            }) {
                Ok(pipe) => helper = Some(pipe),
                Err(error) => {
                    if let Ok(mut slot) = last_error.lock() {
                        *slot = Some(format!("{error:#}"));
                    }
                    continue;
                }
            }
        }
        let (kind, payload) = match command {
            PlayerCmd::Play(bytes) => (audio_proto::PLAY_REPLACE, bytes),
            PlayerCmd::AppendEncoded(bytes) => (audio_proto::PLAY_APPEND_ENCODED, bytes),
            PlayerCmd::AppendPcm { samples, rate } => {
                let mut payload = Vec::with_capacity(4 + samples.len() * 2);
                payload.extend_from_slice(&rate.to_le_bytes());
                payload.extend(samples.into_iter().flat_map(i16::to_le_bytes));
                (audio_proto::PLAY_APPEND_PCM, payload)
            }
            PlayerCmd::Stop => (audio_proto::PLAY_STOP, Vec::new()),
        };
        if helper
            .as_ref()
            .is_some_and(|pipe| pipe.send(kind, &payload).is_err())
        {
            playing.store(false, Ordering::Relaxed);
            helper = None;
        }
    }
}

#[derive(Deserialize)]
struct Devices {
    inputs: Vec<String>,
    outputs: Vec<String>,
}

pub fn list_devices() -> (Vec<String>, Vec<String>) {
    let result = (|| -> Result<Devices> {
        let helper = spawn_helper(&["devices".into()], Signals::default())?;
        let frame = helper.recv_timeout(Duration::from_secs(5))?;
        if frame.kind == audio_proto::ERROR {
            return Err(anyhow!(String::from_utf8_lossy(&frame.payload).into_owned()));
        }
        if frame.kind != audio_proto::DEVICES {
            return Err(anyhow!(
                "pui-audio sent frame {} instead of DEVICES",
                frame.kind
            ));
        }
        Ok(serde_json::from_slice(&frame.payload)?)
    })();
    match result {
        Ok(devices) => (devices.inputs, devices.outputs),
        Err(error) => {
            eprintln!("pui voice devices unavailable: {error:#}");
            (Vec::new(), Vec::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn dsp_remains_in_the_alsa_free_parent() {
        let stereo = [1.0, 0.0, 0.5, 0.5, -1.0, 1.0];
        assert_eq!(mix_to_mono(&stereo, 2), vec![0.5, 0.5, 0.0]);
        let tone = sine(440.0, 1.0, 48_000, 0.8);
        assert_eq!(resample_to_16k(&tone, 48_000).len(), 16_000);
        assert!(!encode_wav_pcm16(&tone[..160], WHISPER_RATE).is_empty());
    }

    #[test]
    fn exit_127_from_fake_helper_names_the_alsa_remedy() {
        let dir = tempfile::tempdir().unwrap();
        let helper = dir.path().join("pui-audio");
        std::fs::write(
            &helper,
            "#!/bin/sh\necho 'error while loading shared libraries: libasound.so.2' >&2\nexit 127\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&helper).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&helper, permissions).unwrap();
        let pipe = spawn_helper_at(&helper, &["capture-ptt".into()], Signals::default()).unwrap();
        let error = pipe.recv_timeout(Duration::from_secs(2)).unwrap_err();
        assert!(format!("{error:#}").contains("install libasound2"));
    }
}
