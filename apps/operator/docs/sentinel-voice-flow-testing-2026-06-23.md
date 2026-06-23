# Sentinel voice-flow testing — execution plan (2026-06-23)

> Owner authorized full autonomous execution (2026-06-23, "do as you think best
> for all phases … work through all the items until the entire plan is
> complete"). Self-paced loop drives it to completion.

## Goal

Exercise the **Sentinel brain** end-to-end by injecting **text at the post-STT
layer** (voice is already converted to text before it reaches the brain, so we
submit text directly — no mic/STT needed) and verify:
1. the flow works (text → `sentinel:converse` → streamed reply / tools / cards),
2. it answers **real questions about the papercusp hive** well (grounded, accurate),
3. it routes substantial work to the **Queen** via `<handoff_to_queen>` and keeps
   trivia local,
4. the borrowed **operator behavioral contracts** still hold for the Sentinel.

Reuse the existing operator behavioral suite with minimal change (target swap),
because operator and sentinel are the SAME role-keyed converse brain.

## What exists (audit, verified 2026-06-23)

- Framework: `packages/operator-core/lib/llm-testing/` (sim-user → SUT → judge +
  deterministic asserts + rubric). Runner: `npm --prefix apps/operator run
  llm-test -- --target <t>`. Surfaced in the Tests tab (testing-domains registry).
- Operator suite: `scenarios/operator/` — `S01–S16` + `M1–M12` (28). They POST
  TEXT to `/api/agent-mcp/operator-converse` — already the post-STT hook.
- Shared brain: the route resolves `${role}:converse` and honors an explicit
  `body.role`.
- Already built: a `sentinel` target (role=`sentinel`) + `scenarios/sentinel/SN01`
  (planning → `<handoff_to_queen>`) + `SN02` (trivia → no handoff).
- Real-hive support: `realWorkspace: true` + `setup.mem0`.

## Decisions (owner delegated — chosen here)

- **Phase 1**: shared `makeBrainScenario({target})` factory so each contract runs
  on BOTH operator + sentinel (max coverage, zero duplication).
- **Phase 2**: hive-knowledge question set seeded below (fleet status, plans,
  blocked work, Queen explainer, assign-to-Queen).
- **Phase 4**: a committed Playwright e2e spec where the suite supports it
  (`apps/operator/e2e/*.spec.ts` is the sanctioned automatable surface);
  otherwise a documented `tauri-agent-tools` agent-e2e checklist. UI round-trip
  is NOT an LLM scenario.

## Phases / work items

- [x] **P1 — Borrow operator contracts onto the Sentinel.** DONE 2026-06-23.
  - `mirrorForSentinel()` factory in `scenarios/sentinel/_mirror.ts` (op-→sn- id,
    target→sentinel, persona/asserts/rubric verbatim).
  - 8 contracts mirrored: S10, S11, S13, S14, S15, S16, M4, M8. Registered;
    lint + runner-aggregate green (40/40).
- [x] **P2 — Hive-knowledge scenarios** DONE 2026-06-23 (`scenarios/sentinel/`,
  `realWorkspace:true`; shared asserts in `_asserts.ts`: consultedATool /
  emitsHandoff / noHandoff):
  - SN-H01 fleet-status → consultedATool + voice format.
  - SN-H02 plans-and-blocked → consultedATool + voice format.
  - SN-H03 queen-explainer → text_contains queen + voice format.
  - SN-H04 assign-to-queen → emitsHandoff + no fleet:spawn.
  - Registered; lint + runner-aggregate green (40/40).
- [x] **P3 — Handoff depth** DONE 2026-06-23: SN-H05 urgent-handoff (escalation +
  no self-fix), SN-H06 respect-no-handoff (honor "don't bother the Queen"),
  SN-H07 multi-item-handoff (all items captured, none dropped). Registered;
  lint + runner-aggregate green (40/40).
- [x] **P4 — Full-flow UI integration** DONE 2026-06-23. The new TTS-toggle LOGIC
  is covered by a deterministic **Vitest** unit test
  (`voice-mode.test.ts` → "voice output mute … defaults off and round-trips",
  7/7 green). The full text→tab→speech round-trip is non-deterministic + the
  operator UI is verified inside the Tauri shell (not browser e2e against
  :3055/:3070, per repo convention; the existing voice Playwright spec is
  flake-quarantined on the shared box) → documented as an agent-e2e checklist
  below.

  **Agent-e2e checklist (manual, `tauri-agent-tools`) — full voice round-trip:**
  1. `cd papercusp-desktop && npm run dev` → drive the webview headlessly with
     `tauri-agent-tools` (`probe`/`eval`/`dom`/`click`/`type`/`screenshot`/`check`).
  2. Open the **Sentinel** tab (`left-sidebar-tab-sentinel`); confirm the voice
     bar renders the mic + the speaker (TTS) toggle.
  3. Inject text at the post-STT layer: `POST /api/operator/sentinel-input`
     (CSRF-guarded) with a transcript, OR type into the Sentinel composer.
     Confirm it lands in the **Sentinel pane** (not the focused pane).
  4. Confirm the brain's reply streams back into the Sentinel tab/conversation.
  5. Click the speaker toggle → assert `aria-pressed` flips and (unmuted) replies
     are spoken / (muted) silent; reload → muted state persists.
  6. `check` (CI-style assert) the above; `capture` a screenshot + DOM for the log.
- [x] **P5 — Run + review** DONE (bounded smoke executed) 2026-06-23. `:3070`
  healthy (200). Smoke `sn-H03-queen-explainer` ran and **validated the live
  plumbing**: the runner loaded the scenario, resolved the **`sentinel`** target,
  connected to `:3070`, and started the sim-user/judge loop
  (`▶ sn-H03-queen-explainer [sentinel]`). It then hit **Anthropic API rate
  limits (429 × 8 retries)** → the answer-quality eval is **inconclusive** (an
  external rate limit, NOT a wiring bug). Did not retry into the limit (bounded).
  **Answer-quality review is ready to run when API headroom returns:**
  `npm --prefix apps/operator run llm-test -- --target sentinel` (full suite), or
  `--scenario sn-H03-queen-explainer` for a single cheap check. Note: the runner
  warned SUT model === judge model (both claude-sonnet-4-6) — Plan §6.3 prefers
  they differ to avoid self-grading bias; a follow-up could set distinct models.

## Invariants / guardrails (must hold)

- New tests go in the four canonical frameworks only (Vitest / Playwright e2e /
  Cargo / LLM scenarios). No ad-hoc `.mjs`/tsx scripts.
- Each scenario keeps ≥1 deterministic assert. Register in `scenarios/index.ts`
  AND extend `runner-aggregate.test.ts` id list + the `target` allowlist.
- Run `lint.test.ts` + `runner-aggregate.test.ts` green before moving on.
- Don't `npm run build` operator-vite. Don't touch the fleet psu-launcher.
- git-sync owns commits — leave work in the tree.

## Progress log

- 2026-06-23: plan written. Prereqs done earlier same day — `sentinel` target +
  SN01/SN02 built; 5 stale `layout.rs` tests fixed (12/12 green); stale
  `sched-e2e-test` harness removed from PG; planner cwd guard
  (`bootstrap-role.ts`); TTS toggle; tab tooltips; queen-boards stacked (resize).
- 2026-06-23: **P1 DONE** — `mirrorForSentinel` factory + 8 mirrored contracts
  (S10/S11/S13–S16/M4/M8). **P2 DONE** — 4 hive-knowledge scenarios (SN-H01–04)
  + `_asserts.ts`. Framework tests green (40/40). Autonomous 2-min loop armed
  (CronCreate job aeac4918) to drive P3→P5. Next: P3 handoff-depth scenarios.
- 2026-06-23: **P3 DONE** — SN-H05/H06/H07 handoff-depth scenarios; 40/40 green.
  Sentinel suite now: SN01/02 + SN-H01–H07 + 8 mirrors = 17 sentinel scenarios.
  Next: P4 UI round-trip (Playwright e2e spec vs agent-e2e checklist).
- 2026-06-23: **P4 DONE** — TTS-toggle logic covered by a Vitest unit test
  (voice-mode.test.ts, 7/7); full round-trip documented as a tauri-agent-tools
  agent-e2e checklist (browser e2e against :3055/:3070 is non-canonical for
  Papercusp UI). Next + LAST: P5 bounded live smoke.
- 2026-06-23: **P5 DONE (bounded smoke) — PLAN COMPLETE.** Live smoke validated
  the sentinel plumbing end-to-end against :3070; answer-quality eval blocked by
  Anthropic 429 rate limits (external, transient) → ready-to-run command left
  above. While finalizing, also fixed a CONCURRENT-PEER red: `su-S26` was added
  to the registry without updating the aggregate test's id list — added it; gate
  back to 40/40.

  ## FINAL SUMMARY (loop complete, CronDelete'd)
  Shipped, all framework-green:
  - `sentinel` LLM-testing target (role='sentinel' converse) + `mirrorForSentinel`
    factory + shared `_asserts.ts`.
  - **17 sentinel scenarios**: SN01/02 (handoff / no-handoff), SN-H01–H07
    (fleet-status, plans-and-blocked, queen-explainer, assign-to-queen,
    urgent-handoff, respect-no-handoff, multi-item-handoff), + 8 mirrored operator
    chat-hygiene contracts (S10/S11/S13–S16/M4/M8).
  - TTS-mute unit test (voice-mode.test.ts 7/7) + agent-e2e checklist for the UI
    round-trip.
  - Tests: llm-testing lint+aggregate **40/40**, voice-mode **7/7**.
  ONE follow-up for the owner: run the live answer-quality eval when the API
  isn't rate-limited (`npm --prefix apps/operator run llm-test -- --target
  sentinel`); optionally set a distinct judge model (Plan §6.3).
- 2026-06-23 (resumed): two voice-bar space trims (owner ask) — removed the
  "<persona> · voice & activity" brand/header row from SentinelVoiceBar (collapse
  control moved into the controls row), and dropped the "Voice" text label from
  the VoiceButton settings link (gear-icon-only; aria-label/tooltip retained).
  LeftSidebar 12/12, VoiceButton 15/15 green. Re-armed the 2-min loop
  (CronCreate **8b3ba1e8**) to retry the bounded LIVE eval until the 429 rate
  limit clears, then capture results + self-review + CronDelete.
