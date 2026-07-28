/**
 * Operator wiring for @papercusp/desktop-ipc's host seam.
 *
 * @papercusp/desktop-ipc is project-agnostic: it doesn't know the
 * operator's env-var names. Map our branded rollback flag
 * (`NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT=1`) onto the generic
 * `forceHttp` seam here. NOTE: the operator-vite SPA bundles under Vite, which
 * (unlike Next's webpack) neither inlines `NEXT_PUBLIC_*` nor defines `process`
 * in the browser. `apps/operator-vite/src/process-polyfill.ts` installs a
 * minimal `process.env`, so this read resolves to `undefined` (hatch off) at
 * runtime instead of throwing `ReferenceError: process is not defined`. To flip
 * the hatch on in the Vite app, set the key on that shim or read
 * `import.meta.env` instead.
 *
 * Imported for side effect at the top of both transport-adapter barrels
 * (`index.ts` and `desktop-bootstrap.ts`) so the configure call runs
 * before the transport picker or the polyfill installer is first used.
 */
import { configureDesktopIpc } from '@papercusp/desktop-ipc';

configureDesktopIpc({
  forceHttp: () =>
    process.env.NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT === '1' ||
    process.env.NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT === 'true',

  /**
   * D-008 (`no-http-anywhere-2026-07-28`): ask the shell whether the IPC bridge's
   * owner is the operator that served this document.
   *
   * This retires an undeclared HTTP carve-out. `/api/desktop/*` was excluded from
   * the IPC reroute unconditionally because those endpoints describe the SERVING
   * operator and the bridge may target a different build on a dev box. Measured in
   * a live shell, that one exclusion was the entire source of webview HTTP egress —
   * escapes recurring on the 30 s poll tick long after the polyfill installed, so
   * it was never the startup race P-011 blamed. The Rust resolver already knows the
   * answer structurally (a per-port advertisement is published BY the operator on
   * that port; only the legacy singleton fallback can name a foreign one), so we
   * read that STRUCTURED flag rather than parsing `resolution_detail` prose — which
   * would be the infer-from-a-string class D-005 exists to retire.
   *
   * Resolved once per session and cached by the seam. Any failure — no Tauri, an
   * older shell whose `IpcStatus` predates the field, a rejected invoke — yields
   * `false`, i.e. exactly the pre-D-008 behaviour.
   */
  ipcOwnerIsContentOrigin: async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const status = await invoke<{ ownerIsContentOrigin?: boolean; owner_is_content_origin?: boolean }>(
        'endpoint_ipc_status',
      );
      // Tauri's specta bindings emit camelCase, but a hand-rolled/older shell may
      // pass the Rust field name through verbatim. Accept either; anything else
      // (including the field being absent) is not a proof, so it stays false.
      return status?.ownerIsContentOrigin === true || status?.owner_is_content_origin === true;
    } catch {
      return false;
    }
  },
});
