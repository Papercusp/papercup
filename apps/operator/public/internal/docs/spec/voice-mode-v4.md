# Voice mode v4
URL: /internal/docs/spec/voice-mode-v4

Voice integration on top of the v5 Operator. STT (Voicemode/Web Speech/Deepgram), TTS (Kokoro/Browser/ElevenLabs/OpenAI/Cartesia), full-agent engines, wake-word commands, multi-tab leader election, dual aria-live regions.

import { Aside } from '@astrojs/starlight/components';

Voice mode is the audio modality on top of the v5 Operator. It lets users
hear Operator's suggestions, cancel auto-fires by saying "cancel," and
invoke commands like `operator approve foo` from anywhere without
opening the panel.

This page documents the v4 architecture (May 2026), updated for the v5+
engine work. For design rationale, see the linked plans
(`universal-voice-interface-2026-06-05`, `voice-realtime-tui-2026-06-05`,
`unify-agent-launches-as-blueprints-2026-06-04`).

## Pipeline at a glance

```
mic → STT engine → onFinalUtterance(text)
                          ↓
                  ┌───────┴───────┐
                  │ wake-word     │  parseOperatorIntent("operator <verb>")
                  │ intent check  │  → opens panel, fires scan, or runs `operator approve <slug>`
                  └───────┬───────┘
                          ↓
                  ┌───────┴───────┐
                  │ priority      │  topConsumer():
                  │ consumer      │    panel-open > background-toast > standing-approval > Oracle
                  └───────┬───────┘
                          ↓
                  ┌───────┴───────┐
                  │ command       │  parseVoiceCommand(text):
                  │ parser        │    cancel|scan|pause|resume|freeform
                  └───────┬───────┘
                          ↓
                       (action)

──────────────────────────────────────────────────

speak(text, role, priority)
       ↓
   tutorial-gate (sessionStorage['oracle-tutorial-complete'])
       ↓
   aria-live publish (polite|assertive)
       ↓
   leader-election gate (only the leader tab speaks)
       ↓
   active TTS engine (kokoro|browser|elevenlabs|openai|cartesia)
```

When a **full-agent engine** is selected (`fullAgentEngine !== 'off'`),
this entire per-utterance STT→consumer→command→TTS pipeline is bypassed:
the engine bundles STT + LLM + TTS + intent dispatch in one streaming
connection. See [Full-agent engines](#full-agent-engines).

## Engines

### STT (speech → text)

| Engine                  | Where it runs                       | Privacy                    | Default                                            |
| ----------------------- | ----------------------------------- | -------------------------- | -------------------------------------------------- |
| **Voicemode (Whisper)** | Local on `:2022`                    | Audio never leaves machine | ✅ when reachable                                   |
| **Web Speech**          | Browser cloud (Google/MS)           | Audio sent to vendor cloud | Opt-in with leak warning                           |
| **Deepgram**            | Cloud (streaming WebSocket, Nova-2) | Audio sent to Deepgram     | Opt-in (BYO key) behind the same leak-warning gate |
| **Off**                 | n/a                                 | n/a                        | When none reachable                                |

`SttEngineKind = 'voicemode' | 'webspeech' | 'deepgram' | 'off'`. Deepgram
is a real cloud STT adapter (`voice-engines/deepgram.ts`, `wss://api.deepgram.com/v1/listen`):
streams \~250ms mic chunks, emits `is_final` utterance markers, and is gated
behind the same one-time `webSpeechLeakAcked` consent as Web Speech.

Endpoint resolution (per `voice-engines.ts`):

1. `mcp__voicemode__service whisper status` (when MCP probe is available)
2. `VOICEMODE_WHISPER_URL` env var
3. `http://localhost:2022` default

No silent fall-through — if probes fail, settings shows a clear "not detected"
message pointing at `mcp__voicemode__service whisper start`.

Mid-session disconnect: `voice-engine-health.startSttHealthMonitor` polls
`/health` every 30s; transitions fire `role="alert"` toasts.

### TTS (text → speech)

| Engine                 | Where it runs           | Streaming         | Cost                      | Default          |
| ---------------------- | ----------------------- | ----------------- | ------------------------- | ---------------- |
| **Kokoro (Voicemode)** | Local on `:8880`        | No (full payload) | $0                        | ✅ when reachable |
| **Browser**            | OS-shipped voices       | Native            | $0                        | Fallback         |
| **ElevenLabs**         | Cloud                   | Yes (MSE)         | \~$0.18/1k chars          | Opt-in (BYO key) |
| **OpenAI**             | Cloud                   | No (buffered)     | \~$0.015/1k chars (tts-1) | Opt-in (BYO key) |
| **Cartesia**           | Cloud (Sonic / Sonic-2) | Yes               | \~$0.05/1k chars          | Opt-in (BYO key) |

`TtsEngineKind = 'kokoro' | 'browser' | 'elevenlabs' | 'openai' | 'cartesia'`.
Cartesia (`voice-engines/cartesia.ts`) is a full streaming adapter against
`https://api.cartesia.ai`, with `sonic`/`sonic-2` models and a voice picker;
its spend rolls into the same cost-tracking state as ElevenLabs/OpenAI.

API keys live in Postgres (`harness_shared.operator_voice_credentials`,
migration 023) — read/written via `readOperatorState`/`writeOperatorState` in
`voice-credentials.ts`, **not** in the `zero_harness` publication so they're
never broadcast over WS. (The previous approach stored them in
`~/.papercusp/credentials.json`.) Mask-on-GET / preserve-on-PUT semantics.

ElevenLabs streaming uses **MediaSource Extensions** (per v4 §1.2.6) for
sub-400ms first-byte. Cancellation is via `audio.pause()` +
`removeSourceBuffer()` + AbortController on the underlying fetch. Safari
falls back to buffer-then-play.

OpenAI uses buffered playback (no streaming endpoint as of `tts-1`).
6 preset voices (alloy/echo/fable/onyx/nova/shimmer); two models
(`tts-1` cheap, `tts-1-hd` better quality).

## Cost tracking

Per-call spend recorded in Postgres (`harness_shared.operator_tts_spend`) —
was previously `<papercuspRoot>/system/operator/tts-spend.json` but the JSON
file raced under multi-tab usage. The table is defined in the consolidated
`000-baseline.sql` schema (the original `020-operator-state-tables.sql` is now
archived under `sql/archive/`, historical-only). The JSONB payload shape:

```json
{
  "perKCharRate": 0.18,           // user-configurable
  "softCapUsd": 5,
  "hardCapUsd": 20,
  "lastSpendDate": "2026-05-02",
  "softCapAcknowledgedDate": null,
  "spend": [{ "date": "2026-05-02", "chars": 8420, "estimatedUsd": 1.52 }]
}
```

* **Soft cap** (default $5/day): one assertive toast per UTC day, dedup'd via `softCapAcknowledgedDate`
* **Hard cap** (default $20/day): auto-fall-back to Kokoro/browser, toast user
* **Rollover**: `lastSpendDate` field — comparing on every `speak()` catches sleep-through-midnight + timezone travel

## Voice consumer priority

`VoiceAppBridge` consumer registry (per v4 §2b):

```
panel-open                 100   the Operator panel is open
background-toast            50   an auto-fire toast is on-screen
standing-approval-prompt    25   reserved (future use)
oracle                       0   implicit lowest, no registration
```

Highest-priority registered consumer wins. If it has an `onUtterance`
handler (e.g. background-toast looking for "cancel"), it processes the
utterance directly. Otherwise the consumer just suppresses lower-priority
routing.

## Multi-tab leader election

`voice-leader.ts` BroadcastChannel-based protocol (per v4 §2i):

1. **Election + heartbeat** (Phase 1): chrome boot opens `BroadcastChannel('operator-voice')`, posts `announce`, waits 250ms, lowest tabId wins. Leader heartbeats every 5s; followers re-elect after 12s of silence.
2. **Focus transfer** (v1.5): `requestVoiceLead()` — when user opens the panel in a non-leader tab, that tab requests the lead, current leader yields, requesting tab becomes leader. Spoken output follows user attention.
3. **Availability guard**: Safari private windows / WebViews lacking `BroadcastChannel` fall back to single-tab mode + settings note.

Election runs **async** during chrome boot; render is not blocked.

## Wake-word `operator <verb>` intents

Strict 2-word prefix; verb whitelist (per v4 §2f). `SCAN_VERBS` is just
`scan` / `status`, plus the multi-word `operator what's pending`:

| Utterance                                                       | Effect                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `operator scan` / `operator status` / `operator what's pending` | Fire the `scan` launch blueprint (findings land as work\_items in the self-improvement backlog) |
| `operator approve <slug>`                                       | Resolve standing approval (single-match)                                                        |
| `operator approve <slug> <cap>`                                 | Explicit cap pick (e.g. `operator approve foo tasks-write`)                                     |

The `operator open` / `operator show` and `operator across workspaces` verbs
were **removed** along with the operator-card panel and card stream
(unify-agent-launches D-005). `parseOperatorIntent` no longer handles them.

Approve disambiguation rules (per v4 §2f):

1. Filter to candidates with `targetHarness === slug`
2. Filter out `firstShownAt === null` (user must have seen it)
3. If explicit cap: must be voice-eligible (2-segment, alphabetic-only) AND match exactly one
4. If no explicit cap: auto-pick when 1 remains; otherwise refuse with disambiguation prompt

Cap eligibility: `tasks:write` ✓, `secrets:read:OPENAI_KEY` ✗ (3+ segments + underscore).

## In-panel commands

`voice-commands.ts` parser, no NLU. Strict literal:

```
cancel
scan [<query>]
pause | resume | unpause
rescan | re-scan | scan again | rerun scan
<anything else, ≥2 chars> → freeform scan request
```

`VoiceCommand` is `cancel | scan | pause | resume | freeform`. The
`dispatch [<ordinal>]` / `dismiss [<ordinal>]` verbs were **removed** along
with the card stream (unify-agent-launches D-005) — the parser has no ordinal
extraction and no pending-card selection.

## Cancel race + visual ring

Per v4 §2c: when voice mode is on AND `speakBackgroundToasts` is on:

* Visual ring extends to **8s** (matches commit deadline)
* "cancel" utterance during the window cancels speech + dispatch + writes `undo_cancel` audit
* Visual button always available + authoritative

When voice mode is off OR toggle is off: visual ring stays at **5s**, commit at 5s.

The 8s extension absorbs worst-case STT latency (\~1.5s on slow CPUs)
without penalizing click-cancel users on default config.

## Lifecycle telemetry: `actor_method`

Per v4 §2m, every audit row carries `actor_method`:

| Value     | When                                                        |
| --------- | ----------------------------------------------------------- |
| `'voice'` | Voice utterance (in-panel command, wake-word, toast cancel) |
| `'click'` | UI click / keyboard activation (default)                    |
| `'api'`   | Direct API call (CLI, automated test)                       |
| `null`    | Legacy / unspecified (back-compat)                          |

The `/api/agent-mcp/operator-stats` endpoint surfaces a `byActorMethod`
breakdown over the last 7 days; `/settings/operator` displays it as a
"How you act" widget below the KPI grid.

## Aria-live regions

Two hidden regions in chrome (per v4 §2j):

```html
<div aria-live="polite"     role="status" />  <!-- queues behind SR -->
<div aria-live="assertive"  role="alert"  />  <!-- preempts SR -->
```

Per-feature priority assignment:

| Feature                                 | Region        |
| --------------------------------------- | ------------- |
| Suggestion arrival (tier=low/medium)    | polite        |
| Suggestion arrival (tier=high)          | assertive     |
| Receiving-flip → consumed               | polite        |
| Receiving-flip → escalated/rejected     | **assertive** |
| Cadence status (scanning…, surfaced N…) | polite        |
| Pause toggle                            | polite        |
| Budget warning (≥80% / 100%)            | **assertive** |
| Breaker tripped                         | **assertive** |
| TTS-failure-disabled toast              | **assertive** |

Visual prominence is invariant: visual toasts carry the same content
regardless of voice state. Voice supplements, never replaces.

## Spoken nudges (per-kind dedup)

| Kind    | Window | Reason                                                                           |
| ------- | ------ | -------------------------------------------------------------------------------- |
| budget  | 30 min | Don't spam after the user has heard "$15 of $20 spent"                           |
| breaker | 10 min | If PG is still down, users want to know                                          |
| pause   | 5 min  | Pause toggles are user-driven; dedup keeps it from re-announcing the latest flip |

Dedup state persisted as `nudgeDedup` inside the voice-prefs JSONB payload
(`harness_shared.operator_voice_prefs`, defined in the consolidated
`000-baseline.sql` — was previously `voice-prefs.json`) so reload doesn't
reset windows.

## Per-role voice mapping

Voices keyed on **role** (not slug). All instances of the `worker` role
share one voice; per-slug overrides (`worker@papercup-coding-foo`) are
v1.5 (the lookup chain in `voiceForRole` already supports them — settings
UI exposure pending).

Roles in v4:

* `system:operator` — Operator's main voice
* `system:operator-nudge` — calmer voice for budget/breaker/pause
* `harness` — generic fallback for receiving-flips when template-role missing
* `worker` / `validator` / `orchestrator` / etc. — substrate roles

## Full-agent engines

The dominant v5+ path. `fullAgentEngine` (default `'off'`) bundles
STT + LLM + TTS + intent dispatch in one streaming connection; when set to
anything but `'off'` it **overrides** `sttEngine` + `ttsEngine` and bypasses
the per-utterance pipeline entirely.

`FullAgentEngineKind` options offered in the picker:

| Engine            | Notes                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `off`             | Default — use the per-utterance STT + TTS pipeline                                                                                       |
| `elevenlabs-conv` | ElevenLabs Conversational AI — primary in v5+ (`voice-engines/elevenlabs-conv.ts`); requires `elevenLabsAgentId` + an ElevenLabs API key |
| `openai-realtime` | OpenAI Realtime (`voice-engines/openai-realtime.ts`); reuses the OpenAI key                                                              |
| `gemini-live`     | Reserved option (reuses the Google credential slot); no dedicated engine adapter yet                                                     |

The enum also carries a legacy alias `'elevenlabs-conversational'` so stored
values still resolve, but it is deliberately not offered in the picker.

## On-device wake-word engines

`wakeWordEngine` selects how the wake word is detected:

| Mode           | Engine                                         | Key               | Default   |
| -------------- | ---------------------------------------------- | ----------------- | --------- |
| `off`          | Transcribe-everything-then-string-match        | none              | ✅ default |
| `porcupine`    | Picovoice Porcupine (commercial, free for dev) | BYO Picovoice key | —         |
| `openwakeword` | openWakeWord (Apache-2.0, custom-trainable)    | none              | —         |

Each engine has its own keyword namespace: `porcupineKeyword`
(`'Computer'` default, plus `Jarvis` / `Bumblebee` / `Alexa` / …) and
`openwakewordKeyword` (`'hey_jarvis'` default, plus `alexa` / `ok_nabu` / …).
The default is plain string-match (no dedicated wake-word model).

## Full-agent session governance

The EL Conv-AI / Realtime path streams the mic continuously while connected,
so silence still costs minutes. Governance fields cap that:

* **`voicePrivacyMode`** — `'always-on'` (default; mic streams continuously,
  lowest latency, audio leaves the box at rest) vs `'wake-word-gated'` (local
  wake-word engine listens on-device; mic only streams after the wake word
  fires, \~1.5s extra first-turn latency).
* **`wakeGatedIdleTimeoutSec`** — idle timeout used in wake-word-gated mode
  (default 20s; tighter since re-waking is cheap).
* **`fullAgentIdleTimeoutMin`** — auto-disconnect after this many minutes of
  **user** inactivity (agent transcripts don't reset the timer). Default 2
  (tightened from 5 after the EL credit-burn audit); 0 = never.
* **`fullAgentSessionMaxMin`** — hard max session duration regardless of
  activity. Default 30; 0 = no max.
* **`fullAgentMonthlyMinuteCap`** — hard monthly EL Conv-AI minute cap; once
  reached, voice-mode refuses a new session and toasts. Default 600 (10h);
  0 = uncapped.
* **`agentLanguage`** — BCP-47 code pinned as EL Conv-AI's `language` override
  (default `'en'`; empty string lets EL auto-detect, at the cost of the
  noise-mishear failure mode).

## Cross-device voice lease

`voice-lease.ts` elects the single host + player of the one shared operator
voice session across surfaces (`universal-voice-interface`, Model A / D-003).
A per-workspace row in `harness_shared.voice_lease` (defined in
`000-baseline.sql`) carries a 12s heartbeat-based expiry.

`VoiceLeaseKind` is `'desktop' | 'mobile' | 'tui'` (the `'tui'` owner kind was
added by migration 166). The lease elects *who renders the response audio and
captures the mic* — non-holders are never refused; they stay
receive + display + control clients (so the same audio never doubles or
echoes). `force: true` takes over the host + player role (the user explicitly
toggled "play here"); the host re-elects when the player drops so the session
survives either UI closing. The server is the source of truth, and a new/forced
owner emits `voiceLease.current` on the sync-invalidate channel so other
surfaces re-sync their elected-player flag.

## TTS engine failure handling

`voice-engine-health.ts` tracks consecutive errors per session:

* 3 consecutive errors → mark engine disabled
* One-time `role="alert"` toast: "Voice mode silently failed; switching to visual."
* Subsequent `speak()` calls become no-ops
* Re-enable from `/settings/voice` (probes the engine + resets counter)

## STT capture loop (Voicemode whisper path)

`stt-voicemode.ts` uses the `@ricky0123/vad-web` **Silero v5 ONNX VAD**
(`MicVAD.new`) — a neural speech/non-speech model, replacing the old
hand-rolled RMS/dBFS MediaRecorder loop (3-4× fewer false positives on
background noise):

* **VAD model**: Silero `v5`, ONNX runtime under `/vad-runtime/`
* **Thresholds**: `positiveSpeechThreshold 0.6`, `negativeSpeechThreshold 0.35`
* **Min speech**: `minSpeechFrames 4` (\~250ms to count as speech)
* **End-of-utterance**: `redemptionFrames 8` (\~500ms of silence)
* **Min size**: `blob.size < 5_000` dropped (skip sub-second noise)

`onSpeechEnd` delivers the utterance as a `Float32Array @ 16kHz`, wrapped
to a **WAV** blob via `f32ToWav` (not webm/opus). The blob POSTs to
`/v1/audio/transcriptions` (`transcribeChunk`) and the returned text fires
`listener.onFinal(text)`. There is no 30s hard force-finalize window in this
file — Silero's boundaries replace it.

## Settings (`/settings/voice`)

Layout (grown well past the original v4 7-step shape):

1. **Engines**: STT selector (voicemode / webspeech / deepgram / off) + TTS
   selector (kokoro / browser / elevenlabs / openai / cartesia) + **full-agent
   engine picker** (off / openai-realtime / gemini-live / elevenlabs-conv) +
   per-engine endpoint status + Test voice / Test all roles / Re-detect engines
2. **BYO-key sections** (each reveals inline when its engine is selected):
   ElevenLabs (API key + Test connection `/v1/user` + voice picker + per-1k-char
   rate + soft/hard caps + cost widget), OpenAI (API key + Test `/v1/models` +
   voice picker alloy/echo/fable/onyx/nova/shimmer + tts-1 vs tts-1-hd),
   **Cartesia** (API key + voice picker + sonic/sonic-2), **Deepgram** (API key
   * connection test). Full-agent engines reuse the matching cloud key
     (`FULL_AGENT_KEY` maps the engine to its credential).
3. **Feature toggles**: well beyond the original 7 (speakSuggestions,
   speakBackgroundToasts, speakReceivingFlips, speakEscalations,
   speakCadenceStatus, speakNudges, wakeWordIntents) — plus speakOpenCards,
   cardAnsweringEnabled, speakSessionHandoff, narrateLongOps,
   operatorBackstoryEnabled, proactiveTicksEnabled, and more.
4. **Wake-word engine**: off (string-match) / porcupine / openwakeword + the
   per-engine keyword picker. See [On-device wake-word engines](#on-device-wake-word-engines).
5. **Full-agent governance**: privacy mode (always-on / wake-word-gated),
   idle / session-max / monthly-minute caps, language pin (`agentLanguage`),
   `elevenLabsAgentId`. See [Full-agent session governance](#full-agent-session-governance).
6. **Per-role voices**: role → voice mapping for the active engine
7. **Precedence matrix**: rendered as a debugging reference

## File map

```
packages/operator-core/lib/        # the voice engines + node-side libs (moved off apps/operator/lib)
├── voice-commands.ts        parser (cancel|scan|pause|resume|freeform)
├── voice-intents.ts         wake-word (scan/status/approve) + approve disambiguation
├── voice-prefs.ts           PG storage; 3 STT + 5 TTS + full-agent engine kinds + ~50 fields
├── voice-credentials.ts     EL/OpenAI/Cartesia/Deepgram/Picovoice/Google keys (PG, mask GET / preserve PUT)
├── voice-lease.ts           cross-surface voice lease (desktop|mobile|tui)
├── voice-engines.ts         shared interfaces + detection
├── voice-engines/
│   ├── kokoro.ts            Voicemode local TTS
│   ├── browser.ts           Web Speech TTS wrapper
│   ├── elevenlabs.ts        Turbo v2.5 + MSE streaming
│   ├── elevenlabs-mse.ts    MediaSource player + buffered fallback
│   ├── openai.ts            tts-1 / tts-1-hd
│   ├── cartesia.ts          Sonic / Sonic-2 streaming TTS
│   ├── whisper.ts           Voicemode STT engine surface
│   ├── webspeech.ts         Web Speech STT engine surface
│   ├── deepgram.ts          Deepgram cloud STT (streaming WS)
│   ├── elevenlabs-conv.ts   EL Conversational-AI full-agent adapter
│   ├── openai-realtime.ts   OpenAI Realtime full-agent adapter
│   ├── porcupine.ts         Picovoice wake-word engine
│   ├── openwakeword.ts      openWakeWord wake-word engine
│   └── cancel-race.ts       pending-flush wrapper
├── tts-spend.ts             cost tracking + soft/hard caps + rollover
├── voice-engine-health.ts   TTS 3-strike + STT probe
├── voice-nudges.ts          per-kind persisted dedup
└── operator-audit.ts        + ActorMethod enum

apps/operator/app/_components/voice/   # browser-side chrome (still under apps/operator)
├── voice-mode.ts            speak() with aria-live + leader gate + tutorial gate
├── voice-prefs-client.ts    client-side cache
├── VoiceAppBridge.tsx       priority registry + intent dispatch
├── voice-leader.ts          BroadcastChannel election + heartbeat + focus transfer
├── AriaLiveRegions.tsx      dual polite + assertive
├── aria-live-bus.ts         pub/sub from speak()
├── VoiceLeaderBootstrap.tsx async chrome-boot
├── OperatorVoiceAnnouncer.tsx closed-panel cadence + pause nudges
├── stt-voicemode.ts         Silero v5 ONNX VAD capture for Voicemode whisper
└── f32-to-wav.ts            Float32Array → WAV blob for whisper upload

packages/operator-core/lib/endpoint-route/routes/agent-mcp/   # Hono routes (Next app/api retired)
├── operator-voice-prefs.ts  GET/PUT
├── operator-credentials.ts  ElevenLabs + OpenAI keys
├── operator-tts-spend.ts    cost + caps
├── operator-elevenlabs-test.ts /v1/user probe
├── operator-openai-test.ts  /v1/models probe
├── operator-nudge.ts        per-kind dedup arbitration
└── operator-audit.ts        (extended for actorMethod field)

apps/operator/app/settings/voice/page.tsx   full v4 UI (rendered by operator-vite via the @/app alias)
```

## Operational pre-flight

To take voice live for a user:

1. `mcp__voicemode__service whisper start` (default port 2022)
2. `mcp__voicemode__service kokoro start` (default port 8880)
3. (Optional) Add ElevenLabs API key at `/settings/voice` → ElevenLabs section → paste → Test connection
4. (Optional) Add OpenAI API key the same way
5. Grant microphone permission when prompted
6. Toggle voice mode on via the existing voice button (top chrome)
7. (Optional) Tune toggles + per-role voices

## What's NOT in v4

Per v4 plan §9 (carried + new):

* NLU / intent classifier (strict literal first)
* Voice cloning for per-role voices
* Server-side TTS aggregation across machines
* Cloud TTS providers beyond ElevenLabs + OpenAI + **Cartesia** (Google, Azure
  remain unimplemented — a Google credential slot exists but no engine adapter)
* Cloud STT engines beyond Web Speech + **Deepgram** (AssemblyAI remains
  unimplemented)
* Voicemode kokoro voice cloning
* Cross-workspace voice features beyond on-demand summary
* Partial-results "can-" preemption for cancel race
* Wake-word + dispatch in one utterance
* Voice during first-run tutorial (permanently gated)
* Per-slug voice settings UI (lookup chain ready; UI surface deferred)

## Tests

```sh
# engine + node-side libs (moved to operator-core)
cd packages/operator-core && npx vitest run lib/voice-*.test.ts
# browser-side chrome (still under apps/operator)
cd apps/operator && npx vitest run app/_components/voice/voice-*.test.ts
```

Coverage spans the full voice surface: `packages/operator-core/lib` carries
14 `voice-*.test.ts` files (11 excluding `*.integration.test.ts`) — parser,
intents, prefs, credentials, engines (local + cloud adapters), cost
methodology, health monitor, nudges, leader election, voice-lease — and
`apps/operator/app/_components/voice` adds 5 more (consumers, leader,
mode-capture, mode, prefs-client). The earlier "78 tests / 9 modules" figure
is no longer accurate.

## Realtime operator voice in the pui (voice-realtime-tui-2026-06-05)

The terminal workbench has BOTH voice modes:

* **PTT** (`v`): capture → Whisper STT → operator-converse → `operator-tts`
  (engine + voice from voice prefs — ElevenLabs when selected) → playback.
* **Realtime** (`V`, any tab): a raw ElevenLabs Conv-AI **WebSocket** session.
  `GET /api/agent-mcp/operator-elevenlabs-ws-init` mints the signed URL
  server-side (key never leaves the operator), claims the voice lease
  (kind `tui` — one live listener across desktop/mobile/pui), and returns the
  shell-mode payload (language-pin override only). The Rust client
  (`apps/tui/src/voice_convai.rs`) streams \~250 ms `pcm_16000` mic chunks up,
  plays `audio` events gap-free, answers `ping`, stops playback on
  `interruption` (barge-in), and serves the **`ask_operator` client tool**
  over the existing operator-converse SSE — the same brain loop as the
  desktop's browser clientTool. Transcripts persist into the SAME operator
  conversation (sources `voice_stt`/`voice_tts`, tags stripped).

Requirements: `fullAgentEngine = elevenlabs-conv` + `elevenLabsAgentId` in
`/settings/voice` and an ElevenLabs API key — the same config the desktop
full-agent mode uses. Without them `V` surfaces the route's hint as a toast.
