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
- [x] spec (38) — DONE
- [x] system (5)
- [x] build-system (7)
- [x] snapshots (7)
- [x] testing (4)
- [x] security (2)
- [x] plugins (1)
- [x] posthog (2)
- [x] desktop (3)
- [x] implementation (6)
- [x] design (16) — DONE
- [x] reference (5) — DONE (role-registry/blueprint-catalog up-to-date; agent-insights-index regenerated; tool-catalog + plans-index regenerate in FINAL PASS)
- [x] agent-insights (99) — DONE

## ✅ AUDIT COMPLETE (2026-06-08)
All sections audited+corrected vs code. 183 content pages got committed edits (rest verified accurate). Generated refs regenerated (gen:doc-projections, exit 0). Docs rebuilt: 238 pages, 237 md twins, 820 mirror files → apps/operator/public/internal/docs. Build green. git-sync committing to staging.
### Completeness re-check (loop continuation): fleet added 2 pages mid-run, now audited:
- agent-insights/hive-tool-namespace.mdx: CORRECT (no edits) — hive:* tools verified.
- spec/trust-model.mdx: EDIT — completion_ref writer has since landed (stampCompletionRefOnMerge); rest accurate/aspirational. Re-ran insights-index + rebuild for these.
### Section markers (all done): — groups done: 1-4 (pages 1-40). Drift: lib→operator-core, @restart→@papercusp, defineTool→tooldef; obsolete notes (autoloop director-cadence retired, dogfood-substrate gate removed, instrumentation-node boot retired→host-bootstrap, universalDomains rename, classifier 14 not 16). NEXT: groups 5-10 (41-99). [groups 5-6 (41-60) DONE: idempotent-pg-ensure+live-pg-regression-sentinel→superseded notes; cjs-family-trap reversed (ESM); index §18→§19; mobile→device rename; 3070 restart→staging :3170. agent-insights-index regenerated again.] NEXT: 7-10 (61-99). [7-8 (61-80) DONE: phase1b-federation + sleep-mode → superseded banners; path-join/jsonb/route-discriminator/etc operator-core paths; react-icon-map bogus import removed; scope-rename guard name fix.] NEXT: 9-10 (81-99) = FINAL agent-insights batch. [9-10 DONE: substrate-flag-flip/-diagnostic-stack → superseded (gate removed, substrate always boots); starlight-migration + tsc-baseline-vs-next-build → Next-retired Update notes; timestamptz/zero retirement note; many operator-core path fixes.] agent-insights COMPLETE (99).
ALL CONTENT SECTIONS DONE. Remaining: FINAL PASS (regen generated refs + rebuild served mirror).

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

### Batch 3 (system + build-system) — DONE  [throttle note: 2-agent concurrency is sustainable; 3+ trips infra rate limit]
NOTE: real baseline SQL path = libs/papercusp/libs/db/sql/000-baseline.sql (archive/ alongside). Native PG db `papercusp` IS live on :5432 (no _native_backup rename).
- system/storage-policy: EDITS — operator-state-pg import path; expert-dispatcher.ts lockfile→display-allocator.ts; /internal/docs link.
- system/credentials-encryption: EDITS — ENCRYPTED_TABLES 5→6 (+operator_search_provider_credentials); operator-core paths.
- system/lifecycle: EDITS — expanded caution Aside (operator-core paths, harness.ts split into Hono routes dead, per-harness-schema retired); links.
- system/tool-packs: ACCURATE.
- system/blueprint-distribution: EDITS — added blueprint:catalog to source map.
- build-system/index: EDITS — removed false next.config.js/app-dead claims; sidecar is single serve.mjs (not 5); admin 4 sections; operator-core path.
- build-system/architecture: EDITS (heaviest) — retired Next-standalone → SP1-C5 serve.mjs sidecar model; bundle layout; bundled_path_env; discovery files; native PG live.
- build-system/layers: EDITS — operator-core path prefixes.
- build-system/admin-commands: EDITS — operator-core path; SSE shapes; SSH syntax; rebuild-3070 host; packaged-build section.
- build-system/verification: EDITS — port finder ss/next-server→operator.json; flag defaults (snapshots TRUE); FAIL signals.
- build-system/privacy-audit: EDITS — scanner is REGEX phx_/phc_ not 6 literal strings; FLAG_DEFAULTS; .app/sidecar layout.
- build-system/vms: EDITS — pcusp-fedbr0→papercusp-fedbr0; no engines field; bundled_path_env; node v24 runtime. Flag: win10-vm torn down (env, not doc).

### Batch 4 (snapshots + testing + security + plugins) — DONE
- snapshots/*: EDITS — design suite largely SHIPPED; renamed fields command→path, aliases map→array, pluginVersionPinned→versionPin, runAt manual→install; Next paths→Hono routes; added "implemented" Asides. index ACCURATE.
- testing/index: EDITS — llm-testing + registry paths→operator-core; Vitest 3→4; Storybook 8→10.
- testing/agent-e2e: EDITS — removed nonexistent PAPERCUSP_BRIDGE_PORT=9230 (bridge binds ephemeral :0, read token file); Next sidecar→Vite/Hono; .next cache→.vite.
- testing/visual-regression: EDITS — libs/ui-primitives→libs/generic/ui-primitives; refreshed snapshot counts.
- testing/p079-bidirectional-federation: EDITS — operator-core test paths. (very accurate)
- security/distribution-trust: ACCURATE.
- security/shared-harnesses: ACCURATE (proposed-design doc, dated 2026-05-31).
- plugins/branch-buttons: EDITS — Next route handler example→plugin apiRoutes Hono app.

### Batch 5 (posthog + desktop + implementation) — DONE
- posthog/index: EDITS — bootstrap source value; snapshots default true; projectId informational.
- posthog/feature-flags: EDITS (heavy) — flag set 9→12; Next route gating→TanStack requireFlag; operator-core paths; PATCH @current; MCP tools.
- desktop/dev-modes: EDITS — no next.config.js (gone); bin/desktop-dev runs release binary not HMR; dev:hmr is real HMR; papercup-dev-api unit.
- desktop/native-console: EDITS — operator-core paths; orchestrator.spawn→fleet:*; PAPERCUSP_OPERATOR_URL.
- desktop/workbench: ACCURATE.
- implementation/status: DATED — added rename-orientation Aside.
- implementation/orchestrator-port: ACCURATE (already caveated).
- implementation/multi-harness-spawning: DATED — added shipped/moved Aside; config_token retired.
- implementation/marketplace: SUPERSEDED — added Cupboard danger Aside.
- implementation/plugin-marketplace-state-2026-05-11: DATED — Aside; worktree rule reversed→staging-only.
- implementation/pi-integration: EDITS — apps/papercusp→apps/operator + operator-core pty paths; Track A flagged aspirational; desktop shell run cmd.
MORE CODE BUGS TO FLAG: FLAG_LABELS/FLAG_BLURBS in FeaturesAdmin.tsx missing VOICE_CHANNELS (12th flag).

### Batch 6 (spec b1: 10 pages) — DONE
- spec/plan-format: EDITS — +ready status; wave-advance rewritten (P-044 blocked_by edges, no current_wave cursor). Very accurate.
- spec/vocabulary: EDITS — kind values template→plugin/pack/blueprint; planner role removed.
- spec/roles: EDITS (aspirational) — planner=scoper→architect note; §4.1 install shapes flagged not-implemented (blueprints instead).
- spec/capabilities: EDITS — durable record = PG plugin_capability_grants not file; summarizer role cut→curator.
- spec/state: EDITS (aspirational) — per-install-schema consolidated to harness_shared; work_items is a union VIEW not tasks table.
- spec/harness-contract: EDITS — orchestrator→director decision role; DECISION_VERBS; implemented notes.
- spec/orchestrator: EDITS — LLM orchestrator split into orchestrator-loop + director; cron fires system:blueprint-run directly.
- spec/operator-v5: EDITS — operator-core paths; Hono routes; superseded modules; OperatorChat not OperatorPanel.
- spec/operator-architecture-decisions: EDITS — path-drift Aside; rules still hold; operator-core/Hono paths.
- spec/routines: EDITS — routines-workflow DBOS engine; system:* actions; audit.* tables aspirational.

### Batch 7 (spec b2: plugin + spawning/coord clusters, 12) — DONE
- spec/plugins: EDITS — /api/plugins/* prefix; papercusp.json not defineManifest; papercusp/protocol version fields; global-plugins dir.
- spec/plugin-quickstart: VERIFIED CLEAN (agent treated as context — RE-CONFIRM in reference batch).
- spec/plugin-migration: EDITS — runtime version 0.1.0→0.1.1.
- spec/plugin-runtime-roadmap: EDITS — migrations squashed note.
- spec/ui-plugins: EDITS (aspirational) — plugin-sdk path; iframe exports; pi inline-dock; fumadocs /project-docs.
- spec/plugins-marketplace: EDITS — superseded by Cupboard banner; ui:dashboard-tab no-id IS shipped.
- spec/harness-spawning: EDITS — scaffold_harness live; depth guard; token_index not config_token; no SPEC.md write; views not physical tables.
- spec/spawning-harnesses: EDITS — harness:create/blueprint Aside; notifyParentOnDone DBOS drain-based.
- spec/spawnable-templates: EDITS — requires is metadata not enforced; workspace-aware path; blueprint supersession note.
- spec/scaffold-failure-recovery: EDITS — removed SPEC.md case; token_index recovery; PG registry not JSON.
- spec/cross-harness-coordination: EDITS — Aside run.sh→codex + cross_harness:* tools; Tier-3 endpoints verified live.
- spec/workspace-scoping: EDITS — largely shipped Aside; backfill script tsx path.

### Batch 8 (spec b3: identity/distribution + voice/misc, 16) — DONE — spec/ COMPLETE
- spec/auth-and-identity: EDITS — token 3→2 places (config_token retired); rotation IS implemented.
- spec/system-and-pi-principals: EDITS — slug→harness_slug; PG-only bearer; pi caps (no hindsight:recall).
- spec/project-sharing: EDITS — Cupboard content-addressed snapshots not Gitea/Cosign.
- spec/distribution: EDITS — superseded-by-Cupboard banner.
- spec/publishing: ACCURATE (apps/papercusp-publish matches).
- spec/marketplace-versioning: EDITS — Cupboard; Ed25519 attestation not Cosign.
- spec/reference-runtime: EDITS — plugin-sdk/loader paths; webapp→operator-core; marketplace→operator-public.
- spec/voice-mode: EDITS — desktop bus client path.
- spec/voice-mode-v4: EDITS — file map roots; tts-spend + nudgeDedup now PG not json; Hono routes.
- spec/validation-assertion-format: ACCURATE.
- spec/cli-pluggability: ACCURATE (omp default, 3 backends).
- spec/multi-topology: EDITS — init emits per-subproject scaffold not --recursive.
- spec/compared: EDITS — real embedded PG not PGlite.
- spec/why, what-not, open-questions: ACCURATE (philosophy).

### Batch 9 (design feedback docs, 8) — DONE
- design/feature-issue-drawer-feedback: BANNER — peek drawer retired → dockview DetailPanel.
- design/harnesses-page-feedback: NOTE — now RichGrid; +Add harness + empty state shipped.
- design/marketplace-feedback: BANNER — superseded by Cupboard /cupboard ?kind= tabs.
- design/mobile-operator-feedback: BANNER — apps/operator-mobile gone → native papercup-rust-mobile.
- design/operator-panel-feedback: BANNER — OperatorPanel.tsx deleted → OperatorChat.
- design/operator-panel-visual-pass: BANNER — same OperatorPanel retirement.
- design/proposals-tab-feedback: BANNER — /harness→/adv redirect; proposals now SamplePanel stub.
- design/settings-feedback: NOTE — grouping/search/advanced shipped; Orchestrator page removed.
NOTE: design system+plan agent (index,tokens,libraries,gotchas,design-phase-plan,scanner-role-plan,operator-card-lifecycle-plan,delegate-async-plan) hit transient "Not logged in" after 66 tool calls — partial edits left; RE-RUNNING.

### Batch 10 (design system/plan + reference + plugin-quickstart) — DONE
- design/index: EDITS — @papercusp/grid-core; CommandPalette path.
- design/tokens: EDITS — hive not builtin theme (frost/black/honeycomb); pc-custom-themes attribution; +bg-raised tokens.
- design/libraries: ACCURATE.
- design/gotchas: EDITS — Next/Turbopack build section now historical.
- design/scanner-role-plan: EDITS — RETIRED banner D-010/011→D-005/D-009 + migration 167.
- design/operator-card-lifecycle-plan: SUPERSEDED note — OperatorPanel removed, OperatorChat; improvements:capture.
- design/delegate-async-plan: EDITS — implemented note; delegates.list/get ids.
- design/design-phase-plan: EDITS — implementation-status note (shipped; Style Dictionary not Terrazzo).
- reference/tool-catalog: STALE (missing turn:interrupt) → regen `npm run gen:doc-tool-catalog` in final pass.
- reference/role-registry: UP TO DATE (--check passed; 20 roles/38 personas).
- reference/blueprint-catalog: UP TO DATE (16 blueprints).
- reference/plans-index: STALE (high-churn, PG) → regen `npm run gen:doc-plans-index` in final pass.
- reference/agent-insights-index: REGENERATED 98→99.
- spec/plugin-quickstart: ACCURATE (no edits; note: CLI still says "marketplace"/:3057 in code, Cupboard is newer product name — product-naming drift not doc error).

### FINAL PASS TODO (after agent-insights)
1. `npm run gen:doc-tool-catalog` (regen tool-catalog.md) + `npm run gen:doc-plans-index` + `npm run gen:doc-insights-index` (refresh after my edits).
2. `cd apps/operator-docs && npm run build` to rebuild served mirror (apps/operator/public/internal/docs) — docs don't hot-reload.

### CROSS-CUTTING (flag for human)
- Next.js framing is stale repo-wide; operator is Vite SPA + Hono. Many docs still teach Next idioms.
- Possible code bug: askOperatorViaSse POSTs without modality:'voice' so voice card-forwarding gate may never fire.
