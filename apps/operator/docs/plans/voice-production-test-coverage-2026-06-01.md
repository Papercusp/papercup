---
title: Voice system — production test coverage
slug: voice-production-test-coverage-2026-06-01
status: active
created: 2026-06-01
updated: 2026-06-02
owner: aviynw@gmail.com
companion-to: [production-readiness-test-coverage-2026-05-30]
---

# Voice system — production test coverage

## Now

**State:** Greenlit 2026-06-01 (user: "I want all" → status active). Audit done: ~46 existing voice tests give strong unit coverage of parsing / spend-math / capture-DSP / card-routing, but the production-primary engine (ElevenLabs Conv AI), the OpenAI Realtime fallback, the mobile voice WS transport, EL token-minting, spend-cap *enforcement*, credential encryption, and a real Tauri-shell conversation E2E are untested — and the one existing browser E2E targets the *retired* `:3055` webapp. Companion to `production-readiness-test-coverage-2026-05-30`, whose **P-026** already shipped the voice engine *adapter contract* slice (cloud + local adapters); this plan covers the gaps P-026 deferred plus transport, enforcement, arbitration, resilience, and E2E.

**Next:** Execute Phase 1 (P0) starting with P-001 (mobile voice WS server integration test).

## Background — the audit (2026-06-01)

Method: two parallel readers censused the voice system's production code (~55 files) and its tests, then a direct source↔test cross-reference identified true gaps. Voice is entirely TypeScript (operator backend + WebKitGTK webview); the Tauri desktop has **no native voice/audio Rust**. Convention is the four canonical frameworks (Vitest `*.test.ts`, Playwright `e2e/*.spec.ts`, Cargo, LLM scenarios) per `admin-testing-tab-restructure-2026-05-24` D-006.

### What exists (~46 voice-touching test files)

- **Vitest (strong on pure logic):** spend math (`tts-spend`, `stt-spend` — accumulation, UTC rollover, soft/hard-cap firing/re-arm), parsing/NLP (`voice-commands`, `voice-intents`, `wake-word`, `classify-utterance-mode`, `operator-converse-tags`, `operator-converse-voice`), capture/DSP (`ptt-capture`, `energy-vad-capture`, `f32-to-wav`, `voice-mode-capture`), engine adapters (`cloud-adapters`, `local-adapters`, `voice-engines`, `prepareForTTS`, `cancel-race`), coordination/cards (`voice-lease` [mocked PG], `voice-leader`, `voice-card-router`, `match-voice-answer`, `decline-phrases`, `compose-ambiguity-prompt`, `voice-nudges`), security (`elevenlabs-webhook-auth` — HMAC only), MCP tools (`agent-tools/operator/__tests__/voice` — mocked), converse route (`agent-mcp-operator-converse` — state-snapshot fan-out only).
- **Playwright (thin — 1 file):** `e2e/voice-mode.spec.ts` — settings-page render, spend widgets, cap-knob PUT, credential masking, STT-bootstrap 404, a11y. No real voice flow, and it drives the retired `:3055` webapp.
- **LLM scenarios (4):** `M8-format-utterance`, `S08-silence-nudge-ready`, `S11-voice-card-answer`, `S07-passive-mode`.
- `quarantine.txt`: no voice flakes.

### Three weaknesses in what exists

1. The production-primary engine is the least-tested relative to risk: EL Conv AI has one test (SSE fallbackText path only); OpenAI Realtime (the fallback) has zero.
2. The only E2E targets the retired standalone webapp surface, not the shipping Tauri shell, and never exercises a real turn.
3. Caps / lease / dispatch logic is unit-tested with mocks; almost nothing is integration- or E2E-tested — the math is right in isolation but the wiring that *enforces* it in a live session is unverified.

### Genuinely untested source (true gaps)

`device-voice-ws.ts`, `openai-realtime.ts`, `elevenlabs-mse.ts`, `routes/device/voice.ts` (lease + EL token minting), `routes/elevenlabs/webhook.ts` + `post-call.ts` handlers, `voice-credentials.ts`, `voice-narration.ts`, `voice-debug-ring.ts`, `VoiceAppBridge.tsx`, plus the live-session wiring for spend-cap enforcement, lease arbitration, barge-in, and reconnection.

## Phase 1 — P0 launch-blocking (production paths with zero / near-zero coverage)

- **P-001** `done` Mobile voice WS server (`device-voice-ws.ts`) → `apps/operator/lib/device-voice-ws.integration.test.ts` (Vitest). Assert: device-JWT auth accept/reject (subprotocol header + `?token=`), transcript→dispatcher forwarding, TTS frame emit back to client, `EADDRINUSE` port-fallback walk, connection close/cleanup. The entire phone↔operator transport; 0 tests today. (SHIPPED 1f43c4637: seam on device-voice-ws.ts export handleConnection + _stopMobileVoiceWsForTests + wss tracking; device-voice-ws.test.ts 17 unit auth gate incl. subprotocol, forwarding, wake-word cache, phone-TTS gating, send OPEN-guard, ping/pong/terminate/close + device-voice-ws.integration.test.ts 4 real listen+auth+round-trip, subprotocol, 1008, EADDRINUSE fallback. 21 green.)
- **P-002** `done` EL Conv AI `voice-session-init` + lease endpoints (`routes/device/voice.ts`) → `lib/endpoint-route/__tests__/device-voice-session-init.test.ts` (Vitest, Hono app.request). Assert: in-flight mint dedup (concurrent → one token), 8s cooldown gate, concurrency-limit detection → correct error surface, lease GET/claim/heartbeat/DELETE. Directly governs cost + the "concurrency limit reached" UX. (SHIPPED 7d08500d5: device-voice-routes.test.ts 16 — lease GET/claim/heartbeat/DELETE + voice-session-init config gates, 8s cooldown 429, mint success+cooldown-arm, error mapping concurrent_limit→503/non-429→502/mint_failed/mint_shape, in-flight dedup. RouteContext + mocked deps + stubbed fetch.)
- **P-003** `done` OpenAI Realtime fallback engine (`voice-engines/openai-realtime.ts`) → `voice-engines/openai-realtime.test.ts` (Vitest, mock RTCPeerConnection + data channel). Assert: data-channel event parse, tool-call dispatch → result round-trip, session-config/SDP shaping, disconnect/error handling. The fallback that runs whenever EL is down / over-limit; 0 tests. (SHIPPED fa4dff983: openai-realtime.test.ts 18. Mocks the agents-realtime SDK + command registry. Covers instruction shaping persona/active-mode converse/language-from-prefs, registry tools + execute round-trip, history events to onTranscript/onAssistantText, error to onError, stop/sendSystem, testRealtimeConnection request+error mapping.)
- **P-004** `done` EL Conv AI action registry + client-tool dispatch → extend `voice-engines/elevenlabs-conv.test.ts` (Vitest). Assert: reflexive (browser-side) command dispatch, webhook-tool (server-side) routing, unknown/malformed tool handling. Production-primary engine; today only the SSE fallbackText path is covered. (SHIPPED ce332cdc1: extended elevenlabs-conv.test.ts +6, now 12. Exported buildClientTools. Covers in-page dispatch command/query route to runCommand/runQuery w/ browser ctx, end_conversation teardown+ack, only browser:required become client tools + buildClientToolCatalog name normalization, desc fallback, server-side excluded. Mocks registry+defs+browser-workspace.)
- **P-005** `todo` EL webhook handler behavior (`routes/elevenlabs/webhook.ts` + `post-call.ts`) → `lib/endpoint-route/__tests__/elevenlabs-webhook.test.ts` (Vitest). Assert: verified payload → server-side tool execution + correct response; post-call logging / utterance persistence. Only the HMAC auth *helper* is tested; the handler is not.
- **P-006** `todo` Spend hard-cap *enforcement* in a live turn → `lib/voice-spend-enforcement.test.ts` (Vitest). Assert: when TTS/STT/EL hard-cap trips, the converse/session path actually refuses or falls back — not merely that `computeNextState` reports `hardCapHit`. Bridges the unit math to real spend control.
- **P-007** `todo` Voice conversation E2E in the Tauri shell → `apps/operator/e2e/voice-conversation.spec.ts` (Playwright, Tauri-driven per `/internal/docs/testing/agent-e2e`). Scripted turn with mocked STT input + stubbed TTS: utterance → operator turn → `<say>` spoken → card answerable. Also retarget the existing `voice-mode.spec.ts` off the retired `:3055` surface.
- **P-008** `todo` WebKitGTK audio capability guard → Vitest unit for the `shouldSkipVoicemodeWhisperOnThisRuntime` Tauri+WebKitGTK branch + a Tauri smoke that `getUserMedia` / WebRTC is reachable in the shell. Voice runs in WebKitGTK, not Chromium — currently no guard test.

## Phase 2 — P1 resilience / arbitration / security

- **P-009** `todo` Cross-surface single-listener lease arbitration → `lib/voice-lease-arbitration.integration.test.ts` (Vitest, real testcontainer PG). Phone preempts desktop; desktop yields unless toggled; lease expiry → re-election; no stereo double-listen. (Lib logic is mocked-PG today.)
- **P-010** `todo` Reconnection / network-drop resilience → Vitest. WebRTC drop → reconnect/teardown; SSE reconnect with `Last-Event-ID` (the voice-converse case); mobile WS reconnect. Voice sessions are long-lived; drops will happen.
- **P-011** `todo` Barge-in (interrupt TTS mid-utterance) → `apps/operator/app/_components/voice/voice-mode-bargein.test.ts` (Vitest). User speaks while operator is speaking → TTS cancels, capture resumes, no overlap. `cancel-race` covers the flush primitive only, not the UX behavior.
- **P-012** `todo` Credential encryption round-trip (`voice-credentials.ts`) → `lib/voice-credentials.integration.test.ts` (Vitest, real PG). Write→read each provider key, ciphertext ≠ plaintext at rest, masking on display. Security-sensitive, untested.
- **P-013** `todo` Voice utterance audit log PG integration (`voice-utterance-log.ts`) → `lib/voice-utterance-log.integration.test.ts` (Vitest, real PG). Real insert into `voice_utterances`, schema/index correctness, `modifications` JSONB, `degraded` flag. Only mocked in the tool test today.
- **P-014** `todo` VoiceAppBridge Oracle routing (`VoiceAppBridge.tsx`) → `VoiceAppBridge.test.tsx` (Vitest component). Consumer-priority resolution (panel-open > background-toast > oracle); Oracle reply spoken via TTS when the panel is closed.
- **P-015** `todo` ElevenLabs MSE audio playback (`voice-engines/elevenlabs-mse.ts`) → `voice-engines/elevenlabs-mse.test.ts` (Vitest). MSE buffer append / playback ordering, underrun + cancel handling.

## Phase 3 — P2 hardening / completeness

- **P-016** `todo` Voice debug ring buffer (`voice-debug-ring.ts`) → `lib/voice-debug-ring.test.ts` (Vitest). Eviction at capacity, ordering, SSE drain.
- **P-017** `todo` voice-narration spoken-state generation (`voice-narration.ts`) → `lib/voice-narration.test.ts` (Vitest). State → voice-friendly description; empty / edge states.
- **P-018** `todo` Engine-health probe fallbacks → extend `lib/voice-engine-health.test.ts`. Whisper@2022 / Kokoro@8880 unreachable → correct degraded status + cloud fallback selection.
- **P-019** `todo` New voice LLM judge scenarios under `lib/llm-testing/scenarios/operator/` — barge-in graceful recovery, spend-cap-reached spoken-message quality, multi-card voice disambiguation, decline-phrase handling in a live card.
- **P-020** `todo` Accessibility of voice state → extend a11y E2E for `AriaLiveRegions` / `OperatorVoiceAnnouncer` (listening / speaking / error states announced to assistive tech).

## Decisions

### D-001 — Scope: the entire voice system, all 20 recommended tests

Date: 2026-06-01. The user reviewed the audit and chose "I want all" — every recommended test, P0 → P2. This plan is a companion to `production-readiness-test-coverage-2026-05-30`; that plan's **P-026** is the already-shipped voice engine *adapter contract* slice (cloud-adapters + local-adapters connection/health request-shaping) and is **not** re-done here. This plan covers the gaps P-026 explicitly deferred (streaming/speak/cancel, OpenAI Realtime, full EL Conv AI dispatch) plus the transport, token-minting, spend *enforcement*, arbitration, resilience, credential, and Tauri-E2E surfaces P-026 never touched.

### D-002 — Test strategy: mock-first + deterministic; live provider calls opt-in behind `TEST_<SERVICE>_KEY`

Date: 2026-06-01. The default suite mocks all external providers (fetch / WebRTC / WebSocket / MediaSource) for determinism, zero secrets in CI, and zero spend — matching `@papercusp/test-config`'s MSW conventions and the repo rule "do not check live keys into fixtures." Where real API drift is a genuine risk (EL Conv AI, Deepgram), add `describe.skipIf(!process.env.TEST_*_KEY)` live smoke variants that self-skip when the key is absent. No live API call ever gates CI. (Open question raised in the audit; resolved as the conventional default — revisit if the user wants live-primary integration.)

### D-003 — Four canonical frameworks; no Cargo (voice has no Rust)

Date: 2026-06-01. Per `admin-testing-tab-restructure-2026-05-24` D-006: Vitest (`*.test.ts` / `*.integration.test.ts`), Playwright (`e2e/*.spec.ts`, Tauri-driven), and LLM scenarios. The Tauri desktop has no native voice/audio code — voice runs entirely in the WebKitGTK webview — so there are no Cargo voice tests. No new `.mjs` integration scripts (P-038 CI lint forbids them).

### D-004 — The existing browser E2E tests the retired surface; the new conversation E2E must run in the Tauri shell

Date: 2026-06-01. `apps/operator/e2e/voice-mode.spec.ts` drives `:3055`/`:3070` in a browser — the retired standalone webapp per `CLAUDE.md`. P-007 adds the real conversation E2E through the Tauri shell (per `/internal/docs/testing/agent-e2e`) and retargets the existing spec so the suite stops asserting against dead surface.
