import { describe, expect, it } from 'vitest';
import { shouldEnableRemoteUiIntents, shouldMountRemoteUiControl } from '../ui/desktop-ui-intents';

describe('desktop UI intents host policy', () => {
  it('disables all remote UI control on static desktop hosts', () => {
    expect(shouldEnableRemoteUiIntents('http://localhost:3070')).toBe(false);
    expect(shouldEnableRemoteUiIntents('http://127.0.0.1:3070')).toBe(false);
    expect(shouldEnableRemoteUiIntents('http://localhost:4173')).toBe(false);
    expect(shouldEnableRemoteUiIntents('http://127.0.0.1:4173')).toBe(false);
  });

  it('keeps remote UI intents enabled on the legacy HMR/web host', () => {
    expect(shouldEnableRemoteUiIntents('http://localhost:3055')).toBe(true);
  });
  it('keeps UiPresenceProvider fully unmounted on static desktop hosts', () => {
    expect(shouldMountRemoteUiControl('http://localhost:3070')).toBe(false);
    expect(shouldMountRemoteUiControl('http://127.0.0.1:3070')).toBe(false);
    expect(shouldMountRemoteUiControl('http://localhost:4173')).toBe(false);
    expect(shouldMountRemoteUiControl('http://127.0.0.1:4173')).toBe(false);
    expect(shouldMountRemoteUiControl('http://localhost:3055')).toBe(true);
  });
  it('keeps both remote-ui policy helpers in sync for known hosts', () => {
    const hosts = [
      'http://localhost:3070',
      'http://127.0.0.1:3070',
      'http://localhost:4173',
      'http://127.0.0.1:4173',
      'http://localhost:3055',
    ];
    for (const host of hosts) {
      expect(shouldMountRemoteUiControl(host)).toBe(shouldEnableRemoteUiIntents(host));
    }
  });
});
