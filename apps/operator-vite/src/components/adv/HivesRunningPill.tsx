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
import { countStarted, hivesRunningLabel, type HiveControlRow } from './hive-control';
import LocalHivesControl from '../left-sidebar/LocalHivesControl';

export default function HivesRunningPill() {
  const on = useFlag(FLAGS.HIVE_CONTROL);
  const [open, setOpen] = useQueryState('hivesCtl', parseAsBoolean.withDefault(false));
  const { data } = useSyncQuery<HiveControlRow>({ queryName: 'hive.controlState', args: {} });
  const hives = (data as HiveControlRow[] | undefined) ?? [];

  if (!on || hives.length === 0) return null;
  const running = countStarted(hives);

  return (
    <div className="pc-advshell__hives-pill-wrap" style={{ position: 'relative' }}>
      <button
        type="button"
        className={`pc-advshell__action pc-advshell__action--hives${running > 0 ? ' is-running' : ''}`}
        data-testid="hives-running-pill"
        aria-expanded={open}
        title="Start/stop hives — click to expand"
        onClick={() => void setOpen(!open)}
      >
        <Play size={11} aria-hidden />
        {hivesRunningLabel(running)}
      </button>
      {open && (
        <div
          className="pc-advshell__hives-pop"
          data-testid="hives-running-pop"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            zIndex: 50,
            minWidth: 300,
            marginTop: 4,
            boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
            borderRadius: 6,
            overflow: 'hidden',
          }}
        >
          <LocalHivesControl />
        </div>
      )}
    </div>
  );
}
