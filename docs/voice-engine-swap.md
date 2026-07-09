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

## Verify a swap

- Preview endpoint proves wiring without touching the live speak path:
  `POST /api/agent-mcp/operator-tts-preview { "engine": "kokoro" }` → `200` + WAV;
  `{ "engine": "elevenlabs" }` → `200` if a key is funded, else `404` (`no-key` —
  which itself proves EL is wired and only the key is missing).
- Server-side edits have **no hot-reload**: restart the host
  (`systemctl --user restart papercup-staging-api.service` for :3170) before
  probing.
