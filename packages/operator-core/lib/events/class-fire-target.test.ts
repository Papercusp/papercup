/**
 * Class-fired reaction targets (identities-v1-2026-08-30 P-028, D-011 / D-054).
 *
 * The invariant these tests exist to protect is D-054 §4: a class-fired rule is
 * sandboxed to the CLASS's declared capability, NEVER to the capability of
 * whatever tool the pot's provider happens to resolve to. The fired tool is
 * provider-dependent, so sourcing the sandbox from it would let INSTALLING A
 * DIFFERENT PROVIDER silently widen what an already-installed rule may do. The
 * `refuses a verb that declares no capability` case below is the one that would
 * fail if someone "helpfully" added a fallback.
 *
 * Only `getCapabilityClass` / `getPotCapabilityProviderBinding` are mocked — the
 * ref parsing/normalizing helpers are the real ones, so a change to class-ref
 * syntax surfaces here rather than being papered over by a fake.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCapabilityClass = vi.fn();
const getPotCapabilityProviderBinding = vi.fn();

vi.mock('../capability-class-registry-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../capability-class-registry-store')>();
  return {
    ...actual,
    getCapabilityClass: (...args: unknown[]) => getCapabilityClass(...args),
    getPotCapabilityProviderBinding: (...args: unknown[]) => getPotCapabilityProviderBinding(...args),
  };
});

const {
  CLASS_FIRE_SCHEME,
  classFireTarget,
  isClassFireTarget,
  parseClassFireTarget,
  resolveClassFireTarget,
  validateClassFireTarget,
} = await import('./class-fire-target');

// The mocked store never touches it; a marker object proves it is passed through.
const sql = { __fake: 'sql' } as never;
const WS = 'ws-test';

beforeEach(() => {
  getCapabilityClass.mockReset();
  getPotCapabilityProviderBinding.mockReset();
});

describe('parseClassFireTarget', () => {
  it('parses class:<id>@<version>#<verb>', () => {
    expect(parseClassFireTarget('class:text.embed@1.0.0#embed')).toEqual({
      classRef: 'text.embed@1.0.0',
      classId: 'text.embed',
      classVersion: '1.0.0',
      verb: 'embed',
    });
  });

  it('returns null for an ordinary tool name so callers can branch on it', () => {
    // The dispatch path branches on this rather than throwing — a plugin rule's
    // ordinary `fire` must fall through to the existing tool machinery.
    expect(parseClassFireTarget('coord:handoff')).toBeNull();
    expect(isClassFireTarget('coord:handoff')).toBe(false);
    expect(isClassFireTarget('class:text.embed@1.0.0#embed')).toBe(true);
  });

  it.each([
    ['no verb', 'class:text.embed@1.0.0'],
    ['empty verb after #', 'class:text.embed@1.0.0#'],
    ['no version', 'class:text.embed#embed'],
    ['empty body', 'class:'],
    ['leading # with no ref', 'class:#embed'],
  ])('returns null for a malformed target (%s)', (_label, fire) => {
    expect(parseClassFireTarget(fire)).toBeNull();
  });

  it('round-trips through classFireTarget', () => {
    const fire = classFireTarget('text.embed@1.0.0', 'embed');
    expect(fire).toBe(`${CLASS_FIRE_SCHEME}text.embed@1.0.0#embed`);
    expect(parseClassFireTarget(fire)?.verb).toBe('embed');
  });
});

describe('validateClassFireTarget (registration time)', () => {
  it('accepts a declared verb and returns the CLASS capability', async () => {
    getCapabilityClass.mockResolvedValue({
      interfaceVerbs: { embed: { inputSchema: {}, capability: 'memory.embed' } },
    });

    const result = await validateClassFireTarget(sql, WS, 'class:text.embed@1.0.0#embed');

    expect(result).toEqual({
      ok: true,
      target: {
        classRef: 'text.embed@1.0.0',
        classId: 'text.embed',
        classVersion: '1.0.0',
        verb: 'embed',
      },
      capability: 'memory.embed',
    });
  });

  it('never consults a pot binding — the verdict must hold in every pot', async () => {
    // This is what makes a rule portable (D-004): registration is pot-independent
    // by construction, so a rule cannot be accepted in one pot and refused in
    // another, and cannot bake in the authoring pot's provider.
    getCapabilityClass.mockResolvedValue({
      interfaceVerbs: { embed: { inputSchema: {}, capability: 'memory.embed' } },
    });

    await validateClassFireTarget(sql, WS, 'class:text.embed@1.0.0#embed');

    expect(getPotCapabilityProviderBinding).not.toHaveBeenCalled();
  });

  it('refuses a fire target that is not a class verb', async () => {
    const result = await validateClassFireTarget(sql, WS, 'coord:handoff');
    expect(result.ok).toBe(false);
    expect(getCapabilityClass).not.toHaveBeenCalled();
    if (!result.ok) expect(result.error).toContain('class:<id>@<version>#<verb>');
  });

  it('refuses a class that is not defined in this workspace', async () => {
    getCapabilityClass.mockResolvedValue(null);
    const result = await validateClassFireTarget(sql, WS, 'class:text.embed@1.0.0#embed');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not defined in this workspace');
  });

  it('refuses an undeclared verb and names the verbs the class does declare', async () => {
    getCapabilityClass.mockResolvedValue({
      interfaceVerbs: {
        embed: { inputSchema: {}, capability: 'memory.embed' },
        rerank: { inputSchema: {}, capability: 'memory.rerank' },
      },
    });

    const result = await validateClassFireTarget(sql, WS, 'class:text.embed@1.0.0#summarize');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('does not declare verb "summarize"');
      expect(result.error).toContain('embed, rerank');
    }
  });

  it('REFUSES a verb that declares no capability rather than falling back (D-054 §4)', async () => {
    // THE load-bearing case. A fallback to the resolved provider tool's own
    // capability would typecheck, pass every other test here, and only be wrong
    // later — in someone else's pot, after they bind a wider provider.
    getCapabilityClass.mockResolvedValue({
      interfaceVerbs: { embed: { inputSchema: {} } },
    });

    const result = await validateClassFireTarget(sql, WS, 'class:text.embed@1.0.0#embed');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('declares no `capability`');
  });

  it('treats a blank capability string as declaring none', async () => {
    getCapabilityClass.mockResolvedValue({
      interfaceVerbs: { embed: { inputSchema: {}, capability: '   ' } },
    });
    const result = await validateClassFireTarget(sql, WS, 'class:text.embed@1.0.0#embed');
    expect(result.ok).toBe(false);
  });
});

describe('resolveClassFireTarget (fire time)', () => {
  it("resolves the verb through the firing pot's own provider binding", async () => {
    getPotCapabilityProviderBinding.mockResolvedValue({
      providerPackage: '@vendor/embedder',
      providerVersion: '2.1.0',
      verbBindings: { embed: 'vendor:embed_text' },
    });

    const result = await resolveClassFireTarget(sql, {
      workspaceId: WS,
      potSlug: 'pot-a',
      fire: 'class:text.embed@1.0.0#embed',
    });

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.tool).toBe('vendor:embed_text');
      expect(result.providerPackage).toBe('@vendor/embedder');
    }
  });

  it('resolves ONE rule to different tools in different pots (D-004)', async () => {
    // The whole point of firing a class rather than a tool id: the same listing,
    // installed in two pots, runs each pot's own bound provider.
    getPotCapabilityProviderBinding
      .mockResolvedValueOnce({
        providerPackage: '@vendor/a',
        providerVersion: '1.0.0',
        verbBindings: { embed: 'vendor_a:embed' },
      })
      .mockResolvedValueOnce({
        providerPackage: '@vendor/b',
        providerVersion: '3.0.0',
        verbBindings: { embed: 'vendor_b:make_vector' },
      });

    const fire = 'class:text.embed@1.0.0#embed';
    const a = await resolveClassFireTarget(sql, { workspaceId: WS, potSlug: 'pot-a', fire });
    const b = await resolveClassFireTarget(sql, { workspaceId: WS, potSlug: 'pot-b', fire });

    expect(a.status === 'resolved' && a.tool).toBe('vendor_a:embed');
    expect(b.status === 'resolved' && b.tool).toBe('vendor_b:make_vector');
  });

  it('reports `unbound` — not silence — when the pot has no provider bound', async () => {
    // Deliberately loud: a quietly non-firing rule is how reconcile-rule.ts sat
    // dead for weeks (EI-5925 / EI-6960). The caller surfaces this as a failed
    // reaction naming the class, the pot and the remedy.
    getPotCapabilityProviderBinding.mockResolvedValue(null);

    const result = await resolveClassFireTarget(sql, {
      workspaceId: WS,
      potSlug: 'pot-a',
      fire: 'class:text.embed@1.0.0#embed',
    });

    expect(result.status).toBe('unbound');
    if (result.status === 'unbound') {
      expect(result.error).toContain('pot "pot-a"');
      expect(result.error).toContain('capability_classes:bind_provider');
    }
  });

  it('reports `unbound` when a provider is bound but binds no tool for the verb', async () => {
    getPotCapabilityProviderBinding.mockResolvedValue({
      providerPackage: '@vendor/embedder',
      providerVersion: '2.1.0',
      verbBindings: { rerank: 'vendor:rerank' },
    });

    const result = await resolveClassFireTarget(sql, {
      workspaceId: WS,
      potSlug: 'pot-a',
      fire: 'class:text.embed@1.0.0#embed',
    });

    expect(result.status).toBe('unbound');
    if (result.status === 'unbound') {
      expect(result.error).toContain('binds no tool for verb "embed"');
      expect(result.error).toContain('rerank');
    }
  });

  it('distinguishes `invalid` (malformed target) from `unbound` (real misconfiguration)', async () => {
    const result = await resolveClassFireTarget(sql, {
      workspaceId: WS,
      potSlug: 'pot-a',
      fire: 'coord:handoff',
    });

    expect(result.status).toBe('invalid');
    expect(getPotCapabilityProviderBinding).not.toHaveBeenCalled();
  });
});
