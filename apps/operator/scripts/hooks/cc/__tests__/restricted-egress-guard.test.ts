/**
 * PreToolUse restricted-egress guard (plan personal-data-reader-set-labels-2026-10-01,
 * P-007, BAR R-11): the client-native Bash / WebFetch half of the egress binding.
 *
 * Pins (1) the hook's coarse prefilter to the operator's authoritative rule list —
 * an installed hook cannot import that list, so a rule added there without a
 * prefilter entry would silently skip the check — and (2) the decision flow,
 * including the fail-closed branches, and (3) the script's stdin/stdout wiring.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  decideEgress,
  egressTexts,
  prefilterHits,
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

  it('allows a non-provider command without calling the operator', async () => {
    const fetchImpl = vi.fn();
    await expect(decideEgress({ toolName: 'Bash', toolInput: { command: 'ls' }, env: ENV, fetchImpl })).resolves.toEqual({
      decision: 'allow',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows a non-psu session (no PAPERCUSP_SID) without calling the operator', async () => {
    const fetchImpl = vi.fn();
    const result = await decideEgress({ toolName: 'Bash', toolInput: { command: PROVIDER_COMMAND }, env: {}, fetchImpl });
    expect(result).toEqual({ decision: 'allow' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('denies with the operator reason when the session is restricted', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, verdict: 'refuse', code: 'disclosure_egress_refused', reason: 'restricted session' }),
    );
    const result = await decideEgress({ toolName: 'Bash', toolInput: { command: PROVIDER_COMMAND }, env: ENV, fetchImpl });
    expect(result).toEqual({ decision: 'deny', reason: 'restricted session' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:59999/api/agent-mcp/restricted-egress-check');
    expect(JSON.parse(String(init.body))).toEqual({ owner: 'su-test', tool: 'Bash', texts: [PROVIDER_COMMAND] });
  });

  it('allows when the operator says the session is unrestricted', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, verdict: 'allow' }));
    await expect(
      decideEgress({ toolName: 'WebFetch', toolInput: { url: 'https://api.linkedin.com/v2/me' }, env: ENV, fetchImpl }),
    ).resolves.toEqual({ decision: 'allow' });
  });

  it('fails closed when the operator errors or is unreachable', async () => {
    const failing = vi.fn(async () => jsonResponse({ ok: false, error: 'boom' }, 500));
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    for (const fetchImpl of [failing, down]) {
      const result = await decideEgress({ toolName: 'Bash', toolInput: { command: PROVIDER_COMMAND }, env: ENV, fetchImpl });
      expect(result.decision).toBe('deny');
    }
  });
});

describe('script wiring', () => {
  function run(payload: unknown, env: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
      timeout: 20_000,
    });
  }

  it('prints nothing for an ordinary command', () => {
    const res = run({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }, ENV);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('prints a PreToolUse deny when a provider command cannot be cleared', () => {
    const res = run({ tool_name: 'Bash', tool_input: { command: PROVIDER_COMMAND } }, ENV);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { hookSpecificOutput: Record<string, string> };
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
  });
});
