/**
 * Service health (P-005) — up/down + latency probe of the dev endpoints
 * (:3070 operator, :3055 vite, :4321 shop, :3350 scout, :3001 web, :8082
 * code-server, + the Tauri desktop). Reads the `dev.serviceHealth` sync query
 * (a snapshot wrapped in a 1-element array → data[0]); manual refresh re-probes.
 * The background DBOS monitor independently broadcasts drop/recover coord
 * messages; this is the on-demand snapshot.
 */
import { useSyncQuery } from '@papercusp/sync';
import { PanelBar, PanelState } from '../panel-kit';

interface ProbeResult {
  name: string;
  up: boolean;
  status: number | null;
  latencyMs: number;
  present?: boolean;
  note?: string;
  recentErrors?: number;
}

export default function ServiceHealthPanel({ active }: { active: boolean }) {
  const sync = useSyncQuery<{ services: ProbeResult[] }>({
    queryName: 'dev.serviceHealth',
    enabled: active,
    staleTime: 10_000,
  });
  const services = sync.data?.[0]?.services ?? [];

  return (
    <div className="pcdar-panel">
      <PanelBar label="Service health" fetching={sync.fetching} onRefresh={sync.invalidate} />
      <PanelState
        loading={sync.loading}
        error={sync.error}
        empty={services.length === 0}
        emptyHint="No probe data."
      />
      {services.map((s) => {
        const absent = s.present === false;
        const dotClass = absent ? 'is-absent' : s.up ? 'is-up' : 'is-down';
        const sub = absent
          ? (s.note ?? 'not running')
          : `${s.status ?? '—'} · ${s.latencyMs}ms${s.recentErrors ? ` · ${s.recentErrors} err` : ''}`;
        return (
          <div key={s.name} className="pcdar-row">
            <span className={`pcdar-dot ${dotClass}`} aria-hidden="true" />
            <div className="pcdar-row__main">
              <div className="pcdar-row__title">{s.name}</div>
              <div className="pcdar-row__sub" title={s.note ?? undefined}>
                {sub}
              </div>
            </div>
            <span className={`pcdar-pill ${absent ? '' : s.up ? 'is-good' : 'is-bad'}`}>
              {absent ? 'absent' : s.up ? 'up' : 'down'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
