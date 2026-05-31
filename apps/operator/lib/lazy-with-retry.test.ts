/**
 * Coverage for lazy-with-retry.shouldAutoReloadChunkFailure — the pure
 * decision of whether a chunk-load failure should force a full reload: off when
 * disabled, in the Tauri desktop, or on the operator (:3070) / preview (:4173)
 * origins; on for ordinary dev origins. (lazyWithRetry itself is render-time.)
 */
import { describe, expect, it } from 'vitest';
import { shouldAutoReloadChunkFailure } from './lazy-with-retry';

describe('shouldAutoReloadChunkFailure', () => {
  it('is false when reloadOnFail is off', () => {
    expect(shouldAutoReloadChunkFailure(false, false, 'http://localhost:5173')).toBe(false);
  });
  it('is false in the Tauri desktop (a reload would re-fetch the bundled chunk graph pointlessly)', () => {
    expect(shouldAutoReloadChunkFailure(true, true, 'http://localhost:5173')).toBe(false);
  });
  it('is false on the operator + preview origins', () => {
    for (const o of ['http://localhost:3070', 'http://127.0.0.1:3070', 'http://localhost:4173', 'http://127.0.0.1:4173']) {
      expect(shouldAutoReloadChunkFailure(true, false, o)).toBe(false);
    }
  });
  it('is true for an ordinary dev origin (and when origin is unknown)', () => {
    expect(shouldAutoReloadChunkFailure(true, false, 'http://localhost:5173')).toBe(true);
    expect(shouldAutoReloadChunkFailure(true, false, undefined)).toBe(true);
  });
});
