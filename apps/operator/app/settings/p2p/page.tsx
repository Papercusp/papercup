'use client';

/**
 * /settings/p2p — the P2P work-sharing owner surface
 * (p2p-work-distribution-2026-07-02 P-002).
 *
 * Sections: Identity & devices (attestation state per device — missing/stale =
 * RED badge, never silent) · Peers (capability matrix; store = Lane A's P-001,
 * renders a LOUD pending state until its resolver lands) · Work opt-in
 * (per-fleet / any-fleet, concurrency cap, schedule windows) · Budgets (P-201
 * shape, informational until Phase 2) · Live foreign work NOW (m24; goes live
 * with P-104) · Audit · the GLOBAL KILL-SWITCH (M10: stop new claims + graceful
 * wind-down with receipts, never freeze; X13: bounded — grace T then mechanical
 * kill) · the m18 one-click starter profile.
 *
 * Layering (the queen/overwatch pattern): every opt-in edit targets a chosen
 * LAYER — the current-workspace OVERRIDE or the all-workspaces DEFAULT — and
 * the effective settings are the field-level merge. nuqs holds the layer
 * selector (agent → UI control surface reads the URL); mid-edit drafts are
 * local useState per the state policy.
 *
 * Reads `p2p.settings` / `p2p.devices` / `p2p.audit` via useSyncQuery; writes
 * through the loopback /api/agent-mcp/p2p-settings-set route (which fires the
 * name-only notifySyncInvalidate('p2p.settings')). Flag-gated behind
 * FLAGS.P2P (default ON — the fleet kill-switch; inertness is structural:
 * opt-in off + zero grants by default).
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import { useSyncQuery, useSyncMutate } from '@papercusp/sync';
import { toast } from 'sonner';
import { Select } from '../../harness/Select';

/* ── Wire types — mirror operator-core/lib/p2p/settings.ts, kept local per the
 *    client wire-type decoupling convention. ── */
interface P2pScheduleWindow {
  days: number[];
  startMin: number;
  endMin: number;
}
type P2pOptInMode = 'off' | 'selected-fleets' | 'any-fleet';
interface P2pWorkOptIn {
  mode: P2pOptInMode;
  fleets: string[];
  maxConcurrentForeign: number;
  windows: P2pScheduleWindow[];
}
interface P2pKillSwitch {
  engaged: boolean;
  engagedAtMs: number | null;
  reason: string | null;
  windDownGraceSec: number;
}
interface P2pSettings {
  optIn: P2pWorkOptIn;
  killSwitch: P2pKillSwitch;
}
interface P2pSettingsLayers {
  workspaceId: string;
  baked: P2pSettings;
  defaultLayer: Partial<P2pSettings> | null;
  overrideLayer: Partial<P2pSettings> | null;
  effective: P2pSettings;
}

type DeviceRow =
  | { kind: 'identity'; githubUserId: number | null; devicePubkey: string | null }
  | {
      kind: 'device';
      hiveHomeSlug: string;
      devicePubkey: string;
      deviceLabel: string | null;
      attestedAtMs: number | null;
      gistUrl: string | null;
      revoked: boolean;
      isThisDevice: boolean;
    }
  | { kind: 'missing'; hiveHomeSlug: string };

interface AuditRow {
  id: string;
  ts: number;
  actor: string;
  action: string;
  subject: string;
  details: Record<string, unknown> | null;
}

interface SetArgs {
  action: 'set' | 'clear-layer' | 'kill-switch' | 'starter-profile';
  layer?: 'default' | 'workspace';
  patch?: unknown;
  engage?: boolean;
  reason?: string | null;
}
interface SetResp {
  ok: boolean;
  error?: string;
  layers?: P2pSettingsLayers;
}

/** REST fallback the sync-mutate hook calls (desktop SSE → the loopback route). */
async function p2pSettingsSetRest(args: SetArgs): Promise<SetResp> {
  const r = await fetch('/api/agent-mcp/p2p-settings-set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let data: SetResp = { ok: false };
  try {
    data = JSON.parse(text) as SetResp;
  } catch {
    /* non-JSON */
  }
  if (!r.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

/* ── Small helpers ── */
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const minToHHMM = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const hhmmToMin = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v < 1440 ? v : null;
};
const fmtTs = (ms: number | null): string =>
  ms && Number.isFinite(ms) ? new Date(ms).toLocaleString() : '';
const shortKey = (k: string | null): string => (k ? `${k.slice(0, 10)}…${k.slice(-6)}` : '');

const inputStyle: CSSProperties = {
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-2)',
  color: 'var(--fg)',
  fontSize: 13,
};
const sectionStyle: CSSProperties = { marginBottom: 28 };
const h2Style: CSSProperties = { margin: '0 0 8px', fontSize: 15 };
const muteStyle: CSSProperties = { color: 'var(--fg-mute)', fontSize: 12.5 };
const redBadge: CSSProperties = {
  display: 'inline-block',
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11.5,
  fontWeight: 700,
  color: 'var(--bad)',
  background: 'color-mix(in srgb, var(--bad), transparent 86%)',
};
const okBadge: CSSProperties = { ...redBadge, color: 'var(--good, #2c9c46)', background: 'color-mix(in srgb, var(--good, #2c9c46), transparent 86%)' };
const btnStyle: CSSProperties = { fontSize: 12.5, padding: '6px 14px', cursor: 'pointer', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-2)', color: 'var(--fg)' };
const pendingNote: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--fg-mute)',
  background: 'var(--bg-2)',
  border: '1px dashed var(--border)',
  borderRadius: 6,
  padding: '10px 12px',
};

/* ── Opt-in editor (drafts are mid-edit → useState; remounts on layer change) ── */
function OptInEditor({
  layer,
  stored,
  effective,
  onSave,
  onClearLayer,
  busy,
}: {
  layer: 'workspace' | 'default';
  stored: Partial<P2pWorkOptIn> | undefined;
  effective: P2pWorkOptIn;
  onSave: (optIn: P2pWorkOptIn) => Promise<void>;
  onClearLayer: () => Promise<void>;
  busy: boolean;
}) {
  const [mode, setMode] = useState<P2pOptInMode>(effective.mode);
  const [fleetsText, setFleetsText] = useState(effective.fleets.join(', '));
  const [cap, setCap] = useState(String(effective.maxConcurrentForeign));
  const [windows, setWindows] = useState<P2pScheduleWindow[]>(effective.windows);

  const save = useCallback(async () => {
    const capN = Number(cap);
    await onSave({
      mode,
      fleets: fleetsText.split(',').map((f) => f.trim()).filter(Boolean),
      maxConcurrentForeign: Number.isFinite(capN) ? capN : effective.maxConcurrentForeign,
      windows,
    });
  }, [mode, fleetsText, cap, windows, onSave, effective.maxConcurrentForeign]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
        <span style={muteStyle}>Accept work from</span>
        <Select
          value={mode}
          onChange={(v) => setMode(v as P2pOptInMode)}
          ariaLabel="Work opt-in mode"
          options={[
            { value: 'off', label: 'No one (off)' },
            { value: 'selected-fleets', label: 'Selected fleets' },
            { value: 'any-fleet', label: 'Any granted fleet' },
          ]}
        />
      </label>
      {mode === 'selected-fleets' && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: 'var(--fg-mute)' }}>
          Opted-in fleet slugs (comma-separated)
          <input
            type="text"
            value={fleetsText}
            onChange={(e) => setFleetsText(e.target.value)}
            placeholder="fleet-a, fleet-b"
            style={inputStyle}
            aria-label="Opted-in fleet slugs"
          />
        </label>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--fg-mute)' }}>
        Max concurrent foreign sessions
        <input
          type="number"
          min={0}
          max={64}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          style={{ ...inputStyle, width: 80 }}
          aria-label="Max concurrent foreign sessions"
        />
      </label>

      <div>
        <div style={{ ...muteStyle, marginBottom: 6 }}>
          Schedule windows (host-local time; empty = always while opted in — windows gate NEW claims, not running work)
        </div>
        {windows.map((w, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
            {DAY_LABELS.map((d, di) => (
              <label key={d} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <input
                  type="checkbox"
                  checked={w.days.includes(di)}
                  onChange={(e) =>
                    setWindows((ws) =>
                      ws.map((x, xi) =>
                        xi === i
                          ? { ...x, days: e.target.checked ? [...x.days, di].sort() : x.days.filter((v) => v !== di) }
                          : x,
                      ),
                    )
                  }
                />
                {d}
              </label>
            ))}
            <input
              type="time"
              value={minToHHMM(w.startMin)}
              onChange={(e) => {
                const v = hhmmToMin(e.target.value);
                if (v !== null) setWindows((ws) => ws.map((x, xi) => (xi === i ? { ...x, startMin: v } : x)));
              }}
              style={{ ...inputStyle, padding: '3px 6px' }}
              aria-label={`Window ${i + 1} start`}
            />
            <span style={muteStyle}>→</span>
            <input
              type="time"
              value={minToHHMM(w.endMin)}
              onChange={(e) => {
                const v = hhmmToMin(e.target.value);
                if (v !== null) setWindows((ws) => ws.map((x, xi) => (xi === i ? { ...x, endMin: v } : x)));
              }}
              style={{ ...inputStyle, padding: '3px 6px' }}
              aria-label={`Window ${i + 1} end`}
            />
            <button type="button" style={btnStyle} onClick={() => setWindows((ws) => ws.filter((_, xi) => xi !== i))}>
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          style={btnStyle}
          onClick={() => setWindows((ws) => [...ws, { days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1020 }])}
        >
          Add window
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button type="button" onClick={() => void save()} disabled={busy} style={{ ...btnStyle, fontWeight: 600 }}>
          {busy ? 'Saving…' : layer === 'workspace' ? 'Save workspace override' : 'Save default (all workspaces)'}
        </button>
        <button
          type="button"
          onClick={() => void onClearLayer()}
          disabled={busy || stored === undefined}
          style={{ ...btnStyle, opacity: stored === undefined ? 0.5 : 1 }}
        >
          Clear this layer
        </button>
        {stored !== undefined && <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>layer has stored values</span>}
      </div>
    </div>
  );
}

export default function P2pSettingsPage() {
  const { data: settingsData, error: settingsError } = useSyncQuery<P2pSettingsLayers>({
    queryName: 'p2p.settings',
  });
  const layers = settingsData?.[0] ?? null;

  const { data: deviceData, error: devicesError } = useSyncQuery<DeviceRow>({ queryName: 'p2p.devices' });
  const deviceRows = useMemo<DeviceRow[]>(() => deviceData ?? [], [deviceData]);

  const { data: auditData } = useSyncQuery<AuditRow>({ queryName: 'p2p.audit', args: { limit: 50 } });
  const auditRows = useMemo<AuditRow[]>(() => auditData ?? [], [auditData]);

  // Peers matrix — Lane A's P-001 grants store. Until its resolver registers,
  // this query errors and the section renders the LOUD pending state below.
  const { data: grantsData, error: grantsError } = useSyncQuery<Record<string, unknown>>({
    queryName: 'p2p.grants',
  });
  const grantRows = useMemo(() => grantsData ?? [], [grantsData]);

  const [layer, setLayer] = useQueryState(
    'layer',
    parseAsStringEnum<'workspace' | 'default'>(['workspace', 'default']).withDefault('workspace'),
  );
  const [busy, setBusy] = useState(false);
  const [ksReason, setKsReason] = useState('');
  const setP2p = useSyncMutate<SetArgs, SetResp>('p2p.settingsSet', p2pSettingsSetRest);

  const mutate = useCallback(
    async (args: SetArgs, okMsg: string) => {
      setBusy(true);
      try {
        await setP2p(args);
        toast.success(okMsg);
      } catch (e) {
        toast.error(`Couldn't save: ${e instanceof Error ? e.message : 'failed'}`);
      } finally {
        setBusy(false);
      }
    },
    [setP2p],
  );

  const identity = deviceRows.find((r): r is Extract<DeviceRow, { kind: 'identity' }> => r.kind === 'identity');
  const devices = deviceRows.filter((r): r is Extract<DeviceRow, { kind: 'device' }> => r.kind === 'device');
  const missing = deviceRows.filter((r): r is Extract<DeviceRow, { kind: 'missing' }> => r.kind === 'missing');
  const identityUnresolved = !identity || identity.githubUserId === null || identity.devicePubkey === null;

  const ks = layers?.effective.killSwitch;
  const storedOptIn = (layer === 'workspace' ? layers?.overrideLayer : layers?.defaultLayer)?.optIn;

  return (
    <div>
      <h1>P2P work sharing</h1>
      <p className="pc-settings-intro">
        Opt this host into pull-based work hand-off across hive peers — and control exactly what it
        accepts. Accepting foreign work requires BOTH a capability grant from you (Peers, below) and
        this host&apos;s opt-in; everything defaults to off. Settings here are host-local — your machine&apos;s
        sovereignty; grants federate, your opt-in does not.
      </p>

      {settingsError && (
        <p role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>
          Couldn&apos;t load P2P settings: {settingsError.message}
        </p>
      )}

      {/* ── GLOBAL KILL-SWITCH (M10/X13) ── */}
      <section
        className="pc-settings-section"
        aria-label="Global kill-switch"
        style={{
          ...sectionStyle,
          border: `1px solid ${ks?.engaged ? 'var(--bad)' : 'var(--border)'}`,
          borderRadius: 8,
          padding: 14,
          background: ks?.engaged ? 'color-mix(in srgb, var(--bad), transparent 92%)' : 'var(--bg)',
        }}
      >
        <h2 style={h2Style}>
          Global kill-switch{' '}
          {ks?.engaged ? <span style={redBadge}>ENGAGED — all foreign work paused</span> : <span style={okBadge}>clear</span>}
        </h2>
        <p style={{ ...muteStyle, margin: '0 0 10px' }}>
          Engaging stops NEW foreign claims immediately and winds down in-flight foreign work
          gracefully with receipts (never a hard freeze). Wind-down is bounded: after the grace
          period ({ks ? ks.windDownGraceSec : '—'}s) remaining sessions are mechanically terminated
          and a receipt is emitted. A mid-run grant downgrade routes through the same wind-down.
        </p>
        {ks?.engaged ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5 }}>
              engaged {fmtTs(ks.engagedAtMs)}
              {ks.reason ? ` — “${ks.reason}”` : ''}
            </span>
            <button
              type="button"
              disabled={busy}
              style={{ ...btnStyle, fontWeight: 600 }}
              onClick={() => void mutate({ action: 'kill-switch', engage: false }, 'Kill-switch disengaged — foreign work may resume.')}
            >
              Disengage
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={ksReason}
              onChange={(e) => setKsReason(e.target.value)}
              placeholder="reason (lands on receipts + audit)"
              style={{ ...inputStyle, width: 280 }}
              aria-label="Kill-switch reason"
            />
            <button
              type="button"
              disabled={busy}
              style={{ ...btnStyle, color: 'var(--bad)', fontWeight: 600 }}
              onClick={() =>
                toast(`Pause ALL foreign work on this host?`, {
                  action: {
                    label: 'Engage kill-switch',
                    onClick: () =>
                      void mutate(
                        { action: 'kill-switch', engage: true, reason: ksReason.trim() || null },
                        'Kill-switch engaged — new claims stopped, in-flight work winding down.',
                      ),
                  },
                })
              }
            >
              Engage kill-switch
            </button>
          </div>
        )}
      </section>

      {/* ── Identity & devices ── */}
      <section className="pc-settings-section" aria-label="Identity and devices" style={sectionStyle}>
        <h2 style={h2Style}>Identity &amp; devices</h2>
        {devicesError && (
          <p role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>
            Couldn&apos;t load device state: {devicesError.message}
          </p>
        )}
        {identityUnresolved ? (
          <p style={{ fontSize: 13 }}>
            <span style={redBadge}>IDENTITY UNRESOLVED</span>{' '}
            <span style={muteStyle}>
              No GitHub identity / device key resolved on this host — P2P grants resolve only through
              attested devices, so this host is P2P-inert until GitHub auth + device attestation exist.
            </span>
          </p>
        ) : (
          <>
            <p style={{ fontSize: 12.5, margin: '0 0 8px' }}>
              GitHub user <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{identity.githubUserId}</strong>{' '}
              · this device <code style={{ fontSize: 11.5 }}>{shortKey(identity.devicePubkey)}</code>
            </p>
            {missing.map((m) => (
              <p key={m.hiveHomeSlug} style={{ fontSize: 12.5, margin: '4px 0' }}>
                <span style={redBadge}>MISSING</span>{' '}
                <span style={muteStyle}>
                  this device has no live attestation on hive <strong>{m.hiveHomeSlug}</strong> — attest it
                  before it can offer or accept P2P work there.
                </span>
              </p>
            ))}
            {devices.length === 0 && missing.length === 0 && (
              <p style={muteStyle}>No hive memberships found for this identity in the workspace.</p>
            )}
            {devices.map((d) => (
              <div key={`${d.hiveHomeSlug}:${d.devicePubkey}`} style={{ fontSize: 12.5, padding: '4px 0', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {d.revoked ? <span style={redBadge}>REVOKED</span> : <span style={okBadge}>attested</span>}
                <span>
                  {d.deviceLabel ?? 'device'} <code style={{ fontSize: 11 }}>{shortKey(d.devicePubkey)}</code>
                  {d.isThisDevice && <strong> (this device)</strong>}
                </span>
                <span style={muteStyle}>
                  hive {d.hiveHomeSlug}
                  {d.attestedAtMs ? ` · attested ${fmtTs(d.attestedAtMs)}` : ''}
                </span>
              </div>
            ))}
          </>
        )}
      </section>

      {/* ── Peers (capability matrix — P-001 store) ── */}
      <section className="pc-settings-section" aria-label="Peers" style={sectionStyle}>
        <h2 style={h2Style}>Peers — capability grants</h2>
        {grantsError || grantRows.length === 0 ? (
          <div style={pendingNote} role="status">
            {grantsError
              ? 'The capability-grant store (plan item P-001) has not landed on this build yet — grants you issue will appear here the moment its p2p.grants read goes live. Nothing is granted meanwhile (structurally inert).'
              : 'No capability grants issued. Grants are keyed by GitHub user id, resolved only through attested devices, with presets Observer (chat) / Collaborator (+steer) / Delegate (+work-offer, wake) / Operator (+spawn).'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            {grantRows.map((g, i) => (
              <pre key={i} style={{ fontSize: 11.5, margin: '4px 0', background: 'var(--bg-2)', padding: 8, borderRadius: 6 }}>
                {JSON.stringify(g)}
              </pre>
            ))}
          </div>
        )}
      </section>

      {/* ── Work opt-in ── */}
      <section className="pc-settings-section" aria-label="Work opt-in" style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
          <h2 style={{ ...h2Style, margin: 0 }}>Work opt-in</h2>
          <Select
            value={layer}
            onChange={(v) => void setLayer(v as 'workspace' | 'default')}
            ariaLabel="Settings layer"
            options={[
              { value: 'workspace', label: 'This workspace (override)' },
              { value: 'default', label: 'All workspaces (default)' },
            ]}
          />
          <button
            type="button"
            disabled={busy}
            style={btnStyle}
            onClick={() =>
              void mutate(
                { action: 'starter-profile' },
                'Starter profile applied — any granted fleet, 2 concurrent sessions, no schedule limits.',
              )
            }
          >
            Apply starter profile
          </button>
        </div>
        <p style={{ ...muteStyle, margin: '0 0 10px' }}>
          Effective now: <strong>{layers?.effective.optIn.mode ?? '…'}</strong>
          {layers ? ` · cap ${layers.effective.optIn.maxConcurrentForeign} · ${layers.effective.optIn.windows.length === 0 ? 'no schedule limits' : `${layers.effective.optIn.windows.length} window(s)`}` : ''}
          {' '}(field-level merge: baked ← default ← workspace override)
        </p>
        {layers && (
          <OptInEditor
            key={`${layer}:${JSON.stringify(storedOptIn ?? null)}`}
            layer={layer}
            stored={storedOptIn}
            effective={layers.effective.optIn}
            busy={busy}
            onSave={(optIn) => mutate({ action: 'set', layer, patch: { optIn } }, `Saved opt-in (${layer} layer).`)}
            onClearLayer={() => mutate({ action: 'clear-layer', layer }, `Cleared the ${layer} layer.`)}
          />
        )}
      </section>

      {/* ── Budgets (P-201 two-axis — Phase 2) ── */}
      <section className="pc-settings-section" aria-label="Budgets" style={sectionStyle}>
        <h2 style={h2Style}>Budgets — per-fleet allotments</h2>
        <div style={pendingNote} role="status">
          Two-axis allotments per fleet — a REMOTE axis (dollars / model-class weights, never bare
          tokens) and a LOCAL axis (GPU slots / local-inference capacity) — land with Phase 2 (plan
          item P-201). Until then no budget means no foreign spend: admission is already refused
          without an explicit opt-in above.
        </div>
      </section>

      {/* ── Live foreign work NOW (m24) ── */}
      <section className="pc-settings-section" aria-label="Foreign work running now" style={sectionStyle}>
        <h2 style={h2Style}>Foreign work running now</h2>
        <div style={pendingNote} role="status">
          No foreign work is running — P2P execution (local-authority spawn) lands with Phase 1
          (plan item P-104); this live view and its per-session kill button go live then. History
          lives in the audit trail below.
        </div>
      </section>

      {/* ── Audit ── */}
      <section className="pc-settings-section" aria-label="P2P audit trail" style={sectionStyle}>
        <h2 style={h2Style}>Audit</h2>
        {auditRows.length === 0 ? (
          <p style={muteStyle}>No P2P audit events yet. Kill-switch flips, starter-profile applies, grant changes and refusal receipts land here.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: 480 }}>
              <thead>
                <tr>
                  {['when', 'actor', 'action', 'details'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '4px 10px', color: 'var(--fg-mute)', fontWeight: 600 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {auditRows.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '4px 10px', whiteSpace: 'nowrap' }}>{fmtTs(r.ts)}</td>
                    <td style={{ padding: '4px 10px' }}>{r.actor}</td>
                    <td style={{ padding: '4px 10px' }}>
                      <code style={{ fontSize: 11.5 }}>{r.action}</code>
                    </td>
                    <td style={{ padding: '4px 10px', color: 'var(--fg-mute)', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.details ? JSON.stringify(r.details) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
