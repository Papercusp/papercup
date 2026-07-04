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
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import { useLexicon } from '@/lib/useLexicon';
import { runHiveControl, countStarted, type HiveControlRow } from '../adv/hive-control';

export default function LocalHivesControl() {
  const t = useLexicon();
  const { data, loading, error } = useSyncQuery<HiveControlRow>({
    queryName: 'hive.controlState',
    args: {},
  });
  const hives = (data as HiveControlRow[] | undefined) ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  const toggle = useCallback(async (hive: HiveControlRow) => {
    const tool = hive.started ? 'hive:pause' : 'hive:start';
    if (
      hive.started &&
      !await askConfirm({
        title: `Pause ${hive.slug}?`,
        body: `Live ${t('contributor', { plural: true, lower: true })} are asked to wrap up; no new wakes fire until Start.`,
        confirmLabel: `Pause ${t('pot', { lower: true })}`,
        destructive: true,
      })
    ) {
      return;
    }
    setBusy(hive.slug);
    try {
      // Stop drains live bees; start just wakes the Queen.
      await runHiveControl(tool, hive.slug, hive.started ? { drainBees: true } : {});
      toast.success(hive.started ? `${t('pot')} paused` : `${t('pot')} started`, { description: hive.slug });
    } catch (e) {
      toast.error(hive.started ? 'Pause failed' : 'Start failed', { description: String(e) });
    }
    // The hive.controlState invalidation fired by hive:start/pause refreshes the row.
    setBusy(null);
  }, [askConfirm, t]);

  return (
    <div className="pclsb-panel" data-testid="local-hives-control">
      {confirmEl}
      <div className="pclsb-panel__bar">
        <span className="pclsb-panel__bar-label">
          local {t('pot', { plural: true, lower: true })} · {countStarted(hives)}/{hives.length} running
        </span>
      </div>
      {error && <div className="pclsb-panel__error">{String(error)}</div>}
      {hives.length === 0 && !loading && (
        <div className="pclsb-panel__empty">no local {t('pot', { plural: true, lower: true })} registered yet.</div>
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
            aria-label={h.started ? `Stop ${t('pot', { lower: true })} ${h.slug}` : `Start ${t('pot', { lower: true })} ${h.slug}`}
            disabled={busy === h.slug}
            onClick={() => void toggle(h)}
          >
            {h.started ? <Square size={11} aria-hidden /> : <Play size={11} aria-hidden />}
            {busy === h.slug ? '…' : h.started ? 'Stop' : 'Start'}
          </button>
        </div>
      ))}
      {hives.length > 0 && (
        <div
          className="pclsb-panel__hint"
          data-testid="queen-tab-pointer"
          style={{ padding: '6px 8px 4px', fontSize: 11, color: 'var(--fg-mute)', lineHeight: 1.45, borderTop: '1px solid var(--border)' }}
        >
          ▸ Start/Stop chooses <em>which {t('pot', { plural: true, lower: true })} run</em>. Pick each {t('pot', { lower: true })}&apos;s{' '}
          <strong>plan focus &amp; work-item steering</strong> in the 👑 {t('brain')} tab (left sidebar).
        </div>
      )}
    </div>
  );
}
