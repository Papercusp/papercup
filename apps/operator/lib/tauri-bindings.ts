// NOT generated — a re-export. The generated Tauri bindings now live at
// `packages/operator-core/lib/tauri-bindings.ts`, which is where specta writes
// them (see the `.export(...)` call in papercusp-desktop/src-tauri/src/main.rs).
//
// WHY THE GENERATED FILE MOVED (EI-18899708711154370 · no-http-anywhere-2026-07-28
// D-014). There used to be TWO live copies of this generated module, imported side
// by side: this one (regenerated) and operator-core's (hand-maintained, and 12
// commands stale by 2026-08-02 — it had no `endpointIpcStatus`). specta writes
// exactly ONE file, so the other was stale BY CONSTRUCTION and nothing detected it.
//
// The duplicate existed because a PACKAGE CANNOT IMPORT FROM AN APP: operator-core
// needs `commands`, so with generation living in apps/operator its only option was
// to keep its own copy. Generating into operator-core inverts that — the package
// owns the generated module and the app re-exports it, which is the direction the
// dependency graph actually allows. Keep it that way: moving generation back into
// apps/operator rebuilds the same trap.
//
// This file exists only to preserve the `@/lib/tauri-bindings` alias its importers
// use (app/_components/NativeTerminalGate.tsx, app/_components/TerminalDivider.tsx).
export * from '@papercusp/operator-core/lib/tauri-bindings';
