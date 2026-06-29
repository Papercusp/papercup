import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installOmpModelsConfig } from '../src/connect';
import type { AgentBundle, OmpGatewayModels } from '../src/bundle-client';

const bundleWith = (omp: OmpGatewayModels | null): AgentBundle =>
  ({
    persona: '',
    toolsmd: '',
    skills: [],
    hooks: [],
    mcp_url: '',
    workspace: { id: 'w', name: 'w' },
    user: { id: 'u', username: 'u', displayName: 'u' },
    omp_gateway_models: omp,
    expires_at: new Date(0).toISOString(),
  }) as AgentBundle;

describe('installOmpModelsConfig (P-005 temp-install + restore)', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'omp-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  const agentDir = () => join(home, '.omp', 'agent');
  const modelsYml = () => join(agentDir(), 'models.yml');
  const modelsJson = () => join(agentDir(), 'models.json');

  it('is a no-op (no ~/.omp touch) when the bundle carries no gateway config', () => {
    const restore = installOmpModelsConfig(bundleWith(null));
    expect(existsSync(modelsYml())).toBe(false);
    restore();
    expect(existsSync(agentDir())).toBe(false);
  });

  it('installs the gateway models.yml and leaves NO permanent edit after restore', () => {
    const restore = installOmpModelsConfig(
      bundleWith({ relPath: '.omp/agent/models.yml', content: 'GATEWAY_YAML', modelSelector: 'papercusp-gateway/claude-sonnet-4' }),
    );
    expect(readFileSync(modelsYml(), 'utf8')).toBe('GATEWAY_YAML');
    restore();
    expect(existsSync(modelsYml())).toBe(false);
  });

  it("backs up + restores a user's pre-existing models.yml AND models.json", () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(modelsYml(), 'USER_YAML');
    writeFileSync(modelsJson(), 'USER_JSON');

    const restore = installOmpModelsConfig(
      bundleWith({ relPath: '.omp/agent/models.yml', content: 'GATEWAY_YAML', modelSelector: 'x' }),
    );
    // ours is authoritative for the session; the user's json is moved aside so
    // pi can't migrate-clobber our yml.
    expect(readFileSync(modelsYml(), 'utf8')).toBe('GATEWAY_YAML');
    expect(existsSync(modelsJson())).toBe(false);

    restore();
    expect(readFileSync(modelsYml(), 'utf8')).toBe('USER_YAML');
    expect(readFileSync(modelsJson(), 'utf8')).toBe('USER_JSON');
  });
});
