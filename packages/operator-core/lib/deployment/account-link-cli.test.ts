/**
 * account-link-cli — the CLI-driven OAuth link (accounts-pool-tab-2026-06-15 P-002/D-016).
 * Drives FAKE provider ptys: Claude captures a URL/code exchange; Codex captures a device
 * URL/code and registers the isolated auth.json. Tokens never return to the caller.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    dataCbs: [] as ((d: string) => void)[],
    written: [] as string[],
    killed: 0,
    outcome: 'token' as 'token' | 'reject',
    mode: 'claude' as 'claude' | 'codex',
  };
  const makePty = () => ({
    onData: (cb: (d: string) => void) => {
      state.dataCbs.push(cb);
      return { dispose: () => { state.dataCbs = state.dataCbs.filter((c) => c !== cb); } };
    },
    onExit: (_cb: (e: { exitCode: number; signal?: number }) => void) => ({ dispose: () => {} }),
    write: (d: string) => {
      state.written.push(d);
      // Model the real `claude setup-token` Ink TUI: the pasted code alone does NOTHING;
      // a SEPARATE Enter (\r) submits it. A regression to a single `code\r` write (which
      // the TUI swallows) therefore never resolves — exactly the production stall this fixes.
      const hasPastedCode = state.written.some((w) => w !== '\r' && w.trim());
      if (d === '\r' && hasPastedCode) {
        const out =
          state.outcome === 'reject'
            ? '\r\n\x1b[31mOAuth error: Request failed with status code 400\x1b[0m Press Enter to retry.\r\n'
            : '\r\n\x1b[32mSuccess!\x1b[0m token:\r\nsk-ant-oat01-TESTtoken_AbC-123\r\n';
        setTimeout(() => state.dataCbs.forEach((cb) => cb(out)), 0);
      }
    },
    kill: () => { state.killed += 1; },
  });
  const spawn = vi.fn(() => {
    const p = makePty();
    // The CLI prints the authorize URL on launch.
    setTimeout(() => state.dataCbs.forEach((cb) => cb(
      state.mode === 'codex'
        ? 'Open this link:\r\nhttps://auth.openai.com/codex/device\r\nEnter this one-time code\r\nABCD-12345\r\n'
        : 'Open this URL:\r\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=X&scope=user:inference&state=s\r\nPaste code: ',
    )), 0);
    return p;
  });
  return {
    state,
    spawn,
    writeFile: vi.fn(async () => {}),
    cp: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    chmod: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    readFile: vi.fn(async (path: string) => {
      if (path.endsWith('/auth.json')) {
        return JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            access_token: 'codex-access-token',
            refresh_token: 'codex-refresh-token',
          },
        });
      }
      throw new Error(`unexpected readFile ${path}`);
    }),
    updateAccountPool: vi.fn(async (mut: (p: { accounts: unknown[] }) => unknown) => mut({ accounts: [] })),
    accountStatus: vi.fn(async () => [
      { id: 'acme', label: 'Acme', credentialRef: 'token:/tmp/test/deploy-credentials/acme', boundTo: [], available: true, sustainedlyLimited: false, rate: {}, liveBuckets: [] },
    ]),
    registerAccount: vi.fn((p: { accounts: unknown[] }, input: Record<string, unknown>) => ({ accounts: [...p.accounts, input] })),
  };
});

vi.mock('@lydell/node-pty', () => ({ spawn: h.spawn }));
vi.mock('node:fs/promises', () => ({ readFile: h.readFile, writeFile: h.writeFile, cp: h.cp, mkdir: h.mkdir, chmod: h.chmod, rm: h.rm }));
vi.mock('../papercusp-root', () => ({ papercuspPath: (...p: string[]) => '/tmp/test/' + p.join('/') }));
vi.mock('./account-pool', () => ({
  registerAccount: h.registerAccount,
  normalizeAccountProvider: (provider: unknown) => (provider === 'codex' ? 'codex' : 'claude'),
}));
vi.mock('./account-pool-store', () => ({ updateAccountPool: h.updateAccountPool, accountStatus: h.accountStatus }));

import { startCliLink, completeCliLink, __resetCliLinksForTest } from './account-link-cli';

afterEach(() => {
  __resetCliLinksForTest();
  h.state.dataCbs = [];
  h.state.written = [];
  h.state.outcome = 'token';
  h.state.mode = 'claude';
  vi.clearAllMocks();
});

describe('account-link-cli — CLI-driven OAuth link', () => {
  it('startCliLink spawns `claude setup-token` (isolated config) + returns the URL it prints', async () => {
    const r = await startCliLink({ accountId: 'acme', label: 'Acme' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(h.spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['setup-token'],
      expect.objectContaining({ env: expect.objectContaining({ CLAUDE_CONFIG_DIR: expect.stringContaining('/tmp/test/deploy-credentials/.setup-acme-') }) }),
    );
    expect(r.authorizeUrl).toContain('https://claude.com/cai/oauth/authorize');
    expect(r.linkId).toBeTruthy();
  });

  it('startCliLink spawns `codex login --device-auth` and returns the device URL + code', async () => {
    h.state.mode = 'codex';
    const r = await startCliLink({ accountId: 'codex-acme', label: 'Codex Acme', provider: 'codex' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(h.spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['login', '--device-auth'],
      expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: expect.stringContaining('/tmp/test/deploy-credentials/.codex-setup-codex-acme-') }) }),
    );
    expect(r.authorizeUrl).toBe('https://auth.openai.com/codex/device');
    expect(r.userCode).toBe('ABCD-12345');
  });

  it('completeCliLink feeds the code, captures the token, registers it, and NEVER returns the token', async () => {
    const s = await startCliLink({ accountId: 'acme', label: 'Acme' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const r = await completeCliLink({ linkId: s.linkId, code: 'THECODE#STATE' }, { notify: () => {}, enterDelayMs: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // the code is pasted, then Enter is sent as a SEPARATE write — the Ink TUI swallows a
    // CR appended to the paste (the production "Linking…" stall). Regression guard.
    expect(h.state.written).toContain('THECODE#STATE');
    expect(h.state.written).toContain('\r');
    expect(h.state.written.some((w) => w.includes('THECODE#STATE') && w.includes('\r'))).toBe(false);
    // the token was written to a 0600 file under the account id + registered as token:<path>
    expect(h.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('deploy-credentials/acme'),
      expect.stringContaining('sk-ant-oat01-TESTtoken'),
      expect.objectContaining({ mode: 0o600 }),
    );
    const regInput = h.registerAccount.mock.calls[0]?.[1] as { id: string; credentialRef: string };
    expect(regInput.id).toBe('acme');
    expect(regInput.credentialRef).toMatch(/^token:/);
    // SECURITY invariant: the token must never appear in the API result.
    expect(JSON.stringify(r)).not.toContain('sk-ant-oat01-TESTtoken');
  });

  it('completeCliLink persists a Codex CLI home and registers it as codex-cli:<home>', async () => {
    h.state.mode = 'codex';
    const s = await startCliLink({ accountId: 'codex-acme', label: 'Codex Acme', provider: 'codex' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const r = await completeCliLink({ linkId: s.linkId }, { notify: () => {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(h.writeFile).toHaveBeenCalledWith(
      '/tmp/test/deploy-credentials/codex-acme.codex-cli/auth.json',
      expect.stringContaining('codex-access-token'),
      expect.objectContaining({ mode: 0o600 }),
    );
    const regInput = h.registerAccount.mock.calls[0]?.[1] as { id: string; credentialRef: string; provider: string };
    expect(regInput.id).toBe('codex-acme');
    expect(regInput.provider).toBe('codex');
    expect(regInput.credentialRef).toBe('codex-cli:/tmp/test/deploy-credentials/codex-acme.codex-cli');
    expect(JSON.stringify(r)).not.toContain('codex-access-token');
  });

  it('completeCliLink fails fast (no write/register) when claude rejects the code', async () => {
    const s = await startCliLink({ accountId: 'acme', label: 'Acme' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    h.state.outcome = 'reject';
    const r = await completeCliLink({ linkId: s.linkId, code: 'BADCODE#STATE' }, { enterDelayMs: 5 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/rejected the code/i);
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.registerAccount).not.toHaveBeenCalled();
  });

  it('completeCliLink rejects an unknown/expired linkId (no write, no register)', async () => {
    const r = await completeCliLink({ linkId: 'nope', code: 'x' });
    expect(r.ok).toBe(false);
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.registerAccount).not.toHaveBeenCalled();
  });

  it('startCliLink rejects a bad account id without spawning', async () => {
    const r = await startCliLink({ accountId: 'bad id!' });
    expect(r.ok).toBe(false);
    expect(h.spawn).not.toHaveBeenCalled();
  });
});
