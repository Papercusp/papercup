'use client';

import { useEffect, useState } from 'react';

interface Props {
  workspaceIds: string[] | null;
}

interface PluginHost {
  loaded?: number;
  errors?: number;
}

interface ActivityEntry {
  id: string;
  workspace_id: string;
  harness_slug: string | null;
  tool_name: string;
  role: string | null;
  invoked_at: string;
  duration_ms: number | null;
  status: string;
}

function fmtRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export default function RightRail({ workspaceIds }: Props) {
  const [pluginHost, setPluginHost] = useState<PluginHost | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    function refresh() {
      // Plugin host
      fetch('/api/plugins/host/refresh', { method: 'POST' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled || !d) return;
          setPluginHost(d.status ?? null);
        })
        .catch(() => {});
      // Activity feed
      const params = new URLSearchParams({
        workspace: 'default',
        role: 'architect',
        run: 'dev-page',
        spawn: 'dev-page',
      });
      fetch(`/api/agent-tools/dev/activity?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceIds, limit: 30 }),
      })
        .then(async (r) => {
          if (!r.ok) return;
          const d = await r.json();
          const parsed = JSON.parse(d.content[0].text);
          if (cancelled) return;
          setActivity(parsed.entries ?? []);
        })
        .catch(() => {});
    }
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [workspaceIds]);

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
        {activity.length === 0 && <div className="pc-dev-muted">no recent activity</div>}
        <ul className="pc-dev-activity">
          {activity.map((e) => (
            <li key={e.id} className="pc-dev-activity-row">
              <div className="pc-dev-activity-name">
                <span className={e.status !== 'ok' ? 'pc-dev-api-err' : ''}>
                  {e.tool_name}
                </span>
                <span className="pc-dev-activity-age">{fmtRel(e.invoked_at)}</span>
              </div>
              <div className="pc-dev-activity-meta">
                {e.harness_slug ?? e.workspace_id}
                {e.role && <> · {e.role}</>}
                {e.duration_ms != null && (
                  <> · {e.duration_ms < 1000 ? `${e.duration_ms}ms` : `${(e.duration_ms / 1000).toFixed(1)}s`}</>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
