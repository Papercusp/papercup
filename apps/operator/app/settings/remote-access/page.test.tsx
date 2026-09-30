// @vitest-environment jsdom
/**
 * Settings → Remote access (external-app-access P-010, D-025).
 *
 * The screen's contract: every phone, app key and service key of the workspace is listed with its
 * creator and last use and with pause / rotate / revoke controls (R-26); the switch posts the
 * workspace's kill switch (R-41); a confirmed revoke posts the entry's id AND kind so a phone goes
 * to the device store and a key to the app-key store (R-40). The end-to-end refusals themselves
 * are proven in the headless Tauri shell and by the route + store tests; this file pins the
 * screen's wiring to those routes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

const H = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  setters: {} as Record<string, ReturnType<typeof vi.fn>>,
  rows: [] as unknown[],
}));

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('nuqs', () => {
  const withDefault = (d: unknown) => ({ defaultValue: d });
  const parser = { withDefault };
  return {
    useQueryState: (k: string, p?: { defaultValue?: unknown }) => {
      H.setters[k] ??= vi.fn();
      return [k in H.query ? H.query[k] : (p?.defaultValue ?? null), H.setters[k]];
    },
    parseAsString: parser,
    parseAsBoolean: parser,
    parseAsStringEnum: () => parser,
  };
});
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: H.rows, loading: false, error: null }),
}));
vi.mock('@/app/harness/Select', () => ({
  Select: ({ value }: { value: string }) => <span data-testid="ws-select">{value}</span>,
}));
vi.mock('@/app/_components/SetupWizard/StepOwnTunnel', () => ({ StepOwnTunnel: () => <div data-testid="own-tunnel-step" /> }));
vi.mock('@/app/harness/ConfirmModal', () => ({
  ConfirmModal: (p: { open: boolean; title: string; body: ReactNode; confirmLabel?: string; onConfirm: () => void }) =>
    p.open ? (
      <div role="dialog" aria-label={p.title}>
        {p.body}
        <button type="button" onClick={() => void p.onConfirm()}>{p.confirmLabel}</button>
      </div>
    ) : null,
}));

import RemoteAccessSettingsPage, { entryTags, type RemoteAccessEntryView } from './page';

function entry(over: Partial<RemoteAccessEntryView>): RemoteAccessEntryView {
  return {
    id: 'x',
    kind: 'app',
    label: 'x',
    creator: 'owner@example.com',
    scopes: {},
    pairedAt: '2026-09-29T00:00:00Z',
    lastSeen: null,
    lastIp: null,
    expiresAt: null,
    pausedAt: null,
    spendCapCents: null,
    spendCapWindowSec: null,
    rotatedAt: null,
    previousKeyValidUntil: null,
    clientAuth: null,
    ...over,
  };
}

const ENTRIES = [
  entry({ id: 'dev-phone', kind: 'mobile', label: 'Avi phone', lastSeen: '2026-09-30T08:00:00Z', lastIp: '10.0.0.9' }),
  entry({ id: 'pcapp_app', kind: 'app', label: 'zapier', creator: 'avi@example.com', scopes: { tools: ['plans:list'] } }),
  entry({ id: 'pcapp_svc', kind: 'service', label: 'nightly', pausedAt: '2026-09-30T09:00:00Z', spendCapCents: 500 }),
];

function overview(enabled = true) {
  return {
    workspaceId: 'ws1',
    remoteAccess: { workspaceId: 'ws1', enabled, changedAt: null, changedBy: null },
    entries: ENTRIES,
    ownTunnel: null,
    ownTunnelError: null,
  };
}

let posts: Array<{ url: string; body: Record<string, unknown> }>;

beforeEach(() => {
  H.query = { ws: 'ws1' };
  H.setters = {};
  H.rows = [overview()];
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === '/api/workspaces') {
        return new Response(JSON.stringify({ current: 'ws1', workspaces: [{ id: 'ws1', name: 'One' }] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Remote access screen', () => {
  it('lists every phone, app key and service key with creator, last use and its controls (R-26)', () => {
    render(<RemoteAccessSettingsPage />);
    const items = screen.getAllByTestId('remote-access-entry');
    expect(items.map((li) => li.getAttribute('data-entry-id'))).toEqual(['dev-phone', 'pcapp_app', 'pcapp_svc']);
    for (const li of items) {
      for (const action of ['pause', 'rotate', 'revoke']) {
        expect(li.querySelector(`[data-action="${action}"]`), `${li.dataset.entryId} ${action}`).not.toBeNull();
      }
    }
    // Scope is a key property; a phone has none to edit.
    expect(items[0]!.querySelector('[data-action="edit-scope"]')).toBeNull();
    expect(items[1]!.querySelector('[data-action="edit-scope"]')).not.toBeNull();
    expect(within(items[1]!).getByText(/Added by avi@example.com/)).toBeTruthy();
    expect(within(items[0]!).getByText(/from 10\.0\.0\.9/)).toBeTruthy();
    expect(within(items[2]!).getByText('Resume')).toBeTruthy();
  });

  it('the switch posts the workspace kill switch (R-41)', async () => {
    render(<RemoteAccessSettingsPage />);
    expect(screen.getByTestId('remote-access-state').dataset.enabled).toBe('true');
    fireEvent.click(screen.getByTestId('remote-access-toggle'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/remote-access', body: { workspaceId: 'ws1', enabled: false } });
  });

  it('says what off means, including that phones keep working', () => {
    H.rows = [overview(false)];
    render(<RemoteAccessSettingsPage />);
    expect(screen.getByTestId('remote-access-state').textContent).toContain('off');
    expect(screen.getByText(/Paired phones are not affected/)).toBeTruthy();
    expect(screen.getByTestId('remote-access-toggle').textContent).toBe('Turn on');
  });

  it('asks before revoking, then revokes the key with its kind (R-40)', async () => {
    H.query = { ws: 'ws1', confirm: 'revoke:pcapp_app' };
    render(<RemoteAccessSettingsPage />);
    const dialog = screen.getByRole('dialog', { name: 'Revoke zapier?' });
    fireEvent.click(within(dialog).getByText('Revoke'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/remote-access/revoke', body: { workspaceId: 'ws1', id: 'pcapp_app', kind: 'app' } });
    expect(H.setters.confirm).toHaveBeenCalledWith(null);
  });

  it('rotating a phone revokes it and opens pairing', async () => {
    H.query = { ws: 'ws1', confirm: 'rotate:dev-phone' };
    render(<RemoteAccessSettingsPage />);
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Rotate'));
    await waitFor(() => expect(H.setters.pair).toHaveBeenCalledWith(true));
    expect(posts[0]).toEqual({ url: '/api/remote-access/revoke', body: { workspaceId: 'ws1', id: 'dev-phone', kind: 'mobile' } });
  });

  it('opens nothing for a confirmation that names no listed entry', () => {
    H.query = { ws: 'ws1', confirm: 'revoke:pcapp_gone' };
    render(<RemoteAccessSettingsPage />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('pauses a phone through the device path', async () => {
    render(<RemoteAccessSettingsPage />);
    const phone = screen.getAllByTestId('remote-access-entry')[0]!;
    fireEvent.click(phone.querySelector('[data-action="pause"]')!);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ workspaceId: 'ws1', id: 'dev-phone', kind: 'mobile', paused: true });
  });
});

describe('entryTags', () => {
  it('names paused, expired, overlap and cap state', () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    expect(entryTags(entry({ pausedAt: '2026-09-30T00:00:00Z', expiresAt: '2026-09-29T00:00:00Z' }), now)).toEqual(['Paused', 'Expired']);
    const tags = entryTags(entry({ previousKeyValidUntil: '2026-09-30T13:00:00Z', spendCapCents: 1234, clientAuth: 'client_secret' }), now);
    expect(tags[0]).toMatch(/^Old key works until/);
    expect(tags).toContain('OAuth client (secret)');
    expect(tags).toContain('Cap $12.34');
  });
});
