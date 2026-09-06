/**
 * acquire-arg-redirect.test.ts — EI-21988514956470475.
 *
 * `locks:acquire` has no `mode`: file locks are ALWAYS exclusive-per-path (see
 * internal-docs/agent-spawning/named-resource-locks), so there is nothing for a
 * mode to select. Before this fix a caller passing `mode: 'exclusive'` got a bare
 * Zod unrecognized-key rejection listing the accepted keys, whose honest reading
 * is "exclusivity is not selectable here" — and the filed item called `mode`
 * "documented" even though NO doc pairs it with locks:acquire. The shape is
 * borrowed from locks:acquire_resource, whose `mode: 'exclusive'` appears
 * verbatim in CLAUDE.md's mutation-probe recipe.
 *
 * Same failure family as `coordination_domain` (EI-21104703429792156) on this
 * same tool: the rejection named what was refused but not the remedy. `seeAlso`
 * already lists both sibling tools, but it is a guidance surface — the caller who
 * needs it is on the FAILURE path, which only `argRedirects` reaches.
 *
 * Pins both redirects so a future edit cannot drop them silently. The RENDERING of
 * argRedirects into the rejection message is covered generically by tooldef's
 * strict-args.test.ts ("unknownArgHint argRedirects"); this pins THIS tool's
 * declarations, matching coordination/tools/inbox-q-arg-redirect.test.ts.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/acquire-arg-redirect.test.ts
 */
import { describe, it, expect } from 'vitest';
import { splitLocalSchemaTarget } from '@papercusp/tooldef';
import acquireTool from './acquire';

describe('locks:acquire guidance.argRedirects', () => {
  it('tells a caller passing `mode` to DROP the key, because file locks are always exclusive', () => {
    const redirect = acquireTool.guidance?.argRedirects?.mode;

    // An explicit drop remedy, not a corrective call: there is no replacement
    // destination because file locks are always exclusive.
    expect(typeof redirect).toBe('object');
    expect(redirect).toMatchObject({ drop: true });
    const note = (redirect as { note?: string }).note ?? '';

    // The load-bearing correction: exclusivity is not missing, it is unconditional.
    expect(note).toMatch(/always exclusive/i);
    expect(note).toMatch(/drop the key/i);

    // And where `mode` genuinely does live, so the caller who actually wanted one of
    // those is not left inferring the capability is absent.
    expect(note).toContain('locks:acquire_resource');
    expect(note).toContain('locks:acquire_granular');
  });

  it('redirects a rejected `resource` key to locks:acquire_resource', () => {
    const redirect = acquireTool.guidance?.argRedirects?.resource;
    expect(redirect).toMatchObject({
      tool: 'locks:acquire_resource',
      args: { resource: '<registered resource>', mode: 'exclusive', reason: '<why>' },
    });

    // The note must carry the PREREQUISITE the tool name alone does not: a named
    // resource is not free-form, so a caller who just retries with the sibling tool
    // and an invented name hits a second rejection.
    const note = (redirect as { note?: string }).note ?? '';
    expect(note).toContain('locks:register_resource');
    expect(note).toMatch(/paths/i);
  });

  it('does NOT accept `mode` as a real arg — the redirect must stay a redirect', () => {
    // Guards the failure mode where someone "fixes" the rejection by adding the key
    // to the schema, which would silently invent a mode file locks cannot honour.
    const parsed = acquireTool.args.safeParse({
      paths: ['packages/operator-core/lib/agent-tools/locks/acquire.ts'],
      intent: 'probe',
      mode: 'exclusive',
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * EI-22380017954531073 — `ttlSec` rejected; the schema spells it `ttl_sec`.
 *
 * Kept a REDIRECT rather than an accepted alias: this tool's args are snake_case
 * throughout (ttl_sec, external_paths, wake_on_grant, pending_edit,
 * coordination_domain), so accepting one camelCase spelling would leave the other four
 * just as surprising while adding exactly the undeclared-arg surface the strict-args
 * rail exists to prevent.
 *
 * Pins the D-004 RENDER contract, not merely the redirect's presence: a target that
 * fails `splitLocalSchemaTarget` still renders, but as "`ttlSec` is not an arg of this
 * tool — it is written by <the whole sentence>", which tells a caller who used the
 * wrong key on the RIGHT tool that some other tool owns their data.
 */
describe('locks:acquire guidance.argRedirects.ttlSec (EI-22380017954531073)', () => {
  /** `.refine()`/`.superRefine()` wrap a ZodObject in ZodEffects, so `.shape` can be one
   *  or more `_def` hops down. Walk rather than assume today's depth. */
  function argKeys(schema: unknown): string[] {
    let node: unknown = schema;
    for (let hop = 0; hop < 8 && node; hop += 1) {
      const shape = (node as { shape?: Record<string, unknown> }).shape;
      if (shape && typeof shape === 'object') return Object.keys(shape);
      const def = (node as { _def?: { schema?: unknown; innerType?: unknown } })._def;
      node = def?.schema ?? def?.innerType;
    }
    throw new Error("could not read an object shape from locks:acquire's args schema");
  }

  const declared = argKeys(acquireTool.args);

  it('declares ttl_sec and NOT ttlSec, so the redirect stays a redirect', () => {
    expect(declared).toContain('ttl_sec');
    expect(declared).not.toContain('ttlSec');
    expect(
      acquireTool.args.safeParse({ paths: ['a.ts'], intent: 'probe', ttlSec: 600 }).success,
    ).toBe(false);
  });

  it('renders as a SAME-TOOL relocation to ttl_sec, not a cross-tool misattribution (D-004)', () => {
    const target = acquireTool.guidance?.argRedirects?.ttlSec;
    expect(typeof target).toBe('string');

    const split = splitLocalSchemaTarget(target as string, declared);
    // A null split IS the D-004 defect: the caller is already on the right tool and
    // would be sent somewhere that cannot help them.
    expect(split, 'ttlSec redirect must be authored as `ttl_sec — explanation`').not.toBeNull();
    expect(split?.path).toBe('ttl_sec');
  });

  it('says to RENAME, and that dropping the key silently takes the default TTL', () => {
    const split = splitLocalSchemaTarget(
      acquireTool.guidance?.argRedirects?.ttlSec as string,
      declared,
    );
    // The load-bearing half. "Unrecognized key" reads as "this tool has no TTL", whose
    // honest remedy is to drop it — and dropping it SUCCEEDS, with the wrong lifetime,
    // so the caller never learns they were refused anything.
    expect(split?.note).toMatch(/rename/i);
    expect(split?.note).toMatch(/default TTL/i);
  });
});
