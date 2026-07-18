/**
 * resource-profile.test.ts — EI-2403 regression.
 *
 * `detectEmbeddedPg()` must classify "an embedded PG shares this box" ONLY off
 * the DISCOVERY-FILE source (the desktop's Tauri-written ~/.papercusp/embedded-pg.json)
 * — never off an explicitly-set env URL (HARNESS_ADMIN_DATABASE_URL / DATABASE_URL /
 * PAPERCUSP_PG_URL), which a dedicated native-PG server (the dev box, any production
 * server) also sets. Pins the exact regression: a `source: 'env'` admin URL used to
 * read embeddedPg=true (misclassifying a dedicated server as sharing an embedded PG).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./embedded-pg-discovery', () => ({ getHarnessAdminUrlWithSource: vi.fn() }));

import { getHarnessAdminUrlWithSource } from './embedded-pg-discovery';
import { detectEmbeddedPg } from './resource-profile';

const getUrl = vi.mocked(getHarnessAdminUrlWithSource);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('detectEmbeddedPg (EI-2403)', () => {
  it('discovery-file source (the desktop\'s Tauri-written embedded-pg.json) ⇒ embedded', () => {
    getUrl.mockReturnValue({ url: 'postgresql://x', source: 'discovery-file' });
    expect(detectEmbeddedPg()).toBe(true);
  });

  it('env source (an explicit DATABASE_URL, e.g. a dedicated dev/prod server) ⇒ NOT embedded', () => {
    getUrl.mockReturnValue({ url: 'postgresql://x', source: 'env' });
    expect(detectEmbeddedPg()).toBe(false);
  });

  it('native-fallback source (zero-config dev, no discovery file) ⇒ NOT embedded', () => {
    getUrl.mockReturnValue({ url: 'postgresql://x', source: 'native-fallback' });
    expect(detectEmbeddedPg()).toBe(false);
  });
});
