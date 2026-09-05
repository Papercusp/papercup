// @vitest-environment jsdom
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { parseAsString, useQueryState } from 'nuqs';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

vi.mock('../../../../../packages/operator-ui/src/grid-theme-bridge', () => ({}));
vi.mock('../../../../operator-vite/src/components/adv/adv-pot-bar-tabs', () => ({
  POT_BAR_TAB_IDS: [], potBarModeForTab: () => null,
}));
vi.mock('@/app/adv/create/use-create-data', () => ({
  useResolvedHarnessSlug: () => null,
}));
// Exercise the exported portal composition and its real URL reader. The
// dashboard writer and editor body have their own suites; neither is a host.
vi.mock('./PlansPane', () => ({
  default: () => {
    const [, setPlan] = useQueryState('wppop', parseAsString);
    return <button onClick={() => void setPlan('papercusp::example-plan')}>Open full plan</button>;
  },
}));
vi.mock('./PlanPopupModal', () => ({
  default: ({ planSlug, harnessSlug, onClose }: {
    planSlug: string; harnessSlug: string; onClose: () => void;
  }) => <div role="dialog" aria-label={`${harnessSlug}::${planSlug}`}>
    Full plan body<button onClick={onClose}>Close plan</button>
  </div>,
}));

import { OPERATOR_SURFACES } from '../../../../../packages/operator-ui/src/surfaces';

afterEach(cleanup);

describe('portal Plans surface popup composition (WI-2146534)', () => {
  it('opens and closes the scoped full plan without an operator router host', async () => {
    const Plans = OPERATOR_SURFACES.plans;
    render(<NuqsTestingAdapter hasMemory searchParams="?app=plans">
      <Suspense fallback={null}><Plans /></Suspense>
    </NuqsTestingAdapter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open full plan' }));
    expect(await screen.findByRole('dialog', { name: 'papercusp::example-plan' })).toBeTruthy();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Open full plan' })).toBeTruthy();
  });
});
