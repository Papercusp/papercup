// @vitest-environment jsdom
/**
 * shortcut-shim.test.tsx — whole-app-coverage P-008.
 *
 * RegistryShortcuts auto-binds every SHORTCUT that carries a `command` to the
 * action registry (a fallback for shortcuts whose components aren't mounted).
 * The hotkeys hook, the command registry, and the lazy defs import are mocked
 * so the test is hermetic; we assert one binding per command-bound shortcut and
 * that the component renders nothing visible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('@papercusp/operator-core/lib/shortcut-registry', () => ({
  SHORTCUTS: [
    { id: 'with-cmd-a', command: 'cmd.a' },
    { id: 'no-cmd' },
    { id: 'with-cmd-c', command: 'cmd.c' },
  ],
}));
vi.mock('../../hotkeys', () => ({ useShortcutAction: vi.fn() }));
vi.mock('@papercusp/operator-core/lib/commands/registry', () => ({ runCommand: vi.fn() }));
vi.mock('@papercusp/operator-core/lib/commands/defs/index', () => ({}));

import { RegistryShortcuts } from './shortcut-shim';
import { useShortcutAction } from '../../hotkeys';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('RegistryShortcuts', () => {
  it('binds one action per command-bound shortcut, skipping those without a command', () => {
    render(<RegistryShortcuts />);
    // 3 shortcuts, only 2 carry a `command`.
    expect(useShortcutAction).toHaveBeenCalledTimes(2);
    expect((useShortcutAction as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('with-cmd-a');
    expect((useShortcutAction as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe('with-cmd-c');
  });

  it('renders no visible output', () => {
    const { container } = render(<RegistryShortcuts />);
    expect(container.textContent).toBe('');
  });
});
