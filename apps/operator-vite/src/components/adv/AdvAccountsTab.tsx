/**
 * AdvAccountsTab — the /adv "Accounts" tab (accounts-pool-tab-2026-06-15).
 *
 * Views the Queen's pool of Claude Max subscriptions: one card per pool account
 * with its id/label, a masked credentialRef (path reference only — the token is
 * NEVER sent to the browser), availability + pause countdown + penalty count,
 * the bound member harnesses, per-account egress (if IP-pinned), and the projected
 * 5h-window usage. Per-account Reset clears a stale projected pause; Remove drops
 * the account (inline confirm). "Add account" links a new Max subscription.
 *
 * Add-account has two paths (P-002):
 *   • PROVEN (default) — paste a `claude setup-token` (sk-ant-oat…) or a
 *     `.credentials.json` bundle → POST /api/admin/deploy-accounts/register. The
 *     token is written server-side under ~/.papercusp/deploy-credentials and only
 *     referenced; it never round-trips through the browser.
 *   • EXPERIMENTAL — server-mediated PKCE OAuth (su-81fe4's link-start/complete
 *     backend). Generates a claude.ai authorize URL, owner approves + pastes the
 *     code. Degrades gracefully ("not available yet") until that backend deploys.
 *
 * Read path: the `accounts.pool` sync query (resolver over accountStatus =
 * accounts:list ∪ accounts:status), live over SSE — register/remove/reset/link
 * fire `notifySyncInvalidate('accounts.pool')`, so cards update themselves.
 *
 * State discipline (CLAUDE.md): the expanded account id + the add-panel open flag
 * are in the URL (nuqs `?acct=`, `?add=`); only mid-edit form drafts + per-row busy
 * lifecycle + the remove-confirm target are useState.
 */
import { useCallback, useEffect, useState } from 'react';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import {
  KeyRound,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Pause,
  CircleCheck,
  CircleSlash,
  Link2,
  Network,
  Plus,
  Trash2,
  X,
  Copy,
  ExternalLink,
} from 'lucide-react';
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

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function postJson(path: string, body: Record<string, unknown>): Promise<{ status: number; ok: boolean; j: { ok?: boolean; error?: string; [k: string]: unknown } }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let j: { ok?: boolean; error?: string; [k: string]: unknown } = {};
  try {
    j = (await res.json()) as typeof j;
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, ok: res.ok, j };
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

function AddAccountPanel({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'token' | 'oauth'>('token');
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  // proven (setup-token / bundle) path
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  // optional per-account egress (per-account IP routing) — advanced, applies to the setup-token path
  const [showEgress, setShowEgress] = useState(false);
  const [egressProxy, setEgressProxy] = useState('');
  const [egressLocal, setEgressLocal] = useState('');
  // experimental OAuth path (su-81fe4 backend: link-start → { authorizeUrl, linkId }; link-complete { linkId, code })
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [linkId, setLinkId] = useState<string | null>(null);
  const [oauthUnavailable, setOauthUnavailable] = useState(false);
  const [code, setCode] = useState('');
  const [oauthBusy, setOauthBusy] = useState(false);

  const submitToken = useCallback(async () => {
    if (!id.trim() || !value.trim()) {
      toast.error('Account id and the pasted value are required');
      return;
    }
    setBusy(true);
    try {
      const egress =
        egressProxy.trim() || egressLocal.trim()
          ? { proxyUrl: egressProxy.trim() || undefined, localAddress: egressLocal.trim() || undefined }
          : undefined;
      const { ok, j } = await postJson('/api/admin/deploy-accounts/register', {
        accountId: id.trim(),
        label: label.trim() || undefined,
        value: value.trim(),
        egress,
      });
      if (!ok || !j.ok) throw new Error(j.error || 'register failed');
      toast.success(`Added account ${id.trim()}`);
      onClose();
    } catch (e) {
      toast.error(`Add failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }, [id, label, value, egressProxy, egressLocal, onClose]);

  const startOAuth = useCallback(async () => {
    if (!id.trim()) {
      toast.error('Account id is required');
      return;
    }
    setOauthBusy(true);
    try {
      const { status, ok, j } = await postJson('/api/admin/deploy-accounts/link-start', {
        accountId: id.trim(),
        label: label.trim() || undefined,
      });
      if (status === 404) {
        setOauthUnavailable(true);
        return;
      }
      const url = typeof j.authorizeUrl === 'string' ? j.authorizeUrl : null;
      const lid = typeof j.linkId === 'string' ? j.linkId : null;
      if (!ok || !j.ok || !url || !lid) throw new Error(j.error || 'link-start failed');
      setAuthorizeUrl(url);
      setLinkId(lid);
    } catch (e) {
      toast.error(`Couldn't start OAuth link: ${errMsg(e)}`);
    } finally {
      setOauthBusy(false);
    }
  }, [id, label]);

  const completeOAuth = useCallback(async () => {
    if (!code.trim()) {
      toast.error('Paste the code claude.ai gave you');
      return;
    }
    if (!linkId) {
      toast.error('Generate the authorize link first');
      return;
    }
    setOauthBusy(true);
    try {
      const { ok, j } = await postJson('/api/admin/deploy-accounts/link-complete', { linkId, code: code.trim() });
      if (!ok || !j.ok) throw new Error(j.error || 'link-complete failed');
      toast.success('Account linked via OAuth');
      onClose();
    } catch (e) {
      toast.error(`Link failed: ${errMsg(e)}`);
    } finally {
      setOauthBusy(false);
    }
  }, [code, linkId, onClose]);

  return (
    <div className="pc-advacct__addpanel">
      <div className="pc-advacct__addhead">
        <span>Link a Claude Max account</span>
        <button type="button" className="pc-advacct__iconbtn" onClick={onClose} aria-label="Close">
          <X size={14} aria-hidden />
        </button>
      </div>

      <div className="pc-advacct__modetabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'token'}
          className={`pc-advacct__modetab${mode === 'token' ? ' is-active' : ''}`}
          onClick={() => setMode('token')}
        >
          Paste setup-token
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'oauth'}
          className={`pc-advacct__modetab${mode === 'oauth' ? ' is-active' : ''}`}
          onClick={() => setMode('oauth')}
        >
          Link via OAuth <span className="pc-advacct__beta">beta</span>
        </button>
      </div>

      <label className="pc-advacct__field">
        <span>Account id</span>
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. aviynw11" spellCheck={false} autoComplete="off" />
      </label>
      <label className="pc-advacct__field">
        <span>Label (optional)</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. work Max" spellCheck={false} autoComplete="off" />
      </label>

      {mode === 'token' ? (
        <>
          <p className="pc-advacct__hint">
            Run <code>claude setup-token</code> while logged into the TARGET Max account (or paste a <code>.credentials.json</code>{' '}
            bundle), then paste the result below. It is written server-side and never echoed back to the browser.
          </p>
          <label className="pc-advacct__field">
            <span>setup-token or .credentials.json</span>
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={3}
              placeholder="sk-ant-oat… or {…}"
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="pc-advacct__expand"
            aria-expanded={showEgress}
            onClick={() => setShowEgress((v) => !v)}
          >
            {showEgress ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
            Egress / per-account IP (advanced)
          </button>
          {showEgress && (
            <>
              <p className="pc-advacct__hint">
                Optional — route this account's upstream Claude traffic through its own IP (a dedicated proxy or a bound source
                address), so per-account rate limits don't share an egress. Leave blank for the shared egress.
              </p>
              <label className="pc-advacct__field">
                <span>Proxy URL</span>
                <input value={egressProxy} onChange={(e) => setEgressProxy(e.target.value)} placeholder="http(s)/socks://…" spellCheck={false} autoComplete="off" />
              </label>
              <label className="pc-advacct__field">
                <span>Local source IP</span>
                <input value={egressLocal} onChange={(e) => setEgressLocal(e.target.value)} placeholder="e.g. 10.0.0.4" spellCheck={false} autoComplete="off" />
              </label>
            </>
          )}
          <div className="pc-advacct__addactions">
            <button type="button" className="pc-advacct__btn pc-advacct__btn--primary" disabled={busy} onClick={() => void submitToken()}>
              {busy ? 'Adding…' : 'Add account'}
            </button>
          </div>
        </>
      ) : oauthUnavailable ? (
        <p className="pc-advacct__hint pc-advacct__hint--warn">
          OAuth linking isn't available on this build yet — the link-start backend hasn't deployed. Use “Paste setup-token” above.
        </p>
      ) : !authorizeUrl ? (
        <>
          <p className="pc-advacct__hint">
            <strong>Experimental.</strong> Generates a claude.ai authorize link for the account id above. Whether claude.ai accepts a
            server-built link still needs a one-time confirmation — if it doesn't, use “Paste setup-token”. The token stays server-side.
          </p>
          <div className="pc-advacct__addactions">
            <button type="button" className="pc-advacct__btn pc-advacct__btn--primary" disabled={oauthBusy} onClick={() => void startOAuth()}>
              {oauthBusy ? 'Generating…' : 'Get authorize link'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="pc-advacct__hint">1. Open this link logged into the TARGET Max account and approve:</p>
          <div className="pc-advacct__urlrow">
            <a href={authorizeUrl} target="_blank" rel="noreferrer" className="pc-advacct__authlink">
              <ExternalLink size={12} aria-hidden /> open authorize page
            </a>
            <button
              type="button"
              className="pc-advacct__iconbtn"
              title="Copy link"
              onClick={() => {
                void navigator.clipboard?.writeText(authorizeUrl);
                toast.success('Authorize link copied');
              }}
            >
              <Copy size={13} aria-hidden />
            </button>
          </div>
          <p className="pc-advacct__hint">2. Paste the code claude.ai shows you:</p>
          <label className="pc-advacct__field">
            <span>code</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="code#state" spellCheck={false} autoComplete="off" />
          </label>
          <div className="pc-advacct__addactions">
            <button type="button" className="pc-advacct__btn pc-advacct__btn--primary" disabled={oauthBusy} onClick={() => void completeOAuth()}>
              {oauthBusy ? 'Linking…' : 'Complete link'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function AdvAccountsTab() {
  const { data: accounts, loading, error } = useSyncQuery<PoolAccount>({ queryName: 'accounts.pool' });
  const [selected, setSelected] = useQueryState('acct', parseAsString);
  const [addOpen, setAddOpen] = useQueryState('add', parseAsBoolean.withDefault(false));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removePending, setRemovePending] = useState<string | null>(null);
  const [removeBusyId, setRemoveBusyId] = useState<string | null>(null);
  const now = useNow();

  const resetRate = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      const { ok, j } = await postJson('/api/admin/deploy-accounts/reset-rate', { id });
      if (!ok || !j.ok) throw new Error(j.error || 'reset failed');
      toast.success(`Reset rate state for ${id}`);
    } catch (e) {
      toast.error(`Reset failed: ${errMsg(e)}`);
    } finally {
      setBusyId(null);
    }
  }, []);

  const removeAccount = useCallback(async (id: string) => {
    setRemoveBusyId(id);
    try {
      const { ok, j } = await postJson('/api/admin/deploy-accounts/remove', { id });
      if (!ok || !j.ok) throw new Error(j.error || 'remove failed');
      toast.success(`Removed ${id} from the pool`);
    } catch (e) {
      toast.error(`Remove failed: ${errMsg(e)}`);
    } finally {
      setRemoveBusyId(null);
      setRemovePending(null);
    }
  }, []);

  return (
    <div className="pc-advacct">
      <header className="pc-advacct__header">
        <div className="pc-advacct__titlewrap">
          <KeyRound size={16} aria-hidden />
          <h2 className="pc-advacct__title">Accounts</h2>
          <span className="pc-advacct__count">{accounts.length}</span>
          <button type="button" className="pc-advacct__btn pc-advacct__addbtn" onClick={() => void setAddOpen(true)}>
            <Plus size={13} aria-hidden /> Add account
          </button>
        </div>
        <p className="pc-advacct__sub">
          The Queen's pool of Claude Max subscriptions. Each account has its own 5h / 7d rolling budget —
          more accounts = more aggregate headroom for the fleet.
        </p>
      </header>

      {addOpen && <AddAccountPanel onClose={() => void setAddOpen(false)} />}

      {error ? (
        <div className="pc-advacct__empty pc-advacct__empty--err">Failed to load the account pool: {String(error.message ?? error)}</div>
      ) : loading && accounts.length === 0 ? (
        <div className="pc-advacct__empty">Loading the account pool…</div>
      ) : accounts.length === 0 ? (
        <div className="pc-advacct__empty">
          No accounts in the pool yet. Click “Add account” to link a Claude Max subscription and give the fleet inference headroom.
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
                  <button
                    type="button"
                    className="pc-advacct__iconbtn pc-advacct__iconbtn--danger"
                    disabled={removeBusyId === a.id}
                    onClick={() => setRemovePending(a.id)}
                    title="Remove this account from the pool"
                    aria-label={`Remove ${a.id}`}
                  >
                    <Trash2 size={13} aria-hidden />
                  </button>
                </div>

                {removePending === a.id && (
                  <div className="pc-advacct__confirm">
                    <span>Remove <strong>{a.id}</strong> from the pool? (The credential file is left in place.)</span>
                    <div className="pc-advacct__confirmbtns">
                      <button
                        type="button"
                        className="pc-advacct__btn pc-advacct__btn--danger"
                        disabled={removeBusyId === a.id}
                        onClick={() => void removeAccount(a.id)}
                      >
                        {removeBusyId === a.id ? 'Removing…' : 'Remove'}
                      </button>
                      <button type="button" className="pc-advacct__btn" onClick={() => setRemovePending(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

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
                          ~{Math.round(util * 100)}% used <span className="pc-advacct__wtag">5h</span>
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
        <span>
          Usage is the unified-5h utilization the inference gateway reads from Anthropic's response headers — accurate while the
          gateway is actively serving the account, may lag while idle. The 7-day window and session % aren't surfaced yet.
        </span>
      </footer>
    </div>
  );
}
