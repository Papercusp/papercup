import { describe, expect, it } from 'vitest';
import { reviewerContext, runPairingControls, seedReviewer, captureNative,
  nativeCapturePreflight, validatePairedSummary,
  verifyReviewerReadback } from '../../../scripts/reviewer-operator-assert.mjs';

const env = { PAPERCUSP_VERIFY_TAURI_ISOLATED: '1', PAPERCUSP_WORKSPACE_ID: 'verify-tauri-isolated-123',
  PAPERCUSP_WORKSPACE: 'verify-tauri-isolated-123', VERIFY_TAURI_PORT: '33710',
  MOBILE_DESKTOP_PUBLIC_URL: 'https://sanitized.trycloudflare.com' };
const payload = { qrPayload: { workspaceId: env.PAPERCUSP_WORKSPACE_ID,
  server: env.MOBILE_DESKTOP_PUBLIC_URL, pairToken: 'SECRET-MUST-NOT-BE-LOGGED' }, expiresAt: '2099-01-01T00:00:00Z' };

function fixture(statuses = [200, 200, 200, 200, 401, 403, 403], minted = payload) {
  const calls: { url: string; options: RequestInit }[] = [];
  const logs: string[] = [];
  const fetchImpl = async (url: string, options: RequestInit) => {
    const status = statuses[calls.length];
    calls.push({ url, options });
    return new Response(JSON.stringify(url.includes('mint-pair-token') ? minted : {}), { status });
  };
  return { calls, logs, run: () => runPairingControls({ env, fetchImpl, log: (s: string) => logs.push(s) }) };
}

describe('isolated reviewer pairing controls', () => {
  it('uses the same real workspace payload locally before testing remote refusal, without logging secrets', async () => {
    const f = fixture();
    expect(await f.run()).toEqual(payload);
    expect(JSON.parse(f.calls[1].options.body as string)).toEqual({ workspaceId: env.PAPERCUSP_WORKSPACE_ID });
    expect(f.calls[5].options.body).toEqual(f.calls[1].options.body);
    expect(f.calls[1].url).toContain('127.0.0.1:33710');
    expect(f.calls[5].url).toContain('sanitized.trycloudflare.com');
    expect(f.logs.join('\n')).not.toContain(payload.qrPayload.pairToken);
    expect(f.calls.every(c => c.options.redirect === 'error')).toBe(true);
  });
  it.each([400, 404, 500])('rejects invalid local mint status %s before any external probe', async status => {
    const f = fixture([200, status]);
    await expect(f.run()).rejects.toThrow('local mint preflight');
    expect(f.calls).toHaveLength(2);
  });
  it.each([400, 404, 500, 200])('rejects tunnel mint status %s as security evidence', async status => {
    await expect(fixture([200, 200, 200, 200, 401, status]).run()).rejects.toThrow('tunnel mint refusal');
  });
  it('requires the local admin route to exist before testing its remote refusal', async () => {
    const f = fixture([200, 200, 404]);
    await expect(f.run()).rejects.toThrow('local admin preflight');
    expect(f.calls).toHaveLength(3);
  });
  it.each([
    { ...payload, qrPayload: { ...payload.qrPayload, workspaceId: 'papercusp-workspace' } },
    { ...payload, qrPayload: { ...payload.qrPayload, server: 'https://another.example' } },
    { ...payload, expiresAt: '2000-01-01T00:00:00Z' },
    { ...payload, qrPayload: { ...payload.qrPayload, pairToken: '' } },
  ])('rejects malformed or non-isolated local mint responses', async minted => {
    const f = fixture(undefined, minted);
    await expect(f.run()).rejects.toThrow('invalid isolated pairing payload');
    expect(f.calls).toHaveLength(2);
  });
  it.each([
    { ...env, PAPERCUSP_VERIFY_TAURI_ISOLATED: '0' },
    { ...env, PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace' },
    { ...env, PAPERCUSP_WORKSPACE: 'papercusp-workspace' },
    { ...env, VERIFY_TAURI_PORT: 'invalid' },
    { ...env, MOBILE_DESKTOP_PUBLIC_URL: 'http://example.com' },
    { ...env, MOBILE_DESKTOP_PUBLIC_URL: 'https://secret@example.com' },
  ])('refuses unsafe context before making a request', badEnv => {
    expect(() => reviewerContext(badEnv)).toThrow();
  });
  it('does not echo token-bearing transport errors', async () => {
    await expect(runPairingControls({ env, fetchImpl: async () => {
      throw new Error(payload.qrPayload.pairToken);
    } })).rejects.toThrow('local health: transport failed');
  });
  it('seeds plans, inbox, fleet and the shared chat using existing tools and synthetic content', async () => {
    const calls: { name: string; args: unknown }[] = [];
    await seedReviewer({ env, invoke: async (name: string, args: unknown) => { calls.push({ name, args }); } });
    expect(calls.map(c => c.name)).toEqual(['plans:new', 'work_items:create', 'fleet:create',
      'conversation:append', 'conversation:append']);
    expect(JSON.stringify(calls)).not.toContain(payload.qrPayload.pairToken);
    expect(JSON.stringify(calls)).not.toContain('papercusp-workspace');
    expect(calls[0].args).toMatchObject({ status: 'draft', workspaceId: env.PAPERCUSP_WORKSPACE_ID });
  });
  it('refuses seeding an ambient live workspace before invoking any tool', async () => {
    let called = false;
    await expect(seedReviewer({ env: { ...env, PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace' },
      invoke: async () => { called = true; } })).rejects.toThrow('disposable workspace');
    expect(called).toBe(false);
  });
  const readbackBodies: Record<string, unknown>[] = [
    { ...payload, qrPayload: { ...payload.qrPayload, pairToken: 'READBACK-PAIR-SECRET' } },
    { workspaceId: env.PAPERCUSP_WORKSPACE_ID, deviceToken: 'READBACK-DEVICE-SECRET' },
    { plans: [{ slug: 'reviewer-demo', title: 'Plan a small product update' }] },
    { workItems: [{ kind: 'change', state: 'open', title: 'Review the next product update' }] },
    { turns: [{ role: 'user', text: 'What is ready for my review?' }, { role: 'assistant',
      text: 'The product update draft is ready. You can review the plan and the work item in your Inbox.' }] },
  ];
  function readbackFixture(bodies = readbackBodies, failedAt = -1) {
    const calls: { url: string; options: RequestInit }[] = [];
    const logs: string[] = [];
    return { calls, logs, run: () => verifyReviewerReadback({ env,
      log: (s: string) => logs.push(s), fetchImpl: async (url: string, options: RequestInit) => {
        const index = calls.length;
        calls.push({ url, options });
        return new Response(JSON.stringify(bodies[index]), { status: index === failedAt ? 503 : 200 });
      } }) };
  }
  it('checks actual paired feeds with a separate token and keeps credentials out of logs', async () => {
    const f = readbackFixture();
    await f.run();
    expect(JSON.parse(f.calls[1].options.body as string)).toEqual({ pairToken: 'READBACK-PAIR-SECRET' });
    expect(f.calls.slice(2).every(c =>
      (c.options.headers as Record<string, string>).authorization === 'Bearer READBACK-DEVICE-SECRET')).toBe(true);
    expect(f.calls.slice(1).every(c => c.url.startsWith(env.MOBILE_DESKTOP_PUBLIC_URL))).toBe(true);
    expect(f.logs.join('\n')).not.toMatch(/SECRET/);
    expect(JSON.stringify(f.calls)).not.toContain(payload.qrPayload.pairToken);
  });
  it('refuses a paired device from another workspace before reading any feed', async () => {
    const bodies = [...readbackBodies];
    bodies[1] = { ...bodies[1], workspaceId: 'papercusp-workspace' };
    const f = readbackFixture(bodies);
    await expect(f.run()).rejects.toThrow('invalid isolated device');
    expect(f.calls).toHaveLength(2);
  });
  it.each([2, 3, 4])('refuses success without seeded content at feed %s', async index => {
    const bodies = [...readbackBodies];
    bodies[index] = {};
    await expect(readbackFixture(bodies).run()).rejects.toThrow('absent');
  });
  it('refuses an unavailable Inbox instead of accepting it as an empty success', async () => {
    await expect(readbackFixture(undefined, 3).run()).rejects.toThrow('seeded Inbox readback: unexpected HTTP status');
  });
  it('does not echo device credentials from readback transport failures', async () => {
    await expect(verifyReviewerReadback({ env, fetchImpl: async () => {
      throw new Error('READBACK-DEVICE-SECRET');
    } })).rejects.toThrow('readback mint: transport failed');
  });
  it.each([{ passedTests: 0, failedTests: 0, skippedTests: 1 },
    { passedTests: 1, failedTests: 1, skippedTests: 0 }, {}])('rejects incomplete native evidence', summary => {
    expect(() => validatePairedSummary(summary)).toThrow();
  });
  it('accepts the exact paired UI result required by the existing iOS workflow', () => {
    expect(() => validatePairedSummary({ passedTests: 1, failedTests: 0, skippedTests: 0 })).not.toThrow();
  });
  it('refuses an existing shared pairing secret without changing it', () => {
    let calls = 0;
    expect(() => nativeCapturePreflight({ REVIEWER_MOBILE_REF: 'staging', REVIEWER_MOBILE_SHA: 'a'.repeat(40) },
      () => { calls++; return '[{"name":"PAPERCUP_PAIR_PAYLOAD"}]'; })).toThrow('refusing to overwrite');
    expect(calls).toBe(1);
  });
  it('refuses a candidate ref that moved before installing a secret', () => {
    expect(() => nativeCapturePreflight({ REVIEWER_MOBILE_REF: 'staging', REVIEWER_MOBILE_SHA: 'a'.repeat(40) },
      (args: string[]) => args[0] === 'secret' ? '[]' : 'b'.repeat(40))).toThrow('exact candidate');
  });
  it('removes its own secret when dispatch fails and supplies the token only on stdin', async () => {
    const calls: { args: string[]; input?: string }[] = [];
    const run = (args: string[], input?: string) => {
      calls.push({ args, input });
      if (args[0] === 'workflow') throw new Error('dispatch refused');
      return args[0] === 'api' ? 'a'.repeat(40) : '[]';
    };
    await expect(captureNative({ env: { ...env, REVIEWER_MOBILE_REF: 'staging',
      REVIEWER_MOBILE_SHA: 'a'.repeat(40), REVIEWER_OUTPUT_DIR: '/unused' }, payload, run })).rejects.toThrow('dispatch refused');
    expect(calls.at(-1)?.args.slice(0, 3)).toEqual(['secret', 'delete', 'PAPERCUP_PAIR_PAYLOAD']);
    expect(calls.find(c => c.args[1] === 'set')?.input).toBe(JSON.stringify(payload.qrPayload));
    expect(JSON.stringify(calls.map(c => c.args))).not.toContain(payload.qrPayload.pairToken);
  });
});
