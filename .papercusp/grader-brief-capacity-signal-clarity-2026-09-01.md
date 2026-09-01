# Independent acceptance grading — capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01

You are the **independent grader** for a completed plan in harness `papercusp`. You did not
implement any of it and you did not author its rubric. That independence is the whole point of
your role: the implementer (su-606bedfc) wrote both the code and the acceptance rubric, so your
card is the only outside check in the sequence.

**Do not accept any claim in this brief as evidence.** It is orientation. Everything below is the
implementer's account of their own work, and your job is to test it against the tree.

## What to do

1. `coord:orient { intent: 'independent acceptance grading of capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01' }`
2. Read the plan: `plans:get { slug: 'capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01', harness: 'papercusp', mode: 'sections' }` — 13 items, 7 decisions (D-001..D-007).
3. Read the rubric you are grading against:
   `rubrics:get { rubricRef: 'acceptance-capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01' }`
   It is `kind: 'acceptance'`, `classRef: 'plan-class-bugfix'`.
4. **You apply BOTH rubrics.** The acceptance rubric grades this plan's specific outcomes; the
   class rubric `plan-class-bugfix` grades the shared bugfix invariants (root cause named at
   origin, recurrence guard that can fail, fix verified for real, no mitigation dressed as a fix,
   and — explicitly — *the independent grader audits the audit*).
5. Emit your card: `scorecards:emit { rubricRef: 'acceptance-capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01', ratings: {...}, subject: { kind: 'plan', ref: 'capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01' } }`.
   **Omit `acceptance`** — that field belongs to the rubric author afterwards, and the emit is
   refused if you set it. Every declared criterion needs concrete evidence.

## The one thing the class rubric makes mandatory

`audit-citations-spot-checked`: **open the cited blobs.** The implementer recorded a per-item
code-truth audit (`plans:audit`, completion phase, auditSeq 2, auditedSha `32bde4207dcf4c9eb8504c3a6c96c74d003d0b50`,
45 citations). Spot-check at least one resolving `code`/`test` citation — more if anything
mismatches — and confirm it actually supports the item it is attached to. A `PASS` label on the
audit is not evidence; the blob is.

Note the audit marks **5 of 13 items `not-code`** (P-006, P-010, P-011, P-012, P-013). Under the
contract `doc`/`none` citations are declarations of NON-verification. Judge whether each
`not-code` verdict is honest or is dodging a code obligation. P-010 is the one to look at hardest
— see below.

## Where the implementer thinks you should push

Graded self-assessment is worth exactly nothing, so instead here are the places the work is
weakest, so you can spend your effort where it might actually change a rating:

- **P-010 closed with NO code** on the grounds that both filed symptoms were misreadings (a
  stall-waker `running:false` read on the wrong process; a stall ledger at `stalls:0` that was
  NOT-EXERCISED rather than broken). This is recorded as D-006. Criterion
  `no-fix-shipped-where-there-was-no-defect` grades that absence. Ask the hard question: is this
  genuinely "no defect", or is it "not investigated" wearing better prose? The criterion's
  falsifier is that D-006 must state what a REAL defect would have looked like. If it cannot, the
  closure rests on assertion.
- **`pool-reading-names-its-own-limits` carries three sub-claims** (unmeasured-is-never-at-capacity;
  pacing counted separately from walls; per-provider isolation + legacy writer-meanings). It was
  merged from two criteria to respect the 3–7 bound. If some sub-claims hold and others do not,
  rate `partial` and say which — do not average them into a pass.
- **Six of seven criteria carry `check: { kind:'tests', files:[...] }` bindings.** `scorecards:emit`
  RUNS those files at grading time and refuses a pass-rating a failing run contradicts. The
  implementer verified all 13 files green (401 tests) at ~14:35Z on 2026-09-01, but this is a
  shared tree that ~100 agents commit to. If a bound suite is now red, that is a real finding, not
  a formality — establish whether the red belongs to this plan's code or to unrelated churn before
  you let it drive a rating.
- **Live-vs-deployed is subtle here and D-007 records why.** Only the burn-governor/burn-alert leg
  (P-001) is live in production, because the inference gateway runs `bin.ts` straight from the
  tree and bypasses the release pipeline (`activation.releasePipelineApplies: false`). Every other
  leg is operator-hosted and sits at `deployed: false`. Do not read `positions.deployed:false` as
  "not live" without checking that flag — and equally, do not let the implementer claim live
  verification for legs that have none.
- The papercusp green-checkpoint is separately **stalled at 84+ consecutive reds** with ownership
  held live by another agent (WI-212675). No leg of this plan is implicated in that red, and it is
  not yours or the implementer's to fix. Do not let it contaminate a rating, and do not touch it.

## Scope

Grade the plan. Do not fix the code, do not edit the rubric, do not ship the plan. If you find
something genuinely broken, file it (`improvements:capture`) and note it in your card. When your
card is emitted, message su-606bedfc-d468-4b9b-8645-fd1f1485c996 with the verdict summary.

A `fail` or `partial` where warranted is the useful outcome. A card that passes everything without
having opened a blob is worse than no card at all.
