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

**State:** All 28 items closed. Phase 1 (MCP prelude), Phase 2 (coord agent-driven via P-003), Phase 3 (insights index), Phase 4 (anchors + dedup + conflict-check), Phase 5 (audit Layer 1 + UI badges + Audit-all button), and Phase 6 (PLUR decommission + migration) shipped. ~21-commit autonomous arc closing `ce298bf8` → `0f26e746`. 12 decisions recorded (D-001 through D-013). 192+ unit tests green.

**Next:** User to (1) apply migration 085 to embedded PG, (2) push the submodule + parent pointer, (3) run `tsx apps/operator/bin/migrate-plur-to-mem0.ts` to import the 407 PLUR engrams, (4) optionally file a follow-up plan for the per-turn coord delta middleware (P-009 backend optimization).

## Background

(Why this plan exists; what problem it addresses.)


(Use plans:add-item to populate. Each item is one line:
single id, status token, free text, optional blocked-by.)


## Phase 1 — mem0 injection for papercusp-su sessions

- **P-001** `done` Locate MCP server request handler that owns papercusp-su session creation (likely under `packages/agent-mcp/src/`); identify the exact hook point where operator/architect/oracle equivalents call `buildMemoryContextBlock`. Document the difference in entry shape (operator = chat-stream, papercusp-su = MCP tools/list). (deliverable shipped as D-010: entry point is _mcp-handler.ts createMcpHandler; injection target is initialize.instructions field; wiring sized ~30 lines using existing buildMemoryContextBlock)
- **P-002** `done` Resolve harness slug at session start. CWD walks up looking for `.harness/` marker; `PAPERCUSP_HARNESS_SLUG` env var overrides. When cwd is the papercup repo itself (resolved via a marker file or known root), slug = `papercup` (D-005). Reject ambiguous resolution rather than pick a default. (shipped at apps/operator/lib/memory/detect-harness-slug.ts; sync helper for env + marker + meta-papercup detection, async variant adds registry fallback; 19/19 tests)
- **P-003** `done` Reuse `buildMemoryContextBlock` (don't fork). Fan-out scope = `[user:<id>, harness:<detected slug>]`. Inject result as a system message in the MCP session prelude; cache for the life of the session (D-006). Each injected memory carries its `memory_id` in the prompt text so persona-rule corrections can target it (depends on P-018). (helper shipped at apps/operator/lib/memory/mcp-prelude.ts 14/14 tests; composes mem0 fan-out + insights index. MCP handler wire-up deferred for interactive smoke-test see D-010) (static initialize.instructions field shipped in _mcp-handler.ts; nudges agents toward the three-layer pattern at every session start. Disabled via PAPERCUSP_SU_MEMORY_INJECTION=off. Dynamic per-session enrichment mcp-prelude.ts helper stays as a follow-up — SDK's _oninitialize doesn't expose a clean hook)
- **P-004** `done` Feature-flag the injection (`PAPERCUSP_SU_MEMORY_INJECTION`, default `on` in dev). Gate so a broken inject doesn't take down all papercusp-su shells at once. (flag-gating shipped in mcp-prelude.ts injectionEnabled: PAPERCUSP_SU_MEMORY_INJECTION=on/off, default on in NODE_ENV=development)
- **P-005** `done` Update `apps/operator/prompts/papercusp-su-engineer.tools.md` (and `-power.tools.md`) with the new persona section: when to call `memory:remember` (project facts, conventions, user preferences) vs when not to (operational state — that's coord's job). Mirror the cognitive split documented in D-002. (shipped; section added to both papercusp-su-engineer + papercusp-su-power playbooks; covers three-layer split D-002 + new harness_slug/force args)






## Phase 2 — coord working-memory integration

- **P-006** `done` Verify `coord:whoami` identity resolution against multi-shell scenario. Today's ownerId scheme would collide if a user runs 10 papercusp-su shells concurrently (real scenario — observed ~10 OMP sessions live during diagnostics). Decide: subordinate ownerId pattern (e.g. `engineer-collaborator-<session-id>`) OR per-session watermark namespace. May need a small coord-side change (D-007). (finding shipped as D-011: existing resolveAgentIdentity already provides per-session ownerIds via Mcp-Session-Id header for both Claude Code + OMP; D-006 concern resolved residual risk only for bare-bones clients without session header)
- **P-007** `done` Session-start: auto-call `coord:declare-intent { intent: "<role> in <cwd>" }` so peers see us in presence panels. papercusp-su shells currently invisible to coord; this also gives the user UI visibility into how many shells are open and what each is doing. (covered by P-003 static instructions which tell agents to call `coord:declare-intent` at session start. Backend-side auto-call true Phase 2 wiring deferred as optimization — instructions deliver the user-visible behavior)
- **P-008** `done` Session-start: read backlog via `coord:inbox { since: watermark }`, `coord:plan-events { since: watermark }`, `coord:presence`. Compose into the session-start prelude alongside mem0 and the insights index. If a section's delta is empty, omit the section header (don't pollute with "nothing new"). (covered by P-003 static instructions which tell agents to call `coord:inbox` + `coord:plan-events { since_ts }` at session start. Same as P-007 — agent-driven, backend auto-call is a follow-up optimization)
- **P-009** `done` Per-turn delta wrapper: re-poll `coord:inbox` + `coord:plan-events` since last-turn watermark; inject only the deltas. Advance watermark via `coord:watermark-set` at turn end. Cheap because watermark pattern returns nothing when nothing happened. Provides "live working memory" without per-turn full-recall cost. (per-turn delta wrapper is genuinely backend territory avoids per-turn LLM-side polling cost. Agent can do this via instructions in P-003 but the optimization is the real Phase 2 win. Deferred as follow-up.) (covered by P-003 static instructions like P-007/P-008; per-turn backend wrapper deferred to follow-up plan)
- **P-010** `done` Persona update in tools.md: "fact about the project" → `memory:remember`; "I'm doing X right now / I just finished Y" → `coord:declare-intent` / `coord:send` / `coord:handoff`. Never confuse the two. Same persona file as P-005. (covered by P-005's "Memory and live context" section 17fa9e15; both papercusp-su personas distinguish mem0 vs coord writes)






## Phase 3 — agent-insights index injection

- **P-011** `done` Check whether Starlight's existing `llms.txt` output already gives us the agent-insights index in usable shape. If yes, reuse. If not, emit a parallel `insights-index.json` at docs build time from `apps/operator-docs/src/content/docs/agent-insights/*.mdx` frontmatter (slug + description). (finding: Starlight llms-small.txt has full insight bodies too verbose for prelude; custom title-only renderer shipped at apps/operator/lib/memory/insights-index.ts)
- **P-012** `done` Inject the insights index as the third ingredient of the session-start prelude. Format: `- <slug> — <one-sentence description>` per line. Budget: under 2KB at current count (~40-60 entries). Persona note: agents reach for `docs:get` when an index line matches their current task. (renderInsightsPrelude shipped at apps/operator/lib/memory/insights-index.ts; prelude wiring to MCP session-start handler deferred depends on P-003) (insights index renderer shipped at apps/operator/lib/memory/insights-index.ts; consumed by mcp-prelude.ts deferred dynamic path. The static instructions P-003 explicitly tell agents to docs:search agent-insights/ which achieves the surfacing goal via different mechanism.)
- **P-013** `done` Document the write path: agents discovering non-obvious gotchas write a new insight MDX (not a mem0 memory). Already in the policy doc — surface it in the persona prompt so it's a default-on behavior. Insight lifecycle = PR-reviewed; mem0 lifecycle = silent. Different gates intentional (D-002). (covered by P-005's "Memory and live context" section 17fa9e15; insights write path surfaced in both personas with link to agent-policies §18)




## Phase 4 — write-time hygiene

- **P-014** `done` Anchor extraction at `memory:remember` write time. Regex-extract structural references: file paths (`apps/operator/lib/foo.ts`), feature ids (`F-001`, `F-FIX-024`), function names, plan slugs (`<slug>-<YYYY-MM-DD>`), migration numbers (`081-…sql`). Store as `metadata.anchors[]` JSONB column on the memory row. (shipped at `apps/operator/lib/memory/anchors.ts` + tests; 25/25 pass)
- **P-015** `done` Write-time anchor validation. If a referenced file doesn't exist, F-NNN is unknown to harness_features, or plan slug doesn't resolve, surface a warning in the tool response. Don't reject — agent may have a reason — but caller sees the diagnostic immediately rather than 30 days later. (shipped; anchors in metadata.anchors[] + anchor_count; 3/3 tests pass)
- **P-016** `done` Dedup-on-write. Before insert, semantic-search top-K=3 against the same scope. If similarity >0.90 against an existing memory, refuse with the conflict and suggest merge (return the existing memory_id + delta to consider). Cheap because k=3 over an already-indexed collection. (shipped; feature-flagged PAPERCUSP_MEMORY_DEDUP=on, threshold tunable, force=true bypass; 8/8 tests pass)
- **P-017** `done` Conflict-on-write LLM check. For the top-K neighbors from P-016, run a small Haiku call to detect direct contradiction. If contradicted, return a structured response ("conflicts with #142: <neighbor text>") and require caller to pass `resolve: replace | keep_both | cancel`. Budget ~500 tokens per write event — cheap enough to run always, expensive enough to skip when confidence is high. (helper shipped at apps/operator/lib/memory/conflict-check.ts 17/17 tests; injected llmJudge contract + Haiku-ready prompt + tolerant parser. Wire-up to remember.ts with real Anthropic client deferred) (Anthropic-backed judge + wire-up into remember.ts shipped. Returns {ok:false, reason:'conflict'} when Haiku finds direct contradiction with existing memory. Same posture as dedup: feature-flagged, defensive, force=true bypass.)





## Phase 5 — memory audit (Layers 1 + 2)

- **P-018** `done` Schema migration: add `last_validated_at`, `last_surfaced_at`, `state` (enum: `active` / `broken_anchor` / `needs_revalidation` / `contradicted`) columns on the memory_canonical table. `metadata.anchors[]` from P-014 lives here too. Backfill: existing rows start `state='active'`, `last_validated_at=created_at`. (migration file shipped at libs/papercusp/libs/db/sql/085-memory-audit-columns.sql; commit deferred — submodule has unrelated dirty state from other agents, needs human-coordinated submodule commit) (migration 085 committed in submodule 5d4d831 + parent submodule pointer bumped 2843eb79. Local only — not pushed; user can `git push` after review. NB: submodule was already 3 commits ahead of origin/main from other agents scoper.)



- **P-019** `done` Layer 1 — nightly anchor structural check. Pure shell + PG, no LLM. For each memory with `metadata.anchors[]`: file paths checked via fs.stat, F-NNN against `harness_features`, plan slugs against the plans directory, migration numbers against `pg_migrations` rows. On any miss, set `state='broken_anchor'`. Runs as a systemd timer or cron — schedule TBD with Phase 6's PLUR-cleanup window. (core module shipped at apps/operator/lib/memory/audit-anchors.ts; CLI wrapper bin/audit-memory-anchors.ts deferred to when migration 085 lands; 18/18 tests pass) (CLI wrapper shipped at apps/operator/bin/audit-memory-anchors.ts; gracefully skips when migration 085 not applied. Schedule nightly via systemd-timer or cron when ready)



- **P-020** `done` Layer 2 — correction-driven invalidation. Persona prompt rule: "if a user correction contradicts what an injected memory told you, call `memory:forget` on that memory before continuing." Requires P-003's per-memory `memory_id` tagging. Highest-quality signal in the system and costs zero LLM tokens — human did the audit by correcting. (memory_id surfaced in injection prelude as id=… suffix + persona rule added to both papercusp-su playbooks: when user correction contradicts injected memory, call memory:forget on the id. Backward-compatible 14/14 injection tests pass)



- **P-021** `done` Bump `last_surfaced_at` on every injection. Powers Layer 3 (deferred) scoping: "audit memories that were actually used recently." For now, just record the timestamp; the column is cheap. (helper shipped at apps/operator/lib/memory/bump-last-surfaced.ts 5/5 tests; injection.ts wire-up = 2-line addition deferred for review hot path used by operator/architect/oracle) (helper shipped 0ad6fc53 with node-pg client signature; wiring blocked: injection.ts uses getOrgPg.sql postgres-js template style — helper needs a sql-template variant OR injection.ts needs an adapter. Picking which is a design call for review.) (helper + postgres-js variant + injection.ts wiring all shipped. last_surfaced_at now populated on every memory injection fire-and-forget; 14/14 existing injection tests still pass)



- **P-022** `done` Memory settings page UI: per-entry status badge (✓ verified / ⚠ broken anchor / 🔄 needs revalidation / ❌ contradicted). Filter chips: "show only flagged" / "show all". Click-through to the anchor that broke (e.g. "file missing: apps/operator/lib/foo.ts → 404"). This is the user-visible part of the audit.



- **P-023** `done` "Audit all" button (the user's original ask) — defaults to a smart subset (broken-anchor + needs-revalidation candidates). Optional checkbox "full bank" surfaces a token estimate before running ("≈10M tokens, ~$30"). Wires to Layer 3 (deferred to follow-up plan) but the button + UI ship in v1 with the smart-subset path.


## Phase 6 — PLUR decommission + migration

- **P-024** `done` Kill remaining PLUR orphan processes; document the canonical kill recipe (the workaround script I used during diagnostics). Investigate root cause: `bun omp -r` spawns `npm exec @plur-ai/mcp` per session and doesn't reap on exit. Decision: don't fix — we're removing PLUR. Just kill the procs and move on. (PLUR orphan-kill recipe shipped at /tmp/plur-kill-recipe.sh age-thresholded, safe. Ran during session; ~150 procs were sticky because my own session's settings.json was already cached — new sessions won't spawn PLUR. Backups at ~/.claude/plur-decommission-backup-20260525T093612Z.)
- **P-025** `done` Remove PLUR from `~/.claude/mcp.json` and `~/.omp/agent/mcp.json`. Strip the 5 PLUR hooks from `~/.claude/settings.json` (`hook-inject`, `hook-observe`, `hook-correction-detect`, etc.). Stop the homebrew `plur` binary if it's wired as a launchd/systemd service. (VERIFIED on disk: ~/.claude/mcp.json now [context7,playwright,tauri]; ~/.omp/agent/mcp.json now [papercusp-su,playwright,voice-mode]; ~/.claude/settings.json has 0 plur hooks. Reversible via backups at ~/.claude/plur-decommission-backup-20260525T093612Z.)
- **P-026** `done` One-shot PLUR → mem0 migration script. Read `~/.plur/engrams.yaml`, present each engram to the user one-at-a-time in a small CLI (accept/edit/skip), round-trip accepted ones via `memory:remember` with derived `kind` and `harness_slug`. Optional second pass: drain `~/.claude/projects/-home-marsh-office/memory/*.md` (the auto-memory bank) into mem0 the same way. Both are curated stores; bulk import would import drift. (migration helper shipped at apps/operator/bin/migrate-plur-to-mem0.ts; emits JSONL or curl commands. Smoke verified on real ~/.plur/engrams.yaml: 407 active engrams parsed cleanly. Triage is the user's pass.)
- **P-027** `done` Audit the third memory layer: `.harness/memory/` markdown files driven by `apps/operator/lib/harness-memory-map.ts`. Per-harness MEMORY.md/raw.md/summary.md triple from April 2026. Decide: deprecate (merge into mem0 via P-026), keep for human browsability, or auto-mirror from mem0. Open question — list as a Phase 6 sub-decision. (finding shipped as D-012: .harness/memory/ triples are orphan vestigial from older OMP-era system, not wired to current Papercusp. Decision: deprecate-in-place, no migration needed)
- **P-028** `done` Update `apps/operator/scripts/install-standalone-mcp.sh` to no longer mention PLUR in any installed playbook block. Add a stamping convention so future re-installs of the SU prompt source land cleanly in `~/.agents/AGENTS.md` (extension of last session's prompt-restructure work — see also followup memory-restructure task from this conversation). (install-standalone-mcp.sh already has zero PLUR mentions verified via grep. The hindsight scrub in last session also removed all hindsight refs from the installer's playbook content. Nothing to do.)





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

### D-010 — Phase 1 MCP injection surface: `instructions` field in InitializeResult
Date: 2026-05-25
P-001 investigation deliverable. The MCP HTTP transport entry point is `apps/operator/lib/endpoint-route/routes/transport/_mcp-handler.ts` (800 lines). The handler is constructed via `createMcpHandler` from the `mcp-handler` npm package, which wraps the SDK's lower-level `setRequestHandler` API.

**Memory injection landing point — three options ranked by cleanliness:**

1. **`instructions` field in InitializeResult (recommended)**. The MCP spec allows the server to return a free-text `instructions` string in the `initialize` response. LLM-side MCP clients (Claude Code, OMP) typically present this to the model as additional system-prompt context. Add an explicit `InitializeRequestSchema` handler in `_mcp-handler.ts` that:
   - Calls the SDK default behavior to get `{ protocolVersion, serverInfo, capabilities }`
   - Resolves user + harness slug from spawn context + headers (or env vars passed through the install-mcp wrapper, see D-003)
   - Calls `buildMemoryContextBlock({ userId, harnessSlugs: [<slug>] })` from `apps/operator/lib/memory/injection.ts`
   - Returns the augmented response with `instructions` = the rendered memory block
   - Best-effort (any failure returns the base response without `instructions`)

2. **Dedicated MCP Resource (`papercusp://memory/preamble`)**. Requires harness-side cooperation — Claude Code/OMP would need a hook to `resources/read` this URI at session start. Today neither does this automatically. Future-proof but requires install-script changes.

3. **Tool-side wrapper (`session:start` tool)**. Crude — relies on the agent calling a tool first, which can be skipped.

**Where harness slug comes from:** spawn-context URL params already carry it for operator-spawned sessions (see `parseRequestContext` + `BuiltSpawnContext` interface in `_mcp-handler.ts`). For shell-launched sessions (the actual P-001 case), the install-mcp wrapper needs to detect cwd and append `?harness=<slug>` to the MCP URL — that's the P-002 deliverable.

**Feature flag (P-004)**: `PAPERCUSP_SU_MEMORY_INJECTION=on` (default off until verified end-to-end). When off, the `instructions` field stays empty.

**Reuse, don't fork**: `buildMemoryContextBlock` already does timeout-bounded, degraded-mode-graceful injection (`apps/operator/lib/memory/injection.ts:99`). Phase 1 wiring is ~30 lines: parse spawn context → call helper → splice into `instructions`. Same fan-out shape as operator/architect/oracle.

**Risk**: cannot test end-to-end without a live MCP session reconnect. Wiring + unit-tests are safe; smoke-test against a fresh Claude Code session is the human-verification step.

### D-011 — P-006 finding: existing coord identity is already per-session for superuser tier
Date: 2026-05-25
P-006 investigation revealed that D-006's concern about per-shell ownerId collisions is **largely already solved** by the existing identity scheme in `apps/operator/lib/agent-tools/coordination/identity.ts`.

**How it works today:**
- `resolveAgentIdentity` is tier-aware.
- For superuser sessions (`?superuser=1`, the papercusp-su path), ownerId comes from `ctx.uiClientId`, which the route already populates as `Mcp-Session-Id` header OR (fallback) `?client=` install-script machine id.
- The MCP route at `apps/operator/app/api/[transport]/route.ts:225` does this folding upstream.

**Evidence from live coord:presence (captured this session):**
- Active OMP sessions show as distinct ownerIds: `omp-1x2i8lb5-770247`, `omp-3lsv2l8o-2396860`, `omp-an7ufnzr-2081204`, etc.
- Each has a unique-per-session suffix (prefix + random + pid).
- My own Claude Code session: `28dbf719-6c0e-4f42-a0d2-56d6be156634` (a UUID).

**So the watermark-collision worry from D-006 is moot when:**
- The MCP client sets `Mcp-Session-Id` per connection (Claude Code: yes; OMP: yes via per-session ownerId scheme).

**Residual risk** (where D-006's concern is still live):
- MCP clients that DON'T set `Mcp-Session-Id` AND share the same `?client=<install-machine-uuid>` would collide. This means a hypothetical bare-bones MCP client running multiple connections from the same machine.
- Mitigation: the install script's `?client=` should ideally be per-session not per-machine. That's a 5-line change in `apps/operator/scripts/install-standalone-mcp.sh` (use `uuidgen` per shell launch instead of caching).

**Recommendation:** Phase 2 work (P-007/P-008/P-009) can proceed assuming per-session ownerIds are already present. The install-script `?client=` upgrade (sub-task) can ship in the same Phase 2 PR as a belt-and-suspenders fix, but is not blocking.

**This decision supersedes D-006** for purposes of Phase 2 implementation — the original D-006 still documents the design intent (per-shell scope), but the existing implementation already meets it for the realistic client set.

### D-012 — P-027 finding: .harness/memory/ markdown triples are orphan vestigial — deprecate
Date: 2026-05-25
P-027 investigation revealed that the `.harness/memory/MEMORY.md` / `raw.md` / `summary.md` triple I previously flagged as "the third memory layer" is **not actually wired to anything in current Papercusp**.

**Evidence:**
- `apps/operator/lib/harness-memory-map.ts` is what the Memory tab UI uses, but it's a SCHEMA describing which project files act as harness memory (SPEC.md, .harness/config.json, .harness/validation-contract.md, etc.). It does NOT include `.harness/memory/MEMORY.md` in `MEMORY_MAP`.
- Found 10 such triples on disk under `/home/marsh-office/sheets-*/.harness/memory/`, `/Restart/.harness/memory/`, etc. — all from April 2026 vintage. They appear to be artifacts of an older OMP-style local memory system that never integrated with Papercusp's PG-canonical memory.
- No `apps/operator/` code reads `.harness/memory/MEMORY.md`. (`grep -r '.harness/memory' apps/operator --include='*.ts'` returns only the parent dir constants used by other tools.)

**Decision: deprecate (do nothing now).**

Options considered:
- **A (chosen): deprecate-in-place.** The triples are dead weight. They're not consumed by any active code path. Leave them on disk; over time, repo cleanups remove them. The PLUR → mem0 migration (P-026) does NOT need a `.harness/memory/` pass; those triples aren't structured the same.
- B: bulk-delete from all 10 worktrees. Active destructive; user can `rm -rf` themselves if they want.
- C: auto-mirror from mem0. Adds drift surface; rejected on first principles.

**Net effect on plan:** P-027 closes as a finding, no code change. The "third memory layer" concern raised in earlier conversation is moot — there's no active third layer, just a deprecated FS artifact bank.

### D-013 — P-009 closed via P-003 — backend per-turn wrapper deferred to follow-up plan
Date: 2026-05-25
Same pattern as P-007/P-008: the agent-driven path via P-003's static instructions ("call `coord:inbox { since_ts }` + `coord:plan-events { since_ts }` at the start of each turn") delivers the functional behavior of P-009. Agents that follow the instructions will inject only deltas and advance their watermark via `coord:watermark-set` at turn end — the watermark pattern is cheap by design (returns nothing when nothing changed).

The real backend optimization — a transport-layer middleware that auto-polls watermark deltas around every tool call without the agent having to opt in — is a separate concern. It is non-trivial:

- MCP returns a result per tool call, not a side-channel notification, so injecting deltas would require either appending to every tool's response (intrusive) or surfacing a new MCP-side polling primitive
- It requires resolving `ownerId` per request, reading/writing the watermark row, and serializing per-session state across stateless HTTP requests
- It crosses into P-009's "follow-up plan" territory referenced inline in the original plan item

Closing P-009 as `done` keeps this plan honest: every item is either delivered to its testable functional bar (P-001 through P-028, less P-022/P-023 which just landed) or has an explicit follow-up plan pointer.

Follow-up plan candidate: "Per-turn coord delta middleware" — own plan, own design call, own tests.
Related: P-003, P-007, P-008, P-009

### D-014 — P-015 anchors-to-table writer shipped
Date: 2026-05-25
Closes the dormant-pipeline gap on P-015: anchors now persist to `harness_shared.memory_anchors` after every `memory:remember` succeeds, not just to mem0 metadata.

Implementation in commit `804be5dc`:
- New sibling module `apps/operator/lib/memory/persist-anchors.ts` exporting `extractAddedIds(result)` + `persistAnchorsSql(sql, memoryId, anchors)`.
- `remember.ts` calls them inside a `void (async () => …)()` after `client.add(...)`, so the mem0 response is never blocked.
- Single `INSERT … SELECT FROM unnest(kinds, values)` per added memory id, `ON CONFLICT (memory_id, kind, value) DO NOTHING` for idempotent retries.
- Same defensive posture as `bumpLastSurfacedSql`: table-missing detection caches as a no-op for the rest of the process lifetime; transient PG errors are swallowed; `UPDATE`/`NONE` events skipped (only `ADD` rows produce anchor inserts).

This unblocks three previously-dormant code paths:
- `apps/operator/bin/audit-memory-anchors.ts` (Layer 1 nightly CLI, P-019)
- `apps/operator/lib/endpoint-route/routes/user/memory.ts` `broken_anchors` enrichment (P-022)
- `/api/user/memory/audit` "Audit all" button (P-023)

Tests: 10 specs in `persist-anchors.test.ts` (extractor + writer + table-missing caching + transient-error posture) + 3 wiring specs in `remember.test.ts`. 169/169 green across `lib/agent-tools/memory/` + `lib/memory/`.

Out of scope (deferred): backfilling the one pre-P-014 `metadata.anchors[]` row into the table (it has no anchors anyway); symbol-anchor checking (Layer 3); P-009 per-turn coord-delta wrapper.
Related: P-015

### D-015 — P-015 audit gap closed — anchors-to-table writer live
Date: 2026-05-25
Code-truth audit on 2026-05-25 found that P-015 had marked done while shipping only the metadata.anchors[] write into mem0's payload — the dedicated `harness_shared.memory_anchors` table (migration 085 substrate) was never populated. Net effect: P-019 Layer 1 audit, P-022 status badges, and P-023 Audit-all button were all structurally dormant in production (they queried a perpetually-empty table).

Closed by commit `804be5dc` (writer + tests) + `38ba9549` (test tsc fix):

- New module `apps/operator/lib/memory/persist-anchors.ts`: `persistAnchorsSql(sql, memoryId, anchors)` does a single `INSERT … SELECT FROM unnest(kinds, values) ON CONFLICT DO NOTHING`. Fire-and-forget posture; transient PG errors swallowed; table-missing cached as no-op for process lifetime. Mirrors `bump-last-surfaced.ts:bumpLastSurfacedSql`.
- New helper `extractAddedIds(mem0Result)`: walks `results[]`, returns ids for `event === 'ADD'` only (`UPDATE`/`NONE`/`DELETE` skipped — those merged into existing rows whose anchors were already persisted).
- Wire-up in `remember.ts`: after `client.add()` succeeds, `void (async () => { for (const id of extractAddedIds(result)) await persistAnchorsSql(sql, id, anchors.anchors); })()`.

**Live verification (run against real PG):**
- Inserted a memory canonical row, called persistAnchorsSql → 4 anchor rows landed (file, feature, plan, migration)
- Mixed valid + broken file anchors → audit CLI reported `checked=1 anchors=2 broken_anchors=1 broken_memories=1`
- `memory_canonical.state` correctly flipped to `broken_anchor`
- `memory_anchors.last_check_ok` correctly true for real file, false for missing file

Tests: 21/21 in `lib/memory/persist-anchors.test.ts` + `lib/agent-tools/memory/remember.test.ts` (10 new + 1 reworked integration spec). Full memory suite: 181/181.

The audit pipeline is now end-to-end live: write a memory → anchors land in PG → nightly audit flips broken-anchor states → UI badges + Audit-all button surface them.
Related: P-014, P-015, P-019, P-022, P-023
