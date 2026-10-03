import { describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/agent-mcp';
import { createHostedPrincipal } from '../auth/hosted-principal';
import { createHostedTutorialAssistanceRoutes, HOSTED_BROWSER_TUTORIAL_HELP_PATH, HOSTED_BROWSER_TUTORIAL_SPEECH_PATH } from '../endpoint-route/routes/hosted-tutorial-progress';
import { createTutorialState, confirmedTutorialSteps } from './cloud-tutorial-lesson';
import type { TutorialHelpRequest } from './cloud-tutorial-help';
const origin = 'https://app.papercusp.com';
const scope = { tenantId: 'tenant-a', userId: 'user-a', workspaceId: 'customer-a' };
const input = { expectedScope: scope, context: { step: 'connection', status: 'ready' }, question: 'Where do I connect my project?' };
const principal = (patch: Partial<Parameters<typeof createHostedPrincipal>[0]> = {}) => createHostedPrincipal({
  workspaceId: 'control', userId: scope.userId, activeOrganizationId: scope.tenantId, selectedWorkspaceId: scope.workspaceId,
  sessionId: 'session', sessionVersion: 1, permissions: ['workspace:view'], ...patch,
});
function setup() {
  const answer = vi.fn(async (_input: TutorialHelpRequest, _signal: AbortSignal, _workspaceId: string) => 'Use the app connection form. The app validates your project.');
  const speech = vi.fn(async (_text: string, _engine: string, _voice: string | undefined) => ({ audio: new ArrayBuffer(16), contentType: 'audio/wav' }));
  const routes = createHostedTutorialAssistanceRoutes({ origin, controlPlaneWorkspaceId: 'control', dependencies: { answer, speech } });
  const call = (body: unknown = input, options: { path?: string; origin?: string; principal?: ReturnType<typeof principal> | null; signal?: AbortSignal } = {}) => {
    const route = routes.find(row => row.path === (options.path ?? HOSTED_BROWSER_TUTORIAL_HELP_PATH))!;
    const request = new Request(`${origin}/api${route.path}`, { method: 'POST', headers: { origin: options.origin ?? origin, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: options.signal });
    const context: RouteContext = { principal: options.principal === null ? null : options.principal ?? principal(), params: {}, input: undefined, signal: request.signal, log: () => {} };
    return route.handler(request, context);
  };
  return { call, answer, speech };
}
describe('hosted lesson assistance boundary', () => {
  it('accepts v2 public recovery and blocks private category/diagnostic input before both providers', async () => {
    const { call, answer, speech } = setup();
    const context = { step: 'practice', status: 'error', version: 2, recoveryCategory: 'unknown' };
    expect((await call({ ...input, context })).status).toBe(200);
    expect(answer.mock.calls[0][0].context).toEqual(context);
    answer.mockClear();
    for (const extra of [{ recoveryCategory: 'private-provider-id' }, { rawError: 'private token' }, { transcript: 'private chat' }]) {
      expect((await call({ ...input, context: { ...context, ...extra } })).status).toBe(400);
      expect((await call({ ...input, context: { ...context, ...extra }, engine: 'openai' }, { path: HOSTED_BROWSER_TUTORIAL_SPEECH_PATH })).status).toBe(400);
    }
    expect(answer).not.toHaveBeenCalled(); expect(speech).not.toHaveBeenCalled();
  });
  it('passes only authorized minimal context to existing brain and leaves domain state untouched', async () => {
    const { call, answer } = setup(); const state = createTutorialState(scope);
    const response = await call();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(answer.mock.calls[0][0]).toEqual(input);
    expect(await response.json()).toEqual({ answer: 'Use the app connection form. The app validates your project.' });
    expect(confirmedTutorialSteps(state)).toEqual([]);
  });
  it.each([{ principal: null }, { principal: principal({ selectedWorkspaceId: 'foreign' }) }, { principal: principal({ userId: 'foreign' }) }, { principal: principal({ activeOrganizationId: 'foreign' }) }, { principal: principal({ permissions: [] }) }, { origin: 'https://evil.invalid' }])('refuses forbidden boundary %j before providers', async options => {
    const { call, answer, speech } = setup();
    expect((await call(input, options)).status).toBeGreaterThanOrEqual(400);
    expect(answer).not.toHaveBeenCalled(); expect(speech).not.toHaveBeenCalled();
  });
  it('refuses credentials and expanded state before provider invocation', async () => {
    const { call, answer } = setup();
    expect((await call({ ...input, question: 'api_key=sk-verysecret123456' })).status).toBe(403);
    expect((await call({ ...input, context: { ...input.context, transcript: 'another tenant' } })).status).toBe(400);
    expect(answer).not.toHaveBeenCalled();
  });
  it('returns a recoverable outage and suppresses cancelled model results', async () => {
    const { call, answer } = setup(); answer.mockRejectedValueOnce(new Error('provider private error'));
    expect(await (await call()).json()).toMatchObject({ error: 'tutorial_help_unavailable' });
    const controller = new AbortController(); controller.abort();
    expect((await call(input, { signal: controller.signal })).status).toBe(408);
  });
  it('uses the shared synthesis adapter with the selected engine and voice', async () => {
    const { call, speech, answer } = setup();
    const response = await call({ ...input, engine: 'openai', voiceId: 'nova' }, { path: HOSTED_BROWSER_TUTORIAL_SPEECH_PATH });
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(speech).toHaveBeenCalledWith(input.question, 'openai', 'nova'); expect(answer).not.toHaveBeenCalled();
  });
});
