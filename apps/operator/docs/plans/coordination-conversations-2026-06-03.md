---
title: Coordination conversations — questions, discussions, and the knowledge-first ask
slug: coordination-conversations-2026-06-03
status: draft
created: 2026-06-03
updated: 2026-06-03
owner: aviynw@gmail.com
companion-to: [coordination-substrate-2026-06-03]
---

# Coordination conversations — questions, discussions, and the knowledge-first ask

## Now

**State:** Draft 2026-06-03. First consumer of [[coordination-substrate-2026-06-03]] — depends on it (Subscribable/Taggable/Threadable/Lifecycle). Shared architecture + cross-project decisions live in the substrate plan; this plan only adds conversation-specific decisions. No code yet.

**Next:** build after the substrate's Phase 0–1 (topics + subscriptions). This is the plan that proves the substrate end-to-end with a real object type.

## What this is

The original "an agent has a question but doesn't know who to ask" problem, generalized: a **conversation** object — a Threadable, Taggable, Subscribable, Lifecycle thread — with two kinds: `question` (wants an answer, resolves when answered) and `discussion` (open-ended). A question is just a conversation that can be answered; the broadcast-Q&A is the special case.

## Decisions (this surface; shared ones in the substrate plan)

### D-001 — Knowledge-first, then peers (tiered ask)
2026-06-03

Before opening a conversation, the ask tool tries existing knowledge — `search:semantic` (which **today indexes escalations / brainstorm / turns / `harness_decisions` only — NOT plans, issues, or past conversations**) + `mem0`. A hit returns the answer inline (no peer interrupted); a miss opens a conversation. This is enforced by the TOOL SHAPE (the ask tool runs the knowledge tier itself), not just by prompting — prompts drift, affordances do not. The tier must cite its source so the asker can judge a hit.

### D-002 — Hybrid sync/async delivery
2026-06-03

The fast knowledge tier answers SYNCHRONOUSLY (inline return). A miss opens an async conversation and returns immediately; peer/human answers arrive via the substrate delivery rail, surfaced on the asker's next tool call / turn. No agent ever blocks on a peer or human. Blocking is deliberately not built — it is redundant with `coord:escalate` / `coord:handoff` for a truly turn-blocking need.

### D-003 — Routing via topics, not experts
2026-06-03

The experts/roles system is deprecated and not used. A new conversation is tagged with topics (substrate Taggable); topic subscribers are the audience. "Who can answer" = who subscribed to the relevant topic + anyone who joins the thread. Per-thread join serves "I can contribute"; topic subscription serves "this is my area" (substrate D-005).

### D-004 — Answer-capture writeback (the loop-closer)
2026-06-03

When a question resolves, the accepted answer is written back to the knowledge layer (mem0 / an `agent-insights` page / a `harness_decisions` entry — chosen by the resolver). This makes the NEXT asker get a sync knowledge-tier hit, and is the safety net if the original asker went idle (the answer is not lost). **NB (load-bearing, per the plan audit):** because `search:semantic` does NOT index raw conversations/issues today, the knowledge-first loop closes ONLY through this writeback into indexed surfaces — answer-capture is the mechanism, not a nicety. Optional follow-up: add conversations + issues as `search:semantic` sources so even un-captured threads become findable. **NB (audit): `harness_decisions` is harness-keyed (`harness_slug NOT NULL`), so an operator-scope (`harness:'all'`) conversation has no decisions home — route its captured answer to the operator's home harness OR an `operator_decisions` surface (resolved alongside the federation-scope decision). `mem0` + `agent-insights` carry no such constraint and work for any scope.**

### D-005 — A conversation can promote to an issue
2026-06-03

A question/discussion that concludes "this is a real problem" promotes into an [[engineer-issues-2026-06-03]] issue, carrying its thread. The conversation's Threadable comment timeline is the same substrate the issue uses, so the discussion is not migrated — just re-parented.

## Build

### Phase 1 — Conversation object + ask
- Migration: `coord_conversations` (id, kind `question`|`discussion`, asker, Lifecycle state, topics via Taggable, thread via Threadable) on the substrate.
- `coord:ask { question, topics? }` — runs the knowledge tier (`search:semantic` over escalations/brainstorm/turns/`harness_decisions` + `mem0`); returns `{ answer, source }` on hit, else opens a conversation + returns `{ conversation_id }`. Suggests/requires topic tags.
- `conversations:post` / `coord:converse` — start/append a discussion thread (Threadable).
- `conversations:answer` + `conversations:resolve` — answer a question; resolve triggers answer-capture (D-004).
- `conversations:join` — per-thread subscribe (substrate Subscribable), for the "I can contribute" motivation.

### Phase 2 — Answer-capture + promote
- Resolve → writeback to mem0 / insights / a `harness_decisions` entry (or `operator_decisions` for operator-scope — D-004).
- `conversations:promote` → issue (re-parent the thread into [[engineer-issues-2026-06-03]]).

## Risks
- **Knowledge-tier quality** — a weak retrieval tier either misses (always escalates to peers) or false-hits (returns stale answers). Tune the sources + require source citation so the asker can judge.
- **Knowledge coverage gap** — `search:semantic` doesn't index conversations/issues, so a question already answered in an *un-captured* thread won't be found knowledge-first. Mitigated by disciplined answer-capture (D-004); the optional follow-up (index conversations/issues) closes it fully.
- **Idle-asker answer loss** — mitigated by answer-capture (D-004) + routing the answer to the asker's `plan_slug`/`feature` so a successor sees it.
- **Async latency** — acceptable per the hybrid model; the sync knowledge tier covers the fast path.

## Dependencies
Substrate (topics, subscriptions, Threadable, delivery). Knowledge sources: `search:semantic` (escalations/brainstorm/turns/`harness_decisions`) + `mem0` — both exist; plans/issues/conversations are NOT in the `search:semantic` index today, so the loop relies on answer-capture into indexed surfaces (indexing them is an optional follow-up). Promotes into [[engineer-issues-2026-06-03]].
