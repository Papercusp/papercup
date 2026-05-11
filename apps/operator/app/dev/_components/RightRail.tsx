'use client';

import { useEffect, useState } from 'react';

interface Props {
  workspaceIds: string[] | null;
}

interface PluginHost {
  loaded?: number;
  errors?: number;
  plugins?: Array<{ name: string; version: string; source: string }>;
}

export default function RightRail(_props: Props) {
  const [pluginHost, setPluginHost] = useState<PluginHost | null>(null);

  useEffect(() => {
    let cancelled = false;
    function refresh() {
      fetch('/api/plugins/host/refresh', { method: 'POST' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled || !d) return;
          setPluginHost(d.status ?? null);
        })
        .catch(() => {});
    }
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="pc-dev-rail-content">
      <section className="pc-dev-rail-block">
        <h3 className="pc-dev-rail-h">Plugin host</h3>
        {!pluginHost && <div className="pc-dev-muted">…</div>}
        {pluginHost && (
          <div className="pc-dev-rail-stats">
            <div>
              <span className="pc-dev-muted">loaded</span>
              <strong>{pluginHost.loaded ?? 0}</strong>
            </div>
            <div>
              <span className="pc-dev-muted">errors</span>
              <strong className={pluginHost.errors ? 'pc-dev-api-err' : ''}>
                {pluginHost.errors ?? 0}
              </strong>
            </div>
          </div>
        )}
      </section>
      <section className="pc-dev-rail-block">
        <h3 className="pc-dev-rail-h">Activity</h3>
        <div className="pc-dev-muted">activity feed — coming next stage.</div>
      </section>
    </div>
  );
}
