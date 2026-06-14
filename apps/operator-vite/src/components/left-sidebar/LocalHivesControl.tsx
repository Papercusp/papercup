/**
 * LocalHivesControl — the central start/stop control for this Swarm's LOCAL
 * hives (hive-control-surface). Reads `hive.controlState` (the persisted started
 * bit per registered hive) and toggles each via hive:start / hive:pause through
 * the shared runHiveControl dispatch.
 *
 * Before this, start/stop lived ONLY inside a single hive's status bar
 * (AdvNowRunning, N=1) — there was no one place to see every hive's started
 * state or flip them. This is that place. Mounted both at the top of the Hives
 * tab and inside the header HivesRunningPill popover (one control, two mounts).
 */
import { useCallback, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { runHiveControl, countStarted, type HiveControlRow } from '../adv/hive-control';

export default function LocalHivesControl() {
  const { data, loading, error } = useSyncQuery<HiveControlRow>({
    queryName: 'hive.controlState',
    args: {},
  });
  const hives = (data as HiveControlRow[] | undefined) ?? [];
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = useCallback(async (hive: HiveControlRow) => {
    const tool = hive.started ? 'hive:pause' : 'hive:start';
    if (
      hive.started &&
      !window.confirm(
        `Pause hive "${hive.slug}"? Live bees are asked to wrap up; no new wakes fire until Start.`,
      )
    ) {
      return;
    }
    setBusy(hive.slug);
    try {
      // Stop drains live bees; start just wakes the Queen.
      await runHiveControl(tool, hive.slug, hive.started ? { drainBees: true } : {});
      toast.success(hive.started ? 'Hive paused' : 'Hive started', { description: hive.slug });
    } catch (e) {
      toast.error(hive.started ? 'Pause failed' : 'Start failed', { description: String(e) });
    }
    // The hive.controlState invalidation fired by hive:start/pause refreshes the row.
    setBusy(null);
  }, []);

  return (
    <div className="pclsb-panel" data-testid="local-hives-control">
      <div className="pclsb-panel__bar">
        <span className="pclsb-panel__bar-label">
          local hives · {countStarted(hives)}/{hives.length} running
        </span>
      </div>
      {error && <div className="pclsb-panel__error">{String(error)}</div>}
      {hives.length === 0 && !loading && (
        <div className="pclsb-panel__empty">no local hives registered yet.</div>
      )}
      {hives.map((h) => (
        <div className="pclsb-row" key={h.slug} data-testid={`local-hive-${h.slug}`}>
          <span className={`pclsb-dot ${h.started ? 'is-up' : 'is-down'}`} aria-hidden="true" />
          <div className="pclsb-row__main">
            <div className="pclsb-row__title">{h.slug}</div>
            {/* State (started/stopped) is conveyed by the dot + the Start/Stop
                button now — only the watchdog warning needs its own sub-line. */}
            {h.watchdogFires24h ? (
              <div className="pclsb-row__sub" data-testid={`local-hive-watchdog-${h.slug}`}>
                ⚠ {h.watchdogFires24h} watchdog/24h
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className={`pclsb-hivebtn pclsb-hivebtn--${h.started ? 'stop' : 'start'}`}
            data-testid={`local-hive-toggle-${h.slug}`}
            aria-label={h.started ? `Stop hive ${h.slug}` : `Start hive ${h.slug}`}
            disabled={busy === h.slug}
            onClick={() => void toggle(h)}
          >
            {h.started ? <Square size={11} aria-hidden /> : <Play size={11} aria-hidden />}
            {busy === h.slug ? '…' : h.started ? 'Stop' : 'Start'}
          </button>
        </div>
      ))}
    </div>
  );
}
