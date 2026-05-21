/**
 * `@bprogress/next` + `@bprogress/next/app` compatibility shim for the
 * operator-vite migration. Wired via `resolve.alias` in `vite.config.ts`.
 *
 * **B6 (2026-05-21): no longer a no-op.** This now re-exports the *real*
 * progress controls from `@bprogress/react` — the framework-agnostic core
 * that `@bprogress/next` itself wraps. Shared operator components
 * (`RouteLink`, `WorkspaceSwitcher`, `MarketplaceList`) import
 * `useProgress` from `@bprogress/next`; under Vite that resolves here and
 * gets a live controller, so their `.start()/.stop()/.set()` calls drive
 * the real bar.
 *
 * The bar itself is mounted once in `__root.tsx` via `<ProgressProvider>`
 * (re-exported below) and advanced by `src/components/NavigationProgress.tsx`,
 * which bridges TanStack Router's `status` to `useProgress()`. The Next
 * package's App-Router auto-wiring is intentionally dropped — TSR drives
 * the bar instead.
 *
 * The live Next operator resolves `@bprogress/next` via `node_modules/`
 * and is unaffected.
 *
 * **Decommission:** delete with the other shims in Phase H.
 */
export { ProgressProvider, useProgress } from '@bprogress/react';
export type { ProgressContextValue, ProgressProviderProps } from '@bprogress/react';
