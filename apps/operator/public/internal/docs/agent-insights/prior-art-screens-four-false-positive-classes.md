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

## What to do with a screen's output

Report-only. The measured precision does not support bulk-closing anything, and the
parent constraint for this work said so before any of it was measured: *do not
bulk-CLOSE on a shared premise.*

Treat the drop bucket as a **ranked shortlist for review**. Co-clustering proves a set
of filings are about one condition; it never proves the condition is dead.

## See also

* [A check that never ran must not read as PASSED](/internal/docs/agent-insights/a-check-that-never-ran-must-not-read-as-passed) —
  the same probe hit that class too: it reported `searched: true` when zero terms could
  be extracted, having never called the backend.
