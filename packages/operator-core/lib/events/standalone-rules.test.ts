/**
 * Standalone reaction rules (identities-v1-2026-08-30 P-028, D-011 / D-054 §7b).
 *
 * Two properties are worth more than the rest here:
 *
 *   1. A standalone rule lands in the SAME `registerReactionRule` engine every
 *      built-in and plugin rule uses. P-028 forbids a second engine and a second
 *      condition language, and the cheapest way for one to appear is for someone
 *      to give standalone rules their own registry "just for now" — so these
 *      tests assert through `listReactionRules()`, the shared one.
 *   2. The registered rule's `capability` comes from the CLASS verb, not from any
 *      tool (D-054 §4).
 *
 * Only the class-registry STORE is mocked; `validateClassFireTarget` and the
 * registry itself are real, so this covers the actual registration seam rather
 * than a restatement of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCapabilityClass = vi.fn();

vi.mock('../capability-class-registry-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../capability-class-registry-store')>();
  return {
    ...actual,
    getCapabilityClass: (...args: unknown[]) => getCapabilityClass(...args),
  };
});

const { listReactionRules, registerReactionRule, _resetReactionsForTests } = await import('./registry');
const { registerStandaloneReactionRule, unregisterStandaloneReactionRules, STANDALONE_RULE_SOURCE } =
  await import('./standalone-rules');

const sql = { __fake: 'sql' } as never;
const WS = 'ws-test';
const FIRE = 'class:text.embed@1.0.0#embed';

/**
 * `capability: null` means the verb declares NONE. Deliberately not `undefined`:
 * a default parameter treats `undefined` as "not passed", so the no-capability
 * case would silently get the default and the refusal test would pass a class
 * that does declare one.
 */
function classDeclaringEmbed(capability: string | null = 'memory.embed') {
  return {
    interfaceVerbs: {
      embed: capability === null ? { inputSchema: {} } : { inputSchema: {}, capability },
    },
  };
}

beforeEach(() => {
  _resetReactionsForTests();
  getCapabilityClass.mockReset();
  getCapabilityClass.mockResolvedValue(classDeclaringEmbed());
});

afterEach(() => {
  _resetReactionsForTests();
});

describe('registerStandaloneReactionRule', () => {
  it('registers into the SHARED reaction registry under standalone:<id>', async () => {
    const result = await registerStandaloneReactionRule(sql, WS, {
      id: 'notify-on-handoff',
      on: 'coord:handoff',
      fire: FIRE,
    });

    expect(result).toMatchObject({
      ok: true,
      ruleId: `${STANDALONE_RULE_SOURCE}:notify-on-handoff`,
      classRef: 'text.embed@1.0.0',
      verb: 'embed',
      capability: 'memory.embed',
    });

    // Asserted through the SHARED registry — a second private registry would
    // leave this empty while the call above still reported ok.
    const registered = listReactionRules().find((r) => r.id === 'standalone:notify-on-handoff');
    expect(registered).toBeDefined();
    expect(registered?.on).toBe('coord:handoff');
    expect(registered?.fire).toBe(FIRE);
    expect(registered?.source).toBe('standalone:notify-on-handoff');
  });

  it('sandboxes the rule to the CLASS capability (D-054 §4)', async () => {
    getCapabilityClass.mockResolvedValue(classDeclaringEmbed('memory.embed'));

    await registerStandaloneReactionRule(sql, WS, { id: 'r1', on: 'coord:handoff', fire: FIRE });

    const registered = listReactionRules().find((r) => r.id === 'standalone:r1');
    expect((registered as { capability?: string } | undefined)?.capability).toBe('memory.embed');
  });

  it('does NOT register when the class verb declares no capability', async () => {
    getCapabilityClass.mockResolvedValue(classDeclaringEmbed(null));

    const result = await registerStandaloneReactionRule(sql, WS, {
      id: 'r1',
      on: 'coord:handoff',
      fire: FIRE,
    });

    expect(result.ok).toBe(false);
    // The refusal must be total: a rule that registered anyway would run
    // unsandboxed while the caller believed it had been rejected.
    expect(listReactionRules().some((r) => r.id === 'standalone:r1')).toBe(false);
  });

  it('refuses a fire target that names a tool instead of a class verb', async () => {
    const result = await registerStandaloneReactionRule(sql, WS, {
      id: 'r1',
      on: 'coord:handoff',
      fire: 'coord:send',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('standalone rule "r1"');
    expect(listReactionRules()).toHaveLength(0);
  });

  it.each([
    ['blank id', { id: '   ', on: 'coord:handoff', fire: FIRE }],
    ['blank on', { id: 'r1', on: '  ', fire: FIRE }],
    // P-011 / D-023: a sync rule runs inline at a hook sink and is never a reaction.
    ['sync delivery', { id: 'r1', on: 'coord:handoff', fire: FIRE, delivery: 'sync' as never }],
  ])('refuses %s without touching the class registry', async (_label, input) => {
    const result = await registerStandaloneReactionRule(sql, WS, input);

    expect(result.ok).toBe(false);
    expect(getCapabilityClass).not.toHaveBeenCalled();
    expect(listReactionRules()).toHaveLength(0);
  });

  it('passes `when` through unchanged — no second condition language', async () => {
    // P-028: `@papercusp/rules` dataConditionSchema is the ONE language. If a
    // standalone-specific dialect were introduced, `when` would stop arriving
    // byte-identical here.
    const when = { 'args.kind': { eq: 'handoff' } };

    await registerStandaloneReactionRule(sql, WS, {
      id: 'r1',
      on: 'coord:handoff',
      when,
      fire: FIRE,
      args: { note: 'hi' },
      onlyOnSuccess: true,
    });

    const registered = listReactionRules().find((r) => r.id === 'standalone:r1') as
      | { when?: unknown; args?: unknown; onlyOnSuccess?: boolean }
      | undefined;
    expect(registered?.when).toEqual(when);
    expect(registered?.args).toEqual({ note: 'hi' });
    expect(registered?.onlyOnSuccess).toBe(true);
  });

  it('omits `when` entirely when none is given, so the rule matches every event', async () => {
    await registerStandaloneReactionRule(sql, WS, { id: 'r1', on: 'coord:handoff', fire: FIRE });

    const registered = listReactionRules().find((r) => r.id === 'standalone:r1') as
      | { when?: unknown }
      | undefined;
    expect(registered && 'when' in registered).toBe(false);
  });
});

describe('unregisterStandaloneReactionRules', () => {
  it('removes every standalone rule and reports the count', async () => {
    await registerStandaloneReactionRule(sql, WS, { id: 'a', on: 'coord:handoff', fire: FIRE });
    await registerStandaloneReactionRule(sql, WS, { id: 'b', on: 'coord:send', fire: FIRE });

    expect(unregisterStandaloneReactionRules()).toBe(2);
    expect(listReactionRules()).toHaveLength(0);
  });

  it('leaves built-in and plugin rules alone', async () => {
    // The uninstall path is a full re-sync; scoping it by source is what keeps it
    // from taking the rest of the registry with it.
    registerReactionRule({
      id: 'builtin:x',
      on: 'coord:handoff',
      fire: 'coord:send',
      args: {},
      source: 'builtin',
    } as never);
    registerReactionRule({
      id: 'plugin:vendor:y',
      on: 'coord:handoff',
      fire: 'vendor:tool',
      args: {},
      source: 'plugin:vendor',
    } as never);
    await registerStandaloneReactionRule(sql, WS, { id: 'a', on: 'coord:handoff', fire: FIRE });

    expect(unregisterStandaloneReactionRules()).toBe(1);

    const remaining = listReactionRules().map((r) => r.id).sort();
    expect(remaining).toEqual(['builtin:x', 'plugin:vendor:y']);
  });

  it('is a no-op returning 0 when no standalone rules are registered', () => {
    expect(unregisterStandaloneReactionRules()).toBe(0);
  });
});
