---
title: Papercusp-SU memory: replace PLUR with layered mem0 + coord + insights
slug: papercusp-su-memory-2026-05-25
status: draft
created: 2026-05-25
updated: 2026-05-25
owner: avi@storewolf.com
---

# Papercusp-SU memory: replace PLUR with layered mem0 + coord + insights

## Now

**State:** Draft plan ready for user review. Builds on memory-harness-scope-2026-05-24 (Phases 1-4 shipped 2026-05-24, `5b0e48ee`) which landed harness-scoped mem0 + auto-injection in operator/architect/oracle/delegate prompts. The gap: papercusp-su MCP entry point doesn't get auto-injection, so engineer-collaborator shells operate memory-blind. Adopting mem0 fully (and decommissioning PLUR) consolidates to one memory layer with one source of truth across operator and engineer-collaborator agents. Three-layer split (mem0 / coord / insights) avoids the "everything is memory" conflation that drifted PLUR.

**Next:** User reviews plan; on approval, start P-001 (locate MCP server request handler that owns papercusp-su session creation).

## Background

(Why this plan exists; what problem it addresses.)


(Use plans:add-item to populate. Each item is one line:
single id, status token, free text, optional blocked-by.)


## Phase 1 — mem0 injection for papercusp-su sessions

- **P-001** `todo` Locate MCP server request handler that owns papercusp-su session creation (likely under `packages/agent-mcp/src/`); identify the exact hook point where operator/architect/oracle equivalents call `buildMemoryContextBlock`. Document the difference in entry shape (operator = chat-stream, papercusp-su = MCP tools/list).
- **P-002** `todo` Resolve harness slug at session start. CWD walks up looking for `.harness/` marker; `PAPERCUSP_HARNESS_SLUG` env var overrides. When cwd is the papercup repo itself (resolved via a marker file or known root), slug = `papercup` (D-005). Reject ambiguous resolution rather than pick a default.
- **P-003** `todo` Reuse `buildMemoryContextBlock` (don't fork). Fan-out scope = `[user:<id>, harness:<detected slug>]`. Inject result as a system message in the MCP session prelude; cache for the life of the session (D-006). Each injected memory carries its `memory_id` in the prompt text so persona-rule corrections can target it (depends on P-018).
- **P-004** `todo` Feature-flag the injection (`PAPERCUSP_SU_MEMORY_INJECTION`, default `on` in dev). Gate so a broken inject doesn't take down all papercusp-su shells at once.
- **P-005** `todo` Update `apps/operator/prompts/papercusp-su-engineer.tools.md` (and `-power.tools.md`) with the new persona section: when to call `memory:remember` (project facts, conventions, user preferences) vs when not to (operational state — that's coord's job). Mirror the cognitive split documented in D-002.






## Phase 2 — coord working-memory integration

- **P-006** `todo` Verify `coord:whoami` identity resolution against multi-shell scenario. Today's ownerId scheme would collide if a user runs 10 papercusp-su shells concurrently (real scenario — observed ~10 OMP sessions live during diagnostics). Decide: subordinate ownerId pattern (e.g. `engineer-collaborator-<session-id>`) OR per-session watermark namespace. May need a small coord-side change (D-007).
- **P-007** `todo` Session-start: auto-call `coord:declare-intent { intent: "<role> in <cwd>" }` so peers see us in presence panels. papercusp-su shells currently invisible to coord; this also gives the user UI visibility into how many shells are open and what each is doing.
- **P-008** `todo` Session-start: read backlog via `coord:inbox { since: watermark }`, `coord:plan-events { since: watermark }`, `coord:presence`. Compose into the session-start prelude alongside mem0 and the insights index. If a section's delta is empty, omit the section header (don't pollute with "nothing new").
- **P-009** `todo` Per-turn delta wrapper: re-poll `coord:inbox` + `coord:plan-events` since last-turn watermark; inject only the deltas. Advance watermark via `coord:watermark-set` at turn end. Cheap because watermark pattern returns nothing when nothing happened. Provides "live working memory" without per-turn full-recall cost.
- **P-010** `todo` Persona update in tools.md: "fact about the project" → `memory:remember`; "I'm doing X right now / I just finished Y" → `coord:declare-intent` / `coord:send` / `coord:handoff`. Never confuse the two. Same persona file as P-005.






## Phase 3 — agent-insights index injection

- **P-011** `todo` Check whether Starlight's existing `llms.txt` output already gives us the agent-insights index in usable shape. If yes, reuse. If not, emit a parallel `insights-index.json` at docs build time from `apps/operator-docs/src/content/docs/agent-insights/*.mdx` frontmatter (slug + description).
- **P-012** `todo` Inject the insights index as the third ingredient of the session-start prelude. Format: `- <slug> — <one-sentence description>` per line. Budget: under 2KB at current count (~40-60 entries). Persona note: agents reach for `docs:get` when an index line matches their current task.
- **P-013** `todo` Document the write path: agents discovering non-obvious gotchas write a new insight MDX (not a mem0 memory). Already in the policy doc — surface it in the persona prompt so it's a default-on behavior. Insight lifecycle = PR-reviewed; mem0 lifecycle = silent. Different gates intentional (D-002).




## Phase 4 — write-time hygiene

- **P-014** `done` Anchor extraction at `memory:remember` write time. Regex-extract structural references: file paths (`apps/operator/lib/foo.ts`), feature ids (`F-001`, `F-FIX-024`), function names, plan slugs (`<slug>-<YYYY-MM-DD>`), migration numbers (`081-…sql`). Store as `metadata.anchors[]` JSONB column on the memory row. (shipped at `apps/operator/lib/memory/anchors.ts` + tests; 25/25 pass)
- **P-015** `todo` Write-time anchor validation. If a referenced file doesn't exist, F-NNN is unknown to harness_features, or plan slug doesn't resolve, surface a warning in the tool response. Don't reject — agent may have a reason — but caller sees the diagnostic immediately rather than 30 days later.
- **P-016** `todo` Dedup-on-write. Before insert, semantic-search top-K=3 against the same scope. If similarity >0.90 against an existing memory, refuse with the conflict and suggest merge (return the existing memory_id + delta to consider). Cheap because k=3 over an already-indexed collection.
- **P-017** `todo` Conflict-on-write LLM check. For the top-K neighbors from P-016, run a small Haiku call to detect direct contradiction. If contradicted, return a structured response ("conflicts with #142: <neighbor text>") and require caller to pass `resolve: replace | keep_both | cancel`. Budget ~500 tokens per write event — cheap enough to run always, expensive enough to skip when confidence is high.





## Phase 5 — memory audit (Layers 1 + 2)

- **P-018** `todo` Schema migration: add `last_validated_at`, `last_surfaced_at`, `state` (enum: `active` / `broken_anchor` / `needs_revalidation` / `contradicted`) columns on the memory_canonical table. `metadata.anchors[]` from P-014 lives here too. Backfill: existing rows start `state='active'`, `last_validated_at=created_at`.



- **P-019** `todo` Layer 1 — nightly anchor structural check. Pure shell + PG, no LLM. For each memory with `metadata.anchors[]`: file paths checked via fs.stat, F-NNN against `harness_features`, plan slugs against the plans directory, migration numbers against `pg_migrations` rows. On any miss, set `state='broken_anchor'`. Runs as a systemd timer or cron — schedule TBD with Phase 6's PLUR-cleanup window.



- **P-020** `todo` Layer 2 — correction-driven invalidation. Persona prompt rule: "if a user correction contradicts what an injected memory told you, call `memory:forget` on that memory before continuing." Requires P-003's per-memory `memory_id` tagging. Highest-quality signal in the system and costs zero LLM tokens — human did the audit by correcting.



- **P-021** `todo` Bump `last_surfaced_at` on every injection. Powers Layer 3 (deferred) scoping: "audit memories that were actually used recently." For now, just record the timestamp; the column is cheap.



- **P-022** `todo` Memory settings page UI: per-entry status badge (✓ verified / ⚠ broken anchor / 🔄 needs revalidation / ❌ contradicted). Filter chips: "show only flagged" / "show all". Click-through to the anchor that broke (e.g. "file missing: apps/operator/lib/foo.ts → 404"). This is the user-visible part of the audit.



- **P-023** `todo` "Audit all" button (the user's original ask) — defaults to a smart subset (broken-anchor + needs-revalidation candidates). Optional checkbox "full bank" surfaces a token estimate before running ("≈10M tokens, ~$30"). Wires to Layer 3 (deferred to follow-up plan) but the button + UI ship in v1 with the smart-subset path.


## Phase 6 — PLUR decommission + migration

- **P-024** `todo` Kill remaining PLUR orphan processes; document the canonical kill recipe (the workaround script I used during diagnostics). Investigate root cause: `bun omp -r` spawns `npm exec @plur-ai/mcp` per session and doesn't reap on exit. Decision: don't fix — we're removing PLUR. Just kill the procs and move on.
- **P-025** `todo` Remove PLUR from `~/.claude/mcp.json` and `~/.omp/agent/mcp.json`. Strip the 5 PLUR hooks from `~/.claude/settings.json` (`hook-inject`, `hook-observe`, `hook-correction-detect`, etc.). Stop the homebrew `plur` binary if it's wired as a launchd/systemd service.
- **P-026** `todo` One-shot PLUR → mem0 migration script. Read `~/.plur/engrams.yaml`, present each engram to the user one-at-a-time in a small CLI (accept/edit/skip), round-trip accepted ones via `memory:remember` with derived `kind` and `harness_slug`. Optional second pass: drain `~/.claude/projects/-home-marsh-office/memory/*.md` (the auto-memory bank) into mem0 the same way. Both are curated stores; bulk import would import drift.
- **P-027** `todo` Audit the third memory layer: `.harness/memory/` markdown files driven by `apps/operator/lib/harness-memory-map.ts`. Per-harness MEMORY.md/raw.md/summary.md triple from April 2026. Decide: deprecate (merge into mem0 via P-026), keep for human browsability, or auto-mirror from mem0. Open question — list as a Phase 6 sub-decision.
- **P-028** `todo` Update `apps/operator/scripts/install-standalone-mcp.sh` to no longer mention PLUR in any installed playbook block. Add a stamping convention so future re-installs of the SU prompt source land cleanly in `~/.agents/AGENTS.md` (extension of last session's prompt-restructure work — see also followup memory-restructure task from this conversation).





## Decisions

(Use plans:add-decision to append. Each decision is a third-level
heading with a date line and a body paragraph.)

### D-001 — D-001: adopt mem0 for papercusp-su; deprecate PLUR
Date: 2026-05-25
mem0 v3 (April 2026) leads the field on LongMemEval (94.8 vs PLUR's 86.7) and LoCoMo (91.6). More importantly, mem0 is already shipped in our codebase — yesterday's plan (`memory-harness-scope-2026-05-24`, Phases 1-4 landed `5b0e48ee`) wired harness-scoped writes and pre-turn auto-injection for operator/architect/oracle/delegate. Adopting it for papercusp-su closes the only gap and gives us one source of truth across all agent surfaces.

PLUR's operational cost is significant: every `bun omp -r` spawns a `npm exec @plur-ai/mcp` per session and doesn't reap on exit. During diagnostics today we counted 159 orphan PLUR procs accumulated over days. The npx hooks tax (`hook-observe`, `hook-correction-detect`, etc.) adds startup time to every tool call. Switching to mem0 — which runs in-process against the embedded PG with no subprocess — eliminates this class of problem.

Letta is a full agent framework, not a comparable memory layer. Zep's OSS edition is deprecated. PLUR is a smaller version of what mem0 does. mem0 wins on all three axes (benchmarks, footprint, already-shipped).

### D-002 — Three-layer memory architecture (mem0 / coord / insights), no overlap
Date: 2026-05-25
Memory for papercusp-su agents is split across three layers with non-overlapping responsibilities:

| Layer | Storage | Lifecycle | Read at session-start | Written by |
|---|---|---|---|---|
| **mem0 (semantic memory)** | PG vectors via `CanonicalVectorStore` | Slow-changing, curated facts | Top-K fan-out over `[user:<id>, harness:<slug>]` | `memory:remember` (explicit) or LLM extraction (deferred) |
| **coord (working memory)** | PG via `harness_shared.coord_*` | Live, delta-tracked via watermark | Backlog since last watermark + presence | `coord:declare-intent`, `coord:send`, `coord:handoff` |
| **insights (procedural memory)** | MDX in `apps/operator-docs/src/content/docs/agent-insights/` | Reviewed via PR, durable | Title + description index (not body) | Manually authored MDX, PR-reviewed |

Cognitive analog: semantic / episodic / procedural memory respectively. Conflating any two leads to drift (PLUR conflated semantic + procedural and got noisy engrams).

Persona prompts (P-005, P-010, P-013) enforce the write-side discipline: "fact about the project" → mem0; "what's happening now" → coord; "how to handle X / why X happens" → insight MDX. This is the rule that prevents the layers from leaking into each other.

**Alternatives rejected**:
- Putting insights into mem0: loses PR-review gate, loses long-form bodies (mem0 capped ~2000 chars), loses deep-linkable URLs, blows out prompt budget on auto-inject. Insights stay where they are; we just *index* them in the session prelude.
- Using coord for "stable knowledge": coord is timestamped + delta-tracked + designed for ephemera, wrong shape for "user prefers X" type facts.
- Single-tier "everything is a memory": PLUR's design. Drifted because there's no shape discipline on writes.

### D-003 — Harness slug detection: CWD-walk + env var override
Date: 2026-05-25
Session-start injection (P-001/P-002) needs to know which `harness:<slug>` to fan out to. Resolution order:

1. `PAPERCUSP_HARNESS_SLUG` env var (explicit override) → use that
2. Walk `cwd` upward looking for a `.harness/` directory or `.harness/slug` marker file → use the slug from there
3. Match cwd against known harness worktrees registered in PG (`harness_registry` / `harness_worktrees`) → use that slug
4. If cwd is the Papercusp repo itself (detected by `apps/operator/package.json` + git remote match) → use `harness:papercup` (treat Papercusp as a meta-harness so engineering self-knowledge has a real home)
5. Otherwise → user-scope only (no harness fan-out)

**Alternatives rejected**:
- Pure env-var requirement: too easy to forget; users want zero-config
- MCP session-init handshake (install script writes slug into header): more code, same outcome as cwd-walk for normal cases
- Always fan out to ALL harnesses when in the papercup repo: too noisy; engineering self-knowledge belongs in one slug, not 50

The cwd-walk + env-var combo matches how harness-aware tooling already works (locks:acquire, coord:declare-intent both use the same detection).

### D-004 — Worktree-bleed: accept (Option A) with persona guidance, not branch-scoped memories
Date: 2026-05-25
Concern raised in design: multiple worktrees of the same harness (e.g. `sheets-fork-2`, `sheets-clone--demo`) all resolve to `harness:sheets` and share one memory bucket. Branch-specific facts ("F-001 implements X via Y") could bleed across.

Options considered:
- **A (chosen)**: Accept the flat `harness:<slug>` scope. Persona prompts (P-010) teach: memories should be project *conventions* not branch *state*. Branch-specific live state belongs in coord, not mem0. Write-time hygiene (P-014/P-017) catches the most common accidents (mentions of F-NNN ids, branch names).
- **B**: Add `git_ref` to memory metadata; injection only surfaces memories where ref ∈ `{current_branch, main, null}`. **Rejected**: branches are operational, not knowledge boundaries; merging a branch wouldn't auto-promote memories; "main" becomes a special case; doubles the migration cost of the next harness-sync rework.
- **C**: LLM-side lint at write time rejecting branch-specific facts. **Folded into Phase 4**: the dedup + anchor + conflict-on-write trio in P-014–P-017 already covers this without a new dedicated lint pass.

The deeper insight: coord absorbs the live-state cases that motivated B. Once a paperscusp-su agent can declare intent + read peer presence (P-007/P-008), there's much less pressure to encode branch-specific state in mem0.

**Revisit if**: we see repeated cases of memories generalizing branch-specific facts in v1 — then ship Option B as a follow-up plan.

### D-005 — Injection frequency: mem0 once-per-session, coord per-turn-delta, insights once-per-session
Date: 2026-05-25
Per-layer injection cadence trades off staleness against token cost:

- **mem0 (semantic)**: Once per session-start. Mem0 is slow-changing by design (curated facts); per-turn re-injection wastes tokens. If a memory is written mid-session, next session sees it. Acceptable staleness window.
- **coord (working memory)**: Per-turn delta via watermark (P-009). The watermark pattern makes this nearly free — `coord:inbox { since_ts }` returns empty when nothing changed. Only the deltas are injected, so cost scales with activity, not with bank size.
- **insights (procedural)**: Once per session-start. Index only (titles + 1-line descriptions) — bodies are pulled on-demand via `docs:get`. Index is small (~40-60 lines today), slow-changing.

Watermark advance happens at turn-end via `coord:watermark-set`. If a session crashes without advancing, next session re-reads from the prior watermark — at-least-once delivery, which is correct for an inbox.

**Alternatives rejected**:
- Per-turn mem0 re-inject: costs ~1-2K tokens per turn for negligible freshness gain
- Once-per-session coord: defeats the purpose; agents would miss live handoffs
- Session-start full insight bodies: blows out the prompt; titles + descriptions are enough to know whether to drill in

**Edge case (deferred)**: a memory written *this session* doesn't surface until next session. If this turns out to bite, add a tiny "fresh memory written this session" hook that re-injects only the new entry. Not v1.

### D-006 — coord ownerId scheme — per-shell sub-identity, not shared across concurrent sessions
Date: 2026-05-25
`coord:whoami` today resolves ownerId per-OS-user (one ownerId for all of marsh-office's shells). If a single user runs N concurrent papercusp-su shells (real scenario — observed ~10 OMP sessions live during diagnostics today), they all share one ownerId and one watermark. Shell A advances the watermark; shell B's per-turn delta poll misses everything shell A saw.

**Resolution (P-006)**: each papercusp-su shell session gets a subordinate ownerId of the form `<user>:<session-id>` (or `engineer-collaborator:<pid>:<starttime>`). The base user-ownerId still receives broadcast messages (`to: ["*"]` or `to: ["human"]`), but watermarks are per-session.

This matches how operator-side agents already work — each spawn has its own ownerId derived from spawn-id. Generalizing to shell sessions is the same pattern.

**Alternatives rejected**:
- Single shared watermark across shells: silent message-loss; unacceptable
- Per-shell watermark, shared ownerId: muddles the "who sent this" attribution in coord:inbox responses
- Don't advance watermark on read (only on explicit ack): defeats the watermark optimization; every poll re-reads the full backlog

Implementation requires changes in `packages/agent-mcp/src/coord/*` to plumb session-id through whoami resolution. Sized in P-006.

### D-007 — Memory audit: 4-layer strategy, ship Layers 1+2 in v1, defer 3+4
Date: 2026-05-25
Naive daily-full-LLM-audit estimated ~$30/day at today's ~500-entry bank, scaling linearly. Audit cost should scale with stale signal, not bank size.

**Layer 1 — Structural anchors (P-018/P-019)** — free. Regex-extract file paths / F-NNN ids / plan slugs / migration numbers at write time; nightly shell job checks anchor existence. Catches the most common staleness (renamed file, deprecated feature) with zero LLM cost.

**Layer 2 — Correction-driven invalidation (P-020)** — free. Give agents the `memory_id` of each injected memory. Persona rule: "if user correction contradicts an injected memory, call `memory:forget` on it." The highest-quality audit signal in the system (real human disagreement) costs nothing.

**Layer 3 — Lazy LLM validation (deferred)** — cost scales with usage. Track `last_surfaced_at` (P-021); periodically batch-validate memories that were actually used + are >30 days unvalidated. Haiku-class model, ~250 tokens/memory amortized.

**Layer 4 — Manual "Audit all" button (P-023)** — user-triggered, defaults to broken-anchor + needs-revalidation subset; "Full bank" checkbox surfaces token cost estimate first.

Phase 5 ships Layers 1 + 2 + the schema migration + UI status badges. That solves ~80% of the staleness pain at near-zero cost. Layer 3 + the LLM-validation backend are a separate follow-up plan; Layer 4 button is wired but its "expensive mode" stays disabled until Layer 3 ships.

**Alternatives rejected**:
- User's straw-man (daily full LLM audit): ~$30/day scaling with bank
- TTL-only: requires perfect TTL setting at write time; misses staleness from code-side changes
- No audit at all: rely on persona discipline; we already see drift in PLUR with no audit gate

The decisive insight: the cheapest audit is the one that never has to run (write-time hygiene in Phase 4). Phase 5 audits only what slipped through.

### D-008 — PLUR migration: user-curated triage, not bulk auto-import
Date: 2026-05-25
Today's PLUR bank: ~406 engrams + 241 episodes in `~/.plur/engrams.yaml`. Plus ~80 auto-memory `.md` facts under `~/.claude/projects/-home-marsh-office/memory/`. Plus the three-file MEMORY.md / raw.md / summary.md triples in `.harness/memory/` dirs (legacy, ~April 2026 vintage).

**P-026 migration policy**: one-shot interactive script that walks `~/.plur/engrams.yaml`, presents each to the user with a `[keep / edit / skip]` choice, and round-trips kept ones via `memory:remember` with derived `kind` and `harness_slug` (defaulting via D-003's cwd heuristic — though for a one-shot migration the user can override per-entry).

**Why not bulk auto-import**: PLUR engrams have well-known drift problems (the original reason for this plan). Mass-importing 400+ entries pre-pollutes mem0 with the same staleness. Triage is slow but the input is small (a few hours over a few sessions) and the output is clean.

**Auto-memory `.md` files (`~/.claude/projects/-home-marsh-office/memory/`)**: already higher-quality (manually curated by the auto-memory system). Same triage approach but could be opted into bulk-import if user signs off on a quality spot-check.

**`.harness/memory/` markdown triples (P-027)**: separate decision needed — these are a third memory layer driven by `apps/operator/lib/harness-memory-map.ts`. Options:
- (a) Deprecate: merge into mem0 via P-026's triage flow
- (b) Keep: live alongside mem0 for human-browsability
- (c) Auto-mirror: write-through from mem0 to MDX so humans can see/edit

Marked as **open question** in P-027 — needs the user's call after they see how mem0 + insights surface in practice. Default to (a) since the goal is one source of truth.

**Alternatives rejected**:
- Bulk import all 400+ engrams: re-introduces the noise we're trying to escape
- Drop all PLUR engrams without review: loses real signal (corrections from real sessions)
- Migration before Phase 1 lands: mem0 needs to be the working memory layer first; importing into a system agents can't read yet is pointless

### D-009 — Persona scope: papercusp-su engineer + power playbooks only; operator/oracle/architect unchanged
Date: 2026-05-25
Yesterday's memory-harness-scope plan (`memory-harness-scope-2026-05-24`) already wired persona guidance for operator/oracle/architect/delegate (`operator.persona.md`, `oracle.persona.md` etc.). Those agents already get pre-turn mem0 injection and already follow the "prefer harness_slug" rule.

This plan only touches **engineer-collaborator** persona files:
- `apps/operator/prompts/papercusp-su-engineer.tools.md` (Claude Code / OMP engineer-collaborator)
- `apps/operator/prompts/papercusp-su-power.tools.md` (power-engineer variant)

Changes to those playbooks (P-005, P-010, P-013):
1. Add a "Memory" section: brief explanation of the three layers (mem0/coord/insights) + when each gets surfaced + when to write each
2. Replace the existing "Hindsight" remnants (already scrubbed) with the new memory section's location
3. Add a "Memory hygiene" subsection covering: anchor-on-write, dedup-on-write, correction → forget flow

Operator-side persona files are NOT touched in this plan — they're already correct as of yesterday. Avoiding scope creep keeps the diff reviewable.

**Out of scope for this plan** (separate follow-ups if needed):
- Per-role persona rewrites for non-papercusp-su agents
- Persona changes for plugin-registered agents
- Persona docs at `/internal/docs/agent-policies` (the policy doc is canonical; tools.md just points at it)
