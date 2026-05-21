---
title: Operator behavior tests — 2026-05-14 (v3, implemented)
slug: operator-behavior-tests-2026-05-14
status: active
created: 2026-05-14
updated: 2026-05-20
owner: pandawamble@gmail.com
---

## Now

**State:** P1–P4 shipped. P5 attempted 2026-05-20: a first triage pass ran and surfaced framework-robustness bugs (since fixed — see §13). The P5 *clean* live run is BLOCKED on the Next.js→Vite migration, which has removed `app/api/agent-mcp/operator-converse/route.ts` — the SUT endpoint the framework drives.

**Next:** When the operator endpoint is stable post-migration, run the §12 procedure for the full triage. See §13 for the resumption checklist.


# Operator behavior tests — 2026-05-14 (v3, implemented)

**Status:** Implementation in flight. Framework extensions (P1) +
all 12 M-scenarios (P2–P4) shipped; P5 live triage run pending an
ANTHROPIC_API_KEY-backed full-pass invocation.

Pairs with:
- `apps/operator/prompts/operator.converse.md` — source-of-truth for
  the brain's behavior.
- `apps/operator/docs/plans/active-mode-proactive-ticks-2026-05-14.md`
  — four end-of-turn outcomes (continue / ask / terminal / sleep).
- `apps/operator/docs/plans/voice-aware-cards-2026-05-14.md` v2 — out
  of scope but referenced in §10.

---

## 1. Goal

Translate each brain-emission contract from the operator synthesis
into runnable llm-testing scenarios. A passing nightly run signals
the operator's emission shape matches the prompt + active-mode plan.

**Brain-emission only.** Provider-side behavior (mode-state, auto-
fire heuristics, continue-chain cap enforcement, silence-nudge route
emission, voice STT routing) is a separate concern with separate test
surfaces. See §10.

## 2. Coverage map

| # | Synthesis assertion | Reachable? | Scenario |
|---|---|---|---|
| §13.3 | `<continue/>` paired with `<say>` | ✅ | M1 |
| §13.4 | After `chat:ask_choice` turn ends | ✅ | M2 (shared) |
| §13.6 | Opener never "what can I help" | ✅ | M3 |
| §13.7 | ≤1 question per turn | ✅ | M4 |
| §13.8 | Panel verbs map to panel tools | ✅ | M9 |
| §13.9 | `<spawn role="worker"/>` has `chunk` | ✅ | M5 |
| §13.10 | `<sleep>` + `<say>` never together | ✅ | M6 |
| §13.11 | `<continue/>` + `chat:ask_choice` never together | ✅ | M2 |
| §13.13 | After `user_says_ready`: 2–3 options | ✅ | M7 |
| §13.1 | Active terminal auto-fires `user_says_ready` | ❌ | deferred — provider state |
| §13.2 | Continue cap 5/300s enforcement | ❌ | deferred — provider state |
| §13.5 | Passive never auto-fires | ❌ | deferred — provider state |
| §13.12 | Silence-nudge via server route | ❌ | deferred — infra |

Plus synthesis §10 negative rules (ideas-not-operator's, no
implementation asks, no stacked questions) — judge-axis coverage in
M10–M12.

## 3. Scenarios shipped (12 / 12)

Deterministic-leaning (M1–M9) + judge-leaning (M10–M12). Filenames
under `apps/operator/lib/llm-testing/scenarios/operator/`.

See each scenario file's docstring for the exact contract.

## 4. Framework extensions (P1, shipped)

- `asserts/operator-format.ts` — 9 custom evaluators with 42
  adversarial unit tests.
- `targets/operator.ts:extractControlTags` — extended to match
  `set_mode` paired tag.
- `lib/llm-testing/tape-ordering.ts` — `findEventsAfter` +
  `deltaTextAfter` helpers with 6 unit tests.
- `rubrics/operator.ts` — added `ideasOwnership` axis; bumped
  `OPERATOR_RUBRIC_VERSION` to `1.1.0`.

## 5. Coexistence with existing S0/S1

- S01–S12 + S12b stay on disk untouched (per `feedback_no_ts_deletion`).
- The rubric bump (1.0.0 → 1.1.0) ripples through their identity_hash
  on next run — expected side-effect; historical PG rows at 1.0.0
  stay queryable but don't trend-compare to 1.1.0+ runs.
- `pnpm llm-test --target operator` runs all 25 operator scenarios
  (13 S + 12 M) per pass. Cost section below assumes this.

## 6. Cost — honest accounting

Recorded (sim + judge only — operator-converse SSE emits `costUsd:0`):
- 8 M-scenarios @ N=3 baseline = 24 × $0.16 = $3.84
- 1 M-scenario @ N=5 baseline (M3 high-crit) = 5 × $0.66 = $3.30
- 2 M-scenarios @ N=3 high-crit (M7, M10) = 6 × $0.66 = $3.96
- 3 M-scenarios @ N=1 baseline (M4, M6, M8) = 3 × $0.16 = $0.48

**Recorded per full M-pass: ~$11.58.**

Real wallet hit (invisible SUT spend at ~$0.43/turn × 30 runs):
~$12.90 invisible.

**Real wallet hit per M-pass: ~$24.** Running all 25 operator
scenarios together (S + M): ~$48/full pass. Nightly: ~$1,440/month.

## 7. Phasing — actual progress

| Phase | Status |
|---|---|
| P1 framework extensions | ✅ shipped (98/98 vitest pass, typecheck clean) |
| P2 M1–M5 | ✅ shipped |
| P3 M6–M9 | ✅ shipped |
| P4 M10–M12 + rubric axis | ✅ shipped |
| P5 full live run + triage | attempted 2026-05-20 — framework bugs found & fixed (§13); clean run BLOCKED on Vite migration |

## 8. Guard-rail vs positive-signal

- **Guard-rail** (passes trivially when brain behaves, alarms on
  regression): M2 (mutex), M4 partial (no stacked ?), M6 (sleep
  alone), M8 (format).
- **Positive-signal** (brain must do a specific thing to pass): M1
  (continue+say), M3 (substantive opener), M5 (spawn chunk-disciplined),
  M7 (post-ready options), M9 (panel close tool), M10–M12 (judge).

## 9. Success criteria

A passing `pnpm llm-test --target operator --parallel 2` after P5
means:

1. All 9 deterministic M-scenarios pass on the majority of matrix runs.
2. All 3 judge M-scenarios — every called-out rubric axis averages
   ≥4.0 across matrix runs; `ideasOwnership` averages ≥4.0 on M10.
3. No `judgeOverruledAssert: true` rows.
4. No `inconsistent_behavior` finding with severity `warn` on
   `criticality:'high'` scenarios (M3, M7, M10).
5. All new rows have `cost_usd > 0`.

## 10. Out of scope (documented)

| Item | Why | Resolution path |
|---|---|---|
| §13.1 active-mode terminal auto-fire | Provider-state, not brain | Future operator-provider-tests plan if/when needed |
| §13.2 continue-chain cap enforcement | Provider stops firing past cap | Same |
| §13.5 passive never auto-fires | Provider mode-state | Same |
| §13.12 silence-nudge via server | Server route emission | Same |
| Voice-mode cards | EL Conv AI transport | Same |
| Mid-card mode switch (text↔voice) | Same | Same |
| Panel UI side-effect | UI layer | Existing Playwright suite |

No follow-up plan is committed to in this plan.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Framework extensions break existing S0/S1 | P1 gate ran 98/98 vitest |
| Sim-user can't reliably produce specific user statements | scenarioDescription prompts the persona explicitly. If still flaky, add scripted-user-text mechanism as a follow-up — not this plan |
| Operator brain fails many scenarios at first run | Expected. P5 triage classifies framework-bug / scenario-bug / operator-bug |
| ideasOwnership too subjective | criticality:'high' on M10 invokes second-opinion Opus pass; R5-2 inter-pass disagreement finding surfaces swings |
| Recorded cost low but real spend invisible | §6 acknowledges; SUT-side cost visibility is a framework follow-up |

## 12. P5 procedure (live run + triage)

When ready to run:

```bash
cd apps/operator
unset ANTHROPIC_AUTH_TOKEN  # framework prefers ANTHROPIC_API_KEY
pnpm llm-test --target operator --parallel 2 2>&1 | tee /tmp/m-batch.log
```

Triage each non-pass run:

1. Open `/admin/testing` → LLM → Runs, click into the failing run.
2. Read the deterministic asserts that fired + judge findings.
3. Classify:
   - **Framework bug**: assert fires for the wrong reason (e.g. tape
     parser mis-segmented; persona prompt didn't reach sim-user). Fix
     the framework; re-run the one scenario.
   - **Scenario authoring bug**: scenarioDescription doesn't actually
     drive the sim-user toward the contract. Fix the scenario; re-run.
   - **Operator bug**: brain emitted the wrong shape. File a finding
     against the operator prompt or active-mode plan.

Past 7 audit rounds during the framework build-out: most "operator
failures" turned out to be framework or scenario bugs on first
attempt. Stay disciplined.

## 13. P5 progress log

### 2026-05-20 — first triage pass + framework hardening

A first P5 pass ran the 12 M-scenarios (`--all --no-matrix`) against
the dev operator. **The run is not trustworthy as operator signal** —
the dev server (`:3055`) was flapping and the operator-converse route
was mid-teardown for the Next.js→Vite migration. Evidence the SUT was
contaminated: M8/M9 showed the "operator" firing `find`, `bash`,
`psql`, `papercusp workspace list` — none are operator tools. The SUT
was not running as the operator.

What the pass *did* legitimately surface — framework-robustness bugs,
independent of the SUT, all fixed in commit `676746e7`:

| Bug | Symptom | Fix |
|---|---|---|
| `temperature` 400 | Calls intermittently 400'd with "temperature is deprecated" | `llmCall` retries-without-temperature on that error class (`isTemperatureDeprecatedError`); self-heals any model that newly deprecates the field |
| Judge non-JSON | M6 → `judge[meta]` "Judge response was not valid JSON" on first miss | `tryParseJson` gains brace-span extraction; `judgeRun` does one strict-JSON repair retry before the parse-failed finding |
| Judge scores broken SUT | M11/M12 empty SUT turns → judge produced confident axis failures describing the dead environment | SUT-health gate: `inconclusiveReason` detects errored/all-empty runs; runner skips the judge and emits one clean `meta/sut_no_output` finding via `buildInconclusiveJudge`. Such runs are `status=errored`, not `failed`. |

Tests: +28 unit (`llm-client.test.ts`, `runner-inconclusive.test.ts`).
Full llm-testing suite 122 pass. `telemetry-tagging-audit.test.ts`
fails — migration casualty (reads the removed `operator-converse/route.ts`),
not in scope here.

### Resumption checklist (when the operator endpoint is stable)

1. Confirm the post-migration operator-converse endpoint URL/port and
   update `OperatorTarget` `baseUrl` default in `targets/operator.ts`
   (currently `http://127.0.0.1:3055`) — or set `PAPERCUSP_OPERATOR_URL`.
2. Smoke one scenario: `npx tsx bin/llm-test.ts run --scenario op-S01-status-quick --no-matrix`.
   Expect a real transcript, not `finishReason=error`.
3. Run the §12 procedure (`--target operator --parallel 2`).
4. Triage per §12. The SUT-health gate now means a genuinely broken
   SUT yields `errored` + `meta/sut_no_output` — distinguishable at a
   glance from real operator `failed` verdicts.
5. Update §7 P5 row + this log with the classified results.
