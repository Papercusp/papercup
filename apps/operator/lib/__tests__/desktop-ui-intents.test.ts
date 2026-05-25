import { describe, expect, it } from 'vitest';
import { shouldEnableRemoteUiIntents } from '../ui/desktop-ui-intents';

describe('desktop UI intents host policy', () => {
  it('disables remote UI intents on static desktop hosts', () => {
    expect(shouldEnableRemoteUiIntents('http://localhost:3070')).toBe(false);
    expect(shouldEnableRemoteUiIntents('http://127.0.0.1:3070')).toBe(false);
    expect(shouldEnableRemoteUiIntents('http://localhost:4173')).toBe(false);
    expect(shouldEnableRemoteUiIntents('http://127.0.0.1:4173')).toBe(false);
  });

  it('keeps remote UI intents enabled on the legacy HMR/web host', () => {
    expect(shouldEnableRemoteUiIntents('http://localhost:3055')).toBe(true);
  });
});
