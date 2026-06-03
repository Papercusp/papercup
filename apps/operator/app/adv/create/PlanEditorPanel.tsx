'use client';

/**
 * create:plan-editor dock panel — the full plan editor (PlanDetail) for one
 * plan, opened on demand (openPlanEditor → openPanel). Multiple plans can be
 * open as separate panels/tabs (vs PlansClient's single full-width editor).
 *
 * Registers a close-guard backed by PlanDetail's unsaved-edit state — the
 * dock prompts before closing a dirty editor (replaces PlansClient's
 * leaveGuard). keepAlive preserves the editor across tab switches.
 */

import { useEffect, useRef } from 'react';
import type { PanelComponentProps } from '@/app/harness/dock/panel-registry';
import PlanDetail from '@/app/admin/plans/PlanDetail';
import { registerCloseGuard } from '@/app/harness/dock/close-guard';

export default function PlanEditorPanel({ panelId, params, api }: PanelComponentProps) {
  const slug = typeof params.plan === 'string' ? params.plan : null;
  const dirtyRef = useRef(false);

  // Guard close while there are unsaved edits. canCloseSilently → !dirty.
  useEffect(() => registerCloseGuard(panelId, () => !dirtyRef.current), [panelId]);

  // Keep the tab title in sync with the slug.
  useEffect(() => {
    if (slug) api.setTitle(slug);
  }, [slug, api]);

  if (!slug) {
    return <div className="pc-items__detail-empty">No plan selected.</div>;
  }

  return (
    <PlanDetail
      key={slug}
      slug={slug}
      onClose={() => api.close()}
      onDirtyChange={(d: boolean) => {
        dirtyRef.current = d;
      }}
      startStatus={null}
      onStartStatusChange={() => {}}
      onPlanStatusChange={() => {}}
    />
  );
}
