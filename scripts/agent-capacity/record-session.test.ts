import { describe, expect, it } from 'vitest';
import { claudeEnv, cleanEnv, cliArgs, codexConfigToml, loadCorpus, summarizeToolCalls } from './record-session';

describe('corpus manifest', () => {
  const corpus = loadCorpus();
  it('pins every repo to a full commit sha and gives every task a known repo and profile', () => {
    for (const repo of Object.values(corpus.repos)) expect(repo.sha).toMatch(/^[0-9a-f]{40}$/);
    for (const t of corpus.tasks) {
      expect(corpus.repos[t.repo]).toBeDefined();
      expect(corpus.timeoutSec[t.profile]).toBeGreaterThan(0);
    }
  });
  it('has unique task ids and covers light, typical and heavy on each repo', () => {
    expect(new Set(corpus.tasks.map((t) => t.id)).size).toBe(corpus.tasks.length);
    for (const repo of Object.keys(corpus.repos)) {
      const profiles = new Set(corpus.tasks.filter((t) => t.repo === repo).map((t) => t.profile));
      expect(profiles).toEqual(new Set(['light', 'typical', 'heavy']));
    }
  });
});

describe('recorded CLI environment', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    PAPERCUSP_SID: 'su-1',
    CLAUDE_CONFIG_DIR: '/psu/cfg',
    ANTHROPIC_API_KEY: 'sk-live',
    CODEX_HOME: '/psu/codex',
    OPENAI_API_KEY: 'sk-oa',
  };
  it('drops every agent/session variable so the CLI is customer-shaped', () => {
    expect(cleanEnv(base)).toEqual({ PATH: '/usr/bin', HOME: '/home/x' });
  });
  it('points claude at the proxy with the gateway bearer and a fresh config dir', () => {
    const env = claudeEnv(base, 'http://127.0.0.1:5000', '/tmp/cfg');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:5000');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('papercusp-gateway');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/cfg');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PAPERCUSP_SID).toBeUndefined();
  });
  it('gives codex a single responses-wire provider at the proxy /v1', () => {
    const toml = codexConfigToml('http://127.0.0.1:5000');
    expect(toml).toContain('model_provider = "capture"');
    expect(toml).toContain('base_url = "http://127.0.0.1:5000/v1"');
    expect(toml).toContain('wire_api = "responses"');
  });
  it('runs codex non-interactively in the work dir and claude with bypassed permissions', () => {
    expect(cliArgs('codex', 'do it', '/w', 'sonnet')).toEqual(['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', '/w', 'do it']);
    expect(cliArgs('claude', 'do it', '/w', 'sonnet')).toContain('--dangerously-skip-permissions');
  });
});

describe('tool-call summary', () => {
  it('counts claude tool_use blocks by name', () => {
    const lines = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Bash' }] } },
    ].map((l) => JSON.stringify(l));
    expect(summarizeToolCalls('claude', lines.join('\n') + '\nnot-json\n')).toEqual({ Bash: 2, Read: 1 });
  });
  it('counts codex completed items other than messages and reasoning', () => {
    const lines = [
      { type: 'item.completed', item: { type: 'reasoning' } },
      { type: 'item.completed', item: { type: 'command_execution' } },
      { type: 'item.started', item: { type: 'command_execution' } },
      { type: 'item.completed', item: { type: 'file_change' } },
      { type: 'item.completed', item: { type: 'agent_message' } },
    ].map((l) => JSON.stringify(l));
    expect(summarizeToolCalls('codex', lines.join('\n'))).toEqual({ command_execution: 1, file_change: 1 });
  });
});
