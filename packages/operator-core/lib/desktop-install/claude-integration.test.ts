import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  installClaudeIntegration,
  uninstallClaudeIntegration,
  readClaudeIntegrationState,
  buildClaudeMcpEntry,
  resolveClaudeConfigPath,
} from './claude-integration';

let home: string;
const claudeBin = spawnSync('which', ['claude'], { encoding: 'utf8', timeout: 2_000 }).stdout?.trim();
const execFileAsync = promisify(execFile);

async function seedPhase1(token = 'TOK-abc', agentId = 'agent-xyz') {
  await mkdir(join(home, '.papercusp'), { recursive: true });
  await writeFile(join(home, '.papercusp', 'superuser-token'), token + '\n');
  await writeFile(join(home, '.papercusp', 'su-agent-id'), agentId + '\n');
}

async function writeClaudeJson(obj: unknown) {
  await writeFile(resolveClaudeConfigPath(home), JSON.stringify(obj, null, 2));
}

async function readClaudeJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolveClaudeConfigPath(home), 'utf8'));
}

const templatePath = () => join(home, '.papercusp', 'claude-mcp.json');

async function readTemplateServers(): Promise<Record<string, { type: string; url: string; headers: Record<string, string> }>> {
  return JSON.parse(await readFile(templatePath(), 'utf8')).mcpServers;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'claude-integ-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('buildClaudeMcpEntry', () => {
  it('env-interpolates operator url + sid + workspace + profile (not baked)', () => {
    const e = buildClaudeMcpEntry('http://localhost:3070', 'TOK', 'agent-1', '');
    expect(e.type).toBe('http');
    expect(e.url).toBe(
      '${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}/api/mcp?superuser=1' +
        '&client=${PAPERCUSP_SID:-agent-1}&native_session=${CLAUDE_CODE_SESSION_ID:-}' +
        '&workspace=${PAPERCUSP_WORKSPACE:-}' +
        // recall drill 2 (2026-07-12): ?harness= feeds the initialize-time memory
        // prelude's recall query — absent, every psu session was a bare session
        // with NO session-start recall. Env-expanded like the rest.
        '&harness=${PAPERCUSP_HARNESS_SLUG:-}&profile=${PAPERCUSP_PROFILE:-}' +
        // su-context-size-variants: the ?tools= trim lever — empty default (full catalog) until
        // psu exports PAPERCUSP_TOOLS = CORE spine for a --context-size=trimmed claude.
        '&tools=${PAPERCUSP_TOOLS:-}' +
        // deterministic-tool-definition-delivery-2026-09-21: the SECOND axis of the same
        // decision. ?tools= says WHICH tools are advertised; tools_compact says HOW MUCH of
        // each one ships (prose stripped, shape kept). psu exports PAPERCUSP_TOOLS_COMPACT
        // from the GENERATED delivery artifact, so neither list is hand-maintained.
        // Unset/empty ⇒ nothing is compacted. Env-expanded like the rest — asserted here
        // because the builder emits it unconditionally, between ?tools= and ?ctx_tier=.
        '&tools_compact=${PAPERCUSP_TOOLS_COMPACT:-}' +
        // context-trimming-tiers D-004: the payload-tier lever, same env-expanded pattern.
        '&ctx_tier=${PAPERCUSP_CONTEXT_TIER:-}',
    );
    expect(e.headers.Authorization).toBe('Bearer TOK');
  });
  it('power profile bakes profile=power as the fallback', () => {
    expect(buildClaudeMcpEntry('http://x', 'T', 'a', 'power').url).toContain('profile=${PAPERCUSP_PROFILE:-power}');
  });

  it('keeps the standalone Claude installer bound to the live native session too', () => {
    const installer = readFileSync(
      new URL('../../../../apps/operator/scripts/install-standalone-mcp.sh', import.meta.url),
      'utf8',
    );
    expect(installer).toContain("&native_session=${CLAUDE_CODE_SESSION_ID:-}");
    expect(installer).toContain("'x-papercusp-native-session': '${PAPERCUSP_NATIVE_SESSION_ID:-}'");
  });

  it.skipIf(!claudeBin)('sends the managed native header through actual Claude HTTP config expansion', async () => {
    const nativeId = '11111111-1111-4111-8111-111111111111';
    const observed: Array<{ header: string | string[] | undefined; query: string | null }> = [];
    const server = createServer((req, res) => {
      observed.push({
        header: req.headers['x-papercusp-native-session'],
        query: new URL(req.url!, 'http://localhost').searchParams.get('native_session'),
      });
      // Configuration health-check only; never invoke an agent or a model.
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const entry = buildClaudeMcpEntry(`http://127.0.0.1:${address.port}`, 'diagnostic', 'probe', '');
      await writeClaudeJson({ mcpServers: { probe: entry } });
      const env = {
        PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: home,
        PAPERCUSP_NATIVE_SESSION_ID: nativeId,
        DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      };
      await execFileAsync(claudeBin!, ['mcp', 'get', 'probe'], { cwd: home, env, timeout: 15_000 });
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((r) => r.header === nativeId && r.query === '')).toBe(true);
      // An absent launch identity must not emit a placeholder or authenticate as
      // a predecessor. The legacy native query still works for a bare client.
      observed.length = 0;
      const { PAPERCUSP_NATIVE_SESSION_ID: _managedId, ...bareEnv } = env;
      await execFileAsync(claudeBin!, ['mcp', 'get', 'probe'], {
        cwd: home, env: { ...bareEnv, CLAUDE_CODE_SESSION_ID: nativeId }, timeout: 15_000,
      });
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((r) => !r.header && r.query === nativeId)).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 40_000);
});

describe('installClaudeIntegration', () => {
  it('writes papercusp-su to the psu template and never registers it in ~/.claude.json', async () => {
    await seedPhase1('TOK-1', 'agent-1');
    await writeClaudeJson({ numStartups: 7, theme: 'dark', mcpServers: { other: { type: 'http', url: 'u', headers: {} } } });
    const userBefore = await readFile(resolveClaudeConfigPath(home), 'utf8');

    const res = await installClaudeIntegration({ home });
    expect(res.changed).toBe(true);
    expect(res.mcpServerInstalled).toBe(true);
    expect(res.templatePath).toBe(templatePath());

    // The user's own config is byte-identical: a plain `claude` loads no Papercusp tools.
    expect(await readFile(resolveClaudeConfigPath(home), 'utf8')).toBe(userBefore);
    const servers = await readTemplateServers();
    expect(Object.keys(servers)).toEqual(['papercusp-su']);
    expect(servers['papercusp-su'].url).toContain('${PAPERCUSP_OPERATOR_URL:-');
    expect(servers['papercusp-su'].url).toContain('client=${PAPERCUSP_SID:-agent-1}');
    expect(servers['papercusp-su'].headers.Authorization).toBe('Bearer TOK-1');
  });

  it('removes a legacy papercusp-su entry from ~/.claude.json, preserving every other key', async () => {
    await seedPhase1();
    await writeClaudeJson({
      numStartups: 7,
      mcpServers: { 'papercusp-su': { type: 'http', url: 'old', headers: {} }, other: { type: 'http', url: 'u', headers: {} } },
    });
    const res = await installClaudeIntegration({ home });
    expect(res.actions).toContain('removed legacy mcpServers.papercusp-su from ~/.claude.json');
    const cfg = await readClaudeJson();
    expect(cfg.numStartups).toBe(7);
    expect(cfg.mcpServers).toEqual({ other: { type: 'http', url: 'u', headers: {} } });
    expect((await readTemplateServers())['papercusp-su']).toBeDefined();
  });

  it('removes the legacy entry even before phase 1 has minted the token', async () => {
    await writeClaudeJson({ mcpServers: { 'papercusp-su': { type: 'http', url: 'old', headers: {} } } });
    const res = await installClaudeIntegration({ home });
    expect(res.reason).toBe('phase1_not_run');
    expect(res.changed).toBe(true);
    expect((await readClaudeJson()).mcpServers).toEqual({});
  });

  it('is idempotent — a second call writes nothing', async () => {
    await seedPhase1();
    const first = await installClaudeIntegration({ home });
    expect(first.changed).toBe(true);
    const second = await installClaudeIntegration({ home });
    expect(second.changed).toBe(false);
    expect(second.mcpServerInstalled).toBe(true);
  });

  it('never creates ~/.claude.json (onboarding is ensured at launch instead)', async () => {
    await seedPhase1();
    const res = await installClaudeIntegration({ home });
    expect(res.mcpServerInstalled).toBe(true);
    await expect(stat(resolveClaudeConfigPath(home))).rejects.toBeTruthy();
  });

  it('WI-1457: bakes the resilient-proxy base as the fallback when PAPERCUSP_MCP_PROXY_BASE is set', async () => {
    await seedPhase1();
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071';
    try {
      await installClaudeIntegration({ home });
      expect((await readTemplateServers())['papercusp-su'].url).toContain('${PAPERCUSP_OPERATOR_URL:-http://127.0.0.1:9071}');
    } finally {
      delete process.env.PAPERCUSP_MCP_PROXY_BASE;
    }
  });

  it('P-007: with neither PAPERCUSP_MCP_PROXY_BASE nor PAPERCUSP_DESKTOP set, bakes the :9071 proxy fallback, never direct :3070', async () => {
    await seedPhase1();
    const prevProxy = process.env.PAPERCUSP_MCP_PROXY_BASE;
    const prevDesktop = process.env.PAPERCUSP_DESKTOP;
    delete process.env.PAPERCUSP_MCP_PROXY_BASE;
    delete process.env.PAPERCUSP_DESKTOP;
    try {
      await installClaudeIntegration({ home });
      const url = (await readTemplateServers())['papercusp-su'].url;
      expect(url).toContain('${PAPERCUSP_OPERATOR_URL:-http://127.0.0.1:9071}');
      expect(url).not.toContain(':3070');
    } finally {
      if (prevProxy === undefined) delete process.env.PAPERCUSP_MCP_PROXY_BASE;
      else process.env.PAPERCUSP_MCP_PROXY_BASE = prevProxy;
      if (prevDesktop === undefined) delete process.env.PAPERCUSP_DESKTOP;
      else process.env.PAPERCUSP_DESKTOP = prevDesktop;
    }
  });

  it('returns phase1_not_run when token/agent-id are missing', async () => {
    const res = await installClaudeIntegration({ home });
    expect(res.reason).toBe('phase1_not_run');
    expect(res.changed).toBe(false);
    await expect(stat(templatePath())).rejects.toBeTruthy();
  });

  it('leaves an invalid ~/.claude.json untouched', async () => {
    await seedPhase1();
    await writeFile(resolveClaudeConfigPath(home), '{ this is not json ');
    const res = await installClaudeIntegration({ home });
    expect(res.mcpServerInstalled).toBe(true);
    expect(await readFile(resolveClaudeConfigPath(home), 'utf8')).toBe('{ this is not json ');
  });

  it('writes the template 0600 (it carries the bearer)', async () => {
    await seedPhase1();
    await installClaudeIntegration({ home });
    const st = await stat(templatePath());
    expect(st.mode & 0o077).toBe(0);
  });

  it('honors the profile option (power)', async () => {
    await seedPhase1();
    await installClaudeIntegration({ home, profile: 'power' });
    expect((await readTemplateServers())['papercusp-su'].url).toContain('profile=${PAPERCUSP_PROFILE:-power}');
  });
});

describe('uninstallClaudeIntegration', () => {
  it('removes the template and any legacy ~/.claude.json entry, preserving other servers', async () => {
    await seedPhase1();
    await installClaudeIntegration({ home });
    await writeClaudeJson({ mcpServers: { 'papercusp-su': { type: 'http', url: 'x', headers: {} }, keep: { type: 'http', url: 'y', headers: {} } } });
    const res = await uninstallClaudeIntegration({ home });
    expect(res.changed).toBe(true);
    const servers = (await readClaudeJson()).mcpServers as Record<string, unknown>;
    expect(servers['papercusp-su']).toBeUndefined();
    expect(servers.keep).toBeDefined();
    await expect(stat(templatePath())).rejects.toBeTruthy();
  });

  it('no-ops when nothing is installed', async () => {
    const res = await uninstallClaudeIntegration({ home });
    expect(res.changed).toBe(false);
  });
});

describe('readClaudeIntegrationState', () => {
  it('reports installed from the psu template, not from ~/.claude.json', async () => {
    await writeClaudeJson({ mcpServers: { 'papercusp-su': { type: 'http', url: 'x', headers: {} } } });
    expect((await readClaudeIntegrationState({ home })).mcpServerInstalled).toBe(false);
    await seedPhase1();
    await installClaudeIntegration({ home });
    expect((await readClaudeIntegrationState({ home })).mcpServerInstalled).toBe(true);
  });
});
