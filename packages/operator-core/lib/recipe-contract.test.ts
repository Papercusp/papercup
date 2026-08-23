import { describe, expect, it } from 'vitest';
import {
  capabilityManifestV1Schema,
  deriveLegacyForegroundManifest,
  downgradeReplayClass,
  preflightRecipeContract,
  projectedToolName,
  recipeBindingSchemaV1Schema,
  type CapabilityManifestV1,
  type CurrentCallerCapabilityCatalog,
  type LogicalCapability,
  type RecipeBindingSchemaV1,
  validateRecipeBindings,
  validateRecipeCapabilities,
} from './recipe-contract';

const stableStringSchema: RecipeBindingSchemaV1 = {
  version: 1,
  properties: {
    query: { type: 'string', required: true, lifetime: { kind: 'stable' } },
  },
  additionalProperties: false,
};

function manifest(
  requirements: LogicalCapability[] = [],
  overrides: Partial<CapabilityManifestV1> = {},
): CapabilityManifestV1 {
  return {
    version: 1,
    representation: 'recipe-script',
    topology: { premises: ['host:same'] },
    requirements: requirements.map((capability) => ({ capability })),
    lifecycle: { allowed: ['foreground'], default: 'foreground' },
    replay: { class: 'read-only' },
    content: { emits: ['text'] },
    ...overrides,
  };
}

function catalog(input: {
  tools?: string[];
  allowedTools?: string[];
  capabilities?: LogicalCapability[];
  allowedCapabilities?: LogicalCapability[];
  hostSame?: boolean;
} = {}): CurrentCallerCapabilityCatalog {
  const tools = input.tools ?? [];
  const capabilities = input.capabilities ?? [];
  return {
    projectedTools: new Set(tools),
    allowedTools: new Set(input.allowedTools ?? tools),
    availableCapabilities: new Set(capabilities),
    allowedCapabilities: new Set(input.allowedCapabilities ?? capabilities),
    topology: { hostSame: input.hostSame ?? true },
  };
}

describe('recipe contract metadata schemas', () => {
  it('requires the exact v1 representation and host:same topology premise', () => {
    expect(capabilityManifestV1Schema.parse(manifest())).toMatchObject({
      version: 1,
      representation: 'recipe-script',
      topology: { premises: ['host:same'] },
    });
    expect(() =>
      capabilityManifestV1Schema.parse({
        ...manifest(),
        topology: { premises: [] },
      }),
    ).toThrow();
    expect(() =>
      capabilityManifestV1Schema.parse({
        ...manifest(),
        requirements: [{ capability: 'backend:functions-exec' }],
      }),
    ).toThrow('unknown logical capability');
  });

  it('enforces reference kinds and secret each-use resolution in binding metadata', () => {
    expect(
      recipeBindingSchemaV1Schema.parse({
        version: 1,
        properties: {
          secret: {
            type: 'secret-ref',
            lifetime: { kind: 'resolved-ref', refKind: 'secret', resolution: 'each-use' },
          },
          artifact: {
            type: 'resource-ref',
            lifetime: { kind: 'resolved-ref', refKind: 'resource', resolution: 'each-run' },
          },
        },
        additionalProperties: false,
      }),
    ).toBeTruthy();

    expect(() =>
      recipeBindingSchemaV1Schema.parse({
        version: 1,
        properties: {
          secret: {
            type: 'secret-ref',
            lifetime: { kind: 'stable' },
          },
        },
        additionalProperties: false,
      }),
    ).toThrow('secret-ref requires');
  });

  it('rejects duplicate requirements and a default lifecycle outside the allowed set', () => {
    expect(() =>
      capabilityManifestV1Schema.parse({
        ...manifest(['tools:work_items:list']),
        requirements: [
          { capability: 'tools:work_items:list' },
          { capability: 'tools:work_items:list' },
        ],
      }),
    ).toThrow('requirements must be unique');
    expect(() =>
      capabilityManifestV1Schema.parse({
        ...manifest(),
        lifecycle: { allowed: ['foreground'], default: 'background' },
      }),
    ).toThrow('default lifecycle must be included');
  });
});

describe('recipe binding validation and lifetime rules', () => {
  it('requires a schema for non-empty bindings and enforces required/extra/type checks', () => {
    expect(validateRecipeBindings({ bindings: { values: { query: 'hello' } } })).toMatchObject({
      ok: false,
      error: { code: 'binding_schema_required' },
    });
    expect(validateRecipeBindings({ schema: stableStringSchema, bindings: { values: {} } })).toMatchObject({
      ok: false,
      error: { code: 'binding_invalid', path: 'bindings.values.query' },
    });
    expect(
      validateRecipeBindings({
        schema: stableStringSchema,
        bindings: { values: { query: 'hello', extra: true } },
      }),
    ).toMatchObject({ ok: false, error: { code: 'binding_invalid', path: 'bindings.values.extra' } });
    expect(
      validateRecipeBindings({ schema: stableStringSchema, bindings: { values: { query: 42 } } }),
    ).toMatchObject({ ok: false, error: { code: 'binding_invalid' } });
  });

  it('keeps secret references out of script inputs and rejects inline plaintext', () => {
    const schema: RecipeBindingSchemaV1 = {
      version: 1,
      properties: {
        token: {
          type: 'secret-ref',
          required: true,
          lifetime: { kind: 'resolved-ref', refKind: 'secret', resolution: 'each-use' },
        },
      },
      additionalProperties: false,
    };
    expect(validateRecipeBindings({ schema, bindings: { values: { token: 'plaintext' } } })).toMatchObject({
      ok: false,
      error: { code: 'binding_secret_inline' },
    });
    expect(
      validateRecipeBindings({ schema, bindings: { values: { token: { secretRef: 'secret://github/pat' } } } }),
    ).toEqual({
      ok: true,
      value: {
        inputs: {},
        secretRefs: { token: { secretRef: 'secret://github/pat', resolution: 'each-use' } },
        resourceRefs: {},
        replayClass: 'read-only',
        portability: 'portable',
      },
    });
  });

  it('allows typed resource references while rejecting volatile values labelled stable', () => {
    const resourceSchema: RecipeBindingSchemaV1 = {
      version: 1,
      properties: {
        report: {
          type: 'resource-ref',
          lifetime: { kind: 'resolved-ref', refKind: 'resource', resolution: 'each-run' },
        },
      },
      additionalProperties: false,
    };
    expect(
      validateRecipeBindings({
        schema: resourceSchema,
        bindings: { values: { report: { resourceRef: 'artifact://report', revision: 'v7' } } },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        inputs: { report: { resourceRef: 'artifact://report', revision: 'v7' } },
        resourceRefs: {
          report: { resourceRef: 'artifact://report', revision: 'v7', resolution: 'each-run' },
        },
      },
    });

    const stableJsonSchema: RecipeBindingSchemaV1 = {
      version: 1,
      properties: { state: { type: 'json', lifetime: { kind: 'stable' } } },
      additionalProperties: false,
    };
    expect(
      validateRecipeBindings({
        schema: stableJsonSchema,
        bindings: { values: { state: { pty_id: 'pty-current' } } },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'binding_ephemeral_persisted', path: 'bindings.values.state.pty_id' },
    });
    expect(
      validateRecipeBindings({
        schema: stableJsonSchema,
        bindings: { values: { state: { path: '/tmp/one-run/output.json' } } },
      }),
    ).toMatchObject({ ok: false, error: { code: 'binding_ephemeral_persisted' } });
  });

  it('admits invocation-ephemeral values only for the current foreground invocation', () => {
    const schema: RecipeBindingSchemaV1 = {
      version: 1,
      properties: {
        screen: { type: 'string', lifetime: { kind: 'invocation-ephemeral' } },
      },
      additionalProperties: false,
    };
    expect(
      validateRecipeBindings({ schema, bindings: { values: { screen: 'pty-now' } }, lifecycle: 'foreground' }),
    ).toMatchObject({
      ok: true,
      value: { replayClass: 'non-replayable', portability: 'invocation-bound' },
    });
    expect(
      validateRecipeBindings({ schema, bindings: { values: { screen: 'pty-now' } }, lifecycle: 'background' }),
    ).toMatchObject({ ok: false, error: { code: 'binding_ephemeral_persisted' } });
    expect(
      validateRecipeBindings({ schema, bindings: { values: { screen: 'pty-now' } }, persistBindings: true }),
    ).toMatchObject({ ok: false, error: { code: 'binding_ephemeral_persisted' } });
  });
});

describe('recipe capability derivation and current-caller preflight', () => {
  it('derives a foreground-only legacy manifest with logical capability escapes', () => {
    expect(projectedToolName('workItems.list')).toBe('work_items:list');
    expect(projectedToolName('capability.bashOutput')).toBe('capability:bash_output');
    expect(deriveLegacyForegroundManifest(['workItems.list', 'capability.bashOutput'])).toEqual({
      version: 1,
      representation: 'recipe-script',
      topology: { premises: ['host:same'] },
      requirements: [
        { capability: 'execution:background-task' },
        { capability: 'execution:shell' },
        { capability: 'tools:capability:bash_output' },
        { capability: 'tools:work_items:list' },
      ],
      lifecycle: { allowed: ['foreground'], default: 'foreground' },
      replay: {
        class: 'non-replayable',
        reason: 'legacy recipe: foreground-only until recaptured with an explicit versioned contract',
      },
      content: { emits: ['text'] },
    });
  });

  it('fails before dispatch when a statically required tool was not declared', () => {
    expect(
      validateRecipeCapabilities({
        manifest: manifest(),
        staticToolNames: ['work_items:list'],
        catalog: catalog({ tools: ['work_items:list'] }),
      }),
    ).toMatchObject({
      ok: false,
      phase: 'preflight',
      executed: false,
      error: { code: 'capability_undeclared', capability: 'tools:work_items:list' },
    });
  });

  it('distinguishes unavailable implementations from current-caller denial', () => {
    const declared = manifest(['tools:work_items:list']);
    expect(
      validateRecipeCapabilities({
        manifest: declared,
        staticToolNames: ['work_items:list'],
        catalog: catalog(),
      }),
    ).toMatchObject({ ok: false, error: { code: 'capability_unavailable' } });
    expect(
      validateRecipeCapabilities({
        manifest: declared,
        staticToolNames: ['work_items:list'],
        catalog: catalog({ tools: ['work_items:list'], allowedTools: [] }),
      }),
    ).toMatchObject({ ok: false, error: { code: 'capability_denied' } });
  });

  it('checks mandatory host:same and the current caller logical capability envelope', () => {
    const shellManifest = manifest(['tools:capability:bash', 'execution:shell']);
    expect(
      validateRecipeCapabilities({
        manifest: shellManifest,
        staticToolNames: ['capability:bash'],
        catalog: catalog({
          tools: ['capability:bash'],
          capabilities: ['execution:shell'],
          hostSame: false,
        }),
      }),
    ).toMatchObject({ ok: false, error: { code: 'topology_premise_failed' } });
    expect(
      validateRecipeCapabilities({
        manifest: shellManifest,
        staticToolNames: ['capability:bash'],
        catalog: catalog({
          tools: ['capability:bash'],
          capabilities: ['execution:shell'],
          allowedCapabilities: [],
        }),
      }),
    ).toMatchObject({ ok: false, error: { code: 'capability_denied', capability: 'execution:shell' } });
    expect(
      validateRecipeCapabilities({
        manifest: shellManifest,
        staticToolNames: ['capability:bash'],
        catalog: catalog({ tools: ['capability:bash'], capabilities: ['execution:shell'] }),
      }),
    ).toMatchObject({
      ok: true,
      value: {
        requirements: ['execution:shell', 'tools:capability:bash'],
      },
    });
  });

  it('requires lifecycle:durable to be declared and available for background execution', () => {
    const backgroundManifest = manifest([], {
      lifecycle: { allowed: ['foreground', 'background'], default: 'foreground' },
      replay: { class: 'checkpointed' },
    });
    expect(
      validateRecipeCapabilities({
        manifest: backgroundManifest,
        staticToolNames: [],
        lifecycle: 'background',
        catalog: catalog({ capabilities: ['lifecycle:durable'] }),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'capability_undeclared', capability: 'lifecycle:durable' },
    });
  });
});

describe('combined recipe contract preflight', () => {
  it('only downgrades replay assertions and reports topology-bound v1 portability', () => {
    expect(downgradeReplayClass('non-replayable', 'read-only')).toBe('non-replayable');
    expect(downgradeReplayClass('read-only', 'idempotent')).toBe('idempotent');
    expect(downgradeReplayClass('idempotent', 'checkpointed')).toBe('checkpointed');

    expect(
      preflightRecipeContract({
        manifest: manifest(['tools:work_items:list']),
        bindingSchema: stableStringSchema,
        bindings: { values: { query: 'open queue' } },
        staticToolNames: ['work_items:list'],
        derivedReplayClass: 'idempotent',
        catalog: catalog({ tools: ['work_items:list'] }),
      }),
    ).toMatchObject({
      ok: true,
      value: {
        replay: {
          asserted: 'read-only',
          derived: 'idempotent',
          effective: 'idempotent',
          downgraded: true,
        },
        portability: 'topology-bound',
        bindings: { inputs: { query: 'open queue' } },
      },
    });
  });

  it('rejects a background run when binding/runtime evidence makes it non-replayable', () => {
    const backgroundManifest = manifest(['lifecycle:durable'], {
      lifecycle: { allowed: ['foreground', 'background'], default: 'background' },
      replay: { class: 'checkpointed' },
    });
    expect(
      preflightRecipeContract({
        manifest: backgroundManifest,
        staticToolNames: [],
        derivedReplayClass: 'non-replayable',
        catalog: catalog({ capabilities: ['lifecycle:durable'] }),
      }),
    ).toMatchObject({ ok: false, error: { code: 'durable_replay_unsafe' } });
  });
});

