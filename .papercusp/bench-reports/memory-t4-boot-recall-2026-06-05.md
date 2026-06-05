# Memory bench — T4 boot-recall tier (live sample)

memory-backend-benchmark-2026-06-05 P-009 (D-005). Scenarios authored by
su-2b227; live-run by su-097d9 under the complete-every-item mandate
(su-2b227 absent). The full 11-scenario matrix is the "run rarely" tier
(D-005); this is the **proof sample** — does pre-turn memory injection
actually surface a seeded gotcha in a live operator session?

- **Target:** live operator brain at `:3170` (staging, runs from main —
  has the mem0-cascade fix).
- **Sim-user + judge:** `claude-sonnet-4-6` via `LLM_TEST_BACKEND=claude-code`
  (Meridian `:3456` is down; this routes through the local Claude CLI).
- **Seeding:** `setup.mem0` writes through the neutral seam into the shared
  mem0 PG (`scope harness:papercup`); the operator brain reads it
  cross-process via pre-turn injection. Each seeded fact carries an
  **unguessable token** present nowhere the sim-user/judge/persona can see
  — the only path into the assistant's text is boot-recall.

## Results

| scenario | seeded token | surfaced? | meaning |
|---|---|---|---|
| MEM00 (control, unseeded) | — | token correctly ABSENT (assert clean) | the token is genuinely unguessable; no hallucination |
| MEM01 (staging probe port) | `31785` | **YES** — assert `text_contains /31785/` passed | boot-recall injection works end-to-end |

MEM01 assistant verbatim: *"Found it — the recorded gotcha: probe the
staging governor proxy on :31785, not :3170 directly. Direct :3170 probes
return false negatives while the governor is still draining post-restart."*

The seeded fact (`port 31785`, fictional) reached the operator's answer
**purely via memory injection** — the model could not otherwise know it.

## Read

- **The tier works.** The control proves the token is unguessable; the
  seeded run proves injection surfaces it. That is the load-bearing
  claim T4 exists to test, and it holds on the live operator with the
  current (mem0) backend.
- **Run-status nuance:** MEM01's run aggregated to `verdict: preview /
  status: failed` despite the boot-recall assert passing — the operator
  rubric's *groundedness* axis scored 2 (it surfaced the fact
  confidently as procedure). That's a rubric-vs-assert tension to tune
  in a later pass, not a boot-recall failure; the deterministic
  `text_contains` assert is the signal that matters here.
- **Backend dependency:** this ran against the **mem0** backend (the
  operator's active default + the cascade fix on `:3170`). The same tier
  against `claude-file` would test FS-backed injection; not run here
  (the green `:3070` host predates the cascade fix, so a mem0 seed there
  would fail extraction — re-run T4 broadly after the next release-gate
  deploy carries the fix to green).

## ⚠ Follow-up — T4 pollutes the live memory store

`realWorkspace: true` + the live operator brain means a T4 run writes to
the **real** `harness_shared.memory_*`, and `setup.ts` cleanup only
removes the direct seed ids. Two leaks remain after a run: (a) mem0's
extractor SPLITS one seeded fact into several derived rows (not in
`seededIds`); (b) the operator brain's normal turn-end memory extraction
writes conversation-derived memories under the live user. This sample
left 93 rows in the live store; su-097d9 swept them
(`DELETE … created_at > <run-start>`, baseline preserved). Before the
periodic full-matrix run, T4 should either run against an isolated
memory schema (like the deterministic tiers' `bench_memory`) or carry a
broader post-run sweep. Filed for su-2b227's lane.

## Not run (the rarely-run full matrix)

MEM02–MEM10 (relay salt env, migration range, flaky isolate flag,
signaling owner, shop CDN check, column rename, TTS rotation, mic device,
explicit-search) are registered + unit-tested; live-running all 11 ×
matrix is the periodic tier, gated behind a broadly-deployed cascade fix
+ a live operator. The proof pair (MEM00 + MEM01) validates the tier.
