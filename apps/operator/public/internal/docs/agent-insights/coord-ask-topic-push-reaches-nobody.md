# `coord:ask` topic push reaches nobody — and the ref-format traps that hide it

**TL;DR** — Asking a question via `coord:ask` with topics tagged does **not** mean
anyone was notified. There are effectively **zero topic subscribers** in this
workspace, so a topic-routed question reaches nobody, and until WI-5807 the tool
cheerfully reported it as *routed*. Answers now come from a **pull** surface
(`coord:orient`'s `openQuestions` fold + `conversations:list { unansweredOnly:true }`),
not from topic push. If you need a specific agent to answer, **name them in `to:`**.

Measured 2026-07-25 (WI-5807, plan
`surface-every-routine-and-unbreak-automation-panes-2026-07-25` P-007).

---

## The finding

| what | number |
|---|---|
| live topic subscriptions, whole workspace | **0** |
| distinct topics used by open questions | 30 (none with a subscriber) |
| open questions | 39 |
| …of those, with zero replies | **39 (100%)** |
| open questions that WERE correctly topic-tagged | 13 — still 1 subscriber (the asker), still 0 replies |
| last question asked at all | 2026-07-20 |

The 13-question row is the load-bearing one: those askers **did it right** — they
tagged topics exactly as the tool told them to — and reached exactly nobody. So this
was never "agents ignore questions". The push mechanism is structurally dead, and the
asking behaviour was rationally abandoned because asking stopped paying off.

Subscriptions themselves are healthy (26k+ live `object` subs). Only *topic* routing
is empty. The asker is self-subscribed, posters auto-join, and `conversations:resolve`
already emits an awaited `conversation:answered:<id>` event — none of that was broken.

## The false-success bug (fixed)

`openConversationCore` computed `unrouted` as `topics.length === 0 && directTo.length === 0`
— i.e. **"did you tag something"**, not **"was anyone reached"**. Tag a topic with no
subscribers and you were told your question had been routed. It is now
`delivered === 0`, measured from the actual fan-out, and cannot drift: `directTo`
recipients are subscribed *before* the fan-out and the asker is excluded from it.

`coord:ask` / `conversations:post` now say plainly *"reached NOBODY — 0 agents
notified"*, name the tagged topics as having no subscribers, and tell you to re-ask
with `to: ['<ownerId>']` (`coord:presence` for who is live).

## What to do instead

- **Asking:** put the agents you want in **`to:`**. That subscribes them directly,
  before fan-out, so it reaches them regardless of topics. Topics only *widen* an
  audience that already exists — they do not create one.
- **Answering:** open questions are pulled, not pushed. `coord:orient` folds up to 3
  open, unanswered questions (excluding your own, aged out at 30 days) as
  `openQuestions`; `conversations:list { kind:'question', state:'open',
  unansweredOnly:true }` is the full set. Answer with `conversations:answer { id, body }`.
- **Do NOT** stand up another opt-in subscription type for this. The existing one
  having zero uptake *is* the finding; a second one inherits the same zero.

---

## ⚠ The query traps — a ref-format mismatch silently returns ZERO

This is the part worth remembering even if you never touch Q&A. Investigating the
above produced **two confident, completely wrong root causes** before the real one,
because these joins return an empty set on a format mismatch — and an empty set reads
exactly like a finding ("nobody is subscribed to anything!") rather than like a bug in
your query.

| table | column | format |
|---|---|---|
| `coord_entity_subscriptions` | `target_kind` | `'object'` — **not** `'conversation'` |
| `coord_entity_subscriptions` | `target_ref` | **PREFIXED**: `'conversation:conv-…'` |
| `coord_links` | `src_kind` | `'conversation'` |
| `coord_links` | `src_ref` | **BARE**: `'conv-…'` |
| `coord_links` | `dst_kind` / `rel` | `'topic'` / `'tagged'` |
| `coord_threads` | `parent_kind` / `parent_ref` | `'conversation'` / **BARE** `'conv-…'` |

So the same conversation is keyed **prefixed** in one table and **bare** in the next.

**The rule: sample a real row and confirm the ref format BEFORE you join on it.** A
zero-row result from a hand-written join is "my join key is wrong" until proven
otherwise — never a finding on its first read. Cross-check any zero against a
single-table `SELECT … LIMIT 5` of each side.

Related: coord_threads also carries `title`, `created_at` and `workspace_id`, which
**collide** with `coord_conversations`' own columns — any join between them must
qualify its select list or Postgres errors on the ambiguity (or, worse, a `SELECT *`
hands you the thread's title where you expected the conversation's).

## Where the code lives

- `packages/operator-core/lib/agent-tools/coordination/conversations-core.ts` — `openConversationCore` (`unrouted` = `delivered === 0`)
- `packages/operator-core/lib/agent-tools/coordination/conversations-store.ts` — `list({ unansweredOnly, includeUnscoped })`
- `packages/operator-core/lib/agent-tools/coordination/tools/orient-open-questions.ts` — the pure orient fold
- `packages/operator-core/lib/agent-tools/coordination/tools/orient.ts` — the leg + the `assembleOrientOutput` hoist that keeps the fold above the result-door cut line
