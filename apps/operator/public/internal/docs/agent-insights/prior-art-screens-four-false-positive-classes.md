# Deciding \"is this already built?\" — four false-positive classes, and why precision must be reported PER LEG
URL: /internal/docs/agent-insights/prior-art-screens-four-false-positive-classes

Any screen that searches the tree to decide whether an idea is already implemented — a tool, or an agent doing it by hand — hits four distinct false-positive classes, each of which produces a confident, well-formed WRONG answer. Measured on the real Scout backlog (WI-9476, 2026-08-03): (1) SELF-CONTAMINATION, the screen finding its own documentation of the ideas it screens; (2) DROPPED/DEPRECATED read as built, when both states close an item precisely because nobody built it; (3) an OPEN SIBLING cited as \"existing\" being duplication rather than prior art; (4) a SYMBOL existing mistaken for the MECHANISM existing. Fixing all four moved the drop rate 80% -> 45%. The larger lesson is methodological: a multi-leg screen's precision cannot be assessed from one leg's evidence, and doing so produced a retracted precision figure that nearly caused the strongest leg to be demoted.

## Why this matters even if you never touch the screening code

The su playbook already tells you to run a reuse check before building anything, and
that the base rate of *already-built* is far higher than it looks. This page is about
the step after that instruction: **the reuse check itself is a classifier, and it has
characteristic ways of being confidently wrong.** Every class below was measured on
real data; every one of them is available to an agent doing the check by hand with
`git grep`, not just to the automated screen.

## The four classes

### 1. Self-contamination — the screen finds its own writing

Searching a codebase for evidence *about* work-items finds the codebase's own writing
*about* those work-items — **including the writing you just added.**

Measured: the screening module documented `EI-7650` and `EI-7652` in its own docstrings
as worked examples of a bug. Its self-id leg then grepped the tree, found those
docstrings, and recommended DROP for both ideas. The only two files citing either id
were the screening module and its test.

A closed loop, and the failure is invisible by inspection: the false positives are
shaped exactly like the true ones — a real file, a real citation, a real match.

Three quieter versions of the same class, all measured:

| what was found                                  | what it actually was                                  |
| ----------------------------------------------- | ----------------------------------------------------- |
| `.papercusp/memory/raw.md`                      | an agent memory dump — WI-2497's *only* evidence      |
| `scratchpad/lexicon-audit-2026-07-09/REPORT.md` | a month-old audit writeup — WI-2890's *only* evidence |
| `public/internal/docs/**`, `llms-full.txt`      | generated doc copies, which also inflate file counts  |

**The rule: an idea DISCUSSED in prose is not an idea BUILT.** Filter to paths that are
admissible as evidence of implementation, and exclude the screening surface itself.
Keep the exclusion surgical — blanket-excluding `lib/scout/` would have hidden genuine
Scout implementations.

#### The residue a path filter cannot reach — and it is adversarial

Filtering by path cannot see prose *about* a defect that lives **inside a genuine
source file**. This is the dangerous remainder, because:

> **The code that DISCUSSES a defect is very often exactly the code that FAILS to
> handle it.**

Worked case: a 19-item family about rubrics collapsing distinct states into `unknown`.
Grepping that vocabulary returns plenty of matches in `scorecards.ts` and
`overwatch/scorecard-backstop.ts` — every one of them *describing* the defect, none
implementing a fix. A path filter admits all of it, and the hits look excellent.

The discriminator that survives is **"does an implementation exist"**, not "is this
discussed". A family like that belongs in `INCONCLUSIVE`, not `DROP`.

### 2. `dropped` / `deprecated` are terminal, but they mean NOT BUILT

This one is seductive because the titles match perfectly.

`WI-2479` ("Persistent fleet headcount target governor") cites `EI-6805` ("Fleet
self-healing headcount governor"). Near-identical titles, terminal state — a textbook
prior-art hit. But `EI-6805` is **dropped**: it closed *because nobody implemented it*.
Reading it as prior art retires an idea on the grounds that the same idea was
previously abandoned. `EI-7622` / `EI-7593` is the same shape.

Split the terminal states:

* **implemented** — `done`, `resolved`, `closed`, `passed` ⇒ real prior art
* **abandoned** — `dropped`, `deprecated` ⇒ *not* prior art

The abandoned signal is still worth surfacing — a re-filing of abandoned work deserves
attention, in either direction — but it must never drive a retire recommendation.

### 3. An OPEN sibling cited as "existing" is duplication, not prior art

An `existing EI-XXXX` citation means nothing until you resolve **that item's state**.

`EI-7654` and `EI-7663` each cite `EI-7650` and `EI-7652` as existing. All four are
open, untriaged members of the *same* cohort. Of the refs surfaced across one 40-item
run, 8 of 10 resolved to genuinely terminal items and 2 were open siblings — so the
leg discriminates well, and is worthless unchecked.

Useful side effect: state-resolving refs yields duplicate-cluster detection **with no
embeddings at all**, because an idea citing a live sibling is a merge candidate on the
strength of its own text.

### 4. A symbol existing is not the mechanism existing

Terms graded "strong" lexical hits on the real backlog included `facts:assert`,
`plans:get`, `plans:items`, `release:checkpoint-run` and `test:affected` — **tool names
the idea merely mentions.** They exist in the tree by definition. Their presence says
nothing about whether the proposed mechanism exists.

Lexical hits are context for a reader. They must not drive a verdict.

## The methodological lesson, which outlived the numbers

Fixing all four classes moved the drop rate down in steps — 80% → 58% → 50% → 45% —
and **none of the four was visible from fixtures.** Every one appeared only when the
screen was run against real data. That alone is worth the cost of wiring a real
backend early.

But the more expensive mistake was in how the result was then measured.

A sample of drop verdicts was hand-checked, and each was judged **by its asserted-ref
leg alone** — then that judgement was attributed to the item's whole verdict. Several
verdicts rested on a different leg entirely. The result was a published precision
figure of "\~1 in 5", which was **wrong and had to be retracted**.

The case that inverted it: `WI-2479`, named as a false positive because its asserted
ref was dropped. Its self-id citations — never opened — were conclusive:
`fleet-headcount-action.ts` (*"WI-2479: durable, dark-by-default fleet headcount repair
action"*), `seed-fleet-headcount-routine.ts`, `FLAGS.FLEET_HEADCOUNT_GOVERNOR` carrying
`case: 'owner-authority'`, and two test suites. It is fully implemented.

> **Evaluate every leg before judging a verdict, and report precision PER LEG.**

Per-leg precision differed sharply — path-filtered **self-id** was the strongest leg
(every clear true positive came from it), **asserted-ref** was weaker (every surviving
false positive came from it), **lexical** is context only. The aggregate number hid all
of that, and acting on it would have demoted the best leg. Two early false positives in
the self-id leg (a memory dump, a scratchpad report) were **path** problems, fixed by a
filter — not leg problems.

**A wrong precision figure is more damaging than a wrong verdict.** A wrong verdict
misjudges one item; a wrong precision figure retunes the whole design.

## "Already built" and "should close" are different questions

`WI-2479` is built **and** legitimately open: finished, tested code parked behind an
owner-authority dark flag, awaiting owner ratification. A screen that maps prior-art
evidence straight to a retire recommendation will tell you to discard real work that is
waiting on a *human decision*, not on an implementer.

If you need to act on this distinction, check the flag state — do not infer it from the
item being open.

## A cluster proves a shared CONDITION, never a shared PROPOSAL

If you cluster a backlog by embedding distance, this is a hard boundary and it is the
one most likely to destroy real work:

> A cluster can justify **"these filings DESCRIBE the same thing"**.
> It can never justify **"these filings WANT the same thing"**.

Distance is computed over text dominated by the *problem statement*, so items proposing
**opposite** mechanisms sit close together.

Measured across three clusters (3/3), the decisive case being 19 items that all reported
one condition — *a rubric emits `unknown` because its subject was never exercised* — and
which resolved into **three partly-contradictory mechanisms**:

* suppress-when-blind
* amplify-when-chronic
* diagnose-idle-as-signal

Merging them into a single item would have destroyed a genuine design decision. The
correct outcome was **3 canonical items and 16 collapsed into them**, each collapse
naming its canonical and why — not one merged item, and emphatically not 19 drops.

Note also what the surface features said: chronic condition, \~a year of noise, heavy
sibling citation, a premise reading as already-known — everything pointed `DROP`. Only
reading the proposals inverted it.

So a collapse verdict must mean **"triage these together"**, never **"merge these"**.

## Before tuning a retrieval leg, measure whether it FILTERS or merely RANKS

A fifth leg was added to the screen after the four classes above: match an idea against
plan SLUGS, on the theory that a plan name encodes the *condition* while a module name
encodes the *mechanism*, so the plan bridges an idea to code that shares no vocabulary
with it. The theory is sound and the worked case is real — an idea phrased "signals fire
with no acting consumer" is implemented by `orphaned-dispatch.ts`, reachable only via the
plan `self-improvement-consume-edges-2026-06-12`.

Measured against the real corpus (978 plans × 40 ideas), the leg fires on **40 of 40
ideas (100%)**, matching 210–236 plans each. Tightening the score threshold to 0.67 left
it at 95%. Adding an IDF/rarity gate left it at 100%.

**A leg that fires on everything filters nothing**, however correct each individual hit
is. But the same leg ranks the known true positive **#6 of 210** — the top 3%. Those two
sentences describe one leg, and confusing them is the failure:

* ✅ "here are \~10 plans worth reading before you build this"
* ❌ "no plan matched, therefore this is novel" — it *always* matches

The generalisable part is the diagnostic. **Firing rate and score distribution cannot
tell you which of those two things you built.** Both looked healthy here: median score
0.75, max 1.0 — numbers that read as strong matches while actually measuring *"is this
plan's name built from words a long idea body happens to use"*, a narrower question than
the one being asked. Only ranking a **known-good pair** separated ranker from filter.

That measurement also caught a defect nothing else would have. The result cap defaulted to
**5** — the obvious number — and the true positive ranks **#6**. The default excluded the
single case the leg was built for, while every aggregate statistic still looked fine.
A cap is a silent truncation: it cannot fail loudly, so it must be **calibrated against a
known-good pair**, never chosen for looking reasonable.

**The check to run on any new retrieval leg, in this order:**

1. What fraction of inputs does it fire on? (≈100% ⇒ it is a ranker; stop calling it a filter.)
2. Where does a *known-good* pair rank? (This is the only measurement that distinguishes signal from noise.)
3. Is your result cap larger than that rank? (Verify; do not assume.)

Steps 1 and 3 are cheap and neither is a substitute for 2.

## On a dense corpus, similarity cannot discriminate — only asserted links can

The section above measured one leg. Running the same check on every leg turned a
one-off result into the design conclusion of the whole screen. Measured over the
186-item cohort (`EI-%`, open, `lane IS NULL`, filed 07-04 to 07-17):

| leg                              | what it rests on                  | reach                         | can it carry a verdict? |
| -------------------------------- | --------------------------------- | ----------------------------- | ----------------------- |
| self-id (evidence-path filtered) | a source file CITES the item's id | **17 = 9.1%**                 | yes — strongest         |
| asserted-ref, prior-art sense    | the author CITES another item     | **125 = 67%**                 | yes — weaker            |
| asserted-ref, intra-cohort sense | the author cites a SIBLING        | **61 = 33%**                  | collapse only           |
| plan-slug                        | slug/idea token overlap           | **≈100%**                     | no — ranks only         |
| plan items to file paths         | a plan item names a path          | 73% of plans, ≈7.8 paths each | no — ranks only         |

Two things fall out, and the second is the load-bearing one.

**Reach and trustworthiness are inversely related.** The most trustworthy leg reaches
about 9% of items; the leg that reaches everything carries no authority at all. No
combination adjudicates the majority of a backlog — that is structural, not a tuning
failure. For most items the only correct output is INCONCLUSIVE.

**The two legs that can carry a verdict are exactly the two resting on an explicit,
human-authored link** — someone deliberately wrote `EI-1234` into a filing, or into a
source file. Every leg resting on *similarity* (lexical overlap, plan-slug overlap,
embedding distance, path extraction) fires on nearly everything, because a corpus this
dense returns plausible hits for any query. The hits are not wrong; they are
undiscriminating, which is worse, because each one reads like evidence.

So the practical rule for a screen on a corpus like this: **adding another retrieval leg
does not buy discrimination.** The remaining upside is in sharpening the assertion legs
and in making the ranking legs cheap to *read*, rather than trying to make them decide.

### Therefore: absence is not evidence, and a report must say so in its own output

If your best leg sees 9% of the space, then "the legs found nothing" is close to
uninformative about whether the thing exists. This is the sibling of
[a check that never ran must not read as PASSED](/internal/docs/agent-insights/a-check-that-never-ran-must-not-read-as-passed),
one step on: **a check that DID run, at 9% recall, must not read as CLEAR either.**

A verdict count alone invites exactly the wrong reading. "DROP=18 of 40" gets restated
as "45% of the backlog is already built" — a claim about the world, when the run only
supports a claim about what a few bounded-recall legs happened to find. The fix is to
make the denominator part of the output rather than a caveat a reader has to remember:
`screenCoverage()` / `renderScreenCoverage()` emit a per-run header splitting items into
**positive-evidence** verdicts (a leg FOUND something — defensible), **absence-only**
(cleared by finding nothing — bounded by recall, never counted as adjudicated), and
**silent** (retrieval did not run). An all-absence run must report that it adjudicated
exactly zero; a control test pins that, so absence can never be quietly promoted to
evidence inside the counting.

### Two traps when measuring reach

**Bound the population before you bound the leg.** The first run of this measurement
returned 3,757 items against an expected \~184, because `lane='observation'` holds 3,571
open rows in the same window — a separate population that never enters the work queue.
Nothing in the result looked wrong; only its magnitude disagreeing with a number already
in hand caught it.

**Name which question a reach figure answers.** The asserted-ref leg reaches 67% for
"does the author cite prior art" and 33% for "does the author cite a sibling" — one leg,
two questions, differing by 2x in opposite directions. Reporting either without saying
which produces a figure that is precisely wrong for the other. And because densely
ref-linked clusters are the cheapest to find, they get drained FIRST, so these ceilings
**decay** as a backlog is worked: any reach figure is a snapshot of a moving population.

## What to do with a screen's output

Report-only. The measured precision does not support bulk-closing anything, and the
parent constraint for this work said so before any of it was measured: *do not
bulk-CLOSE on a shared premise.*

Treat the drop bucket as a **ranked shortlist for review**. Co-clustering proves a set
of filings are about one condition; it never proves the condition is dead. Publish the
coverage header alongside the counts, so the fraction the screen could not speak to is
visible in the same breath as the fraction it could.

## See also

* [A check that never ran must not read as PASSED](/internal/docs/agent-insights/a-check-that-never-ran-must-not-read-as-passed) —
  the same probe hit that class too: it reported `searched: true` when zero terms could
  be extracted, having never called the backend.
