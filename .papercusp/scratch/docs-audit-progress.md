# operator-docs audit progress

Source of truth = CODE ONLY (repo: /home/marsh-office/papercupai-workspace/papercup).
Auditing every page in apps/operator-docs/src/content/docs/ and fixing in place.

Legend: [ ] todo · [~] in progress · [x] done

## Sections (page counts)
- [x] top-level (4): index, agent-policies, branding, performance
- [x] endpoint-system (15)
- [~] agents (7)
- [~] agent-spawning (8)
- [~] data-sync (7)
- [ ] spec (45)
- [ ] system (5)
- [ ] build-system (7)
- [ ] snapshots (6)
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

### CROSS-CUTTING (flag for human)
- Next.js framing is stale repo-wide; operator is Vite SPA + Hono. Many docs still teach Next idioms.
- Possible code bug: askOperatorViaSse POSTs without modality:'voice' so voice card-forwarding gate may never fire.
