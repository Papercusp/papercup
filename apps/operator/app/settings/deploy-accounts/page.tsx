'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQueryState, parseAsBoolean, parseAsString } from 'nuqs';
import { toast } from 'sonner';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import {
  formatResetIn,
  isActiveAccount,
  setupTokenCommand,
  utilizationTone,
  type PoolHeadroom,
} from './headroom';

/**
 * Deploy accounts settings — the provider-account pool used by the inference
 * gateway. Claude Max accounts back Anthropic-compatible fleet egress and
 * deploy credentials; Codex accounts back OpenAI-compatible Codex account pins.
 * Link one by minting or referencing the provider credential.
 *
 * Why paste-a-token (not an in-app OAuth redirect): claude.ai's authorize endpoint rejects a
 * hand-built URL (it needs claude-code's own client handshake), so the owner runs
 * `claude setup-token` — which does that handshake in their real browser — and pastes the result.
 * Accepts a `sk-ant-oat…` setup-token (→ token:) or a `.credentials.json` bundle (→ file:).
 * Never touches this box's ~/.claude. Backed by /api/admin/deploy-accounts{,/register,/remove}.
 *
 * Live utilization comes from /api/admin/inference-gateway/stats when the gateway reports its
 * current route, and falls back to each account row's last observed provider-limit projection.
 *
 * Lives under /settings/deploy-accounts (moved here from the /admin tabs). The
 * /settings layout supplies the chrome, so this page renders bare content.
 */
interface AccountRow {
  id: string;
  provider?: 'claude' | 'codex';
  label?: string;
  credentialRef: string;
  boundTo: string[];
  available: boolean;
  sustainedlyLimited: boolean;
  rate: { pausedUntil: number; penaltyCount: number; utilization?: number; windowResetAt?: number };
}

type AccountProvider = NonNullable<AccountRow['provider']>;

function accountProvider(row: Pick<AccountRow, 'provider'>): AccountProvider {
  return row.provider === 'codex' ? 'codex' : 'claude';
}

function providerLabel(provider: AccountProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

function providerCredentialHint(provider: AccountProvider): string {
  return provider === 'codex'
    ? 'Codex accounts use a bearer token or env:NAME reference for the OpenAI-compatible gateway route.'
    : 'Claude accounts use a setup-token or .credentials.json bundle minted by claude setup-token.';
}

export default function DeployAccountsPage() {
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
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
  const [provider, setProvider] = useState<'claude' | 'codex'>('claude');
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [linkId, setLinkId] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
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
    setUserCode(null);
    setCode('');
    setProvider('claude');
  }, [setAddOpen, setAccountId, setLabel]);

  const register = useCallback(async () => {
    setAddError(null);
    if (!/^[A-Za-z0-9._-]+$/.test(accountId)) {
      setAddError('Account ID must be A-Za-z0-9 . _ - (no spaces, no : or @).');
      return;
    }
    if (!value.trim()) {
      setAddError(provider === 'codex' ? 'Paste a Codex/OpenAI bearer token or env:NAME reference.' : 'Paste a setup-token (sk-ant-oat…) or a .credentials.json bundle.');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/admin/deploy-accounts/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, label: label || undefined, provider, value: value.trim() }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'register failed');
      resetForm();
      // Explicit success signal — the form reset alone is ambiguous if the
      // follow-up list refresh fails (refresh surfaces its own listError).
      toast.success(`${providerLabel(provider)} account "${accountId}" linked`);
      await refresh();
    } catch (e) {
      setAddError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [accountId, label, provider, value, resetForm, refresh]);

  // OAuth mode step A: start the provider CLI and capture its browser-login URL.
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
        body: JSON.stringify({ accountId, label: label || undefined, provider }),
      });
      const j = await r.json();
      if (r.status === 404) throw new Error('OAuth linking isn’t available on this build yet — use “Paste a setup-token”.');
      if (!j.ok || !j.authorizeUrl || !j.linkId) throw new Error(j.error || 'could not start the OAuth link');
      setAuthorizeUrl(j.authorizeUrl as string);
      setLinkId(j.linkId as string);
      setUserCode(typeof j.userCode === 'string' ? j.userCode : null);
    } catch (e) {
      setAddError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [accountId, label, provider]);

  // OAuth mode step B: finish the held provider CLI and register the server-side credential.
  const completeOAuth = useCallback(async () => {
    setAddError(null);
    if (!linkId) {
      setAddError('Generate the authorize link first.');
      return;
    }
    if (provider === 'claude' && !code.trim()) {
      setAddError('Paste the code claude.ai showed you after you approved.');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/admin/deploy-accounts/link-complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ linkId, ...(code.trim() ? { code: code.trim() } : {}) }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'link failed');
      resetForm();
      toast.success(`${providerLabel(provider)} account "${accountId}" linked via browser login`);
      await refresh();
    } catch (e) {
      setAddError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [linkId, code, provider, accountId, resetForm, refresh]);

  const remove = useCallback(
    async (id: string) => {
      const ok = await askConfirm({
        title: 'Remove account',
        body: `Remove account "${id}" from the pool? The credential file is left in place.`,
        confirmLabel: 'Remove',
        destructive: true,
      });
      if (!ok) return;
      await fetch('/api/admin/deploy-accounts/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await refresh();
    },
    [askConfirm, refresh],
  );

  const command = setupTokenCommand(accountId);
  const activeLinkMode = linkMode;
  const oauthProviderName = providerLabel(provider);
  const copyCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the command is visible to copy by hand */
    }
  }, [command]);

  const primaryAction =
    activeLinkMode === 'oauth'
      ? authorizeUrl
        ? completeOAuth
        : startOAuth
      : register;
  const primaryLabel =
    activeLinkMode === 'oauth'
      ? authorizeUrl
        ? busy ? 'Linking...' : 'Complete link'
        : busy ? 'Generating...' : 'Get authorize link'
      : busy ? 'Linking...' : 'Link account';
  const primaryDisabled =
    busy ||
    !accountId ||
    (activeLinkMode === 'oauth'
      ? authorizeUrl
        ? provider === 'claude' && !code.trim()
        : false
      : !value.trim());
  const formStatus = addError
    ? 'Resolve the error before continuing.'
    : busy
      ? 'Saving changes...'
      : activeLinkMode === 'oauth'
        ? authorizeUrl
          ? provider === 'codex'
            ? 'Enter the device code in the browser, then complete the link.'
            : code.trim()
              ? 'Ready to complete the link.'
              : 'Paste the approval code to continue.'
          : accountId
            ? `Ready to start the ${oauthProviderName} browser login.`
            : 'Enter an account ID to continue.'
        : value.trim()
          ? 'Ready to link this account.'
          : provider === 'codex' ? 'Paste a bearer token or env reference to continue.' : 'Paste a setup-token or credentials bundle to continue.';

  return (
    <div className="pc-da">
      {confirmEl}
      <div className="pc-da__bar">
        <p className="pc-da__lede">
          Account pool used by the inference gateway. Claude Max accounts power pooled fleet egress and deploys;
          Codex accounts route Codex sessions through the OpenAI-compatible account-pinning path.
        </p>
        {!addOpen && (
          <button className="pc-da__btn pc-da__btn--primary" onClick={() => setAddOpen(true)}>
            + Link account
          </button>
        )}
      </div>

      {addOpen && (
        <div className="pc-da__wizard">
          <div className="pc-da__wizard-head">
            <strong>Link an account</strong>
            <button className="pc-da__btn pc-da__btn--ghost" onClick={resetForm}>
              Cancel
            </button>
          </div>

          <div className="pc-da__modes" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={provider === 'claude'}
              className={`pc-da__mode${provider === 'claude' ? ' is-active' : ''}`}
              onClick={() => {
                setProvider('claude');
                setAddError(null);
                setValue('');
                setAuthorizeUrl(null);
                setLinkId(null);
                setUserCode(null);
                setCode('');
              }}
            >
              Claude
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={provider === 'codex'}
              className={`pc-da__mode${provider === 'codex' ? ' is-active' : ''}`}
              onClick={() => {
                setProvider('codex');
                setLinkMode('oauth');
                setAuthorizeUrl(null);
                setLinkId(null);
                setUserCode(null);
                setCode('');
                setValue('');
                setAddError(null);
              }}
            >
              Codex
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
              {provider === 'codex' ? 'Paste a bearer token' : 'Paste a setup-token'}
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

          {activeLinkMode === 'oauth' ? (
            !authorizeUrl ? (
              <div className="pc-da__step">
                <p className="pc-da__step-hint">
                  {provider === 'codex' ? (
                    <>
                      2 · We'll start a Codex device login for this account and show you the OpenAI device code.
                      Open the link signed in as the <strong>target ChatGPT/Codex account</strong>, enter the code,
                      then complete the link. The credential is written server-side and never returned to the browser.
                    </>
                  ) : (
                    <>
                      2 · We'll start a Claude login for this account and give you a link (this runs the real{' '}
                      <code>claude setup-token</code> handshake on the server, so claude.ai accepts it). Open the link signed in
                      as the <strong>TARGET Max account</strong>, approve, then paste the code claude shows you. The token is
                      written server-side and never returned to the browser.
                    </>
                  )}
                </p>
              </div>
            ) : (
              <>
                <div className="pc-da__step">
                  <span className="pc-da__step-label">
                    2 · Open &amp; approve (signed in as the target {provider === 'codex' ? 'Codex account' : 'Max account'})
                  </span>
                  <div className="pc-da__cmd">
                    <a className="pc-da__authlink" href={authorizeUrl} target="_blank" rel="noreferrer">
                      ↗ open the {provider === 'codex' ? 'OpenAI device login page' : 'claude.ai authorize page'}
                    </a>
                    <button
                      type="button"
                      className="pc-da__btn pc-da__btn--ghost pc-da__copy"
                      onClick={() => void navigator.clipboard?.writeText(authorizeUrl)}
                    >
                      Copy link
                    </button>
                  </div>
                  {provider === 'codex' && userCode && (
                    <div className="pc-da__cmd">
                      <code>{userCode}</code>
                      <button
                        type="button"
                        className="pc-da__btn pc-da__btn--ghost pc-da__copy"
                        onClick={() => void navigator.clipboard?.writeText(userCode)}
                      >
                        Copy code
                      </button>
                    </div>
                  )}
                </div>
                {provider === 'claude' ? (
                  <label className="pc-da__field">
                    <span>3 · Paste the code claude.ai shows you</span>
                    <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="code#state" />
                  </label>
                ) : (
                  <div className="pc-da__step">
                    <span className="pc-da__step-label">3 · Complete after the browser confirms login</span>
                    <p className="pc-da__step-hint">
                      Codex polls the device login in the held CLI process. When the browser says the login is complete, click Complete link.
                    </p>
                  </div>
                )}
              </>
            )
          ) : (
            <>
              <div className="pc-da__step">
                {provider === 'claude' ? (
                  <>
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
                  </>
                ) : (
                  <>
                    <span className="pc-da__step-label">2 · Add bearer credential</span>
                    <p className="pc-da__step-hint">
                      Paste a Codex/OpenAI bearer token, or enter <code>env:NAME</code> to reference a server environment variable.
                    </p>
                  </>
                )}
              </div>
              <label className="pc-da__field">
                <span>{provider === 'codex' ? '3 · Paste the bearer token or env reference' : '3 · Paste the token (or a .credentials.json bundle)'}</span>
                <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={3} placeholder={provider === 'codex' ? 'sk-…   or   env:OPENAI_API_KEY' : 'sk-ant-oat01-…   or   {&quot;claudeAiOauth&quot;:{…}}'} />
                <small>{providerCredentialHint(provider)}</small>
              </label>
            </>
          )}
          {addError && <p className="pc-da__error">⚠ {addError}</p>}
          <div className="pc-da__save-row">
            <span className="pc-da__save-status" aria-live="polite">{formStatus}</span>
            <div className="pc-da__save-actions">
              <button type="button" className="pc-da__btn pc-da__btn--ghost" onClick={resetForm}>
                Cancel
              </button>
              <button className="pc-da__btn pc-da__btn--primary" disabled={primaryDisabled} onClick={() => void primaryAction()}>
                {primaryLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="pc-da__list">
        {loadingList && <p className="pc-da__muted">Loading…</p>}
        {listError && <p className="pc-da__error">⚠ {listError}</p>}
        {!loadingList && !listError && accounts.length === 0 && (
          <p className="pc-da__muted">No accounts in the pool yet. Link one to grow the fleet's aggregate capacity.</p>
        )}
        {accounts.length > 0 && (
          <div style={{ height: Math.min(620, 34 + accounts.length * 42 + 4) }}>
            <RichGrid<AccountRow>
              columns={accountColumns(headroom, remove)}
              rows={accounts}
              getRowId={(a) => a.id}
              rowMinHeight={42}
              headerHeight={34}
            />
          </div>
        )}
      </div>

      <style>{`
        .pc-da { padding: 16px 18px; color: var(--fg); }
        .pc-da__bar { display: flex; align-items: flex-start; gap: 16px; justify-content: space-between; margin-bottom: 14px; }
        .pc-da__lede { margin: 0; max-width: 70ch; font-size: 13px; color: var(--fg-dim); line-height: 1.5; }
        .pc-da__btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 13px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 78%); background: var(--bg-2); color: var(--fg); font-size: 12px; font-weight: 650; cursor: pointer; }
        .pc-da__btn:hover { background: color-mix(in srgb, var(--bg-popover), transparent 4%); border-color: color-mix(in srgb, var(--accent-strong), transparent 60%); }
        .pc-da__btn:disabled { opacity: 0.5; cursor: default; }
        .pc-da__btn--primary { background: color-mix(in srgb, var(--accent), transparent 82%); color: var(--accent-soft); border-color: color-mix(in srgb, var(--accent-strong), transparent 55%); }
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
        .pc-da__field small { color: var(--fg-mute); font-size: 11.5px; line-height: 1.4; }
        .pc-da__field input, .pc-da__field textarea { background: color-mix(in srgb, var(--bg-deeper), transparent 20%); border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 80%); border-radius: 8px; color: var(--fg); padding: 8px 10px; font-size: 13px; font-family: ui-monospace, Menlo, monospace; }
        .pc-da__error { color: var(--bad); font-size: 12.5px; margin: 6px 0 0; }
        .pc-da__muted { color: color-mix(in srgb, var(--accent-soft), transparent 45%); font-size: 13px; }
        .pc-da__save-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
        .pc-da__save-status { color: var(--fg-mute); font-size: 12.5px; }
        .pc-da__save-actions { display: inline-flex; align-items: center; gap: 8px; }
        .pc-da__mono { font-family: ui-monospace, Menlo, monospace; }
        .pc-da__cred { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: color-mix(in srgb, var(--accent-soft), transparent 38%); }
        .pc-da__pill { display: inline-flex; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 650; }
        .pc-da__pill--active { margin-left: 8px; background: color-mix(in srgb, var(--accent-strong), transparent 80%); color: var(--accent-cool); }
        .pc-da__pill--neutral { background: color-mix(in srgb, var(--fg), transparent 88%); color: var(--fg-dim); }
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

function accountColumns(headroom: PoolHeadroom | null, remove: (id: string) => void): ColumnDef<AccountRow>[] {
  return [
    {
      key: 'id',
      header: 'ID',
      width: 1.2,
      toCopyText: (a) => a.id,
      render: ({ row }) => {
        const active = isActiveAccount(headroom, row.id);
        return (
          <span className="pc-da__mono">
            {row.id}
            {active && <span className="pc-da__pill pc-da__pill--active" title="The gateway is routing egress through this account now">active</span>}
          </span>
        );
      },
    },
    { key: 'label', header: 'Label', width: 1, toCopyText: (a) => a.label || '—', render: ({ row }) => row.label || '—' },
    {
      key: 'provider',
      header: 'Provider',
      width: 0.8,
      toCopyText: (a) => a.provider || 'claude',
      render: ({ row }) => <span className="pc-da__pill pc-da__pill--neutral">{providerLabel(accountProvider(row))}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: 1.1,
      toCopyText: (a) => accountStatusText(a),
      render: ({ row }) => accountStatus(row),
    },
    {
      key: 'budget',
      header: 'Usage',
      width: 1.5,
      toCopyText: (a) => accountUsageText(a, headroom),
      render: ({ row }) => {
        const usage = accountUsage(row, headroom);
        if (!usage) return <span className="pc-da__muted">—</span>;
        const pct = usage.pct;
        return (
          <div className="pc-da__util" title={`${usage.label}${usage.rejected ? ' — over budget' : ''}`}>
            <div className={`pc-da__util-bar pc-da__util-bar--${utilizationTone(pct)}`}>
              <span style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            <span className="pc-da__util-pct">
              {pct}%{usage.reset ? ` · resets ${usage.reset}` : ''}
            </span>
          </div>
        );
      },
    },
    {
      key: 'bound',
      header: 'Bound to',
      width: 1.4,
      toCopyText: (a) => a.boundTo.length ? a.boundTo.join(', ') : '—',
      render: ({ row }) => <span className="pc-da__mono">{row.boundTo.length ? row.boundTo.join(', ') : '—'}</span>,
    },
    {
      key: 'credential',
      header: 'Credential',
      width: 1.5,
      toCopyText: (a) => a.credentialRef,
      render: ({ row }) => <span className="pc-da__mono pc-da__cred">{row.credentialRef}</span>,
    },
    {
      key: 'actions',
      header: '',
      width: '88px',
      render: ({ row }) => (
        <button className="pc-da__btn pc-da__btn--ghost" onClick={() => void remove(row.id)}>
          Remove
        </button>
      ),
    },
  ];
}

function accountStatusText(account: AccountRow): string {
  if (account.sustainedlyLimited) return 'limited';
  if (account.rate.pausedUntil > Date.now()) return `paused ${new Date(account.rate.pausedUntil).toLocaleTimeString()}`;
  return 'available';
}

function accountUsage(
  account: AccountRow,
  headroom: PoolHeadroom | null,
): { pct: number; reset?: string; label: string; rejected?: boolean } | null {
  if (isActiveAccount(headroom, account.id) && headroom?.utilizationPct !== undefined) {
    return {
      pct: headroom.utilizationPct,
      reset: headroom.resetInSec !== undefined ? formatResetIn(headroom.resetInSec) : undefined,
      label: `${headroom.window ?? (accountProvider(account) === 'codex' ? 'OpenAI' : '5h')} window`,
      rejected: headroom.rejected,
    };
  }
  const utilization = account.rate.utilization;
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null;
  const resetMs = account.rate.windowResetAt && account.rate.windowResetAt > Date.now()
    ? Math.ceil((account.rate.windowResetAt - Date.now()) / 1000)
    : undefined;
  return {
    pct: Math.round(utilization * 100),
    reset: resetMs ? formatResetIn(resetMs) : undefined,
    label: accountProvider(account) === 'codex' ? 'OpenAI account usage' : 'Claude 5h budget',
  };
}

function accountUsageText(account: AccountRow, headroom: PoolHeadroom | null): string {
  const usage = accountUsage(account, headroom);
  return usage ? `${usage.pct}%${usage.reset ? ` reset ${usage.reset}` : ''}` : '—';
}

function accountStatus(account: AccountRow) {
  if (account.sustainedlyLimited) return <span className="pc-da__pill pc-da__pill--bad">limited</span>;
  if (account.rate.pausedUntil > Date.now()) {
    return (
      <span className="pc-da__pill pc-da__pill--warn">
        paused → {new Date(account.rate.pausedUntil).toLocaleTimeString()}
      </span>
    );
  }
  return <span className="pc-da__pill pc-da__pill--ok">available</span>;
}
