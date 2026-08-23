'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../harness/Button';
import { Checkbox } from '../../harness/Checkbox';
import { Modal } from '../../harness/Modal';
import { Table, type TableColumn } from '../../harness/Table';

interface SourceStats {
  source: string;
  documents: number;
  newest_at: string | null;
}

interface PersonalGrant {
  id: string;
  principal_type: 'plan-template' | 'binding' | 'agent-role';
  principal_id: string;
  scopes: string[];
  granted_by: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

interface VaultStatus {
  ok: boolean;
  enabled: boolean;
  workspaceId: string;
  user: { id: string; displayName: string };
  stats: { sources: SourceStats[]; unembedded: number };
  grants: PersonalGrant[];
  supportedSources: string[];
  embedding: { mode: 'gemma'; localOnly: true };
  integrations?: { google: IntegrationStatus };
}

interface IntegrationSourceStatus {
  kind: string;
  status: string;
  lastConnectedAt: string | null;
  lastSyncAt: string | null;
}

interface IntegrationStatus {
  provider: 'google';
  configured: boolean;
  connected: boolean;
  status: 'needs-app-config' | 'available' | 'connected' | 'degraded' | 'error';
  sources: IntegrationSourceStatus[];
}

interface GrantPreview {
  ok: boolean;
  planSlug: string;
  harnessSlug: string;
  principalType: 'plan-template';
  principalId: string;
  declaredScopes: string[];
}

interface ApiFailure {
  ok?: false;
  error?: string;
}

const ARCHIVE_HELP = {
  google: 'https://support.google.com/accounts/answer/3024190',
  googleTakeout: 'https://takeout.google.com/settings/takeout',
  facebook: 'https://www.facebook.com/help/212802592074644',
  instagram: 'https://www.facebook.com/help/181231772500920',
  x: 'https://help.x.com/en/managing-your-account/accessing-your-x-data',
} as const;

export function googleWorkspaceConnectHref(): string {
  const params = new URLSearchParams({
    provider: 'google',
    plugin: 'google-workspace',
    harness: 'papercusp',
    field: 'owner',
  });
  return '/api/oauth/start?' + params.toString();
}

async function responseJson<T>(response: Response): Promise<T> {
  const value = (await response.json().catch(() => ({}))) as T & ApiFailure;
  if (!response.ok || value.ok === false) {
    throw new Error(value.error ?? `HTTP ${response.status}`);
  }
  return value;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function activeGrant(grant: PersonalGrant): boolean {
  if (grant.revoked_at) return false;
  return !grant.expires_at || new Date(grant.expires_at).getTime() > Date.now();
}

export default function PersonalVaultSettingsPage() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<{ source: string | null } | null>(null);
  const [planSlug, setPlanSlug] = useState('');
  const [harnessSlug, setHarnessSlug] = useState('papercusp');
  const [grantPreview, setGrantPreview] = useState<GrantPreview | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const next = await responseJson<VaultStatus>(
        await fetch('/api/user/personal-vault', { cache: 'no-store' }),
      );
      setStatus(next);
    } catch (err) {
      toast.error(`Personal Vault load failed: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const liveGrants = useMemo(() => status?.grants.filter(activeGrant) ?? [], [status]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    if (!status || busy) return;
    const previous = status.enabled;
    setStatus({ ...status, enabled });
    setBusy('enabled');
    try {
      await responseJson<{ ok: true; enabled: boolean }>(
        await fetch('/api/user/personal-vault', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        }),
      );
      toast.success(enabled ? 'Personal Vault enabled.' : 'Personal Vault disabled. Imports and recall are stopped.');
    } catch (err) {
      setStatus({ ...status, enabled: previous });
      toast.error(`Couldn’t update the kill switch: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [busy, status]);

  const disconnectGoogle = useCallback(async () => {
    if (!status || busy) return;
    setBusy('disconnect-google');
    try {
      await responseJson<{ ok: true; disconnectedSources: number }>(
        await fetch('/api/user/personal-vault/integrations/google', { method: 'DELETE' }),
      );
      toast.success('Google Workspace disconnected. Existing Personal Vault documents were kept.');
      await load();
    } catch (err) {
      toast.error('Google Workspace disconnect failed: ' + (err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [busy, load, status]);

  const importFiles = useCallback(async (files: FileList | File[]) => {
    if (!status?.enabled) {
      toast.error('Enable the Personal Vault before importing.');
      return;
    }
    const pending = Array.from(files);
    if (!pending.length) return;
    setBusy('import');
    try {
      let total = 0;
      const allWarnings: string[] = [];
      for (const file of pending) {
        const form = new FormData();
        form.set('file', file);
        const result = await responseJson<{
          ok: true;
          documents: number;
          sources: string[];
          warnings: string[];
        }>(await fetch('/api/user/personal-vault/import', { method: 'POST', body: form }));
        total += result.documents;
        allWarnings.push(...result.warnings.map((warning) => `${file.name}: ${warning}`));
      }
      toast.success(`Imported ${total.toLocaleString()} personal record${total === 1 ? '' : 's'} locally.`);
      if (allWarnings.length) toast.warning(allWarnings.slice(0, 3).join(' · '));
      await load();
    } catch (err) {
      toast.error(`Import failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }, [load, status?.enabled]);

  const purge = useCallback(async () => {
    if (!purgeTarget) return;
    const source = purgeTarget.source;
    setBusy(`purge:${source ?? 'all'}`);
    try {
      const result = await responseJson<{
        ok: true;
        removed: { documents: number; cursors: number; aliases: number; identities: number };
      }>(
        await fetch('/api/user/personal-vault', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source, confirm: true }),
        }),
      );
      toast.success(
        `Purged ${result.removed.documents.toLocaleString()} document${result.removed.documents === 1 ? '' : 's'}${source ? ` from ${source}` : ''}.`,
      );
      setPurgeTarget(null);
      await load();
    } catch (err) {
      toast.error(`Purge failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [load, purgeTarget]);

  const previewPlanGrant = useCallback(async () => {
    if (!planSlug.trim()) return;
    setBusy('grant-preview');
    try {
      const preview = await responseJson<GrantPreview>(
        await fetch('/api/user/personal-vault/grants/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ planSlug: planSlug.trim(), harnessSlug: harnessSlug.trim() || undefined }),
        }),
      );
      setGrantPreview(preview);
    } catch (err) {
      toast.error(`Couldn’t inspect that plan: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [harnessSlug, planSlug]);

  const approvePlanGrant = useCallback(async () => {
    if (!grantPreview) return;
    setBusy('grant-approve');
    try {
      await responseJson<{ ok: true }>(
        await fetch('/api/user/personal-vault/grants', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ planSlug: grantPreview.planSlug, harnessSlug: grantPreview.harnessSlug }),
        }),
      );
      toast.success(`Approved ${grantPreview.declaredScopes.length} Personal Vault scope${grantPreview.declaredScopes.length === 1 ? '' : 's'} for ${grantPreview.principalId}.`);
      setGrantPreview(null);
      setPlanSlug('');
      await load();
    } catch (err) {
      toast.error(`Grant approval failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [grantPreview, load]);

  const revoke = useCallback(async (grant: PersonalGrant) => {
    setBusy(`revoke:${grant.id}`);
    try {
      await responseJson<{ ok: true }>(
        await fetch(`/api/user/personal-vault/grants?id=${encodeURIComponent(grant.id)}`, { method: 'DELETE' }),
      );
      toast.success(`Revoked Personal Vault access for ${grant.principal_id}.`);
      await load();
    } catch (err) {
      toast.error(`Revoke failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [load]);

  const sourceColumns: TableColumn<SourceStats>[] = [
    {
      key: 'source',
      header: 'Source',
      render: (source) => <code>personal:{source.source}</code>,
    },
    {
      key: 'records',
      header: 'Records',
      headerStyle: { textAlign: 'right' },
      cellStyle: { textAlign: 'right' },
      render: (source) => source.documents.toLocaleString(),
    },
    {
      key: 'newest',
      header: 'Newest',
      render: (source) => formatDate(source.newest_at),
    },
    {
      key: 'actions',
      header: '',
      cellStyle: { textAlign: 'right' },
      render: (source) => (
        <Button
          variant="destructive"
          onClick={() => setPurgeTarget({ source: source.source })}
          disabled={busy !== null}
        >
          Purge source
        </Button>
      ),
    },
  ];

  const grantColumns: TableColumn<PersonalGrant>[] = [
    {
      key: 'principal',
      header: 'Principal',
      render: (grant) => (
        <>
          <strong>{grant.principal_id}</strong>
          <span className="pc-settings-note" style={{ display: 'block' }}>{grant.principal_type}</span>
        </>
      ),
    },
    {
      key: 'scopes',
      header: 'Scopes',
      render: (grant) => (
        <>{grant.scopes.map((scope) => <code key={scope} style={{ marginRight: 6 }}>{scope}</code>)}</>
      ),
    },
    {
      key: 'state',
      header: 'State',
      render: (grant) => {
        const active = activeGrant(grant);
        return active ? 'Active' : grant.revoked_at ? 'Revoked' : 'Expired';
      },
    },
    {
      key: 'granted',
      header: 'Granted',
      render: (grant) => formatDate(grant.granted_at),
    },
    {
      key: 'actions',
      header: '',
      cellStyle: { textAlign: 'right' },
      render: (grant) => {
        const active = activeGrant(grant);
        return active ? (
          <Button variant="destructive" onClick={() => void revoke(grant)} disabled={busy !== null}>
            {busy === `revoke:${grant.id}` ? 'Revoking…' : 'Revoke'}
          </Button>
        ) : null;
      },
    },
  ];

  if (loading || !status) {
    return <main className="pc-settings-page"><h1>Personal Vault</h1><p role="status">Loading…</p></main>;
  }

  return (
    <main className="pc-settings-page">
      <header>
        <h1>Personal Vault</h1>
        <p className="pc-settings-intro">
          Import your Gmail, Calendar, Contacts, Facebook, Instagram, and X archives into a private,
          owner-local search corpus. Personal content is never part of normal agent recall and its
          vectors are produced only by the local EmbeddingGemma model.
        </p>
      </header>

      <section className="pc-settings-section" aria-labelledby="vault-control-heading">
        <h2 id="vault-control-heading">Privacy control</h2>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, maxWidth: 760 }}>
          <Checkbox
            checked={status.enabled}
            onChange={(value) => void setEnabled(value)}
            disabled={busy === 'enabled'}
            ariaLabel="Enable Personal Vault imports and granted recall"
          />
          <span>
            <strong>Enable Personal Vault</strong>
            <span className="pc-settings-note" style={{ display: 'block' }}>
              Turning this off immediately blocks imports, live ingestion, search, and granted recall.
              It does not delete anything; use the purge controls below for verified deletion.
            </span>
          </span>
        </label>
        <dl className="pc-settings-status" style={{ marginTop: 16 }}>
          <div><dt>Workspace</dt><dd>{status.workspaceId}</dd></div>
          <div><dt>Embedding</dt><dd>EmbeddingGemma · local only</dd></div>
          <div><dt>Awaiting embedding</dt><dd>{status.stats.unembedded.toLocaleString()}</dd></div>
          <div><dt>Active grants</dt><dd>{liveGrants.length.toLocaleString()}</dd></div>
        </dl>
      </section>

      <section className="pc-settings-section" aria-labelledby="vault-integrations-heading">
        <h2 id="vault-integrations-heading">Live integrations</h2>
        <p className="pc-settings-note">
          Live connections keep new provider records flowing into the same owner-local vault.
          OAuth tokens remain server-side and are never returned to this page.
        </p>
        {(() => {
          const google = status.integrations?.google ?? {
            provider: 'google' as const,
            configured: false,
            connected: false,
            status: 'needs-app-config' as const,
            sources: [],
          };
          return (
            <article
              aria-labelledby="vault-google-heading"
              style={{ marginTop: 16, padding: 16, border: '1px solid var(--border)', borderRadius: 10 }}
            >
              <div style={{ display: 'flex', gap: 12, alignItems: 'start', justifyContent: 'space-between' }}>
                <div>
                  <h3 id="vault-google-heading" style={{ marginTop: 0 }}>Google Workspace</h3>
                  <p className="pc-settings-note">
                    One consent connects Gmail, Calendar, and Contacts. Gmail uses provider push
                    notifications plus replay-safe incremental history sync.
                  </p>
                </div>
                <strong aria-label={'Google Workspace status: ' + google.status}>
                  {google.status === 'needs-app-config' ? 'Needs app setup' : google.status}
                </strong>
              </div>
              {google.sources.length ? (
                <dl className="pc-settings-status">
                  {google.sources.map((source) => (
                    <div key={source.kind}>
                      <dt>{source.kind === 'gcal' ? 'Calendar' : source.kind}</dt>
                      <dd>
                        {source.status}
                        {source.lastSyncAt ? ' · synced ' + formatDate(source.lastSyncAt) : ''}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {!google.configured ? (
                <p className="pc-settings-note" role="status">
                  Add a Google Desktop OAuth client at
                  {' '}~/.config/papercusp/google-oauth-client.json to enable consent on this machine.
                </p>
              ) : null}
              <div className="pc-settings-actions" style={{ marginTop: 12 }}>
                <Button
                  variant="primary"
                  disabled={!google.configured || busy !== null}
                  onClick={() => window.location.assign(googleWorkspaceConnectHref())}
                >
                  {google.connected ? 'Reconnect Google Workspace' : 'Connect Google Workspace'}
                </Button>
                {google.connected ? (
                  <Button
                    variant="destructive"
                    disabled={busy !== null}
                    onClick={() => void disconnectGoogle()}
                  >
                    {busy === 'disconnect-google' ? 'Disconnecting…' : 'Disconnect'}
                  </Button>
                ) : null}
              </div>
              <p className="pc-settings-note" style={{ marginBottom: 0 }}>
                Disconnect stops live sync but keeps imported documents. Use Purge below only when
                you want verified deletion.
              </p>
            </article>
          );
        })()}
      </section>

      <section className="pc-settings-section" aria-labelledby="vault-import-heading">
        <h2 id="vault-import-heading">Import archives</h2>
        <p className="pc-settings-note">
          Supported: Google Takeout mail (.mbox), Calendar (.ics), Contacts (.vcf), Facebook/Instagram
          message exports, and X archive ZIP/JSON/JS. Files are parsed on this machine.
        </p>
        <div
          className="pc-settings-note"
          aria-labelledby="vault-archive-help-heading"
          style={{ marginTop: 16, padding: 16, border: '1px solid var(--border)', borderRadius: 10 }}
        >
          <h3 id="vault-archive-help-heading" style={{ marginTop: 0 }}>How to get an archive</h3>
          <ol style={{ display: 'grid', gap: 14, marginBottom: 0, paddingLeft: 22 }}>
            <li>
              <strong>Gmail, Google Calendar, and Google Contacts:</strong>{' '}
              open{' '}
              <a href={ARCHIVE_HELP.googleTakeout} target="_blank" rel="noreferrer noopener">
                Google Takeout
              </a>
              , choose only <em>Mail</em>, <em>Calendar</em>, and <em>Contacts</em>, keep ZIP as the
              delivery format, create the export, then download every ZIP part to this computer.
              Google&apos;s{' '}
              <a href={ARCHIVE_HELP.google} target="_blank" rel="noreferrer noopener">
                official download guide
              </a>
              {' '}explains the export and delivery choices.
            </li>
            <li>
              <strong>Facebook:</strong> follow Meta&apos;s{' '}
              <a href={ARCHIVE_HELP.facebook} target="_blank" rel="noreferrer noopener">
                Export your information guide
              </a>
              : Settings &amp; privacy → Accounts Center → Your information and permissions → Export
              your information → Create export → Export to device. Choose <em>Messages</em>, all time,
              and <em>JSON</em>, then import the downloaded ZIP here. Meta keeps a prepared download
              available for a limited time.
            </li>
            <li>
              <strong>Instagram:</strong> use the same Accounts Center flow and select the Instagram
              profile. Choose <em>Messages</em> and <em>JSON</em>; see Meta&apos;s{' '}
              <a href={ARCHIVE_HELP.instagram} target="_blank" rel="noreferrer noopener">
                Instagram export guide
              </a>
              .
            </li>
            <li>
              <strong>X:</strong> Settings and privacy → Your account → Download an archive of your
              data → Request archive. When X notifies you, download the ZIP and import it here. See
              the{' '}
              <a href={ARCHIVE_HELP.x} target="_blank" rel="noreferrer noopener">
                official X archive guide
              </a>
              .
            </li>
          </ol>
          <p style={{ marginBottom: 0 }}>
            Archive files can contain highly private information. Keep them on this machine and delete
            the downloaded copies when you no longer need them.
          </p>
        </div>
        <div
          role="button"
          tabIndex={0}
          aria-label="Choose or drop Personal Vault archive files"
          onClick={() => fileInput.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') fileInput.current?.click();
          }}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void importFiles(event.dataTransfer.files);
          }}
          style={{
            marginTop: 12,
            padding: '28px 20px',
            borderRadius: 10,
            cursor: status.enabled && busy !== 'import' ? 'pointer' : 'not-allowed',
            border: `2px dashed ${dragging ? 'var(--accent)' : 'var(--border)'}`,
            background: dragging ? 'color-mix(in srgb, var(--accent) 10%, var(--bg-2))' : 'var(--bg-2)',
            opacity: status.enabled ? 1 : 0.6,
          }}
        >
          <strong>{busy === 'import' ? 'Importing locally…' : 'Drop archive files here'}</strong>
          <span className="pc-settings-note" style={{ display: 'block', marginTop: 4 }}>
            or click to choose files · duplicates are updated by stable source keys
          </span>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          disabled={!status.enabled || busy === 'import'}
          accept=".zip,.mbox,.ics,.vcf,.json,.js"
          onChange={(event) => event.target.files && void importFiles(event.target.files)}
        />
      </section>

      <section className="pc-settings-section" aria-labelledby="vault-sources-heading">
        <h2 id="vault-sources-heading">Imported sources</h2>
        {status.stats.sources.length ? (
          <div style={{ overflowX: 'auto' }}>
            <Table columns={sourceColumns} rows={status.stats.sources} getRowKey={(source) => source.source} />
          </div>
        ) : <p className="pc-settings-note">No personal records imported yet.</p>}
        <div className="pc-settings-actions" style={{ marginTop: 16 }}>
          <Button variant="destructive" onClick={() => setPurgeTarget({ source: null })} disabled={busy !== null}>
            Purge entire vault
          </Button>
        </div>
      </section>

      <section className="pc-settings-section" aria-labelledby="vault-plan-grant-heading">
        <h2 id="vault-plan-grant-heading">Approve plan access</h2>
        <p className="pc-settings-note">
          A plan template must declare <code>personalScopes</code> in its frontmatter. Preview reads that
          declaration from the canonical plan; approval cannot add scopes the template did not declare.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 2fr) minmax(160px, 1fr) auto', gap: 10, alignItems: 'end', maxWidth: 840 }}>
          <label>
            <span style={{ display: 'block', marginBottom: 4 }}>Plan slug</span>
            <input value={planSlug} onChange={(event) => setPlanSlug(event.target.value)} placeholder="meeting-prep-brief" />
          </label>
          <label>
            <span style={{ display: 'block', marginBottom: 4 }}>Harness</span>
            <input value={harnessSlug} onChange={(event) => setHarnessSlug(event.target.value)} placeholder="papercusp" />
          </label>
          <Button
            variant="primary"
            onClick={() => void previewPlanGrant()}
            disabled={!planSlug.trim() || busy !== null}
          >
            {busy === 'grant-preview' ? 'Inspecting…' : 'Review access'}
          </Button>
        </div>
      </section>

      <section className="pc-settings-section" aria-labelledby="vault-grants-heading">
        <h2 id="vault-grants-heading">Grant history</h2>
        {status.grants.length ? (
          <div style={{ overflowX: 'auto' }}>
            <Table columns={grantColumns} rows={status.grants} getRowKey={(grant) => grant.id} />
          </div>
        ) : <p className="pc-settings-note">No Personal Vault grants have been approved.</p>}
      </section>

      <Modal
        open={purgeTarget !== null}
        onOpenChange={(open) => !open && setPurgeTarget(null)}
        title={purgeTarget?.source ? `Purge ${purgeTarget.source}` : 'Purge entire Personal Vault'}
        description="This permanently deletes Personal Vault documents, vectors, cursors, and orphaned identity data."
        contentStyle={{ width: 'min(520px, calc(100vw - 4rem))', padding: 22, borderRadius: 12, background: 'var(--bg-1)', border: '1px solid var(--border)' }}
      >
        <h2>{purgeTarget?.source ? `Purge personal:${purgeTarget.source}?` : 'Purge the entire Personal Vault?'}</h2>
        <p>
          This permanently removes the selected documents, their local vectors, sync cursor, source aliases,
          and identities no longer referenced by another source. Grant history is retained for audit.
        </p>
        <div className="pc-settings-actions" style={{ justifyContent: 'flex-end' }}>
          <Button onClick={() => setPurgeTarget(null)} disabled={busy?.startsWith('purge:')}>Cancel</Button>
          <Button variant="destructive" onClick={() => void purge()} disabled={busy?.startsWith('purge:')}>
            {busy?.startsWith('purge:') ? 'Purging…' : 'Permanently purge'}
          </Button>
        </div>
      </Modal>

      <Modal
        open={grantPreview !== null}
        onOpenChange={(open) => !open && setGrantPreview(null)}
        title="Approve Personal Vault access"
        description="Review the exact personal scopes declared by this plan template before granting access."
        contentStyle={{ width: 'min(560px, calc(100vw - 4rem))', padding: 22, borderRadius: 12, background: 'var(--bg-1)', border: '1px solid var(--border)' }}
      >
        <h2>Approve access for {grantPreview?.principalId}</h2>
        <p className="pc-settings-note">
          Plan <code>{grantPreview?.planSlug}</code> in <code>{grantPreview?.harnessSlug}</code> declares:
        </p>
        {grantPreview?.declaredScopes.length ? (
          <ul>{grantPreview.declaredScopes.map((scope) => <li key={scope}><code>{scope}</code></li>)}</ul>
        ) : (
          <p role="alert" style={{ color: 'var(--bad)' }}>
            This plan declares no Personal Vault scopes. Add <code>personalScopes: [personal:gmail]</code> to its frontmatter first.
          </p>
        )}
        <p>
          The grant is bound to this plan-template identity. Coding and review agents remain denied even if a matching grant exists.
        </p>
        <div className="pc-settings-actions" style={{ justifyContent: 'flex-end' }}>
          <Button onClick={() => setGrantPreview(null)} disabled={busy === 'grant-approve'}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void approvePlanGrant()}
            disabled={!grantPreview?.declaredScopes.length || busy === 'grant-approve'}
          >
            {busy === 'grant-approve' ? 'Approving…' : 'Approve declared scopes'}
          </Button>
        </div>
      </Modal>
    </main>
  );
}
