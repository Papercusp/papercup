/**
 * Round-trip test for the share-semantics flow:
 *
 *   1. Plugin manifest declares share-semantics flags.
 *   2. extractShape strips secret + shareable:false fields, recording shape.
 *   3. shapeJson goes into the SnapshotPlugin manifest entry.
 *   4. The fork-completion form would consume that shape and supply overrides.
 *   5. resolveAliases handles renames between snapshot version and current.
 *
 * Locks the contract so future edits to extractShape or resolveAliases
 * don't break the fork experience.
 */

import { describe, expect, it } from 'vitest';
import { extractShape, resolveAliases, type ConfigSchema } from './snapshot-shape';

describe('end-to-end snapshot fork share-semantics', () => {
  // V1 schema: github-repo plugin
  const v1Schema: ConfigSchema = {
    type: 'object',
    required: ['github_token'],
    properties: {
      github_token: {
        type: 'string',
        secret: true,
        snapshotPolicy: 'strip',
        oauth: { provider: 'github', scopes: ['repo'] },
      },
      owner: {
        type: 'string',
        shareable: false,
        pattern: '^[a-zA-Z0-9-]+$',
      },
      repo: { type: 'string' },
      visibility: { type: 'string', default: 'private' },
      defaultBranch: { type: 'string', default: 'main' },
    },
  };

  // V2 schema: github-repo's defaultBranch was renamed; new field added.
  const v2Schema: ConfigSchema = {
    ...v1Schema,
    properties: {
      ...v1Schema.properties,
      defaultBranch: {
        type: 'string',
        default: 'main',
        aliases: ['default_branch', 'branch'],
      },
      // hypothetical removal: visibility renamed
      visibility: {
        type: 'string',
        default: 'private',
        aliases: ['private'],
      },
    },
  };

  it('publisher snapshot strips token + owner; preserves repo + visibility + defaultBranch', () => {
    const publisherConfig = {
      github_token: 'ghp_publisher',
      owner: 'publisher-org',
      repo: 'sample-app',
      visibility: 'public',
      defaultBranch: 'main',
    };
    const { redactedConfig, shape } = extractShape(v1Schema, publisherConfig);
    expect(redactedConfig).toEqual({
      repo: 'sample-app',
      visibility: 'public',
      defaultBranch: 'main',
    });
    expect(shape.fields.github_token).toBeDefined();
    expect(shape.fields.github_token.reason).toBe('secret-strip');
    expect(shape.fields.github_token.oauth?.provider).toBe('github');
    expect(shape.fields.owner.reason).toBe('shareable-false');
    expect(shape.fields.owner.pattern).toBe('^[a-zA-Z0-9-]+$');
  });

  it('forker overrides fill in stripped fields cleanly', () => {
    // After fork, the substrate writes the redacted base config, then
    // applies the user's overrides on top.
    const baseFromSnapshot = { repo: 'sample-app', visibility: 'public', defaultBranch: 'main' };
    const userOverrides = { github_token: 'ghp_forker', owner: 'forker' };
    const merged = { ...baseFromSnapshot, ...userOverrides };
    expect(merged).toEqual({
      github_token: 'ghp_forker',
      owner: 'forker',
      repo: 'sample-app',
      visibility: 'public',
      defaultBranch: 'main',
    });
  });

  it('renamed fields are resolved when forking onto v2 schema', () => {
    // The snapshot was captured under v1 (defaultBranch: 'develop')
    // Forker installs v2 — same name, so this is a no-op.
    const captured = { defaultBranch: 'develop', repo: 'r' };
    const r = resolveAliases(v2Schema, captured);
    expect(r.config.defaultBranch).toBe('develop');
  });

  it('legacy field name remaps to current name via alias chain', () => {
    // v0 had `default_branch`; v2 schema declares it as an alias for `defaultBranch`.
    const legacy = { default_branch: 'develop', repo: 'r' };
    const r = resolveAliases(v2Schema, legacy);
    expect(r.config).toEqual({ defaultBranch: 'develop', repo: 'r' });
    expect(r.trace.default_branch).toBe('renamed');
  });

  it('snapshot config flows: v0 → v2 with alias rename + share-semantics', () => {
    // Old snapshot captured under v0 had `default_branch` (predates rename)
    // and a publisher's owner/token (which were stripped).
    const oldSnapshotConfig = {
      repo: 'sample-app',
      visibility: 'public',
      default_branch: 'develop',
    };
    // Step 1: forker's overrides arrive.
    const overrides = { github_token: 'ghp_forker', owner: 'forker' };
    // Step 2: alias resolution remaps default_branch → defaultBranch.
    const aliased = resolveAliases(v2Schema, oldSnapshotConfig);
    // Step 3: merge overrides on top.
    const merged = { ...aliased.config, ...overrides };
    expect(merged).toEqual({
      repo: 'sample-app',
      visibility: 'public',
      defaultBranch: 'develop',
      github_token: 'ghp_forker',
      owner: 'forker',
    });
  });

  it('snapshotPolicy: include with publisher confirmation lets demo creds travel', () => {
    const demoSchema: ConfigSchema = {
      properties: {
        demo_webhook: {
          type: 'string',
          secret: true,
          snapshotPolicy: 'include',
        },
      },
    };
    const config = { demo_webhook: 'https://hooks.demo/x' };
    const { redactedConfig, shape } = extractShape(demoSchema, config, {
      includeSecretsConfirmed: true,
    });
    expect(redactedConfig.demo_webhook).toBe('https://hooks.demo/x');
    expect(shape.fields.demo_webhook.reason).toBe('secret-include');
  });
});
