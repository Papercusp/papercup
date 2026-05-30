---
title: Two file-locking systems in Papercusp — a comparison
slug: file-locking-systems-comparison-2026-05-20
status: shipped
created: 2026-05-20
updated: 2026-05-30
owner: pandawamble@gmail.com
---

## Now

**State:** **Date:** 2026-05-20 **Status:** Analysis / design reference **Subjects:** - `FileLockQueue` — `libs/papercusp/packages/orchestrator/src/file-lock-queue.ts` - SU-locks — `apps/operator/lib/agent-tools/locks/` (committed `9ebb499a`), plan `su-agent-coordination-v3-2026-05-14.md`

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# Two file-locking systems in Papercusp — a comparison

**Date:** 2026-05-20
**Status:** Analysis / design reference
**Subjects:**
- `FileLockQueue` — `libs/papercusp/packages/orchestrator/src/file-lock-queue.ts`
- SU-locks — `apps/operator/lib/agent-tools/locks/` (committed `9ebb499a`), plan `su-agent-coordination-v3-2026-05-14.md`

---

## TL;DR

Papercusp has **two** file-claim coordinators. They look like siblings —
both do atomic multi-path acquire, FIFO fairness, deadlock-freedom,
dead-owner cleanup — but they solve **different problems that share a
vocabulary**.

The single variable that differs is **how many OS processes must
agree**. FileLockQueue coordinates async tasks inside *one* process;
SU-locks coordinates *N* independent processes. Every other design
difference — in-memory vs Postgres, Promise vs LISTEN/NOTIFY, string
owner vs session identity, `reap()` vs TTL, one trusted caller vs many
untrusted ones — is a *downstream consequence* of that one variable.

Neither is "better." FileLockQueue is **the easier problem solved
well**; SU-locks is **the harder problem solved adequately**. Swapping
them ranges from wasteful (SU-locks in-process) to physically
impossible (FileLockQueue cross-process).

The one criticism that survives scrutiny is *not* "which is better" —
it's that SU-locks was designed with no reference to FileLockQueue, so
the two reinvented a shared conceptual API in parallel, differently
worded. The fix is a shared **interface + vocabulary**, not a shared
implementation.

---

## 1. The two problems, stated precisely

### FileLockQueue

> Within a single orchestrator Node process, multiple
> concurrently-running worker invocations edit one shared working tree.
> Stop two of them from editing the same file at the same time, and
> never deadlock.

Facts about its world:

- **One process, one event loop, one heap.** The "agents" are async
  tasks (`runChunkLoop` calls), not processes.
- **The lock owner supervises the workers.** The same code that owns
  the queue spawns, schedules, and reaps the workers (`main-loop.ts`).
- **Shared fate.** If the process dies, every worker dies with it.
- **Exactly one caller**, `worker-chunk-loop.ts`, written by the same
  author as the lock. No untrusted caller exists.
- **Tiny contention** — `parallelMaxWorkers` is a handful (≈2–8).

### SU-locks

> Multiple independent OS processes — Claude Code / OMP / Codex /
> Gemini sessions, started by a human at different times — edit one
> shared checkout. Stop two from editing the same file, survive any
> one of them crashing, and make the state inspectable.

Facts about its world:

- **N processes, no shared memory, no shared fate.** Process A
  crashing must not corrupt or lose B's view.
- **No supervisor.** Nobody reaps a dead agent. A crashed agent is
  indistinguishable from a slow one.
- **Untrusted, heterogeneous callers** — LLM-driven agents in four
  CLIs, plus hand-written `psql`. Cooperation cannot be assumed.
- **Durability required.** Lock state outlives any agent and is a
  product surface (operator UI, `locks:queue`).

---

## 2. Are they the same problem? No.

Same **noun** ("file lock"). Different **problem**.

The shared vocabulary is genuine — both really do atomic
whole-set acquire with FIFO fairness — but the vocabulary is the
*cheap* part. The expensive parts (durability, identity, liveness
detection, enforcement, wait/wake) are where they diverge, and they
diverge because the **process model** differs.

A useful framing: SU-locks' problem is a strict **superset** of
FileLockQueue's. Everything hard in SU-locks is a thing FileLockQueue
gets to *not do* because it has one process and one trusted caller.

---

## 3. The cascade — one variable drives every difference

Every row below is downstream of "1 process" vs "N processes."

| Concern | FileLockQueue (1 process) | SU-locks (N processes) | Why the difference is forced |
|---|---|---|---|
| **State storage** | JS `Map<path, owner>` in heap | PG tables `agent_file_locks`, `agent_lock_waiters` | N processes can't share a heap — need an external store. |
| **Critical-section atomicity** | *Free.* The JS event loop never preempts; all of `acquire`/`drainWaiters` runs to completion between `await`s. | *Manufactured.* `pg_advisory_xact_lock(101, hashtext('su:'||ws))` serializes every mutating txn per workspace. | A single-threaded loop has a critical section for free. N PG connections genuinely race; the critical section must be built. |
| **Deadlock-freedom** | Whole-set atomic acquire + a waiter holds nothing while queued ⇒ no hold-and-wait ⇒ impossible. | *Same* — the advisory lock makes each acquire critical-section-atomic, so a partial hold never exists. | **Identical strategy** (see §4). One gets atomicity free; the other buys it. |
| **Wait / wake** | A `Promise`; `drainWaiters()` calls `resolve()`. Zero latency, zero polling. | Durable `agent_lock_waiters` row + `LISTEN ch_workspace_<id>` + `grant_cascade()` `pg_notify` on release. ≈1s wake. | A `Promise` is a heap object — can't cross a process boundary. Cross-process needs an out-of-band signal *and* the waiter itself must be durable (the waiting process can die). |
| **Owner identity** | Caller passes a string, `${feature.id}:${chunk.id}`. Trivial — the supervisor assigns it. | Each process must self-derive a stable, distinct id. The entire `Mcp-Session-Id` / hook `session_id` saga. | In one process the supervisor hands out ids. Across processes each must mint its own — and getting it wrong (per-machine id) silently collapses all agents onto one owner. |
| **Liveness / crash recovery** | `reap(owner)` — called by the orchestrator when it *observes* a worker lane die. No TTL. | TTL `expires_ts` + janitor sweep + optional `heartbeat`. | The orchestrator supervises its workers, so it *knows* when one dies. SU-locks has no supervisor — it can't tell crashed from slow, so it must time out. |
| **Enforcement** | Not a concern. One caller; the code path is literally `acquire(); … implement()`. A worker *cannot* edit without acquiring — the same function does both. | The central hard problem. N untrusted agents; the store can't make anyone honest. Claude Code gets a `PreToolUse` hook; OMP/Codex/Gemini are cooperative-only. | One trusted caller ⇒ enforcement is structural. N untrusted callers ⇒ enforcement is bolted on per-CLI and imperfect. |
| **Observability** | `snapshot()` for tests. Nobody else needs to see process-internal state. | `locks:queue` tool + operator UI + `psql`. The state is a product surface. | Process-internal state needs no UI. Cross-process coordination state must be inspectable by humans. |
| **Failure surface** | Essentially none. No I/O, no network, no second process. The lock cannot "be down." | PG can be down; the connection pool can saturate; advisory-lock holders can stick; statement timeouts fire. Hence `lock_timeout=5s`, per-op `statement_timeout`, the janitor. | An external store drags in its entire failure surface. |
| **Cost per acquire** | A few `Map` ops — nanoseconds. | A txn: advisory lock + janitor + head-waiter SELECT + upsert + verify — milliseconds, plus a round trip. | Durability and cross-process safety are not free. |
| **Size** | One file, ≈240 lines incl. comments. | ≈2.5k lines: store + txn wrapper + 5 verbs + listener + identity + 3 SQL migrations. | The size gap *is* the problem-difficulty gap. |

---

## 4. Correction: they use the *same* deadlock-freedom strategy

An earlier offhand take called these "different deadlock-freedom
strategies (canonical sort vs advisory lock) chosen for no examined
reason." Having read both: **that was wrong.**

Both are deadlock-free for the **same** underlying reason: a
**whole-set atomic acquire** means a caller never holds one path while
blocking on another. No hold-and-wait — and hold-and-wait is a
*necessary* condition for deadlock (Coffman). Remove it and deadlock
is structurally impossible, regardless of anything else.

- **FileLockQueue** gets the atomic critical section *for free* from
  the single-threaded event loop. A waiter is pushed onto a queue
  holding **nothing**, and `drainWaiters` grants it the entire set at
  once or not at all.
- **SU-locks** *manufactures* the same atomic critical section with
  `pg_advisory_xact_lock` per workspace, because its N transactions
  genuinely run concurrently.

Same design. The only difference is whether the atomic critical
section is a **gift of the runtime** or something you must **build**.

A precision note on FileLockQueue's own header: it attributes
deadlock-freedom to its "canonical-ordering rule" (alphabetical sort).
Lock-ordering is the deadlock defense for taking locks **one at a
time** — neither system does that. Given whole-set atomic acquire, the
sort is **not load-bearing** for deadlock-freedom; the
no-hold-while-waiting property is. The sort still earns its place —
dedup, stable set identity, FIFO determinism — but the header
overstates its role.

---

## 5. Which is "better"?

"Better" is undefined until the constraint set is fixed. Fix it, and
run the four-way matrix:

| | FileLockQueue's context (1 process) | SU-locks' context (N processes) |
|---|---|---|
| **FileLockQueue** | **Excellent.** ≈240 lines, zero deps, zero latency, zero failure modes, trivially testable, cannot get out of sync (nothing to sync). Near the simplest thing that works. | **Physically impossible.** Separate processes share no JS heap — there is no `Map` to contend on. The file's own header says so: *"In-process only … if we ever need cross-process locking … the implementation switches to filesystem-backed advisory locks."* |
| **SU-locks** | **Bad.** Adds a PG round trip + a whole side-database to a nanosecond hot path; introduces a "PG down" failure mode to something that currently *cannot* fail; gains nothing — the workers already share a heap. Strictly worse. | **Appropriate, roughly the right shape.** Bigger, with real sharp edges (the per-session identity bug; connection-pool pressure; the 500ms acquire timeout firing under load; cooperative-only enforcement for 3 of 4 CLIs). But the *size* is intrinsic — durability, identity, crash-detection, observability, wait/wake are each genuine requirements of the cross-process problem. |

Conclusions:

- **In-process:** FileLockQueue wins decisively. Its virtue is
  *restraint* — it solves exactly its problem and resists building
  machinery it doesn't need.
- **Cross-process:** SU-locks is the only option. FileLockQueue is not
  "worse" there — it is a non-starter.
- **Neither dominates** because they don't share a problem.
  FileLockQueue has the higher quality-to-difficulty ratio, and that
  restraint is genuinely to its credit — but it is solving the *easy*
  problem. A correct cross-process solution **cannot** be 240 lines;
  the comparison "SU-locks is bloated next to FileLockQueue" is a
  category error.

Single-sentence answer: **FileLockQueue is better engineering for an
easier problem; SU-locks is necessarily larger because its problem is
strictly harder.**

---

## 6. The criticism that *does* survive

Not "which is better." It is: **SU-locks was designed with no
reference to FileLockQueue.**

The SU-locks v3 plan's §0 history (v1 filesystem → v2 SQLite → v3 PG)
shows no awareness that the orchestrator already had a working,
battle-tested file-claim coordinator with the same *conceptual* API:

| FileLockQueue | SU-locks | Same idea |
|---|---|---|
| `acquire(owner, paths) → handle` | `locks:acquire` | atomic whole-set claim |
| `release(handle)` | `locks:release` | drop the set |
| `tryExtend(handle, more)` | folded into `acquire` (see §7) | grow a held set |
| `reap(owner)` | TTL + janitor | reclaim from a dead owner |
| FIFO `waiters[]` + `drainWaiters` | `agent_lock_waiters` + `grant_cascade` | FIFO-fair grant |
| head-waiter `reserved` set | head-waiter check in `tryAcquire` | anti-starvation |

The two reinvented this surface in parallel, differently worded.

**But — they should NOT share an implementation.** One is a `Map`, one
is PG + LISTEN/NOTIFY; the storage engine, wait mechanism, and identity
model are *correctly* different. What they could and should share:

1. **A common interface** — one `FileClaimCoordinator<Handle>` type,
   two implementations (`InProcessQueue`, `PgBackedQueue`). A reader who
   learns one learns the other; a conformance test suite can run
   against both. Low cost, real clarity win.
2. **Identical vocabulary** — "owner", "handle", "extend", "reap",
   "whole-set-atomic", "FIFO-fair" should be *named the same* in both.
   Currently parallel-but-differently-worded. Nearly free to align.
3. **One deadlock-freedom note** — documented once ("whole-set atomic
   acquire ⇒ no hold-and-wait"), referenced by both. Today FileLockQueue's
   header implies the *sort* is the defense and SU-locks' plan implies
   the *advisory lock* is — each tells half the story (§4).

Scope of the recommendation: **extract a shared interface +
vocabulary + a single deadlock-freedom note. Keep two
implementations.** Not "unify the systems."

---

## 7. Genuine semantic divergences (decide these if a shared interface is extracted)

Two places the systems made **opposite choices** — not cosmetic:

### 7.1 Extension: distinct operation vs idempotent re-acquire

- **FileLockQueue** has `tryExtend` as a first-class op. The worker
  chunk loop needs it: a worker often discovers mid-chunk it must
  touch an undeclared file; `tryExtend` grows the hold without
  releasing. On contention → release-all + re-acquire the union.
- **SU-locks** has no `extend` verb. Extension is folded into
  `acquire`: calling `locks:acquire` again with a superset is a
  same-owner re-acquire. The `xmax = 0` / `reusableLockId` machinery
  in `tryAcquire` exists *precisely* to make a second acquire unify
  `lock_id`s instead of fragmenting them — and the Claude Code hook
  leans on it (every `Edit` fires a fresh acquire).

Both defensible. SU-locks' choice is the more subtle one — a
meaningful slice of `tryAcquire`'s complexity is there only to make
"acquire is also extend" correct. If a shared interface is extracted,
this is the one place the two genuinely disagree and a call must be
made: first-class `extend`, or idempotent re-acquire.

### 7.2 FIFO fairness — same compromise, different mechanism

Both want: strict FIFO would let waiter[0] blocked on a hot file stall
an unrelated waiter[1] whose files are free — too pessimistic. Both
land on the same compromise — *unrelated later waiters may pass; a
waiter conflicting with the head may not*:

- **FileLockQueue** — explicit: `drainWaiters` builds a `reserved` set
  from the head waiter's paths; any later waiter touching a reserved
  path is skipped.
- **SU-locks** — split across two places: `grant_cascade` iterates
  strict `ORDER BY queued_ts, ticket_id` granting any free set, and
  `tryAcquire` refuses a *fresh* acquire if an older waiter overlaps
  (the head-waiter check). Together these yield the same rule.

They converge on behavior; only the mechanism differs. A shared
interface should state the fairness contract once so neither drifts.

---

## 8. Recommendation

1. **Keep both systems.** They solve different problems; both are
   well-matched to theirs. No merge.
2. **Extract `FileClaimCoordinator`** — a shared interface + a shared
   conformance test suite, two implementations behind it. Modest
   effort, real onboarding/clarity payoff.
3. **Align vocabulary** across both code + docs (§6.2).
4. **Write the deadlock-freedom rationale once** (§4) and have both
   point at it; fix FileLockQueue's header overstatement of the sort.
5. **Decide the extension model** (§7.1) as part of the interface.
6. Treat SU-locks' real sharp edges (identity, pool pressure,
   enforcement coverage) as **their own** follow-ups — they are
   intrinsic to the cross-process problem, not artifacts of having
   ignored FileLockQueue, and a shared interface does not address them.

The headline for a reader who remembers nothing else: **two systems,
one variable — process count — and that variable, not any quality
difference, explains every divergence.**
