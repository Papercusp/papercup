'use client';

import { useEffect, useState } from 'react';
import { MarketplaceIndex } from '@papercup/marketplace-public-ui';

interface CatalogEntry {
  kind?: 'plugin' | 'template' | 'snapshot';
}

export default function Page() {
  const [counts, setCounts] = useState<{
    templates?: number;
    plugins?: number;
    snapshots?: number;
  }>({});

  // Live-count fetch from the local marketplace catalog. Failure
  // degrades to the static index — the static-export marketplace site
  // at papercuspai.com renders the same component without this fetch,
  // and we want both surfaces to look identical when counts can't load.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/marketplace/catalog', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.catalog) return;
        const next = { templates: 0, plugins: 0, snapshots: 0 };
        for (const entry of data.catalog as CatalogEntry[]) {
          if (entry.kind === 'plugin') next.plugins++;
          else if (entry.kind === 'snapshot') next.snapshots++;
          else next.templates++;
        }
        setCounts(next);
      })
      .catch(() => {
        // Silent — graceful degradation to no-count display.
      });
    return () => { cancelled = true; };
  }, []);

  return <MarketplaceIndex counts={counts} />;
}
