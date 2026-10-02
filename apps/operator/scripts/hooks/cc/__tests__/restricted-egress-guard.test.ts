/**
 * PreToolUse restricted-egress guard (plan personal-data-reader-set-labels-2026-10-01,
 * P-007, BAR R-11): the client-native Bash / WebFetch half of the egress binding.
 *
 * Pins (1) the hook's coarse prefilter to the operator's authoritative rule list —
 * an installed hook cannot import that list, so a rule added there without a
 * prefilter entry would silently skip the check — and (2) the decision flow,
 * including the fail-closed branches, and (3) the script's stdin/stdout wiring.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  RESTRICTED_EGRESS_MATCHER,
  decideEgress,
  egressTexts,
  prefilterHits,
  sandboxedBashCommand,
} from '../pretooluse-restricted-egress-guard.mjs';
import { providerEgressRules } from '../../../../../../packages/operator-core/lib/personal-vault/provider-egress.mjs';

const HOOK = fileURLToPath(new URL('../pretooluse-restricted-egress-guard.mjs', import.meta.url));
const ENV = { PAPERCUSP_SID: 'su-test', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:59999' } as NodeJS.ProcessEnv;
const PROVIDER_COMMAND = 'curl -X POST https://slack.com/api/chat.postMessage -d text=hi';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('prefilter covers the operator rule list', () => {
  it('matches every rule sample in provider-egress.mjs', () => {
    for (const rule of providerEgressRules()) expect(prefilterHits([rule.sample]), rule.id).toBe(true);
  });

  it('does not match ordinary commands', () => {
    for (const command of ['ls -la', 'git status', 'npm run test:file -- a.test.ts', 'curl http://127.0.0.1:3070/api/health']) {
      expect(prefilterHits([command]), command).toBe(false);
    }
  });
});

describe('decideEgress', () => {
  it('reads the Bash command and the WebFetch URL, nothing else', () => {
    expect(egressTexts('Bash', { command: 'echo hi' })).toEqual(['echo hi']);
    expect(egressTexts('WebFetch', { url: 'https://slack.com', prompt: 'x' })).toEqual(['https://slack.com']);
    expect(egressTexts('Read', { file_path: '/x' })).toEqual([]);
  });

  it('allows a non-psu session (no PAPERCUSP_SID) without calling the operator', async () => {
    const fetchImpl = vi.fn();
    const result = await decideEgress({ toolName: 'Bash', toolInput: { command: PROVIDER_COMMAND }, env: {}, fetchImpl });
    expect(result).toEqual({ decision: 'allow' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('denies with the operator reason when a provider is named, and asks for the restriction status', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, verdict: 'refuse', code: 'disclosure_egress_refused', reason: 'restricted session', restricted: true }),
    );
    const result = await decideEgress({ toolName: 'Bash', toolInput: { command: PROVIDER_COMMAND }, env: ENV, fetchImpl });
    expect(result).toEqual({ decision: 'deny', reason: 'restricted session' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:59999/api/agent-mcp/restricted-egress-check');
    expect(JSON.parse(String(init.body))).toEqual({ owner: 'su-test', tool: 'Bash', texts: [PROVIDER_COMMAND], status: true });
  });

  it('allows every tool unchanged when the operator says the session is unrestricted', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, verdict: 'allow', restricted: false }));
    for (const [toolName, toolInput] of [
      ['Bash', { command: 'ls' }],
      ['WebFetch', { url: 'https://example.com', prompt: 'x' }],
      ['mcp__tsenta__search', { q: 'x' }],
    ] as const) {
      await expect(decideEgress({ toolName, toolInput, env: ENV, fetchImpl }), toolName).resolves.toEqual({ decision: 'allow' });
    }
  });

  // WI-10005589 / D-012: the network layer, not name matching.
  describe('a restricted session', () => {
    const restricted = () => vi.fn(async () => jsonResponse({ ok: true, verdict: 'allow', restricted: true }));
    const RUNTIME_HOOK = `${process.env.HOME}/.papercusp/hooks/cc/x.sh`;

    it('has Bash rewritten to run with no network — even a host built at run time', async () => {
      const command = `python3 -c "import urllib.request; urllib.request.urlopen('https://' + 'slack' + '.com')"`;
      const result = await decideEgress({
        toolName: 'Bash',
        toolInput: { command, description: 'd', run_in_background: true },
        env: ENV,
        fetchImpl: restricted(),
        sandbox: (c) => `SANDBOX[${c}]`,
      });
      expect(result).toEqual({
        decision: 'rewrite',
        updatedInput: { command: `SANDBOX[${command}]`, description: 'd', run_in_background: true },
      });
    });

    it('is denied Bash when no network sandbox exists on the host', async () => {
      const result = await decideEgress({ toolName: 'Bash', toolInput: { command: 'ls' }, env: ENV, fetchImpl: restricted(), sandbox: () => null });
      expect(result).toMatchObject({ decision: 'deny' });
    });

    it('is denied WebFetch and every non-Papercusp MCP tool, but not Papercusp’s own (gated) tools', async () => {
      const fetchImpl = restricted();
      for (const [toolName, toolInput] of [
        ['WebFetch', { url: 'https://example.com', prompt: 'x' }],
        ['mcp__slack__post_message', { text: 'hi' }],
      ] as const) {
        await expect(decideEgress({ toolName, toolInput, env: ENV, fetchImpl }), toolName).resolves.toMatchObject({ decision: 'deny' });
      }
      const calls = fetchImpl.mock.calls.length;
      await expect(decideEgress({ toolName: 'mcp__papercusp-su__mail_send', toolInput: {}, env: ENV, fetchImpl })).resolves.toEqual({
        decision: 'allow',
      });
      expect(fetchImpl.mock.calls.length).toBe(calls);
    });

    it('is denied edits of the files the CLI executes, and allowed every other edit without an operator call', async () => {
      const fetchImpl = restricted();
      for (const file_path of [RUNTIME_HOOK, `${process.env.HOME}/.claude/settings.json`, '/repo/.git/hooks/post-commit', '/repo/.mcp.json']) {
        await expect(
          decideEgress({ toolName: 'Edit', toolInput: { file_path }, cwd: '/repo', env: ENV, fetchImpl }),
          file_path,
        ).resolves.toMatchObject({ decision: 'deny' });
      }
      const calls = fetchImpl.mock.calls.length;
      await expect(
        decideEgress({ toolName: 'Write', toolInput: { file_path: '/repo/src/a.ts' }, cwd: '/repo', env: ENV, fetchImpl }),
      ).resolves.toEqual({ decision: 'allow' });
      expect(fetchImpl.mock.calls.length).toBe(calls);
    });
  });

  it('treats an unreachable or failing operator as restricted (fail closed)', async () => {
    const failing = vi.fn(async () => jsonResponse({ ok: false, error: 'boom' }, 500));
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const unknownStatus = vi.fn(async () => jsonResponse({ ok: true, verdict: 'allow', restricted: null }));
    for (const fetchImpl of [failing, down, unknownStatus]) {
      await expect(
        decideEgress({ toolName: 'Bash', toolInput: { command: 'ls' }, env: ENV, fetchImpl, sandbox: (c) => `S[${c}]` }),
      ).resolves.toEqual({ decision: 'rewrite', updatedInput: { command: 'S[ls]' } });
      await expect(decideEgress({ toolName: 'WebFetch', toolInput: { url: 'https://x.example' }, env: ENV, fetchImpl })).resolves.toMatchObject({
        decision: 'deny',
      });
    }
  });
});

describe('the installed matcher', () => {
  const asRegex = [(m: string) => new RegExp(m), (m: string) => new RegExp(`^(?:${m})$`)];
  it('matches the guarded tools and no Papercusp MCP tool, under either regex reading', () => {
    for (const toRe of asRegex) {
      const re = toRe(RESTRICTED_EGRESS_MATCHER);
      for (const name of ['Bash', 'WebFetch', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__slack__post', 'mcp__tsenta__x']) {
        expect(re.test(name), name).toBe(true);
      }
    }
    const anchored = asRegex[1](RESTRICTED_EGRESS_MATCHER);
    for (const name of ['mcp__papercusp-su__coord_send', 'mcp__papercusp__x', 'Read', 'Grep']) expect(anchored.test(name), name).toBe(false);
  });

  it('is the matcher the desktop installer writes', () => {
    const installer = readFileSync(
      fileURLToPath(new URL('../../../../../../packages/operator-core/lib/desktop-install/papercusp-files.ts', import.meta.url)),
      'utf8',
    );
    expect(installer).toContain(`matcher: '${RESTRICTED_EGRESS_MATCHER}'`);
  });
});

describe('sandboxedBashCommand', () => {
  const home = '/home/u';
  const env = { HOME: home } as NodeJS.ProcessEnv;
  const present = new Set(['/usr/bin/bwrap', '/run/user/1000', '/run/docker.sock', `${home}/.claude`, `${home}/.papercusp/hooks`]);

  it('unshares the network, hides host-service sockets, and makes runtime config read-only', () => {
    const cmd = sandboxedBashCommand(`echo 'it''s'`, { env, cwd: '/repo', uid: 1000, exists: (p) => present.has(p) })!;
    expect(cmd.startsWith(`'/usr/bin/bwrap' '--dev-bind' '/' '/' '--unshare-net'`)).toBe(true);
    expect(cmd).toContain(`'--tmpfs' '/run/user/1000'`);
    expect(cmd).toContain(`'--ro-bind' '/dev/null' '/run/docker.sock'`);
    expect(cmd).toContain(`'--ro-bind' '${home}/.claude' '${home}/.claude'`);
    expect(cmd).toContain(`'--ro-bind' '${home}/.papercusp/hooks' '${home}/.papercusp/hooks'`);
    expect(cmd).not.toContain('.mcp.json'); // absent paths are skipped (bwrap cannot bind a missing path)
    expect(cmd.endsWith(`'--' '/bin/bash' '-c' 'echo '\\''it'\\'''\\''s'\\'''`)).toBe(true);
  });

  it('falls back to unshare --net, and to null when neither exists', () => {
    expect(sandboxedBashCommand('ls', { env, uid: 1000, exists: (p) => p === '/usr/bin/unshare' })).toBe(
      `'/usr/bin/unshare' '--user' '--map-current-user' '--net' '--' '/bin/bash' '-c' 'ls'`,
    );
    expect(sandboxedBashCommand('ls', { env, uid: 1000, exists: () => false })).toBeNull();
  });

  const bwrapWorks = spawnSync('/usr/bin/bwrap', ['--dev-bind', '/', '/', '--unshare-net', '/bin/true']).status === 0;

  it.skipIf(!bwrapWorks)('really has no network: a host listener is reachable outside and unreachable inside (real bwrap)', async () => {
    const server = createServer((socket) => socket.end('hi'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    try {
      const probe = `python3 -c "import socket; s=socket.create_connection(('127.0.0.1', ${port}), 2); print('CONNECTED')"`;
      const run = (command: string) => spawnAsync('/bin/bash', ['-c', command]);
      expect((await run(probe)).stdout).toContain('CONNECTED');
      const inside = await run(sandboxedBashCommand(probe, { cwd: process.cwd() })!);
      expect(inside.stdout).not.toContain('CONNECTED');
      expect(inside.code).not.toBe(0);
      // An ordinary command still works and its exit status passes through.
      const ordinary = await run(sandboxedBashCommand('echo ok; exit 3', { cwd: process.cwd() })!);
      expect(ordinary).toMatchObject({ code: 3 });
      expect(ordinary.stdout).toContain('ok');
    } finally {
      server.close();
    }
  });
});

/** Spawn without blocking the event loop (the in-process listener must keep serving). */
function spawnAsync(file: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((done) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => done({ code, stdout }));
  });
}

describe('script wiring', () => {
  function run(payload: unknown, env: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
      timeout: 20_000,
    });
  }

  it('prints nothing outside a psu session', () => {
    const res = run({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }, {});
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('prints an updatedInput running the command offline when the operator cannot clear the session', () => {
    const res = run({ tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd: process.cwd() }, ENV);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { hookSpecificOutput: Record<string, unknown> };
    if (sandboxedBashCommand('ls -la') === null) {
      expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    } else {
      expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse' });
      expect(String((out.hookSpecificOutput.updatedInput as { command: string }).command)).toMatch(/--unshare-net|--net/);
    }
  });

  it('prints a PreToolUse deny when a provider command cannot be cleared', () => {
    const res = run({ tool_name: 'Bash', tool_input: { command: PROVIDER_COMMAND } }, ENV);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { hookSpecificOutput: Record<string, string> };
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
  });
});
