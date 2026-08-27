'use client';

/**
 * PlanPopupModal (owner-plans-single-pane-2026-07-17 P-003) — the plan opened
 * as a POPUP from the sidebar Plans face, instead of a navigation.
 *
 * READ-FIRST (D-001): the body is the SAME PlanDetail the Create tab renders
 * (4th mount context — /admin/plans, MainViewPanel, PlanEditorPanel, here),
 * which already defaults to its read/preview pane; editing stays one click
 * away inside the component. Tracking ≠ authoring — the Create dock keeps the
 * authoring posture.
 *
 * Known re-host traps, both handled (the dock's clipping lesson):
 *   - PlanDetail relies on a `.pc-plans__main` scroller for its overflow —
 *     provided here by `.plan-popup__body` (see plans-pane.css);
 *   - a dirty editor must not be silently discarded on close — PlanDetail's
 *     onDirtyChange feeds the useConfirmDialog guard (MainViewPanel pattern).
 *
 * Second tab (P-005): Sessions — every agent session that touched this plan,
 * with transcript search (PlanSessionsTab). Tab state is `?ppv` (nuqs, D-003)
 * so the popup is deep-linkable + agent-driveable.
 */
import { useRef } from 'react';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import { Modal } from '@/app/harness/Modal';
import PlanDetail from '@/app/admin/plans/PlanDetail';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import PlanSessionsTab from './PlanSessionsTab';
import PlanProvenanceBadge from './PlanProvenanceBadge';
// PlanDetail's chrome (pc-plans__*) is global CSS; importing it here makes the
// popup self-sufficient wherever the sidebar mounts (InboxPane precedent).
import '@/app/admin/plans/plans.css';
import './plans-pane.css';

const POPUP_VIEWS = ['plan', 'sessions'] as const;
export type PlanPopupView = (typeof POPUP_VIEWS)[number];

export default function PlanPopupModal({
  planSlug,
  harnessSlug,
  planTitle,
  origin,
  onClose,
}: {
  /** The open plan — null renders nothing (closed). */
  planSlug: string | null;
  /** The plan's OWN harness (from the loaded list row) — scoping plans:get to
   *  the wrong harness is the Create tab's old "Server: not_found" trap. */
  harnessSlug: string | null;
  planTitle?: string | null;
  /** Canonical plan-content provenance projected by plans:list. */
  origin?: 'scout' | null;
  onClose: () => void;
}) {
  const [view, setView] = useQueryState(
    'ppv',
    parseAsStringEnum<PlanPopupView>([...POPUP_VIEWS]).withDefault('plan'),
  );
  const dirtyRef = useRef(false);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  const open = planSlug !== null;

  const reallyClose = () => {
    dirtyRef.current = false;
    void setView(null); // drop ?ppv so the next open lands on the Plan tab
    onClose();
  };

  const guardedClose = () => {
    if (dirtyRef.current) {
      void askConfirm({
        title: 'Discard unsaved edits?',
        body: 'Your current plan edits will be discarded.',
        confirmLabel: 'Discard',
        destructive: true,
      }).then((ok) => {
        if (ok) reallyClose();
      });
      return;
    }
    reallyClose();
  };

  return (
    <>
      {open ? (
        <Modal
          open
          onOpenChange={(o) => {
            if (!o) guardedClose();
          }}
          title={planTitle ?? planSlug ?? 'Plan'}
          srOnlyTitle
          contentClassName="plan-popup"
          contentStyle={{
            width: 'min(1100px, 94vw)',
            height: 'min(860px, calc(100vh - 4rem))',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            padding: 0,
          }}
        >
          <div className="plan-popup__header">
            <div className="plan-popup__identity">
              <div className="plan-popup__title" title={planSlug ?? undefined}>
                {planTitle ?? planSlug}
              </div>
              <PlanProvenanceBadge origin={origin} testId="plan-popup-provenance-badge" />
            </div>
            <div className="plan-popup__tabs" role="tablist" aria-label="Plan popup view">
              <button
                type="button"
                role="tab"
                aria-selected={view === 'plan'}
                className={`plan-popup__tab${view === 'plan' ? ' is-on' : ''}`}
                onClick={() => void setView('plan')}
                data-testid="plan-popup-tab-plan"
              >
                Plan
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'sessions'}
                className={`plan-popup__tab${view === 'sessions' ? ' is-on' : ''}`}
                onClick={() => void setView('sessions')}
                data-testid="plan-popup-tab-sessions"
              >
                Sessions
              </button>
            </div>
            <button
              type="button"
              className="plan-popup__close"
              onClick={guardedClose}
              aria-label="Close plan popup"
              data-testid="plan-popup-close"
            >
              ✕
            </button>
          </div>
          {view === 'sessions' ? (
            <PlanSessionsTab planSlug={planSlug!} harnessSlug={harnessSlug} />
          ) : (
            <div className="pc-plans__main plan-popup__body" data-testid="plan-popup-body">
              <PlanDetail
                key={planSlug}
                slug={planSlug!}
                harnessSlug={harnessSlug}
                showBack={false}
                onClose={guardedClose}
                onDirtyChange={(d: boolean) => {
                  dirtyRef.current = d;
                }}
                startStatus={null}
                onStartStatusChange={() => {}}
                onPlanStatusChange={() => {}}
              />
            </div>
          )}
        </Modal>
      ) : null}
      {confirmEl}
    </>
  );
}
