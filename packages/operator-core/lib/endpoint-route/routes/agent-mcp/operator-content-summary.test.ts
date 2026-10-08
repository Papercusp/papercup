import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ user: 'user-one', workspace: 'ws-one', prompts: [] as { promptText: string }[], fail: false, synth: vi.fn(), prefs: vi.fn() }));
vi.mock('../../../auth', () => ({ getSessionUserOrDefault: async () => h.user ? { id: h.user } : null }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => h.workspace }));
vi.mock('../../../agent-chat-stream', () => ({ runAgentChat: async function* (request: { promptText: string }) {
  h.prompts.push(request);
  if (h.fail) { yield { type: 'error', message: 'Model unavailable.' }; return; }
  yield { type: 'result', finalText: 'Requested explicit summary.', costUsd: 0, tokensIn: 10, tokensOut: 10, stopReason: 'end_turn' };
} }));
vi.mock('../../../inference-gateway/local-backend-store', () => ({ listLocalBackends: async () => [{ enabled: true, models: ['fixture-local'] }] }));
vi.mock('../../../operator-budget', () => ({ checkBudget: async () => ({ exceeded: false }), recordSpend: async () => {} }));
vi.mock('../../../cache/instance', () => ({ getOperatorCache: () => ({ getOrSet: async (_workspace: string, _key: string, factory: () => Promise<unknown>) => factory() }) }));
vi.mock('../../../voice-prefs', () => ({ loadVoicePrefs: h.prefs }));
vi.mock('../../../voice-node/kokoro-local', () => ({ kokoroTtsAvailable: async () => false }));
vi.mock('./tts-synth', () => ({ synthesize: h.synth, synthesizeReading: h.synth }));
import tool from './operator-tts';
type Route = { handler(req: Request): Promise<Response> };
async function post(body: unknown, signal?: AbortSignal) {
  return (tool as unknown as Route).handler(new Request('http://localhost/api/agent-mcp/operator-tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }));
}
beforeEach(() => { h.user = 'user-one'; h.workspace = 'ws-one'; h.fail = false; h.prompts.length = 0; vi.clearAllMocks(); });
describe('existing output endpoint explicit summary operation', () => {
  it('processes the full supplied selection, forwards options and never synthesizes speech', async () => {
    const text = 'Authorized selection. '.repeat(1800) + 'EXACT FINAL TAIL';
    const result = await post({ operation: 'summarize', content: { kind: 'selection', text, partial: true, ref: 'provided:selection' }, summary: { allowCloud: true, length: 'short', focus: 'numbers', language: 'French' } });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ok: true, summary: 'Requested explicit summary.', sourceRefs: ['provided:selection'], coverage: { complete: false, characters: text.length, warnings: ['source-partial'] } });
    const leaves = h.prompts.map(p => JSON.parse(p.promptText)).filter(p => p.phase.startsWith('source chunk'));
    expect(leaves.map(p => p.quotedSource).join('')).toBe(text);
    expect(leaves[0]).toMatchObject({ length: 'short', focus: 'numbers', language: 'French' });
    expect(h.synth).not.toHaveBeenCalled(); expect(h.prefs).not.toHaveBeenCalled();
  });
  it('refuses unconsented cloud disclosure and never routes a local selection through the cloud runner', async () => {
    const body = { operation: 'summarize', content: { kind: 'text', text: 'Source.' } };
    const denied = await post(body);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ ok: false, code: 'cloud-consent-required' });
    expect(h.prompts).toHaveLength(0);
    const local = await post({ ...body, summary: { model: 'fixture-local' } });
    expect(local.status).toBe(503);
    expect(await local.json()).toMatchObject({ ok: false, code: 'local-route-unavailable' });
    expect(h.prompts).toHaveLength(0);
  });
  it('rejects reference-only input and malformed options before any model call', async () => {
    expect((await post({ operation: 'summarize', content: { kind: 'reference', ref: 'private:elsewhere' } })).status).toBe(400);
    expect((await post({ operation: 'summarize', content: { kind: 'text', text: 'source' }, summary: { maxCalls: 0 } })).status).toBe(400);
    expect(h.prompts).toHaveLength(0);
  });
  it('requires a current user and concrete workspace, including for repeated requests', async () => {
    const body = { operation: 'summarize', content: { kind: 'text', text: 'private source' }, summary: { allowCloud: true } };
    h.user = ''; expect((await post(body)).status).toBe(401);
    h.user = 'user-one'; h.workspace = '*'; expect((await post(body)).status).toBe(401);
    expect(h.prompts).toHaveLength(0);
  });
  it('keeps cancellation and model errors honest and silent', async () => {
    const body = { operation: 'summarize', content: { kind: 'text', text: 'source' }, summary: { allowCloud: true } };
    const ac = new AbortController(); ac.abort();
    expect((await post(body, ac.signal)).status).toBe(499);
    expect(h.prompts).toHaveLength(0);
    h.fail = true; const failed = await post(body);
    expect(failed.status).toBe(502); expect(await failed.json()).toMatchObject({ ok: false, code: 'model-failed' });
    expect(h.synth).not.toHaveBeenCalled();
  });
});
