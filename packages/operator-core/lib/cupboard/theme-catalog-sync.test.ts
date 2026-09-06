import { describe, expect, it, vi } from 'vitest';

const notify = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: notify }));

import { THEME_CATALOG_QUERY, notifyThemeCatalogChanged } from './theme-catalog-sync';

describe('notifyThemeCatalogChanged', () => {
  it('disables source dedupe so rapid update/remove invalidations are not dropped', async () => {
    await notifyThemeCatalogChanged();
    await notifyThemeCatalogChanged();

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(
      1,
      THEME_CATALOG_QUERY,
      undefined,
      undefined,
      { dedupeWindowMs: 0 },
    );
    expect(notify).toHaveBeenNthCalledWith(
      2,
      THEME_CATALOG_QUERY,
      undefined,
      undefined,
      { dedupeWindowMs: 0 },
    );
  });
});
