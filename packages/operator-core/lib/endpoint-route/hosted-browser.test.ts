import { describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/agent-mcp';
import type { Sql } from 'postgres';
import { createHostedPrincipal, type HostedPrincipal } from '../auth/hosted-principal';
import type { VerifiedTenantServerContext } from '@papercusp/db-org';
import type { SyncEvent } from '../sync-sse';
import {
  HOSTED_BROWSER_ACTION_PATH,
  HOSTED_BROWSER_QUERY_NAME,
  HOSTED_BROWSER_REST_QUERY_PATH,
  HOSTED_BROWSER_SSE_PATH,
  createHostedBrowserRoutes,
} from './hosted-browser';

const ORIGIN = 'https://app.papercusp.com';
const CONTROL_PLANE_WORKSPACE = 'control-plane';
const SELECTED_WORKSPACE = 'tenant-a';
const NEVER_EMIT_MARKER = 'never-emit-me';

const principal = createHostedPrincipal({
  workspaceId: CONTROL_PLANE_WORKSPACE,
  userId: 'user-1',
  activeOrganizationId: 'org-1',
  selectedWorkspaceId: SELECTED_WORKSPACE,
  sessionId: 'session-1',
  sessionVersion: 1,
  permissions: ['workspace:view', 'workspace:operate', 'workspace:destroy', 'cloud-connection:manage'],
});

const fakeSql = (() => []) as unknown as Sql;

function context(current: HostedPrincipal = principal): RouteContext {
  return {
    principal: current,
    input: undefined,
    params: {},
    log: () => {},
    signal: new AbortController().signal,
  };
}

function routeHandler(routes: ReturnType<typeof createHostedBrowserRoutes>['routes'], path: string) {
  const route = routes.find((candidate) => candidate.path === path);
  if (!route) throw new Error(`missing route ${path}`);
  return route.handler;
}

function tenantRunner(calls: Array<{ selectedWorkspaceId?: string }>) {
  return async <T>(ctx: VerifiedTenantServerContext, fn: (sql: Sql) => Promise<T>): Promise<T> => {
    calls.push({ selectedWorkspaceId: ctx.selectedWorkspace?.id });
    return fn(fakeSql);
  };
}

describe('hosted browser route boundary', () => {
  it('reads the fixed control-plane source inside the selected tenant transaction', async () => {
    const tenantCalls: Array<{ selectedWorkspaceId?: string }> = [];
    const readControl = vi.fn(async (workspaceId: string, tx?: Sql) => {
      expect(workspaceId).toBe(CONTROL_PLANE_WORKSPACE);
      expect(tx).toBe(fakeSql);
      return [{ kind: 'workspace', id: SELECTED_WORKSPACE }];
    });
    const routes = createHostedBrowserRoutes({
      publicOrigin: ORIGIN,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: { runTenant: tenantRunner(tenantCalls), readControl },
    }).routes;
    const handler = routeHandler(routes, HOSTED_BROWSER_REST_QUERY_PATH);
    const request = new Request(
      `${ORIGIN}/api${HOSTED_BROWSER_REST_QUERY_PATH}?name=${encodeURIComponent(HOSTED_BROWSER_QUERY_NAME)}&args=%7B%7D`,
      { headers: { 'x-papercusp-workspace': CONTROL_PLANE_WORKSPACE } },
    );

    const response = await handler(request, context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rows: [{ kind: 'workspace', id: SELECTED_WORKSPACE }],
    });
    expect(readControl).toHaveBeenCalledTimes(1);
    expect(tenantCalls).toEqual([{ selectedWorkspaceId: SELECTED_WORKSPACE }]);
  });

  it('rejects a mismatched workspace header before touching tenant data', async () => {
    const readControl = vi.fn(async () => []);
    const routes = createHostedBrowserRoutes({
      publicOrigin: ORIGIN,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: { readControl },
    }).routes;
    const handler = routeHandler(routes, HOSTED_BROWSER_REST_QUERY_PATH);
    const response = await handler(
      new Request(`${ORIGIN}/api${HOSTED_BROWSER_REST_QUERY_PATH}?name=${HOSTED_BROWSER_QUERY_NAME}`, {
        headers: { 'x-papercusp-workspace': 'tenant-b' },
      }),
      context(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'workspace_binding_mismatch' });
    expect(readControl).not.toHaveBeenCalled();
  });

  it('rejects a hosted principal from a different control-plane instance', async () => {
    const readControl = vi.fn(async () => []);
    const routes = createHostedBrowserRoutes({
      publicOrigin: ORIGIN,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: { readControl },
    }).routes;
    const foreignPrincipal = createHostedPrincipal({
      ...principal,
      workspaceId: 'other-control-plane',
    });
    const response = await routeHandler(routes, HOSTED_BROWSER_REST_QUERY_PATH)(
      new Request(`${ORIGIN}/api${HOSTED_BROWSER_REST_QUERY_PATH}?name=${HOSTED_BROWSER_QUERY_NAME}`),
      context(foreignPrincipal),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'control_plane_binding_mismatch' });
    expect(readControl).not.toHaveBeenCalled();
  });

  it('requires the exact configured Origin for hosted cookie writes', async () => {
    const action = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const routes = createHostedBrowserRoutes({
      publicOrigin: ORIGIN,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: {
        provisioningAvailable: () => true,
        readTarget: async () => null,
        readConnection: async () => null,
        startLifecycle: action as never,
        startDestroy: action as never,
      },
    }).routes;
    const handler = routeHandler(routes, HOSTED_BROWSER_ACTION_PATH);

    const missingOrigin = await handler(
      new Request(`${ORIGIN}/api${HOSTED_BROWSER_ACTION_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'stop', workspaceId: 'host-1' }),
      }),
      context(),
    );
    const wrongOrigin = await handler(
      new Request(`${ORIGIN}/api${HOSTED_BROWSER_ACTION_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ action: 'stop', workspaceId: 'host-1' }),
      }),
      context(),
    );

    expect(missingOrigin.status).toBe(403);
    expect(wrongOrigin.status).toBe(403);
    expect(action).not.toHaveBeenCalled();
  });

  it('keeps workspace-host row keys on the fixed control plane while RLS scopes the selected tenant', async () => {
    const tenantCalls: Array<{ selectedWorkspaceId?: string }> = [];
    const readConnection = vi.fn(async (workspaceId: string, _connectionId: string, tx?: Sql) => {
      expect(workspaceId).toBe(CONTROL_PLANE_WORKSPACE);
      expect(tx).toBe(fakeSql);
      return {
        id: 'gcp:connection',
        label: 'Hosted GCP',
        target: 'gcp',
        status: 'connected' as const,
        connection: {
          target: 'gcp',
          cloudCredentialRef: { kind: 'cloud' as const, ref: 'adc://default' },
          provider: {
            projectId: 'project-a',
            serviceAccountEmail: 'runtime@developer.gserviceaccount.com',
          },
        },
      };
    });
    const upsertConnection = vi.fn(async (input: { workspaceId: string }, tx?: Sql) => {
      expect(tx).toBe(fakeSql);
      expect(input.workspaceId).toBe(CONTROL_PLANE_WORKSPACE);
    });
    const routes = createHostedBrowserRoutes({
      publicOrigin: ORIGIN,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: {
        runTenant: tenantRunner(tenantCalls),
        readConnection,
        upsertConnection,
        inspectConnection: async () => ({
          validation: {
            ok: true,
            checkedAt: '2026-08-30T00:00:00.000Z',
            identity: 'runtime@developer.gserviceaccount.com',
            warnings: [],
            errors: [],
          },
          scopes: [],
          regions: [],
          sizes: [],
          images: [],
        }),
      },
    }).routes;
    const handler = routeHandler(routes, '/hosted/browser/workspace-hosts/connection');
    const response = await handler(
      new Request(`${ORIGIN}/api/hosted/browser/workspace-hosts/connection`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ action: 'validate-connection', connectionId: 'gcp:connection' }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(readConnection).toHaveBeenCalledTimes(1);
    expect(upsertConnection).toHaveBeenCalledTimes(1);
    expect(tenantCalls).toEqual([
      { selectedWorkspaceId: SELECTED_WORKSPACE },
      { selectedWorkspaceId: SELECTED_WORKSPACE },
    ]);
  });

  it('forwards only tenant-safe invalidations over SSE and strips row payloads', async () => {
    let emit: ((event: SyncEvent) => void) | undefined;
    const close = vi.fn();
    const relevant: SyncEvent = {
      id: 1,
      ts: 123,
      name: HOSTED_BROWSER_QUERY_NAME,
      args: { workspaceId: SELECTED_WORKSPACE },
      data: [{ secret: NEVER_EMIT_MARKER }],
    };
    const foreign: SyncEvent = {
      id: 2,
      ts: 124,
      name: HOSTED_BROWSER_QUERY_NAME,
      args: { workspaceId: 'tenant-b' },
      data: [{ secret: 'foreign' }],
    };
    const subscribe = vi.fn(async (listener: (event: SyncEvent) => void) => {
      emit = listener;
      return { send: listener, close };
    });
    const routes = createHostedBrowserRoutes({
      publicOrigin: ORIGIN,
      controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE,
      dependencies: {
        subscribe,
        backfillSince: () => [relevant, foreign],
      },
    }).routes;
    const handler = routeHandler(routes, HOSTED_BROWSER_SSE_PATH);
    const abort = new AbortController();
    const response = await handler(
      new Request(`${ORIGIN}/api${HOSTED_BROWSER_SSE_PATH}`, {
        headers: { 'x-papercusp-workspace': CONTROL_PLANE_WORKSPACE, 'last-event-id': '0' },
        signal: abort.signal,
      }),
      context(),
    );

    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    const replay = await reader.read();
    const replayText = decoder.decode(replay.value);
    expect(decoder.decode(first.value)).toContain('event: heartbeat');
    expect(replayText).toContain('event: invalidate');
    expect(replayText).toContain('"name":"workspaceHosts.control"');
    expect(replayText).toContain('"tsMs":123');
    expect(replayText).not.toContain(NEVER_EMIT_MARKER);
    expect(replayText).not.toContain('foreign');

    // The live callback is scoped the same way as replay.
    emit?.(relevant);
    const live = await reader.read();
    expect(decoder.decode(live.value)).toContain('"tsMs":123');
    abort.abort();
    await reader.cancel();
    expect(close).toHaveBeenCalled();
  });
});
