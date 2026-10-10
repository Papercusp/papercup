// @vitest-environment jsdom
/**
 * Slack card on Settings → Integrations (simplify-integration-setup-2026-10-10 P-001): opens Slack's
 * create-from-manifest page pre-filled from the existing manifest route, posts the user's own
 * tokens to the existing connect route, and renders the connected team and bot without ever
 * rendering a token back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

const H = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  openExternal: vi.fn(async (_href: string) => {}),
  calls: [] as Array<{ method: string; url: string; body: unknown }>,
  snapshot: { sources: [] as unknown[] } as { sources: unknown[] },
  connectStatus: 200,
  connectBody: { ok: true } as Record<string, unknown>,
}));

vi.mock('sonner', () => ({ toast: H.toast }));
vi.mock('nuqs', () => ({
  parseAsStringEnum: () => ({}),
  useQueryState: () => useState<string | null>(null),
}));
vi.mock('../../_components/ExternalLinkProvider', () => ({ openExternalWebUrl: H.openExternal }));

import {
  SlackSetupCard,
  slackCreateAppUrl,
  slackSourcesFromSnapshot,
  slackTokenProblem,
} from './SlackSetupCard';

const MANIFEST = { display_information: { name: 'Papercusp Triggers' }, settings: { socket_mode_enabled: true } };
const CONNECTED = {
  id: 'src-1',
  kind: 'slack',
  status: 'connected',
  credentialRef: 'oauth-tokens/papercusp/slack-socket/u1',
  config: { teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT', botName: 'papercusp', channels: [] },
  lastConnectedAt: '2026-10-10T20:00:00.000Z',
  lastError: null,
};

beforeEach(() => {
  H.calls = [];
  H.snapshot = { sources: [] };
  H.connectStatus = 200;
  H.connectBody = { ok: true };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      H.calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
      if (url === '/api/admin/triggers/slack/manifest') return json(200, { ok: true, manifest: MANIFEST });
      if (url === '/api/admin/triggers/slack/connect' && method === 'POST') {
        if (H.connectStatus === 200) H.snapshot = { sources: [CONNECTED] };
        return json(H.connectStatus, H.connectBody);
      }
      if (url === '/api/admin/triggers') return json(200, H.snapshot);
      return json(404, { ok: false, error: 'not_found' });
    }),
  );
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('slackCreateAppUrl', () => {
  it('pre-fills Slack’s create-from-manifest page with the manifest as JSON', () => {
    const url = new URL(slackCreateAppUrl(MANIFEST));
    expect(url.origin + url.pathname).toBe('https://api.slack.com/apps');
    expect(url.searchParams.get('new_app')).toBe('1');
    expect(JSON.parse(url.searchParams.get('manifest_json') ?? '')).toEqual(MANIFEST);
  });
});

describe('slackSourcesFromSnapshot', () => {
  it('keeps only Slack sources and only their display fields', () => {
    const views = slackSourcesFromSnapshot({ sources: [CONNECTED, { id: 'a', kind: 'asana', status: 'connected', config: {} }] });
    expect(views).toEqual([
      {
        id: 'src-1',
        status: 'connected',
        teamName: 'Acme',
        teamId: 'T1',
        botName: 'papercusp',
        botUserId: 'UBOT',
        lastConnectedAt: '2026-10-10T20:00:00.000Z',
        lastError: null,
      },
    ]);
    expect(JSON.stringify(views)).not.toContain('oauth-tokens');
  });

  it('reads a snapshot without sources as none connected', () => {
    expect(slackSourcesFromSnapshot({ enabled: false })).toEqual([]);
  });
});

describe('slackTokenProblem', () => {
  it('names the token whose prefix is wrong and accepts the right pair', () => {
    expect(slackTokenProblem('xoxb-1', 'xoxb-2')).toMatch(/xapp-/);
    expect(slackTokenProblem('xapp-1', 'xapp-2')).toMatch(/xoxb-/);
    expect(slackTokenProblem('xapp-1', 'xoxb-2')).toBeNull();
  });
});

describe('SlackSetupCard', () => {
  it('says no workspace is connected when the snapshot has no Slack source', async () => {
    render(<SlackSetupCard />);
    expect(await screen.findByText('No Slack workspace connected.')).toBeTruthy();
  });

  it('opens Slack with the manifest pre-filled and then shows the token form', async () => {
    render(<SlackSetupCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Create Slack app' }));
    await waitFor(() => expect(H.openExternal).toHaveBeenCalledTimes(1));
    const opened = new URL(H.openExternal.mock.calls[0]![0]);
    expect(JSON.parse(opened.searchParams.get('manifest_json') ?? '')).toEqual(MANIFEST);
    expect(await screen.findByRole('form', { name: 'Slack tokens' })).toBeTruthy();
  });

  it('copies the manifest as the fallback when the pre-filled link does not work', async () => {
    render(<SlackSetupCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy manifest' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1));
    expect(JSON.parse((navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toEqual(MANIFEST);
  });

  it('posts both tokens to the connect route, clears them, and shows the connected team and bot', async () => {
    render(<SlackSetupCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enter tokens' }));
    const app = screen.getByLabelText('App-level token') as HTMLInputElement;
    const bot = screen.getByLabelText('Bot token') as HTMLInputElement;
    expect(app.type).toBe('password');
    expect(bot.type).toBe('password');
    fireEvent.change(app, { target: { value: ' xapp-1-abc ' } });
    fireEvent.change(bot, { target: { value: 'xoxb-2-def' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }));

    expect(await screen.findByText('Acme')).toBeTruthy();
    expect(screen.getByText(/Bot: @papercusp/)).toBeTruthy();
    expect(H.calls.find((call) => call.method === 'POST')).toEqual({
      method: 'POST',
      url: '/api/admin/triggers/slack/connect',
      body: { appToken: 'xapp-1-abc', botToken: 'xoxb-2-def' },
    });
    expect(screen.queryByRole('form', { name: 'Slack tokens' })).toBeNull();
    expect(document.body.innerHTML).not.toContain('xoxb-2-def');
    expect(document.body.innerHTML).not.toContain('xapp-1-abc');
  });

  it('refuses swapped tokens without calling the route', async () => {
    render(<SlackSetupCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enter tokens' }));
    fireEvent.change(screen.getByLabelText('App-level token'), { target: { value: 'xoxb-2' } });
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: 'xapp-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/xapp-/);
    expect(H.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('shows the route’s refusal and keeps the form open', async () => {
    H.connectStatus = 400;
    H.connectBody = { ok: false, error: 'slack_connect_failed', detail: 'slack_auth_test_200:invalid_auth' };
    render(<SlackSetupCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enter tokens' }));
    fireEvent.change(screen.getByLabelText('App-level token'), { target: { value: 'xapp-1' } });
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: 'xoxb-bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }));
    expect((await screen.findByRole('alert')).textContent).toContain('invalid_auth');
    expect(screen.getByRole('form', { name: 'Slack tokens' })).toBeTruthy();
  });
});
