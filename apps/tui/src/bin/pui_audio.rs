//! Runtime-optional audio process. Keeping every cpal/rodio reference in this
//! binary lets `pui` start on machines without ALSA; only voice needs it.

#[path = "../audio_proto.rs"]
mod audio_proto;
#[path = "../voice.rs"]
mod voice_backend;

use anyhow::{anyhow, Context, Result};
use audio_proto::*;
use serde::Serialize;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureMeta<'a> {
    seconds: f32,
    src_rate: u32,
    device: &'a str,
}

fn main() {
    let command = std::env::args().nth(1).unwrap_or_default();
    let result = match command.as_str() {
        "capture-ptt" => capture_ptt(),
        "capture-stream" => {
            let chunk_ms = std::env::args()
                .nth(2)
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(100);
            capture_stream(chunk_ms)
        }
        "play" => play(),
        "devices" => devices(),
        _ => Err(anyhow!(
            "usage: pui-audio <capture-ptt|capture-stream [chunk-ms]|play|devices>"
        )),
    };
    if let Err(error) = result {
        let message = format!("{error:#}");
        let _ = write_frame(std::io::stdout().lock(), ERROR, message.as_bytes());
        eprintln!("pui-audio: {message}");
        std::process::exit(1);
    }
}

fn stdin_eof_flag() -> Arc<AtomicBool> {
    let done = Arc::new(AtomicBool::new(false));
    let signal = done.clone();
    std::thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = std::io::stdin().read_to_end(&mut sink);
        signal.store(true, Ordering::Relaxed);
    });
    done
}

fn capture_ptt() -> Result<()> {
    let session = voice_backend::start_capture()?;
    let stop = stdin_eof_flag();
    let mut stdout = std::io::stdout().lock();
    write_frame(&mut stdout, READY, b"{}")?;
    while !stop.load(Ordering::Relaxed) {
        write_frame(&mut stdout, LEVEL, &session.level().to_le_bytes())?;
        std::thread::sleep(Duration::from_millis(50));
    }
    let result = session.finish()?;
    let meta = serde_json::to_vec(&CaptureMeta {
        seconds: result.seconds,
        src_rate: result.src_rate,
        device: &result.device,
    })?;
    write_frame(&mut stdout, CAPTURE_META, &meta)?;
    write_frame(&mut stdout, CAPTURE_WAV, &result.wav)?;
    Ok(())
}

fn capture_stream(chunk_ms: u32) -> Result<()> {
    let mut capture = voice_backend::start_stream_capture(chunk_ms)?;
    let chunks = capture
        .take_chunks()
        .context("audio capture did not expose its chunk stream")?;
    let stop = stdin_eof_flag();
    let mut stdout = std::io::stdout().lock();
    write_frame(&mut stdout, READY, b"{}")?;
    while !stop.load(Ordering::Relaxed) {
        match chunks.recv_timeout(Duration::from_millis(50)) {
            Ok(bytes) => {
                write_frame(&mut stdout, PCM16_CHUNK, &bytes)?;
                let samples: Vec<f32> = bytes
                    .chunks_exact(2)
                    .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0)
                    .collect();
                write_frame(
                    &mut stdout,
                    LEVEL,
                    &voice_backend::rms(&samples).to_le_bytes(),
                )?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    capture.stop();
    Ok(())
}

fn play() -> Result<()> {
    let player = voice_backend::Player::spawn();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        loop {
            match read_frame(&mut stdin) {
                Ok(Some(frame)) => {
                    if tx.send(frame).is_err() {
                        return;
                    }
                }
                _ => return,
            }
        }
    });
    let mut stdout = std::io::stdout().lock();
    write_frame(&mut stdout, READY, b"{}")?;
    let mut last_state = false;
    let mut last_error = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(frame) => match frame.kind {
                PLAY_REPLACE => player.play(frame.payload),
                PLAY_APPEND_ENCODED => player.append_encoded(frame.payload),
                PLAY_APPEND_PCM => {
                    if frame.payload.len() < 4 {
                        return Err(anyhow!("APPEND_PCM frame lacks its sample rate"));
                    }
                    let rate = u32::from_le_bytes(frame.payload[..4].try_into().unwrap());
                    let samples = frame.payload[4..]
                        .chunks_exact(2)
                        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
                        .collect();
                    player.append_pcm(samples, rate);
                }
                PLAY_STOP => player.stop(),
                other => return Err(anyhow!("unknown playback frame type {other}")),
            },
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
        let error = player.last_error();
        if error != last_error {
            if let Some(error) = error.as_deref() {
                write_frame(&mut stdout, ERROR, error.as_bytes())?;
            }
            last_error = error;
        }
        let state = player.is_playing();
        if state != last_state {
            write_frame(&mut stdout, STATE, if state { b"playing" } else { b"idle" })?;
            last_state = state;
        }
    }
}

fn devices() -> Result<()> {
    let (inputs, outputs) = voice_backend::list_devices();
    let payload = serde_json::to_vec(&serde_json::json!({
        "inputs": inputs,
        "outputs": outputs,
    }))?;
    write_frame(std::io::stdout().lock(), DEVICES, &payload).context("write device list")
}
