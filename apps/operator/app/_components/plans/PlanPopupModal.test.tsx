// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

vi.mock('@/app/harness/Modal', () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="plan-popup-modal">{children}</div> : null,
}));

vi.mock('@/app/admin/plans/PlanDetail', () => ({
  default: () => <div data-testid="plan-detail" />,
}));

vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn().mockResolvedValue(true), element: null }),
}));

vi.mock('./PlanSessionsTab', () => ({
  default: () => <div data-testid="plan-sessions" />,
}));

import PlanPopupModal from './PlanPopupModal';

afterEach(cleanup);

const renderPopup = (origin: 'scout' | null) =>
  render(
    <NuqsTestingAdapter searchParams="">
      <PlanPopupModal
        planSlug="provenance-plan"
        harnessSlug="papercusp"
        planTitle="Provenance plan"
        origin={origin}
        onClose={() => {}}
      />
    </NuqsTestingAdapter>,
  );

describe('PlanPopupModal provenance', () => {
  it.each([
    ['scout', 'Blender', 'blender'],
    [null, 'Outside Blender', 'outside-blender'],
  ] as const)('renders %s as %s in the popup header', (origin, label, dataValue) => {
    renderPopup(origin);
    const badge = screen.getByTestId('plan-popup-provenance-badge');
    expect(badge.textContent).toBe(label);
    expect(badge.getAttribute('data-plan-provenance')).toBe(dataValue);
    expect(badge.getAttribute('aria-label')).toBe(`Plan source: ${label}`);
  });
});
