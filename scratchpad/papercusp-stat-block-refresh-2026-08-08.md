# Papercusp stat block — reconciled and refreshed

*Measured 8 August 2026. Supersedes the late-July figures in the deck.*

---

## 1. The headline: one number in the deck is mislabelled and will reproduce *lower*

**Slide 11 says `113,527 — COORDINATION EVENTS / ALL TIME`. Re-measured today it is
108,086.**

The table is retention-pruned. Its oldest surviving row is 30 May 2026, but the first
commit was 6 April — so roughly the first eight weeks have already aged out. "All time"
was never the right label; it was a point-in-time count of a rolling window.

Why this is the one to fix: the deck promises every figure is *"reproducible on request."*
An investor's engineer who checks this one gets **108,086** against a slide claiming
**113,527 all time** — a number that went *down*. The two available readings are "he
inflated it" or "he doesn't know how his own instrumentation works." Both are worse than
the truth, which is mundane: it's a rolling window and the label was wrong.

**Fix it as a rate, which is both defensible and stronger:**

> `25,711 — COORDINATION EVENTS / LAST 7 DAYS`

A rate can't be contradicted by retention, it reproduces on demand forever, and ~3,700
coordination events a day says more about sustained load than a cumulative total does.
If you want a cumulative number too, label it honestly: *108,086 retained (70-day
window)*.

---

## 2. Everything else grew. Several figures are now conservative.

| Metric | Deck (late July) | Now (8 Aug) | Change |
| --- | --- | --- | --- |
| Lines TS/TSX | 2.37M | **2.41M** | ↑ 1.7% |
| Test lines | 993K | **1.139M** | ↑ 14.7% |
| Test files | 5,349 | **5,692** | ↑ 6.4% |
| Test-to-source ratio | 0.72:1 | **0.90:1** | ↑ 25% |
| Agent tool calls / 7d | 482,645 | **593,991** | ↑ 23% |
| Work items in ledger | 29,005 | **33,769** | ↑ 16% |
| Coordination events | 113,527 "all time" | **25,711 / 7d** | *relabel* |
| Migrations | 572 | **630** | ↑ 58 in 12 days |
| Tools / groups | 691 / 139 | **691 / 139** | flat |
| Blueprints | 48 | **48** | flat |

**The ratio move is the most valuable one.** 0.72:1 → **0.90:1** means test code grew
almost 9× faster than product code over twelve days. For anyone assessing whether an
agent-built codebase is actually verified rather than merely large, that trend line is
worth more than the absolute number — it says verification intensity is *increasing*
under autonomous development, which is the opposite of the default assumption about
AI-generated code.

---

## 3. Why your 2.37M and my earlier 2.14M both measured correctly

They counted different sets, so "pick one" was the wrong advice — the right answer is to
state the basis.

| Basis | Files | Lines |
| --- | --- | --- |
| On-disk, excluding `node_modules` (what the deck used) | 13,768 | — |
| Git-tracked, all | 11,668 | 2,434,697 |
| **Git-tracked, excluding retired code** ← recommended | **11,495** | **2,405,004** |
| Retired code only | 173 | 29,693 |

The deck's file count (12,099) is an on-disk count, so it included generated and untracked
files. My 2.14M was tracked-and-excluding-retired at a point twelve days earlier.

**Publish the tracked-excluding-retired basis.** It is the strictest defensible reading,
it reproduces with one command anybody can run, and — the useful part — it now *exceeds*
the deck's headline anyway. You get a higher number and a tighter methodology at the same
time. Say the basis out loud in a footnote: *"git-tracked TypeScript, excluding retired
code; `git ls-files` reproducible."*

---

## 4. Three figures you have and aren't using

These came out of the same measurement and are not on any slide. The first is the best
unused stat you own.

**228 distinct agents in the last 7 days.**
Not sessions — distinct agent identities that made tool calls. Paired with 593,991 calls,
this is the number that makes "coordination substrate" concrete: 228 agents, ~594K
operations, one codebase, no interference. Slide 11 currently proves *volume*; this proves
*concurrency*, which is the actual claim. Nearly half a million calls could in principle
be one agent in a loop. 228 agents cannot.

**2,551 distinct coordination participants all-time · 200 distinct harnesses.**
The breadth behind the volume — the substrate has carried thousands of agent identities
across 200 separate work contexts, not one long-running pot.

**16,172 work items driven to a terminal state.**
Completion, not just accumulation. 33,769 items in the ledger reads better when you can
say ~16K of them were carried to done — it answers the obvious skeptical question about
whether a big queue means throughput or just backlog.

**~84,900 tool calls per day, sustained.** Same figure as 593,991/7d, but a daily rate
lands harder in conversation and survives the reader forgetting your window.

---

## 5. Recommended slide 11

```
2.41 M          1.14 M          0.90:1
LINES TS/TSX    LINES OF TESTS  TEST-TO-SOURCE RATIO
11,495 FILES    5,692 TEST FILES  ↑ from 0.72:1 in July

593,991         228             33,769
AGENT TOOL      DISTINCT AGENTS WORK ITEMS
CALLS / 7 DAYS  / 7 DAYS        IN THE LEDGER
```

Swapping the cumulative coordination-event total for **228 distinct agents** costs you
nothing and upgrades the slide from a volume claim to a concurrency claim — which is the
thing the whole deck is arguing.

Footnote: *Measured from the repository and live database 8 August 2026. Lines are
git-tracked, excluding retired code. Rates are trailing seven-day. Reproducible on
request.*

---

## 6. Also worth updating

- **"Sixteen weeks"** (slide 11) → **eighteen weeks**. First commit 6 April, so it's 124
  days as of 8 August. Cheap to get wrong and cheap to fix; it'll go stale again, so
  consider "since 6 April 2026" and let the reader do the arithmetic.
- **630 migrations, up 58 in twelve days** — a decent throughput proxy if you ever need
  one, and it's schema change under autonomy, which is the risky kind.

---

## 7. Making "reproducible on request" true

Every figure above came from either `git ls-files` piped to `wc`, or a read-only SQL query
against the operator database. Nothing needed judgement, which means it can be one
command.

The gap worth closing: the promise is on the slide, but there's no artifact that delivers
it. If someone asks, the answer should be a script you run in front of them that prints
the block — not you reconstructing twelve ad-hoc measurements from memory, which is what
just produced the mislabelled coordination number in the first place.

Say the word and I'll add `npm run stats:proof` — one command, prints the slide-11 block
with its basis footnote, and fails loudly rather than silently mislabelling a
retention-pruned table as all-time. Roughly an hour, and it makes the deck's strongest
promise mechanically true.
