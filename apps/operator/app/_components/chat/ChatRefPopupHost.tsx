'use client';

/**
 * ChatRefPopupHost (WI-6601) — the ONE mount of the chat ref-pill popups.
 *
 * THE BUG THIS FIXES. `wpop`/`wppop` are global nuqs state, but the popups that
 * render them used to be mounted INSIDE `OperatorChat`, gated on that
 * instance's own `harnessSlug` prop:
 *
 *     {harnessSlug ? (<WorkItemPopupModal … /><PlanPopupModal … />) : null}
 *
 * The gate existed for a real reason — the persistent sidebar instance and a
 * harness-scoped instance (SessionChatModal via HudView) can be mounted at the
 * same time, and two mounts of one param is a duplicate stacked popup. But the
 * sidebar is a CROSS-HARNESS surface and never receives a `harnessSlug`, so on
 * any mount without a resolvable `?slug` the gate closed on the only instance
 * present: the drill-in wrote a perfectly correct `wpop=papercusp::WI-6594`
 * and NOTHING rendered it (measured live 2026-07-28, `nModals: 0`). A dead
 * click whose URL looks right.
 *
 * WHY A SINGLETON AND NOT A WIDER GATE. Widening the per-instance gate
 * re-introduces the duplicate-render it was added to prevent — the two failures
 * are opposite ends of the same missing invariant ("exactly one renderer"). So
 * own the popups in one place, driven purely by the param, and let every chat
 * surface keep WRITING the param without any of them rendering it. The popups
 * were already pure functions of props, so nothing about them had to change.
 *
 * WHERE IT MOUNTS: the router root (`apps/operator-vite/src/routes/__root.tsx`),
 * INSIDE `NuqsAdapter` (it reads query state) but OUTSIDE the `!chromeless`
 * gate. That last part is load-bearing: `/quick-panel` is chromeless, so
 * `ChromeShell` never renders there — mounting this in the chrome would have
 * left the exact surface WI-6601 names still broken.
 *
 * BUNDLE: both popups are lazy — `PlanPopupModal` pulls `PlanDetail`, which
 * pulls the Vditor editor. A static import here would drag that onto every
 * route including `/login`. Loading them only once a param is actually set
 * makes this strictly lighter than the per-instance mount it replaces.
 * `lazyWithRetry`, not bare `React.lazy`: on the packaged WebKitGTK desktop a
 * transient chunk-load failure must not escalate to the fatal route boundary
 * (WI-2902).
 */
import { Suspense, useMemo } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { lazyWithRetry as lazy } from '@papercusp/operator-core/lib/lazy-with-retry';
import { useResolvedHarnessSlug } from '@/app/adv/create/use-create-data';
import {
  CHAT_PLAN_POPUP_PARAM,
  CHAT_WORK_ITEM_POPUP_PARAM,
  decodeScopedRef,
  encodeScopedRef,
} from './chat-ref-popup-params';

const WorkItemPopupModal = lazy(() => import('../work-items/WorkItemPopupModal'));
const PlanPopupModal = lazy(() => import('../plans/PlanPopupModal'));

export default function ChatRefPopupHost() {
  const [openWorkItem, setOpenWorkItem] = useQueryState(
    CHAT_WORK_ITEM_POPUP_PARAM,
    parseAsString,
  );
  const [openPlan, setOpenPlan] = useQueryState(CHAT_PLAN_POPUP_PARAM, parseAsString);

  // The surrounding surface's harness is the FALLBACK only. A ref that named
  // its own harness is the stricter source and wins — it is right even on a
  // cross-harness mount, where `?slug` is absent entirely. Same precedence
  // HudView applies to its own `hudwi`/`hudplanpop`.
  const resolvedHarness = useResolvedHarnessSlug();

  const workItem = useMemo(() => decodeScopedRef(openWorkItem), [openWorkItem]);
  const plan = useMemo(() => decodeScopedRef(openPlan), [openPlan]);

  const workItemHarness = workItem.harness ?? resolvedHarness;
  const planHarness = plan.harness ?? resolvedHarness;

  return (
    <>
      {workItem.id ? (
        <Suspense fallback={null}>
          <WorkItemPopupModal
            id={workItem.id}
            harnessSlug={workItemHarness}
            // A related-item ref inside the open detail RE-TARGETS this same
            // popup (the component's own documented contract). Re-encode with
            // the harness we resolved, so the follow-on item stays scoped.
            onSelect={(id) => void setOpenWorkItem(encodeScopedRef(workItemHarness, id))}
            onClose={() => void setOpenWorkItem(null)}
          />
        </Suspense>
      ) : null}
      {plan.id ? (
        <Suspense fallback={null}>
          <PlanPopupModal
            planSlug={plan.id}
            harnessSlug={planHarness}
            onClose={() => void setOpenPlan(null)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
