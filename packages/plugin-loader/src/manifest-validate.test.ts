import { describe, it, expect } from 'vitest';
import { validateManifest } from './manifest-validate';

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const r = validateManifest({ name: 'mytool', version: '0.1.0' });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('rejects unknown top-level fields', () => {
    const r = validateManifest({ name: 'mytool', version: '0.1.0', wibble: true });
    expect(r.ok).toBe(false);
    const msg = r.issues.map((i) => i.message).join(' ');
    expect(msg).toMatch(/unknown property "wibble"/);
  });

  it('rejects an invalid plugin id', () => {
    const r = validateManifest({ name: 'My-TOOL', version: '0.1.0' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === '/name')).toBe(true);
  });

  it('rejects an id that is too short', () => {
    const r = validateManifest({ name: 'ab', version: '0.1.0' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === '/name')).toBe(true);
  });

  it('accepts scoped ids', () => {
    const r = validateManifest({ name: '@papercupai/cloudflare-pages', version: '0.1.0' });
    expect(r.ok).toBe(true);
  });

  it('rejects bad semver', () => {
    const r = validateManifest({ name: 'mytool', version: 'not-a-version' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === '/version')).toBe(true);
  });

  it('accepts known optional fields', () => {
    const r = validateManifest({
      name: 'mytool',
      version: '0.1.0',
      description: 'hi',
      papercusp: '^0.1.0',
      protocol: '^1.0',
      capabilities: ['http:fetch:example.com'],
      kind: 'plugin',
    });
    expect(r.ok).toBe(true);
  });
});

describe('$schema meta-keyword', () => {
  it('allows $schema field for editor LSP autocomplete', () => {
    const r = validateManifest({
      $schema: 'https://papercupai.com/papercusp-plugin.schema.json',
      name: '@test/with-schema',
      version: '0.1.0',
      kind: 'plugin',
      papercusp: '^1.0',
      capabilities: [],
      actions: [],
    });
    expect(r.ok).toBe(true);
  });
});

describe('plugin dependency + config fields', () => {
  it('accepts requires + recommends arrays', () => {
    const r = validateManifest({
      name: '@test/with-deps',
      version: '0.1.0',
      kind: 'plugin',
      papercusp: '^1.0',
      requires: ['@papercupai/cloudflare-pages'],
      recommends: ['@papercupai/github-repo'],
      capabilities: [],
      actions: [],
    });
    expect(r.ok).toBe(true);
  });

  it('accepts defaultConfig object', () => {
    const r = validateManifest({
      name: '@test/with-default-config',
      version: '0.1.0',
      kind: 'plugin',
      papercusp: '^1.0',
      defaultConfig: { apiKey: 'placeholder', retries: 3 },
      capabilities: [],
      actions: [],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects requires as non-array', () => {
    const r = validateManifest({
      name: '@test/bad-requires',
      version: '0.1.0',
      kind: 'plugin',
      papercusp: '^1.0',
      requires: 'not-an-array',
      capabilities: [],
      actions: [],
    });
    expect(r.ok).toBe(false);
  });
});

describe('triggerPack manifest shape (external-triggers P-012)', () => {
  const triggerPack = {
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
  };

  it('accepts the strict pure-data declaration', () => {
    expect(validateManifest({
      name: '@test/email-draft-responder',
      version: '0.1.0',
      kind: 'plugin',
      triggerPack,
    }).ok).toBe(true);
  });

  it('refuses an inline armed bit — install and arm stay separate', () => {
    const r = validateManifest({
      name: '@test/email-draft-responder',
      version: '0.1.0',
      kind: 'plugin',
      triggerPack: {
        ...triggerPack,
        binding: { ...triggerPack.binding, armed: true },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.issues.map((issue) => issue.message).join(' ')).toMatch(/unknown property "armed"/);
  });

  it('refuses unknown nested fields and invalid storm limits', () => {
    const r = validateManifest({
      name: '@test/email-draft-responder',
      version: '0.1.0',
      triggerPack: {
        ...triggerPack,
        source: { ...triggerPack.source, token: 'leak' },
        binding: { ...triggerPack.binding, stormPolicy: { maxRuns: 0 } },
      },
    });
    expect(r.ok).toBe(false);
  });
});

describe('provides.events + dependencies.events (events-as-a-dependency axis, D-003/P-005)', () => {
  const base = { name: '@test/events', version: '0.1.0', kind: 'plugin', papercusp: '^1.0', capabilities: [] as string[] };

  it('accepts a provides.events family declaration', () => {
    const r = validateManifest({
      ...base,
      provides: {
        events: [
          {
            family: 'widget-done',
            keyTemplate: 'widget:done:<id>',
            params: [{ name: 'id', required: true, describe: 'the widget id' }],
            describe: 'A widget finished.',
          },
        ],
      },
    });
    expect(r.ok).toBe(true);
  });

  it('accepts a no-param (literal-key) provided family', () => {
    const r = validateManifest({
      ...base,
      provides: { events: [{ family: 'heartbeat', keyTemplate: 'widget:heartbeat' }] },
    });
    expect(r.ok).toBe(true);
  });

  it('accepts dependencies.events with an optional flag', () => {
    const r = validateManifest({
      ...base,
      dependencies: { events: [{ family: 'widget-done' }, { family: 'other', optional: true }] },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a provided event missing keyTemplate', () => {
    const r = validateManifest({ ...base, provides: { events: [{ family: 'x' }] } });
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown subfield on a provided event (additionalProperties:false)', () => {
    const r = validateManifest({
      ...base,
      provides: { events: [{ family: 'x', keyTemplate: 'a:b', wat: 1 }] },
    });
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown key under provides (additionalProperties:false)', () => {
    const r = validateManifest({ ...base, provides: { tools: ['x'] } });
    expect(r.ok).toBe(false);
  });

  it('rejects a dependencies.events entry missing family', () => {
    const r = validateManifest({ ...base, dependencies: { events: [{ optional: true }] } });
    expect(r.ok).toBe(false);
  });
});
