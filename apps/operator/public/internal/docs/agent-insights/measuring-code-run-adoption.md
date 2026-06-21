# Measuring code:run adoption + token impact (a systematic A/B)
URL: /internal/docs/agent-insights/measuring-code-run-adoption

How to A/B-test whether agents reach for code:run, the token cost with-vs-without it, and which prompt-enforcement style maximizes adoption — using the llm-testing variant seam (excludeTools + promptOverlay + variantId) on the cheap, uncontended haiku bucket.

`code:run` collapses N tool round-trips into one inference call, so getting agents to **reach for
it** is a direct lever on tokens-per-task. This is the repeatable way to measure adoption, the
token delta of the tool's availability, and which prompt-enforcement style raises adoption — without
a live operator, on the cheap/uncontended haiku bucket.

## The seam (what makes it an A/B)

Three pieces in the in-process `su` target (`targets/su.ts`), all reusable for any tool-adoption A/B:

1. **`configDelta.excludeTools: string[]`** — drops canonical tool names from the catalog offered to
   the SUT for that run (`filterCatalog`). This is the **with-vs-without-availability** arm: run the
   same scenario once with `code:run` present and once with `{ excludeTools: ['code:run','code:tools'] }`
   to measure the token cost the tool removes.
2. **`variant.promptOverlay` / `configDelta.systemPromptText`** — the **enforcement-style** arms: an
   overlay *appends* an enforcement clause (additive); `systemPromptText` *replaces* the whole system
   prompt (use the exported `loadPlaybookBody()` + `SU_PLAYBOOK_FRAMING` to build a nudge-stripped or
   nudge-rewritten variant for a clean "no nudge" / "alternative wording" arm).
3. **`variantId` persisted to `llm_test_runs.telemetry_json`** (`storage.ts`) — so arms group natively
   in SQL: `telemetry_json->>'variantId'` (baseline runs have none → `COALESCE(...,'baseline')`).

## The recipe

Each arm is a variant JSON; the CLI applies it and persists the tag. Run on haiku — it's cheap,
its rate bucket is uncontended (the fleet burns sonnet/opus), and it has *adoption headroom* so
enforcement deltas actually show (a model that already adopts perfectly, like opus, shows no signal).

```bash
# arm files: {id, promptOverlay?, configDelta?}
echo '{"id":"no-coderun","configDelta":{"excludeTools":["code:run","code:tools"]}}' > /tmp/var-noco.json
echo '{"id":"strong-enforce","promptOverlay":"## code:run — strongly prefer it ..."}' > /tmp/var-strong.json

cd apps/operator
export PAPERCUSP_ANTHROPIC_URL=http://127.0.0.1:8788   # route through the gateway pool (EI-456) — else you 429
export PAPERCUSP_LLM_TEST_SKIP_CLAIM=1                 # sequential A/B; skip the per-scenario claim
export LLM_TEST_SUT_MODEL=claude-haiku-4-5 LLM_TEST_JUDGE_MODEL=claude-haiku-4-5 LLM_TEST_SIM_MODEL=claude-haiku-4-5

npm run llm-test -- --scenario su-S13-code-run-batch                              # baseline
npm run llm-test -- --scenario su-S13-code-run-batch --variant @/tmp/var-noco.json
npm run llm-test -- --scenario su-S13-code-run-batch --variant @/tmp/var-strong.json
```

Then the grouped read (deterministic asserts are the source of truth — the judge is secondary):

```sql
SELECT replace(scenario_id,'-code-run','') AS scenario,
       COALESCE(telemetry_json->>'variantId','baseline') AS arm,
       count(*) n,
       count(*) FILTER (WHERE status='passed') AS clean_adopt,          -- reached code:run AND didn't hand-loop
       count(*) FILTER (WHERE transcript_norm_json::text LIKE '%code:run%') AS reached_coderun,
       round(avg(cost_usd)::numeric,4) AS mean_cost                     -- token proxy (sim+sut+judge)
FROM harness_shared.llm_test_runs
WHERE started_at > '<AB_START>'::timestamptz AND sut_model='claude-haiku-4-5'
GROUP BY scenario, arm ORDER BY scenario, arm;
```

## The scenarios (the task shapes)

* **`su-S13-code-run-batch`** — 12-item per-item loop; the headline "do X for each of N" case.
* **`su-S15-code-run-small-batch`** — only 3 items; the *low-N* threshold ("reach for it even at 3").
* **`su-S16-code-run-batch-write`** — per-item WRITE; the dry-run/confirm-gate path.
* **`su-S14-code-run-not-for-single`** — the **guard**: a single-fact call must NOT be wrapped in
  code:run (over-application). Any adoption push must keep S14 green.

`reached_coderun` (did it call the tool at all) and `clean_adopt` (called it AND didn't *also*
hand-loop) are different metrics — a weak model often does both, which inflates `reached` while
`clean` stays low.

## Two caveats that bound what haiku can tell you

1. **The token-win needs CLEAN adoption to manifest.** A model that calls `code:run` *and* still
   hand-loops pays more, not less. Haiku rarely batches cleanly (capability ceiling), so on haiku the
   no-coderun arm costs about the same as baseline — both hand-loop. The real several-fold win shows
   on a capable model (sonnet/opus) that commits to one script. (Demonstrated live: an Opus su
   collapsed 4 tool calls into one `code:run`.) Measure the token delta on **sonnet** when the pool
   is free (drop the `LLM_TEST_*_MODEL` overrides); haiku is for the adoption/enforcement signal.
2. **The in-process target caps the SUT loop** (`MAX_TOOL_ITERATIONS`), so a hand-looping arm can't
   blow up past the cap — the measured token delta UNDERSTATES a real agent's (which has no such cap).

## Empirical findings (2026-06-21, haiku, N=3 — directional)

* **The token mechanism, measured: availability cuts tool calls \~3×.** On S13 the `no-coderun` arm
  made **\~16 tool calls** (hand-loops every item); every code:run-available arm made **\~5–7**. The
  *dollar* delta is muted (no-coderun $0.0204 vs baseline $0.0172, \~16%) ONLY because the in-process
  target caps the SUT loop at `MAX_TOOL_ITERATIONS` — a real uncapped agent pays the full \~3× in
  re-read context, so **`mean_calls` (16 → 6) is the truer proxy than `mean_cost` here**.
* **Enforcement raises *reaching* without over-application.** `strong-enforce` and `reflexive`
  overlays took S13 `reached_coderun` 2/3 → 3/3 while S14 stayed 3/3 pass with zero code:run — a
  stronger nudge did not cause the model to wrap single calls. `strong-enforce` was even cost-NEGATIVE
  vs baseline ($0.0164 \< $0.0172).
* **It does not fix CLEAN adoption on a weak model** — `clean_adopt` stayed \~0–1/3 across arms
  (haiku reaches for code:run but redundantly hand-loops too). The clean win is model-capability-gated.
* **Low-N is the hardest case for a weak model** — S15 (a 3-item batch) baseline got 0/3
  `reached_coderun` even under the aggressive nudge: haiku just fires 3 direct gets. The "reach for it
  even at 2–3 calls" framing is aimed here; whether it moves a capable model is the sonnet re-run's job.
* **Action taken:** folded the `strong-enforce` framing ("prefer it aggressively — batching cuts
  tokens several-fold, reach for it even at 2–3 calls") into the canonical `CODE_RUN_NUDGE` + the su
  prose copies, since it raises reaching with no over-application downside and matches the operator's
  stated preference (adopt aggressively even at a small per-call cost). Re-run the A/B on sonnet to
  confirm the clean-adoption + token deltas on the real fleet model.

## Code recipes — the reuse layer that makes the win compound

Adoption (above) makes ONE agent's `code:run` cheap. **Code recipes** (plan
`code-recipes-2026-06-21`, shipped 2026-06-21) make it cheap for *every* agent after, and
self-promote the hottest patterns into first-class tools:

* **Capture:** every successful `code:run` is auto-saved as a hive-scoped *recipe* (best-effort,
  never breaks a run) — `agent-tools/code/capture-recipe.ts`, `code-recipes-store.ts`, migration `349`
  (`code_recipes` + `code_recipe_runs`).
* **Soft dedup:** on run, a hybrid `@papercusp/search` (BM25 + pgvector + tool-set Jaccard) surfaces
  similar recipes *in the result* — the LLM decides reuse-vs-proceed, never blocked
  (`code-recipes-search.ts`).
* **Reuse:** `recipes:list/get/search/run`; `recipes:run` executes under the **reuser's** role
  envelope, never the author's (tested invariant).
* **Graduation:** `recipes:candidates` scores recipes deterministically (run-frequency × distinct-agent
  breadth × success × tool-cohesion − redundancy; canonical formula in `code-recipes-candidates.ts`),
  scored against the **`recipe-graduation-readiness`** rubric. The **Queen** owns idle-gated review
  (`queen.base.md`): she files a work-item to promote a hot recipe to a `defineTool` (the coding
  pipeline's review IS the gate) or merge near-duplicates (`recipes:merge`/`recipes:sweep`).

This is the same "frequency is proven demand" principle as the adoption A/B, but applied to *genesis*:
a recipe run many times by many agents is a tool candidate with the implementation already written —
a better signal than scout/observation guessing at a missing tool. Complements
`tool-call-batching-wrappers-2026-06-21` (hand-curated fixed-ritual wrappers) — shared
`dev:tool_cooccurrence` signal + shared catalog labeling.
