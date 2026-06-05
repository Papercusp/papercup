import { describe, expect, it } from 'vitest';
import { shouldMountRemoteUiControl } from '../ui/desktop-ui-intents';

describe('remote UI control host policy', () => {
  it('mounts on the operator host — dev Vite and the shipped desktop', () => {
    // :3055 = Vite dev server; :3070 = operator host (dev + prod). Both
    // front a live Hono backend, so the agent → UI control surface mounts.
    expect(shouldMountRemoteUiControl('http://localhost:3055')).toBe(true);
    expect(shouldMountRemoteUiControl('http://localhost:3070')).toBe(true);
    expect(shouldMountRemoteUiControl('http://127.0.0.1:3070')).toBe(true);
    expect(shouldMountRemoteUiControl('http://localhost:3070/')).toBe(true);
    expect(shouldMountRemoteUiControl('http://127.0.0.1:3070/')).toBe(true);
  });

  it('stays off on the backend-less build-preview host (:4173)', () => {
    // `vite preview` serves static dist with no /api backend — presence +
    // intent SSE would 404, so the surface must not mount.
    expect(shouldMountRemoteUiControl('http://localhost:4173')).toBe(false);
    expect(shouldMountRemoteUiControl('http://127.0.0.1:4173')).toBe(false);
    expect(shouldMountRemoteUiControl('http://localhost:4173/')).toBe(false);
    expect(shouldMountRemoteUiControl('http://127.0.0.1:4173/')).toBe(false);
  });
});
