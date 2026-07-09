# Voice engine swap — local (kokoro/whisper) ↔ ElevenLabs

The operator voice stack is **single-sourced**: there is exactly one server-side
TTS synthesis registry and one STT transcription helper. Switching a provider —
e.g. local **kokoro** ↔ **ElevenLabs** — is a **config (voice-prefs) change**, not
a code change. There is no second implementation to keep in sync.

> History: a parallel client-side `detectEngines()` adapter framework
> (`voice-engines.ts`) used to shadow the server registry. It read server-only
> API keys and so was never viable client-side; its only caller was its own test.
> It was removed 2026-07-09 (WI-3448). If you go looking for "the other voice
> implementation" — there isn't one anymore, and that's the point.

## The two independent axes

Voice-prefs (PUT `/api/agent-mcp/operator-voice-prefs`) drive everything. Two
axes matter, and **`fullAgentEngine` wins when it is not `off`**:

| pref | values | what it controls |
| --- | --- | --- |
| `fullAgentEngine` | `off` \| `openai-realtime` \| `gemini-live` \| `elevenlabs-conv` | The bundled **conversational transport** (a single WebRTC/streaming session that does STT+LLM+TTS end-to-end). When ≠ `off` it **overrides** `sttEngine`/`ttsEngine`. |
| `sttEngine` | `voicemode` \| `webspeech` \| `deepgram` \| `off` | Per-utterance **speech-to-text** (only consulted when `fullAgentEngine === 'off'`). |
| `ttsEngine` | `kokoro` \| `browser` \| `elevenlabs` \| `openai` \| `cartesia` | Per-utterance **text-to-speech** (only consulted when `fullAgentEngine === 'off'`). |

So there are two genuinely different code paths, and EL can plug into **either**:

1. **Per-utterance pipeline** (`fullAgentEngine: 'off'`): STT and TTS are separate
   calls. TTS goes through the one registry — `ttsEngine: 'elevenlabs'` is a
   drop-in swap for `'kokoro'`. **This is the recommended EL integration** — it
   reuses the whole pipeline and only the synthesis endpoint changes.
2. **Conversational transport** (`fullAgentEngine: 'elevenlabs-conv'`): a distinct
   bundled EL Conversational session that **bypasses** the per-utterance pipeline.
   Use only if you specifically want EL's turn-taking/barge-in transport rather
   than local STT + EL TTS.

## The single TTS registry

`packages/operator-core/lib/endpoint-route/routes/agent-mcp/tts-synth.ts` exports
one function:

```ts
synthesize(engine, text, voiceId, prefs, opts?) => { ok, bytes, contentType } | { ok:false, status }
```

Both server routes call it, so they can never drift:

- `operator-tts.ts` — the live speak endpoint (re-exports the same `synthesize`
  reference; a test pins `synthesizeFromRoute === synthesize`).
- `operator-tts-preview.ts` — the /settings voice preview.

Providers and their config source:

| `ttsEngine` | endpoint | model | voice | key (server-side) |
| --- | --- | --- | --- | --- |
| `kokoro` (local) | `http://127.0.0.1:8880/v1/audio/speech` | `kokoro` | `af_bella` | none |
| `elevenlabs` | `api.elevenlabs.io/.../text-to-speech/{voice}/stream` | `eleven_turbo_v2_5` | `prefs.elevenlabsVoiceId` | `xi-api-key` |
| `openai` | `api.openai.com/v1/audio/speech` | `prefs.openaiModel` | `prefs.openaiVoice` | `Authorization: Bearer` |
| `cartesia` | `api.cartesia.ai/tts/bytes` | `prefs.cartesiaModel` | `prefs.cartesiaVoiceId` | `X-API-Key` |

Contract: missing cloud key → `{ ok:false, status:404 }` (no upstream call);
unknown engine → `400`; upstream non-ok → `502`. **Keys never leave the server** —
the client only ever sends prefs + text and receives audio bytes.

STT is the mirror: `voice-engines/whisper.ts` `transcribeChunk(baseUrl, audio)`
POSTs to the OpenAI-compatible `/v1/audio/transcriptions` (local whisper on
`:2022`).

## Recipe: switch local → ElevenLabs

1. **Fund + save the EL key** (server-side, never in the tree): the key is read by
   `voice-credentials.readElevenLabsKey()`. Save it via the /settings voice panel
   (validated by the `operator-elevenlabs-test` route) or the credential store.
2. **Flip the pref.** For per-utterance TTS (recommended):

   ```
   PUT /api/agent-mcp/operator-voice-prefs
   { "ttsEngine": "elevenlabs", "elevenlabsVoiceId": "21m00Tcm4TlvDq8ikWAM" }
   ```

   Leave `fullAgentEngine: 'off'` and `sttEngine: 'voicemode'` (local whisper) to
   keep STT free and local while only TTS goes to EL. Or, for the full EL
   conversational transport, set `fullAgentEngine: 'elevenlabs-conv'` instead
   (needs the funded key too; overrides stt/tts).
3. **That's it** — no rebuild, no code edit. `elevenlabsVoiceId` is preserved in
   prefs across swaps, so flipping `ttsEngine` back to `kokoro` (all-local, free)
   and later to `elevenlabs` again is lossless.

## Recipe: switch ElevenLabs → local (the current default)

```
PUT /api/agent-mcp/operator-voice-prefs
{ "fullAgentEngine": "off", "sttEngine": "voicemode", "ttsEngine": "kokoro" }
```

Requires the local services running: kokoro TTS on `:8880`, whisper STT on `:2022`
(managed under `.voicemode/services/`). No API keys, no per-char spend.

## What the status codes mean

`synthesize()` classifies the provider's response so the UI can tell a
**user-fixable credential problem** from a **provider outage**. (Before
2026-07-09 every upstream failure collapsed onto `502`, so a defunded ElevenLabs
account looked exactly like ElevenLabs being down.)

| status | meaning | who fixes it |
| --- | --- | --- |
| `200` | audio bytes | — |
| `404` `no-key` | no key configured for that engine | add a key |
| `401` | provider **rejected** the key — invalid, or out of credits | fix/fund the key |
| `429` | rate-limited / quota exhausted | wait, or upgrade the plan |
| `400` | bad request — unknown engine, bad voice id, bad model | fix the request |
| `502` | provider 5xx, unreachable, or a timeout | infrastructure |

`404` is produced **only** for "key not configured" — never passed through from a
provider — so the `no-key` contract stays unambiguous.

## Verify a swap

- Preview endpoint proves wiring without touching the live speak path:
  `POST /api/agent-mcp/operator-tts-preview { "engine": "kokoro" }` → `200` + WAV.
  `{ "engine": "elevenlabs" }` → `200` with a funded key; `404 no-key` with no key
  at all; `401` when a key is present but rejected (this still proves EL is fully
  wired — only the money is missing).
- Server-side edits have **no hot-reload**: restart the host
  (`systemctl --user restart papercup-staging-api.service` for :3170) before
  probing.

## Automated tests

Most voice tests stub `fetch` — they prove the wiring. Two suites hit the **real**
local services and will catch a real API change:

```bash
# Unit layer: live kokoro + whisper, incl. a TTS→STT round trip.
# Auto-skips when the services are down; PAPERCUSP_VOICE_LIVE=1 makes that a hard fail.
cd packages/operator-core
PAPERCUSP_VOICE_LIVE=1 npx vitest run lib/endpoint-route/routes/agent-mcp/voice-local-live.test.ts

# Browser layer: Chrome plays a kokoro-synthesized WAV into getUserMedia via
# --use-file-for-fake-audio-capture, records it with MediaRecorder, POSTs it to
# /api/agent-mcp/operator-stt, and asserts whisper transcribes the sentence back.
cd apps/operator
OPERATOR_E2E_REUSE_SERVER=1 OPERATOR_E2E_BASE_URL=http://127.0.0.1:3170 \
  npx playwright test e2e/voice-live-e2e.spec.ts
```

## Troubleshooting

**"Local TTS worked, then silently stopped and never came back."**
kokoro's systemd unit sets `UVICORN_LIMIT_MAX_REQUESTS`, intended to recycle a
uvicorn *worker* to mitigate an upstream memory leak (hexgrad/kokoro#152). But
`start-gpu.sh` runs uvicorn with **no `--workers`**, so the limit terminates the
whole server — with exit code **0**. A unit set to `Restart=on-failure` treats
that as a clean shutdown and never restarts it, so TTS dies permanently after
exactly N requests.

Fixed 2026-07-09 in `~/.config/systemd/user/voicemode-kokoro.service`:
`Restart=always` (exit-0 recycles now self-heal) and the limit raised `25 → 1000`
(a recycle costs a ~2.5 min CUDA model reload, so it should be rare). Check with:

```bash
systemctl --user show voicemode-kokoro.service -p Restart -p NRestarts
journalctl --user -u voicemode-kokoro.service | grep -i 'Maximum request limit'
```

**Preview returns `502`.** That now means a genuine outage — check
`curl http://127.0.0.1:8880/health` (kokoro) and `:2022/health` (whisper). A
credential problem reports `401`/`404`, not `502`.
