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
- [ ] **P3 — Handoff depth** (extend SN01/SN02): urgent vs normal, multi-item,
  "I'll do it myself" (no handoff), tier-gate. Judge brief quality.
- [ ] **P4 — Full-flow UI integration**: text → Sentinel tab renders reply → TTS
  toggle gates speech. Playwright e2e spec if supported, else agent-e2e checklist.
- [ ] **P5 — Run + review**: `llm-test --target sentinel` against live `:3070`
  (real workspace for P2); capture rubric scores + transcripts; iterate weak spots.

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
