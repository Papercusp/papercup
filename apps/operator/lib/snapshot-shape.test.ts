import { describe, expect, it } from 'vitest';
import {
  extractShape,
  resolveAliases,
  type ConfigSchema,
} from './snapshot-shape';

describe('extractShape', () => {
  it('strips secret fields by default', () => {
    const schema: ConfigSchema = {
      properties: {
        github_token: { type: 'string', secret: true },
        repo: { type: 'string' },
      },
    };
    const { redactedConfig, shape } = extractShape(schema, {
      github_token: 'ghp_abc',
      repo: 'my-repo',
    });
    expect(redactedConfig).toEqual({ repo: 'my-repo' });
    expect(shape.fields.github_token.reason).toBe('secret-strip');
    expect(shape.fields.repo).toBeUndefined();
    expect(shape.warnings).toEqual([]);
  });

  it('preserves oauth descriptor in shape for stripped secrets', () => {
    const schema: ConfigSchema = {
      properties: {
        github_token: {
          type: 'string',
          secret: true,
          oauth: { provider: 'github', scopes: ['repo'] },
          description: 'GitHub PAT',
        },
      },
    };
    const { shape } = extractShape(schema, { github_token: 'ghp_x' });
    expect(shape.fields.github_token.oauth).toEqual({
      provider: 'github',
      scopes: ['repo'],
    });
    expect(shape.fields.github_token.description).toBe('GitHub PAT');
  });

  it('strips shareable:false fields', () => {
    const schema: ConfigSchema = {
      properties: {
        accountId: { type: 'string', shareable: false, pattern: '^[a-f0-9]{32}$' },
        repo: { type: 'string' },
      },
    };
    const { redactedConfig, shape } = extractShape(schema, {
      accountId: 'abc123',
      repo: 'my-repo',
    });
    expect(redactedConfig).toEqual({ repo: 'my-repo' });
    expect(shape.fields.accountId.reason).toBe('shareable-false');
    expect(shape.fields.accountId.pattern).toBe('^[a-f0-9]{32}$');
  });

  describe('snapshotPolicy: include', () => {
    const schema: ConfigSchema = {
      properties: {
        demo_webhook: {
          type: 'string',
          secret: true,
          snapshotPolicy: 'include',
        },
      },
    };

    it('keeps include-policy secrets when --include-secrets confirmed', () => {
      const { redactedConfig, shape } = extractShape(
        schema,
        { demo_webhook: 'https://hooks.slack/...' },
        { includeSecretsConfirmed: true },
      );
      expect(redactedConfig.demo_webhook).toBe('https://hooks.slack/...');
      expect(shape.fields.demo_webhook.reason).toBe('secret-include');
    });

    it('strips include-policy secrets when not confirmed', () => {
      const { redactedConfig, shape } = extractShape(schema, {
        demo_webhook: 'https://hooks.slack/...',
      });
      expect(redactedConfig.demo_webhook).toBeUndefined();
      expect(shape.warnings.length).toBeGreaterThan(0);
      expect(shape.warnings[0]).toContain('--include-secrets');
    });
  });

  describe('snapshotPolicy: warn-and-prompt', () => {
    const schema: ConfigSchema = {
      properties: {
        token: { type: 'string', secret: true, snapshotPolicy: 'warn-and-prompt' },
      },
    };

    it('strips when resolver returns false', () => {
      const { redactedConfig } = extractShape(
        schema,
        { token: 'x' },
        { resolveWarnAndPrompt: () => false },
      );
      expect(redactedConfig.token).toBeUndefined();
    });

    it('keeps when resolver returns true', () => {
      const { redactedConfig } = extractShape(
        schema,
        { token: 'x' },
        { resolveWarnAndPrompt: () => true },
      );
      expect(redactedConfig.token).toBe('x');
    });

    it('defaults to strip when no resolver supplied', () => {
      const { redactedConfig } = extractShape(schema, { token: 'x' });
      expect(redactedConfig.token).toBeUndefined();
    });
  });

  describe('pattern-based fallback', () => {
    it('strips unflagged keys that match secret pattern', () => {
      const { redactedConfig, shape } = extractShape(
        { properties: {} },
        { api_key: 'abc', other: 'safe' },
      );
      expect(redactedConfig).toEqual({ other: 'safe' });
      expect(shape.fields.api_key.reason).toBe('pattern-fallback');
      expect(shape.warnings[0]).toContain('not flagged');
    });

    it('keeps but flags fields explicitly marked secret:false matching the pattern', () => {
      const schema: ConfigSchema = {
        properties: {
          api_key: { type: 'string', secret: false },
        },
      };
      const { redactedConfig, shape } = extractShape(schema, { api_key: 'k' });
      expect(redactedConfig.api_key).toBe('k');
      expect(shape.fields.api_key.flaggedShareableButLooksSecret).toBe(true);
      expect(shape.warnings[0]).toContain('flagged shareable');
    });

    it('catches non-conventional names like password and pat', () => {
      const { redactedConfig: r1 } = extractShape({ properties: {} }, { password: 'x' });
      expect(r1.password).toBeUndefined();
      const { redactedConfig: r2 } = extractShape({ properties: {} }, { my_pat: 'x' });
      expect(r2.my_pat).toBeUndefined();
    });

    it('does not catch substrings like "key" alone (per spec)', () => {
      const { redactedConfig } = extractShape({ properties: {} }, { key: 'x' });
      expect(redactedConfig.key).toBe('x');
    });
  });

  it('passes plain config through verbatim', () => {
    const schema: ConfigSchema = {
      properties: {
        defaultBranch: { type: 'string', default: 'main' },
        retries: { type: 'number' },
      },
    };
    const { redactedConfig, shape } = extractShape(schema, {
      defaultBranch: 'develop',
      retries: 3,
    });
    expect(redactedConfig).toEqual({ defaultBranch: 'develop', retries: 3 });
    expect(shape.fields).toEqual({});
  });

  it('handles config keys absent from schema (passthrough + pattern check)', () => {
    const { redactedConfig } = extractShape(
      { properties: {} },
      { extra_field: 'travels', api_token: 'gone' },
    );
    expect(redactedConfig).toEqual({ extra_field: 'travels' });
  });

  it('handles missing/null schema gracefully', () => {
    const { redactedConfig } = extractShape(undefined, { foo: 'bar', api_key: 'x' });
    expect(redactedConfig).toEqual({ foo: 'bar' });
    const { redactedConfig: r2 } = extractShape(null, { foo: 'bar' });
    expect(r2).toEqual({ foo: 'bar' });
  });
});

describe('resolveAliases', () => {
  it('renames old keys to current keys', () => {
    const schema: ConfigSchema = {
      properties: {
        defaultBranch: { type: 'string', aliases: ['default_branch', 'branch'] },
      },
    };
    const { config, trace } = resolveAliases(schema, { default_branch: 'main' });
    expect(config).toEqual({ defaultBranch: 'main' });
    expect(trace.default_branch).toBe('renamed');
  });

  it('drops removed fields (aliases includes null)', () => {
    const schema: ConfigSchema = {
      properties: {
        legacy_flag: { type: 'string', aliases: [null] },
      },
    };
    const { config, trace } = resolveAliases(schema, { legacy_flag: 'old' });
    expect(config.legacy_flag).toBeUndefined();
    expect(trace.legacy_flag).toBe('removed');
  });

  it('prefers current name when both old and new are present', () => {
    const schema: ConfigSchema = {
      properties: {
        defaultBranch: { type: 'string', aliases: ['default_branch'] },
      },
    };
    const { config } = resolveAliases(schema, {
      defaultBranch: 'main',
      default_branch: 'develop',
    });
    expect(config).toEqual({ defaultBranch: 'main' });
  });

  it('leaves config unchanged when no aliases declared', () => {
    const schema: ConfigSchema = {
      properties: { foo: { type: 'string' } },
    };
    const { config, trace } = resolveAliases(schema, { foo: 'bar' });
    expect(config).toEqual({ foo: 'bar' });
    expect(Object.keys(trace)).toHaveLength(0);
  });

  it('handles missing schema gracefully', () => {
    const { config } = resolveAliases(undefined, { foo: 'bar' });
    expect(config).toEqual({ foo: 'bar' });
  });
});
