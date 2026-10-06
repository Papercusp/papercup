# Synthetic-voice round trips — 2026-10-06 (D-006, WI-10006763)

Plan: `voice-final-public-release-2026-10-01`. Decision D-006 adds agent-run synthetic
round trips (Kokoro speech injected as microphone input). Avi's guided real-microphone
session (D-005) remains the final check; nothing here replaces it.

## TUI (`pui`) — PASS

- **Test:** `smoke_speech_roundtrip_via_operator` in `apps/tui/src/voice_proxy.rs`
  (the `pui` binary's `voice` module, which drives the `pui-audio` helper process the
  TUI uses for capture and playback). Unit guards in the same module:
  `streamed_wav_placeholder_sizes_are_rewritten`,
  `speech_word_matching_normalizes_case_and_punctuation`.
- **Runner:** `PUI_SMOKE_TTS_ENGINES=kokoro PUI_OPERATOR=staging PAPERCUSP_REQUIRE_LIVE_VOICE=1 apps/tui/scripts/audio-loopback-smoke.sh`
- **Isolation:** a temporary PipeWire null-sink (`pui_voice_test_<pid>`) routed per process
  through `PULSE_SINK` / `PULSE_SOURCE`. No sound is emitted, and the BRIO/HDMI defaults
  are untouched. The module is unloaded on exit.
- **Operator:** `:3170` (staging operator, build `99100d1029`). The `operator-stt` and
  `operator-tts` proxy routes write no conversation turn.
- **Tree:** superproject `b47ce3957a` plus the uncommitted edits named in WI-10006763.

| Leg | Path | Heard by operator STT | Result |
|---|---|---|---|
| Microphone | Kokoro pangram WAV → PUI player → null-sink → PUI capture (monitor) → `operator-stt` | "The quick brown fox jumps over the lazy dog." (9/9 words) | PASS |
| Reply playback (Kokoro) | `operator-tts` engine=kokoro → PUI player → null-sink → PUI capture → `operator-stt` | "The synthetic reply arrived safely." (5/5 words) | PASS |
| Device smokes | tone loopback, play tone, 16 kHz record | — | PASS (4/4 tests, 21.4 s) |

Logs: `.papercusp/scratch/d006-tui-smoke-run3.log` and `.papercusp/scratch/d006-tui-smoke-run4.log`
(run 3: prefs engine; run 4: explicit kokoro).

Defect found and fixed in the test fixture, not the product: Kokoro streams WAV with
placeholder `0xFFFFFFFF` RIFF and data sizes, which the PUI player rejects
("decode audio: end of stream"). The operator TTS route already rewrites those sizes
(measured: the operator returned RIFF size = length − 8), so TUI replies were never
affected. The smoke now repairs the raw fixture the same way.

### ElevenLabs reply leg — PASS (run 5, 2026-10-06T17:20:58Z–17:21:40Z)

Re-run once `:3170` carried the D-007 availability change
(`packages/operator-core/lib/voice-release-availability.ts`; `dev:pipeline_position` reported
`staging-operator` build `428bcb7c23` `containsChange: true`). Run 4's `:3170` build
`99100d1029` predated it and answered 400 "not available in this release".

- **Runner:** `PUI_SMOKE_TTS_ENGINES=kokoro,elevenlabs PUI_OPERATOR=staging PAPERCUSP_REQUIRE_LIVE_VOICE=1 bash apps/tui/scripts/audio-loopback-smoke.sh`

| Leg | Heard by operator STT | Result |
|---|---|---|
| Microphone (Kokoro pangram) | "The quick brown fox jumps over the lazy dog." (9/9 words) | PASS |
| Reply playback (Kokoro) | "The synthetic reply arrived safely." (5/5 words) | PASS |
| Reply playback (ElevenLabs) | "The synthetic reply arrived safely." (5/5 words) | PASS |
| Device smokes | — | PASS (4/4 tests, 24.4 s) |

Log: `.papercusp/scratch/d006-tui-el-run1.log` (`EXIT=0`).

## Desktop — in progress

The Playwright spec `apps/operator/e2e/voice-synthetic-roundtrip.spec.ts` runs inside an
isolated `scripts/verify-tauri-headless.sh` rig (isolated database and WebView profile).
Run 1 failed before boot: the rig's frozen source snapshot caught a peer's half-finished
edit. Runs 2–3 exposed two harness defects, both fixed: the SPA rebuild stamp predated the
sources the build read (WI-10006797), and Playwright's `response.body()` returns an empty body
for audio the page plays as media, so the spec now captures TTS bytes with
`page.route` + `route.fetch`.

### Run 4 (2026-10-06T17:42:36Z, run `20261006T174240Z-575393`)

| Leg | Result |
|---|---|
| Push-to-talk: fake-mic Kokoro pangram → real PTT path → local Whisper | PASS |
| Reply playback (Kokoro): `speak()` → `operator-tts-preview` → captured audio → Whisper | PASS |
| Reply playback (ElevenLabs) | FAIL: the isolated database starts with no voice credentials, so ElevenLabs reported unhealthy |
| Stop, denial, retry | not run (serial mode stops after the first failure) |

Log: `.papercusp/scratch/d006-rig-run4.log` (2 passed, 1 failed, 3 not run).

Fix for run 5: the rig's assertion script (`.papercusp/scratch/d006-rig-assert.sh`) copies the
live workspace's encrypted voice-credential row into the throwaway rig database under the
rig's workspace id before Playwright starts. The secret is never printed, and the rig
database is deleted on teardown. Run 5 also adds the brain leg: a spoken question is posted
as a turn, the agent answers, and the spoken answer is captured and transcribed.

## Hosted portal — pending

A signed-in test account is needed; asked Avi (conversation
`conv-muwxkot8-0000-71edfc77ed724982ae24c1522a48d51e`).
