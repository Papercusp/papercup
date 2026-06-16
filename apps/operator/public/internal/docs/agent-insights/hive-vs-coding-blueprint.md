# Hive vs coding blueprint — don't conflate them
URL: /internal/docs/agent-insights/hive-vs-coding-blueprint

The hive blueprint (Queen + generalist bees, no spine) is the orchestration layer; the coding blueprint (scoper→…→curator spine) is one execution pipeline it runs. Agents repeatedly describe hive bees with coding-spine roles — they are different blueprints at different layers with opposite execution models.

Agents (and humans — and this insight's author, twice in one session) repeatedly
describe **hive** `bee`s as moving through the **coding** spine
(scoper → architect → worker → …). They are **different blueprints at different
layers with opposite execution models.** Both `extends: base` and both are
"blueprints," which is exactly why they look like siblings — but one
*orchestrates* and one *executes*.

## The one-liner

* **`coding`** = an *execution pipeline*. Takes ONE `feature` (`F-NNN`) and pushes
  it through a fixed chain of specialist roles via a deterministic state-machine
  **spine**.
* **`hive`** = the *orchestration layer above it*. A single **Queen** surveys the
  work frontier and **places ranked work onto generalist `bee`s** (no spine), then
  declares her own next wake. A hive can itself *create* coding harnesses.

They are **not two flavors of the same thing** — the hive sits *above* and runs
coding (and research/…) pipelines as needed.

## Contrast

|                | `coding`                                                                                                                                 | `hive`                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `kind`         | `harness`                                                                                                                                | `hive` (root-only, **never nested**)                                                      |
| work unit      | `feature` (`F-NNN`)                                                                                                                      | `hive-wake` (`POT-NNN`) for the Queen's own wake; real work = `work_items` placed on bees |
| execution      | state-machine **spine**: `director` emits a verb → `deriveNext` → next role                                                              | **no spine**: Queen surveys + places work + self-declares wake                            |
| roles          | scoper → architect → worker → validator → documenter → curator (+ opt-in tester / security / crosscheck / ui-qa; reviewer = the PR gate) | `queen`/`operator` (decider) + `bee` (one generic worker)                                 |
| spine edges    | \~20 verbs (`NEXT_WORKER`, `NEXT_VALIDATOR`, …) → role transitions                                                                       | 3 terminal only: `DONE` / `ESCALATE` / `IDLE`                                             |
| `maxTurns`     | 200                                                                                                                                      | 50                                                                                        |
| who drives     | orchestrator runs ≤4 feature pipelines, strict plan-priority order                                                                       | Queen "steers, doesn't dispatch"; bees own their own sequencing                           |
| trigger        | autoloop dispatch (plan-order slot-filling)                                                                                              | self-declared wake (`hive:declare-wake`); **no timer**                                    |
| `planner`      | `features-import` (plans → features, waves + `blocked_by`)                                                                               | `inline`                                                                                  |
| `requiresRepo` | `true`                                                                                                                                   | `false`                                                                                   |
| finalize       | `gates.finalize`: DONE → curator → documenter → archive                                                                                  | none — bees complete work-items; the Queen reads state                                    |

## The traps that cause the confusion

1. **"worker" is overloaded.** `worker` is a *coding* pipeline role. The hive's
   generic agent is a **`bee`** — the glossary says it "carries no pipeline spine
   and no chunk requirement, **unlike `worker`**." A bee is NOT a
   scoper/architect/worker/validator.
2. **"Queen" ≠ "director".** Both decide, but the `director` emits per-feature
   verbs *inside a spine*; the **Queen** places work across a fleet *with no
   spine*.
3. **A bee can create a coding harness** (`blueprint:catalog → harness:create`)
   for genuinely structured work — so the two appear nested in practice even
   though they're distinct layers. (A bee may **not** launch another hive — hives
   are peers, never nested.)

## Rule of thumb

If you're naming scoper / architect / validator / reviewer / curator → you're in a
**coding** harness. If you're describing a **Queen placing ranked work on bees** →
you're in a **hive**, and **there is no spine.** When unsure, read the harness's
`kind` (`harness` vs `hive`) and its `blueprint.yaml` `spine:` block — a hive's
spine has only `DONE` / `ESCALATE` / `IDLE`.

*Sources: `blueprints/{hive,coding,base}/blueprint.yaml`, `hive/prompts/bee.md`,
`harness/glossary.mdx`, `orchestrator/src/blueprint/{schema,derive-next}.ts`.*
