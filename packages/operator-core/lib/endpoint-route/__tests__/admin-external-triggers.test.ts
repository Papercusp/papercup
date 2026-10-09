import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const flagEnabled = vi.fn(async () => true);
const loadSnapshot = vi.fn(async (_sql: unknown, _workspace: string) => ({
  enabled: true,
  counts: { sources: 0, bindings: 0, armed: 0, recentFailures: 0 },
  sources: [],
  bindings: [],
  recentRuns: [],
}));
const loadPlanSnapshot = vi.fn(async (_sql: unknown, _workspace: string, harness: string, plan: string) => ({
  harnessSlug: harness,
  planSlug: plan,
  schedule: { kind: 'cron', cron: '0 9 * * 1-5' },
  scheduleActive: false,
  scheduledAt: null,
  expiresAt: null,
  tzid: 'America/New_York',
  lastFire: null,
  nextFire: null,
  manualSource: 'input-schema',
}));
const createBinding = vi.fn(async (_sql: unknown, _workspace: string, input: Record<string, unknown>) => ({
  id: BINDING_ID,
  ...input,
  sourceKind: 'gmail',
  action: { type: 'launch-plan' },
  armed: false,
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
}));
const detachBinding = vi.fn(async (_sql: unknown, _workspace: string, id: string) => ({
  id,
  detachedAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
}));
const setArmed = vi.fn(async (_sql: unknown, _workspace: string, id: string, armed: boolean) => ({
  id,
  armed,
  updatedAt: '2026-08-22T00:00:00.000Z',
}));
const setStorm = vi.fn(async (_sql: unknown, _workspace: string, id: string, input: unknown) => ({
  id,
  stormPolicy: input,
  updatedAt: '2026-08-22T00:00:00.000Z',
}));
const notify = vi.fn(async (..._args: unknown[]) => {});
const connectSlack = vi.fn(async (_sql: unknown, input: Record<string, unknown>) => ({
  id: '20000000-0000-4000-8000-000000000001',
  kind: 'slack',
  status: 'connecting',
  credentialRef: `slack-socket:${input.field ?? input.ownerUserId}`,
  config: { teamId: 'T1' },
}));
const SLACK_ORG_DISABLED = 'slack_org_connector_disabled:legal_review_pending';
const connectOrgSlack = vi.fn(async (_sql: unknown, _input: Record<string, unknown>) => ({
  id: '20000000-0000-4000-8000-000000000002',
  kind: 'slack',
  status: 'connecting',
  credentialRef: 'slack-socket:org-T1',
  config: { teamId: 'T1', credentialModel: 'customer-internal-app' },
}));
const ensureSlackFlagship = vi.fn(async (_sql: unknown, _workspaceId: string, source: { id: string }) => ({
  plan: { created: true, schemaAdded: true },
  binding: {
    id: BINDING_ID,
    sourceId: source.id,
    sourceKind: 'slack',
    planHarnessSlug: 'papercusp',
    planSlug: 'slack-respond-in-thread-2026-08-22',
    eventPattern: 'ext:slack:mention',
    eventFilter: {},
    action: { type: 'launch-plan' },
    armed: false,
    stormPolicy: {},
  },
}));
const sql = vi.fn();
const getSource = vi.fn();
const ensureBugClassifier = vi.fn(async (_sql: unknown, _workspace: string, source: { id: string }, _createdBy: string) => ({
  plan: { created: true },
  binding: { id: BINDING_ID, sourceId: source.id, eventPattern: 'ext:slack:message', armed: false },
}));

vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => ({
    kind: 'system',
    slug: 'system:operator',
    workspaceId: 'ws-test',
    authMethod: 'superuser-bearer',
    trust: 'trusted',
    capabilities: new Set(['*']),
    label: 'su',
  })),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    constructor(
      public status: number,
      public reason: string,
    ) {
      super(reason);
    }
  },
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql }),
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: () => flagEnabled() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: '22222222-2222-4222-8222-222222222222' })),
}));
vi.mock('../../sync-sse', () => ({
  notifySyncInvalidate: (...args: Parameters<typeof notify>) => notify(...args),
}));
vi.mock('../../external-triggers/admin', () => ({
  createExternalTriggerBinding: (...args: Parameters<typeof createBinding>) => createBinding(...args),
  detachExternalTriggerBinding: (...args: Parameters<typeof detachBinding>) => detachBinding(...args),
  disabledExternalTriggerAdminSnapshot: () => ({
    enabled: false,
    counts: { sources: 0, bindings: 0, armed: 0, recentFailures: 0 },
    sources: [],
    bindings: [],
    recentRuns: [],
  }),
  loadExternalTriggerAdminSnapshot: (...args: Parameters<typeof loadSnapshot>) => loadSnapshot(...args),
  loadExternalTriggerPlanAdminSnapshot: (...args: Parameters<typeof loadPlanSnapshot>) => loadPlanSnapshot(...args),
  setExternalTriggerBindingArmed: (...args: Parameters<typeof setArmed>) => setArmed(...args),
  updateExternalTriggerBindingStormPolicy: (...args: Parameters<typeof setStorm>) => setStorm(...args),
}));
vi.mock('../../external-triggers/slack', () => ({
  SLACK_APP_MANIFEST_TEMPLATE: { settings: { socket_mode_enabled: true } },
  connectOwnedSlackSource: (...args: Parameters<typeof connectSlack>) => connectSlack(...args),
}));
vi.mock('../../external-triggers/slack-flagship', () => ({
  SLACK_RESPOND_IN_THREAD_PLAN: 'slack-respond-in-thread-2026-08-22',
  ensureSlackRespondInThreadBinding: (...args: Parameters<typeof ensureSlackFlagship>) => ensureSlackFlagship(...args),
}));
vi.mock('../../external-triggers/source-store', () => ({
  getExternalTriggerSource: (...args: unknown[]) => getSource(...args),
}));
vi.mock('../../external-triggers/slack-bug-classification', () => ({
  SLACK_BUG_CLASSIFICATION_PLAN: 'slack-classify-bug-2026-10-08',
  ensureSlackBugClassificationBinding: (...args: Parameters<typeof ensureBugClassifier>) => ensureBugClassifier(...args),
}));
vi.mock('../../data-sources/slack-org-connector', () => ({
  // Literal, not SLACK_ORG_DISABLED: this factory is hoisted above that const.
  SLACK_ORG_DISABLED_ERROR: 'slack_org_connector_disabled:legal_review_pending',
  connectOrganizationSlackSource: (...args: Parameters<typeof connectOrgSlack>) => connectOrgSlack(...args),
}));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import routes from '../routes/admin/external-triggers';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;
const [read, mutate, slackManifest, slackConnect, slackConnectOrg] = routes as unknown as AnyRoute[];
const URL = 'http://127.0.0.1:3070/admin/triggers';
const BINDING_ID = '10000000-0000-4000-8000-000000000001';

async function request(route: AnyRoute, method: 'GET' | 'PATCH' | 'POST', body?: unknown, headers: Record<string, string> = {}, query = '') {
  const app = new Hono();
  registerRoute(app, route);
  return app.request(`http://127.0.0.1:3070${route.path}${query}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  flagEnabled.mockResolvedValue(true);
  getSource.mockReset();
  sql.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('external-trigger admin route pair', () => {
  it('keeps owner-local and Slack routes under their explicit trust gates', () => {
    expect(read).toMatchObject({ method: 'GET', path: '/admin/triggers' });
    expect(mutate).toMatchObject({ method: 'PATCH', path: '/admin/triggers' });
    expect(read.auth).toEqual({ trust: ['verified', 'trusted', 'unverified-loopback'] });
    expect(mutate.auth).toEqual(read.auth);
    expect(slackManifest).toMatchObject({
      method: 'GET',
      path: '/admin/triggers/slack/manifest',
      auth: { trust: ['verified', 'trusted'] },
    });
    expect(slackConnect).toMatchObject({
      method: 'POST',
      path: '/admin/triggers/slack/connect',
      auth: { trust: ['verified', 'trusted'] },
    });
  });

  it('returns the shared snapshot and the default-ON flag fails open on provider errors', async () => {
    flagEnabled.mockRejectedValueOnce(new Error('flag provider offline'));
    const response = await request(read, 'GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: true });
    expect(loadSnapshot).toHaveBeenCalledWith(sql, 'ws-test');
  });

  it('folds the named plan schedule/manual snapshot into the shared trigger read', async () => {
    const response = await request(
      read,
      'GET',
      undefined,
      {},
      '?planSlug=triage-mail&planHarnessSlug=papercusp',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      plan: {
        planSlug: 'triage-mail',
        schedule: { kind: 'cron' },
        manualSource: 'input-schema',
      },
    });
    expect(loadPlanSnapshot).toHaveBeenCalledWith(sql, 'ws-test', 'papercusp', 'triage-mail');
  });

  it('returns the disabled shape without reading data when the flag is explicitly off', async () => {
    flagEnabled.mockResolvedValueOnce(false);
    const response = await request(read, 'GET');
    expect(await response.json()).toMatchObject({ enabled: false, bindings: [] });
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('refuses cross-origin writes before flag or data access', async () => {
    const response = await request(
      mutate,
      'PATCH',
      { op: 'set-armed', id: BINDING_ID, armed: true, confirm: true },
      { origin: 'https://evil.example' },
    );
    expect(response.status).toBe(403);
    expect(flagEnabled).not.toHaveBeenCalled();
    expect(setArmed).not.toHaveBeenCalled();
  });

  it('requires explicit owner confirmation for both arming directions', async () => {
    for (const armed of [true, false]) {
      const response = await request(mutate, 'PATCH', { op: 'set-armed', id: BINDING_ID, armed });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: 'owner_confirmation_required',
        gate: { category: 'schedule-arm', authority: 'owner', reversible: true },
      });
    }
    expect(setArmed).not.toHaveBeenCalled();
  });

  it('applies a confirmed arm and invalidates the shared admin snapshot', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'set-armed',
      id: BINDING_ID,
      armed: true,
      confirm: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, binding: { id: BINDING_ID, armed: true } });
    expect(setArmed).toHaveBeenCalledWith(sql, 'ws-test', BINDING_ID, true);
    expect(notify).toHaveBeenCalledWith('externalTriggers.admin', { workspaceId: 'ws-test' });
  });

  it('installs an external binding disarmed and invalidates the plan facet', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'attach-external',
      sourceId: '20000000-0000-4000-8000-000000000001',
      planHarnessSlug: 'papercusp',
      planSlug: 'triage-mail',
      eventPattern: 'ext:gmail:message.received',
      eventFilter: { label: 'support' },
      maxRuns: 2,
      windowSeconds: 60,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, binding: { armed: false } });
    expect(createBinding).toHaveBeenCalledWith(sql, 'ws-test', expect.objectContaining({
      planSlug: 'triage-mail',
      createdBy: 'owner:22222222-2222-4222-8222-222222222222',
    }));
    expect(notify).toHaveBeenCalledWith('plans.list', undefined);
  });

  it('accepts a goal target and forwards it without inventing plan columns', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'attach-external',
      sourceId: '20000000-0000-4000-8000-000000000001',
      goalId: 'goal-support-triage',
      eventPattern: 'ext:gmail:message.received',
      eventFilter: { label: 'support' },
    });
    expect(response.status).toBe(200);
    expect(createBinding).toHaveBeenCalledWith(sql, 'ws-test', expect.objectContaining({ goalId: 'goal-support-triage' }));
    const goalInput = createBinding.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(goalInput).not.toHaveProperty('planSlug');
    expect(goalInput).not.toHaveProperty('planHarnessSlug');
    expect(await response.json()).toMatchObject({ ok: true, binding: { armed: false } });
  });

  it('accepts the Gmail direct Email work-item target', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'attach-external',
      sourceId: '20000000-0000-4000-8000-000000000001',
      workItemHarnessSlug: 'email',
      workItemKind: 'email-draft-proposal',
      eventPattern: 'ext:gmail:message.received',
    });
    expect(response.status).toBe(200);
    expect(createBinding).toHaveBeenCalledWith(sql, 'ws-test', expect.objectContaining({
      workItemHarnessSlug: 'email',
      workItemKind: 'email-draft-proposal',
    }));
    expect(await response.json()).toMatchObject({ ok: true, binding: { armed: false } });
  });

  it('rejects an attach payload that mixes target families at the HTTP boundary', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'attach-external',
      sourceId: '20000000-0000-4000-8000-000000000001',
      planHarnessSlug: 'papercusp',
      planSlug: 'triage-mail',
      goalId: 'goal-support-triage',
      eventPattern: 'ext:gmail:message.received',
    });
    expect(response.status).toBe(400);
    expect(createBinding).not.toHaveBeenCalled();
  });

  it('requires confirmation, then soft-detaches without deleting history', async () => {
    const refused = await request(mutate, 'PATCH', { op: 'detach-external', id: BINDING_ID });
    expect(refused.status).toBe(409);
    expect(detachBinding).not.toHaveBeenCalled();

    const response = await request(mutate, 'PATCH', {
      op: 'detach-external', id: BINDING_ID, confirm: true,
    });
    expect(response.status).toBe(200);
    expect(detachBinding).toHaveBeenCalledWith(sql, 'ws-test', BINDING_ID);
    expect(notify).toHaveBeenCalledWith('plans.list', undefined);
  });

  it('validates and applies the canonical storm-policy fields', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'set-storm-policy',
      id: BINDING_ID,
      maxRuns: 3,
      windowSeconds: 120,
    });
    expect(response.status).toBe(200);
    expect(setStorm).toHaveBeenCalledWith(sql, 'ws-test', BINDING_ID, { maxRuns: 3, windowSeconds: 120 });
  });

  // WI-10004920: the dispatch validity window is settable from the admin surface,
  // on both doors, and bounded at the boundary by the engine's 31-day ceiling.
  it('forwards a stated dispatch validity window on set-storm-policy', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'set-storm-policy',
      id: BINDING_ID,
      maxRuns: 3,
      windowSeconds: 120,
      maxAgeSeconds: 3600,
    });
    expect(response.status).toBe(200);
    expect(setStorm).toHaveBeenCalledWith(sql, 'ws-test', BINDING_ID, {
      maxRuns: 3,
      windowSeconds: 120,
      maxAgeSeconds: 3600,
    });
  });

  it('forwards a window-only policy on attach-external without inventing rate fields', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'attach-external',
      sourceId: '20000000-0000-4000-8000-000000000001',
      planHarnessSlug: 'papercusp',
      planSlug: 'triage-mail',
      eventPattern: 'ext:gmail:message.received',
      maxAgeSeconds: 7200,
    });
    expect(response.status).toBe(200);
    const input = createBinding.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(input.stormPolicy).toEqual({ maxAgeSeconds: 7200 });
  });

  it('refuses a validity window past the 31-day ceiling at the HTTP boundary', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'set-storm-policy',
      id: BINDING_ID,
      maxRuns: 3,
      windowSeconds: 120,
      maxAgeSeconds: 32 * 24 * 60 * 60,
    });
    expect(response.status).toBe(400);
    expect(setStorm).not.toHaveBeenCalled();
  });

  it('serves the reusable Socket Mode manifest without exposing a secret', async () => {
    const response = await request(slackManifest, 'GET');
    expect(await response.json()).toEqual({ ok: true, manifest: { settings: { socket_mode_enabled: true } } });
  });

  it('stores Slack tokens through the connection seam and never echoes them', async () => {
    const response = await request(slackConnect, 'POST', {
      appToken: 'xapp-private', botToken: 'xoxb-private', installSlug: 'papercusp', channels: ['C1'],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      source: { kind: 'slack', status: 'connecting' },
      binding: { eventPattern: 'ext:slack:mention', armed: false },
      plan: { slug: 'slack-respond-in-thread-2026-08-22', created: true, armed: false },
    });
    expect(JSON.stringify(body)).not.toContain('xapp-private');
    expect(JSON.stringify(body)).not.toContain('xoxb-private');
    expect(connectSlack).toHaveBeenCalledWith(sql, expect.objectContaining({
      workspaceId: 'ws-test',
      ownerUserId: '22222222-2222-4222-8222-222222222222',
      appToken: 'xapp-private',
      botToken: 'xoxb-private',
    }));
    expect(ensureSlackFlagship).toHaveBeenCalledWith(
      sql,
      'ws-test',
      expect.objectContaining({ kind: 'slack' }),
      'owner:22222222-2222-4222-8222-222222222222',
    );
    expect(notify).toHaveBeenCalledWith('externalTriggers.admin', { workspaceId: 'ws-test' });
  });

  it('configures the owned bug source and installs the ordinary-message classifier disarmed', async () => {
    const ownerUserId = '22222222-2222-4222-8222-222222222222';
    const sourceId = '20000000-0000-4000-8000-000000000001';
    const asanaId = '20000000-0000-4000-8000-000000000003';
    const source = { id: sourceId, workspaceId: 'ws-test', kind: 'slack', ownerUserId,
      config: { botUserId: 'UBOT', installSlug: 'papercusp' }, cursor: {} };
    const destination = { sourceId: asanaId, projectGid: '123' };
    getSource.mockResolvedValueOnce(source).mockResolvedValueOnce({ kind: 'asana', ownerUserId, config: { projectGids: ['123'] } });
    const configured = { ...source, config: { ...source.config, channels: ['C1'], asanaBugDestination: destination } };
    sql.mockResolvedValueOnce([configured]);
    const response = await request(mutate, 'PATCH', { op: 'configure-slack-bugs', sourceId,
      channels: ['C1', 'C1'], asanaBugDestination: destination });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, source: configured,
      binding: { eventPattern: 'ext:slack:message', armed: false },
      plan: { slug: 'slack-classify-bug-2026-10-08', armed: false } });
    expect(sql).toHaveBeenCalledOnce();
    expect(sql.mock.calls[0][0].join('')).toContain('config = config ||');
    expect(sql.mock.calls[0][0].join('')).toContain('config IS NOT DISTINCT FROM');
    expect(JSON.parse(sql.mock.calls[0][1])).toEqual({ channels: ['C1'], asanaBugDestination: destination });
    expect(ensureBugClassifier).toHaveBeenCalledWith(sql, 'ws-test', configured, `owner:${ownerUserId}`);
    expect(setArmed).not.toHaveBeenCalled();
    expect(connectSlack).not.toHaveBeenCalled();
  });

  it('refuses cross-owner, wrong-provider and unselected-project bug destinations before configuration', async () => {
    const sourceId = '20000000-0000-4000-8000-000000000001';
    const source = { id: sourceId, kind: 'slack', ownerUserId: '22222222-2222-4222-8222-222222222222', config: {} };
    const body = { op: 'configure-slack-bugs', sourceId, channels: ['C1'],
      asanaBugDestination: { sourceId: '20000000-0000-4000-8000-000000000003', projectGid: '123' } };
    for (const destination of [
      { kind: 'asana', ownerUserId: 'another-owner', config: { projectGids: ['123'] } },
      { kind: 'linear', ownerUserId: source.ownerUserId, config: { projectGids: ['123'] } },
      { kind: 'asana', ownerUserId: source.ownerUserId, config: { projectGids: ['other'] } },
    ]) {
      getSource.mockResolvedValueOnce(source).mockResolvedValueOnce(destination);
      const response = await request(mutate, 'PATCH', body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'slack_bug_scope_invalid' });
    }
    getSource.mockResolvedValueOnce({ ...source, ownerUserId: 'another-owner' }).mockResolvedValueOnce({
      kind: 'asana', ownerUserId: source.ownerUserId, config: { projectGids: ['123'] } });
    expect((await request(mutate, 'PATCH', body)).status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
    expect(ensureBugClassifier).not.toHaveBeenCalled();
  });

  it('refuses a concurrently changed Slack source without installing or arming a classifier', async () => {
    const sourceId = '20000000-0000-4000-8000-000000000001';
    const ownerUserId = '22222222-2222-4222-8222-222222222222';
    getSource.mockResolvedValueOnce({ id: sourceId, kind: 'slack', ownerUserId, config: {} })
      .mockResolvedValueOnce({ kind: 'asana', ownerUserId, config: { projectGids: ['123'] } });
    sql.mockResolvedValueOnce([]);
    const response = await request(mutate, 'PATCH', { op: 'configure-slack-bugs', sourceId, channels: ['C1'],
      asanaBugDestination: { sourceId: '20000000-0000-4000-8000-000000000003', projectGid: '123' } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'slack_bug_source_changed' });
    expect(ensureBugClassifier).not.toHaveBeenCalled();
    expect(setArmed).not.toHaveBeenCalled();
  });

  // Placeholder token strings on purpose: the route never inspects the prefix
  // (the mocked connector does), and real-looking Slack prefixes trip the secrets guard.
  it('connects an organization Slack source as the session owner, with no flagship binding', async () => {
    expect(slackConnectOrg).toMatchObject({
      method: 'POST',
      path: '/admin/triggers/slack/connect-org',
      auth: { trust: ['verified', 'trusted'] },
    });
    const response = await request(slackConnectOrg, 'POST', {
      appToken: 'app-token-private', botToken: 'bot-token-private',
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, source: { kind: 'slack', config: { credentialModel: 'customer-internal-app' } } });
    expect(JSON.stringify(body)).not.toContain('app-token-private');
    expect(JSON.stringify(body)).not.toContain('bot-token-private');
    expect(connectOrgSlack).toHaveBeenCalledWith(sql, {
      workspaceId: 'ws-test',
      ownerUserId: '22222222-2222-4222-8222-222222222222',
      createdBy: 'owner:22222222-2222-4222-8222-222222222222',
      appToken: 'app-token-private',
      botToken: 'bot-token-private',
      installSlug: 'papercusp',
    });
    expect(ensureSlackFlagship).not.toHaveBeenCalled();
    expect(connectSlack).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('externalTriggers.admin', { workspaceId: 'ws-test' });
  });

  it('answers 409 disabled while the org connector flag is dark (legal read pending)', async () => {
    connectOrgSlack.mockRejectedValueOnce(new Error(SLACK_ORG_DISABLED));
    const response = await request(slackConnectOrg, 'POST', { appToken: 'app-token', botToken: 'bot-token' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'disabled', detail: SLACK_ORG_DISABLED });
    expect(notify).not.toHaveBeenCalled();
  });

  it('refuses a per-user channels list and cross-origin org connects before touching Slack', async () => {
    const extra = await request(slackConnectOrg, 'POST', { appToken: 'app-token', botToken: 'bot-token', channels: ['C1'] });
    expect(extra.status).toBe(400);
    const crossOrigin = await request(
      slackConnectOrg,
      'POST',
      { appToken: 'app-token', botToken: 'bot-token' },
      { origin: 'https://evil.example' },
    );
    expect(crossOrigin.status).toBe(403);
    expect(connectOrgSlack).not.toHaveBeenCalled();
  });
});
