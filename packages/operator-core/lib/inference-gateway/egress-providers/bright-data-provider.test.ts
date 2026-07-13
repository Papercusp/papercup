/**
 * bright-data-provider.test.ts — the BrightDataProvider stub (D-001 fallback path, B-PROV, WI-288).
 * Run: cd packages/operator-core && npx vitest run lib/inference-gateway/egress-providers/bright-data-provider.test.ts
 */
import { describe, expect, it } from 'vitest';
import { createBrightDataProvider } from './bright-data-provider';

describe('createBrightDataProvider', () => {
  it('is named brightdata', () => {
    expect(createBrightDataProvider().name).toBe('brightdata');
  });

  it('allocate rejects with a clear "stub, not implemented" error', async () => {
    await expect(createBrightDataProvider().allocate('acct-a')).rejects.toThrow(/stub.*not implemented/i);
  });

  it('release rejects with a clear "stub, not implemented" error', async () => {
    await expect(createBrightDataProvider().release('id-1')).rejects.toThrow(/stub.*not implemented/i);
  });

  it('healthcheck rejects with a clear "stub, not implemented" error', async () => {
    await expect(createBrightDataProvider().healthcheck('id-1')).rejects.toThrow(/stub.*not implemented/i);
  });

  it('list resolves to an empty array (a harmless, truthful no-op probe)', async () => {
    await expect(createBrightDataProvider().list()).resolves.toEqual([]);
  });
});
