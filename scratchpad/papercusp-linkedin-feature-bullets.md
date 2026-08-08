# Papercusp — feature bullets for LinkedIn

*Pick-list. 62 bullets, grouped. Each is header + 2–4 sentences, written to stand alone
so you can lift any one of them without the others for context.*

---

## How to pick

A LinkedIn profile is skimmed by three audiences at once — recruiters, engineers, and
investors. They reward different bullets:

- **Recruiters** scan for scale and scope. §9 (numbers) and §1 (positioning).
- **Engineers** scan for whether you've built something real. §2, §4, §6, §8.
- **Investors** scan for the thing that isn't commoditised. §1, §5, §6.

**If you only pick eight,** these carry the most weight per line and don't overlap:
`1.1` · `1.2` · `2.1` · `3.1` · `4.1` · `5.2` · `6.1` · `9.1`

**Numbers updated 8 August 2026 — regenerate with `npm run stats:proof` rather than
trusting this file.** §9 now differs from the deck for two reasons, both worth knowing
before you publish: (1) every earlier measurement in this thread — including my own
reconciliation — *undercounted*, because `git ls-files` silently omits the contents of
all 39 submodules; the true total is 2.66M lines, not 2.37M or 2.41M. (2) The deck's
"113,527 coordination events / all time" tile is over a retention-swept table, so it
re-measures **lower** than published — fix it before anyone checks. Full reconciliation:
`papercusp-stat-block-refresh-2026-08-08.md`.

---

## §1 — Positioning and thesis

**1.1 · Coordination infrastructure for fleets of AI agents**
Built the layer that lets many AI agents work one codebase without interfering with each
other. Nearly all AI capital has gone into making individual models better; how you get
many agents to work together productively has received a fraction of it, and most of
what exists predates the current generation of models. That gap is the product.

**1.2 · Built Papercusp with Papercusp**
The system wrote itself. I designed all of it and directed the work, but the agent fleet
produced the code — running on the coordination substrate it was building, from a standing
start on 6 April 2026, one person. The strongest evidence that the coordination layer
works is the artifact it produced.

**1.3 · An open ecosystem, not a workflow harness**
Traditional agent frameworks have humans pre-configure how agents interact. Papercusp
instead hands agents low-level composable primitives — messaging, events, locks, work
items, memory, retrieval — and lets them decide how to compose them for the mission.
Structure emerges from real use rather than from a guess written in advance.

**1.4 · A layer above the models and above the coding CLIs**
Papercusp is not a model and not another coding agent. It sits above both, which is why
every model release and every new agent CLI makes it stronger instead of replacing it.
Agent backends (Claude Code, Codex, open-weights models on your own hardware) are
interchangeable drivers behind a stable interface.

**1.5 · The bet: no new model capability required**
The thesis is that today's models go dramatically further with support than they do
unaided — durable memory, dynamic context, enforced concurrency, push-based
coordination, mechanical verification. Nothing here waits on a research breakthrough. It
is solved by accumulating a very large number of unglamorous engineering details and
holding all of them in view at once.

**1.6 · Ten agents is a productivity story; ten thousand is a capability story**
Going from one agent to ten produces a real but sublinear gain that already pays for
itself in tokens. The interesting question is what becomes possible at a scale nobody has
run, because nobody has built the layer that would let them — including agents that don't
just solve problems but work out which problems need solving.

---

## §2 — Multi-agent coordination

**2.1 · Fleet model — one leader, many members, no hand-dispatch**
A fleet has a leader responsible for driving a plan to completion and members who pull
work autonomously. The leader writes a *filter* over the work-item dependency graph
defining what the fleet may touch; members call `get_next` and receive the next claimable
item whose blockers are all resolved. Nobody hands out assignments, so the leader never
becomes the bottleneck.

**2.2 · Leader observability into every member**
A fleet leader can see the live state of each member — what it's holding, whether it's
progressing or stalled, how full its context window is, and which critical work nobody
has picked up. Supervision is a query against shared state, not a status meeting.

**2.3 · Messaging delivered at every tool call**
Agents communicate over a durable messaging plane whose deltas are injected at each tool
call, so a message reaches a working agent mid-task rather than waiting for it to check
an inbox. Supports direct messages, audience addressing, and subscriptions.

**2.4 · Audience addressing that resolves at send time**
Messages are addressed to *audiences*, not enumerated recipients — a fleet, a topic, a
plan, everyone holding a given file. The selector resolves to the live set when the
message is sent, and an unknown selector reaches nobody rather than broadcasting to
everyone. An entire plan or fleet is one address.

**2.5 · Subscriptions with per-reader volume control**
Agents create their own threads and subscribe to their peers', choosing how loud each one
is: every update, a periodic digest, or only when explicitly named. Volume is the thing
multi-agent systems get wrong, and the control belongs to the reader.

**2.6 · Dynamic events — agents create and await their own conditions**
Rather than polling, an agent declares an event, and peers wait on it — one event, a
pattern, or a compound condition (all of these, any of these, three of five). The waiter
ends its turn and consumes nothing until the event fires. Declarations latch, so an agent
that registers after the fact is told immediately instead of waiting forever.

**2.7 · Agents wake each other**
An agent blocked on something another agent owns can wake that agent directly, and gets
back a verifiable delivery result — whether a live session actually received it, or
whether the recipient was absent. "I handed it off" is a checkable claim rather than an
assumption.

**2.8 · Theory of mind in the message protocol**
Every message declares what it expects back — an acknowledgement, an answer, an action,
or nothing at all — and carries what the sender believes the reader does not yet know.
Agents therefore operate with a working model of each other rather than broadcasting into
the void.

**2.9 · Auto-coupling of agents working on the same thing**
The system detects, from live turn content, when two agents are working on related
problems and automatically couples them — injecting more detailed context about the other
agent's work into each one's window. Collaboration that neither agent had to think to
ask for.

**2.10 · File locking with declared intent**
Agents don't merely see that a file is locked; they see *why* — the holder's stated
intent and expiry. Enforcement is automatic at the edit boundary, so concurrent editing
is safe by design and agents never have to negotiate before touching a file.

---

## §3 — Work tracking and planning

**3.1 · One object model: everything is a plan or a work item**
There is no separate workflow language to learn. A one-line fix, a twelve-phase
migration, a coding task and a research task are the same kind of object and get the same
machinery — claims, dependencies, phases, priorities, schedules, wakes and audits. Plans
convert into work items when started.

**3.2 · Work items form a dependency DAG**
Items declare what blocks them, producing a graph the scheduler walks. Every item carries
an assignee and a completion state, and nothing is claimable until its blockers resolve —
so ordering is enforced by the substrate rather than by an agent remembering the sequence.

**3.3 · Ambiguity needs no pre-written branch**
An agent that meets a situation nobody anticipated doesn't fall off the end of a rigid
workflow. It creates the structure as it goes — expands a work item, records a decision,
opens a new plan, escalates to a human — and the scheduler treats all of it identically.

**3.4 · Structure is emergent, then frozen**
Once a workflow proves itself in real use, it's frozen into a *blueprint*: a validated,
versioned declaration of a pipeline's work-item spine, roles and phases. The order
matters — you write the blueprint after the right structure has emerged, not up front
from a guess. 48 blueprints today, covering coding, research, review, migration,
deliberation and evaluation.

**3.5 · Repetition hardens into tooling**
When agents keep doing the same thing, the platform notices. Repeated procedures are
ranked as promotion candidates by run frequency, distinct-agent reuse and success rate,
with near-duplicates clustered for merging — so common paths become first-class tools
instead of folklore.

**3.6 · Cross-lane rulings are addressable objects**
When an agent settles a trade-off other agents must follow, it's recorded as a plan
decision with an id, not a chat message. Decisions surface automatically when a governed
item is claimed. Observed live: an agent re-read a recorded decision, discovered its own
earlier report was wrong, self-corrected unprompted and swept up further instances — an
outcome a message cannot produce, because a message isn't addressable after delivery.

**3.7 · Completion requires evidence**
Closing a work item requires stating what was verified and how. A bare "done" is reopened
by the leader's completion-integrity audit, which makes burn-down numbers mean something.

---

## §4 — Context and memory

**4.1 · Context that outlives the context window — no compaction needed**
Agents write durable state the moment it forms: checkpoints, decisions, asserted facts.
When a session hits its token limit there is nothing to compact and nothing to lose — the
process is killed, relaunched against a deterministic carry document, and resumes. The
industry's standard failure mode (lossy summarisation of a long session) is designed out
rather than mitigated.

**4.2 · Four kinds of memory, deliberately distinguished**
*Semantic* — facts and background. *Episodic* — the turn-by-turn record of what actually
happened. *Working* — checkpoints holding a job still in flight. *Procedural* —
agent-written runbooks recording how a confusing failure was really diagnosed. An agent
hitting a strange bug searches the runbooks before it reads any code, so the system gets
cheaper to operate the longer it runs.

**4.3 · One shared memory store across every client**
A single store every agent and client reads and writes, holding four scopes: reference
(how a thing works), project (what's being built and why), feedback (how you want the
work done) and user (who you are). No per-client silos, so knowledge earned in one
session is available everywhere.

**4.4 · Hybrid recall across four embedding spaces**
Retrieval fuses full-text search with four embedding spaces (including a fully local
model) via reciprocal rank fusion, then reranks. Memories carry anchors to files, plans
and tools, so recall narrows automatically to whatever the agent is touching. Superseded
facts retire rather than vanish.

**4.5 · Dynamic context injection — assembled per turn, not at startup**
An agent's working context isn't a static prompt written once. The platform composes it
at every turn boundary from live state — what changed, what you claimed, what a peer told
you, what you once concluded — and sends it as a delta from the last update. Injection
volume is tuned per reader to balance performance against token spend.

**4.6 · It arrives already briefed**
Whenever an agent starts, wakes, picks up a task or returns from a restart, the history,
decisions and peer activity bearing on that specific job are already in front of it. It
never burns a turn hunting for context before it can begin.

**4.7 · Provenance stamping — authority does not drift**
Every injected line is marked with where it actually came from: a human, a peer, or the
agent's own earlier notes. This kills a real and subtle failure mode — across repeated
context rewrites, an agent's own note-to-self gets re-read as an instruction from the
user, eventually manufacturing directives and permissions the human never gave. Papercusp
makes origin mechanically checkable.

**4.8 · Live references instead of snapshots**
A work-item id mentioned in a message hydrates at delivery into current status, title and
checkpoint. A cited item arrives live and the reader never re-fetches it, so agents don't
act on stale copies of state.

**4.9 · The verbatim record survives**
All session turns are indexed and semantically searchable. Losing context is not losing
data — an agent can retrieve the exact pre-restart quote instead of re-deriving it, or
worse, confidently guessing at it.

**4.10 · Deterministic context injection on reach**
Beyond search, the system detects when an agent is reaching for something and injects the
relevant context deterministically — the right runbook, the governing decision, the prior
attempt — rather than relying on the agent to think to look.

---

## §5 — Self-improvement

**5.1 · Every turn ends by proposing an improvement**
Agents are instructed to close each turn by identifying what would have made that turn
easier. Fully-formed ideas go straight onto the persistent work queue as claimable,
deduplicated work items; half-formed ones go to a separate observation backlog. Friction
is captured at the moment it is felt, not reconstructed later.

**5.2 · An idea pipeline that learns which ideas ship**
Observations and deterministically-collected system statistics feed a generation pipeline
that runs several creative lenses — first-principles, analogical, inversion. Adversarial
critics then score each idea for novelty and feasibility, survivors are fused into
proposals, and real outcomes feed back into the lens weights. Over time the system learns
which *kinds* of thinking actually produce shipped work, and reweights toward them.

**5.3 · Lessons travel between projects**
When the same friction recurs across different projects, the system promotes it into a
lesson on its own, carrying the count of how often it recurred and the trail of where.
Lessons export as packs and install into another project's memory with a conflict review,
so the second project starts where the first left off.

**5.4 · Agent-authored rubrics with runnable replication drills**
Want to improve something? An agent writes a rubric — each criterion spelling out how the
thing is meant to work, how to measure it, and what degraded looks like. A rating filed
without evidence is rejected, and every criterion carries a runnable drill so a grade can
be reproduced rather than believed. Rubrics are versioned: proposed, ratified, amended.

**5.5 · Documentation bound to the code it describes**
Agents write documentation automatically and link it to specific functions. When one of
those functions changes, an agent is woken to check whether the documentation still
holds. Docs rot by default in every codebase; here the rot triggers a work item.

---

## §6 — Peer-to-peer

**6.1 · Built a peer-to-peer implementation of git**
Machines sync code directly to each other over encrypted connections with no forge in the
middle — one repository per project, each device writing its own private lane. Agents
across a P2P network can therefore coordinate on and self-improve any project built in
Papercusp, including Papercusp itself.

**6.2 · The coordination plane is peer-to-peer too**
It isn't only the code. Messages, events, presence and work state all move machine to
machine, each side signing a receipt. There is no central coordinator to go down.

**6.3 · Your source never leaves your machines**
Because peers sync straight to each other, no outside service ever holds your source,
your work history, or anything your agents produce. Nothing to subscribe to, no third
party to trust, and no outage somewhere else that can stop your team working.

**6.4 · Shared work state across humans and machines**
Everyone on a project sees one shared work state, not synchronised copies. Two people and
their fleets can build the same codebase from different machines, with permissions setting
what each side may see and change.

**6.5 · Bridged to GitHub without depending on it**
The P2P layer bridges bidirectionally to GitHub — ingress, egress, forks and release
promotion — with an admission gate and a secrets guard on publish. Teams interoperate with
existing infrastructure while the substrate itself remains decentralised.

**6.6 · Source bundled with the release**
The source ships with the product so that anyone can improve their own Papercusp. Combined
with the P2P layer, improvements can propagate between installations without a central
distributor.

---

## §7 — Verification and delivery

**7.1 · Agents never commit — locks in, cadence out**
Agents don't touch git. They edit under intent-declaring file locks, and a background
routine commits the whole shared tree to a staging branch on a cadence. This removes an
entire category of multi-agent failure: no branch juggling, no half-committed trees, no
agent clobbering another's uncommitted work.

**7.2 · Promotion to main is earned mechanically**
On a separate cadence the staging branch runs the full test suite; it fast-forwards to
main only if it passes. Nothing reaches the green branch by human or agent judgement — a
pre-push hook blocks it — so "green" is a fact rather than a claim.

**7.3 · Automated deploy with rollback**
Green commits deploy automatically within minutes, with auto-rollback on failure and a
two-port model running staging and green production side by side. The full path from an
agent's edit to live software has no human step in it.

**7.4 · Verification-weighted engineering**
A 0.86:1 test-to-source ratio — 1.23M lines of tests across 6,170 test files — spanning
unit, integration against real containerised Postgres, browser end-to-end with
accessibility checks, Rust, and scored LLM behaviour batteries that catch prompt and
policy regressions. Mechanical verification is what makes autonomy safe to grant.

---

## §8 — Platform engineering

**8.1 · One typed function, three transports**
Features are written once as a single typed function and projected automatically onto an
HTTP route, an MCP tool for agents, and an in-process call. Auth, role allow-lists,
quotas, streaming progress, error shaping and telemetry are handled once in a shared
dispatcher. The catalogue now stands at 691 tools across 139 groups — a consequence of
the architecture, not of writing 691 endpoints.

**8.2 · Postgres as the entire coordination substrate**
Every durable thing lives in one transactional store: work items, plans, decisions,
locks, presence, messages, memories, flags, and a full telemetry record of every tool
call. Multi-agent systems usually keep coordination state in process memory and then
can't answer "what happened and why" afterwards. Here provenance, audit and cost
attribution are queries. 630 migrations, no runtime DDL.

**8.3 · A real Postgres embedded in a desktop app**
The product ships PostgreSQL 18 embedded, with logical replication — not SQLite, and not
a hosted dependency. Local-first is a genuine architectural stance rather than a
marketing one.

**8.4 · Local-first desktop on Tauri and Rust**
Built on Tauri 2 with a native webview and a Node sidecar, giving an order-of-magnitude
smaller installer and materially lower idle memory than the Electron equivalent — which
matters for an app that sits resident all day running fleets. Includes tray-resident
headless operation, login auto-start, a signed auto-updater, and a fully type-checked
Rust↔TypeScript IPC boundary.

**8.5 · A multi-provider inference gateway**
Model calls route through a first-party gateway providing credential pooling across many
accounts, per-account rate governance, automatic failover with cache-preserving session
affinity, health probing, circuit breaking and per-call cost accounting. Providers are
interchangeable inputs; a customer requiring fully on-premise inference is a
configuration change, not a rewrite.

**8.6 · WebAssembly component plugins**
Third-party plugins compile to WASM components against versioned WIT interfaces and load
on either host — jco-transpiled for JavaScript, wasmtime for Rust. Sandboxed,
capability-scoped and language-agnostic: a materially stronger security posture than
running an untrusted npm package in-process.

**8.7 · Realtime sync over Postgres LISTEN/NOTIFY**
A first-party sync layer gives the UI one query API and picks its transport by context —
server-sent events over Postgres notifications as the desktop path, with WebSocket and
REST fallbacks. A write anywhere invalidates exactly the affected queries.

**8.8 · Agents can drive the UI through the same surface humans use**
User-meaningful UI state lives in the URL rather than in component memory, as an enforced
architectural rule. That makes the entire interface addressable and drivable by an agent
— state hidden inside React is invisible to one.

**8.9 · Two modes: full autonomy, or a superuser peer**
Run the autonomous loop when you want agents to manage everything end to end, or work
directly with a superuser agent when you want a collaborator with full authority and a
human in the decision path. The same substrate serves both.

**8.10 · ~30 domain-free libraries built for reuse**
Roughly thirty internal libraries — sync, search, locks, rate limiting, scheduling,
plugin loading, structured concurrency, IPC framing, deployment driving — are written
behind configuration seams specifically so they can be reused or spun out, with a
generated catalogue and a lint rule enforcing the pattern.

**8.11 · Feature delivery that can't quietly stall**
A first-party flag system with enforced defaults, an audited exception list for anything
shipped dark, and expiry dates on those exceptions. Finished work cannot sit unshipped
behind a flag nobody flips.

---

## §9 — Scale and proof

*Re-measured 8 August 2026 by `npm run stats:proof`. Lines are git-tracked TypeScript
across the superproject and all 39 submodules, excluding retired and vendored code.*

**9.1 · 2.66M lines since April, solo**
First commit 6 April 2026 — 17 weeks. 2.66M lines of TypeScript across 12,731 files, plus
a 71K-line Rust desktop shell, built by one person directing an agent fleet: not a line
hand-written, but all of it designed. Every figure is measured from the repository and the
live database by a single command, and reproducible on demand.

**9.2 · 233 agents, 580,000 tool calls, one codebase, one week**
579,886 agent tool calls from 233 distinct agent identities in a single seven-day window —
roughly 83,000 operations a day, sustained. Volume alone could be one agent in a loop; 233
concurrent identities on one codebase is the thing that's actually hard, and it is the
regime where coordination either holds or falls apart.

**9.3 · 1.23M lines of tests — a 0.86:1 test-to-source ratio**
1.23M lines of tests across 6,170 test files against 1.43M lines of product code. On the
narrower basis I've tracked longest, the ratio has climbed from 0.72:1 to 0.90:1 — test
code growing faster than product code under autonomous development, which is the opposite
of the default assumption about AI-generated software.

**9.4 · 33,803 work items, 15,554 driven to done**
The work ledger at production volume, with nearly half of everything ever filed carried to
a terminal state — throughput, not just accumulation. Alongside it: 25,000+ coordination
events a week across 55 distinct work contexts.

**9.5 · 691 tools across 139 functional groups**
The agent-facing surface area, all of it auth-gated, quota-governed and telemetered
through one shared dispatcher — generated from typed function definitions rather than
hand-written per endpoint.

**9.6 · 630 schema migrations, 58 of them in twelve days**
Schema evolution under autonomous development, applied through a runner with atomic
migration-number allocation so concurrent agents cannot collide. Sustained structural
change is the risky kind, and it's the kind this has been doing continuously.

---

## §10 — Three framings if you want a single summary line

**Engineering-forward**
Built a coordination substrate for AI agent fleets — durable work-item DAG, push-based
messaging and events, enforced file locking, four-layer memory with dynamic context
injection, peer-to-peer git, and mechanically-gated delivery. 2.66M lines in seventeen
weeks, written by the agent fleet it was built to coordinate.

**Product-forward**
Papercusp turns a crowd of AI agents into a team. Agents claim work off a shared
dependency graph, message and wake each other, remember what they learned across
restarts, verify their own work through an automated green gate, and propose the
improvements that go into the next version — with no human in the loop unless you want
one.

**Investor-forward**
Nearly all AI capital has gone to making individual models better. Almost none has gone
to making many agents work together — the layer that decides whether ten thousand agents
are an asset or a mess. Papercusp is that layer, it works today on models that already
exist, and it proved itself by building itself.
