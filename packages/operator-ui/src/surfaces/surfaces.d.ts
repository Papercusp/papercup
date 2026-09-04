/**
 * The PUBLIC TYPE SURFACE of `@papercusp/operator-ui/surfaces`, declared
 * without importing the operator components it mounts (WI-2143109).
 *
 * WHY A HAND-WRITTEN .d.ts RATHER THAN LETTING TSC INFER FROM index.tsx
 *
 * `index.tsx` lazily imports ~465 modules living in `apps/operator/app` and
 * `apps/operator-vite/src`. Those modules are written against the OPERATOR's
 * tsconfig — its `@/*` path mapping, its `lib`, its `types`, its strictness.
 * A consumer that follows the implementation therefore pulls that whole tree
 * into ITS program under ITS settings, which produces two bad outcomes and no
 * good one:
 *
 *   - hundreds of resolution errors that are artifacts of the consumer's
 *     config, not defects (measured: 625 errors in the portal, dominated by
 *     `Cannot find module '@/...'` — a path the operator's own build resolves
 *     perfectly well); and
 *   - a second, slower, differently-configured typecheck of code that is
 *     ALREADY typechecked where it lives, by `lint:tsc`'s operator legs and
 *     operator-vite's own `tsc`. Re-checking it here adds no safety.
 *
 * So the boundary is deliberate: the IMPLEMENTATION is typechecked in the repo
 * that owns it; CONSUMERS get this declaration. That is the ordinary contract
 * of a package, and it is what `exports["./surfaces"].types` points at.
 *
 * ⚠ THE COST, STATED PLAINLY: this file is hand-maintained, so it can drift
 * from `index.tsx` — the classic hand-maintained-metadata failure. Two things
 * bound that. It is TINY and shape-stable (a key union plus one uniform
 * component type — every entry is a zero-prop mount BY CONSTRUCTION, which is
 * why per-surface props are bound inside the table rather than exposed here).
 * And a drifted key is not silent: `isOperatorSurfaceKind` and
 * `OPERATOR_SURFACES` are declared over the SAME union, so a kind added to one
 * and not the other fails at the call site.
 */
import type { ComponentType, LazyExoticComponent } from 'react';

/**
 * The portal mounts that resolve to an operator component.
 *
 * Nine are rail surfaces (the former `mount: "embedded-pane"` iframes);
 * `tasks-roster` is the topbar process popover. Keep in sync with the table in
 * `index.tsx` — see the drift note above.
 */
export type OperatorSurfaceKind =
  | 'tasks-roster'
  | 'session-history'
  | 'desktops'
  | 'plans'
  | 'inbox'
  | 'overview'
  | 'hud'
  | 'work'
  | 'learning'
  | 'workflows'
  | 'brainstorm';

/**
 * Every surface is a zero-prop lazy mount. Surfaces that need arguments
 * (`layout="split"`, `panel="brainstorm"`, `active`) have them bound inside the
 * table, so a host never has to know which is which — and `Record<string,
 * never>` states that: passing props here is a type error, not a silent no-op.
 */
export declare const OPERATOR_SURFACES: Record<
  OperatorSurfaceKind,
  LazyExoticComponent<ComponentType<Record<string, never>>>
>;

/** Narrow an arbitrary rail kind to one that has a surface behind it. */
export declare function isOperatorSurfaceKind(kind: string): kind is OperatorSurfaceKind;
