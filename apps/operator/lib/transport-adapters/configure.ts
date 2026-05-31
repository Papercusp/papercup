/**
 * Operator wiring for @papercusp/desktop-ipc's host seam.
 *
 * @papercusp/desktop-ipc is project-agnostic: it doesn't know the
 * operator's env-var names. Map our branded rollback flag
 * (`NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT=1`) onto the generic
 * `forceHttp` seam here. The literal `NEXT_PUBLIC_*` read is inlined by
 * the Next.js bundler, so this still works in the browser bundle.
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
