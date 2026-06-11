---
rel_path: "e2e/round2-session4-su0feaf-2026-06-10.md"
updated_at: 1781148693101
_body: "content"
---

# Impersonation E2E round 2 — session 4 report — 2026-06-11 (~03:20–03:35Z) — su-0feaf
Plan: app-impersonation-e2e-round2-2026-06-10 · Items closed: P-005, P-011, P-012. Native MCP recovered this session (the post-deploy 426 cleared on remount).

## P-012 — production-build pass (first ever; the headline numbers)
Rig: dpkg -x Papercusp_0.0.1_amd64.deb (built 2026-06-10 ~20:45) → /tmp, ran usr/bin/papercusp-desktop with fresh HOME/XDG on Xvfb :96 + VirtualGL — NO system install, fully self-contained (embedded PG initdb under the fresh HOME; release picks unused ports — operator :19132, pg :15481 — so the EI-296 shared-attach hazard does NOT apply to release builds).
| Metric | Production (.deb) | Dev-build reference | 
|---|---|---|
| Window appears | 0.52s | ~0.5–1.3s (run #1) |
| TRUE first-run cold start (initdb + 108 migrations → operator listening) | 18.6s | never measured before (iso hono alone was ~13s) |
| Warm boot → operator listening | 2.06s | dev shell boot median 2.8s |
| API TTFB (healthz 5×) | ~2ms median | ~1.5ms staging |
| Inspector auto-open | NO (release) | YES (debug, EI-180) |
UI verified rendering from its own operator (screenshot: VTE + SPA). Tab-settle/SPA-load/INP: N/A-NO-BRIDGE — the dev bridge is #[cfg(debug_assertions)]; future prod perf passes need a release-safe instrumentation path or stay screenshot-based.
FINDINGS → EI-300 (major): two first-boot PG ERRORs on the fresh embedded DB — `harness_shared.voice_relay does not exist` (runtime queries a table the bundled 108-migration set never creates; staging knows 114) and `invalid input syntax for type bigint: "2026-06-10T10:58:51.426Z"`. Non-fatal but real first-run product-path bugs the dev box structurally cannot catch. First-boot log kept: /tmp/e2e-r2-prod.log.

## P-011 — soak harvested
Clean 1.0h idle span on the :94 debug instance (staging :3170): app webview +96MB/hr, the auto-opened inspector's own WebKitWebProcess +314MB/hr — both MONOTONIC with zero user activity. Combined with session-2's nav result (+184MB warm-up over the first 60 navs, then flat), the EI-278 picture: (a) navigation is NOT a leak; (b) idle accumulation is real and inspector-dominant; (c) HONESTLY, pure idle extrapolates to only ~1.3GB webview /14h — far short of EI-278's 16GB webview kill, so the multiplier is likely activity-driven (continuous SSE/new-content allocations re-paying the warm-up cost). Discriminator runs proposed on EI-278 (idle-with-inspector-closed; idle+SSE-churn). The instrumented instance (app 88077, :94) + the 5-min sampler (/tmp/e2e-r2-soak.{sh,tsv}) handed LIVE to EI-278's assignee su-111be; idle-segment cutoff ts 1781148522 (post-cutoff samples include my P-005 probe activity).

## P-005 — §13 pipeline-state rows: all N/A-RETIRED (code-level evidence)
agent-e2e §13 rows [addpl popover], [dept DepartmentHarnessDashboard], [banners PlanReview/Checkpoint/Escalation/Promotion], [phases]: zero matching components in apps/operator-vite/src (the only Checkpoint hits are GitClient — the green-checkpoint admin view). No phase UI exists in the SPA even with harness-phases ON (the flag gates non-UI/legacy surfaces). Modal internals were covered across sessions 1–2 (palette, workspace switcher, notifications, add-harness Esc/scroll-lock). No pipeline-state seeding was needed — the rows test surfaces that no longer exist. EI-301 (improvement) filed: prune/remap the doc-stale §13 rows.

## Issues ledger this session
Filed: EI-300 (prod first-boot PG errors, major), EI-301 (doc-stale §13 rows, improvement). Updated: EI-278 (2 data comments: rates + gap analysis + live-rig handoff).

## Cleanup ledger
Prod rig fully torn down (app/serve/embedded-pg/code-server killed by port-pid, /tmp/e2e-r2-prod* removed except the EI-300 boot log, :96 freed incl. stale X lock). LEFT ALIVE (deliberate, handed off): :94 soak stack + sampler (su-111be's to kill), e2e-imp-sync1 + WI-94 (EI-206 repro), 2 e2e-imp-r2-ttft conversations. Bash gotcha recorded for the next executor: pgrep/pkill patterns matching your own command line kill your own shell (exit 144) — kill by listening-port pid (ss -tlnp) instead.

## Plan state after session 4
DONE 9/16: P-001, P-002, P-004, P-005, P-009, P-010, P-011, P-012, P-014. BLOCKED 3: P-003 (EI-290 steer affordance), P-006 + P-007 (EI-296 iso-rig isolation / EI-297 fault injection). OPEN 4: P-008 (regression sweep — resumes as peer fixes land), P-013 (load-sensitivity, stretch/opportunistic), P-015 + P-016 (rolling per-session). All executable work is done or blocked on external fixes.
