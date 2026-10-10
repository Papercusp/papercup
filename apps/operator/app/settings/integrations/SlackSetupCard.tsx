'use client';

/**
 * Slack on Settings → Integrations (simplify-integration-setup-2026-10-10 P-001).
 *
 * The Slack app stays customer-owned (plan R-5): the user creates it inside their own workspace
 * from Papercusp's manifest, then pastes its two tokens here. Nothing new on the server — the card
 * calls the existing admin routes with the desktop's cookie session:
 *   GET  /api/admin/triggers/slack/manifest  → the manifest the "Create Slack app" link pre-fills
 *   POST /api/admin/triggers/slack/connect   → validates the bot token, stores both tokens outside
 *                                              the repo, and upserts the user's Slack source
 *   GET  /api/admin/triggers                 → the sources snapshot the connected state renders
 *
 * Tokens live only in this form's local state until submit, are masked, and are cleared on
 * success; no response the card reads carries a token back (plan R-3).
 *
 * Slack's `manifest_json` query parameter on api.slack.com/apps is undocumented, so the card also
 * offers the manifest on the clipboard and a plain link to the app list as the fallback.
 */

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Button } from '../../harness/Button';
import { openExternalWebUrl } from '../../_components/ExternalLinkProvider';

export const SLACK_APPS_URL = 'https://api.slack.com/apps';
const SLACK_MANIFEST_API = '/api/admin/triggers/slack/manifest';
const SLACK_CONNECT_API = '/api/admin/triggers/slack/connect';
const TRIGGER_ADMIN_API = '/api/admin/triggers';

/** Slack's create-from-manifest page with Papercusp's manifest pre-filled. */
export function slackCreateAppUrl(manifest: unknown): string {
  return `${SLACK_APPS_URL}?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

/** The non-secret fields of one Slack source in the /admin/triggers snapshot. */
export interface SlackSourceView {
  id: string;
  status: string;
  teamName: string | null;
  teamId: string | null;
  botName: string | null;
  botUserId: string | null;
  lastConnectedAt: string | null;
  lastError: string | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Pick the Slack sources out of the trigger admin snapshot, keeping only display fields. */
export function slackSourcesFromSnapshot(snapshot: unknown): SlackSourceView[] {
  const sources = (snapshot as { sources?: unknown })?.sources;
  if (!Array.isArray(sources)) return [];
  return sources
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && row.kind === 'slack')
    .map((row) => {
      const config = (row.config && typeof row.config === 'object' ? row.config : {}) as Record<string, unknown>;
      return {
        id: String(row.id),
        status: text(row.status) ?? 'unknown',
        teamName: text(config.teamName),
        teamId: text(config.teamId),
        botName: text(config.botName),
        botUserId: text(config.botUserId),
        lastConnectedAt: text(row.lastConnectedAt),
        lastError: text(row.lastError),
      };
    });
}

/** Client-side shape check so an obviously swapped or truncated token never leaves the form. */
export function slackTokenProblem(appToken: string, botToken: string): string | null {
  if (!appToken.startsWith('xapp-')) return 'The app-level token starts with xapp-.';
  if (!botToken.startsWith('xoxb-')) return 'The bot token starts with xoxb-.';
  return null;
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const json = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string; detail?: string }) | null;
  if (!res.ok || !json || json.ok === false) {
    throw new Error(json?.detail ?? json?.error ?? `HTTP ${res.status}`);
  }
  return json;
}

export function SlackSetupCard() {
  const [sources, setSources] = useState<SlackSourceView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Whether the token form is open is user-meaningful, so it lives in the URL.
  const [panel, setPanel] = useQueryState('slack', parseAsStringEnum(['connect']));
  const [appToken, setAppToken] = useState('');
  const [botToken, setBotToken] = useState('');
  const [busy, setBusy] = useState<'create' | 'copy' | 'connect' | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const snapshot = await jsonRequest<unknown>(TRIGGER_ADMIN_API);
      setSources(slackSourcesFromSnapshot(snapshot));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const fetchManifest = useCallback(
    async () => (await jsonRequest<{ manifest: unknown }>(SLACK_MANIFEST_API)).manifest,
    [],
  );

  const createApp = useCallback(async () => {
    setBusy('create');
    try {
      await openExternalWebUrl(slackCreateAppUrl(await fetchManifest()));
      toast.success('Slack opened in your browser. Pick your workspace, create the app, then install it.');
      void setPanel('connect');
    } catch (err) {
      toast.error(`Couldn’t open Slack: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [fetchManifest, setPanel]);

  const copyManifest = useCallback(async () => {
    setBusy('copy');
    try {
      await navigator.clipboard.writeText(JSON.stringify(await fetchManifest(), null, 2));
      toast.success('Manifest copied. In Slack choose Create New App → From a manifest and paste it.');
    } catch (err) {
      toast.error(`Couldn’t copy the manifest: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [fetchManifest]);

  const connect = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const app = appToken.trim();
      const bot = botToken.trim();
      const problem = slackTokenProblem(app, bot);
      if (problem) {
        setFormError(problem);
        return;
      }
      setBusy('connect');
      setFormError(null);
      try {
        await jsonRequest(SLACK_CONNECT_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appToken: app, botToken: bot }),
        });
        setAppToken('');
        setBotToken('');
        void setPanel(null);
        toast.success('Slack connected.');
        await load();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [appToken, botToken, load, setPanel],
  );

  const connected = sources ?? [];
  return (
    <section className="pc-settings-section" aria-label="Slack" data-provider="slack-setup" style={cardStyle}>
      <div style={cardHead}>
        <div style={{ minWidth: 0 }}>
          <h2 style={cardTitle}>Slack</h2>
          <p style={muteText}>
            Report bugs and start plans from Slack. You create a Slack app in your own workspace from Papercusp’s
            manifest, install it, and paste its two tokens here.
          </p>
        </div>
        <div style={actionRow}>
          <Button variant={connected.length > 0 ? 'neutral' : 'primary'} onClick={() => void createApp()} disabled={busy !== null}>
            Create Slack app
          </Button>
          <Button variant="ghost" onClick={() => void copyManifest()} disabled={busy !== null}>
            Copy manifest
          </Button>
          <Button
            variant={panel === 'connect' ? 'accent' : 'ghost'}
            aria-expanded={panel === 'connect'}
            aria-controls="slack-connect-form"
            onClick={() => void setPanel(panel === 'connect' ? null : 'connect')}
          >
            {connected.length > 0 ? 'Replace tokens' : 'Enter tokens'}
          </Button>
        </div>
      </div>

      {loadError && sources === null && (
        <p role="alert" style={errorText}>
          Couldn’t load Slack status: {loadError}
        </p>
      )}
      {sources !== null && connected.length === 0 && <p style={muteText}>No Slack workspace connected.</p>}
      {connected.map((source) => (
        <div key={source.id} style={rowStyle} data-slack-source={source.id}>
          <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{source.teamName ?? source.teamId ?? 'Slack workspace'}</span>
          <span style={badgeStyle(source.status)}>{source.status}</span>
          <div style={metaText}>
            Bot: {source.botName ? `@${source.botName}` : (source.botUserId ?? 'unknown')}
            {source.lastConnectedAt ? ` · Last connected ${new Date(source.lastConnectedAt).toLocaleString()}` : ''}
          </div>
          {source.lastError && <p style={errorText}>Last error: {source.lastError}</p>}
        </div>
      ))}

      {panel === 'connect' && (
        <form id="slack-connect-form" onSubmit={(event) => void connect(event)} style={formStyle} aria-label="Slack tokens">
          <ol style={stepList}>
            <li>
              In the app’s <strong>Basic Information</strong> page, generate an app-level token with the
              <code> connections:write</code> scope (it starts with <code>xapp-</code>).
            </li>
            <li>
              Install the app to your workspace, then copy the <strong>Bot User OAuth Token</strong> from
              <strong> OAuth &amp; Permissions</strong> (it starts with <code>xoxb-</code>).
            </li>
            <li>
              Lost the create page? Open{' '}
              <a href={SLACK_APPS_URL} onClick={(event) => { event.preventDefault(); void openExternalWebUrl(SLACK_APPS_URL); }}>
                your Slack apps
              </a>
              .
            </li>
          </ol>
          <label style={fieldLabel}>
            App-level token
            <input
              type="password"
              name="slack-app-token"
              autoComplete="off"
              spellCheck={false}
              placeholder="xapp-…"
              value={appToken}
              onChange={(event) => setAppToken(event.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={fieldLabel}>
            Bot token
            <input
              type="password"
              name="slack-bot-token"
              autoComplete="off"
              spellCheck={false}
              placeholder="xoxb-…"
              value={botToken}
              onChange={(event) => setBotToken(event.target.value)}
              style={inputStyle}
            />
          </label>
          {formError && (
            <p role="alert" style={errorText}>
              {formError}
            </p>
          )}
          <div style={actionRow}>
            <Button type="submit" variant="primary" disabled={busy !== null || !appToken.trim() || !botToken.trim()}>
              {busy === 'connect' ? 'Connecting…' : 'Connect Slack'}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function badgeStyle(status: string): CSSProperties {
  const color = status === 'connected' ? 'var(--good)' : status === 'connecting' ? 'var(--warn, #d29922)' : 'var(--bad)';
  return { marginLeft: 8, fontSize: 11, color, border: `1px solid ${color}`, borderRadius: 4, padding: '0 4px' };
}

const cardStyle: CSSProperties = { marginBottom: 20 };
const cardHead: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8, flexWrap: 'wrap' };
const cardTitle: CSSProperties = { fontSize: 16, margin: 0 };
const actionRow: CSSProperties = { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' };
const rowStyle: CSSProperties = { borderTop: '1px solid var(--border, rgba(127,127,127,0.25))', padding: '10px 0' };
const muteText: CSSProperties = { color: 'var(--fg-mute)', fontSize: 13, margin: '6px 0' };
const metaText: CSSProperties = { color: 'var(--fg-mute)', fontSize: 12, marginTop: 2 };
const errorText: CSSProperties = { color: 'var(--bad)', fontSize: 12, margin: '4px 0 0', overflowWrap: 'anywhere' };
const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 };
const stepList: CSSProperties = { margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--fg)', display: 'flex', flexDirection: 'column', gap: 4 };
const fieldLabel: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--fg-mute)' };
const inputStyle: CSSProperties = {
  font: 'inherit',
  fontSize: 13,
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--border, rgba(127,127,127,0.35))',
  background: 'var(--bg)',
  color: 'var(--fg)',
};
