/**
 * AdvAccountsTab — the /adv "Accounts" tab (accounts-pool-tab-2026-06-15).
 *
 * Views the Queen's pool of Claude Max subscriptions: one card per pool account
 * with its id/label, a masked credentialRef (path reference only — the token is
 * NEVER sent to the browser), availability + pause countdown + penalty count,
 * the bound member harnesses, per-account egress (if IP-pinned), and the projected
 * 5h-window usage. A per-account Reset clears a stale projected pause.
 *
 * Read path: the `accounts.pool` sync query (resolver over accountStatus =
 * accounts:list ∪ accounts:status), live over SSE — no polling. Reset/Remove
 * fire `notifySyncInvalidate('accounts.pool')` server-side, so the card updates
 * itself. Linking new accounts via OAuth + remove live in P-002.
 *
 * State discipline (CLAUDE.md): the selected/expanded account id is in the URL
 * (nuqs `?acct=`); only the per-row busy lifecycle is useState.
 */
import { useCallback, useEffect, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { KeyRound, RotateCcw, ChevronDown, ChevronRight, Pause, CircleCheck, CircleSlash, Link2, Network } from 'lucide-react';
import './AdvAccountsTab.css';

// ── Row shape — mirrors AccountStatusRow (operator-core account-pool-store).
// Sync rows are untyped on the client by convention, so we restate the shape. ──
interface AccountRate {
  pausedUntil: number;
  lastPenaltyAt: number;
  penaltyCount: number;
  windowStartedAt: number;
  utilization?: number;
  windowResetAt?: number;
  utilizationAt?: number;
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

/** Show the credential's scheme + filename only — never the home path, never the token. */
function maskRef(ref: string): string {
  const colon = ref.indexOf(':');
  const scheme = colon > 0 ? ref.slice(0, colon) : '';
  const path = colon > 0 ? ref.slice(colon + 1) : ref;
  const base = path.split('/').filter(Boolean).pop() ?? path;
  return scheme ? `${scheme}:…/${base}` : `…/${base}`;
}

/** "2h 13m" / "12m" / "45s" / "now" from a forward delta in ms. */
function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
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

/** A 1s-ticking clock for live countdowns (render-only state, allowed as useState). */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export default function AdvAccountsTab() {
  const { data: accounts, loading, error } = useSyncQuery<PoolAccount>({ queryName: 'accounts.pool' });
  const [selected, setSelected] = useQueryState('acct', parseAsString);
  const [busyId, setBusyId] = useState<string | null>(null);
  const now = useNow();

  const resetRate = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch('/api/admin/deploy-accounts/reset-rate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      toast.success(`Reset rate state for ${id}`);
    } catch (e) {
      toast.error(`Reset failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <div className="pc-advacct">
      <header className="pc-advacct__header">
        <div className="pc-advacct__titlewrap">
          <KeyRound size={16} aria-hidden />
          <h2 className="pc-advacct__title">Accounts</h2>
          <span className="pc-advacct__count">{accounts.length}</span>
        </div>
        <p className="pc-advacct__sub">
          The Queen's pool of Claude Max subscriptions. Each account has its own 5h / 7d rolling budget —
          more accounts = more aggregate headroom for the fleet.
        </p>
      </header>

      {error ? (
        <div className="pc-advacct__empty pc-advacct__empty--err">Failed to load the account pool: {String(error.message ?? error)}</div>
      ) : loading && accounts.length === 0 ? (
        <div className="pc-advacct__empty">Loading the account pool…</div>
      ) : accounts.length === 0 ? (
        <div className="pc-advacct__empty">
          No accounts in the pool yet. Register a Claude Max subscription to give the fleet inference headroom.
        </div>
      ) : (
        <ul className="pc-advacct__grid">
          {accounts.map((a) => {
            const paused = a.rate.pausedUntil > now;
            const expanded = selected === a.id;
            const statusKind = paused ? 'paused' : a.available ? 'ok' : 'off';
            const StatusIcon = paused ? Pause : a.available ? CircleCheck : CircleSlash;
            const statusLabel = paused
              ? `Paused · resets in ${fmtCountdown(a.rate.pausedUntil - now)}`
              : a.available
                ? 'Available'
                : 'Unavailable';
            const util = typeof a.rate.utilization === 'number' ? a.rate.utilization : null;
            return (
              <li key={a.id} className={`pc-advacct__card pc-advacct__card--${statusKind}`}>
                <div className="pc-advacct__cardhead">
                  <span className={`pc-advacct__dot pc-advacct__dot--${statusKind}`} aria-hidden />
                  <div className="pc-advacct__names">
                    <span className="pc-advacct__label">{a.label || a.id}</span>
                    <span className="pc-advacct__id">{a.id}</span>
                  </div>
                  <button
                    type="button"
                    className="pc-advacct__btn"
                    disabled={busyId === a.id}
                    onClick={() => void resetRate(a.id)}
                    title="Clear this account's projected pause / penalty state (does not touch the credential)"
                  >
                    <RotateCcw size={13} aria-hidden />
                    {busyId === a.id ? 'Resetting…' : 'Reset'}
                  </button>
                </div>

                <div className="pc-advacct__ref" title={`credentialRef: ${maskRef(a.credentialRef)} (path reference — the token never reaches the browser)`}>
                  <span className="pc-advacct__reflabel">cred</span>
                  <code>{maskRef(a.credentialRef)}</code>
                </div>

                <div className={`pc-advacct__status pc-advacct__status--${statusKind}`}>
                  <StatusIcon size={13} aria-hidden />
                  <span>{statusLabel}</span>
                  {a.sustainedlyLimited && <span className="pc-advacct__chip pc-advacct__chip--warn">sustained limit</span>}
                  {a.rate.penaltyCount > 0 && (
                    <span className="pc-advacct__chip">
                      {a.rate.penaltyCount} penalt{a.rate.penaltyCount === 1 ? 'y' : 'ies'}
                    </span>
                  )}
                </div>

                <dl className="pc-advacct__meta">
                  <div>
                    <dt>Usage</dt>
                    <dd>
                      {util != null ? (
                        <>
                          ~{Math.round(util * 100)}% used <span className="pc-advacct__approx">approx</span>
                          {a.rate.utilizationAt ? <span className="pc-advacct__muted"> · {fmtAgo(a.rate.utilizationAt, now)}</span> : null}
                        </>
                      ) : (
                        <span className="pc-advacct__muted">—</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>5h window</dt>
                    <dd>
                      {a.rate.windowResetAt && a.rate.windowResetAt > now ? (
                        <>resets in {fmtCountdown(a.rate.windowResetAt - now)}</>
                      ) : (
                        <span className="pc-advacct__muted">—</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Bound to</dt>
                    <dd>
                      {a.boundTo.length ? (
                        <span className="pc-advacct__bound">
                          {a.boundTo.map((m) => (
                            <span key={m} className="pc-advacct__chip">{m}</span>
                          ))}
                        </span>
                      ) : (
                        <span className="pc-advacct__muted">unbound</span>
                      )}
                    </dd>
                  </div>
                  {a.egress && (a.egress.proxyUrl || a.egress.localAddress) ? (
                    <div>
                      <dt><Network size={11} aria-hidden /> Egress</dt>
                      <dd><code className="pc-advacct__egress">{a.egress.proxyUrl || a.egress.localAddress}</code></dd>
                    </div>
                  ) : null}
                </dl>

                {a.liveBuckets.length > 0 && (
                  <button
                    type="button"
                    className="pc-advacct__expand"
                    aria-expanded={expanded}
                    onClick={() => void setSelected(expanded ? null : a.id)}
                  >
                    {expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                    {a.liveBuckets.length} live governor bucket{a.liveBuckets.length === 1 ? '' : 's'}
                  </button>
                )}
                {expanded && a.liveBuckets.length > 0 && (
                  <ul className="pc-advacct__buckets">
                    {a.liveBuckets.map((b) => (
                      <li key={b.key} className="pc-advacct__bucket">
                        <code>{b.provider}/{b.modelClass}</code>
                        <span className={b.paused ? 'pc-advacct__chip pc-advacct__chip--warn' : 'pc-advacct__chip'}>
                          {b.paused ? `paused · ${fmtCountdown(b.pausedUntil - now)}` : 'live'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <footer className="pc-advacct__foot">
        <Link2 size={12} aria-hidden />
        <span>Usage is a projection and may lag the account's real headroom (accurate header-derived numbers land with the gateway usage-accuracy fix). Linking new accounts via OAuth is coming next.</span>
      </footer>
    </div>
  );
}
