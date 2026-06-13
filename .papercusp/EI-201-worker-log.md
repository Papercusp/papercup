# EI-201 worker log

**Bug:** Desktop crashed on first left-click under Wayland — wry's
undecorated-resizing hit-test (`undecorated_resizing.rs`) unwrapped a
`webview.parent().parent().downcast::<gtk::Window>()` that fails once the
native-terminal VTE embed reparents the webview into a `GtkPaned`. Runs on every
button-1 press before `is_decorated()`, so the first click was fatal.

## State found
- The code fix was **already shipped & owner-verified** (vendored
  `tauri-runtime-wry` 2.11.0 via `[patch.crates-io]`; both the button-press and
  touch handlers now resolve `webview.toplevel()` + `.downcast::<…>().ok()`).
  Owner journal evidence: 3 pre-patch crash records → 0 panics over 5 clicks into
  the reparented webview post-patch.
- What was missing (why it never left the queue): **no automated regression
  guard**. Issue follow-up (a) flags the live regression vector — when upstream
  releases the fix the vendored copy gets dropped, and a re-vendor / `cargo
  update` could silently reintroduce the unwrap.

## Change made
Added a source-invariant Cargo test `mod patch_regression` at the end of
`papercusp-desktop/src-tauri/vendor/tauri-runtime-wry/src/undecorated_resizing.rs`:
- `both_handlers_resolve_the_toplevel_gracefully` — asserts both handlers use
  `.toplevel()` and `.downcast::<gtk::Window>().ok()` (≥2 each).
- `the_panicking_unwrap_is_gone` — asserts the source has no
  `.downcast::<gtk::Window>().unwrap()` and no "Safe to unwrap unless this is not
  from tao" marker.

Behavioural test isn't possible (the panic is a GTK button-press/touch callback
needing a live display + reparented webview + synthetic click — not headless-
reproducible), so the guard pins the **shape** of the fix, which is the actual
regression vector. The test scans only source above a `PAPERCUSP_EI201_GUARD_SENTINEL`
marker so its own literals don't self-satisfy the scan.

## Verification
`cd papercusp-desktop/src-tauri && cargo test -p tauri-runtime-wry patch_regression`
→ **2 passed; 0 failed** (vendored crate compiles in ~33–42s standalone).
Fails-before proven: when the forbidden `.unwrap()` literal was in scope (initial
mis-scoped run) the negative assertion fired; against pre-patch source both tests
fail. After the patch both pass.

## For the validator to re-verify
- Re-run `cargo test -p tauri-runtime-wry patch_regression` (green).
- Note: building the FULL tauri bin crate is large/slow and unnecessary — the
  change is confined to the vendored lib crate, which builds standalone.
- When upstream tauri ships PR #15513, the whole vendor dir + the test get
  dropped together (per the issue's documented teardown).

Resolved: `fixed`.
