# Testing — `pui` (Papercusp terminal workbench)

Rust crate (`apps/tui`, binary `pui`). Tests are Cargo `#[cfg(test)]` modules —
the canonical home for Rust per the repo's four-framework convention.

## Run

```bash
cd apps/tui
cargo test            # all unit/integration tests (fast, offline) — the default
cargo clippy          # lint; the bar is 0 warnings
cargo test -- --ignored --nocapture   # live smokes (need a running operator)
```

`cargo test` is fully offline (no operator, no network) and is what CI/`test:affected`
should run. The `#[ignore]`d live smokes require the operator running (an
`~/.papercusp/endpoint-ipc.json` socket present) and exercise the real wire.

## What's covered

- **`app.rs` — the reducer (pure, no I/O).** Tab switching, `j/k` nav + clamping,
  selection-after-refetch clamping, command palette capture, help overlay,
  harness cycling + Harnesses column focus toggle, docs scroll, presence-sidebar
  toggle, notifications (push → toast/badge/seq, history backfill, `N`/Esc/inbox
  clear, history cap), and the multi-step tutorial (advance/Esc-skip/F1-reopen).
- **`ui.rs` — rendering (pure `draw(&App)` over a ratatui `TestBackend`).** Each
  tab view + every overlay (help, palette, tutorial, toast, notifications) is
  asserted by rendering to a fixed-size buffer and checking content. Includes the
  presence sidebar (online-only) and the Inbox notification badge.
- **`models.rs` — serde DTOs.** Each operator-API shape is parsed from a
  live-probed JSON fixture (plans, roster, attention, features, issues, projects,
  activity, testing domains, claude-settings, docs, toast-log), with null/missing
  fields defaulting (shape drift never hard-fails a deserialize).
- **`framing.rs` / `ipc.rs` — the IPC transport.** Frame encode/decode
  (round-trip, partial, oversize, unknown type) + an end-to-end client over a
  **fake Unix-socket server**: `sys_http` body reassembly, non-2xx errors, and
  `invoke_stream` streaming-then-terminal.
- **`sse.rs` — the SSE parser.** Frame splitting, partial-frame remainder,
  incremental reassembly, CRLF + multi-line `data:`.
- **`http.rs` — the HTTP transport.** Incremental UTF-8 decode (multibyte split
  across chunks) + an end-to-end client over a **fake TCP HTTP server**: bearer
  header sent, body parsed, non-2xx errors, and streamed SSE frames.
- **`mux.rs` / `layout.rs` — zellij control.** `zellij action`/`zellij pipe`
  command construction (pure argv) + the workbench KDL + `materialize`.
- **`tutorial.rs` — first-run state.** `pui-state.json` seen/mark round-trip,
  key-preserving merge, malformed-file → unseen.
- **`companion.rs` — companion zellij plugin link (P-004 / D-008).** The pure
  helpers: the `zellij pipe` child argv, the `file:` plugin URL, `PaneSpec` →
  `OpenCommandPane`, and `PluginEvent` → `Event` mapping. The reducer arms for
  the companion events live in the `app.rs` tests: topology stored;
  `workbench_summary` (incl. the `▶ <focused>` focus-follow indicator); pane-exit
  → notification + `r`-to-relaunch arming (`relaunch_spec` re-runs the exited
  command via `sh -c`, one-shot); a plain shell exit does NOT arm relaunch;
  pane-close → topology prune. The status-bar indicator render is in the `ui.rs`
  tests. The live process spawn + duplex is covered by the plugin crate's live
  smoke (see below), not here.

## Live smokes (`-- --ignored`, need a running operator)

- `ipc::live_ipc_smoke` — `sys:http` GET over the real socket returns plans.
- `ipc::live_sse_subscription_smoke` — raw `invoke_stream` of the SSE route.
- `ui::live_client_subscribe_sse` — the transport-agnostic `subscribe_sse` gets a
  live heartbeat frame.
- `ui::live_toast_log_fetch` — `recent_toasts` over the real wire.
- `ui::live_presence_sidebar_render` — renders the real roster into the sidebar.

## What's NOT covered (known gaps)

- **Interactive TTY behaviour** — actual terminal rendering, raw-mode input, and
  the crossterm event loop are not exercised (the reducer + `draw` are tested in
  isolation; the alternate-screen/raw-mode shell in `main.rs` is not). First
  human-interactive run still pending.
- **HTTP transport live** — only unit-tested via a fake server; never run against
  a real operator (the dev box resolves IPC, has no `operator.json`). The remote
  path needs an SP1 `serve` instance to verify end-to-end.
- **zellij live** — only command construction is tested here; spawning/driving a
  real zellij session (and the `pui workbench` layout) is unverified in this
  crate. The companion plugin's live duplex (open/focus/close panes, pane-exit
  detection) IS verified end-to-end by `apps/pui-zellij-plugin/scripts/live-smoke.py`
  against an isolated zellij session.
- **OS notifications** — `notify::os_notify` is best-effort (no D-Bus assertion);
  delivery isn't tested, only that it never panics.
- **coord_inbox listener (P-002)** — not built (gated on the TUI coord
  owner-identity decision + an operator SSE route).

## After editing

Run `cargo test` + `cargo clippy` (0 warnings) before declaring done. If you
touched the wire (`ipc.rs`/`http.rs`/`client.rs`/`sse.rs`/`models.rs`), also run
the live smokes against a running operator to confirm the real shapes still parse.
