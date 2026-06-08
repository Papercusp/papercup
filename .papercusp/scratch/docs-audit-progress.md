# operator-docs audit progress

Source of truth = CODE ONLY (repo: /home/marsh-office/papercupai-workspace/papercup).
Auditing every page in apps/operator-docs/src/content/docs/ and fixing in place.

Legend: [ ] todo · [~] in progress · [x] done

## Sections (page counts)
- [x] top-level (4): index, agent-policies, branding, performance
- [x] endpoint-system (15)
- [x] agents (7)
- [x] agent-spawning (8)
- [x] data-sync (7)
- [ ] spec (45)
- [~] system (5)
- [~] build-system (7)
- [~] snapshots (7)
- [ ] testing (4)
- [ ] security (2)
- [ ] plugins (1)
- [ ] posthog (2)
- [ ] desktop (3)
- [ ] implementation (6)
- [ ] design (17)
- [ ] reference (5) — CHECK IF GENERATED before hand-editing
- [ ] agent-insights (98)

## Per-page log

### Batch 1 (top-level + endpoint-system) — DONE
Dominant drift: Next.js app/api → Hono endpoint-route routes; apps/operator/lib → packages/operator-core/lib; @restart → @papercusp scope.
- index.mdx: EDITS — "how published" was Fumadocs/apps/papercusp/:3055 → Astro Starlight/apps/operator-docs/:3070//internal/docs; Phase 6b marked shipped. Flag: papercup web app retired.
- branding.mdx: ACCURATE.
- performance.mdx: EDITS — perf guard path apps/operator → packages/operator-core; BASELINE stale (3→1, only A7); flag: pervasive Next.js framing now stale, :3055 testing guidance contradicts policy.
- agent-policies.mdx: EDITS — @restart/grid-core→@papercusp; features:update→flags:set; *-su wrappers→psu; agent-insights path; meta.json→Starlight; broken plan link; section cross-ref off-by-one.
- endpoint-system/overview: EDITS — defineRoute removed (not re-export); mobile:true flag invented → auth:{kind:['device']}, /api/device/*.
- endpoint-system/function-as-truth: EDITS — Next→Hono catchall paths.
- endpoint-system/writing-a-tool: EDITS — built-ins in operator-core/lib/agent-tools (not agent-mcp); defineTool field schema→args.
- endpoint-system/transports: EDITS — Next→Hono paths; reserved events fixed (progress/error NOT reserved; chunk/card ARE); @restart/sse→@papercusp/sse.
- endpoint-system/gating: EDITS — default-deny IS on in Papercusp; paths.
- endpoint-system/telemetry: EDITS — added 7 shipped columns, invalid-input status, parent_spawn_id now populated, scratch URI form.
- endpoint-system/operations: EDITS — paths; removed deleted expert-dispatcher.ts / bin/run.ts.
- endpoint-system/tool-catalog: EDITS — many verb-count/name fixes; delegates/experts/hindsight removed; orchestrator-spawn retired; built-in count ~100→~340.
- endpoint-system/reference: EDITS — file map moved to operator-core; migrations squashed to 000-baseline.
- endpoint-system/state-tools: ACCURATE.
- endpoint-system/ask-user: ACCURATE.
- endpoint-system/spawn-signing: EDITS — paths; ensure-schema/branch-iso retired; client param added; rotation cache-coherence; Vitest tests.
- endpoint-system/superuser-mode: EDITS — *-su→psu; token reused on reinstall; telemetry run_id/window_key fixed; gate-bypass diagram.
- endpoint-system/voice-modality: EDITS — modality default ['text','voice']; ask_choice not text-only; <sleep duration_minutes>; paths. Flag: possible voice-modality bug in askOperatorViaSse.

### Batch 2a (agents/ + agent-spawning first half) — DONE
- agents/index: EDITS — claude_sessions table→delegates; @restart/sync→@papercusp/sync.
- agents/action-registry: EDITS (v5 plan doc, kept framing) — archived plan paths; lib/commands→operator-core/lib/commands.
- agents/docs-retrieval: EDITS (heavy) — fumadocs→Starlight adapters; content paths; Next llms.txt routes→Hono host-docs.ts; operator-core paths.
- agents/finding-context: ACCURATE.
- agents/kickoffs: EDITS — omp --append-system-prompt→psu --launch-context (P-032); operator-core paths; KICKOFF_KIND_ALLOW.
- agents/operator-persona: EDITS — operator-core paths; narration API split; panel-cards RETIRED.
- agents/prompt-assembly: EDITS — operator-core path; injection dir; /internal/docs links.
- agent-spawning/overview: EDITS (heavy) — orchestrator.spawn/poll/list_active/cancel → fleet:spawn/tree/cancel; real source map.
- agent-spawning/lifecycle: EDITS (heaviest) — 4 tools→3 fleet:*; removed in-memory Map narrative; heartbeat/reclaim; KILL_GRACE_MS=2000.
- agent-spawning/schema: EDITS — spawned_agents DDL +10 cols; status +restarting; RLS policy name; URL params +client/exp/HMAC.
- agent-spawning/limits: EDITS — MAX_CONCURRENT=10 → maxSimultaneousAgents(16, ceiling 64); queue+await not caller-retry; output_tail ~2KB.

### Batch 2b (agent-spawning 2nd half + data-sync) — DONE
- agent-spawning/allowlist-and-caps: EDITS (heavy) — removed fictional per-role matrix + 5 spawn_* error codes + MAX_DEPTH/MAX_CHILDREN; real model = new_subagent:request/approve + ceiling 16/64 + queue-await.
- agent-spawning/named-resource-locks: EDITS — dev-server now ENFORCED; full registered-resource table; raw-Bash gate now WIRED (P-026).
- agent-spawning/observability: EDITS — cap-rejects DO write failed row; query filter fix; concurrency number.
- agent-spawning/terminal-wrappers: ACCURATE.
- data-sync/index: EDITS — @restart/*→@papercusp/*; operator-core paths; live consumer paths.
- data-sync/zero: EDITS — args object not array; useSyncQuery returns object not 2-tuple; no-provider graceful.
- data-sync/schema: EDITS — schema-per-harness INVERTED → consolidated tables; papercup_shared table list.
- data-sync/named-queries: EDITS (heavy) — defineQueries namespaced object-arg API; consolidated catalog.
- data-sync/cookbook: EDITS — package names; args object; removed schemaVersion bumps; retired panels re-pathed.
- data-sync/pitfalls: EDITS — RichGrid ctx shape; no schemaVersion; useSyncQuery no-throw; loadProjects gone.
- data-sync/richgrid: EDITS (heavy) — ColumnDef/CellRenderContext signatures; controlled sort; virtualMode; expandedRowKey(s).
NOTE: data-sync section already carries a retirement banner (zero-cache retired); kept it.

### CROSS-CUTTING (flag for human)
- Next.js framing is stale repo-wide; operator is Vite SPA + Hono. Many docs still teach Next idioms.
- Possible code bug: askOperatorViaSse POSTs without modality:'voice' so voice card-forwarding gate may never fire.
