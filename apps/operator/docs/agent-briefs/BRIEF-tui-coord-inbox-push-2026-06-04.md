# BRIEF — coord_inbox push for the `pui` TUI (P-002 / D-003b)

**Plan:** `tui-workbench-ratatui-2026-06-04` (read it first: `plans:get { slug, harness:'all' }`).
Relevant decisions: **D-008** (hybrid), **D-009** (pluggable transport), **D-011** (rail split).
**Coordinate with:** `su-30a41` — owner of the coordination substrate (`coordination-substrate-2026-06-03`). An ownership question for the operator route is already open in coord; **confirm with them before adding the operator route / restarting `:3070`.**

## Goal
The `pui` TUI surfaces **direct coord messages / handoffs / escalations addressed to the human**, push-driven (NO polling), in the Inbox tab + as notifications. This is the one piece of TUI reactivity not yet wired — table data + presence + `attention.notify` already push via the `sync_invalidate` SSE bus; this adds the *separate* `coord_inbox` rail.

## Verified background (don't re-derive)
- `coord_inbox` is a PG `pg_notify` channel shipped in **migration 126**; it fires on every `harness_shared.coord_event_log` insert. Payload = `"<workspace_id>::<writer_key>"`, where **`writer_key` = the recipient owner id** (matches `readInbox(ownerId)`). Broadcasts (`to:['*']`) land as per-recipient rows; `to:['human']` rows carry `writer_key='human'`.
- **Nothing LISTENs `coord_inbox` yet — the TUI is the FIRST consumer.**
- The TUI is **IPC/HTTP-only, no direct PG** (D-009), so it CANNOT `LISTEN coord_inbox` itself. The **operator** must host a coord-inbox SSE producer; the TUI rides it like `/api/zero-harness/sse`.
- Content lives in `coord_event_log`, `surface='messages'`, read from a watermark (at-least-once, replayable).

## Identity decision — baked default (so you're not blocked)
Filter for **`writer_key='human'`** (messages addressed `to:['human']`) — **no TUI identity registration needed**, the HUD stays passive. Note the upgrade path in the plan (give `pui` a stable coord owner id → full participant) but DON'T build that unless the owner asks.

## Scope — two halves

### (a) Operator: coord-inbox SSE producer + reader  *(coordinate ownership with su-30a41 first)*
- Mirror `apps/operator/lib/sync-sse.ts` (channel `sync_invalidate`) for a `coord_inbox` LISTEN fan-out.
- New `defineTool` SSE route, e.g. `GET /api/coord/inbox/sse` — `auth` per the existing `/zero-harness/sse` route; filter pushes to `writer_key='human'` (or the connection's owner). Follow the **"Adding a tool"** discipline in `CLAUDE.md` (define in `lib/endpoint-route/routes/coord/`, register in the route index, add `guidance`).
- New reader route `GET /api/coord/inbox?since=<id>` → rows from `coord_event_log` (`surface='messages'`, filter, `ORDER BY id`).
- `:3070` has **no hot-reload** — restart via `dev:restart` (drains peers) to pick up `lib/**`.

### (b) TUI consumer  (`apps/tui`)
- `OperatorClient::subscribe_sse(path)` is already transport-agnostic — reuse it for the new route.
- Add a second subscription task in `main.rs` (like `invalidation_loop`): on a coord_inbox wake, fetch `/api/coord/inbox?since=<watermark>`, emit a new `Event` → reducer appends to the **existing notification infra** (`app.push_notif` / `notifs` / toast / Inbox) — see item 4 (P8). Track the watermark.
- Render coord messages in the **Inbox tab** (a section) and as toasts (reuse `Notif`).

## Testing
- Operator: Vitest for the reader + a route smoke; the SSE route gets a live smoke.
- TUI: reducer/Event unit tests (new coord-message → notif/inbox) + a `#[ignore]` live smoke mirroring `ui::live_client_subscribe_sse`. Bar: `cargo test` green + `cargo clippy` 0 warnings.

## Done when
A `coord:send { to:['human'], … }` shows up in `pui`'s Inbox + as a toast within ~1s, no polling, and survives a reconnect (watermark replay).

## Do NOT
- …make the TUI LISTEN PG directly (it's IPC/HTTP-only).
- …poll. The wake is `coord_inbox`; the rows are the content.
- …restart `:3070` or add the operator route before su-30a41 confirms ownership (it's their live substrate).
- …build the full participant-identity model unless the owner greenlights it.
