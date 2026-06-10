'use client';

/**
 * HiveStartPauseButton — the GLOBAL "Start Hive" / "Pause Hive" control
 * (start-hive-wake-orchestration-2026-06-09 P-006 / D-006).
 *
 * Distinct from PlanRail's per-plan Start (which drives the feature pipeline):
 * this boots/freezes the BRAIN. Sits in the global header next to OPS/PUI.
 *
 * - Read: `useSyncQuery('hive.controlState')` — per-hive `{ started, … }`
 *   (invalidated live by hive:start / hive:pause).
 * - Write: POST /api/agent-mcp/run-tool { name: 'hive:start' | 'hive:pause' }
 *   — the loopback palette bridge into the full gated/audited dispatch.
 * - Label: the lexicon pack (`t('pot')` → "Hive" | "Pot") — never hardcoded.
 * - Confirm state: nuqs (`?hiveCtl=confirm`) per the state policy — the
 *   pending-confirm step is agent-visible/deep-linkable; only the in-flight
 *   busy flag stays useState.
 *
 * Hidden when no hive exists (nothing to start). Multi-hive: acts on the
 * first registered hive (the N=1 build — local-hive scope); the slug is shown
 * in the title so the target is explicit.
 */

import { useState } from 'react';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';

import { useLexicon } from '@/lib/useLexicon';

interface HiveControlRow {
  slug: string;
  started: boolean;
  nextFireAt: string | null;
  lastWakeAt: string | null;
  watchdogFires24h: number;
}

async function runHiveControl(tool: 'hive:start' | 'hive:pause', slug: string): Promise<void> {
  const res = await fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: tool, args: { harness: slug }, confirmed: true }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
    result?: { content?: Array<{ text?: string }> };
  };
  if (!res.ok || !body.ok) {
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  const text = body.result?.content?.[0]?.text;
  const payload = text ? (JSON.parse(text) as { ok?: boolean; message?: string }) : { ok: true };
  if (payload.ok === false) throw new Error(payload.message ?? `${tool} refused`);
}

export function HiveStartPauseButton() {
  const t = useLexicon();
  const [busy, setBusy] = useState(false);
  // The two-step confirm lives in the URL (agent-drivable, reload-safe).
  const [confirmStage, setConfirmStage] = useQueryState(
    'hiveCtl',
    parseAsStringEnum<'confirm'>(['confirm']),
  );

  const { data } = useSyncQuery({ queryName: 'hive.controlState', args: {} });
  const hive = (data as HiveControlRow[] | undefined)?.[0];
  if (!hive) return null; // no hive registered — nothing to start

  const started = hive.started;
  const verb = started ? 'Pause' : 'Start';
  const label = `${verb} ${t('pot')}`; // "Start Hive" | "Pause Pot" — lexicon-resolved

  const act = async () => {
    setBusy(true);
    try {
      await runHiveControl(started ? 'hive:pause' : 'hive:start', hive.slug);
      toast.success(`${label} — done (${hive.slug}).`, { duration: 4000 });
    } catch (e) {
      toast.error(`${label} failed: ${e instanceof Error ? e.message : 'unknown error'}`, {
        duration: 10000,
      });
    } finally {
      setBusy(false);
      void setConfirmStage(null);
    }
  };

  return (
    <button
      type="button"
      className={`pc-header-cta pc-header-cta--mission${started ? ' is-hive-started' : ''}`}
      aria-label={label}
      aria-busy={busy}
      title={
        confirmStage === 'confirm'
          ? `Click again to ${verb.toLowerCase()} ${hive.slug}`
          : `${label} (${hive.slug})${hive.watchdogFires24h > 0 ? ` — watchdog fired ${hive.watchdogFires24h}× in 24h` : ''}`
      }
      disabled={busy}
      style={busy ? { opacity: 0.6, pointerEvents: 'none' } : undefined}
      onClick={() => {
        if (confirmStage === 'confirm') void act();
        else void setConfirmStage('confirm');
      }}
      onBlur={() => void setConfirmStage(null)}
    >
      <span className="pc-header-cta-orb" aria-hidden="true">
        {/* Filled dot = running, hollow = paused — read at a glance. */}
        <span
          className="pc-header-cta-logo"
          style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: '50%',
            border: '2px solid currentColor',
            background: started ? 'currentColor' : 'transparent',
          }}
        />
      </span>
      <span className="pc-header-cta-label">
        {confirmStage === 'confirm' ? `${verb}?` : label.toUpperCase()}
      </span>
    </button>
  );
}
