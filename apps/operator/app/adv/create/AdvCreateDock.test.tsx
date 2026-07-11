// @vitest-environment jsdom
//
// AdvCreateDock — the /adv Create dockview shell (fixed sidebar|main split).
// Effect-only mount around <HarnessDock>; the assertable surface is the fixed
// `adv-create2` layout name, the two-panel registration on mount, and the
// exported `ensureCreatePanelsRegistered` idempotency. HarnessDock + dock-actions
// + the two panel children are stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const registerSpy = vi.fn();
vi.mock('../../harness/dock/HarnessDock', () => ({
  HarnessDock: ({ layoutName }: { layoutName: string }) => (
    <div data-testid="harness-dock" data-layout={layoutName} />
  ),
}));
vi.mock('../../harness/dock/panel-registry', () => ({
  panelRegistry: { register: (...args: unknown[]) => registerSpy(...args) },
}));
vi.mock('../../harness/dock/dock-actions', () => ({
  onDockApiBind: vi.fn(() => () => {}),
}));
vi.mock('./PlansListPanel', () => ({
  default: () => null,
  CreateViewRail: () => <nav aria-label="Create view" data-testid="create-view-rail" />,
}));
vi.mock('./MainViewPanel', () => ({ default: () => null }));
// The shell imports a sibling CSS file by side effect; stub to a no-op module.
vi.mock('../harnesses/adv-dock.css', () => ({}));

import AdvCreateDock, { ensureCreatePanelsRegistered } from './AdvCreateDock';

afterEach(cleanup);

describe('AdvCreateDock', () => {
  it('registers the create:filter + create:main panels on first mount', () => {
    render(<AdvCreateDock />);
    const types = registerSpy.mock.calls.map((c) => c[0]);
    expect(types).toContain('create:filter');
    expect(types).toContain('create:main');
  });

  it('mounts HarnessDock with the fixed adv-create2 layout', () => {
    render(<AdvCreateDock />);
    expect(screen.getByTestId('harness-dock').getAttribute('data-layout')).toBe('adv-create2');
    expect(screen.getByTestId('create-view-rail')).toBeTruthy();
    expect(screen.getByTestId('harness-dock').parentElement?.classList.contains('pc-adv-create__dock')).toBe(true);
  });

  it('ensureCreatePanelsRegistered is idempotent (the registered guard)', () => {
    // Already registered on first import/mount above → a direct call adds none.
    const before = registerSpy.mock.calls.length;
    ensureCreatePanelsRegistered();
    ensureCreatePanelsRegistered();
    expect(registerSpy.mock.calls.length).toBe(before);
  });
});
