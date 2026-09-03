/**
 * The nine operator CENTRE surfaces, as importable React components
 * (WI-2143109).
 *
 * WHY A FAÇADE HERE AND A PHYSICAL MOVE FOR AccountsTab
 * ----------------------------------------------------
 * AccountsTab was `git mv`'d into this package: 494 self-contained lines whose
 * only ties to the operator app were the three seams in `../seam`. Moving it
 * left ONE copy, and the operator re-exports it.
 *
 * These nine are a different shape and the same rule produces a different
 * answer. Measured (2026-09-03) their union is 465 runtime modules and 42
 * stylesheets spread across `apps/operator/app`, `apps/operator-vite/src` and
 * `packages/operator-core/lib`, wired together with the operator's `@/` alias.
 * Physically moving that closure would not "extract a panel" — it would move
 * most of the operator app into a package, rewrite ~465 files' import paths,
 * and leave the operator importing its own screens back through a package
 * boundary. The duplication rule that justified moving AccountsTab is the same
 * rule that forbids it here: one source of truth, and these files already have
 * one.
 *
 * So this module is composition only. Each entry names the component the
 * operator route ALREADY renders for that tab, so the portal mounts the very
 * same tree the operator does — no fork, no reimplementation, and a change to
 * a surface lands in both apps at once. The mapping below is the portal-side
 * mirror of `apps/operator-vite/src/routes/adv/index.tsx`'s tab switch plus the
 * `/plans`, `/inbox` and `/cloud-workspaces` route components.
 *
 * WHAT A HOST OWES THESE SURFACES (more than AccountsTab needed)
 *   1. configureOperatorUi({ Link, toast, apiFetch })   — ../seam
 *   2. a nuqs adapter above them  (74 of the 465 modules read URL state)
 *   3. a SyncProvider above them  (84 modules read through @papercusp/sync)
 *   4. build aliases for `@/` + `@papercusp/operator-core`, and the browser
 *      shims operator-vite already declares in its vite.config `resolve.alias`
 *      (without the `delegated-tasks` shim in particular, a runtime-guarded
 *      dynamic import drags ~1,900 server modules and node:fs into the graph —
 *      measured: PlansPane 2,165 modules shimless vs 220 with).
 *
 * Every entry is `lazy()` ON PURPOSE. The nine closures overlap but are far
 * from equal (20 modules for Desktops, 255 for HUD), and a portal tab must not
 * pay for the eight surfaces it is not showing. This preserves the same chunk
 * boundary the operator's own route-level code-splitting gives them.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** The portal rail kinds that resolve to an operator surface. */
export type OperatorSurfaceKind =
  | 'tasks-roster'
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
 * `Desktops` is the one surface with a SUBJECT (which workspace host to open).
 * The operator reads it from its own URL, so the portal passes it the same way
 * — through the nuqs adapter the host installs, not as a prop. That keeps this
 * table free of per-surface prop plumbing: every entry is a zero-prop mount.
 */
export const OPERATOR_SURFACES: Record<
  OperatorSurfaceKind,
  LazyExoticComponent<ComponentType<Record<string, never>>>
> = {
  // The topbar process pill's roster. Not a rail surface — it is the popover
  // behind the process pill — but it is the same kind of thing (an operator
  // panel the portal framed) and it is the LAST iframe in the portal, so it
  // belongs in this table rather than in a parallel one-off mechanism.
  // `active` drives its inventory subscription; the popover only renders while
  // open, so it is always active.
  'tasks-roster': lazy(async () => {
    const mod = await import('../../../../apps/operator-vite/src/components/adv/TasksRosterPanel');
    const Panel = mod.default;
    return { default: () => <Panel active /> };
  }),
  // /cloud-workspaces?step=operate&tab=desktops
  desktops: lazy(() => import('../../../../apps/operator/app/cloud-workspaces/page')),
  // /plans — PlansPane owns filters, dashboard nav and the cleanup strip.
  // `layout="split"` is the route's own choice, re-stated here so the portal
  // pane lays out list-beside-detail exactly as /plans does.
  plans: lazy(async () => {
    const mod = await import('../../../../apps/operator/app/_components/plans/PlansPane');
    const Pane = mod.default;
    return { default: () => <Pane layout="split" /> };
  }),
  // /inbox — same split contract as /plans.
  inbox: lazy(async () => {
    const mod = await import('../../../../apps/operator/app/_components/inbox/InboxPane');
    const Pane = mod.default;
    return { default: () => <Pane layout="split" /> };
  }),
  // /adv?tab=<id> — these five are the tab bodies from the adv route's switch.
  overview: lazy(() => import('../../../../apps/operator-vite/src/components/adv/AdvOverviewTab')),
  hud: lazy(() => import('../../../../apps/operator/app/adv/hud/HudView')),
  work: lazy(() => import('../../../../apps/operator/app/adv/harnesses/HarnessesWorkspace')),
  learning: lazy(() => import('../../../../apps/operator-vite/src/components/adv/LearningTab')),
  workflows: lazy(() => import('../../../../apps/operator-vite/src/components/adv/AdvWorkflowsTab')),
  // brainstorm is one of AdvHarnessPanelPage's panels, not a component of its
  // own — the operator's switch falls through `brainstorm | prs | insights |
  // settings | docs | git | testing` to this single page.
  brainstorm: lazy(async () => {
    const mod = await import('../../../../apps/operator-vite/src/components/adv/AdvHarnessPanelPage');
    const Panel = mod.default;
    return { default: () => <Panel panel="brainstorm" /> };
  }),
};

/** Whether a portal rail kind has a native operator surface behind it. */
export function isOperatorSurfaceKind(kind: string): kind is OperatorSurfaceKind {
  return kind in OPERATOR_SURFACES;
}
