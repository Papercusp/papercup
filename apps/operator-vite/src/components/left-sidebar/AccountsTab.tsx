/**
 * AccountsTab (left sidebar) — the owner's SESSION-NOW account override, docked next
 * to Queen in the Colony left sidebar (accounts-pool-tab-2026-06-15 P-005; the owner's
 * "Accounts tab in the LEFT SIDEBAR next to Queen holding session-now overrides").
 *
 * The Queen-adjacent owner-steering lever: restrict which pool accounts the fleet may
 * spawn/deploy on RIGHT NOW (Force = allow-list, Exclude = skip), or clear back to the
 * whole pool. Shares the override logic with the AdvShell Accounts tab via
 * useAccountOverride; the full pool view + usage + account-linking live in that tab.
 *
 * Data: account list ← accounts.pool sync query; override ← GET/POST
 * /api/admin/deploy-accounts/session-override (su-81fe4's hive_settings-backed route).
 */
import { useSyncQuery } from '@papercusp/sync';
import { useAccountOverride } from '../adv/use-account-override';

interface PoolAccountLite {
  id: string;
  label?: string;
  available: boolean;
  rate: {
    pausedUntil: number;
    /** Unified 5h rolling utilization (fraction; 1.0 = 100%). */
    utilization?: number;
    windowResetAt?: number;
    /** Unified 7d (weekly) rolling utilization (fraction). */
    utilization7d?: number;
    windowResetAt7d?: number;
  };
}

/** "~12%" from a 0..1+ fraction, or "—" when never observed. */
function pct(u?: number): string {
  return typeof u === 'number' ? `~${Math.round(u * 100)}%` : '—';
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

export default function AccountsTab({ active }: { active: boolean }) {
  const now = Date.now();
  const { data: accounts, loading } = useSyncQuery<PoolAccountLite>({ queryName: 'accounts.pool', enabled: active });
  const { overrideBusy, forced, excluded, overrideActive, toggleForce, toggleExclude, clearOverride } = useAccountOverride();

  return (
    <div className="pclsb-acct">
      <style>{ACCT_CSS}</style>
      <p className="pclsb-acct__intro">
        Limit which Max accounts the fleet may spawn/deploy on <strong>right now</strong>. No selection = the whole pool
        (default). <em>Force</em> = allow-list only these; <em>Exclude</em> = skip these.
      </p>

      {overrideActive && (
        <button type="button" className="pclsb-acct__clear" disabled={overrideBusy} onClick={clearOverride}>
          Clear override
        </button>
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
            const reset5h =
              a.rate.windowResetAt && a.rate.windowResetAt > now ? ` · resets ${fmtCountdown(a.rate.windowResetAt - now)}` : '';
            const reset7d =
              a.rate.windowResetAt7d && a.rate.windowResetAt7d > now ? ` · resets ${fmtCountdown(a.rate.windowResetAt7d - now)}` : '';
            return (
              <li key={a.id} className="pclsb-acct__row">
                <div className="pclsb-acct__top">
                  <div className="pclsb-acct__name" title={a.id}>
                    <span className="pclsb-acct__label">{a.label || a.id}</span>
                    <span className="pclsb-acct__id">{a.id}</span>
                  </div>
                  <div className="pclsb-acct__btns">
                    <button
                      type="button"
                      className={`pclsb-acct__b${isForced ? ' is-force' : ''}`}
                      disabled={overrideBusy}
                      onClick={() => toggleForce(a.id)}
                      title={isForced ? 'Remove from the forced allow-list' : 'Force the fleet to use only this account'}
                    >
                      {isForced ? '✓ Force' : 'Force'}
                    </button>
                    <button
                      type="button"
                      className={`pclsb-acct__b${isExcluded ? ' is-excl' : ''}`}
                      disabled={overrideBusy}
                      onClick={() => toggleExclude(a.id)}
                      title={isExcluded ? 'Stop excluding this account' : 'Exclude this account from fleet selection'}
                    >
                      {isExcluded ? '✓ Excl' : 'Excl'}
                    </button>
                  </div>
                </div>
                <div className="pclsb-acct__usage">
                  <span className="pclsb-acct__u" title={`5h rolling usage${reset5h}`}>
                    5h <strong>{pct(a.rate.utilization)}</strong>
                    {reset5h && <span className="pclsb-acct__umute">{reset5h}</span>}
                  </span>
                  <span className="pclsb-acct__u" title={`7d rolling usage${reset7d}`}>
                    7d <strong>{pct(a.rate.utilization7d)}</strong>
                    {reset7d && <span className="pclsb-acct__umute">{reset7d}</span>}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="pclsb-acct__foot">
        Full pool view, 5h/7d usage and account linking live in the <strong>Accounts</strong> tab (top strip).
      </p>
    </div>
  );
}

const ACCT_CSS = `
.pclsb-acct { display: flex; flex-direction: column; gap: 10px; padding: 12px 12px 16px; font-size: 12.5px; color: var(--fg, #e7e7ea); }
.pclsb-acct__intro { margin: 0; font-size: 11.5px; line-height: 1.45; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__intro em { font-style: normal; color: var(--fg, #e7e7ea); }
.pclsb-acct__clear {
  align-self: flex-start; font-size: 11.5px; padding: 4px 10px; border-radius: 7px; cursor: pointer;
  color: var(--accent, #8b5cf6); background: color-mix(in srgb, var(--accent, #8b5cf6) 12%, transparent);
  border: 1px solid var(--accent, #8b5cf6);
}
.pclsb-acct__clear:disabled { opacity: 0.55; cursor: default; }
.pclsb-acct__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.pclsb-acct__row {
  display: flex; flex-direction: column; gap: 6px; padding: 7px 9px; border-radius: 8px;
  background: var(--bg-2, rgba(255, 255, 255, 0.035)); border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
}
.pclsb-acct__top { display: flex; align-items: center; gap: 8px; }
.pclsb-acct__usage { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 10.5px; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__u { white-space: nowrap; }
.pclsb-acct__u strong { font-weight: 600; color: var(--fg, #e7e7ea); }
.pclsb-acct__umute { color: var(--fg-mute, #8a8a91); }
.pclsb-acct__name { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.pclsb-acct__label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pclsb-acct__id { font-size: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__btns { display: flex; gap: 4px; flex: 0 0 auto; }
.pclsb-acct__b {
  font-size: 10.5px; padding: 2px 7px; border-radius: 6px; cursor: pointer; color: var(--fg-mute, #c2c2c9);
  background: transparent; border: 1px solid var(--border, rgba(255, 255, 255, 0.16));
}
.pclsb-acct__b:hover:not(:disabled) { color: var(--fg, #e7e7ea); border-color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__b:disabled { opacity: 0.55; cursor: default; }
.pclsb-acct__b.is-force { color: var(--accent, #8b5cf6); border-color: var(--accent, #8b5cf6); background: color-mix(in srgb, var(--accent, #8b5cf6) 12%, transparent); }
.pclsb-acct__b.is-excl { color: var(--warn, #fbbf24); border-color: var(--warn, #fbbf24); background: color-mix(in srgb, var(--warn, #fbbf24) 12%, transparent); }
.pclsb-acct__foot { margin: 0; font-size: 10.5px; line-height: 1.4; color: var(--fg-mute, #8a8a91); border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08)); padding-top: 10px; }
`;
