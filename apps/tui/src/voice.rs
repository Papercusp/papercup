//! Voice mode (PTT) — the Rust audio stack (voice-mode-tui-port-2026-06-05 P0).
//!
//! Capture: cpal (default input device → PipeWire default source) → mono mix →
//! 16 kHz resample → PCM16 WAV (hound) — the exact shape the voicemode Whisper
//! `/v1/audio/transcriptions` endpoint wants (the browser PTT path sends
//! `f32ToWav(pcm16k, 16000)` — we mirror it).
//!
//! Playback: rodio (wav from kokoro, mp3 from the cloud engines).
//!
//! Threading: cpal `Stream` and rodio `OutputStream` are `!Send`, so each side
//! lives on a dedicated OS thread behind a command channel; the handles
//! (`CaptureSession`, `Player`) are `Send` and own no audio objects. `App`
//! stays pure — main.rs drives these from the run loop (plan D-007).
//!
//! Device disambiguation (this box has the Brio + several USB codecs): we take
//! the PipeWire *default* source/sink (what `pactl get-default-source` says —
//! the Brio here), with `PUI_VOICE_INPUT` / `PUI_VOICE_OUTPUT` env overrides
//! matching a cpal device-name substring for setups where the default is wrong.
#![allow(dead_code)] // P2 consumes the full surface as the PTT loop lands.

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc as smpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Whisper's native sample rate — the capture pipeline's output rate.
pub const WHISPER_RATE: u32 = 16_000;

// ─────────────────────────── pure DSP (unit-tested) ───────────────────────────

/// Interleaved multi-channel f32 → mono by averaging each frame's channels.
pub fn mix_to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    let ch = channels.max(1) as usize;
    if ch == 1 {
        return samples.to_vec();
    }
    samples
        .chunks(ch)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

/// Resample mono f32 to 16 kHz. Integer downsample ratios use boxcar-average
/// decimation (the averaging doubles as a crude anti-alias low-pass — plenty
/// for PTT speech into Whisper); everything else uses linear interpolation.
pub fn resample_to_16k(mono: &[f32], src_rate: u32) -> Vec<f32> {
    if mono.is_empty() || src_rate == 0 {
        return Vec::new();
    }
    if src_rate == WHISPER_RATE {
        return mono.to_vec();
    }
    if src_rate > WHISPER_RATE && src_rate % WHISPER_RATE == 0 {
        let ratio = (src_rate / WHISPER_RATE) as usize;
        return mono
            .chunks(ratio)
            .map(|c| c.iter().sum::<f32>() / c.len() as f32)
            .collect();
    }
    let ratio = src_rate as f64 / WHISPER_RATE as f64;
    let out_len = (mono.len() as f64 / ratio).floor() as usize;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let i0 = pos.floor() as usize;
            let frac = (pos - i0 as f64) as f32;
            let a = mono[i0.min(mono.len() - 1)];
            let b = mono[(i0 + 1).min(mono.len() - 1)];
            a + (b - a) * frac
        })
        .collect()
}

/// Encode mono f32 (−1..1) as a PCM16 WAV byte buffer at `rate`.
pub fn encode_wav_pcm16(samples: &[f32], rate: u32) -> Vec<u8> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cur = std::io::Cursor::new(Vec::new());
    {
        // In-memory writer can't fail on IO; unwraps are spec-correctness only.
        let mut w = hound::WavWriter::new(&mut cur, spec).expect("wav writer");
        for &s in samples {
            let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            w.write_sample(v).expect("wav sample");
        }
        w.finalize().expect("wav finalize");
    }
    cur.into_inner()
}

/// Synthesize a sine tone (test/smoke helper).
pub fn sine(freq: f32, secs: f32, rate: u32, amp: f32) -> Vec<f32> {
    let n = (secs * rate as f32) as usize;
    (0..n)
        .map(|i| (i as f32 / rate as f32 * freq * std::f32::consts::TAU).sin() * amp)
        .collect()
}

/// Root-mean-square level of a chunk (the mic meter's unit).
pub fn rms(chunk: &[f32]) -> f32 {
    if chunk.is_empty() {
        return 0.0;
    }
    (chunk.iter().map(|s| s * s).sum::<f32>() / chunk.len() as f32).sqrt()
}

// ─────────────────────────────── capture side ───────────────────────────────

/// What a finished recording yields: the Whisper-ready WAV + provenance.
#[derive(Debug)]
pub struct CaptureResult {
    /// 16 kHz mono PCM16 WAV bytes.
    pub wav: Vec<u8>,
    /// Captured length in seconds (at the source rate, pre-resample).
    pub seconds: f32,
    /// The device's native sample rate the audio was captured at.
    pub src_rate: u32,
    /// The cpal device name that captured it.
    pub device: String,
}

enum CaptureCmd {
    /// Stop and deliver the encoded result.
    Finish,
    /// Stop and discard.
    Cancel,
}

/// Handle to one in-flight PTT recording. The cpal stream lives on a dedicated
/// thread; this handle is Send (main.rs finishes it in `spawn_blocking`).
pub struct CaptureSession {
    cmd_tx: smpsc::Sender<CaptureCmd>,
    done_rx: smpsc::Receiver<Result<CaptureResult>>,
    level_bits: Arc<AtomicU32>,
    started: Instant,
}

impl CaptureSession {
    /// Latest mic RMS level (0..~1) — written by the audio callback, read on
    /// UI ticks. No event spam (plan D-007).
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level_bits.load(Ordering::Relaxed))
    }

    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    /// Stop recording, resample + encode, and return the WAV. Blocks briefly
    /// (ms-scale DSP) — call from `spawn_blocking`, not the UI thread.
    pub fn finish(self) -> Result<CaptureResult> {
        let _ = self.cmd_tx.send(CaptureCmd::Finish);
        self.done_rx
            .recv_timeout(Duration::from_secs(10))
            .context("capture thread did not deliver a result")?
    }

    /// Stop recording and discard the audio (Esc while recording).
    pub fn cancel(self) {
        let _ = self.cmd_tx.send(CaptureCmd::Cancel);
        // Best-effort: wait for the thread to wind down so the stream closes
        // before a new session could open the device again.
        let _ = self.done_rx.recv_timeout(Duration::from_secs(2));
    }
}

/// Open the input device and start recording. Device pick: `PUI_VOICE_INPUT`
/// env substring match when set, else the cpal/PipeWire default source.
pub fn start_capture() -> Result<CaptureSession> {
    let (cmd_tx, cmd_rx) = smpsc::channel::<CaptureCmd>();
    let (done_tx, done_rx) = smpsc::channel::<Result<CaptureResult>>();
    let (ready_tx, ready_rx) = smpsc::channel::<Result<()>>();
    let level_bits = Arc::new(AtomicU32::new(0));
    let level_for_thread = level_bits.clone();

    std::thread::Builder::new()
        .name("pui-voice-capture".into())
        .spawn(move || capture_thread(cmd_rx, done_tx, ready_tx, level_for_thread))
        .context("spawn capture thread")?;

    // Surface device/stream-open failures at start (not at finish) so the UI
    // can show "mic unavailable" immediately.
    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(CaptureSession {
            cmd_tx,
            done_rx,
            level_bits,
            started: Instant::now(),
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(anyhow!("capture thread did not signal readiness")),
    }
}

fn capture_thread(
    cmd_rx: smpsc::Receiver<CaptureCmd>,
    done_tx: smpsc::Sender<Result<CaptureResult>>,
    ready_tx: smpsc::Sender<Result<()>>,
    level_bits: Arc<AtomicU32>,
) {
    let setup = (|| -> Result<(cpal::Device, cpal::SupportedStreamConfig, String)> {
        let host = cpal::default_host();
        let device = pick_device(
            host.input_devices().context("enumerate input devices")?,
            host.default_input_device(),
            std::env::var("PUI_VOICE_INPUT").ok().as_deref(),
        )
        .ok_or_else(|| anyhow!("no input (mic) device available"))?;
        let name = device.name().unwrap_or_else(|_| "<unknown>".into());
        let config = device
            .default_input_config()
            .with_context(|| format!("default input config for {name}"))?;
        Ok((device, config, name))
    })();

    let (device, config, name) = match setup {
        Ok(t) => t,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };

    let src_rate = config.sample_rate().0;
    let channels = config.channels();
    let buf: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

    let stream = {
        let buf = buf.clone();
        let level = level_bits.clone();
        let on_err = |e: cpal::StreamError| {
            // Capture errors mid-stream surface as a short recording; the
            // status line shows whatever Whisper makes of it.
            eprintln!("pui voice capture stream error: {e}");
        };
        let push = move |chunk: Vec<f32>| {
            level.store(rms(&chunk).to_bits(), Ordering::Relaxed);
            if let Ok(mut b) = buf.lock() {
                b.extend_from_slice(&chunk);
            }
        };
        match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config.clone().into(),
                move |data: &[f32], _| push(data.to_vec()),
                on_err,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config.clone().into(),
                move |data: &[i16], _| {
                    push(data.iter().map(|&s| s as f32 / 32768.0).collect())
                },
                on_err,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &config.clone().into(),
                move |data: &[u16], _| {
                    push(
                        data.iter()
                            .map(|&s| (s as f32 - 32768.0) / 32768.0)
                            .collect(),
                    )
                },
                on_err,
                None,
            ),
            other => {
                let _ = ready_tx.send(Err(anyhow!("unsupported sample format {other:?}")));
                return;
            }
        }
    };

    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(anyhow!("open input stream on {name}: {e}")));
            return;
        }
    };
    if let Err(e) = stream.play() {
        let _ = ready_tx.send(Err(anyhow!("start input stream on {name}: {e}")));
        return;
    }
    let _ = ready_tx.send(Ok(()));

    // Record until told otherwise. A dropped handle (sender gone) cancels.
    let cmd = cmd_rx.recv().unwrap_or(CaptureCmd::Cancel);
    drop(stream); // close the device before the (ms-scale) DSP below

    match cmd {
        CaptureCmd::Cancel => {
            let _ = done_tx.send(Err(anyhow!("recording cancelled")));
        }
        CaptureCmd::Finish => {
            let samples = buf.lock().map(|b| b.clone()).unwrap_or_default();
            let seconds = if src_rate > 0 && channels > 0 {
                samples.len() as f32 / channels as f32 / src_rate as f32
            } else {
                0.0
            };
            let mono = mix_to_mono(&samples, channels);
            let s16k = resample_to_16k(&mono, src_rate);
            let wav = encode_wav_pcm16(&s16k, WHISPER_RATE);
            let _ = done_tx.send(Ok(CaptureResult {
                wav,
                seconds,
                src_rate,
                device: name,
            }));
        }
    }
}

/// Pick a device: name-substring override first (case-insensitive), else the
/// host default. Shared by capture (input) and playback (output).
fn pick_device<I>(devices: I, default: Option<cpal::Device>, want: Option<&str>) -> Option<cpal::Device>
where
    I: Iterator<Item = cpal::Device>,
{
    if let Some(want) = want.filter(|w| !w.trim().is_empty()) {
        let want_lc = want.to_lowercase();
        for d in devices {
            if d.name()
                .map(|n| n.to_lowercase().contains(&want_lc))
                .unwrap_or(false)
            {
                return Some(d);
            }
        }
        // Fall through to default when the override matches nothing — a wrong
        // env var shouldn't brick voice entirely.
    }
    default
}

/// Names of available input/output devices (the `:voice-devices` palette /
/// smoke diagnostics).
pub fn list_devices() -> (Vec<String>, Vec<String>) {
    let host = cpal::default_host();
    let name_of = |d: cpal::Device| d.name().unwrap_or_else(|_| "<unknown>".into());
    let inputs = host
        .input_devices()
        .map(|it| it.map(name_of).collect())
        .unwrap_or_default();
    let outputs = host
        .output_devices()
        .map(|it| it.map(name_of).collect())
        .unwrap_or_default();
    (inputs, outputs)
}

// ─────────────────────────────── playback side ───────────────────────────────

enum PlayerCmd {
    /// Decode + play these audio bytes (wav/mp3), replacing anything playing.
    Play(Vec<u8>),
    /// Stop playback now.
    Stop,
}

/// Long-lived playback handle. The rodio `OutputStream` lives on its thread;
/// the handle is Send + cheap to clone into async tasks.
#[derive(Clone)]
pub struct Player {
    tx: smpsc::Sender<PlayerCmd>,
    playing: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl Player {
    /// Spawn the playback thread. The output device opens lazily on first
    /// play (so a missing sound card only breaks playback, not startup).
    pub fn spawn() -> Player {
        let (tx, rx) = smpsc::channel::<PlayerCmd>();
        let playing = Arc::new(AtomicBool::new(false));
        let last_error = Arc::new(Mutex::new(None));
        let p = playing.clone();
        let le = last_error.clone();
        let _ = std::thread::Builder::new()
            .name("pui-voice-playback".into())
            .spawn(move || player_thread(rx, p, le));
        Player {
            tx,
            playing,
            last_error,
        }
    }

    /// Play audio bytes (wav or mp3), stopping anything currently playing.
    pub fn play(&self, bytes: Vec<u8>) {
        let _ = self.tx.send(PlayerCmd::Play(bytes));
    }

    /// Stop playback (barge-in / Esc).
    pub fn stop(&self) {
        let _ = self.tx.send(PlayerCmd::Stop);
    }

    pub fn is_playing(&self) -> bool {
        self.playing.load(Ordering::Relaxed)
    }

    /// The most recent playback error, if any (cleared on a successful play).
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|g| g.clone())
    }
}

fn player_thread(
    rx: smpsc::Receiver<PlayerCmd>,
    playing: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
) {
    let set_err = |msg: Option<String>| {
        if let Ok(mut g) = last_error.lock() {
            *g = msg;
        }
    };
    // (OutputStream, handle) must outlive every sink — created lazily, kept
    // for the thread's life. `OutputStream` is !Send; it never leaves here.
    let mut output: Option<(rodio::OutputStream, rodio::OutputStreamHandle)> = None;
    let mut sink: Option<rodio::Sink> = None;

    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(PlayerCmd::Play(bytes)) => {
                if let Some(s) = sink.take() {
                    s.stop();
                }
                if output.is_none() {
                    let want = std::env::var("PUI_VOICE_OUTPUT").ok();
                    let opened = match want.as_deref().filter(|w| !w.trim().is_empty()) {
                        Some(w) => {
                            let host = cpal::default_host();
                            let dev = host
                                .output_devices()
                                .ok()
                                .and_then(|it| pick_device(it, host.default_output_device(), Some(w)));
                            match dev {
                                Some(d) => rodio::OutputStream::try_from_device(&d),
                                None => rodio::OutputStream::try_default(),
                            }
                        }
                        None => rodio::OutputStream::try_default(),
                    };
                    match opened {
                        Ok(pair) => output = Some(pair),
                        Err(e) => {
                            set_err(Some(format!("open output device: {e}")));
                            continue;
                        }
                    }
                }
                let handle = &output.as_ref().expect("output opened above").1;
                match rodio::Decoder::new(std::io::Cursor::new(bytes)) {
                    Ok(source) => match rodio::Sink::try_new(handle) {
                        Ok(s) => {
                            s.append(source);
                            playing.store(true, Ordering::Relaxed);
                            set_err(None);
                            sink = Some(s);
                        }
                        Err(e) => set_err(Some(format!("audio sink: {e}"))),
                    },
                    Err(e) => set_err(Some(format!("decode audio: {e}"))),
                }
            }
            Ok(PlayerCmd::Stop) => {
                if let Some(s) = sink.take() {
                    s.stop();
                }
                playing.store(false, Ordering::Relaxed);
            }
            Err(smpsc::RecvTimeoutError::Timeout) => {
                if playing.load(Ordering::Relaxed)
                    && sink.as_ref().map(|s| s.empty()).unwrap_or(true)
                {
                    playing.store(false, Ordering::Relaxed);
                    sink = None;
                }
            }
            Err(smpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

// ────────────────────────────────── tests ──────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_wav(bytes: &[u8]) -> (hound::WavSpec, Vec<i16>) {
        let mut r = hound::WavReader::new(std::io::Cursor::new(bytes)).expect("wav reader");
        let spec = r.spec();
        let samples = r.samples::<i16>().map(|s| s.unwrap()).collect();
        (spec, samples)
    }

    /// Dominant frequency estimate by zero-crossing count.
    fn zero_cross_freq(samples: &[f32], rate: u32) -> f32 {
        if samples.len() < 2 {
            return 0.0;
        }
        let crossings = samples
            .windows(2)
            .filter(|w| (w[0] >= 0.0) != (w[1] >= 0.0))
            .count();
        crossings as f32 / 2.0 / (samples.len() as f32 / rate as f32)
    }

    #[test]
    fn mono_mix_averages_channels() {
        let stereo = [1.0, 0.0, 0.5, 0.5, -1.0, 1.0];
        assert_eq!(mix_to_mono(&stereo, 2), vec![0.5, 0.5, 0.0]);
        // 1ch passes through.
        assert_eq!(mix_to_mono(&[0.25, -0.25], 1), vec![0.25, -0.25]);
    }

    #[test]
    fn resample_48k_to_16k_decimates_by_3() {
        let tone = sine(440.0, 1.0, 48_000, 0.8);
        let out = resample_to_16k(&tone, 48_000);
        assert_eq!(out.len(), 16_000);
        // The tone survives decimation at the right pitch.
        let f = zero_cross_freq(&out, 16_000);
        assert!((f - 440.0).abs() < 10.0, "expected ~440Hz, got {f}");
    }

    #[test]
    fn resample_44k1_to_16k_linear_interp() {
        let tone = sine(440.0, 1.0, 44_100, 0.8);
        let out = resample_to_16k(&tone, 44_100);
        let expected = 16_000;
        assert!(
            (out.len() as i64 - expected).unsigned_abs() <= 2,
            "len {} !~ {expected}",
            out.len()
        );
        let f = zero_cross_freq(&out, 16_000);
        assert!((f - 440.0).abs() < 10.0, "expected ~440Hz, got {f}");
    }

    #[test]
    fn resample_8k_upsamples() {
        let tone = sine(300.0, 0.5, 8_000, 0.8);
        let out = resample_to_16k(&tone, 8_000);
        assert!((out.len() as i64 - 8_000).unsigned_abs() <= 2);
        let f = zero_cross_freq(&out, 16_000);
        assert!((f - 300.0).abs() < 10.0, "expected ~300Hz, got {f}");
    }

    #[test]
    fn resample_16k_is_identity_and_empty_is_safe() {
        let tone = sine(440.0, 0.1, 16_000, 0.5);
        assert_eq!(resample_to_16k(&tone, 16_000), tone);
        assert!(resample_to_16k(&[], 48_000).is_empty());
        assert!(resample_to_16k(&[0.1], 0).is_empty());
    }

    #[test]
    fn wav_encode_roundtrips_pcm16_mono_16k() {
        let tone = sine(440.0, 0.25, WHISPER_RATE, 0.5);
        let wav = encode_wav_pcm16(&tone, WHISPER_RATE);
        let (spec, samples) = decode_wav(&wav);
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, WHISPER_RATE);
        assert_eq!(spec.bits_per_sample, 16);
        assert_eq!(samples.len(), tone.len());
        // Amplitude survives the f32→i16 quantization.
        let peak = samples.iter().map(|s| s.unsigned_abs()).max().unwrap();
        assert!((peak as f32 / 32767.0 - 0.5).abs() < 0.01);
    }

    #[test]
    fn wav_encode_clamps_overdrive() {
        let wav = encode_wav_pcm16(&[2.0, -2.0], WHISPER_RATE);
        let (_, samples) = decode_wav(&wav);
        assert_eq!(samples, vec![32767, -32767]);
    }

    #[test]
    fn rms_basics() {
        assert_eq!(rms(&[]), 0.0);
        assert!((rms(&[0.5, -0.5, 0.5, -0.5]) - 0.5).abs() < 1e-6);
    }

    // ── hardware smokes (#[ignore] — need a real audio stack; run via
    // `cargo test -- --ignored` inside the isolated null-sink loopback the
    // verification step sets up; see plan P-001/P-004). ──

    /// Capture ~1.5s from the default (or PUI_VOICE_INPUT) device and verify
    /// the pipeline yields a sane 16k mono WAV.
    #[test]
    #[ignore]
    fn smoke_record_yields_16k_wav() {
        let session = start_capture().expect("start capture");
        std::thread::sleep(Duration::from_millis(1500));
        let res = session.finish().expect("finish capture");
        eprintln!(
            "captured {:.2}s at {} Hz from {} → {} wav bytes",
            res.seconds,
            res.src_rate,
            res.device,
            res.wav.len()
        );
        let (spec, samples) = decode_wav(&res.wav);
        assert_eq!(spec.sample_rate, WHISPER_RATE);
        assert_eq!(spec.channels, 1);
        // ~1.5s of 16k audio, generous margin for stream startup latency.
        assert!(
            samples.len() > WHISPER_RATE as usize, // > 1.0s
            "too few samples: {}",
            samples.len()
        );
    }

    /// Play a 440Hz tone through the default (or PUI_VOICE_OUTPUT) device and
    /// verify the playing flag transitions.
    #[test]
    #[ignore]
    fn smoke_play_tone() {
        let tone = sine(440.0, 0.8, WHISPER_RATE, 0.4);
        let wav = encode_wav_pcm16(&tone, WHISPER_RATE);
        let player = Player::spawn();
        player.play(wav);
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            player.is_playing(),
            "player never started: {:?}",
            player.last_error()
        );
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!player.is_playing(), "player never finished");
        assert_eq!(player.last_error(), None);
    }

    /// Full loop: play a tone while recording — requires the loopback routing
    /// (play→null sink, capture→its monitor) the verification shell sets up.
    /// Asserts the captured audio contains the played tone.
    ///
    /// The tone (2.5s) is deliberately LONGER than the capture window (~1.6s) so
    /// the whole recording is steady-state tone — and we estimate the frequency
    /// over the middle 60% only, skipping the stream-startup onset. (A naive
    /// estimate over a buffer with trailing silence reads low: 440·tone/window.)
    #[test]
    #[ignore]
    fn smoke_loopback_tone_roundtrip() {
        let player = Player::spawn();
        let session = start_capture().expect("start capture");
        let tone = sine(440.0, 2.5, WHISPER_RATE, 0.6);
        player.play(encode_wav_pcm16(&tone, WHISPER_RATE));
        std::thread::sleep(Duration::from_millis(1600));
        let res = session.finish().expect("finish capture");
        let (_, samples) = decode_wav(&res.wav);
        let f32s: Vec<f32> = samples.iter().map(|&s| s as f32 / 32768.0).collect();
        let level = rms(&f32s);
        assert!(level > 0.01, "loopback capture is silent (rms {level})");
        // Middle 60% — past the onset, before finish() trims, all tone.
        let lo = f32s.len() * 2 / 10;
        let hi = f32s.len() * 8 / 10;
        let mid = &f32s[lo..hi];
        let f = zero_cross_freq(mid, WHISPER_RATE);
        assert!(
            (f - 440.0).abs() < 40.0,
            "expected ~440Hz in the loopback capture, got {f}"
        );
    }
}
