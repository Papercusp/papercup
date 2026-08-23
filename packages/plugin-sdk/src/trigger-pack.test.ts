import { describe, expect, it } from 'vitest';
import { validateTriggerPackDeclaration, type PluginTriggerPack } from './index';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

function validManifest(): {
  kind: 'plugin';
  triggerPack: PluginTriggerPack;
  configSchema: Record<string, unknown>;
  oauth: Array<{ provider: string; scopes: string[]; fieldName: string }>;
} {
  return {
    kind: 'plugin',
    triggerPack: {
      source: { kind: 'gmail', oauthField: 'googleWorkspace' },
      plan: {
        path: 'plan.md',
        inputSchema: { type: 'object', properties: { trigger: { type: 'object' } } },
      },
      binding: {
        eventPattern: 'ext:gmail:message.received',
        filter: { direction: 'inbound' },
        stormPolicy: { maxRuns: 5, windowSeconds: 60 },
      },
    },
    configSchema: {
      type: 'object',
      properties: {
        googleWorkspace: {
          type: 'string',
          secret: true,
          shareable: false,
          snapshotPolicy: 'strip',
          oauth: { provider: 'google', scopes: SCOPES },
        },
      },
    },
    oauth: [{ provider: 'google', scopes: SCOPES, fieldName: 'googleWorkspace' }],
  };
}

describe('validateTriggerPackDeclaration', () => {
  it('accepts a manifest-only trigger pack with explicit secret/share/OAuth semantics', () => {
    expect(validateTriggerPackDeclaration(validManifest())).toEqual([]);
  });

  it('rejects code-tool kind:pack and a source/event family mismatch', () => {
    const manifest = validManifest();
    expect(validateTriggerPackDeclaration({
      ...manifest,
      kind: 'pack',
      triggerPack: {
        ...manifest.triggerPack,
        binding: { eventPattern: 'ext:slack:mention' },
      },
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('kind "plugin"'),
      expect.stringContaining('ext:gmail:'),
    ]));
  });

  it('rejects a credential field that could leak or asks for mismatched OAuth scopes', () => {
    const manifest = validManifest();
    const properties = (manifest.configSchema.properties as Record<string, Record<string, unknown>>);
    properties.googleWorkspace = {
      ...properties.googleWorkspace,
      secret: false,
      shareable: true,
      snapshotPolicy: 'include',
      oauth: { provider: 'google', scopes: [SCOPES[0]] },
    };
    expect(validateTriggerPackDeclaration(manifest)).toEqual(expect.arrayContaining([
      expect.stringContaining('.secret must be true'),
      expect.stringContaining('.snapshotPolicy must be "strip"'),
      expect.stringContaining('.shareable must be false'),
      expect.stringContaining('.oauth.scopes must match'),
    ]));
  });

  it('rejects absolute, traversing, and non-markdown plan paths', () => {
    for (const path of ['/plan.md', '../plan.md', 'plans/../plan.md', 'plan.json', 'plans\\plan.md']) {
      const manifest = validManifest();
      manifest.triggerPack.plan.path = path;
      expect(validateTriggerPackDeclaration(manifest)).toContain(
        'triggerPack.plan.path must be a safe relative .md path',
      );
    }
  });
});
