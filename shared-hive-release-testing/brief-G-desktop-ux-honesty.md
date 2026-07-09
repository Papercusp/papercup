# Brief G — Desktop UX flows & honesty

**Priority: S1 lane.** Playwright e2e + live desktop verification. Coordinate the
live harness via the `shared-pot-live-instances` lock (with A, E).

## Objective
Prove the user-facing shared-pot flows in the **actual Tauri desktop app** are
correct, honest, and don't strand the user — create, publish, share, discover,
join, and the federation status surfaces.

## Why it matters for release
This is what the public actually touches. The backend can be perfect and the
release still fail if "Publish" lies about reach, the share link is wrong, or join
silently no-ops. (We already fixed one "deceptive publish" honesty bug — assume
there are more UX-truth gaps.)

## Scope / scenarios
1. **Create pot** (from repo, from blueprint) — the picker/flow lands a real,
   bootable pot; visibility derives from repo privacy correctly.
2. **Publish / ShareHiveDialog** (`apps/operator/app/harness/ShareHiveDialog.tsx`):
   - `reachablePeers` honesty: with 0 peers it says "no peers connected yet, becomes
     discoverable when peers come online" — NOT "announced to N peers". With peers,
     the count is real. (This was the deceptive-publish fix — keep it honest.)
   - The share/member/invite **link is correct** and carries the pot topic.
   - Visibility selector states (public/invite/private) match backend effect.
3. **Discover** — the directory lists public pots accurately; invite pots don't
   appear without the secret; stale/withdrawn pots disappear.
4. **Join** — pasting a link actually joins + boots + backfills; an invalid/expired
   link gives a clear error, not a silent no-op or a stuck spinner.
5. **Federation status surfaces** — peer count, sync state, member list reflect
   reality (cross-check against the peer's PG). No "synced" while actually stranded.
6. **Error/empty/loading states** — every flow's unhappy path shows a truthful,
   actionable message; nothing claims success on failure.

## Method
- **Per project rules, verify in the Tauri shell** (`cd papercusp-desktop && npm
  run dev`) following `/internal/docs/testing` + `testing/agent-e2e` — do NOT point
  a browser at `:3055`/`:3070` (blocked + misleading). Use the documented Tauri
  agent-e2e workflow and/or Playwright specs in `apps/operator/e2e/`.
- Cross-check every UI claim against ground truth (the instance's PG / sidecar
  API). The bar is "the UI never lies".
- Use a fixed-`.deb` pair for the real share→join flow (coordinate with Brief A).

## Deliverables
- `findings-G.md`: a flow matrix (flow × {happy, unhappy, honesty-vs-ground-truth}
  × verdict) + any UX-lie or strand (publish-lies / join-no-ops = S1, "synced"
  while stranded = S0) + Playwright specs for the stable flows.

## Done / verdict
GREEN only when every flow works in the real desktop app, every status/claim
matches ground truth, and every unhappy path is truthful and actionable.
