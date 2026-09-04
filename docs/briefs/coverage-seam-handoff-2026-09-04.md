# Handoff — coverage seam ship, and the two detector-integrity items left open

**From:** su-318d21e2-9fd2-40ca-b79c-f5d34f6f9767
**Written:** 2026-09-04T13:52Z
**Harness:** papercusp · **Workspace:** papercusp-workspace
**Provenance:** written at the owner's request (`[owner 2026-09-04]` — "write a brief for another agent to continue with your work"). Everything below that reads as a directive is `[self-imposed]` unless tagged otherwise.

---

## 0. TL;DR — the headline task is DONE; don't redo it

`design-to-code-coverage-seam-2026-09-02` is **`status: shipped`**, verified independently at 13:52Z (`plans:get` → `status:"shipped"`, `forcedPast: null` — no waiver, nothing was force-passed). The rubric auto-retired on ship.

**Do not re-open, re-grade, or re-verify the ship.** The full ceremony held:

| step | who | evidence |
|---|---|---|
| 26/26 items terminal | — | `plans:items`, 0 non-terminal |
| code-truth audit | su-318d21e2 | 59 resolved citations |
| rubric authored (rev 2, 7 criteria) | su-318d21e2 | `acceptance-design-to-code-coverage-seam-2026-09-02` |
| independent vetting | su-a961ddec | attested vs `meta-acceptance-rubric` |
| independent grading | su-22952d44 | card **EI-22338567777457145**, 7/7 healthy |
| author acceptance | su-318d21e2 | card **EI-22338965297312153**, verdict `accept` |
| ship write | su-467a4d53 | `plans:set-plan-status → shipped` |

Three separate agents, none in another's spawn lineage. That was deliberate — the grader-eligibility rule bars the rubric author's lineage, so the grading had to be *routed*, not launched.

### ⚠ One thing that will look wrong and is not

`plans:get`'s lifecycle block still says:

> *"every item is terminal (26 done, 0 dropped), and no acceptance rubric is active — the validation path has not begun."*

on a plan that just completed the entire validation path. **This is a known, filed defect (§3), not evidence the ship was incomplete.** Do not act on it. The ship gate is a *different resolver* and it read `satisfied: true`. Post-ship the reading is additionally ambiguous because acceptance rubrics legitimately retire on ship — see the self-camouflage warning in §3.

---

## 1. What I still hold — claims to re-verify before you touch anything

I held two work-items. **A session death releases claims**, so `assignee` may already be null by the time you read this. Re-check with `work_items:get` and re-claim before editing:

- **EI-21857009379287004** (`change`, major) — the schema-drift guard is unreachable from migration changes
- **WI-2143001** (`change`, major) — `coverage_evidence` has never held a row

Both are detector-integrity work. Both have full checkpoints on the item itself; this brief is the map, the checkpoints are the territory.

---

## 2. EI-21857009379287004 — design settled, ONE open question, do not skip the precondition

### What it actually is

The title frames it as a notification gap ("nothing tells the author to regenerate"). **Measured, it is a REACHABILITY gap**, and that changes the fix entirely.

```
node scripts/affected-tests.mjs --changed-paths libs/papercusp/libs/db/sql/1103-*.sql --print-affected | grep -c 'schema-object-drift'
→ 0
```

Zero matches across 7 workspaces / 17 tasks. `apps/operator` has separate `test` (selected) and `test:integration` (never selected) scripts, and the drift guard lives in the latter. **The only change that can break `index-manifest.ts` never selects the only test that checks it.**

### Why it is major, not a nit

I regenerated the manifest and measured the diff: **43 index definitions added, 3 removed — only 2 were mine.** The other 41 belong to other agents' migrations since 2026-08-30. The guard had been silently dark for ~5 days across many authors. This is not "I forgot to regenerate"; it is a detector that cannot fire.

### The settled design

Add an entry to `REPO_WIDE_INVARIANT_GUARDS` at `scripts/affected-tests.mjs:1787`. Entries are `{ workspace, script, appliesTo(f) }` and the script must exist in that workspace's `package.json`.

```js
appliesTo: (f) => f.startsWith('libs/papercusp/libs/db/sql/') && f.endsWith('.sql')
```

**`NON_WORKSPACE_PATH_ROUTES` is the WRONG lever** — I checked; the sql path already selects `@papercusp/db-org` and `@papercusp/web`. Don't go there.

### ⚠ THE OPEN QUESTION — decide this before writing code

**Which script does the guard attach?**

- **Static `check-*.mjs` (preferred).** Every existing guard is a sub-second static scan with no deps. Parse `CREATE INDEX` / `DROP INDEX` names out of the migration corpus; assert each created-and-not-dropped name appears in `index-manifest.ts`. Would have caught all 43 of today's instances and matches the existing cost profile.
- **The docker-dependent integration test.** Needs testcontainers and ~28s — a materially different cost profile for a path that runs on every repo-wide change.

**Known limit of the static approach, and you must state it in the guard's header rather than overclaim:** the drift test materialises the manifest from a *real Postgres* precisely because a text search over migrations cannot find every index class. A static guard is therefore deliberately **incomplete** — it catches the common literal case and is not a replacement for the integration check. Say so in the header.

### ⚠ PRECONDITION — non-negotiable, and the window is closing

Every existing guard entry cites this precedent: **measure the new guard GREEN over the whole real tree BEFORE registering it**, or it red-pins the entire fleet on drift accrued while it slept.

The tree is green *right now* only because I regenerated the manifest at 13:34Z (3/3 passed, 23.96s). **That window closes the moment any agent lands the next index migration.** If you pick this up cold, re-measure first; do not assume my green still holds.

### Also worth fixing while you are in there

The drift test's default 180s `hookTimeout` **timed out under load** on my first run, reporting 3 tests `COLLECTED, NOT RUN`. That is an *undetermined* result that renders almost identically to a pass or a fail — a third way this guard reports nothing. Re-run needed `--hookTimeout=900000`. Raise it.

---

## 3. EI-22103180235641196 — I raised this to `major` today; it is now the highest-leverage cheap fix

### The defect

`plans:get`'s lifecycle reports `acceptance.rubricActive: false` / `rubricRef: null` — with prose *"no acceptance rubric is active — the validation path has not begun"* — for plans whose acceptance rubric **is** active, and which the ship gate resolves correctly in the *same response*.

### Why I escalated it

`improvements:capture` declined my filing as a duplicate and surfaced **four prior independent filings** (similarity 0.93 / 0.92 / 0.91 / 0.90). Mine was the **fifth**. Every one of them was filed at `minor` or `nit`, so nobody ever picked it up — the exact "rediscovered because never owned" signature. **The rediscovery count is the severity argument**; five separate diagnoses is not a nit. I raised it to `major` and attached the full diagnosis as comment 82577.

### Diagnosis (settled: it does NOT gate)

Derived by `derivePlanLifecycleForRead`:
- `plan-lifecycle-derivation.ts:234` — `rubricActive: input.acceptanceRubricRef !== null`
- `:244` — `ref` from `readActiveAcceptanceRubrics({ workspaceId, planSlugs })`

`get.ts` wraps it in a try/catch documented *"Advisory overlay… it must never fail the plan read."*

**Proof it is not a gate input:** at the same instant lifecycle claimed no rubric was active, `shipReadiness` returned `acceptance_not_recorded` with `rubricId` **and** `gradedBy` populated, `unavailableReason: null`. So the risk is *misdirection*, not blockage — an agent trusting it re-proposes a duplicate rubric (churn that invalidates the vetting attestation) or reports a plan further from done than it is. It cost the grader real time mid-grading.

**Useful narrowing:** the catch path returns `{ freshness }` with *no* `acceptance` key ("Unmeasured, NOT false"). The observed reading had `rubricActive:false` **and** `rubricRef:null` present — so the read *succeeded* and returned no ref. The bug is inside `readActiveAcceptanceRubrics` or its arguments, not the error path.

**Prime suspect — `[inferred]`, re-probe before acting.** `get.ts:1033` records EI-22103498805895390, a previous instance of this same symptom caused by the lookup filtering `harness_plans` by `workspace_id`. That fix scoped it to `row.workspaceId ?? DEFAULT_WORKSPACE_ID`. Same class appears to have recurred, or that fix left a gap. **I did not read `readActiveAcceptanceRubrics` itself** — that is step one.

### ⚠ This defect self-camouflages — reproduce carefully

An acceptance rubric legitimately **retires on ship**, at which point `rubricActive:false` is *correct* (`libs/generic/plan-parser/src/lifecycle.ts:384`). The coverage-seam plan has now shipped, so reproducing against it will show a correct-looking value and read as self-resolved. **Reproduce against a plan whose rubric is active and un-retired**, or the instrument lies to you a second time.

### Next action

Read `readActiveAcceptanceRubrics`; check whether its filter is scope-correct or excludes `status='active'` / pins a revision. Then add the regression test the previous fix evidently lacked: an active, un-retired acceptance rubric must yield `rubricActive:true`. **Five filings and no test is the actual root cause.**

---

## 4. WI-2143001 — the honest gap the shipped plan is narrowed around

`harness_shared.coverage_evidence` has **never held a row** (`count 0`, `max(observed_at)` NULL — stronger than "empty now"). Every rung of `testing_surface_depth` reads solely from that table, so all ~2,021 live surfaces sit at depth 0, and rubric criteria of `kind:'coverage'` have passed **zero times across 338 rubrics / 2,016 criteria** because they structurally cannot.

This is the dependency four plan items deferred to. The shipped plan does **not** claim otherwise — its `## Now` states plainly that it BUILT and GATED the code→test instruments but did NOT FEED them, and names this ref. That narrowing is what criterion C7 graded and passed.

**Untouched beyond ownership.** It is the real remaining work of the coverage seam. If you want the highest-value thing on this list, it is this one.

---

## 5. Operational lessons worth inheriting

**`ok:true` means *persisted*, never *legible*.** Every carry channel here has its own independent bound and they do not warn each other:

| channel | bound | how it failed on me |
|---|---|---|
| `coord:send` | **600 chars** for `expects:'action'` (refuses outright); truncates silently for `expects:'none'` | a 3,076-char message delivered at 600; later a 2,008-char one at 600 |
| `work_items:get` | projection depth | collapsed my grader brief's body **twice** |
| tool results | ~1,500 tokens | the grading card truncated at 3 of 7 criteria |
| `acceptance.reasoning` | 2,000 chars | three rejected attempts |

**The general fix:** when content *must* arrive intact, put it somewhere with no delivery bound (a file, a work-item comment, this brief) and send a **pointer sized to the channel**. A pointer that fits beats a payload that does not. Read the receipt's own numbers — `bodyDeliveredChars` vs `bodyAuthoredChars` — never its `ok` flag.

**Read the whole card before you rate it.** The grading card truncated at 3 of 7 criteria on first read. Rating from that would have been rating a partial card while believing it complete. I pulled the rest from the ratings jsonb:

```sql
SELECT r.key, r.value->>'rating', r.value->>'evidence'
  FROM harness_shared.engineer_issues ei,
       LATERAL jsonb_each(ei.payload->'observation'->'ratings') r
 WHERE ei.issue_id = '<card id>' AND ei.workspace_id = 'papercusp-workspace';
```

(The tenant predicate is mandatory — `dev:pg_query` refuses without it.)

**"Collected, not run" is not a pass and not a fail.** My first manifest regeneration returned `Hook timed out` with all 3 tests `COLLECTED, NOT RUN`. Read as failure it sends you fixing something that is fine; read as pass it is worse. The harness labelled it explicitly and that label was the only thing between the two readings.

---

## 6. Things NOT to do

- ⛔ **Do not revise the acceptance rubric.** It retired on ship. A revision bump would un-count the grading card retroactively.
- ⛔ **Do not use `force:{reason}`** on a ship write. It waives only code-truth, never rubric/vetting/grading/verdict — and permanently marks the plan.
- ⛔ **Do not re-ask these graders.** su-467a4d53 (implemented 15/26) and su-55a5bada (implemented P-010) are barred as implementers; su-a961ddec vetted rev 1; su-22952d44 already graded.
- ⛔ **Do not trust the lifecycle `rubricActive` field** (§3).
- ⛔ Colon-form tools (`rubrics:propose`, `scorecards:emit`, `plans:get`) are **not ToolSearch-selectable** — dispatch via `tools:invoke { name, args }`.

---

## 7. Recommended order of work

1. **WI-2143001** — highest value; it is the actual unfinished ambition of the coverage seam.
2. **EI-22103180235641196** — cheapest real win; a scope-bug plus the missing regression test, and it stops the sixth rediscovery.
3. **EI-21857009379287004** — settled design, but resolve the static-vs-integration question *and* re-measure the tree green before registering.

One unfiled item worth its own capture: nothing currently catches an index whose *expression* no query can produce (how migration 1096 orphaned 842's). Distinct from #3, which is the downstream manifest detector.
