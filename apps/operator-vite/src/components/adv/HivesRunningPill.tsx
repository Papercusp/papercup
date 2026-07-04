/**
 * HivesRunningPill — the always-visible header control (hive-control-surface).
 * A compact "▶ N running" pill in the AdvShell header toolbar; click expands an
 * inline panel with the full per-hive start/stop control (LocalHivesControl), so
 * the Swarm's autonomous state is visible + flippable from anywhere — not just
 * inside one hive's status bar. Reads the same `hive.controlState` query the
 * Hives-tab control does. Hidden when no local hive is registered or the flag
 * is off.
 */
import { Play } from 'lucide-react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import { useSyncQuery } from '@papercusp/sync';
import { Popover } from '@/app/harness/Popover';
import { useLexicon } from '@/lib/useLexicon';
import { countStarted, hivesRunningLabel, type HiveControlRow } from './hive-control';
import LocalHivesControl from '../left-sidebar/LocalHivesControl';

export default function HivesRunningPill() {
  const t = useLexicon();
  const on = useFlag(FLAGS.HIVE_CONTROL);
  const [open, setOpen] = useQueryState('hivesCtl', parseAsBoolean.withDefault(false));
  const { data } = useSyncQuery<HiveControlRow>({ queryName: 'hive.controlState', args: {} });
  const hives = (data as HiveControlRow[] | undefined) ?? [];

  if (!on || hives.length === 0) return null;
  const running = countStarted(hives);

  return (
    <div className="pc-advshell__hives-pill-wrap">
      <Popover
        open={open}
        onOpenChange={(next) => void setOpen(next)}
        trigger={(
          <button
            type="button"
            className={`pc-advshell__action pc-advshell__action--hives${running > 0 ? ' is-running' : ''}`}
            data-testid="hives-running-pill"
            aria-expanded={open}
            aria-controls="pc-advshell-hives-pop"
          >
            <Play size={11} aria-hidden />
            {hivesRunningLabel(running, t('pot', { lower: true }), t('pot', { plural: true, lower: true }))}
          </button>
        )}
        tooltipLabel={`Start/stop ${t('pot', { plural: true, lower: true })}`}
        side="bottom"
        align="end"
        ariaLabel={`Local ${t('pot', { plural: true, lower: true })}`}
        contentClassName="pc-advshell__hives-pop"
      >
        <div
          id="pc-advshell-hives-pop"
          data-testid="hives-running-pop"
        >
          <LocalHivesControl />
        </div>
      </Popover>
    </div>
  );
}
