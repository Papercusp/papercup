/**
 * @vitest-environment jsdom
 *
 * Tests for the per-tab UI client id (sessionStorage-backed, cached, SSR-safe).
 * Run with: cd packages/operator-core && npx vitest run lib/ui/client-id.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getOrCreateClientId, _resetClientIdCacheForTests } from './client-id';

const STORAGE_KEY = 'papercusp_ui_client_id';
const UUID_RE = /^[0-9a-f-]{36}$/i;

beforeEach(() => {
  window.sessionStorage.clear();
  _resetClientIdCacheForTests();
});
afterEach(() => {
  window.sessionStorage.clear();
  _resetClientIdCacheForTests();
});

describe('getOrCreateClientId', () => {
  it('mints a uuid-shaped id and persists it to sessionStorage', () => {
    const id = getOrCreateClientId();
    expect(id).toMatch(UUID_RE);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(id);
  });

  it('returns the same id on repeat calls (in-memory cache)', () => {
    expect(getOrCreateClientId()).toBe(getOrCreateClientId());
  });

  it('reads back the stored id after the cache is reset', () => {
    const first = getOrCreateClientId();
    _resetClientIdCacheForTests();
    expect(getOrCreateClientId()).toBe(first);
  });

  it('reuses a valid pre-existing sessionStorage value', () => {
    const preset = '12345678-1234-1234-1234-123456789abc';
    window.sessionStorage.setItem(STORAGE_KEY, preset);
    expect(getOrCreateClientId()).toBe(preset);
  });

  it('ignores a malformed stored value and mints a fresh one', () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'not-a-uuid');
    const id = getOrCreateClientId();
    expect(id).toMatch(UUID_RE);
    expect(id).not.toBe('not-a-uuid');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(id);
  });
});
