import { describe, expect, it, beforeEach } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import { _resetCatalogForTests, getCatalog, lookup } from '@papercusp/tooldef';
// Importing this registers papercuspTierFor as tooldef's tier resolver (load-
// time side effect), so the `defineTool(...).tier` assertions below classify
// against the real Papercusp table rather than the engine's 'low' default.
import { papercuspTierFor } from '../capability-tiers-papercusp';
import {
  _resetProjectionRegistryForTests,
  lookupByMcpName,
} from '@papercusp/tooldef';
import { dispatchProjectedTool } from '@papercusp/tooldef';

describe('defineTool', () => {
  beforeEach(() => {
    _resetCatalogForTests();
    _resetProjectionRegistryForTests();
  });

  it('registers a tool with explicit name', () => {
    const tool = defineTool({
      name: 'tasks:list',
      description: 'List tasks',
      capability: 'tasks:read',
      args: z.object({}),
      async handler() {
        return { data: [] };
      },
    });
    expect(tool.name).toBe('tasks:list');
    expect(tool.tier).toBe('low');
    expect(lookup('tasks:list')).toBe(tool);
  });

  it('looks up tier from capability', () => {
    const tool = defineTool({
      name: 'audit:list',
      description: 'List audit',
      capability: 'audit:read',
      args: z.object({}),
      async handler() {
        return { data: [] };
      },
    });
    expect(tool.tier).toBe('high');
  });

  it('refuses duplicate tool registration', () => {
    defineTool({
      name: 'unique:tool',
      description: 'first',
      capability: 'tasks:read',
      args: z.object({}),
      async handler() {
        return { data: null };
      },
    });
    expect(() =>
      defineTool({
        name: 'unique:tool',
        description: 'second',
        capability: 'audit:read',
        args: z.object({}),
        async handler() {
          return { data: null };
        },
      }),
      // The registration guard's message was reworded to be self-explaining — it now
      // says the second registration "silently shadows the first" (the same anchor its
      // dedicated tests in tool-projection.test.ts assert on). The old `/collision/`
      // assertion here was never updated to match, so it red on every run independent of
      // any change. Anchor both suites on the message's actual, intentional phrase.
    ).toThrow(/silently shadows the first/);
  });

  it('role-gated tools dispatch without a principal', async () => {
    const def = defineTool({
      name: 'operator:scan_test',
      description: 'role-gated probe',
      capability: 'operator:scan',
      requirePrincipal: false,
      agentRoles: ['operator', 'reviewer'],
      args: z.object({ x: z.number() }),
      async handler(args, ctx) {
        return { content: [{ type: 'text', text: `ok ${args.x} role=${ctx.role}` }] };
      },
    });
    expect(def.requirePrincipal).toBe(false);
    expect(def.agentRoles).toEqual(['operator', 'reviewer']);
    // NOT in the legacy catalog (only principal-gated tools land there).
    expect(lookup('operator:scan_test')).toBeUndefined();

    const tool = lookupByMcpName('operator:scan_test');
    expect(tool).toBeDefined();
    expect(tool!.agentRoles).toEqual(['operator', 'reviewer']);

    // No principal on ctx — would be 401 for principal-gated tools, but
    // role-gated should pass through to the handler.
    const result = await dispatchProjectedTool(
      tool!,
      'operator:scan_test',
      { x: 7 },
      {
        log: () => {},
        signal: new AbortController().signal,
        progress: () => {},
        emit: () => {},
        workspaceId: 'default',
        role: 'operator',
        runId: 'run_T',
      },
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.result?.content[0]).toEqual({ type: 'text', text: 'ok 7 role=operator' });
  });

  it('role-gated tools enforce the role allowlist', async () => {
    defineTool({
      name: 'operator:scan_role_gate',
      description: 'role-gate probe',
      capability: 'operator:scan',
      requirePrincipal: false,
      agentRoles: ['operator'],
      args: z.object({}),
      async handler() {
        return { content: [{ type: 'text', text: 'should not run' }] };
      },
    });
    const tool = lookupByMcpName('operator:scan_role_gate')!;
    const result = await dispatchProjectedTool(
      tool,
      'operator:scan_role_gate',
      {},
      {
        log: () => {},
        signal: new AbortController().signal,
        progress: () => {},
        emit: () => {},
        workspaceId: 'default',
        role: 'worker',
        runId: 'run_T',
        chunkId: 'ck_T',
      },
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('role_not_allowed');
  });

  /**
   * EI-20087434994864624 (+7 duplicate filings on 2026-08-10 alone) — a NESTED failure
   * must teach the shape it needs.
   *
   * The former full-schema dump was bounded at 1,800 chars. When the failing field sat
   * several levels down behind a union, that bound landed long before it — so the error was
   * simultaneously too long (context burn) and too short (never reached the answer). Eight
   * agents independently burned ~3 round-trips each on coord:send's `body[].couldNotDetermine`,
   * and the only way any of them extracted the shape was sending a deliberate `[{}]` to make
   * the validator enumerate the required keys.
   *
   * The fixture below is that exact shape: `body` is a union of a string and an array of
   * sections, and the section field is an array of objects.
   */
  describe('nested failing-field schema (EI-20087434994864624)', () => {
    const defineNestedProbe = () =>
      defineTool({
        name: 'operator:nested_hint_probe',
        description: 'nested-field schema-hint probe',
        capability: 'operator:scan',
        requirePrincipal: false,
        agentRoles: ['operator'],
        args: z.object({
          to: z.array(z.string()),
          body: z.union([
            z.string(),
            z.array(
              z.object({
                text: z.string(),
                // The field that defeated eight agents: an array of objects, where the
                // object's key list is the thing you actually need and cannot see.
                couldNotDetermine: z
                  .array(z.object({ what: z.string(), why: z.string().optional() }))
                  .optional(),
              }),
            ),
          ]),
        }),
        async handler() {
          return { content: [{ type: 'text', text: 'should not run' }] };
        },
      });

    const dispatch = async (args: unknown) => {
      defineNestedProbe();
      const tool = lookupByMcpName('operator:nested_hint_probe')!;
      return dispatchProjectedTool(tool, 'operator:nested_hint_probe', args, {
        log: () => {},
        signal: new AbortController().signal,
        progress: () => {},
        emit: () => {},
        workspaceId: 'default',
        role: 'operator',
        runId: 'run_T',
      }, {});
    };

    it('names the accepted keys of the PARENT object when a nested leaf fails', async () => {
      // Exactly the call that failed in the wild: the caller guessed the item shape.
      const result = await dispatch({
        to: ['peer'],
        body: [{ text: 'hi', couldNotDetermine: [{}] }],
      });

      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('invalid_args:');
      // THE POINT: the error carries the failing OBJECT's schema, so `what` is discoverable
      // without a probe. Rendering the leaf instead would give a useless {"type":"string"}.
      expect(result.error?.message).toContain('the field(s) that failed, in full:');
      expect(result.error?.message).toContain('"what"');
      // The label locates it, with array hops collapsed to [] so it reads as a path.
      expect(result.error?.message).toContain('body[].couldNotDetermine[]');
    });

    it('resolves the path THROUGH a union branch, which is why the flat dump could not', async () => {
      const result = await dispatch({
        to: ['peer'],
        // `body` is string | section[]; the failing path only exists in the second branch.
        body: [{ text: 'hi', couldNotDetermine: ['a plain string, not an object'] }],
      });

      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('the field(s) that failed, in full:');
      expect(result.error?.message).toContain('"what"');
    });

    it('a top-level failure gets only its own schema, never the whole args schema (WI-6661)', async () => {
      const result = await dispatch({ to: 'not-an-array', body: 'fine' });

      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('the field(s) that failed, in full:');
      expect(result.error?.message).toContain('`to` accepts');
      expect(result.error?.message).toContain('"type":"array"');
      expect(result.error?.message).not.toContain('full args schema:');
    });

    it('stays BOUNDED — the narrowed hint is far smaller than the dump it replaces', async () => {
      const result = await dispatch({
        to: ['peer'],
        body: [{ text: 'hi', couldNotDetermine: [{}] }],
      });
      const hint = result.error?.message?.split('the field(s) that failed, in full:')[1] ?? '';
      expect(hint.length).toBeGreaterThan(0);
      expect(hint.length).toBeLessThan(1800);
    });

    it('puts a complete accepted example before verbose nested descriptions', async () => {
      const verbose = 'Long field guidance that must come after the compact accepted example. '.repeat(40);
      defineTool({
        name: 'operator:verbose_nested_hint_probe',
        description: 'verbose nested-field schema-hint probe',
        capability: 'operator:scan',
        requirePrincipal: false,
        agentRoles: ['operator'],
        args: z.object({
          checks: z.array(
            z.object({
              claim: z.string().describe(verbose),
              id: z.string().optional().describe(verbose),
              recheck: z.string().optional().describe(verbose),
              verified: z.string().optional().describe(verbose),
            }),
          ),
        }),
        async handler() {
          return { content: [{ type: 'text', text: 'should not run' }] };
        },
      });
      const tool = lookupByMcpName('operator:verbose_nested_hint_probe')!;
      const result = await dispatchProjectedTool(
        tool,
        'operator:verbose_nested_hint_probe',
        { checks: [{ key: 'x', probe: 'y' }] },
        {
          log: () => {},
          signal: new AbortController().signal,
          progress: () => {},
          emit: () => {},
          workspaceId: 'default',
          role: 'operator',
          runId: 'run_T',
        },
        {},
      );

      expect(result.ok).toBe(false);
      const message = result.error?.message ?? '';
      const example =
        'e.g. {"claim":"<string>","id":"<string>","recheck":"<string>","verified":"<string>"}';
      expect(message).toContain(example);
      expect(message).toContain('(required: claim; optional: id, recheck, verified)');
      expect(message.indexOf(example)).toBeLessThan(message.indexOf('verbose schema:'));
    });

    it('does not teach empty arrays for nested fields with minItems', async () => {
      defineTool({
        name: 'operator:min_items_nested_hint_probe',
        description: 'nested minItems schema-hint probe',
        capability: 'operator:scan',
        requirePrincipal: false,
        agentRoles: ['operator'],
        args: z.object({
          coverage: z.object({
            population: z.array(z.string()).min(1),
            checked: z.array(z.string()).optional(),
            residue: z.array(z.string()).min(1),
          }),
        }),
        async handler() {
          return { content: [{ type: 'text', text: 'should not run' }] };
        },
      });
      const tool = lookupByMcpName('operator:min_items_nested_hint_probe')!;
      const result = await dispatchProjectedTool(
        tool,
        'operator:min_items_nested_hint_probe',
        { coverage: { population: 'all', checked: 'all', residue: 'none' } },
        {
          log: () => {},
          signal: new AbortController().signal,
          progress: () => {},
          emit: () => {},
          workspaceId: 'default',
          role: 'operator',
          runId: 'run_T',
        },
        {},
      );

      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain(
        'e.g. {"population":["<string>"],"checked":[],"residue":["<string>"]}',
      );
    });
  });

  it('replaces the whole-schema dump with the failing field schema plus accepted keys (WI-6661)', async () => {
    defineTool({
      name: 'operator:schema_hint_probe',
      description: 'schema-on-invalid-args probe',
      capability: 'operator:scan',
      requirePrincipal: false,
      agentRoles: ['operator'],
      args: z.object({ id: z.string(), body: z.string() }),
      async handler() {
        return { content: [{ type: 'text', text: 'should not run' }] };
      },
    });
    const tool = lookupByMcpName('operator:schema_hint_probe')!;
    const result = await dispatchProjectedTool(
      tool,
      'operator:schema_hint_probe',
      // The 2026-07-11 release-fleet regression shape: right id, wrong sibling field name —
      // the terse per-issue error taught nothing, so the caller repeated the identical mistake.
      { id: 'WI-1', comment: 'wrong field name' },
      {
        log: () => {},
        signal: new AbortController().signal,
        progress: () => {},
        emit: () => {},
        workspaceId: 'default',
        role: 'operator',
        runId: 'run_T',
      },
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('invalid_args:');
    // P-004's one-call correction intent survives without the unreliable blob:
    // `body` is named and typed, while the closed-shape hint lists both valid keys.
    expect(result.error?.message).toContain('the field(s) that failed, in full:');
    expect(result.error?.message).toContain('`body` accepts {"type":"string"}');
    expect(result.error?.message).toContain('this tool accepts ONLY: id, body');
    expect(result.error?.message).toContain('"body"');
    expect(result.error?.message).not.toContain('full args schema:');
  });

  it('keeps a late primitive failure bounded even when unrelated fields have huge descriptions (WI-6661)', async () => {
    defineTool({
      name: 'operator:bounded_field_hint_probe',
      description: 'bounded field-hint probe',
      capability: 'operator:scan',
      requirePrincipal: false,
      agentRoles: ['operator'],
      args: z.object({
        unrelated: z.string().optional().describe('unrelated prose '.repeat(300)),
        claimableLimit: z.number().int().positive().max(100).describe('Maximum claimable items.'),
      }),
      async handler() {
        return { content: [{ type: 'text', text: 'should not run' }] };
      },
    });
    const tool = lookupByMcpName('operator:bounded_field_hint_probe')!;
    const result = await dispatchProjectedTool(
      tool,
      'operator:bounded_field_hint_probe',
      { claimableLimit: 'not-a-number' },
      {
        log: () => {},
        signal: new AbortController().signal,
        progress: () => {},
        emit: () => {},
        workspaceId: 'default',
        role: 'operator',
        runId: 'run_T',
      },
      {},
    );

    expect(result.ok).toBe(false);
    const message = result.error?.message ?? '';
    expect(message).toContain('`claimableLimit` accepts');
    expect(message).toContain('"maximum":100');
    expect(message).not.toContain('unrelated prose');
    expect(message).not.toContain('full args schema:');
    expect(message.length).toBeLessThan(900);
  });

  it('uses only accepted field names when a root-level failure has no field path (WI-6661)', async () => {
    defineTool({
      name: 'operator:pathless_hint_probe',
      description: 'pathless field-hint probe',
      capability: 'operator:scan',
      requirePrincipal: false,
      agentRoles: ['operator'],
      args: z.union([
        z.object({ left: z.string() }),
        z.object({ right: z.number() }),
      ]),
      async handler() {
        return { content: [{ type: 'text', text: 'should not run' }] };
      },
    });
    const tool = lookupByMcpName('operator:pathless_hint_probe')!;
    const result = await dispatchProjectedTool(
      tool,
      'operator:pathless_hint_probe',
      42,
      {
        log: () => {},
        signal: new AbortController().signal,
        progress: () => {},
        emit: () => {},
        workspaceId: 'default',
        role: 'operator',
        runId: 'run_T',
      },
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('accepted args: left, right');
    expect(result.error?.message).not.toContain('full args schema:');
  });

  /**
   * EI-10943 — the schema dump is for SHAPE-blindness, not for a caller who simply
   * overran a cap.
   *
   * The dump above (P-004) earns its keep when the caller does not know the contract:
   * one failure teaches the whole shape. But it was appended to EVERY invalid_args
   * error, including "foundDuring: too long by 3 chars" — 1,800 characters of schema
   * that teach nothing the caller already knew, landing in the context of the agent
   * least able to spare it. Observed live: a one-char overrun on a cosmetic provenance
   * label returned the entire args schema of improvements:capture.
   */
  it('OMITS the schema dump for a pure value-level error, and says how far over the cap it is', async () => {
    defineTool({
      name: 'operator:length_probe',
      description: 'over-length arg probe',
      capability: 'operator:scan',
      requirePrincipal: false,
      agentRoles: ['operator'],
      args: z.object({ id: z.string(), label: z.string().max(10) }),
      async handler() {
        return { content: [{ type: 'text', text: 'should not run' }] };
      },
    });
    const tool = lookupByMcpName('operator:length_probe')!;
    const result = await dispatchProjectedTool(
      tool,
      'operator:length_probe',
      // Right keys, right types — one value is 5 chars over its cap. The caller
      // demonstrably knows the shape.
      { id: 'WI-1', label: 'x'.repeat(15) },
      {
        log: () => {},
        signal: new AbortController().signal,
        progress: () => {},
        emit: () => {},
        workspaceId: 'default',
        role: 'operator',
        runId: 'run_T',
      },
      {},
    );
    expect(result.ok).toBe(false);
    // Actionable in ONE retry: the actual length, the overage, and the target.
    expect(result.error?.message).toContain('label: too long — 15 chars, 5 over the 10-char limit; trim to 10.');
    // …and NOT 1,800 chars of schema the caller did not need.
    expect(result.error?.message).not.toContain('full args schema:');
  });

  it('a mixed value/shape failure still stays field-scoped', async () => {
    defineTool({
      name: 'operator:mixed_probe',
      description: 'mixed-issue probe',
      capability: 'operator:scan',
      requirePrincipal: false,
      agentRoles: ['operator'],
      args: z.object({ id: z.string(), label: z.string().max(10) }),
      async handler() {
        return { content: [{ type: 'text', text: 'should not run' }] };
      },
    });
    const tool = lookupByMcpName('operator:mixed_probe')!;
    const result = await dispatchProjectedTool(
      tool,
      'operator:mixed_probe',
      { id: 'WI-1', label: 'x'.repeat(15), nonsense: 1 },
      {
        log: () => {},
        signal: new AbortController().signal,
        progress: () => {},
        emit: () => {},
        workspaceId: 'default',
        role: 'operator',
        runId: 'run_T',
      },
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('`label` accepts');
    expect(result.error?.message).toContain('"maxLength":10');
    expect(result.error?.message).toContain('this tool accepts ONLY: id, label');
    expect(result.error?.message).not.toContain('full args schema:');
  });

  it('exposes the catalog', () => {
    defineTool({
      name: 'a:one',
      description: 'a',
      capability: 'tasks:read',
      args: z.object({}),
      async handler() {
        return { data: null };
      },
    });
    defineTool({
      name: 'b:two',
      description: 'b',
      capability: 'goals:read',
      args: z.object({}),
      async handler() {
        return { data: null };
      },
    });
    const names = getCatalog().map((t) => t.name).sort();
    expect(names).toEqual(['a:one', 'b:two']);
  });

  it('role-gated tools forward `state` schema to the projection registry', async () => {
    const StateSchema = z.object({
      count: z.number().int().min(0),
      phase: z.enum(['running', 'done']),
    });
    defineTool({
      name: 'operator:state_probe',
      description: 'state-shaped probe',
      capability: 'tasks:read',
      requirePrincipal: false,
      roles: ['operator'],
      state: StateSchema,
      args: z.object({}),
      async handler(_args, ctx) {
        if (!ctx.publishState) {
          return { content: [{ type: 'text', text: 'no_publishState' }], isError: true };
        }
        ctx.publishState({ count: 1, phase: 'done' });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    const tool = lookupByMcpName('operator:state_probe')!;
    expect(tool.state).toBeDefined();
    expect(tool.state).toBe(StateSchema);
    const result = await dispatchProjectedTool(
      tool,
      'operator:state_probe',
      {},
      {
        log: () => {},
        signal: new AbortController().signal,
        progress: () => {},
        emit: () => {},
        workspaceId: 'default',
        role: 'operator',
        runId: 'run_state_probe',
      },
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.result?.content[0]).toEqual({ type: 'text', text: 'ok' });
  });
});

describe('papercuspTierFor', () => {
  it('handles exact matches', () => {
    expect(papercuspTierFor('tasks:read')).toBe('low');
    expect(papercuspTierFor('tasks:write')).toBe('medium');
    expect(papercuspTierFor('audit:read')).toBe('high');
  });
  it('handles wildcards', () => {
    expect(papercuspTierFor('secrets:read:OPENAI_KEY')).toBe('high');
    expect(papercuspTierFor('http:fetch:youtube.com')).toBe('high');
    expect(papercuspTierFor('events:emit:foo')).toBe('medium');
  });
  it('defaults to medium for unknown', () => {
    expect(papercuspTierFor('frob:nicate')).toBe('medium');
  });
});

describe('JSON schema flattening for OpenAI compat', () => {
  beforeEach(() => {
    _resetCatalogForTests();
    _resetProjectionRegistryForTests();
  });

  it('plain z.object schemas pass through with type:object', () => {
    defineTool({
      name: 'test:plain',
      capability: 'test:read',
      args: z.object({ name: z.string() }),
      async handler() { return { data: { ok: true } }; },
    });
    const t = lookupByMcpName('test:plain');
    expect(t).toBeTruthy();
    expect(t!.inputSchema.type).toBe('object');
    expect((t!.inputSchema as Record<string, unknown>).oneOf).toBeUndefined();
    expect((t!.inputSchema as Record<string, unknown>).anyOf).toBeUndefined();
  });

  it('discriminatedUnion flattens to a single object with merged properties', () => {
    defineTool({
      name: 'test:union',
      capability: 'test:read',
      args: z.discriminatedUnion('op', [
        z.object({ op: z.literal('peek') }),
        z.object({ op: z.literal('push'), data: z.string() }),
      ]),
      async handler() { return { data: { ok: true } }; },
    });
    const t = lookupByMcpName('test:union');
    expect(t).toBeTruthy();
    const s = t!.inputSchema as Record<string, unknown>;
    expect(s.type).toBe('object');
    expect(s.oneOf).toBeUndefined();
    expect(s.anyOf).toBeUndefined();
    const props = s.properties as Record<string, unknown>;
    expect(props.op).toBeTruthy();
    expect(props.data).toBeTruthy();
    expect((s.required as string[]).includes('op')).toBe(true);
    expect((s.required as string[] | undefined)?.includes('data') ?? false).toBe(false);
  });

  it('z.union flattens like discriminatedUnion', () => {
    defineTool({
      name: 'test:plain_union',
      capability: 'test:read',
      args: z.union([
        z.object({ kind: z.literal('a'), foo: z.string() }),
        z.object({ kind: z.literal('b'), bar: z.number() }),
      ]),
      async handler() { return { data: { ok: true } }; },
    });
    const t = lookupByMcpName('test:plain_union');
    expect(t).toBeTruthy();
    const s = t!.inputSchema as Record<string, unknown>;
    expect(s.type).toBe('object');
    expect(s.oneOf).toBeUndefined();
    expect(s.anyOf).toBeUndefined();
    const props = s.properties as Record<string, unknown>;
    expect(props.foo).toBeTruthy();
    expect(props.bar).toBeTruthy();
  });

  // Phase 4 T3.1 — E2E bug #36 regression. The role-gated defineTool path
  // was silently dropping the `modality` field between input and the
  // projection registry, so voice users got an empty tool catalog.
  // Lock the pipeline so future field additions get tested at the seam,
  // not just by the downstream filter mock.
  it('forwards modality from defineTool to the projected tool', () => {
    defineTool({
      name: 'test:voice_only',
      description: 'voice surface only',
      capability: 'test:read',
      requirePrincipal: false,
      roles: ['operator'],
      modality: ['voice'],
      args: z.object({}),
      async handler() { return { content: [{ type: 'text', text: 'ok' }] }; },
    });
    defineTool({
      name: 'test:both_surfaces',
      description: 'visible on both surfaces',
      capability: 'test:read',
      requirePrincipal: false,
      roles: ['operator'],
      modality: ['text', 'voice'],
      args: z.object({}),
      async handler() { return { content: [{ type: 'text', text: 'ok' }] }; },
    });
    defineTool({
      name: 'test:no_modality_declared',
      description: 'absent modality — defaults to both at the filter layer',
      capability: 'test:read',
      requirePrincipal: false,
      agentRoles: ['operator'],
      args: z.object({}),
      async handler() { return { content: [{ type: 'text', text: 'ok' }] }; },
    });
    const voiceTool = lookupByMcpName('test:voice_only');
    const bothTool = lookupByMcpName('test:both_surfaces');
    const absentTool = lookupByMcpName('test:no_modality_declared');
    expect(voiceTool?.modality).toEqual(['voice']);
    expect(bothTool?.modality).toEqual(['text', 'voice']);
    // Absent on the projection — the catalog layer applies the
    // ['text','voice'] default when reading.
    expect(absentTool?.modality).toBeUndefined();
  });
});
