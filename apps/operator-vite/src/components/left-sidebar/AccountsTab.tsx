/**
 * AccountsTab (left sidebar) — the owner's account-pool panel, docked next to Queen
 * in the Colony left sidebar (accounts-pool-tab-2026-06-15 P-005).
 *
 * This is now the SINGLE in-app account view (the standalone /adv "Accounts" tab was
 * removed — its data folded in here). Compact by default: each row shows status +
 * 5h/7d usage + the session-now Force/Exclude steering levers; expanding a row reveals
 * the full card — masked credential ref, availability + pause/penalty, 5h/7d windows
 * with reset + "as of", bound member harnesses, egress, live governor buckets, and a
 * per-account Reset (clear a stale projected pause). Adding / removing / linking an
 * account lives in Settings → Deploy accounts (the heavy wizard); a link sits in the
 * footer. Shares the override logic with nothing else now via useAccountOverride.
 *
 * Data: full account rows ← accounts.pool sync query (live over SSE; register/remove/
 * reset/override fire notifySyncInvalidate('accounts.pool') so rows refresh). Override
 * ← GET/POST /api/admin/deploy-accounts/session-override (hive_settings-backed),
 * applied OPTIMISTICALLY in useAccountOverride so the levers flip instantly.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Pause,
  CircleCheck,
  CircleSlash,
  Network,
  Settings as SettingsIcon,
  KeyRound,
} from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { useAccountOverride } from '../adv/use-account-override';

// Full pool-account row — mirrors AccountStatusRow (operator-core account-pool-store).
// Sync rows are untyped on the client by convention, so we restate the shape.
interface AccountRate {
  pausedUntil: number;
  lastPenaltyAt: number;
  penaltyCount: number;
  windowStartedAt: number;
  utilization?: number;
  windowResetAt?: number;
  utilizationAt?: number;
  utilization7d?: number;
  windowResetAt7d?: number;
}
interface PoolAccount {
  id: string;
  label?: string;
  credentialRef: string;
  boundTo: string[];
  available: boolean;
  sustainedlyLimited: boolean;
  rate: AccountRate;
  egress?: { proxyUrl?: string; localAddress?: string };
  liveBuckets: { key: string; provider: string; modelClass: string; paused: boolean; pausedUntil: number }[];
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function postJson(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; j: { ok?: boolean; error?: string } }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let j: { ok?: boolean; error?: string } = {};
  try {
    j = (await res.json()) as typeof j;
  } catch {
    /* non-JSON response */
  }
  return { ok: res.ok, j };
}

/** Show the credential's scheme + filename only — never the home path, never the token. */
function maskRef(ref: string): string {
  const colon = ref.indexOf(':');
  const scheme = colon > 0 ? ref.slice(0, colon) : '';
  const path = colon > 0 ? ref.slice(colon + 1) : ref;
  const base = path.split('/').filter(Boolean).pop() ?? path;
  return scheme ? `${scheme}:…/${base}` : `…/${base}`;
}

/** "~12%" from a 0..1+ fraction, or "—" when never observed. */
function pct(u?: number): string {
  return typeof u === 'number' ? `~${Math.round(u * 100)}%` : '—';
}

function usagePctValue(u?: number): number {
  if (typeof u !== 'number' || !Number.isFinite(u)) return 0;
  return Math.max(0, Math.min(100, Math.round(u * 100)));
}

function usageTone(u?: number): 'quiet' | 'ok' | 'warn' | 'hot' {
  if (typeof u !== 'number') return 'quiet';
  if (u >= 0.9) return 'hot';
  if (u >= 0.7) return 'warn';
  return 'ok';
}

/** Compact forward countdown — "3d 5h" / "2h 13m" / "12m" / "now". */
function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "3m ago" / "2h ago" from a past epoch ms. */
function fmtAgo(at: number, now: number): string {
  const ms = now - at;
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function UsageMeter({ label, value, reset }: { label: string; value?: number; reset?: string }) {
  const width = usagePctValue(value);
  const tone = usageTone(value);
  return (
    <div className={`pclsb-acct__meter pclsb-acct__meter--${tone}`} aria-label={`${label} usage ${pct(value)}${reset}`}>
      <span className="pclsb-acct__meterlabel">{label}</span>
      <div className="pclsb-acct__bar" aria-hidden>
        <span style={{ width: `${width}%` }} />
      </div>
      <strong>{pct(value)}</strong>
      {reset ? <span className="pclsb-acct__meterreset">{reset.replace(/^ · /, '')}</span> : null}
    </div>
  );
}

/** A 1s-ticking clock for live countdowns; only runs while the tab is active. */
function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [enabled, intervalMs]);
  return now;
}

export default function AccountsTab({ active }: { active: boolean }) {
  const now = useNow(active);
  const { data: accounts, loading } = useSyncQuery<PoolAccount>({ queryName: 'accounts.pool', enabled: active });
  const { overrideBusy, forced, excluded, overrideActive, toggleForce, toggleExclude, clearOverride } = useAccountOverride();
  // Which card is expanded (accordion). URL state so it's agent-driveable + survives reload.
  const [expanded, setExpanded] = useQueryState('acct', parseAsString);
  const [resetBusyId, setResetBusyId] = useState<string | null>(null);
  const poolSummary = useMemo(() => {
    const rows = accounts ?? [];
    const paused = rows.filter((a) => a.rate.pausedUntil > now).length;
    return {
      total: rows.length,
      available: rows.filter((a) => a.available && a.rate.pausedUntil <= now).length,
      paused,
      limited: rows.filter((a) => a.sustainedlyLimited).length,
      forced: forced.size,
      excluded: excluded.size,
    };
  }, [accounts, excluded.size, forced.size, now]);

  const resetRate = useCallback(async (id: string) => {
    setResetBusyId(id);
    try {
      const { ok, j } = await postJson('/api/admin/deploy-accounts/reset-rate', { id });
      if (!ok || !j.ok) throw new Error(j.error || 'reset failed');
      toast.success(`Reset rate state for ${id}`);
    } catch (e) {
      toast.error(`Reset failed: ${errMsg(e)}`);
    } finally {
      setResetBusyId(null);
    }
  }, []);

  return (
    <div className="pclsb-acct">
      <style>{ACCT_CSS}</style>
      <header className="pclsb-acct__hero">
        <div className="pclsb-acct__herotitle">
          <KeyRound size={14} aria-hidden />
          <div>
            <span className="pclsb-acct__eyebrow">spawn account pool</span>
            <p>Session steering for fleet account use.</p>
          </div>
        </div>
        <div className="pclsb-acct__summary" aria-label="Account pool summary">
          <span><b>{poolSummary.available}/{poolSummary.total}</b> avail</span>
          <span><b>{poolSummary.paused}</b> paused</span>
          <span><b>{poolSummary.limited}</b> limited</span>
          <span><b>{poolSummary.forced || poolSummary.excluded ? `${poolSummary.forced}/${poolSummary.excluded}` : 'off'}</b> steer</span>
        </div>
      </header>

      <div className="pclsb-acct__rule" role="note">
        <strong>Force</strong> allow-lists · <strong>Excl</strong> skips · none uses the whole pool
      </div>

      {overrideActive && (
        <div className="pclsb-acct__ovr" role="status">
          <div className="pclsb-acct__ovrtext">
            <strong>Session steering active</strong>
            {forced.size > 0 && (
              <>
                <span>Only</span> {[...forced].map((id) => <span key={id} className="pclsb-acct__chip is-force">{id}</span>)}{' '}
              </>
            )}
            {excluded.size > 0 && (
              <>
                <span>Exclude</span> {[...excluded].map((id) => <span key={id} className="pclsb-acct__chip is-excl">{id}</span>)}
              </>
            )}
          </div>
          <button type="button" className="pclsb-acct__clear" disabled={overrideBusy} onClick={clearOverride}>
            Clear
          </button>
        </div>
      )}

      {loading && accounts.length === 0 ? (
        <div className="pclsb-panel__empty">Loading accounts…</div>
      ) : accounts.length === 0 ? (
        <div className="pclsb-panel__empty">No accounts in the pool yet.</div>
      ) : (
        <ul className="pclsb-acct__list">
          {accounts.map((a) => {
            const isForced = forced.has(a.id);
            const isExcluded = excluded.has(a.id);
            const isOpen = expanded === a.id;
            const paused = a.rate.pausedUntil > now;
            const statusKind = paused ? 'paused' : a.available ? 'ok' : 'off';
            const StatusIcon = paused ? Pause : a.available ? CircleCheck : CircleSlash;
            const statusLabel = paused
              ? `Paused · resets ${fmtCountdown(a.rate.pausedUntil - now)}`
              : a.available
                ? 'Available'
                : 'Unavailable';
            const statusShort = paused ? `pause ${fmtCountdown(a.rate.pausedUntil - now)}` : a.available ? 'avail' : 'off';
            const reset5h =
              a.rate.windowResetAt && a.rate.windowResetAt > now ? ` · resets ${fmtCountdown(a.rate.windowResetAt - now)}` : '';
            const reset7d =
              a.rate.windowResetAt7d && a.rate.windowResetAt7d > now ? ` · resets ${fmtCountdown(a.rate.windowResetAt7d - now)}` : '';
            return (
              <li key={a.id} className={`pclsb-acct__row pclsb-acct__row--${statusKind}${isForced ? ' is-forced' : ''}${isExcluded ? ' is-excluded' : ''}`}>
                <div className="pclsb-acct__top">
                  <button
                    type="button"
                    className="pclsb-acct__name"
                    aria-expanded={isOpen}
                    onClick={() => void setExpanded(isOpen ? null : a.id)}
                  >
                    <span className="pclsb-acct__labelrow">
                      <span className={`pclsb-acct__dot pclsb-acct__dot--${statusKind}`} aria-hidden />
                      <span className="pclsb-acct__label">{a.label || a.id}</span>
                    </span>
                    <span className="pclsb-acct__id">{a.id}</span>
                  </button>
                  <span className={`pclsb-acct__statuspill pclsb-acct__statuspill--${statusKind}`} aria-label={statusLabel}>{statusShort}</span>
                  <div className="pclsb-acct__btns">
                    <button
                      type="button"
                      className={`pclsb-acct__b${isForced ? ' is-force' : ''}`}
                      disabled={overrideBusy}
                      aria-pressed={isForced}
                      aria-label={isForced ? `Stop forcing ${a.id}` : `Force only ${a.id}`}
                      onClick={() => toggleForce(a.id)}
                    >
                      {isForced ? '✓ Force' : 'Force'}
                    </button>
                    <button
                      type="button"
                      className={`pclsb-acct__b${isExcluded ? ' is-excl' : ''}`}
                      disabled={overrideBusy}
                      aria-pressed={isExcluded}
                      aria-label={isExcluded ? `Stop excluding ${a.id}` : `Exclude ${a.id}`}
                      onClick={() => toggleExclude(a.id)}
                    >
                      {isExcluded ? '✓ Excl' : 'Excl'}
                    </button>
                    <button
                      type="button"
                      className="pclsb-acct__expand"
                      aria-label={isOpen ? 'Collapse' : 'Expand'}
                      aria-expanded={isOpen}
                      onClick={() => void setExpanded(isOpen ? null : a.id)}
                    >
                      {isOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                    </button>
                  </div>
                </div>

                <div className="pclsb-acct__usage">
                  <UsageMeter label="5h" value={a.rate.utilization} reset={reset5h} />
                  <UsageMeter label="7d" value={a.rate.utilization7d} reset={reset7d} />
                </div>

                <div className="pclsb-acct__facts">
                  <span>{maskRef(a.credentialRef)}</span>
                  <span>{a.boundTo.length ? `${a.boundTo.length} bound` : 'unbound'}</span>
                  <span>{a.liveBuckets.length ? `${a.liveBuckets.length} bucket${a.liveBuckets.length === 1 ? '' : 's'}` : 'no buckets'}</span>
                  {a.egress && (a.egress.proxyUrl || a.egress.localAddress) ? <span>egress</span> : null}
                  {paused && <span className="pclsb-acct__chip is-excl">paused</span>}
                  {isForced && <span className="pclsb-acct__chip is-force">forced</span>}
                  {isExcluded && <span className="pclsb-acct__chip is-excl">excluded</span>}
                  {a.sustainedlyLimited && <span className="pclsb-acct__chip is-excl">limited</span>}
                  {a.rate.penaltyCount > 0 && (
                    <span className="pclsb-acct__chip">{a.rate.penaltyCount} penalt{a.rate.penaltyCount === 1 ? 'y' : 'ies'}</span>
                  )}
                </div>

                {isOpen && (
                  <div className="pclsb-acct__detail">
                    <div className={`pclsb-acct__status pclsb-acct__status--${statusKind}`}>
                      <StatusIcon size={12} aria-hidden />
                      <span>{statusLabel}</span>
                    </div>
                    <dl className="pclsb-acct__meta">
                      <div>
                        <dt>5h window</dt>
                        <dd>
                          {pct(a.rate.utilization)}
                          {reset5h && <span className="pclsb-acct__umute">{reset5h}</span>}
                          {a.rate.utilizationAt ? <span className="pclsb-acct__umute"> · as of {fmtAgo(a.rate.utilizationAt, now)}</span> : null}
                        </dd>
                      </div>
                      <div>
                        <dt>7d window</dt>
                        <dd>
                          {pct(a.rate.utilization7d)}
                          {reset7d && <span className="pclsb-acct__umute">{reset7d}</span>}
                        </dd>
                      </div>
                      <div>
                        <dt>Bound to</dt>
                        <dd>
                          {a.boundTo.length ? (
                            <span className="pclsb-acct__bound">
                              {a.boundTo.map((m) => <span key={m} className="pclsb-acct__chip">{m}</span>)}
                            </span>
                          ) : (
                            <span className="pclsb-acct__umute">unbound</span>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Cred</dt>
                        <dd><code className="pclsb-acct__cred">{maskRef(a.credentialRef)}</code></dd>
                      </div>
                      {a.egress && (a.egress.proxyUrl || a.egress.localAddress) ? (
                        <div>
                          <dt><Network size={10} aria-hidden /> Egress</dt>
                          <dd><code className="pclsb-acct__cred">{a.egress.proxyUrl || a.egress.localAddress}</code></dd>
                        </div>
                      ) : null}
                    </dl>

                    {a.liveBuckets.length > 0 && (
                      <ul className="pclsb-acct__buckets">
                        {a.liveBuckets.map((b) => (
                          <li key={b.key}>
                            <code>{b.provider}/{b.modelClass}</code>
                            <span className={`pclsb-acct__chip${b.paused ? ' is-excl' : ''}`}>
                              {b.paused ? `paused · ${fmtCountdown(b.pausedUntil - now)}` : 'live'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}

                    <button
                      type="button"
                      className="pclsb-acct__reset"
                      disabled={resetBusyId === a.id}
                      onClick={() => void resetRate(a.id)}
                      aria-label={`Clear projected pause and penalty state for ${a.id}`}
                    >
                      <RotateCcw size={11} aria-hidden /> {resetBusyId === a.id ? 'Resetting…' : 'Reset rate state'}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Link to="/settings/deploy-accounts" className="pclsb-acct__manage">
        <SettingsIcon size={12} aria-hidden /> Add / remove accounts…
      </Link>
      <p className="pclsb-acct__foot">
        Usage is the unified 5h + 7d utilization the inference gateway reads from Anthropic's headers — last observed value,
        so an idle/limited account keeps its last-known %.
      </p>
    </div>
  );
}

const ACCT_CSS = `
.pclsb-acct { display: flex; flex-direction: column; gap: 10px; padding: 12px 12px 16px; font-size: 12.5px; color: var(--fg, #e7e7ea); }
.pclsb-acct__hero {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 10px 11px; border-radius: 8px;
  background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)) 88%, var(--accent, #8b5cf6) 12%);
  border: 1px solid color-mix(in srgb, var(--accent, #8b5cf6) 24%, var(--border, rgba(255, 255, 255, 0.12)));
}
.pclsb-acct__hero svg { flex: 0 0 auto; color: var(--accent, #8b5cf6); margin-top: 2px; }
.pclsb-acct__hero p { margin: 3px 0 0; font-size: 11.5px; line-height: 1.4; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__eyebrow { display: block; font-size: 9.5px; font-weight: 760; letter-spacing: 0; text-transform: uppercase; color: var(--fg, #e7e7ea); }
.pclsb-acct__summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.pclsb-acct__summary > div {
  min-width: 0; padding: 7px 8px; border-radius: 8px; border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  background: var(--bg-2, rgba(255, 255, 255, 0.035));
}
.pclsb-acct__summary span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; font-weight: 720; letter-spacing: 0; text-transform: uppercase; color: var(--fg-mute, #8a8a91); }
.pclsb-acct__summary strong { display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; line-height: 1.1; color: var(--fg, #e7e7ea); font-variant-numeric: tabular-nums; }
.pclsb-acct__rule {
  display: grid; gap: 3px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.035)) 82%, transparent);
  font-size: 10.5px; line-height: 1.35; color: var(--fg-mute, #a6a6ad);
}
.pclsb-acct__rule strong { color: var(--fg, #e7e7ea); font-weight: 700; }
.pclsb-acct__ovr { display: flex; align-items: flex-start; gap: 8px; padding: 7px 9px; border-radius: 8px;
  background: color-mix(in srgb, var(--accent, #8b5cf6) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent, #8b5cf6) 35%, transparent); }
.pclsb-acct__ovrtext { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; font-size: 10.5px; line-height: 1.6; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__ovrtext > strong { flex-basis: 100%; color: var(--fg, #e7e7ea); font-size: 11px; }
.pclsb-acct__clear {
  flex: 0 0 auto; align-self: center; font-size: 11px; padding: 3px 9px; border-radius: 7px; cursor: pointer;
  color: var(--accent, #8b5cf6); background: color-mix(in srgb, var(--accent, #8b5cf6) 8%, transparent); border: 1px solid var(--accent, #8b5cf6);
}
.pclsb-acct__clear:disabled { opacity: 0.55; cursor: default; }
.pclsb-acct__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.pclsb-acct__row {
  display: flex; flex-direction: column; gap: 6px; padding: 7px 9px; border-radius: 8px;
  background: var(--bg-2, rgba(255, 255, 255, 0.035)); border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
}
.pclsb-acct__row--paused { border-color: color-mix(in srgb, var(--warn, #fbbf24) 35%, transparent); }
.pclsb-acct__row--off { opacity: 0.82; }
.pclsb-acct__row.is-forced { border-color: color-mix(in srgb, var(--accent, #8b5cf6) 42%, transparent); }
.pclsb-acct__row.is-excluded { border-color: color-mix(in srgb, var(--warn, #fbbf24) 42%, transparent); }
.pclsb-acct__top { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 6px 8px; }
.pclsb-acct__dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--fg-mute, #8a8a91); }
.pclsb-acct__dot--ok { background: var(--good, #34d399); }
.pclsb-acct__dot--paused { background: var(--warn, #fbbf24); }
.pclsb-acct__dot--off { background: var(--bad, #f87171); }
.pclsb-acct__name { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; align-items: flex-start;
  background: transparent; border: none; cursor: pointer; text-align: left; padding: 0; color: inherit; font: inherit; }
.pclsb-acct__labelrow { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0; }
.pclsb-acct__label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.pclsb-acct__id { font-size: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__statuspill {
  justify-self: end; display: inline-flex; align-items: center; max-width: 116px; min-height: 21px; padding: 2px 7px; border-radius: 999px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12)); background: var(--bg-3, rgba(255, 255, 255, 0.06));
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9.5px; font-weight: 700; color: var(--fg-mute, #c2c2c9);
}
.pclsb-acct__statuspill--ok { color: var(--good, #34d399); border-color: color-mix(in srgb, var(--good, #34d399) 38%, transparent); background: color-mix(in srgb, var(--good, #34d399) 10%, transparent); }
.pclsb-acct__statuspill--paused { color: var(--warn, #fbbf24); border-color: color-mix(in srgb, var(--warn, #fbbf24) 38%, transparent); background: color-mix(in srgb, var(--warn, #fbbf24) 10%, transparent); }
.pclsb-acct__statuspill--off { color: var(--bad, #f87171); border-color: color-mix(in srgb, var(--bad, #f87171) 38%, transparent); background: color-mix(in srgb, var(--bad, #f87171) 10%, transparent); }
.pclsb-acct__btns { grid-column: 1 / -1; display: flex; gap: 4px; flex: 0 0 auto; align-items: center; justify-content: flex-end; }
.pclsb-acct__b {
  font-size: 10.5px; padding: 2px 7px; border-radius: 6px; cursor: pointer; color: var(--fg-mute, #c2c2c9);
  background: var(--bg-2, rgba(255, 255, 255, 0.035)); border: 1px solid var(--border, rgba(255, 255, 255, 0.16));
}
.pclsb-acct__b:hover:not(:disabled) { color: var(--fg, #e7e7ea); border-color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__b:disabled { opacity: 0.55; cursor: default; }
.pclsb-acct__b.is-force { color: var(--accent, #8b5cf6); border-color: var(--accent, #8b5cf6); background: color-mix(in srgb, var(--accent, #8b5cf6) 12%, transparent); }
.pclsb-acct__b.is-excl { color: var(--warn, #fbbf24); border-color: var(--warn, #fbbf24); background: color-mix(in srgb, var(--warn, #fbbf24) 12%, transparent); }
.pclsb-acct__expand { display: inline-flex; align-items: center; justify-content: center; padding: 2px; border-radius: 5px;
  background: transparent; border: none; cursor: pointer; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__expand:hover { color: var(--fg, #e7e7ea); }
.pclsb-acct__usage { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 6px; font-size: 10.5px; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__meter {
  min-width: 0; display: grid; gap: 3px; padding: 6px 7px; border-radius: 7px; border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.035)) 88%, transparent);
}
.pclsb-acct__meterhead { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 9.5px; color: var(--fg-mute, #8a8a91); }
.pclsb-acct__meterhead span { font-weight: 720; letter-spacing: 0; text-transform: uppercase; }
.pclsb-acct__meterhead strong { color: var(--fg, #e7e7ea); font-variant-numeric: tabular-nums; }
.pclsb-acct__bar { height: 4px; overflow: hidden; border-radius: 999px; background: var(--bg-3, rgba(255, 255, 255, 0.07)); }
.pclsb-acct__bar span { display: block; height: 100%; border-radius: inherit; background: var(--fg-mute, #8a8a91); }
.pclsb-acct__meter--ok .pclsb-acct__bar span { background: var(--good, #34d399); }
.pclsb-acct__meter--warn .pclsb-acct__bar span { background: var(--warn, #fbbf24); }
.pclsb-acct__meter--hot .pclsb-acct__bar span { background: var(--bad, #f87171); }
.pclsb-acct__meterreset { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-mute, #8a8a91); font-size: 9px; }
.pclsb-acct__umute { color: var(--fg-mute, #8a8a91); }
.pclsb-acct__chip { display: inline-flex; padding: 1px 6px; border-radius: 999px; font-size: 9.5px; font-weight: 600;
  background: var(--bg-3, rgba(255, 255, 255, 0.06)); color: var(--fg-mute, #c2c2c9); border: 1px solid var(--border, rgba(255, 255, 255, 0.1)); }
.pclsb-acct__chip.is-force { color: var(--accent, #8b5cf6); border-color: color-mix(in srgb, var(--accent, #8b5cf6) 45%, transparent); background: color-mix(in srgb, var(--accent, #8b5cf6) 12%, transparent); }
.pclsb-acct__chip.is-excl { color: var(--warn, #fbbf24); border-color: color-mix(in srgb, var(--warn, #fbbf24) 45%, transparent); background: color-mix(in srgb, var(--warn, #fbbf24) 12%, transparent); }
.pclsb-acct__detail { display: flex; flex-direction: column; gap: 7px; padding-top: 6px; border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08)); }
.pclsb-acct__status { display: flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--fg-mute, #c2c2c9); }
.pclsb-acct__status--ok { color: var(--good, #34d399); }
.pclsb-acct__status--paused { color: var(--warn, #fbbf24); }
.pclsb-acct__status--off { color: var(--bad, #f87171); }
.pclsb-acct__meta { display: flex; flex-direction: column; gap: 4px; margin: 0; }
.pclsb-acct__meta > div { display: grid; grid-template-columns: 58px 1fr; gap: 8px; align-items: baseline; }
.pclsb-acct__meta dt { margin: 0; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #8a8a91); display: inline-flex; align-items: center; gap: 3px; }
.pclsb-acct__meta dd { margin: 0; font-size: 10.5px; color: var(--fg, #e7e7ea); min-width: 0; }
.pclsb-acct__bound { display: inline-flex; flex-wrap: wrap; gap: 3px; }
.pclsb-acct__cred { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9.5px; color: var(--fg-mute, #a6a6ad);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; max-width: 100%; }
.pclsb-acct__buckets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.pclsb-acct__buckets li { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.pclsb-acct__buckets code { font-size: 9.5px; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__reset {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; padding: 3px 8px; border-radius: 6px;
  cursor: pointer; color: var(--fg-mute, #c2c2c9); background: transparent; border: 1px solid var(--border, rgba(255, 255, 255, 0.16));
}
.pclsb-acct__reset:hover:not(:disabled) { color: var(--fg, #e7e7ea); border-color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__reset:disabled { opacity: 0.55; cursor: default; }
.pclsb-acct__manage { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--accent, #8b5cf6);
  text-decoration: none; align-self: flex-start; }
.pclsb-acct__manage:hover { text-decoration: underline; }
.pclsb-acct__foot { margin: 0; font-size: 10.5px; line-height: 1.4; color: var(--fg-mute, #8a8a91); border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08)); padding-top: 10px; }
@media (max-width: 300px) {
  .pclsb-acct__summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pclsb-acct__usage { grid-template-columns: 1fr; }
  .pclsb-acct__statuspill { justify-self: start; grid-column: 1 / -1; max-width: 100%; }
}
`;
