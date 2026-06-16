/**
 * account-link-cli — the CLI-driven OAuth link (accounts-pool-tab-2026-06-15 P-002/D-016).
 * Drives a FAKE `claude setup-token` pty: start captures the URL the CLI prints; complete
 * feeds the code, captures the minted token, writes + registers it, and NEVER returns the token.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = { dataCbs: [] as ((d: string) => void)[], written: [] as string[], killed: 0 };
  const makePty = () => ({
    onData: (cb: (d: string) => void) => {
      state.dataCbs.push(cb);
      return { dispose: () => { state.dataCbs = state.dataCbs.filter((c) => c !== cb); } };
    },
    onExit: (_cb: (e: { exitCode: number; signal?: number }) => void) => ({ dispose: () => {} }),
    write: (d: string) => {
      state.written.push(d);
      // The CLI mints + prints the token once we paste the code.
      if (d.trim()) setTimeout(() => state.dataCbs.forEach((cb) => cb('\r\n\x1b[32mSuccess!\x1b[0m token:\r\nsk-ant-oat01-TESTtoken_AbC-123\r\n')), 0);
    },
    kill: () => { state.killed += 1; },
  });
  const spawn = vi.fn(() => {
    const p = makePty();
    // The CLI prints the authorize URL on launch.
    setTimeout(() => state.dataCbs.forEach((cb) => cb('Open this URL:\r\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=X&scope=user:inference&state=s\r\nPaste code: ')), 0);
    return p;
  });
  return {
    state,
    spawn,
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    chmod: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    updateAccountPool: vi.fn(async (mut: (p: { accounts: unknown[] }) => unknown) => mut({ accounts: [] })),
    accountStatus: vi.fn(async () => [
      { id: 'acme', label: 'Acme', credentialRef: 'token:/tmp/test/deploy-credentials/acme', boundTo: [], available: true, sustainedlyLimited: false, rate: {}, liveBuckets: [] },
    ]),
    registerAccount: vi.fn((p: { accounts: unknown[] }, input: Record<string, unknown>) => ({ accounts: [...p.accounts, input] })),
  };
});

vi.mock('@lydell/node-pty', () => ({ spawn: h.spawn }));
vi.mock('node:fs/promises', () => ({ writeFile: h.writeFile, mkdir: h.mkdir, chmod: h.chmod, rm: h.rm }));
vi.mock('../papercusp-root', () => ({ papercuspPath: (...p: string[]) => '/tmp/test/' + p.join('/') }));
vi.mock('./account-pool', () => ({ registerAccount: h.registerAccount }));
vi.mock('./account-pool-store', () => ({ updateAccountPool: h.updateAccountPool, accountStatus: h.accountStatus }));

import { startCliLink, completeCliLink, __resetCliLinksForTest } from './account-link-cli';

afterEach(() => {
  __resetCliLinksForTest();
  h.state.dataCbs = [];
  h.state.written = [];
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

  it('completeCliLink feeds the code, captures the token, registers it, and NEVER returns the token', async () => {
    const s = await startCliLink({ accountId: 'acme', label: 'Acme' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const r = await completeCliLink({ linkId: s.linkId, code: 'THECODE#STATE' }, { notify: () => {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // the code was written to the CLI's stdin
    expect(h.state.written.some((w) => w.includes('THECODE#STATE'))).toBe(true);
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
