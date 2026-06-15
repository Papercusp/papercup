// @vitest-environment jsdom
//
// PlanEditorPanel — the create:plan-editor dock panel. A thin wrapper over the
// heavy PlanDetail, but with real wiring worth pinning: the no-slug empty
// branch, threading ?plan into PlanDetail, syncing the tab title to the slug,
// and registering a close-guard backed by PlanDetail's dirty state (the guard
// reports "can close silently" only while not dirty). PlanDetail + the
// close-guard registry are stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { guard } = vi.hoisted(() => ({
  guard: { registered: [] as Array<{ panelId: string; canClose: () => boolean }>, dispose: vi.fn() },
}));

vi.mock('@/app/harness/dock/close-guard', () => ({
  registerCloseGuard: (panelId: string, canClose: () => boolean) => {
    guard.registered.push({ panelId, canClose });
    return guard.dispose;
  },
}));

// PlanDetail → a marker echoing its slug; expose onDirtyChange so the test can
// flip the dirty flag and observe the close-guard's verdict.
let lastOnDirtyChange: ((d: boolean) => void) | null = null;
vi.mock('@/app/admin/plans/PlanDetail', () => ({
  default: ({ slug, onDirtyChange }: { slug: string; onDirtyChange: (d: boolean) => void }) => {
    lastOnDirtyChange = onDirtyChange;
    return <div data-testid="plan-detail">{slug}</div>;
  },
}));

import PlanEditorPanel from './PlanEditorPanel';

function mkProps(params: Record<string, unknown>) {
  return { panelId: 'panel-1', panelType: 'create:plan-editor', params, api: { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() } };
}

beforeEach(() => {
  guard.registered = [];
  lastOnDirtyChange = null;
});
afterEach(() => cleanup());

describe('<PlanEditorPanel />', () => {
  it('renders the empty hint when no ?plan is set', () => {
    render(<PlanEditorPanel {...mkProps({})} />);
    expect(screen.getByText(/no plan selected/i)).toBeTruthy();
    expect(screen.queryByTestId('plan-detail')).toBeNull();
  });

  it('renders PlanDetail for the ?plan slug and syncs the tab title', () => {
    const props = mkProps({ plan: 'my-plan' });
    render(<PlanEditorPanel {...props} />);
    expect(screen.getByTestId('plan-detail').textContent).toBe('my-plan');
    expect(props.api.setTitle).toHaveBeenCalledWith('my-plan');
  });

  it('registers a close-guard that blocks closing only while PlanDetail is dirty', () => {
    render(<PlanEditorPanel {...mkProps({ plan: 'my-plan' })} />);
    expect(guard.registered).toHaveLength(1);
    const { canClose } = guard.registered[0];
    // clean by default → can close silently
    expect(canClose()).toBe(true);
    // PlanDetail reports dirty → guard now blocks the silent close
    lastOnDirtyChange?.(true);
    expect(canClose()).toBe(false);
    // back to clean → can close again
    lastOnDirtyChange?.(false);
    expect(canClose()).toBe(true);
  });
});
