---
rel_path: "e2e/round2-session6-su6c28e-2026-06-11.md"
updated_at: 1781166697709
_body: "content"
---

# Impersonation E2E round 2 — session 6 (final) — su-6c28e — 2026-06-11 ~06:40–08:45Z

Plan: app-impersonation-e2e-round2-2026-06-10 (successor session to su-1f2b6's overnight s5). Targets: green :3070 (EI-259 retest), staging :3170 via own Tauri :95 (UI legs), hand-built TRUE iso stack :3272 + fault proxy :3273 (P-006/P-007). Staging tree at session start: b5add6863. LLM spend: 2 calls / 10¢ (EI-259 smoke turns). Console allowlist: EMPTY held (0 app-level errors in all driven sessions).

## Coverage (this session)

| Leg | Verdict | Evidence |
|---|---|---|
| EI-259 retest (P-003 leg / P-008) | PASS | Chat turn on e2e-imp-sync1 via green :3070 → spawned_agents row `agent_chats-daab06d2-…` per turn (2 turns, 2 rows, done + output_tail). spawn_tree leg N/A-NO-TOOLS (view reads tool telemetry; chat surface has no MCP tools). Comment on EI-259. |
| EI-215 fix + verify (P-008) | FIXED→RESOLVED | NEW shared CupboardErrorState (friendly copy + inline Retry, raw error muted) wired into listings/tools/detail; dead `error.includes('fetch')` friendly-branch bug removed. 4 new tests; cupboard suite 34/34. Live: /cupboard/999999 renders friendly 404 + Retry; Retry refetches; happy path 17 listings intact. |
| EI-239 fix + verify (P-007/P-008) | FIXED→RESOLVED | (a) @papercusp/sync connectivity store (network-level-only, 2-strike flip) + OfflineIndicator persistent toast in __root; (b) Rust connect_load_failed → bundled reconnecting page polling 1/s, all 3 window paths incl. production. Live socat rig: toast on, auto-dismiss on recovery, dead-origin reload → recovery page → auto-return ~2s. Unit test caught a real </script> injection in the page generator (fixed via < escaping). cargo 158/158. |
| EI-296 fix + verify | FIXED→RESOLVED | PAPERCUSP_DEV_API_TARGET env escape hatch (never persisted) + the deeper IPC-singleton leak fix (custom ports no longer inherit endpoint-ipc.json — first live round proved /api silently hit a LIVE operator while the custom target was dead). Live: pinned :3271, kill target → /api REJECTS. |
| P-006 cupboard Fork | PASS | TRUE iso stack (own PG e2e_r3_iso, 117 migrations, own HOME, hono :3272): UI Fork click → "Blueprint vote installed v0.1.0" toast @2s, clone in iso HOME only. FINDING: first attempt leaked to shared workspace storage via inherited PAPERCUSP_HOME (stray removed, recipe amendment on EI-296). Publishing Save/Rotate/Reset-cache remain N/A-NO-CREDS (s3). |
| P-007 settings-500 | PASS | Fault proxy :3273 injected 500 on POST /api/profile → graceful "save failed: HTTP 500" toast, no crash, form data kept; cleared → "Profile saved", API read-back shows iso persistence; shared DB 0 matching rows. |
| P-013 load-sensitivity | DONE | 90-min sampler, load1 9.5–48.6: medians load-insensitive (≤0.2ms shift), tails load-dominated (p90 up to 25×). Grading rule artifact: papercup:e2e/perf-load-sensitivity-2026-06-11.md |

## Repo changes landed (staging; git-sync sweeps; reach green via pipeline)
- apps/operator/app/cupboard/CupboardErrorState.tsx (+test, 3 call sites) — EI-215
- libs/generic/sync: connectivity.ts (+6 tests), batch-fetcher + SSEAdapter reporting, index exports — EI-239; sync lib 93/93
- apps/operator-vite: OfflineIndicator.tsx mounted in __root.tsx — EI-239
- papercusp-desktop/src-tauri: install_load_failure_recovery + recovery_page_html (+2 tests) in main.rs; PAPERCUSP_DEV_API_TARGET + IPC-singleton strictness in dev_wrapper.rs/main.rs (+2 tests) — EI-239/EI-296; cargo 158/158
- packages/operator-core: hive:create_from_repo guidance trimmed to the 1200-char budget (peer's tool was red at HEAD); agent-chats stream test made load-robust (20s drain / 45s budget — passed isolated, flaked twice under suite load)
- Gates: npm run test:affected GREEN (1121 files); tools-md-sync 46/46.

## Cleanup ledger (P-016)
- Fixtures DELETED per the EI-206+EI-229-both-closed condition: harness e2e-imp-sync1 removed from the :3170 registry (DELETE /api/harness/projects → ok, list confirms gone; WI-94 was already state=deprecated and rides the registry removal), /tmp/e2e-imp-su026d2 removed.
- Iso rig torn down: hono :3272 + fault proxy :3273 + socat :3271 killed; DB e2e_r3_iso DROPPED; iso HOME deleted; ports 3271/3272 verified free.
- Display rig: Tauri instances (3 generations) + Xvfb :95 + openbox killed; 4 bridge token files removed; :95 verified free.
- P-013 sampler stopped (TSV kept at /tmp/e2e-r3-p013.tsv; verdict persisted as artifact).
- Stray shared-storage mutation (vote blueprint from the PAPERCUSP_HOME leak) removed same-session; shared staging :3170 + green :3070 verified healthy (200/200).
- Shared desktop-build-target.json untouched (md5-verified across all launches).

## Open residue (not silently dropped)
- P-003 steer leg: owner decision EI-290 (no user-reachable work-item steer/chat affordance) — needs-human; EI-259 oracle leg done.
- EI-239 production-.deb re-verify rides the next .deb rebuild (both fix legs are in binary + bundle by construction).
- EI-296 nice-to-have residue: hono-host exposing endpoint-ipc discovery (not needed for isolation correctness).

## Owner questions (batched)
1. EI-290: how should a user steer/chat a SPECIFIC work item now that general operator/oracle composers exist? (Blocks the last plan item P-003.)
2. P-013 verdict suggests baseline graders adopt "median-only at any load; tail grades need loadavg<24 or a quiet rerun" — adopt as a standing rule in the perf battery?

