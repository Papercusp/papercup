# Plan — Sentinel as a full Claude-Code TUI (voice + text + shared thread + cards)

**Owner directive (2026-06-22):** "I do want it to be a full claude tui. … it will be
used a lot once you make it functional. we have not used it yet at all, so you can
completely change how it works without breaking any dependencies."

**Scope:** Make the dock's **🛡 sentinel** pane — a *real* Claude Code session
(`psu --agent=claude --role=…`) — the **functional, user-facing Sentinel**: the
user talks to it by **text and voice**, it shares **one conversation thread** with
the webview, and it can ask **structured choices (cards)**. This **supersedes
`operator:converse`** as the front-door brain.

> **Greenfield.** The pane is unused; no dependents. Redesign freely.

> **Official-plan note:** the PG-backed papercusp plan (`plans:*`) can't be created
> while the `papercusp-su` MCP is disconnected — promote this doc to a `plans:new`
> entry (phases = sections A–E) once it reconnects. Supersedes
> `sentinel-tui-shared-backend-and-cards-2026-06-22.md` (the `operator:converse`/
> ratatui approach), whose shipped Phase-1/2 work targeted the **wrong surfaces**
> (see "Reused vs replaced").

---

## 0. Why this plan exists — the investigation finding (2026-06-22)

The desktop opens a ghostty + zellij **`pui` dock** (`~/.papercusp/pui-chat-dock.kdl`).
Its **🛡 sentinel** pane runs `psu --no-picker --agent=claude --role=operator`
(`apps/tui/src/layout.rs:260-261`) — which is a **genuine `claude` (Claude Code)
process** (`apps/operator/scripts/psu-launcher.mjs` `roleFlow`:1667 →
`roleLaunchArgs`:224-251 execs the raw `claude` CLI with
`--append-system-prompt-file <rolePrompt> --mcp-config <signed .mcp.json>
--strict-mcp-config --permission-mode bypassPermissions`). Prompt + MCP are
assembled by `buildRoleLaunchSpec` (`packages/operator-core/lib/role-launch-spec.ts:154`;
workspace persona via `assembleWorkspaceRolePrompt`:328-385; signed **role-scoped**
MCP URL `role=operator`:272-291). It launches fine (auth via
`~/.papercusp/superuser-token`; `--no-picker`; role resolves) — **but it is inert
and disconnected:**

| Gap | Evidence |
|---|---|
| **No voice I/O** | Voice → `routeVoiceUtteranceToConverse` → `operator:converse` only (`VoiceAppBridge.tsx`~119, `voice-converse-bridge.ts:42`). Nothing writes STT into the Claude pane's stdin; nothing speaks its output. |
| **Off the shared thread** | The Claude session keeps its own `.jsonl` (`CLAUDE_CONFIG_DIR`, role-launch-spec.ts:307). It never touches `operator_conversations` (`operator-conversations.ts`, `getOrCreateActiveConversation`, route `…/operator/conversations.ts:26`) — which the webview text+voice + the `apps/tui` ratatui all share. |
| **Wrong role** | It runs the **operator** (placement/decider) kernel role (`role-registry.ts:139`; caps `role-principal-caps.ts:116-149` = harness/work_items/plans/curation/coord) — **not** the **sentinel** (Sentinel) conversational role (caps incl. `operator:converse`/voice at `role-principal-caps.ts:62-76`). |
| **No cards** | `chat:ask_choice` needs `ctx.askUser` (`ask_choice.ts:130-142`), bound only on a `runId`-carrying converse/oracle dispatch via the card-correlator. A raw Claude-Code MCP client → `{error:'no_chat_surface'}`. |
| **Prior work missed it** | Phase-1 (voice→`operator:converse`) + Phase-2 (cards in the `apps/tui` **ratatui**) wired `operator:converse` + the webview + the ratatui — **not** this Claude pane. |

**Silver lining:** the Claude TUI runs on **Claude Max**, *not* the fleet's LLM
account pool — so it is **testable even while the pool is rate-starved** (the
current state blocking `operator:converse`).

---

## 1. Target architecture

```
        ┌─────────────── shared operator_conversations thread (PG) ───────────────┐
        │                                                                          │
  voice (STT) ─┐                                                          ┌─ webview chat UI (text)
               ├──► 🛡 Sentinel = psu --role=sentinel (Claude Code, Claude Max) ──┤
  voice (TTS) ◄┘     · Sentinel persona · reads/appends the shared thread           └─ (optional) ratatui mirror
                     · dispatches engineering to the Queen
                     · asks structured choices via a card bridge
```

> **Constraint (owner, 2026-06-22) — LOCAL APP USER ONLY.** The Sentinel
> communicates *only* with the local user of the app, via the local **webview
> STT/TTS pipeline ↔ the Claude-TUI pane**. The **P2P voice-channel system**
> (`voice:join`/`leave`/`channels`/`transcript`) is **NOT** the path for
> Sentinel↔user voice (that's a different, multi-peer system). So: voice-IN =
> local STT → the pane's stdin; voice-OUT = the pane's reply → the local
> `speak()`/TTS. Do not wire the Sentinel into P2P channels for user voice.

- The **Sentinel brain = a full Claude-Code agent** (Sentinel persona), not
  `operator:converse`.
- **Voice in:** STT final-utterances are written to the Sentinel pane's PTY stdin.
- **Voice out:** the Sentinel's spoken replies are captured and TTS'd.
- **One thread:** the Sentinel reads + appends `operator_conversations`, so the
  webview and voice see the same transcript.
- **Cards:** plain-text Q&A first; a blocking-ask MCP bridge later.

---

## 2. Phases

### Phase A — Launch the pane as the Sentinel role
- Change the dock generator (`apps/tui/src/layout.rs:260-261`) + `pui-chat-dock.kdl`
  sentinel pane to `psu --no-picker --agent=claude --role=sentinel` (or a new
  dedicated role if the existing `sentinel` role's caps are wrong for a front door).
- Confirm `assembleWorkspaceRolePrompt` loads `sentinel.persona.md` +
  `sentinel.tools.md` for the harness-less role (it already prefers `<role>.*`).
- Review/adjust the role's MCP cap set (`role-principal-caps.ts`) for a front-door
  agent: conversation read/append (new — Phase B), work_items/plans, dispatch-to-Queen,
  voice:* , and the card tool (Phase E). Drop placement-only caps it doesn't need.
- **Verify:** dock pane starts a usable Sentinel Claude session (Claude Max), responds
  to typed input. Test via §16 of `testing/agent-e2e` (dump-screen / write-chars).
- **Risk:** the `sentinel` role today carries `operator:converse` (a cap for the
  *lighter* brain) — as a full Claude agent it should NOT call converse; prune that
  and give it direct tools instead. Decide new-role vs reuse-and-prune.

### Phase B — Shared conversation thread (the hard one)
- Goal: voice(webview) + webview-text + the Claude Sentinel all on ONE
  `operator_conversations` thread (`getOrCreateActiveConversation`).
- **Approach (recommended): an MCP tool, not a transcript projector.** Add a
  sentinel-role tool pair (e.g. `conversation:recent` read + `conversation:append`
  write) over `operator-conversations.ts`. At launch, inject the last N turns of the
  active conversation into the Sentinel's system prompt (via `buildRoleLaunchSpec`),
  and have the Sentinel `conversation:append` each user+assistant turn (with
  `source:'voice'|'text'`). The webview already live-syncs the thread (`useSyncQuery`),
  so its turns appear in the webview instantly.
- **Alternative:** project the Claude `.jsonl` → `operator_conversations` (a watcher).
  More brittle (format mapping, dedup). Prefer the MCP-tool approach.
- **Risk:** this is the hardest piece — Claude's transcript store ≠ the PG thread.
  Keep the Sentinel the *writer of record* (append-on-turn) to avoid two sources of truth.
- **STATUS 2026-06-22 (investigated, READY for a fresh session — NOT built).** All
  building blocks confirmed with NO schema change: `operator-conversations.ts` exposes
  `getOrCreateActiveConversation`, `listTurnsRecent({conversationId,…})`, `appendTurn(…)`
  on `harness_shared.operator_conversations`; launch injection goes through
  `composeLaunchContext` (`su-launch-context.ts`) called from `buildRoleLaunchSpec`
  (⚠ FLEET-WIDE — gate to the sentinel role + change carefully, like psu-launcher).
  **Refinement:** because Phase C (DONE) routes voice-in to the SENTINEL PANE (not
  `operator_conversations`), the voice convo no longer flows through the PG thread —
  so the **append direction is the essential one** (the Sentinel must
  `conversation:append` each user+assistant turn so the webview reflects it); read /
  launch-inject is secondary. Build order: the two additive MCP tools first
  (low-risk), the persona "append every turn" instruction, then the fleet-wide
  `buildRoleLaunchSpec` injection LAST + carefully.

### Phase C — Voice IN (STT → Sentinel stdin)
- The Sentinel pane is a PTY child managed by the dock/`psu-pty-host.mjs`.
- Add a path so a final STT utterance is **written to that pane's stdin** (text +
  Enter), analogous to the dock's KDL `Write` keybindings.
- Re-target the voice runtime: replace `routeVoiceUtteranceToConverse(text)` with a
  "send to the Sentinel PTY" call. Likely a small IPC/endpoint the voice host hits
  that the PTY host (or zellij `action write-chars`) fulfills against the sentinel pane.
- Reuse the existing voice runtime unchanged (STT engines, local-whisper fallback,
  VAD, PTT, `fullAgentEngine:'off'`).
- **Risk:** writing into a live interactive Claude pane (focus, race, multi-line). Use
  a deterministic submit (bracketed paste + Enter) and confirm via dump-screen.

### Phase D — Voice OUT (Sentinel reply → TTS) — DONE (code)
- **Built via an MCP `voice:say` tool** (`agent-tools/voice/say.ts`), NOT the
  Stop-hook/`<say>`-capture the plan first proposed. The Sentinel calls
  `voice:say(text)` to speak; the tool pushes the line into the in-process buffer
  (`sentinel-output-buffer.ts`); the webview voice runtime polls `GET
  /api/operator/sentinel-output` (`VoiceAppBridge` + `drainSentinelOutput`) and
  runs each line through the local `speak()`/TTS. Persona instructs it
  (`sentinel.persona.md` "How you speak"). `voice:say` is `capability:
  'operator:read'` + `agentRoles:['sentinel']` (the sentinel's `voice:*` mapping),
  so no role-cap change was needed; `tools-md-sync` green.
- **Why the tool, not capture:** no transcript parsing, no screen-scraping, no
  operator-URL discovery, no per-session hook config — the agent explicitly emits
  what's spoken (so tool noise/code is never TTS'd) and it's in-process.
- The `POST /api/operator/sentinel-output` endpoint also exists (CSRF-guarded) for
  a future hook/alt-emitter, but `voice:say` is the path.
- **Risk:** relies on the persona calling `voice:say` for spoken lines (vs auto
  capture) — acceptable + gives the agent control; revisit if it under-speaks.
- **⚠ LIVE-TEST FINDING (2026-06-22) — voice-OUT not yet wired across processes.**
  Voice-IN is VERIFIED working end-to-end (endpoint → sentinel pane → the sentinel
  replied). But voice-OUT has TWO gaps: (1) the dock sentinel's MCP points at
  **`localhost:3070`** (the GREEN/main operator, per
  `.papercusp-workspaces/.../.mcp.json`), which does NOT yet have `voice:say` — my
  changes are on staging, so the sentinel can't call the tool until the green deploy
  lands it (git-sync → green-checkpoint → main → :3070, or a force-deploy). (2) The
  in-memory `sentinel-output-buffer` does NOT bridge the operator the sentinel
  pushes to (:3070) and the one the webview polls (:3270) — separate processes —
  AND it violates the PG storage policy. **FIX: make the buffer PG-backed** (a
  migration via `db:migrate` + rewrite `sentinel-output-buffer.ts` to INSERT on
  push / SELECT+DELETE on drain) so push and poll bridge regardless of operator.
  Both are needed before voice-OUT works live.
- **UPDATE 2026-06-22 (PG buffer ATTEMPTED + REVERTED — needs a clean DB).** Wrote
  the PG-backed buffer + migration `381-sentinel-says.sql` (`harness_shared.sentinel_says`)
  but reverted both, because: (a) no running operator picks up working-tree edits
  cleanly this session — `:3170` runs a LAGGING checkout, so the POST→GET "round-trip"
  that looked green was actually the OLD in-memory buffer, NOT PG (invalid verification);
  and (b) the dev `:5432`/`papercusp` DB is DRIFTED (~37 columns) from the committed
  schema, so a local `pull-schema` can't regenerate a clean `generated.ts` — and
  committing a migration WITHOUT the matching `generated.ts` fails CI's drift gate and
  blocks ALL deploys. The buffer is back to in-memory (async signatures kept so the PG
  swap stays drop-in). **DO THE PG BUFFER IN A FRESH SESSION ON A CLEAN DB:** re-add
  migration 381, apply it on a non-drifted DB (CI's testcontainer path, or a clean
  embedded-pg), run `pull-schema` THERE, commit the clean `generated.ts`, then swap
  `sentinel-output-buffer.ts` in-memory→PG (INSERT on push / `WITH d AS (DELETE …
  RETURNING) SELECT … ORDER BY id` on drain). voice:say must also reach `:3070` (green)
  via the deploy pipeline.

### Phase E — Cards (structured choices)
- **Near-term — DONE (2026-06-22):** plain-text Q&A via a persona instruction —
  `sentinel.persona.md` § "How you offer choices (cards)" tells the Sentinel to
  speak a short NUMBERED list through `voice:say` ("Two options: one … two … Which?")
  and accept a voice/number reply. Zero new infra; works in a raw Claude pane.
- **Later (rich cards):** a sentinel MCP tool that **blocks + round-trips through the
  reusable server machinery** (card-correlator → `openCards` state-channel →
  `/card-response` → `resolveCardResponse`; all intact per the old plan §10), rendered
  in the **webview** or a **separate pui pane** (a real Claude pane can't render the
  card inline). Reuse the ratatui `card_view.rs` widget if cards live in a pui pane.

---

## 3. Reused vs replaced

| Prior work | Verdict |
|---|---|
| Voice **runtime** (STT/whisper fallback, `speak()`/TTS, VAD, PTT, `fullAgentEngine:'off'`) | **Reused** — only the routing *target* changes (→ Sentinel PTY, not converse). |
| Phase-1 **routing** (voice→`operator:converse`) | **Replaced** — converse is the brain we're superseding. |
| Phase-2 **ratatui cards** (`apps/tui/card_view.rs`) | **Wrong surface** — keep only if cards render in a pui pane; otherwise superseded by Phase E. |
| **Server card machinery** (correlator, `openCards`, `/card-response`) | **Reused** for Phase E rich cards. |
| `<say>` **tag convention** (`chat_tags.rs`, `operator-converse-tags.ts`) | **Reused** for Phase D. |
| **zellij-pane testing** (`testing/agent-e2e` §16) | **Reused** — the verification method for every phase. |
| **UI work already shipped** (left-rail voice bar, Novice rename, Sentinel lexicon, 3-state toggle, collapse control, no-store shell) | **Kept** — independent of the brain redesign. |

---

## 4. Open decisions (resolve before/while building)
1. **Retire `operator:converse` for the user chat, or keep it as a webview fallback?**
   Owner intent ("full claude tui") ⇒ the Claude Sentinel is the front door; decide
   whether the webview chat UI is retired, repointed at the shared thread (read-only
   mirror), or kept as a degraded fallback.
2. **A new dedicated role vs reuse+prune the existing `sentinel`** (Phase A caps).
3. **Voice-out:** `<say>` tag (recommended) vs output capture.
4. **Cards:** plain-text only for v1, or build the blocking-ask bridge + pick its
   render surface (webview vs pui pane).
5. **Thread mechanism:** MCP read/append tool (recommended) vs `.jsonl` projector.

---

## 5. Testing
- Drive the Claude Sentinel pane via **`testing/agent-e2e` §16** (`zellij … action
  dump-screen` / `write-chars`; screenshot the dock window).
- The Sentinel runs on **Claude Max**, so end-to-end voice+text is **testable now**,
  independent of the rate-starved account pool.
- Per phase: A → typed turn gets a Sentinel reply; B → a webview turn appears in the
  Claude pane's context and vice-versa (one thread); C → a simulated/real STT
  utterance reaches the pane; D → the reply is TTS'd; E → a choice round-trips.

## 6. Risks
- PTY stdin bridging into a live interactive Claude pane (C).
- Thread unification / dual source-of-truth (B) — the hardest piece.
- Voice-out reliability + keeping spoken text concise (D).
- Role caps: giving the Sentinel the right (and not too many) tools (A).
