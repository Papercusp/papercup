# Brief M — Desktop UI: share-hive flow + the G-004 live status surface

**Priority: S2 lane.** Desktop E2E via the **Tauri shell** (NEVER `:0`, never a
browser at `:3055`/`:3070`). Follow `/internal/docs/testing` + `testing/agent-e2e`.

## Objective
Drive the **real desktop UI** through the shared-hive user journey and resolve
**G-004** — the desktop has **no live peer/sync status surface** (a gap, not a lie):
implement a minimal one, or document the absence honestly.

## Why it matters for release
The federation logic is proven at the API/PG layer; the **user** experiences it
through the Tauri UI, and UI-only bugs (handler wired wrong, toast lost, panel
unmounted, deceptive copy) don't show up in curl/PG checks. G-001/G-002/G-003 are
honesty bugs at the UI seam; G-004 is a missing surface — a user has no way to see
"am I connected to peers / is my hive syncing?", which makes every other federation
guarantee invisible and erodes trust at exactly the moment it matters.

## Scope / scenarios
Run a SECOND Tauri instance headless (its own Xvfb `:1xx` + `PAPERCUSP_WORKSPACE_ROOT`),
or reuse the smoke pair's instances if drivable. For each, capture DOM/screenshot
evidence (silence ≠ success):
1. **ShareHiveDialog** (`apps/operator/app/harness/ShareHiveDialog.tsx`): share a
   hive (public + invite); assert the dialog shows the link/secret and an **honest**
   reach signal (consumes G-001's `reachablePeersForHive`, not the global count).
2. **Discover panel:** lists public hives; **withdrawn hives drop out** on the
   30s poll + manual Refresh (G-003); joining navigates correctly.
3. **Invite-join copy (G-002):** a dead/wrong secret shows honest failure copy, NOT
   an unconditional "appears shortly".
4. **G-004 live status surface:** design + implement a minimal peer/sync indicator
   (peer count for the active hive, last-sync / drained state) — OR, if deferred,
   write the honest "no live sync status yet" documentation + an EI so it's tracked,
   not silently missing.

## Method
- Release builds have **no debug bridge** (`#[cfg(debug_assertions)]`), so for a
  packaged `.deb` use **VirtualGL screenshots** (`vglrun -d egl0`, NOT bare Xvfb —
  WebKitGTK won't paint without GL → blank-white). For a `npm run dev` debug shell
  use `tauri-agent-tools` (DOM/eval/click). Pick per what you're driving.
- The G-004 implementation is small UI + a `/api/...` read of peer/drain state;
  keep it disjoint from the operator-core lanes.

## Deliverables
- `findings-M.md`: per-journey PASS/FAIL with DOM/screenshot evidence, and the
  G-004 decision (implemented surface, or documented gap + EI).

## Done / verdict
GREEN only when the share→discover→join journey is driven on the real shell with
positive evidence, the honesty copy is correct, and G-004 is either shipped or
honestly documented.
