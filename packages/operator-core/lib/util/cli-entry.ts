/**
 * Bundle-safe "run only as a CLI, not on import" guard.
 *
 * The naive idiom — `import.meta.url === pathToFileURL(process.argv[1]).href`
 * (or the `file://${process.argv[1]}` / `fileURLToPath(import.meta.url) ===
 * process.argv[1]` spellings) — is correct for a standalone `.ts`/`.mjs` file
 * but is a BOOT-TIME LANDMINE once the module is esbuild-bundled into the
 * desktop sidecar (`papercusp-desktop/.../serve.mjs`).
 *
 * In that single-file bundle EVERY inlined module shares ONE `import.meta.url`
 * — the bundle's own — which equals `process.argv[1]`. So a naive inline guard
 * evaluates TRUE for every bundled library-CLI, each running its `main()` and
 * `process.exit()` the moment its module is first imported during operator
 * boot. That is EI-650: the sidecar logged the `seed-learning-singletons`
 * dry-run then silently exited (process.exit(0)) before serving, taking
 * embedded PG down with it — deterministic on every packaged build.
 *
 * The sidecar bundle is built with `--define:__PAPERCUSP_BUNDLED_SIDECAR__=true`
 * (see `papercusp-desktop/bin/build-desktop-sidecar.sh`). In that build an
 * inlined library module is NEVER the real entry — the bundle entry
 * (`apps/operator/bin/serve.ts`) boots unconditionally and does not use this
 * helper — so we report `false` and no library `main()` fires.
 *
 * Outside the bundle (tsx, dev, vitest) the define is absent, so we fall back
 * to the real path comparison: `tsx some-cli.ts` still self-executes exactly
 * as before. The esbuild build for the CJS `require.main === module` idiom is
 * already neutralised by the bundle banner's dummy `module`; this is the
 * symmetric fix for the ESM `import.meta.url` idiom.
 */
import { pathToFileURL } from 'node:url';

// Injected by esbuild (`--define`) only in the desktop-sidecar bundle. Absent
// (a genuine `undefined` global) under tsx/dev/test — read it via `typeof` so
// that reference never throws.
declare const __PAPERCUSP_BUNDLED_SIDECAR__: boolean | undefined;

/**
 * True iff `importMetaUrl` is the directly-executed entrypoint — i.e. the file
 * was run as a CLI, not imported. Always false inside the bundled sidecar (an
 * inlined library is never the entry there), so a library's CLI `main()` never
 * fires at operator boot.
 *
 * @param importMetaUrl the calling module's `import.meta.url`
 */
export function isCliEntry(importMetaUrl: string): boolean {
  if (typeof __PAPERCUSP_BUNDLED_SIDECAR__ !== 'undefined' && __PAPERCUSP_BUNDLED_SIDECAR__) {
    return false;
  }
  return !!process.argv[1] && importMetaUrl === pathToFileURL(process.argv[1]).href;
}
