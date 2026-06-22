# Generic (non-coding) hives — the hive-blueprint domain profile
URL: /internal/docs/agent-insights/generic-hive-non-coding

How a Hive runs non-coding work. `generic-hive` is a built-in `kind:'hive'` blueprint that judges deliverables against a rubric (no tests), lands output as artifacts (no commits), and co-locates by topic (not files). The new domain-profile schema fields (acceptance/output/affinity/lexicon/fleet/wake/learning/placement) and where the engine reads each.

> **⚠️ Renamed since this was written.** The blueprint this page calls **`generic-hive`** (and its
> coding sibling **`hive`**) are now **legacy ids aliased to `work` and `coding`** —
> `libs/papercusp/packages/orchestrator/src/blueprint/loader.ts` maps `hive→coding` /
> `generic-hive→work`. `blueprintId: 'generic-hive'` still resolves via the alias, but the canonical
> blueprint dirs are `blueprints/work/` + `blueprints/coding/`. The domain-profile **mechanism** below
> (judge acceptance, artifacts output, topic affinity, the schema fields) is unchanged — only the
> blueprint *names* moved; substitute `work`/`coding` for the current ids.

## What

The Hive/Queen/bee work-queue is no longer coding-only. The blueprint engine already
carried `kind:'hive'`; what made a Hive "a coding system" was hardcoded create/runtime
policy + coding-baked personas. `hive-blueprint-generalization-2026-06-15` lifted that into
a declarable **domain profile** and shipped **`generic-hive`** — the non-coding counterpart
of the coding `hive`.

```bash
hive:create { slug: 'my-research-hive', blueprintId: 'generic-hive', wakeInSeconds: 0 }
```

stands up a Hive whose Queen places **research / analysis / deliberation** work onto bees
that produce **deliverables** (reports, decisions, documents):

* **`acceptance.kind: judge`** — "done" is an LLM judge's verdict against a rubric, not a
  test pass.
* **`output.kind: artifacts`** — deliverables persist to the artifacts store, not a repo commit.
* **`affinity.kind: topic-overlap`** — the Queen co-locates/decomposes by subject, not files.
* **`dependencies.blueprints: [research, review, vote]`** — the work-blueprints its bees spawn.

Shipped as **`generic-hive extends hive`** (D-009), NOT a strict 3-deep `base-hive` split:
the live `hive` is already the de-facto base + coding hive (repo-less, generic roles, only its
`prompts/queen.md` is file-coded), and repointing the running fleet to a renamed `coding-hive`
was the risky part. So `generic-hive` is an additive sibling; `hive` stays the coding hive.

## The domain-profile schema (where each field is read)

All additive + **optional** on `BlueprintSchema`
(`libs/papercusp/packages/orchestrator/src/blueprint/schema.ts`) — every pre-existing
blueprint parses byte-identically, so the coding fleet is unchanged.

| Field                          | Consumed by                                                                                                                                                                                                                          | Coding default (undefined ⇒)                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `acceptance.kind` + `rubric`   | `planFinalization` (`dbos/orchestrator-finalize.ts`): `human-gate` blocks DONE until approved; `judge` inserts a **`judge`-role** step before the onDone recipe. Activated by `harnessAcceptanceKind()` in `orchestrator-runner.ts`. | `tests` — the pipeline's validator/smoke gates |
| `output.kind`                  | `planFinalization` tags the documenter with `OUTPUT_KIND=<sink>`; `harnessOutputKind()` reads it.                                                                                                                                    | `repo-commit` — no extra                       |
| `affinity.kind`                | `fleet:place_batch`'s `affinity_kind` arg → `AFFINITY_WEIGHTS_BY_KIND` presets in `fleet/placement-affinity.ts` (reweights the lexicographic ranker).                                                                                | `file-overlap` — today's weights               |
| `lexicon`                      | persona/UI noun overrides (feature/PR vs deliverable/report)                                                                                                                                                                         | the built-in noun                              |
| `learning.{pack,loops}`        | `createHiveHarness` seeds `learning.pack` as the default seed pack                                                                                                                                                                   | the global default pack                        |
| `fleet` / `wake` / `placement` | declared; runtime reads are partial (see Gotchas)                                                                                                                                                                                    | global defaults                                |
| `dependencies.blueprints`      | the spawned-blueprint dep + install-closure (blueprint-role-bundling P-007)                                                                                                                                                          | none                                           |

The shared spawn preamble (`prompt-build.ts` + `testing-standard-policy.ts`) also swaps its
hardcoded `TESTING_STANDARD` for a domain-agnostic `VERIFICATION_STANDARD` when
`acceptance.kind !== 'tests'` — so a generic bee isn't told to write tests for a deliverable.

## Roles

`generic-hive` ships its own **`queen`** (topic-seam decomposition), **`judge`** (scores a
deliverable against the acceptance rubric → PASS/NEEDS-REVISION — distinct from the gym judge),
and **`documenter`** (honors `OUTPUT_KIND=artifacts` → `artifacts:save`). The **`bee`** is
inherited (it's already \~95% domain-agnostic). The acceptance gate reuses the existing
registered **`judge`** role (a FROZEN\_OVERLAY role), not a new `acceptance-judge`.

## Gotchas

* **The Queen must pass `affinity_kind` explicitly** to `fleet:place_batch` — the tool does
  not yet auto-resolve the calling hive's blueprint (P-015 deferred). The generic queen persona
  instructs this.
* **The judge step doesn't thread `acceptance.rubric`** into its extras yet; the generic judge
  persona embeds the default dimensions (accuracy/completeness/clarity), which match
  `generic-hive`'s rubric. A fork with a different rubric would need the rubric threaded.
* **The full execution smoke** (`generic-hive` → research-task → DONE via judge+artifacts) is the
  one runtime path not yet exercised; everything up to **live `blueprint:validate`** is verified.

## Source map

| Concern                 | Source                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------- |
| Blueprint + personas    | `libs/papercusp/packages/harness/blueprints/generic-hive/`                             |
| Domain-profile schema   | `libs/papercusp/packages/orchestrator/src/blueprint/schema.ts`                         |
| Acceptance/output gate  | `packages/operator-core/lib/dbos/orchestrator-finalize.ts` + `orchestrator-runner.ts`  |
| Affinity presets        | `packages/operator-core/lib/fleet/placement-affinity.ts` + `place_batch.ts`            |
| Preamble de-code        | `libs/papercusp/packages/orchestrator/src/prompt-build.ts`                             |
| hive:create blueprintId | `packages/operator-core/lib/agent-tools/hive/{create,_create}.ts` + `lib/hive/wake.ts` |
| Plan                    | `hive-blueprint-generalization-2026-06-15` (D-009 split, D-010 runtime-correctness)    |
