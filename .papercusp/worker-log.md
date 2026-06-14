# Worker log — EI-9 (auto-implement, attempt 3)

**Bug:** `pui workbench` — the companion zellij plugin opens a focus-stealing
floating pane on first launch, blocking pui input until hidden (Ctrl-p w).

## Root cause (confirmed from zellij 0.44.3 source)
`zellij pipe --plugin <url>` launches the plugin with `floating_plugin`
defaulting to **floating** (`zellij-utils/src/cli.rs` Pipe.floating_plugin —
"defaults to floating"). There is **no** CLI flag for a background/no-pane
launch (only floating ↔ tiled ↔ in-place — all visible), so the launch path
(`apps/tui/src/companion.rs::pipe_argv`) cannot make it headless. The companion
renders nothing (`render()` empty) so the pane sits blank and, being focused,
steals keystrokes from the tiled `pui hud` pane.

## Fix (plugin-side, `apps/pui-zellij-plugin/src/main.rs`)
The plugin suppresses its own pane via `hide_self()`:
- Called in `load()`, and once more on the first `PaneUpdate` (one-shot latch
  `should_retry_self_hide`) as race insurance for the case where the pane isn't
  in the session yet at `load()` time. The retry is idempotent — once the pane
  is suppressed it's no longer in the tiled/floating sets.
- Verified from zellij source that this is correct + complete:
  - `hide_self` → `SuppressPane(PaneId::Plugin(self))`; permission-free
    (falls through to the catch-all `Granted` in `check_command_permission`).
  - `tab::has_non_suppressed_pane_with_pid` + `extract_pane` both handle
    **floating** panes, so the floating companion pane is suppressed.
  - When ours is the **only** floating pane, `extract_pane` calls
    `hide_floating_panes()` + `move_clients_out_of_pane()` — hiding the floating
    layer *and* returning focus to the tiled HUD. Both bug symptoms fixed in one
    call. The plugin stays alive (suppressed ≠ closed), so the pipe link holds.

## Why the prior attempt (su-ad289) failed, and why this differs
Attempt 1 fired an **external** `zellij action toggle-floating-panes` on
`Event::CompanionReady` — it raced pane creation (pane appeared *after* the
toggle → no-op). `hide_self()` is issued **from inside the plugin** during
`load()` (the pane already hosts the plugin) and is retried on first PaneUpdate,
so it is not subject to that race. It also targets only the plugin's own pane,
never a work pane, and never toggles all floating panes.

## Verification
- `cd apps/pui-zellij-plugin && cargo test` → 9 passed (incl. new
  `self_hide_retry_latch_fires_exactly_once`, which pins the retry to one-shot).
- `cargo build --release --target wasm32-wasip1` → clean (compiles the wasm
  `hide_self()` call sites — the real ship target).
- `cargo clippy --release --target wasm32-wasip1` → clean.

## For the validator / live verification
The behavioral assertion (no floating pane on first `pui workbench`; HUD
driveable immediately) needs a **live zellij** session — not runnable in this
runner and not expressible in the four canonical test frameworks (the
`hide_self()` host call is wasm-only). Repro harness from the original session:
`/tmp/pui-livetest/drive_spawn2.py`. The installed wasm
(`~/.papercusp/pui-companion.wasm`) must be rebuilt+reinstalled by the normal
build/release pipeline for the fix to take effect live — this worker does not
deploy.

## Scope check
Plugin-side only. Touches no protected surface (no release/deploy machinery,
scheduler, git-sync, lock authority, migrations, flags, auth, or the
self-improvement loop). Self/inline-sized: 1 file, +58 lines.
