/**
 * `ChatRefPopupHost` for an external host (WI-10001509).
 *
 * THE SINGLETON CONTRACT, ONE REPO BOUNDARY OUT. `wpop`/`wppop` are global
 * nuqs state and exactly ONE component may render them — mount two and a click
 * opens two stacked popups, which is the failure WI-6601's singleton was
 * introduced to prevent. The operator mounts it at its router root; a host that
 * mounts the Papercup chat (the portal) owes the same single mount at ITS shell
 * root, which is what this export exists to make possible.
 *
 * WHY A FAÇADE AND NOT A MOVE: the host pulls in `WorkItemPopupModal` and
 * `PlanPopupModal` — the operator's own detail screens, several hundred modules
 * deep through `@/`. That is the same closure `./surfaces` documents as
 * move-forbidden: relocating it would drag most of the operator app into this
 * package. So this composes rather than copies, exactly like `./surfaces`, and
 * a change to the popups lands on both hosts at once.
 *
 * ⚠ PATH DEPTH: `./surfaces/index.tsx` sits one directory deeper and reaches
 * the app with `../../../../`; from `src/` it is `../../../`.
 *
 * LAZY on purpose, matching the operator's own mount: both popups pull the
 * Vditor editor through `PlanDetail`, so a static import here would drag it
 * into the host's eager bundle for every route. Loading only once a param is
 * actually set keeps a host that never opens a ref pill paying nothing.
 *
 * The Suspense boundary is OURS, not the host's: this is a fire-and-forget
 * mount with no visible chrome of its own, so making a host remember to wrap it
 * would be a rule whose only symptom when forgotten is a thrown promise at the
 * shell root. `null` is the right fallback — the component renders nothing
 * until a param is set, and the popups inside it carry their own skeletons.
 */
import { lazy, Suspense } from 'react';

const LazyChatRefPopupHost = lazy(
  () => import('../../../apps/operator/app/_components/chat/ChatRefPopupHost'),
);

export interface ChatRefPopupHostProps {
  /**
   * The MOUNTING HOST's own harness, used only when a ref did not carry one of
   * its own. The ref's harness always wins; this outranks only the operator's
   * URL/localStorage-resolved fallback, which a non-operator host has no
   * meaningful value for.
   */
  fallbackHarnessSlug?: string | null;
}

/**
 * The ref-popup renderer. Mount ONCE per host, inside both the nuqs adapter
 * (it reads query state) and the host's `SyncProvider` (both popups read
 * through `@papercusp/sync`).
 */
export function ChatRefPopupHost({ fallbackHarnessSlug }: ChatRefPopupHostProps = {}) {
  return (
    <Suspense fallback={null}>
      <LazyChatRefPopupHost fallbackHarnessSlug={fallbackHarnessSlug} />
    </Suspense>
  );
}

export default ChatRefPopupHost;
