/**
 * tool-auth-gating.test.ts — the missing-bearer/workspace-auth failure class.
 *
 * ~56 of the recorded failures (harness_shared.tool_invocations, 2026-05-31)
 * were `requires authenticated request (bearer + workspace tx)` /
 * `lacks capability …` — principal-gated built-ins invoked without a principal.
 * (The role-scoped synthesis half is fixed in _mcp-handler.ts; the dedicated
 * handler-path test for that wiring — via __buildMcpToolContext_forTests — is
 * still owed and tracked separately.)
 *
 * This guards the GATE itself + closes the surface-vs-registry gap that
 * tools-md-sync only checks by name.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../agent-tools/index';
import { lookupByMcpName, getCatalog } from '@papercusp/tooldef';

// A tool is invokable if it's in EITHER registry: the projection registry
// (lookupByMcpName, ~217) or the bearer-dispatch built-in catalog (getCatalog,
// ~28). hindsight:recall, for example, is a built-in present in the catalog.
const catalogNames = new Set(getCatalog().map((t) => t.name));
const isInvokable = (name: string) => Boolean(lookupByMcpName(name)) || catalogNames.has(name);

const __dirname = dirname(fileURLToPath(import.meta.url));
type ProjFn = { fn: (a: unknown, c: unknown) => Promise<unknown> };

describe('auth gating (missing bearer/workspace class)', () => {
  it('principal-gated built-ins reject calls with no principal/tx', async () => {
    // These are LEGACY-projected built-ins (registerLegacyAsProjected): the
    // projected wrapper itself rejects when principal/tx is absent. Tools
    // defined via the new `defineTool` (e.g. papercusp:list_workspaces,
    // capability workspaces:read) go through registerRoleGatedAsProjected,
    // which by design does NOT self-gate on principal — gating is the
    // dispatcher's role+capability+quota check (define-tool.ts §"role-gated").
    // That dispatcher-path gating is covered separately (see file header), so
    // role-gated tools don't belong in this principal+tx assertion.
    // NOTE: issues:list is intentionally NOT here — it's a role-gated defineTool
    // (requirePrincipal:false, capability coord:read), so the projected wrapper
    // does NOT self-gate on principal+tx. Its unauthenticated-rejection is via
    // the handler's resolveAgentIdentity gate, covered in the next test.
    const names = ['features:get', 'features:history', 'audit:list', 'harness:list'];
    for (const name of names) {
      const t = lookupByMcpName(name) as ProjFn | undefined;
      expect(t, `${name} present in registry`).toBeTruthy();
      // The projected wrapper checks principal+tx BEFORE validating args, so an
      // empty ctx surfaces the auth error (not invalid_args) and never runs the
      // handler — safe to call.
      await expect(t!.fn({}, {})).rejects.toThrow(/requires authenticated request/);
    }
  });

  it('role-gated coordination tools reject an unauthenticated (empty-ctx) call via the identity gate', async () => {
    // issues:list (engineer-issues D-003) is role-gated, not principal-gated: its
    // handler resolves the caller's coordination identity first, which throws when
    // the ctx carries no power-user/superuser/principal. Guards that the
    // requirePrincipal:false path still can't be invoked anonymously.
    for (const name of ['issues:list']) {
      const t = lookupByMcpName(name) as ProjFn | undefined;
      expect(t, `${name} present in registry`).toBeTruthy();
      await expect(t!.fn({}, {})).rejects.toThrow(/identity|authenticated|principal|capability/i);
    }
  });

  it('every operator-converse allowedTool resolves in the core registry (invokable, not just named)', () => {
    // Plugin-provided tools are loaded per-workspace, NOT in the static
    // `@/lib/agent-tools/index` catalog — the orchestrator-spawn family
    // (@papercupai/orchestrator-spawn) is exposed to the converse surface but
    // lives in a plugin (see operator-mcp-tools.ts §"Spawn primitive"). Exclude
    // that documented family; everything else must resolve.
    const PLUGIN_PROVIDED = new Set([
      'orchestrator_spawn', 'orchestrator_poll', 'orchestrator_list_active', 'orchestrator_cancel',
    ]);
    const src = readFileSync(join(__dirname, '..', 'operator-mcp-tools.ts'), 'utf8');
    const names = [...new Set([...src.matchAll(/mcp__agentmcp__([a-zA-Z0-9_:.]+)/g)].map((m) => m[1]))]
      .filter((n) => !PLUGIN_PROVIDED.has(n));
    expect(names.length).toBeGreaterThan(10);
    const missing = names.filter((n) => !isInvokable(n));
    expect(missing, `allowedTools with no registry entry: ${missing.join(', ')}`).toEqual([]);
  });
});
