import type { ReactNode } from 'react';

/**
 * `@bprogress/next` + `@bprogress/next/app` compatibility shim for the
 * operator-vite migration. Wired via `resolve.alias` in `vite.config.ts`.
 *
 * Why a no-op: the bprogress top-of-page progress bar is purely cosmetic.
 * In the Next operator it's mounted by `RouteProgressProvider`, which is
 * **deferred to plan B6** (the `@bprogress/next` → TSR `useRouterState`
 * adapter) and is NOT yet in operator-vite's `__root.tsx`. That means leaf
 * components (`RouteLink`, `WorkspaceSwitcher`, `MarketplaceList`) call
 * `useProgress()` with no `ProgressProvider` ancestor. Rather than risk
 * `@bprogress/next`'s real `useProgress` throwing / pulling Next-only
 * internals at module load, this shim returns inert controls.
 *
 * Net effect until B6 lands: navigation works, the progress bar simply
 * doesn't animate. B6 replaces this with a real TSR-native bar.
 *
 * **Decommission:** delete with the other shims in Phase H.
 */

export interface ProgressControls {
  set: (n: number) => void;
  start: (n?: number, m?: number, force?: boolean) => void;
  stop: (delay?: number) => void;
  inc: (n?: number) => void;
  dec: (n?: number) => void;
  pause: () => void;
  resume: () => void;
}

// Module-level constant — stable identity so `useEffect(..., [progress])`
// in callers doesn't re-fire every render.
const NOOP_PROGRESS: ProgressControls = {
  set: () => {},
  start: () => {},
  stop: () => {},
  inc: () => {},
  dec: () => {},
  pause: () => {},
  resume: () => {},
};

export function useProgress(): ProgressControls {
  return NOOP_PROGRESS;
}

/**
 * `ProgressProvider` from `@bprogress/next/app` — passthrough. The real
 * one renders the progress-bar DOM + wires router events; the shim just
 * renders children so a `RouteProgressProvider` port that mounts it
 * doesn't crash before B6 supplies the real implementation.
 */
export function ProgressProvider({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
