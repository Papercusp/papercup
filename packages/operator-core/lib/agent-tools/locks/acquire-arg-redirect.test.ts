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
import acquireTool from './acquire';

describe('locks:acquire guidance.argRedirects', () => {
  it('tells a caller passing `mode` to DROP the key, because file locks are always exclusive', () => {
    const redirect = acquireTool.guidance?.argRedirects?.mode;

    // A plain string, not a corrective call: the remedy is to omit the key, not to
    // switch tools — the caller already chose the right one.
    expect(typeof redirect).toBe('string');
    const note = redirect as string;

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
