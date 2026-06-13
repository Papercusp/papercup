# Worker log — EI-201 (Wayland click crash: wry undecorated_resizing unwrap)

## Outcome: fixed (verified)

## What I found
The fix was already authored in the tree by a prior attempt (vendored
`tauri-runtime-wry` 2.11.0 via `[patch.crates-io]` in
`papercusp-desktop/src-tauri/Cargo.toml`), but it had NOT been verified or
resolved — so the bug never left the queue (re-dispatched → attempt 2).

- Fix sites: `papercusp-desktop/src-tauri/vendor/tauri-runtime-wry/src/undecorated_resizing.rs`
  button-press + touch hit-test handlers now do
  `webview.toplevel().and_then(|w| w.downcast::<gtk::Window>().ok())`
  instead of `webview.parent().parent()...downcast::<gtk::Window>().unwrap()`.
  Correct at any GTK nesting depth incl. the VTE embed's reparented GtkPaned.

## The real defect blocking verification (why attempt 1 "failed")
A `#[cfg(test)] mod patch_regression` source-shape guard accompanied the fix.
Its `handler_source()` originally split the file on `"mod patch_regression"`
to isolate the code above the test. But the guard's own doc-comment block
(placed *above* the module decl) re-states the forbidden literal
`.downcast::<gtk::Window>().unwrap()` as documentation — so it stayed inside
the scanned region and `the_panicking_unwrap_is_gone` FAILED on its own comment.

The uncommitted working-tree change fixes it: it inserts a
`PAPERCUSP_EI201_GUARD_SENTINEL` marker BEFORE the comment block and splits
there, excluding the doc block from the scan. (The "Safe to unwrap..." phrase
is deliberately line-wrapped in the comment so it never matches contiguously.)
This is load-bearing and I left it in the tree for git-sync to commit.

## Verification
- `cd papercusp-desktop/src-tauri && cargo test -p tauri-runtime-wry patch_regression`
  → 2 passed; 0 failed. Crate compiles cleanly with the patch.
- Proved fail-before/pass-after: reproduced the guard's scan logic — old
  `"mod patch_regression"` split includes `.downcast::<gtk::Window>().unwrap()`
  (FAIL); new sentinel split excludes it and all 4 assertions pass.
- Behavioural repro (live Wayland reparented click → panic) is not headless-
  reproducible; the source-invariant guard is the correct regression vector.

## Validator should re-verify
- The sentinel change lands (git-sync) so the COMMITTED submodule state also
  has the passing guard — currently the fix is correct but uncommitted.
- Follow-up (NOT this item): upstream PR tauri-apps/tauri#15513; when a released
  tauri-runtime-wry carries it, drop the vendor dir + the [patch.crates-io] block.
