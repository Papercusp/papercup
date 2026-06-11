---
rel_path: "e2e/round2-session5-su1f2b6-2026-06-11.md"
updated_at: 1781218936726
_body: "content"
---

# E2E round 2 — session 5 (su-1f2b6, overnight fix-and-verify loop)

**Scope:** P-008 regression sweep closure (fix + retest), environment repair, palette verification. Plan: app-impersonation-e2e-round2-2026-06-10.
**Rig:** dedicated Tauri debug binary under Xvfb :97 + VirtualGL (real RTX 3090 GL), bridge pids 1460167 → 2443955 (relaunched after a peer's over-broad pkill), target staging :3170. No focus-steal; the owner's live window untouched.

## Fixes landed by this session (all live-verified on :3170, all staging-only until the next green deploy)

| Issue | Fix | Evidence |
|---|---|---|
| EI-206 (major) | Harness list → @papercusp/sync: new `harnessProjects.lite` resolver + shared payload builder (`lib/harness/projects-lite.ts`); invalidation from the registry write seam (`harness-registry.ts notifyRegistryChanged`); migration **222** attaches `emit_change_notify` to `harness_shared.harness_registry` + bridge entry (defeats the bus's 90s source-dedupe) | [/adv Progress tab] register-into-hive → DOM in ~2s, zero interactions; DELETE 1s later → gone in ~2s. sync-resolver 81/81; test:affected 11,128 green |
| EI-224 (major) | MainViewPanel precedence `view==='plans' && plan` (issue's option b) | Inbox mounts with ?plan present; Plans restores the same open plan |
| EI-231 (nit) | WorkspaceSwitcher: document-level Escape handler (rename input exempt), focus returns to trigger | click→menu+wsSwitch=true; Esc→closed+param cleared |
| EI-221 (minor) | nav.ts: nav.marketplace→nav.cupboard, /marketplace→/cupboard (+ navigate promptDescription) | palette (?palette=true) → type "cupboard" → "Go to Cupboard" → /cupboard renders (h1 Cupboard, 17 cards) |
| EI-238 (nit) | Profile save toast → "Profile saved" (storage is PG) | Save click captured toast "Profile saved" |

## Peer fixes verified/corroborated this session
- EI-215 (su-6c28e's CupboardErrorState): /cupboard/999999 from THIS rig renders the friendly copy + `cupboard-error-retry` affordance. PASS.
- EI-239 (su-6c28e): offline toast + Rust reconnect page — their socat-rig evidence accepted; not re-run here (killing staging would yank fleet peers).
- EI-259 (su-75cee fix, su-6c28e green retest): accepted.

**P-008 status: COMPLETE — all 8 round-1 UI issues resolved + retested.**

## Environment finding (filed EI-306, fixed inline)
Two orphaned `vite build --watch` processes from a dead Jun-9 e2e session were racing the live dev:nohmr watcher into the shared `apps/operator-vite/dist` — the on-disk bundle was PARTIAL (missing whole components), so fresh :3170 loads could render broken UI that looks like app bugs. Killed both orphans, one clean rebuild, single legitimate watcher left. Detection rule: `pgrep -af "vite build"` > 1 for the same dist is always wrong.

## Palette finding (comment fixed inline)
`?palette=1` does NOT open the palette — the param is `parseAsBoolean`, so only `?palette=true` parses open. The component doc-comment claimed `?palette=1`; fixed. Keyboard ⌘K/Ctrl+P could not be exercised from this Xvfb rig (key events don't land without real focus — rig limitation, not an app bug; the binding is registry-driven and the palette opens fine via URL/ui:dispatch).

## Not covered by this session (explicitly deferred, with owners)
- P-003 steer leg — blocked on EI-290 (no user-reachable steer/chat affordance exists; product gap, human-gated).
- P-006/P-007 — blocked on EI-296 (iso rig not isolated for UI) / EI-297 (no operator-side fault injection).
- P-013 load-sensitivity stretch — left to the perf lane (quiet-vs-loaded sampling; opportunistic by the plan's own grading).
- EI-278 RSS soak — rig handed to su-111be (P-011 closed by su-0feaf).

## Cleanup ledger (P-016, this session)
- Registry fixtures e2e-sweep-live{1,2,3}: created + DELETED via API, registry verified clean (16 rows, no e2e-sweep-*); /tmp dirs removed.
- Stale bridge token /tmp/tauri-dev-bridge-1460167.token removed after the pkill casualty; relaunch token is /tmp/tauri-dev-bridge-2443955.token.
- Teardown at loop end: Tauri pid 2443955, openbox 219127 (peer-restarted), Xvfb :97 (pid in /tmp/e2e-sweep-su1f2b6/xvfb97.pid), /tmp/e2e-sweep-su1f2b6/.
- NOT deleted: fixture e2e-imp-sync1 + WI-94 (P-016's deletion condition is EI-206 AND EI-229 both closed — now satisfied; left for the plan-closing session to delete + record, since su-0feaf owns the fixture's original ledger entry).

