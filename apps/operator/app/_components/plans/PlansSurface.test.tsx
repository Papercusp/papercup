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
import { ChatRefPopupHost } from '../../../../../packages/operator-ui/src/chat-ref-popup-host';

afterEach(cleanup);

// WI-10001509 MOVED THE MOUNT, so this suite moved with it. WI-2146534
// originally asserted the Plans SURFACE opened the popup by itself, because an
// external host had no popup host of its own. It does now: the host mounts the
// shared `ChatRefPopupHost` ONCE at its shell root, so the surface carrying a
// second one would render `wppop` twice — two stacked popups, the exact failure
// WI-6601's singleton exists to prevent. The guarantee under test is therefore
// no longer "the surface opens it" but "the composition opens exactly one".
describe('portal Plans surface popup composition (WI-2146534, remounted by WI-10001509)', () => {
  const renderPlans = (withHost: boolean) => {
    const Plans = OPERATOR_SURFACES.plans;
    return render(<NuqsTestingAdapter hasMemory searchParams="?app=plans">
      <Suspense fallback={null}><Plans /></Suspense>
      {withHost ? <ChatRefPopupHost fallbackHarnessSlug="papercusp" /> : null}
    </NuqsTestingAdapter>);
  };

  it('opens and closes the scoped full plan when the host mounts the popup host', async () => {
    renderPlans(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Open full plan' }));
    expect(await screen.findByRole('dialog', { name: 'papercusp::example-plan' })).toBeTruthy();
    // The singleton contract: ONE mount, so exactly one dialog even though the
    // surface and the host are composed together.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Open full plan' })).toBeTruthy();
  });

  it('does NOT carry its own popup host, so a mounting host cannot double it', async () => {
    // The falsifier for the change above: if the surface ever re-acquires a
    // popup host, this renders a dialog with no host mounted and fails here —
    // which is cheaper than discovering it as two stacked popups on :3081.
    renderPlans(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Open full plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
