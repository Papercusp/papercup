import { describe, expect, it } from 'vitest';
import { shouldAutoReloadChunkFailure } from '../lazy-with-retry';

describe('lazyWithRetry chunk-failure auto reload policy', () => {
  it('never auto-reloads inside Tauri desktop shells', () => {
    expect(shouldAutoReloadChunkFailure(true, true, 'http://localhost:3055')).toBe(false);
    expect(shouldAutoReloadChunkFailure(true, true, 'http://localhost:3070')).toBe(false);
    expect(shouldAutoReloadChunkFailure(true, true, 'http://localhost:4173')).toBe(false);
  });

  it('suppresses auto-reload on no-HMR and preview hosts even outside explicit Tauri detection', () => {
    expect(shouldAutoReloadChunkFailure(true, false, 'http://localhost:3070')).toBe(false);
    expect(shouldAutoReloadChunkFailure(true, false, 'http://127.0.0.1:3070')).toBe(false);
    expect(shouldAutoReloadChunkFailure(true, false, 'http://localhost:4173')).toBe(false);
  });

  it('allows auto-reload only on the legacy 3055 HMR host when explicitly enabled', () => {
    expect(shouldAutoReloadChunkFailure(true, false, 'http://localhost:3055')).toBe(true);
    expect(shouldAutoReloadChunkFailure(false, false, 'http://localhost:3055')).toBe(false);
  });
});
