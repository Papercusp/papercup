import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installClaudeIntegration,
  uninstallClaudeIntegration,
  readClaudeIntegrationState,
  buildClaudeMcpEntry,
  resolveClaudeConfigPath,
} from './claude-integration';

let home: string;

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
        '&client=${PAPERCUSP_SID:-agent-1}&workspace=${PAPERCUSP_WORKSPACE:-}&profile=${PAPERCUSP_PROFILE:-}' +
        // su-context-size-variants: the ?tools= trim lever — empty default (full catalog) until
        // psu exports PAPERCUSP_TOOLS = CORE spine for a --context-size=trimmed claude.
        '&tools=${PAPERCUSP_TOOLS:-}',
    );
    expect(e.headers.Authorization).toBe('Bearer TOK');
  });
  it('power profile bakes profile=power as the fallback', () => {
    expect(buildClaudeMcpEntry('http://x', 'T', 'a', 'power').url).toContain('profile=${PAPERCUSP_PROFILE:-power}');
  });
});

describe('installClaudeIntegration', () => {
  it('registers papercusp-su into an existing ~/.claude.json, preserving every other key', async () => {
    await seedPhase1('TOK-1', 'agent-1');
    await writeClaudeJson({ numStartups: 7, theme: 'dark', mcpServers: { other: { type: 'http', url: 'u', headers: {} } } });

    const res = await installClaudeIntegration({ home });
    expect(res.changed).toBe(true);
    expect(res.mcpServerInstalled).toBe(true);

    const cfg = await readClaudeJson();
    expect(cfg.numStartups).toBe(7); // preserved
    expect(cfg.theme).toBe('dark'); // preserved
    const servers = cfg.mcpServers as Record<string, { url: string; headers: { Authorization: string } }>;
    expect(servers.other).toBeDefined(); // other server preserved
    expect(servers['papercusp-su'].url).toContain('${PAPERCUSP_OPERATOR_URL:-');
    expect(servers['papercusp-su'].url).toContain('client=${PAPERCUSP_SID:-agent-1}');
    expect(servers['papercusp-su'].headers.Authorization).toBe('Bearer TOK-1');
  });

  it('is idempotent — a second call writes nothing', async () => {
    await seedPhase1();
    await writeClaudeJson({ mcpServers: {} });
    const first = await installClaudeIntegration({ home });
    expect(first.changed).toBe(true);
    const second = await installClaudeIntegration({ home });
    expect(second.changed).toBe(false);
    expect(second.mcpServerInstalled).toBe(true);
  });

  it('NEVER creates ~/.claude.json when claude was never launched', async () => {
    await seedPhase1();
    const res = await installClaudeIntegration({ home });
    expect(res.changed).toBe(false);
    expect(res.reason).toBe('claude_not_initialized');
    await expect(stat(resolveClaudeConfigPath(home))).rejects.toBeTruthy(); // still absent
  });

  it('returns phase1_not_run when token/agent-id are missing', async () => {
    await writeClaudeJson({ mcpServers: {} }); // claude.json exists, but no ~/.papercusp secrets
    const res = await installClaudeIntegration({ home });
    expect(res.reason).toBe('phase1_not_run');
    expect(res.changed).toBe(false);
  });

  it('skips (does not destroy) an invalid ~/.claude.json', async () => {
    await seedPhase1();
    await writeFile(resolveClaudeConfigPath(home), '{ this is not json ');
    const res = await installClaudeIntegration({ home });
    expect(res.reason).toBe('claude_json_invalid');
    expect(res.changed).toBe(false);
    // file left untouched (not renamed away)
    expect(await readFile(resolveClaudeConfigPath(home), 'utf8')).toBe('{ this is not json ');
  });

  it('writes 0600 (not group/world readable)', async () => {
    await seedPhase1();
    await writeClaudeJson({ mcpServers: {} });
    await installClaudeIntegration({ home });
    const st = await stat(resolveClaudeConfigPath(home));
    expect(st.mode & 0o077).toBe(0);
  });

  it('honors the profile option (power)', async () => {
    await seedPhase1();
    await writeClaudeJson({ mcpServers: {} });
    await installClaudeIntegration({ home, profile: 'power' });
    const servers = (await readClaudeJson()).mcpServers as Record<string, { url: string }>;
    expect(servers['papercusp-su'].url).toContain('profile=${PAPERCUSP_PROFILE:-power}');
  });
});

describe('uninstallClaudeIntegration', () => {
  it('removes papercusp-su, preserves other servers', async () => {
    await seedPhase1();
    await writeClaudeJson({ mcpServers: { 'papercusp-su': { type: 'http', url: 'x', headers: {} }, keep: { type: 'http', url: 'y', headers: {} } } });
    const res = await uninstallClaudeIntegration({ home });
    expect(res.changed).toBe(true);
    const servers = (await readClaudeJson()).mcpServers as Record<string, unknown>;
    expect(servers['papercusp-su']).toBeUndefined();
    expect(servers.keep).toBeDefined();
  });

  it('no-ops when ~/.claude.json is absent', async () => {
    const res = await uninstallClaudeIntegration({ home });
    expect(res.changed).toBe(false);
  });
});

describe('readClaudeIntegrationState', () => {
  it('reports installed when papercusp-su present', async () => {
    await writeClaudeJson({ mcpServers: { 'papercusp-su': { type: 'http', url: 'x', headers: {} } } });
    const st = await readClaudeIntegrationState({ home });
    expect(st.claudeConfigExists).toBe(true);
    expect(st.mcpServerInstalled).toBe(true);
  });
});
