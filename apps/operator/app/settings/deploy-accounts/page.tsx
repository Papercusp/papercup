'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQueryState, parseAsBoolean, parseAsString } from 'nuqs';
import { toast } from 'sonner';
import {
  formatResetIn,
  isActiveAccount,
  setupTokenCommand,
  utilizationTone,
  type PoolHeadroom,
} from './headroom';

/**
 * Deploy accounts settings — the pool of Claude Max accounts used as
 * per-machine / remote-frame DEPLOY credentials + the fleet's pooled egress.
 * Link one by minting a credential with claude-code's own login and pasting it.
 *
 * Why paste-a-token (not an in-app OAuth redirect): claude.ai's authorize endpoint rejects a
 * hand-built URL (it needs claude-code's own client handshake), so the owner runs
 * `claude setup-token` — which does that handshake in their real browser — and pastes the result.
 * Accepts a `sk-ant-oat…` setup-token (→ token:) or a `.credentials.json` bundle (→ file:).
 * Never touches this box's ~/.claude. Backed by /api/admin/deploy-accounts{,/register,/remove}.
 *
 * Live 5h utilization comes from /api/admin/inference-gateway/stats — the gateway is the only
 * process that sees the unified rate-limit headers, and it reports the currently-bound account's
 * most-constraining window, so utilization shows on the account egress is routing through now.
 *
 * Lives under /settings/deploy-accounts (moved here from the /admin tabs). The
 * /settings layout supplies the chrome, so this page renders bare content.
 */
interface AccountRow {
  id: string;
  label?: string;
  credentialRef: string;
  boundTo: string[];
  available: boolean;
  sustainedlyLimited: boolean;
  rate: { pausedUntil: number; penaltyCount: number };
}

export default function DeployAccountsPage() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [headroom, setHeadroom] = useState<PoolHeadroom | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);

  const [addOpen, setAddOpen] = useQueryState('add', parseAsBoolean.withDefault(false));
  const [accountId, setAccountId] = useQueryState('id', parseAsString.withDefault(''));
  const [label, setLabel] = useQueryState('label', parseAsString.withDefault(''));

  const [value, setValue] = useState(''); // the pasted token / bundle — secret, useState only
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Link mode (accounts-pool-tab-2026-06-15 P-002): "oauth" = click a link → authorize in the
  // browser → paste the code (the link-start/link-complete round-trip); "token" = the proven
  // `claude setup-token` paste. OAuth is the default the owner reaches for; it's experimental
  // because claude.ai may reject a server-built authorize URL (D-005) — the token flow always works.
  // Default to the one-click browser login. It now runs the REAL `claude setup-token` CLI
  // server-side (account-link-cli.ts) and relays its link, so claude.ai accepts it (the CLI does
  // the client handshake a hand-built URL can't — accounts-pool-tab D-016). The setup-token paste
  // tab stays as the manual fallback.
  const [linkMode, setLinkMode] = useState<'oauth' | 'token'>('oauth');
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [linkId, setLinkId] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const refresh = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const r = await fetch('/api/admin/deploy-accounts');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'failed to load accounts');
      setAccounts(j.accounts ?? []);
    } catch (e) {
      setListError((e as Error).message);
    } finally {
      setLoadingList(false);
    }
    // Live rate-headroom is best-effort: a gateway-off / unreachable read just
    // hides the utilization, it never blocks or errors the account list.
    try {
      const r = await fetch('/api/admin/inference-gateway/stats');
      const j = await r.json();
      setHeadroom(j?.ok ? (j.gateway as PoolHeadroom) : null);
    } catch {
      setHeadroom(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resetForm = useCallback(() => {
    setAddOpen(false);
    setAccountId('');
    setLabel('');
    setValue('');
    setAddError(null);
    setAuthorizeUrl(null);
    setLinkId(null);
    setCode('');
  }, [setAddOpen, setAccountId, setLabel]);

  const register = useCallback(async () => {
    setAddError(null);
    if (!/^[A-Za-z0-9._-]+$/.test(accountId)) {
      setAddError('Account ID must be A-Za-z0-9 . _ - (no spaces, no : or @).');
      return;
    }
    if (!value.trim()) {
      setAddError('Paste a setup-token (sk-ant-oat…) or a .credentials.json bundle.');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/admin/deploy-accounts/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, label: label || undefined, value: value.trim() }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'register failed');
      resetForm();
      // Explicit success signal — the form reset alone is ambiguous if the
      // follow-up list refresh fails (refresh surfaces its own listError).
      toast.success(`Max account "${accountId}" linked`);
      await refresh();
    } catch (e) {
      setAddError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [accountId, label, value, resetForm, refresh]);

  // OAuth mode step A: generate the claude.ai authorize URL (verifier kept server-side under linkId).
  const startOAuth = useCallback(async () => {
    setAddError(null);
    if (!/^[A-Za-z0-9._-]+$/.test(accountId)) {
      setAddError('Account ID must be A-Za-z0-9 . _ - (no spaces, no : or @).');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/admin/deploy-accounts/link-start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, label: label || undefined }),
      });
      const j = await r.json();
      if (r.status === 404) throw new Error('OAuth linking isn’t available on this build yet — use “Paste a setup-token”.');
      if (!j.ok || !j.authorizeUrl || !j.linkId) throw new Error(j.error || 'could not start the OAuth link');
      setAuthorizeUrl(j.authorizeUrl as string);
      setLinkId(j.linkId as string);
    } catch (e) {
      setAddError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [accountId, label]);

  // OAuth mode step B: exchange the pasted code → write credential → register (token stays server-side).
  const completeOAuth = useCallback(async () => {
    setAddError(null);
    if (!linkId) {
      setAddError('Generate the authorize link first.');
      return;
    }
    if (!code.trim()) {
      setAddError('Paste the code claude.ai showed you after you approved.');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/admin/deploy-accounts/link-complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ linkId, code: code.trim() }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'link failed');
      resetForm();
      toast.success(`Max account "${accountId}" linked via OAuth`);
      await refresh();
    } catch (e) {
      setAddError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [linkId, code, accountId, resetForm, refresh]);

  const remove = useCallback(
    async (id: string) => {
      if (!confirm(`Remove account "${id}" from the pool? (the credential file is left in place)`)) return;
      await fetch('/api/admin/deploy-accounts/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await refresh();
    },
    [refresh],
  );

  const command = setupTokenCommand(accountId);
  const copyCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the command is visible to copy by hand */
    }
  }, [command]);

  return (
    <div className="pc-da">
      <div className="pc-da__bar">
        <p className="pc-da__lede">
          The pool of Claude <strong>Max accounts</strong> the fleet runs on — each subscription's own 5h/7d
          budget, pooled for egress + remote-frame deploys (more accounts = more aggregate capacity). Link one by
          minting a token with claude-code's own login; this never touches this box's own login.
        </p>
        {!addOpen && (
          <button className="pc-da__btn pc-da__btn--primary" onClick={() => setAddOpen(true)}>
            + Link Max account
          </button>
        )}
      </div>

      {addOpen && (
        <div className="pc-da__wizard">
          <div className="pc-da__wizard-head">
            <strong>Link a Max account</strong>
            <button className="pc-da__btn pc-da__btn--ghost" onClick={resetForm}>
              Cancel
            </button>
          </div>

          <div className="pc-da__modes" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={linkMode === 'oauth'}
              className={`pc-da__mode${linkMode === 'oauth' ? ' is-active' : ''}`}
              onClick={() => {
                setLinkMode('oauth');
                setAddError(null);
              }}
            >
              🔗 One-click (browser login)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={linkMode === 'token'}
              className={`pc-da__mode${linkMode === 'token' ? ' is-active' : ''}`}
              onClick={() => {
                setLinkMode('token');
                setAddError(null);
              }}
            >
              Paste a setup-token
            </button>
          </div>

          <label className="pc-da__field">
            <span>1 · Account ID</span>
            <input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="e.g. machine-2 or aviynw10" />
          </label>
          <label className="pc-da__field">
            <span>Label (optional)</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Hetzner NYC" />
          </label>

          {linkMode === 'oauth' ? (
            !authorizeUrl ? (
              <div className="pc-da__step">
                <p className="pc-da__step-hint">
                  2 · We'll start a Claude login for this account and give you a link (this runs the real{' '}
                  <code>claude setup-token</code> handshake on the server, so claude.ai accepts it). Open the link signed in
                  as the <strong>TARGET Max account</strong>, approve, then paste the code claude shows you. The token is
                  written server-side and never returned to the browser.
                </p>
                <button className="pc-da__btn pc-da__btn--primary" disabled={busy || !accountId} onClick={() => void startOAuth()}>
                  {busy ? 'Generating…' : 'Get authorize link'}
                </button>
              </div>
            ) : (
              <>
                <div className="pc-da__step">
                  <span className="pc-da__step-label">2 · Open &amp; approve (signed in as the target Max account)</span>
                  <div className="pc-da__cmd">
                    <a className="pc-da__authlink" href={authorizeUrl} target="_blank" rel="noreferrer">
                      ↗ open the claude.ai authorize page
                    </a>
                    <button
                      type="button"
                      className="pc-da__btn pc-da__btn--ghost pc-da__copy"
                      onClick={() => void navigator.clipboard?.writeText(authorizeUrl)}
                    >
                      Copy link
                    </button>
                  </div>
                </div>
                <label className="pc-da__field">
                  <span>3 · Paste the code claude.ai shows you</span>
                  <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="code#state" />
                </label>
                <button className="pc-da__btn pc-da__btn--primary" disabled={busy || !code.trim()} onClick={() => void completeOAuth()}>
                  {busy ? 'Linking…' : 'Complete link'}
                </button>
              </>
            )
          ) : (
            <>
              <div className="pc-da__step">
                <span className="pc-da__step-label">2 · Mint a token for it</span>
                <p className="pc-da__step-hint">
                  On a machine where you can sign in as that account, run this — the isolated config dir keeps the mint
                  off this box's own login:
                </p>
                <div className="pc-da__cmd">
                  <code>{command}</code>
                  <button type="button" className="pc-da__btn pc-da__btn--ghost pc-da__copy" onClick={() => void copyCommand()}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="pc-da__step-hint">
                  Sign in as the target account in the browser it opens; it prints a token (<code>sk-ant-oat…</code>).
                </p>
              </div>
              <label className="pc-da__field">
                <span>3 · Paste the token (or a .credentials.json bundle)</span>
                <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={3} placeholder="sk-ant-oat01-…   or   {&quot;claudeAiOauth&quot;:{…}}" />
              </label>
              <button className="pc-da__btn pc-da__btn--primary" disabled={busy || !accountId || !value.trim()} onClick={register}>
                {busy ? 'Linking…' : 'Link account'}
              </button>
            </>
          )}
          {addError && <p className="pc-da__error">⚠ {addError}</p>}
        </div>
      )}

      <div className="pc-da__list">
        {loadingList && <p className="pc-da__muted">Loading…</p>}
        {listError && <p className="pc-da__error">⚠ {listError}</p>}
        {!loadingList && !listError && accounts.length === 0 && (
          <p className="pc-da__muted">No accounts in the pool yet. Link one to grow the fleet's aggregate capacity.</p>
        )}
        {accounts.length > 0 && (
          <table className="pc-da__table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Label</th>
                <th>Status</th>
                <th>5h budget</th>
                <th>Bound to</th>
                <th>Credential</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const active = isActiveAccount(headroom, a.id);
                const pct = active ? headroom?.utilizationPct : undefined;
                return (
                  <tr key={a.id}>
                    <td className="pc-da__mono">
                      {a.id}
                      {active && <span className="pc-da__pill pc-da__pill--active" title="The gateway is routing egress through this account now">active</span>}
                    </td>
                    <td>{a.label || '—'}</td>
                    <td>
                      {a.sustainedlyLimited ? (
                        <span className="pc-da__pill pc-da__pill--bad">limited</span>
                      ) : a.rate.pausedUntil > Date.now() ? (
                        <span className="pc-da__pill pc-da__pill--warn">
                          paused → {new Date(a.rate.pausedUntil).toLocaleTimeString()}
                        </span>
                      ) : (
                        <span className="pc-da__pill pc-da__pill--ok">available</span>
                      )}
                    </td>
                    <td>
                      {pct !== undefined ? (
                        <div className="pc-da__util" title={`${headroom?.window ?? '5h'} window${headroom?.rejected ? ' — over budget' : ''}`}>
                          <div className={`pc-da__util-bar pc-da__util-bar--${utilizationTone(pct)}`}>
                            <span style={{ width: `${Math.min(100, pct)}%` }} />
                          </div>
                          <span className="pc-da__util-pct">
                            {pct}% · resets {formatResetIn(headroom?.resetInSec)}
                          </span>
                        </div>
                      ) : (
                        <span className="pc-da__muted">—</span>
                      )}
                    </td>
                    <td className="pc-da__mono">{a.boundTo.length ? a.boundTo.join(', ') : '—'}</td>
                    <td className="pc-da__mono pc-da__cred">{a.credentialRef}</td>
                    <td>
                      <button className="pc-da__btn pc-da__btn--ghost" onClick={() => void remove(a.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <style>{`
        .pc-da { padding: 16px 18px; color: var(--fg); }
        .pc-da__bar { display: flex; align-items: flex-start; gap: 16px; justify-content: space-between; margin-bottom: 14px; }
        .pc-da__lede { margin: 0; max-width: 70ch; font-size: 13px; color: var(--fg-dim); line-height: 1.5; }
        .pc-da__btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 13px; border-radius: 9px; border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 78%); background: var(--bg-2); color: var(--fg); font-size: 12px; font-weight: 650; cursor: pointer; }
        .pc-da__btn:hover { background: color-mix(in srgb, var(--bg-popover), transparent 4%); border-color: color-mix(in srgb, var(--accent-strong), transparent 60%); }
        .pc-da__btn:disabled { opacity: 0.5; cursor: default; }
        .pc-da__btn--primary { background: linear-gradient(180deg, color-mix(in srgb, var(--bg-raised), transparent 2%), color-mix(in srgb, var(--bg-1), transparent 1%)); border-color: color-mix(in srgb, var(--accent-strong), transparent 55%); }
        .pc-da__btn--ghost { background: transparent; }
        .pc-da__wizard { border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 72%); border-radius: 12px; background: color-mix(in srgb, var(--bg), transparent 30%); padding: 14px; margin-bottom: 18px; max-width: 680px; }
        .pc-da__wizard-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .pc-da__modes { display: inline-flex; gap: 4px; padding: 3px; margin-bottom: 12px; border-radius: 9px; background: color-mix(in srgb, var(--bg-deeper), transparent 20%); }
        .pc-da__mode { font-size: 12px; padding: 5px 12px; border-radius: 7px; border: none; background: transparent; color: var(--fg-dim); cursor: pointer; font-weight: 600; }
        .pc-da__mode.is-active { background: color-mix(in srgb, var(--accent-strong), transparent 78%); color: var(--accent-cool); }
        .pc-da__authlink { flex: 1; font-size: 13px; color: var(--accent-cool); text-decoration: none; font-weight: 650; }
        .pc-da__authlink:hover { text-decoration: underline; }
        .pc-da__step { margin: 2px 0 12px; }
        .pc-da__step-label { font-size: 11px; color: color-mix(in srgb, var(--accent-soft), transparent 30%); font-weight: 650; }
        .pc-da__step-hint { margin: 6px 0; font-size: 12.5px; color: var(--fg-dim); line-height: 1.5; }
        .pc-da__cmd { display: flex; align-items: center; gap: 8px; margin: 6px 0; padding: 8px 10px; background: color-mix(in srgb, var(--bg-deeper), transparent 15%); border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 82%); border-radius: 7px; }
        .pc-da__cmd code { flex: 1; font-size: 12px; color: var(--accent-cool); overflow-x: auto; white-space: nowrap; }
        .pc-da__copy { padding: 4px 9px; font-size: 11px; flex: 0 0 auto; }
        .pc-da__field { display: grid; gap: 4px; width: 100%; margin-bottom: 10px; }
        .pc-da__field > span { font-size: 11px; color: color-mix(in srgb, var(--accent-soft), transparent 30%); font-weight: 650; }
        .pc-da__field input, .pc-da__field textarea { background: color-mix(in srgb, var(--bg-deeper), transparent 20%); border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 80%); border-radius: 8px; color: var(--fg); padding: 8px 10px; font-size: 13px; font-family: ui-monospace, Menlo, monospace; }
        .pc-da__error { color: var(--bad); font-size: 12.5px; margin: 6px 0 0; }
        .pc-da__muted { color: color-mix(in srgb, var(--accent-soft), transparent 45%); font-size: 13px; }
        .pc-da__table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
        .pc-da__table th { text-align: left; padding: 8px 10px; border-bottom: 1px solid color-mix(in srgb, var(--accent-strong), transparent 84%); color: color-mix(in srgb, var(--accent-soft), transparent 40%); font-weight: 650; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
        .pc-da__table td { padding: 8px 10px; border-bottom: 1px solid color-mix(in srgb, var(--accent-strong), transparent 93%); vertical-align: middle; }
        .pc-da__mono { font-family: ui-monospace, Menlo, monospace; }
        .pc-da__cred { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: color-mix(in srgb, var(--accent-soft), transparent 38%); }
        .pc-da__pill { display: inline-flex; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 650; }
        .pc-da__pill--active { margin-left: 8px; background: color-mix(in srgb, var(--accent-strong), transparent 80%); color: var(--accent-cool); }
        .pc-da__pill--ok { background: color-mix(in srgb, var(--good), transparent 84%); color: var(--good); }
        .pc-da__pill--warn { background: color-mix(in srgb, var(--warn), transparent 84%); color: var(--warn); }
        .pc-da__pill--bad { background: color-mix(in srgb, var(--bad), transparent 84%); color: var(--bad); }
        .pc-da__util { display: grid; gap: 3px; min-width: 110px; }
        .pc-da__util-bar { height: 6px; border-radius: 999px; background: color-mix(in srgb, var(--fg), transparent 88%); overflow: hidden; }
        .pc-da__util-bar > span { display: block; height: 100%; border-radius: 999px; }
        .pc-da__util-bar--ok > span { background: var(--good); }
        .pc-da__util-bar--warn > span { background: var(--warn); }
        .pc-da__util-bar--bad > span { background: var(--bad); }
        .pc-da__util-pct { font-size: 11px; color: var(--fg-dim); }
      `}</style>
    </div>
  );
}
