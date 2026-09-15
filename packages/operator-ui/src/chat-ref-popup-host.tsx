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
 */
import { lazy } from 'react';

/**
 * The ref-popup renderer. Mount ONCE per host, inside both the nuqs adapter
 * (it reads query state) and the host's `SyncProvider` (both popups read
 * through `@papercusp/sync`).
 *
 * `fallbackHarnessSlug` is the host's own harness, used only when a ref did not
 * carry one of its own — the ref's harness always wins.
 */
export const ChatRefPopupHost = lazy(
  () => import('../../../apps/operator/app/_components/chat/ChatRefPopupHost'),
);

export default ChatRefPopupHost;
