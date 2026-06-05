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
});
