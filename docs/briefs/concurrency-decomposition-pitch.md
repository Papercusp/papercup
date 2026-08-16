# Addressable context — the concurrency-decomposition pitch

> Plan-linked deliverable: `get-feedback-relevance-consults-2026-08-16` P-009 (WI-39509).
> Drafted 2026-08-16 by su-c0fe9 under owner-directed AUTO. Sources are pinned throughout;
> §5.4 names the one claim that still needs owner input.

## 1. The question

> "but one question i havent been able to answer myself is... do they need to be running at
> the same time? How does that relate to my dynamic context injection?"
> — Avi, design conversation, 2026-08-16 01:37 EDT (session `f8f0b056`, owner-typed)

The honest answer is: *mostly no — and the "mostly" is worth building around.* "Why is
concurrency better than serial, beyond speed?" decomposes into five distinct benefits, and
they have different requirements. Only one of them irreducibly requires simultaneity.

## 2. The decomposition

1. **Speed** (wall-clock). Conceded, boring. Any parallel system has it.
2. **Bidirectional information flow in the decision timeline.** Serially, discoveries flow
   only forward: agent 3's bug find can't reach agents 1–2, whose finished work is now
   wrong (rework). Concurrently, any discovery course-corrects every peer mid-flight — and
   truncates the tokens peers would burn down invalidated paths. This is a **cost**
   argument, not just a latency argument.
3. **Correlated observation of shared live state.** N agents watching the same pipeline at
   the same moment run a controlled differential: same world-state, varying only platform.
   Commonality isolates shared causes; difference isolates platform causes. This is the
   **only** benefit that irreducibly requires simultaneity (transients, races,
   load-correlated behavior).
4. **Pull-deliberation.** Asking a question of the context best equipped to answer it and
   getting *fresh reasoning* back. Requires **wakeability**, not simultaneity.
   → reified as `consult:get_feedback` (Phase 1, shipped).
5. **Push-interjection.** A peer volunteering something you didn't know you needed
   (unknown unknowns). Requires **interest subscriptions + wakes**, not simultaneity.
   → reified as interest watches, `watch:create { targetKind: 'interest' }` (Phase 2, shipped).

**Conceded for honesty:** perspective *diversity* does not require concurrency — it
requires independent contexts, which serial fresh sessions also give. We don't claim it.

**Injection vs consult:** context injection is retrieval of what was *already said* —
conclusions; it can only answer questions the past agent happened to address. A consult is
*fresh reasoning applied to a novel question* — a colleague, not a library. Every consult
is persisted and backfills the retrieval layer: the first ask costs a wake, repeats are
served by injection. A cache hierarchy, not rivals.

## 3. The pitch line

> Concurrency isn't the feature — **addressable context** is. We decomposed what "working
> at the same time" actually buys and built each piece as a first-class primitive, so
> simultaneity becomes a performance knob rather than an architectural requirement. Live
> coordination is the zero-latency special case — and where simultaneity is genuinely
> irreducible (correlated observation of a live shared system), we run truly parallel.

## 4. What we built (shipped, enforced, tested)

Each guardrail is a server-enforced mechanism, never guidance prose (plan D-005):

- **Router** (P-002): embed the question; search cross-agent turn history; blend similarity
  with recency, verification/completion evidence, and authorship — similarity ≠ authority:
  the agent with the most turns on X may be the one most *stuck* on X.
- **Score floor + honest failure** (D-003): below the floor the first-class answer is
  *"no qualified responder — proceed on your own judgment."* Falsifiability-tested (P-007).
- **Requester tool** (P-003): `consult:get_feedback({ question, tried, observed,
  decisionAtStake, latency })` — the prompt doubles as the embedding query; specificity IS
  routing quality.
- **Responder contract** (P-004, D-004): validate relevance first, decline cheaply; answer
  FROM transcript, citing evidence; requester owns the decision.
- **Thread lifecycle** (P-005): exchange cap; every message carries a question or a new
  fact (neither = the structural close signal); recursion depth ≤ 2; A→B→A cycle refusal;
  per-task wake budget; expiry sweep (live-verified canary); cap-hit deliberation
  *graduates* into shared live work — full concurrency re-enters as the escalation tier,
  not the default posture.
- **Retrieval backfill** (P-006): closed threads are indexed; repeat questions are served
  by injection without a wake.
- **Interest watches** (P-008): standing interests wake an agent when a peer's in-flight
  work matches (`min_similarity` floor, frontier watermark over async-backfilled
  embeddings; migration 839).

## 5. The retired-QA-system defense — checked against the actual autopsy

> "Okay, we can make it a conversation, but we already implemented a QA system taht we
> retired for a rason, so how will this sytem be different?"
> — Avi, same conversation, 01:52 EDT (owner-typed, verbatim)

### 5.1 What the retired system actually was (recovered from git history)

The referent is the **experts system** — authored persona experts, in two generations,
both recovered from primary sources:

- **Planning-pass experts** (`spec/experts.mdx`, recovered via
  `git show 0288443a^:apps/operator/content/internal-docs/spec/experts.mdx`): one `expert`
  role per feature area authoring a detailed `SPEC.md`, critiqued by ephemeral `feedback`
  agents drawn from an **authored persona roster** — security, UX, perf, a11y, ops,
  implementer, domain-expert, devil's-advocate. Convergence = two consecutive
  `newIssues: []` verdicts; `maxAgents` cap (default 12); a cost budget. Off by default
  (`scoper.useExperts`).
- **Direct-writing experts** (`agents/authoring-experts.mdx`, same recovery): autonomous
  specialist roles (first: `infra-reviewer`) defined by an authored prompt plus a
  `<role>.role.json` manifest whose hand-written `whenUseful` string told the scoper when
  to consult it. A discoverable *directory of authored experts*.

**Timeline (from file history, not commit subjects — subjects ride git-sync sweeps and are
not evidence here):** the docs were removed 2026-05-20 (`0288443a`); the operator-side
implementation — `experts-core.ts` (475L), `experts-data.ts` (228L), `expert-dispatcher`,
`expert-triggers`, seven `agent-tools/experts/*` verbs, endpoint routes, tests; 22 files,
−2,959 lines — was removed 2026-06-03 (`6da55dfa`). The system's whole operator life is
measured in weeks.

### 5.2 The difference, in one line

The old system's experts were **authored** — a roster of persona prompts, a role someone
wrote. The new system's experts are **discovered** — histories earned by doing real work.

Consequences, each a direct negation of an authored-roster property:

| Authored roster (retired) | Discovered histories (shipped) |
|---|---|
| Roster to maintain; `whenUseful` strings hand-written per role | Expert set is a side effect of work happening; nothing to maintain |
| Persona ≠ information: the expert *plays* security | Informational advantage by construction: the route targets a context that actually contains something the requester's doesn't |
| The expert always answers (hallucinated authority) | The router can fail honestly: "no qualified responder" is a first-class, floor-enforced result |
| Cold starts per consult | Warm contexts — the responder already holds its history |
| A directory in someone's head (or a manifest file) | Addressing computed at query time from turn history |
| Knowledge pushed into designated containers ahead of demand — speculative structure, rots | Knowledge left where it was created, routed on demand — nothing to rot |

### 5.3 The rot is observable in-tree, today

The "speculative structure rots" claim is not rhetoric — it has a live exhibit. The
current blueprint `libs/papercusp/packages/harness/blueprints/base/prompts/scoper.md`
(lines 44–65) **still instructs the two-phase `useExperts` flow**, telling the scoper to
`POST /api/harness/$HARNESS_SLUG/experts` and read `prompts/expert.md` — against API
routes and prompts deleted 2026-06-03. The authored structure outlived its own substrate
by two and a half months, silently. A system whose expert set is computed at query time
has no such artifact to strand.

**Honesty invariant (testable, tested):** "no qualified responder" must be a *common*
result in practice. If every call returns an answer, the floor is broken and these are
costumed experts again. The floor + the no-qualified-responder path ship with
falsifiability controls (P-007); the calibration metric is tracked as an open item.

### 5.4 What the archaeology could NOT establish — the owner-gated claim

**WHY the experts system was retired is on no recoverable record.** Searched: session
transcripts (hybrid + owner-turn-filtered; the index's coverage was positively controlled
— it holds *zero* turns from the June-2026 era, so any retirement conversation predates
the index), the memory store, the decisions/brainstorm/escalations corpora, the plan
store, and repo comments. Avi's only recorded reference is the 2026-08-16 question quoted
above, which names the fact of the retirement but not the reason.

This matters because the defense above is checked against what the system *was* (now
verified) but not against why it *died* (still presumed). If the real reason was, e.g.,
"wakes were too disruptive" or "answers came too late," that reason **transfers to the new
design** and must be answered by the wake-budget and latency-contract mechanisms rather
than by the authored-vs-discovered argument.

**One line from Avi closes this** — either "it was retired because ⟨X⟩," confirming the
defense or redirecting it. Alternate referent considered and demoted: the conversations
pane's "Q&A" surface (dropped by `conversations-agent-messages-2026-07-27`) renders the
*legacy user↔agent* Q&A (its `turn-answer` route died 2026-05-20) — a UI pane over a
different relationship, not "a QA system we implemented" for agents.

Pitch asset once stated: *"We built the naive version, retired it, and know exactly why it
died — and the new design answers that failure mechanically, not aspirationally."*

## 6. Evidence appendix

| Claim | Probe |
|---|---|
| Experts lib deleted 2026-06-03 (`6da55dfa`, 22 files, −2,959L) | `TZ=UTC git log --diff-filter=D -1 --format='%cI %H' -- apps/operator/lib/experts-core.ts` |
| Experts docs deleted 2026-05-20 (`0288443a`) | same probe against `apps/operator/content/internal-docs/spec/experts.mdx` |
| Recovered spec text | `git show 0288443a^:apps/operator/content/internal-docs/spec/experts.mdx` |
| Live scoper residue | `rg -n 'useExperts|/experts' libs/papercusp/packages/harness/blueprints/base/prompts/scoper.md` |
| Session index does not cover June 2026 | `sessions:search { query: 'harness plan feature work', until: '2026-06-10' }` → 0 hits (positive control) |
| Owner's retirement question, verbatim | `sessions:search { session: 'f8f0b056-b65b-404f-ac11-6f01f577ca9e', mode: 'verbatim', query: 'QA system taht we retired' }` |
| Consult mechanism as shipped | plan `get-feedback-relevance-consults-2026-08-16` §"The mechanism", D-002–D-009; WI-39414/19/21/48/57/61, WI-39470/74/99/500 |
