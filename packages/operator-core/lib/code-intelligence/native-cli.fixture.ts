/** Real native CLI fixture: preserve the selected runtime and producer budgets. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { resolveAgentMcpBaseUrl } from '../mcp-base-url';
import { PTOOL_CONNECT_TIMEOUT_MS, PTOOL_LIST_TOOLS_TOTAL_TIMEOUT_MS,
  PTOOL_LIST_TOOLS_TIMEOUT_MS, timeoutForTool } from '../../../../apps/operator/scripts/ptool.mjs';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const processHeadroomMs = PTOOL_LIST_TOOLS_TIMEOUT_MS;

export function nativeCliPlan(baseUrl: string, name: string, args: Record<string, unknown>,
  inherited: NodeJS.ProcessEnv = process.env) {
  const selected = new URL(baseUrl);
  const staging = selected.protocol === 'http:' && selected.port === '3170' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(selected.hostname);
  const env: NodeJS.ProcessEnv = { ...inherited, PAPERCUSP_CONTEXT_TIER: 'full' };
  // An inherited green proxy must never reclassify an alternate/remote pin.
  delete env.PAPERCUSP_MCP_PROXY_BASE;
  delete env.PAPERCUSP_MCP_PROXY_PORT;
  const cliUrl = staging ? resolveAgentMcpBaseUrl(baseUrl, {
    ...env, PAPERCUSP_MCP_STAGING_PROXY_PORT: inherited.PAPERCUSP_MCP_STAGING_PROXY_PORT ?? '9171',
  }) : baseUrl.replace(/\/$/, '');
  if (staging) {
    const proxy = new URL(cliUrl);
    if (proxy.origin === selected.origin || ['3070', '9071'].includes(proxy.port)) {
      throw new Error('Native CLI staging fixture requires its maintained MCP proxy');
    }
    env.PAPERCUSP_MCP_PROXY_BASE = cliUrl;
    env.PAPERCUSP_MCP_PROXY_PORT = proxy.port;
  }
  const requestMs = timeoutForTool('tools:invoke', { name, args });
  return { cliUrl, env, timeoutMs: PTOOL_CONNECT_TIMEOUT_MS + PTOOL_LIST_TOOLS_TOTAL_TIMEOUT_MS + requestMs + processHeadroomMs };
}

export function nativeCliTestTimeout(names: string[]) {
  return names.reduce<number>((total, name) => total + nativeCliPlan('http://127.0.0.1:3170', name, {}).timeoutMs,
    processHeadroomMs);
}

export function nativeCliResult(result: { status: number | null; stdout: string; stderr: string; error?: Error; signal?: string | null }) {
  const evidence = `status=${result.status} signal=${result.signal ?? 'none'} error=${result.error?.message ?? 'none'}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  if (result.status !== 0 || result.error) throw new Error(`Native CLI process failed\n${evidence}`);
  let parsed: { ok?: boolean; data?: unknown };
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new Error(`Native CLI returned invalid JSON\n${evidence}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Native CLI returned an invalid response shape\n${evidence}`);
  }
  if (parsed.ok === false) throw new Error(`Native CLI tool refused\n${evidence}`);
  // Only the legacy object wrapper is a transport envelope. Byte readers own
  // their base64 `data` field, so preserve the complete page and its cursor.
  return parsed.data !== null && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    && Object.keys(parsed).every(key => key === 'ok' || key === 'data') ? parsed.data : parsed;
}

export function nativeCliCall(baseUrl: string, name: string, args: Record<string, unknown>) {
  const plan = nativeCliPlan(baseUrl, name, args);
  return nativeCliResult(spawnSync(process.execPath, [join(repoRoot, 'apps/operator/scripts/ptool.mjs'),
    'tools:invoke', `--url=${plan.cliUrl}`, '--json', '-'], {
    cwd: repoRoot, encoding: 'utf8', timeout: plan.timeoutMs, input: JSON.stringify({ name, args }), env: plan.env,
  })) as Record<string, any>;
}
