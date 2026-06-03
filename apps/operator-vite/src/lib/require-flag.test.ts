/**
 * Coverage for the SPA flag gate `requireFlag()` — the operator-vite port of
 * the former Next Server-Component gate (moved here in the Next→Vite
 * migration; see plan `finish-next-removal-2026-06-01`). Behaviour parity:
 *   - flag on  → resolves (route renders).
 *   - flag off → `throw notFound()` (TanStack Router renders notFoundComponent).
 *   - flags unreachable → `loadFlags()` rejects → falls back to FLAG_DEFAULTS
 *     (a closed gate) → `throw notFound()`.
 *
 * `@tanstack/react-router` notFound + `@papercusp/flags/client` are mocked;
 * FLAG_DEFAULTS (real) supplies the closed-gate fallback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlagKey } from '@papercusp/flags';

const NOT_FOUND = new Error('NOT_FOUND');
const notFound = vi.fn(() => {
  throw NOT_FOUND;
});
vi.mock('@tanstack/react-router', () => ({ notFound: () => notFound() }));

const loadFlags = vi.fn();
const getFlagSnapshot = vi.fn();
vi.mock('@papercusp/flags/client', () => ({
  loadFlags: () => loadFlags(),
  getFlagSnapshot: () => getFlagSnapshot(),
}));

import { requireFlag } from './require-flag';

const KEY = 'snapshots' as FlagKey;
afterEach(() => vi.clearAllMocks());

describe('requireFlag', () => {
  it('resolves (no notFound) when the flag is on', async () => {
    loadFlags.mockResolvedValue(undefined);
    getFlagSnapshot.mockReturnValue({ flags: { [KEY]: true } });
    await expect(requireFlag(KEY)).resolves.toBeUndefined();
    expect(notFound).not.toHaveBeenCalled();
  });

  it('throws notFound() when the flag is off', async () => {
    loadFlags.mockResolvedValue(undefined);
    getFlagSnapshot.mockReturnValue({ flags: { [KEY]: false } });
    await expect(requireFlag(KEY)).rejects.toBe(NOT_FOUND);
    expect(notFound).toHaveBeenCalledOnce();
  });

  it('falls back to the closed FLAG_DEFAULTS gate when flags are unreachable', async () => {
    // loadFlags rejects (network failure); the snapshot then carries no entry
    // for KEY, so requireFlag must fall back to FLAG_DEFAULTS[KEY] (false → closed).
    loadFlags.mockRejectedValue(new Error('network'));
    getFlagSnapshot.mockReturnValue({ flags: {} });
    await expect(requireFlag(KEY)).rejects.toBe(NOT_FOUND);
    expect(notFound).toHaveBeenCalledOnce();
  });
});
