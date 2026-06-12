'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQueryState, parseAsBoolean, parseAsString } from 'nuqs';
import { toast } from 'sonner';

/**
 * Deploy accounts settings — the pool of Claude accounts used as per-machine /
 * remote-frame DEPLOY credentials. Register one by pasting a credential the
 * owner mints with claude-code's own login.
 *
 * Why paste-a-token (not an in-app OAuth redirect): claude.ai's authorize endpoint rejects a
 * hand-built URL (it needs claude-code's own client handshake), so the owner runs
 * `claude setup-token` — which does that handshake in their real browser — and pastes the result.
 * Accepts a `sk-ant-oat…` setup-token (→ token:) or a `.credentials.json` bundle (→ file:).
 * Never touches this box's ~/.claude. Backed by /api/admin/deploy-accounts{,/register,/remove}.
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
  const [listError, setListError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);

  const [addOpen, setAddOpen] = useQueryState('add', parseAsBoolean.withDefault(false));
  const [accountId, setAccountId] = useQueryState('id', parseAsString.withDefault(''));
  const [label, setLabel] = useQueryState('label', parseAsString.withDefault(''));

  const [value, setValue] = useState(''); // the pasted token / bundle — secret, useState only
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

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
      toast.success(`Deploy account "${accountId}" registered`);
      await refresh();
    } catch (e) {
      setAddError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [accountId, label, value, resetForm, refresh]);

  const remove = useCallback(
    async (id: string) => {
      if (!confirm(`Remove deploy account "${id}" from the pool? (the credential file is left in place)`)) return;
      await fetch('/api/admin/deploy-accounts/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await refresh();
    },
    [refresh],
  );

  return (
    <div className="pc-da">
      <div className="pc-da__bar">
        <p className="pc-da__lede">
          Claude accounts used as <strong>per-machine / remote-frame deploy credentials</strong>. Mint one with
          claude-code's own login, then paste it here — this never touches this box's own login.
        </p>
        {!addOpen && (
          <button className="pc-da__btn pc-da__btn--primary" onClick={() => setAddOpen(true)}>
            + Add account
          </button>
        )}
      </div>

      {addOpen && (
        <div className="pc-da__wizard">
          <div className="pc-da__wizard-head">
            <strong>Add deploy account</strong>
            <button className="pc-da__btn pc-da__btn--ghost" onClick={resetForm}>
              Cancel
            </button>
          </div>
          <ol className="pc-da__steps">
            <li>
              On a machine where you can sign in as the target account, run (the isolated dir keeps it off your
              normal login):
              <pre className="pc-da__pre">CLAUDE_CONFIG_DIR="$HOME/.claude-deploy-&lt;id&gt;" claude setup-token</pre>
            </li>
            <li>Sign in as the target account in the browser it opens; it prints a token (<code>sk-ant-oat…</code>).</li>
            <li>Paste that token below (or paste a <code>.credentials.json</code> bundle).</li>
          </ol>
          <label className="pc-da__field">
            <span>Account ID</span>
            <input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="e.g. machine-2 or aviynw10" />
          </label>
          <label className="pc-da__field">
            <span>Label (optional)</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Hetzner NYC" />
          </label>
          <label className="pc-da__field">
            <span>Token or .credentials.json</span>
            <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={3} placeholder="sk-ant-oat01-…   or   {&quot;claudeAiOauth&quot;:{…}}" />
          </label>
          <button className="pc-da__btn pc-da__btn--primary" disabled={busy || !accountId || !value.trim()} onClick={register}>
            {busy ? 'Registering…' : 'Add account'}
          </button>
          {addError && <p className="pc-da__error">⚠ {addError}</p>}
        </div>
      )}

      <div className="pc-da__list">
        {loadingList && <p className="pc-da__muted">Loading…</p>}
        {listError && <p className="pc-da__error">⚠ {listError}</p>}
        {!loadingList && !listError && accounts.length === 0 && (
          <p className="pc-da__muted">No deploy accounts yet. Add one to use it for remote-frame deploys.</p>
        )}
        {accounts.length > 0 && (
          <table className="pc-da__table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Label</th>
                <th>Status</th>
                <th>Bound to</th>
                <th>Credential</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td className="pc-da__mono">{a.id}</td>
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
                  <td className="pc-da__mono">{a.boundTo.length ? a.boundTo.join(', ') : '—'}</td>
                  <td className="pc-da__mono pc-da__cred">{a.credentialRef}</td>
                  <td>
                    <button className="pc-da__btn pc-da__btn--ghost" onClick={() => void remove(a.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
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
        .pc-da__steps { margin: 4px 0 12px; padding-left: 20px; font-size: 13px; color: var(--fg-dim); line-height: 1.6; }
        .pc-da__pre { margin: 6px 0; padding: 8px 10px; background: color-mix(in srgb, var(--bg-deeper), transparent 15%); border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 82%); border-radius: 7px; font-size: 12px; color: var(--accent-cool); overflow-x: auto; }
        .pc-da__field { display: grid; gap: 4px; width: 100%; margin-bottom: 10px; }
        .pc-da__field > span { font-size: 11px; color: color-mix(in srgb, var(--accent-soft), transparent 30%); font-weight: 650; }
        .pc-da__field input, .pc-da__field textarea { background: color-mix(in srgb, var(--bg-deeper), transparent 20%); border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 80%); border-radius: 8px; color: var(--fg); padding: 8px 10px; font-size: 13px; font-family: ui-monospace, Menlo, monospace; }
        .pc-da__error { color: var(--bad); font-size: 12.5px; margin: 6px 0 0; }
        .pc-da__muted { color: color-mix(in srgb, var(--accent-soft), transparent 45%); font-size: 13px; }
        .pc-da__table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
        .pc-da__table th { text-align: left; padding: 8px 10px; border-bottom: 1px solid color-mix(in srgb, var(--accent-strong), transparent 84%); color: color-mix(in srgb, var(--accent-soft), transparent 40%); font-weight: 650; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
        .pc-da__table td { padding: 8px 10px; border-bottom: 1px solid color-mix(in srgb, var(--accent-strong), transparent 93%); }
        .pc-da__mono { font-family: ui-monospace, Menlo, monospace; }
        .pc-da__cred { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: color-mix(in srgb, var(--accent-soft), transparent 38%); }
        .pc-da__pill { display: inline-flex; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 650; }
        .pc-da__pill--ok { background: color-mix(in srgb, var(--good), transparent 84%); color: var(--good); }
        .pc-da__pill--warn { background: color-mix(in srgb, var(--warn), transparent 84%); color: var(--warn); }
        .pc-da__pill--bad { background: color-mix(in srgb, var(--bad), transparent 84%); color: var(--bad); }
      `}</style>
    </div>
  );
}
