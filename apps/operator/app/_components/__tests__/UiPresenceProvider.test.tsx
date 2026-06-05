/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { UiPresenceProvider } from '../UiPresenceProvider';

const useUiPresence = vi.fn();
const UiIntentDispatcher = vi.fn(() => <div data-testid="ui-intent-dispatcher" />);
const shouldMountRemoteUiControl = vi.fn();

vi.mock('../../../lib/ui/use-ui-presence', () => ({
  useUiPresence: () => useUiPresence(),
}));

vi.mock('../../../lib/ui/intent-dispatcher', () => ({
  UiIntentDispatcher: () => UiIntentDispatcher(),
}));

vi.mock('@papercusp/operator-core/lib/ui/desktop-ui-intents', () => ({
  shouldMountRemoteUiControl: (...args: unknown[]) => shouldMountRemoteUiControl(...args),
}));

afterEach(() => {
  cleanup();
  useUiPresence.mockReset();
  UiIntentDispatcher.mockReset();
  shouldMountRemoteUiControl.mockReset();
});

describe('UiPresenceProvider', () => {
  it('does not mount remote UI control when static desktop policy disables it', () => {
    shouldMountRemoteUiControl.mockReturnValue(false);

    const { container } = render(<UiPresenceProvider />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('ui-intent-dispatcher')).toBeNull();
    expect(useUiPresence).not.toHaveBeenCalled();
    expect(UiIntentDispatcher).not.toHaveBeenCalled();
  });

  it('mounts remote UI control when the host policy allows it', () => {
    shouldMountRemoteUiControl.mockReturnValue(true);

    render(<UiPresenceProvider />);

    expect(useUiPresence).toHaveBeenCalled();
    expect(UiIntentDispatcher).toHaveBeenCalled();
    expect(screen.getByTestId('ui-intent-dispatcher')).toBeTruthy();
  });
});
