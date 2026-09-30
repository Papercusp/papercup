import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(__dirname, 'bootstrap-agent-vm.sh');

describe('bootstrap-agent-vm.sh (DRY_RUN)', () => {
  let root: string;
  let tasks: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'capboot-'));
    tasks = path.join(root, 'tasks.json');
    writeFileSync(
      tasks,
      JSON.stringify({
        version: 1,
        repos: {
          webapp: { url: 'https://example.test/webapp.git', sha: 'aaa111', kind: 'ts', setup: ['yarn install --frozen-lockfile', 'yarn build'] },
          service: { url: 'https://example.test/service.git', sha: 'bbb222', kind: 'py', systemPackages: ['libfoo-dev', 'libbar-dev'], setup: ['uv sync --frozen'] },
        },
        tasks: [],
      }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const boot = (env: Record<string, string>) =>
    spawnSync('bash', [SCRIPT, tasks], { encoding: 'utf8', env: { ...process.env, DRY_RUN: '1', AGENT_CAPACITY_CACHE: path.join(root, 'cache'), ...env } });

  it('pins the recorded CLI versions and builds every repo at its sha with its own setup, in order', () => {
    const r = boot({ CLAUDE_VERSION: '2.1.284', CODEX_VERSION: '0.159.2' });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines.at(-1)).toBe('BOOTSTRAP_OK');
    const runs = lines.filter((l) => l.startsWith('RUN ')).map((l) => l.slice(4));
    expect(runs.find((l) => l.includes('apt-get install'))).toMatch(/ libbar-dev libfoo-dev$/);
    expect(runs).toContain('sudo npm install -g --no-fund --no-audit @anthropic-ai/claude-code@2.1.284 @openai/codex@0.159.2');
    const prepared = path.join(root, 'cache', 'prepared');
    const repoRuns = runs.filter((l) => l.includes(prepared) && !l.startsWith('mkdir'));
    expect(repoRuns).toEqual([
      `git clone --quiet https://example.test/service.git ${prepared}/service`,
      `git -C ${prepared}/service checkout --quiet --detach bbb222`,
      `bash -c cd '${prepared}/service' && uv sync --frozen`,
      `git clone --quiet https://example.test/webapp.git ${prepared}/webapp`,
      `git -C ${prepared}/webapp checkout --quiet --detach aaa111`,
      `bash -c cd '${prepared}/webapp' && yarn install --frozen-lockfile`,
      `bash -c cd '${prepared}/webapp' && yarn build`,
    ]);
  });

  it('refuses to start without the recorded CLI versions', () => {
    const r = boot({ CODEX_VERSION: '0.159.2' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/CLAUDE_VERSION/);
    expect(r.stdout).not.toMatch(/RUN /);
  });
});
