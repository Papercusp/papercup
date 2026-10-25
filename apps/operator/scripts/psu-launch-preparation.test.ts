import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { contextTrimmingEnv, launchFreshSu, prepareSuLaunch, prepareSuLaunchEnvironment } from './psu-launcher.mjs';

const dir = mkdtempSync(join(tmpdir(), 'su-launch-preparation-'));
writeFileSync(join(dir, 'settings.json'), JSON.stringify({ effortLevel: 'max' }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function bootstrap(agent: 'claude' | 'codex') {
  return { status: 'ok', agent, cwd: '/chosen/workspace', promptFile: '/chosen/persona.md',
    nativeSessionId: 'chosen-native-id', compactionLimit: 360000,
    model: agent === 'claude' ? 'claude-sonnet-4-6:high' : 'gpt-5.6-sol:high',
    envelopeEnv: { PAPERCUSP_SID: 'chosen-owner', PAPERCUSP_WORKSPACE: 'chosen-workspace',
      PAPERCUSP_HARNESS_SLUG: 'chosen-harness', PAPERCUSP_LAUNCH_CONTEXT_FILE: '/chosen/context.md',
      PAPERCUSP_ACCOUNT_ROUTING_MODE: 'pin', PAPERCUSP_ACCOUNT_ID: 'chosen-account',
      CODEX_HOME: '/chosen/codex-home', CLAUDE_CONFIG_DIR: dir,
      PAPERCUSP_TTY: '/dev/pts/owned', PAPERCUSP_TOOLS: 'su-tools' } };
}

describe('effective SU launch preparation', () => {
  it.each(['claude', 'codex'] as const)('%s PTY production launcher consumes the canonical prepared configuration', async agent => {
    const home = mkdtempSync(join(tmpdir(), 'su-prepared-consumer-'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const persona = join(home, 'persona.md');
      writeFileSync(persona, 'Chosen persona, authority and memory inputs');
      const boot = { ...bootstrap(agent), cwd: home, promptFile: persona,
        envelopeEnv: { ...bootstrap(agent).envelopeEnv,
          ...contextTrimmingEnv(agent), PAPERCUSP_TOOLS: 'coord_orient',
          PAPERCUSP_TOOLS_COMPACT: 'coord_orient', CODEX_HOME: home, CLAUDE_CONFIG_DIR: home,
          PAPERCUSP_LAUNCH_CONTEXT_FILE: persona, PAPERCUSP_AUTO_MODE: '1',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788',
        } };
      const canonical = prepareSuLaunch(boot, { executionKind: 'pty', accountRoute: 'chosen-account', model: 'stale-caller:low' });
      // Capture the real launcher's final assembly. Existing transport tests
      // exercise the wrapper's same sanitizer and real PTY/stdio children.
      const launch = vi.fn();
      await launchFreshSu({ agent, workspace: 'chosen-workspace' }, {
        model: 'stale-caller:low', account: 'chosen-account', auto: true,
        picker: false, noKickoff: true,
      }, { apiImpl: async () => boot, preflightCodexAutoPoolImpl: async () => true,
        runLaunchPreflightImpl: () => {}, runWrapperImpl: launch });
      expect(launch).toHaveBeenCalledOnce();
      const actual = launch.mock.calls[0][0];
      expect(actual).toMatchObject({ wrapperBin: canonical.bin, cwd: canonical.cwd,
        args: [...canonical.args, ...canonical.extraArgs], envelopeEnv: boot.envelopeEnv });
      const effective = prepareSuLaunchEnvironment(actual.envelopeEnv, {
        ANTHROPIC_API_KEY: 'parent-secret', PAPERCUSP_ACCOUNT_ID: 'parent-account',
      });
      expect(effective).toMatchObject(boot.envelopeEnv);
      expect(effective.ANTHROPIC_API_KEY).toBeUndefined();
      expect(readFileSync(effective.PAPERCUSP_LAUNCH_CONTEXT_FILE, 'utf8')).toBe('Chosen persona, authority and memory inputs');
      if (agent === 'claude') {
        expect(actual.args).toContain(persona);
        expect(actual.args).toContain('--dangerously-skip-permissions');
        expect(actual.args.some((arg: string) => arg.includes('Task,Agent'))).toBe(true);
      } else {
        expect(actual.args).toContain('--dangerously-bypass-hook-trust');
        expect(actual.args).toContain('--dangerously-bypass-approvals-and-sandbox');
        expect(actual.args).toContain('model_auto_compact_token_limit=288000');
      }
    } finally { log.mockRestore(); rmSync(home, { recursive: true, force: true }); }
  });

  it.each(['claude', 'codex'] as const)('%s preserves bootstrap scope, configuration and model across transports', agent => {
    const boot = bootstrap(agent);
    const inheritedEnv = { HOME: dir, PAPERCUSP_SID: 'parent', CODEX_HOME: '/parent/home',
      ANTHROPIC_API_KEY: 'parent-secret', PAPERCUSP_ACCOUNT_ID: 'parent-account' };
    const options = { model: 'caller-model:low', accountRoute: 'chosen-account', inheritedEnv };
    const pty = prepareSuLaunch(boot, { ...options, executionKind: 'pty' });
    const native = prepareSuLaunch(boot, { ...options, executionKind: 'programmatic' });
    expect(native.model).toBe(boot.model);
    expect(native.cwd).toBe(boot.cwd);
    expect(native.args).toEqual(pty.args);
    expect(native.modelArgs).toEqual(pty.modelArgs);
    expect(native.extraArgs).toEqual(pty.extraArgs);
    expect(native.env).toEqual({ ...pty.env, PAPERCUSP_TTY: undefined });
    expect(native.env).toMatchObject({
      PAPERCUSP_SID: 'chosen-owner', PAPERCUSP_ACCOUNT_ID: 'chosen-account',
      CODEX_HOME: '/chosen/codex-home', CLAUDE_CONFIG_DIR: dir,
      PAPERCUSP_LAUNCH_CONTEXT_FILE: '/chosen/context.md', PAPERCUSP_TOOLS: 'su-tools',
    });
    expect(native.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(boot.envelopeEnv.PAPERCUSP_TTY).toBe('/dev/pts/owned');
    expect(inheritedEnv.PAPERCUSP_ACCOUNT_ID).toBe('parent-account');
    if (agent === 'codex') {
      expect(native.modelArgs).toContain('model_reasoning_effort="high"');
      expect(native.modelArgs).toContain('model_auto_compact_token_limit=288000');
    } else {
      expect(native.modelArgs).toEqual(['--model', 'claude-sonnet-4-6', '--effort', 'high']);
      expect(native.args).toContain('--system-prompt-file');
      expect(native.args.some(arg => arg.includes('Task,Agent'))).toBe(true);
    }
  });

  it.each(['claude', 'codex'] as const)('%s refuses account substitution before runtime allocation', agent => {
    for (const accountRoute of ['default', 'auto', 'different-account']) {
      expect(() => prepareSuLaunch(bootstrap(agent), { accountRoute, inheritedEnv: {} }))
        .toThrow(expect.objectContaining({ code: 'account_route_mismatch' }));
    }
  });

  it('repairs a legacy Codex auto response only when its managed home proves the resolved gateway route', () => {
    const home = mkdtempSync(join(tmpdir(), 'su-codex-auto-route-'));
    try {
      writeFileSync(join(home, 'config.toml'), [
        '# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT',
        'model_provider = "papercusp-codex-gateway"',
        '# END PAPERCUSP_CODEX_GATEWAY_ROOT',
        '# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER',
        '[model_providers.papercusp-codex-gateway]',
        'base_url = "http://127.0.0.1:8788/v1"',
        'wire_api = "responses"',
        'experimental_bearer_token = "test-token"',
        'http_headers = { "x-papercusp-owner" = "chosen-owner" }',
        '# END PAPERCUSP_CODEX_GATEWAY_PROVIDER',
      ].join('\n'));
      const legacy = bootstrap('codex');
      delete legacy.envelopeEnv.PAPERCUSP_ACCOUNT_ROUTING_MODE;
      delete legacy.envelopeEnv.PAPERCUSP_ACCOUNT_ID;
      legacy.envelopeEnv.CODEX_HOME = home;
      const launch = prepareSuLaunch({ ...legacy, codexHome: home }, {
        accountRoute: 'auto', inheritedEnv: {},
      });
      expect(launch.env.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('auto');

      const rejected = [
        'model_provider = "papercusp-codex-gateway"\n',
        [
          '# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT',
          'model_provider = "papercusp-codex-gateway"',
          '# END PAPERCUSP_CODEX_GATEWAY_ROOT',
          '# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER',
          '[model_providers.papercusp-codex-gateway]',
          'base_url = "http://127.0.0.1:8788/v1"',
          'wire_api = "responses"',
          'experimental_bearer_token = "test-token"',
          'http_headers = { "x-papercusp-owner" = "chosen-owner", "x-papercusp-account" = "pinned" }',
          '# END PAPERCUSP_CODEX_GATEWAY_PROVIDER',
        ].join('\n'),
        '# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT\nmodel_provider = "papercusp-codex-gateway"\n# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER\n',
        'model_provider = "openai"\n# model_provider = "papercusp-codex-gateway"\n# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT\n# END PAPERCUSP_CODEX_GATEWAY_ROOT\n# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER\n# END PAPERCUSP_CODEX_GATEWAY_PROVIDER\n',
        [
          '# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT',
          'model_provider = "papercusp-codex-gateway"',
          '# END PAPERCUSP_CODEX_GATEWAY_ROOT',
          '# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER',
          '[model_providers.papercusp-codex-gateway]',
          'base_url = "http://127.0.0.1:8788/v1"',
          'wire_api = "responses"',
          'experimental_bearer_token = "test-token"',
          'http_headers = { "x-papercusp-owner" = "chosen-owner", "X-Papercusp-Account" = "pinned" }',
          '# END PAPERCUSP_CODEX_GATEWAY_PROVIDER',
        ].join('\n'),
        [
          '# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT',
          'model_provider = "papercusp-codex-gateway"',
          '# END PAPERCUSP_CODEX_GATEWAY_ROOT',
          '# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER',
          '[model_providers.papercusp-codex-gateway]',
          'base_url = "http://127.0.0.1:8788/v1"',
          'wire_api = "responses"',
          'experimental_bearer_token = "test-token"',
          'http_headers = { "x-papercusp-owner" = "chosen-owner", "x-papercusp-account" = "" }',
          '# END PAPERCUSP_CODEX_GATEWAY_PROVIDER',
        ].join('\n'),
        ...['', 'https://example.invalid/v1'].map(baseUrl => [
          '# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT',
          'model_provider = "papercusp-codex-gateway"',
          '# END PAPERCUSP_CODEX_GATEWAY_ROOT',
          '# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER',
          '[model_providers.papercusp-codex-gateway]',
          `base_url = "${baseUrl}"`,
          'wire_api = "responses"',
          'experimental_bearer_token = "test-token"',
          'http_headers = { "x-papercusp-owner" = "chosen-owner" }',
          '# END PAPERCUSP_CODEX_GATEWAY_PROVIDER',
        ].join('\n')),
      ];
      for (const config of rejected) {
        writeFileSync(join(home, 'config.toml'), config);
        expect(() => prepareSuLaunch({ ...legacy, codexHome: home }, {
          accountRoute: 'auto', inheritedEnv: {},
        })).toThrow(expect.objectContaining({ code: 'account_route_mismatch' }));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('passes a repaired legacy Codex auto route into the spawned child environment', async () => {
    const home = mkdtempSync(join(tmpdir(), 'su-codex-auto-child-'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(home, 'config.toml'), [
        '# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT',
        'model_provider = "papercusp-codex-gateway"',
        '# END PAPERCUSP_CODEX_GATEWAY_ROOT',
        '# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER',
        '[model_providers.papercusp-codex-gateway]',
        'base_url = "http://127.0.0.1:8788/v1"',
        'wire_api = "responses"',
        'experimental_bearer_token = "test-token"',
        'http_headers = { "x-papercusp-owner" = "chosen-owner" }',
        '# END PAPERCUSP_CODEX_GATEWAY_PROVIDER',
      ].join('\n'));
      const legacy = bootstrap('codex');
      delete legacy.envelopeEnv.PAPERCUSP_ACCOUNT_ROUTING_MODE;
      delete legacy.envelopeEnv.PAPERCUSP_ACCOUNT_ID;
      legacy.envelopeEnv.CODEX_HOME = home;
      const launch = vi.fn();
      await launchFreshSu({ agent: 'codex', workspace: 'chosen-workspace' }, {
        model: legacy.model, account: 'auto', picker: false, noKickoff: true,
      }, { apiImpl: async () => ({ ...legacy, codexHome: home }),
        preflightCodexAutoPoolImpl: async () => true,
        runLaunchPreflightImpl: () => {}, runWrapperImpl: launch });
      expect(launch).toHaveBeenCalledOnce();
      expect(launch.mock.calls[0][0].envelopeEnv.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('auto');
    } finally {
      log.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses an ineligible bootstrap instead of falling back to another credential', () => {
    expect(() => prepareSuLaunch({ ...bootstrap('codex'), status: 'error' }, { inheritedEnv: {} }))
      .toThrow(expect.objectContaining({ code: 'unsupported_su_launch' }));
  });

  it('emits no extended-window override for a model without that capability', () => {
    const launch = prepareSuLaunch({ ...bootstrap('codex'), model: 'gpt-5.5:high' }, { inheritedEnv: {} });
    expect(launch.modelArgs).toEqual(['-m', 'gpt-5.5', '-c', 'model_reasoning_effort="high"']);
  });

  it('keeps exact resume separate from new native identity and preserves the native delegation opt-in', () => {
    const boot = bootstrap('claude');
    const fresh = prepareSuLaunch(boot, { inheritedEnv: {} });
    const resumed = prepareSuLaunch(boot, { resumeSession: 'existing-native-id', allowSubagents: true, inheritedEnv: {} });
    expect(fresh.args).toContain('--session-id');
    expect(resumed.args).not.toContain('--session-id');
    expect(resumed.extraArgs.slice(-2)).toEqual(['-r', 'existing-native-id']);
    expect(resumed.args.some(arg => arg.includes('Task,Agent'))).toBe(false);
  });
});
