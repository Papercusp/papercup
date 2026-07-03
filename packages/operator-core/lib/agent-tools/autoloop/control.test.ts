import { describe, expect, it } from 'vitest';
import { resetErrorScopes } from './control';

/**
 * resetErrorScopes — the reset-errors scope resolver (EI-6753).
 *
 * The chronic-failure watchdog files a bug per red autoloop_state row and
 * prescribes "then autoloop:control reset-errors" as the remediation. But
 * `loop:arm` loops (the `loop-su-` and `loop-role-` roles) record their fire-gate
 * under install_slug='*' — which the per-harness brain scopes ([workspaceId, slug])
 * NEVER include — so before this fix a role-scoped reset silently no-op'd on the
 * exact class of loops that triggers the escalation (loop-su-<uuid>@*). A role-scoped
 * reset must therefore also clear the '*' scope; a role-LESS reset must NOT (so a
 * per-harness reset can't wipe every warm-session loop's counter across the ws).
 */
describe('resetErrorScopes', () => {
  const brain = ['papercusp-workspace', 'papercusp'];

  it("EI-6753: a ROLE-scoped reset includes the '*' (loop:arm) scope so a loop-su-*@* row is reachable", () => {
    const scopes = resetErrorScopes(brain, 'loop-su-30633068-a395-4c76-a1d7-7bc5c3c3095d');
    expect(scopes).toContain('*');
    expect(scopes).toEqual(['papercusp-workspace', 'papercusp', '*']);
  });

  it("a role-LESS reset stays per-harness — it NEVER adds '*' (so it can't wipe every warm-session loop)", () => {
    const scopes = resetErrorScopes(brain, undefined);
    expect(scopes).not.toContain('*');
    expect(scopes).toEqual(['papercusp-workspace', 'papercusp']);
  });

  it("dedupes '*' when a brain scope already is '*' (a workspace whose slug resolved to '*')", () => {
    expect(resetErrorScopes(['*'], 'loop-su-x')).toEqual(['*']);
    expect(resetErrorScopes(['ws', '*'], 'loop-su-x')).toEqual(['ws', '*']);
  });

  it('a single brain scope (coordination-off) still gains the loop:arm scope when role-scoped', () => {
    expect(resetErrorScopes(['papercusp'], 'loop-role-abc')).toEqual(['papercusp', '*']);
    expect(resetErrorScopes(['papercusp'], undefined)).toEqual(['papercusp']);
  });

  it('preserves brain-scope order and is idempotent (deduped, order-stable)', () => {
    const scopes = resetErrorScopes(['a', 'b'], 'loop-su-x');
    expect(scopes).toEqual(['a', 'b', '*']);
  });
});
