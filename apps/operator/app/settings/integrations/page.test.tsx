// @vitest-environment jsdom
/**
 * Settings → Integrations (linear-asana-task-sync-2026-10-05 P-007, D-014): renders from the
 * overview, subscribes the live query as the user the routes resolve, and sends every write to its
 * route with the body the route expects. The source's harness and a rule's target harness are
 * deliberately different values: the page lets a user pick them independently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';

const H = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  sync: new Map<string, unknown[]>(),
  queryArgs: new Map<string, unknown>(),
  queryEnabled: new Map<string, boolean | undefined>(),
  desktop: false,
  openExternal: vi.fn(async (_href: string) => {}),
  routes: [] as Array<{ method: string; path: string | RegExp; status: number; body: unknown }>,
  calls: [] as Array<{ method: string; url: string; body: unknown }>,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName, args, enabled }: { queryName: string; args: unknown; enabled?: boolean }) => {
    H.queryArgs.set(queryName, args);
    H.queryEnabled.set(queryName, enabled);
    return { data: enabled === false ? undefined : H.sync.get(queryName), loading: false, error: null };
  },
}));

vi.mock('sonner', () => ({ toast: H.toast }));

vi.mock('nuqs', () => ({
  parseAsString: { withDefault: (defaultValue: string) => ({ defaultValue }) },
  parseAsStringEnum: () => ({ withDefault: (defaultValue: string) => ({ defaultValue }) }),
  useQueryState: (_key: string, parser?: { defaultValue?: string }) => useState<string | null>(parser?.defaultValue ?? ''),
}));

vi.mock('../../harness/Select', () => ({
  Select: ({
    value,
    onChange,
    options,
    ariaLabel,
  }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: unknown }>;
    ariaLabel?: string;
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="" disabled>
        —
      </option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {String(option.label)}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('../../_components/ExternalLinkProvider', () => ({
  isExternalWebUrl: (href: string, current: string) => new URL(href).origin !== new URL(current).origin,
  openExternalWebUrl: H.openExternal,
}));

vi.mock('@/lib/ipc-status-tauri', () => ({ isDesktop: () => H.desktop }));

import Page from './page';

const API = '/api/user/integrations/tickets';

const LINEAR = {
  id: 'linear',
  displayName: 'Linear',
  capabilities: ['ticket.sync', 'ticket.containers'],
  canListContainers: true,
  statusMapping: 'provider-defined',
  requiredConfig: ['teamIds'],
  connectHref: '/api/oauth/start?provider=linear&return=%2Fsettings%2Fintegrations',
};
const ASANA = {
  id: 'asana',
  displayName: 'Asana',
  capabilities: ['ticket.sync', 'ticket.containers'],
  canListContainers: true,
  statusMapping: 'sections',
  requiredConfig: ['projectGids'],
  connectHref: '/api/oauth/start?provider=asana&return=%2Fsettings%2Fintegrations',
};

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: 'src-1',
    provider: 'linear',
    providerAccountId: 'org-1',
    accountLabel: 'Acme',
    status: 'connected',
    lastError: null,
    lastSyncAt: null,
    nextAttemptAt: null,
    failureCount: 0,
    config: { accountLabel: 'Acme' },
    missingConfig: ['teamIds', 'harnessSlug'],
    mirrored: 0,
    admitted: 0,
    rules: [],
    ...overrides,
  };
}

function route(method: string, path: string | RegExp, body: unknown, status = 200) {
  H.routes.push({ method, path, status, body });
}

function serve(overview: { providers: unknown[]; sources: unknown[] }) {
  route('GET', API, { ok: true, userId: 'user-1', ...overview });
}

/** The rendered row for one source, once the overview has loaded it. */
async function row(sourceId: string) {
  const element = await waitFor(() => {
    const found = document.querySelector(`[data-source="${sourceId}"]`);
    if (!found) throw new Error(`source row ${sourceId} is not rendered`);
    return found as HTMLElement;
  });
  return within(element);
}
const call = (method: string, url: string) => H.calls.find((c) => c.method === method && c.url === url);

beforeEach(() => {
  H.routes = [];
  H.calls = [];
  H.sync.clear();
  H.queryArgs.clear();
  H.queryEnabled.clear();
  H.desktop = false;
  H.sync.set('harnessProjects.lite', [{ slug: 'papercusp' }, { slug: 'website' }]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      H.calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
      const match = H.routes.find((r) => r.method === method && (typeof r.path === 'string' ? r.path === url : r.path.test(url)));
      const status = match?.status ?? 404;
      const body = match ? match.body : { ok: false, error: 'no_route', detail: `${method} ${url}` };
      return { ok: status < 400, status, json: async () => body };
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Settings → Integrations', () => {
  it('renders each provider from the overview and subscribes the live query as the resolved user', async () => {
    serve({ providers: [LINEAR, ASANA], sources: [source({ mirrored: 1, admitted: 0 })] });
    render(<Page />);

    await screen.findByText('Acme');
    expect(H.queryArgs.get('integrations.tickets')).toEqual({ userId: 'user-1' });
    expect(H.queryEnabled.get('integrations.tickets')).toBe(true);

    const linear = within(screen.getByRole('region', { name: 'Linear' }));
    expect(linear.getByRole('button', { name: 'Connect another account' })).toBeTruthy();
    expect(linear.getByText('Needs teams and a harness to store tickets in before it can sync.')).toBeTruthy();
    expect(linear.getByText(/1 ticket mirrored/)).toBeTruthy();

    const asana = within(screen.getByRole('region', { name: 'Asana' }));
    expect(asana.getByRole('button', { name: 'Connect Asana' })).toBeTruthy();
    expect(asana.getByText('No Asana account connected.')).toBeTruthy();
  });

  it('renders the live query over the first read once it answers', async () => {
    serve({ providers: [LINEAR], sources: [source()] });
    H.sync.set('integrations.tickets', [{ providers: [LINEAR], sources: [source({ accountLabel: 'Acme (live)' })] }]);
    render(<Page />);

    expect(await screen.findByText('Acme (live)')).toBeTruthy();
    expect(screen.queryByText('Acme')).toBeNull();
  });

  it('shows the read failure when the overview cannot load', async () => {
    route('GET', API, { ok: false, error: 'ticket_integrations_failed', detail: 'database unavailable' }, 500);
    render(<Page />);
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t load integrations: database unavailable');
  });

  it('saves the chosen teams and harness through the config route', async () => {
    serve({ providers: [LINEAR], sources: [source()] });
    route('POST', `${API}/sources/src-1/containers`, {
      ok: true,
      truncated: false,
      containers: [
        { id: 'team-a', name: 'Engineering', kind: 'team', key: 'ENG' },
        { id: 'team-b', name: 'Design', kind: 'team', key: 'DES' },
      ],
    });
    route('PATCH', `${API}/sources/src-1/config`, { ok: true, config: {}, missingConfig: [] });
    render(<Page />);

    fireEvent.click((await row('src-1')).getByRole('button', { name: 'What syncs' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Engineering/ }));
    fireEvent.change(screen.getByLabelText('Harness to store tickets in'), { target: { value: 'website' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(call('PATCH', `${API}/sources/src-1/config`)).toBeTruthy());
    expect(call('POST', `${API}/sources/src-1/containers`)?.body).toEqual({ args: {} });
    expect(call('PATCH', `${API}/sources/src-1/config`)?.body).toEqual({ patch: { harnessSlug: 'website', teamIds: ['team-a'] } });
    await waitFor(() => expect(H.toast.success).toHaveBeenCalledWith('Saved. Linear syncs this account shortly.'));
  });

  it('falls back to id fields when the provider cannot list its containers', async () => {
    serve({ providers: [LINEAR], sources: [source()] });
    route(
      'POST',
      `${API}/sources/src-1/containers`,
      { ok: false, error: 'provider_capability_unsupported', detail: 'no ticket.containers' },
      409,
    );
    route('PATCH', `${API}/sources/src-1/config`, { ok: true, config: {}, missingConfig: [] });
    render(<Page />);

    fireEvent.click((await row('src-1')).getByRole('button', { name: 'What syncs' }));
    await screen.findByText('Linear can’t list its teams or projects here, so enter their ids.');
    fireEvent.change(screen.getByLabelText('Teams'), { target: { value: 'team-a, team-b' } });
    fireEvent.change(screen.getByLabelText('Harness to store tickets in'), { target: { value: 'website' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(call('PATCH', `${API}/sources/src-1/config`)?.body).toEqual({
        patch: { harnessSlug: 'website', teamIds: ['team-a', 'team-b'] },
      }),
    );
  });

  it('keeps only the chosen workspace’s projects', async () => {
    const asana = source({
      id: 'src-2',
      provider: 'asana',
      accountLabel: 'Acme Asana',
      config: { workspaceGid: 'ws-1', projectGids: ['p-1'], harnessSlug: 'website' },
      missingConfig: [],
    });
    serve({ providers: [ASANA], sources: [asana] });
    route('POST', `${API}/sources/src-2/containers`, {
      ok: true,
      truncated: false,
      containers: [
        { id: 'ws-1', name: 'Acme', kind: 'workspace' },
        { id: 'ws-2', name: 'Side project', kind: 'workspace' },
        { id: 'p-1', name: 'Website', kind: 'project', parentId: 'ws-1' },
        { id: 'p-2', name: 'Mobile', kind: 'project', parentId: 'ws-2' },
      ],
    });
    route('PATCH', `${API}/sources/src-2/config`, { ok: true, config: {}, missingConfig: [] });
    render(<Page />);

    fireEvent.click((await row('src-2')).getByRole('button', { name: 'What syncs' }));
    expect(((await screen.findByRole('checkbox', { name: /Website/ })) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('checkbox', { name: /Mobile/ })).toBeNull();

    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'ws-2' } });
    expect(screen.queryByRole('checkbox', { name: /Website/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Mobile/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(call('PATCH', `${API}/sources/src-2/config`)?.body).toEqual({
        patch: { harnessSlug: 'website', workspaceGid: 'ws-2', projectGids: ['p-2'] },
      }),
    );
  });

  it('maps sections onto canonical columns where the provider has sections, and says why there is nothing to map otherwise', async () => {
    const asana = source({
      id: 'src-2',
      provider: 'asana',
      accountLabel: 'Acme Asana',
      config: { workspaceGid: 'ws-1', projectGids: ['p-1'], harnessSlug: 'website', sectionCategories: { 'sec-todo': 'todo' } },
      missingConfig: [],
    });
    serve({ providers: [LINEAR, ASANA], sources: [source(), asana] });
    route('POST', /\/sources\/src-[12]\/containers$/, {
      ok: true,
      truncated: false,
      containers: [
        { id: 'ws-1', name: 'Acme', kind: 'workspace' },
        {
          id: 'p-1',
          name: 'Website',
          kind: 'project',
          parentId: 'ws-1',
          sections: [
            { id: 'sec-todo', name: 'To do' },
            { id: 'sec-doing', name: 'Doing' },
          ],
        },
      ],
    });
    route('PATCH', `${API}/sources/src-2/config`, { ok: true, config: {}, missingConfig: [] });
    render(<Page />);

    fireEvent.click((await row('src-1')).getByRole('button', { name: 'Status mapping' }));
    expect(await screen.findByText(/Linear decides each ticket’s column from its own workflow-state types/)).toBeTruthy();

    fireEvent.click((await row('src-2')).getByRole('button', { name: 'Status mapping' }));
    const doing = (await screen.findByLabelText('Column for Doing')) as HTMLSelectElement;
    expect(doing.value).toBe('default');
    expect((screen.getByLabelText('Column for To do') as HTMLSelectElement).value).toBe('todo');
    fireEvent.change(doing, { target: { value: 'in-progress' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));

    await waitFor(() =>
      expect(call('PATCH', `${API}/sources/src-2/config`)?.body).toEqual({
        patch: { sectionCategories: { 'sec-todo': 'todo', 'sec-doing': 'in-progress' } },
      }),
    );
  });

  it('adds a preset rule into a harness other than the source’s, and disables a rule', async () => {
    const rule = {
      id: 'rule-1',
      title: 'Delegated to Papercusp',
      harness: 'papercusp',
      workKind: 'change',
      enabled: true,
    };
    serve({
      providers: [LINEAR],
      sources: [source({ config: { accountLabel: 'Acme', teamIds: ['team-a'], harnessSlug: 'website' }, missingConfig: [], rules: [rule] })],
    });
    route('POST', `${API}/sources/src-1/containers`, { ok: true, truncated: false, containers: [] });
    route('POST', `${API}/sources/src-1/rules`, {
      ok: true,
      rule: { ...rule, id: 'rule-2' },
      backfill: { scanned: 3, admitted: 2, existing: 0, refused: [], truncated: false },
    });
    route('DELETE', `${API}/sources/src-1/rules/rule-1`, { ok: true, rule: { ...rule, enabled: false } });
    render(<Page />);

    fireEvent.click((await row('src-1')).getByRole('button', { name: 'Rules (1)' }));
    const rules = within(await screen.findByRole('list', { name: 'Admission rules' }));
    expect(rules.getByText('Delegated to Papercusp')).toBeTruthy();
    expect(rules.getByText('Change in papercusp')).toBeTruthy();
    expect((screen.getByLabelText('Target harness') as HTMLSelectElement).value).toBe('website');

    fireEvent.change(screen.getByLabelText('Rule'), { target: { value: 'label' } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'needs-agent' } });
    fireEvent.change(screen.getByLabelText('Work kind'), { target: { value: 'task' } });
    fireEvent.change(screen.getByLabelText('Target harness'), { target: { value: 'papercusp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    await waitFor(() =>
      expect(call('POST', `${API}/sources/src-1/rules`)?.body).toEqual({
        preset: 'label',
        value: 'needs-agent',
        harness: 'papercusp',
        workKind: 'task',
      }),
    );
    await waitFor(() => expect(H.toast.success).toHaveBeenCalledWith('Rule added. 2 synced tickets admitted as work.'));

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(call('DELETE', `${API}/sources/src-1/rules/rule-1`)).toBeTruthy());
  });

  it('counts a backfilled ticket the intake attached to an already-filed bug as admitted', async () => {
    serve({ providers: [LINEAR], sources: [source({ config: { harnessSlug: 'website' }, missingConfig: [] })] });
    route('POST', `${API}/sources/src-1/containers`, { ok: true, truncated: false, containers: [] });
    route('POST', `${API}/sources/src-1/rules`, {
      ok: true,
      rule: { id: 'rule-3', title: 'Label needs-agent', harness: 'website', workKind: 'bug', enabled: true },
      backfill: { scanned: 3, admitted: 1, folded: 1, existing: 1, refused: [], truncated: false },
    });
    render(<Page />);

    fireEvent.click((await row('src-1')).getByRole('button', { name: 'Rules (0)' }));
    fireEvent.change(await screen.findByLabelText('Rule'), { target: { value: 'label' } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'needs-agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    await waitFor(() =>
      expect(H.toast.success).toHaveBeenCalledWith(
        'Rule added. 2 synced tickets admitted as work (1 attached to a bug that was already filed).',
      ),
    );
  });

  it('refuses a value-taking preset with no value without calling the route', async () => {
    serve({ providers: [LINEAR], sources: [source({ config: { harnessSlug: 'website' }, missingConfig: ['teamIds'] })] });
    route('POST', `${API}/sources/src-1/containers`, { ok: true, truncated: false, containers: [] });
    render(<Page />);

    fireEvent.click((await row('src-1')).getByRole('button', { name: 'Rules (0)' }));
    fireEvent.change(await screen.findByLabelText('Rule'), { target: { value: 'project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    await waitFor(() => expect(H.toast.error).toHaveBeenCalledWith('Enter a project for this rule.'));
    expect(call('POST', `${API}/sources/src-1/rules`)).toBeUndefined();
  });

  it('opens a provider’s sign-in in the system browser on desktop', async () => {
    H.desktop = true;
    serve({ providers: [LINEAR], sources: [] });
    route('GET', /^\/api\/oauth\/start\?/, { ok: true, authorizationUrl: 'https://linear.app/oauth/authorize?state=s' });
    render(<Page />);

    fireEvent.click(await screen.findByRole('button', { name: 'Connect Linear' }));

    await waitFor(() => expect(H.openExternal).toHaveBeenCalledWith('https://linear.app/oauth/authorize?state=s'));
    const start = new URL(H.calls.find((c) => c.url.startsWith('/api/oauth/start'))!.url, 'http://localhost');
    expect(Object.fromEntries(start.searchParams)).toEqual({ provider: 'linear', return: '/settings/integrations', response: 'json' });
    expect(H.toast.success).toHaveBeenCalledWith(expect.stringContaining('Linear sign-in opened in your browser'));
  });

  it('refuses to open a non-https authorization URL', async () => {
    H.desktop = true;
    serve({ providers: [LINEAR], sources: [] });
    route('GET', /^\/api\/oauth\/start\?/, { ok: true, authorizationUrl: 'http://linear.example/oauth/authorize' });
    render(<Page />);

    fireEvent.click(await screen.findByRole('button', { name: 'Connect Linear' }));

    await waitFor(() =>
      expect(H.toast.error).toHaveBeenCalledWith(
        'Couldn’t start Linear sign-in: the OAuth server returned an unsafe authorization URL',
      ),
    );
    expect(H.openExternal).not.toHaveBeenCalled();
  });
});
