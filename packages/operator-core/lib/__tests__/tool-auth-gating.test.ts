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
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../agent-tools/index';
import { lookupByMcpName, getCatalog } from '@papercusp/tooldef';

// A tool is invokable if it's in EITHER registry: the projection registry
// (lookupByMcpName, ~217) or the bearer-dispatch built-in catalog (getCatalog,
// ~28). search:query, for example, is a built-in present in the catalog.
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
      // empty ctx surfaces the gating error (not invalid_args) and never runs the
      // handler — safe to call. (Message reworded by EI-30: a missing principal/tx
      // is almost always a workspace-SCOPING gap, not an auth failure.)
      await expect(t!.fn({}, {})).rejects.toThrow(/requires a workspace-scoped call/);
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
    // As of Brief 4 (agent-briefs-2026-06-05) the spawn surface is the BUILT-IN
    // fleet:spawn/tree/cancel (over the durable nursery), replacing the dead
    // @papercupai/orchestrator-spawn plugin family that was never installed (every
    // orchestrator_* call returned "tool not found"). So there are no longer any
    // plugin-provided allowedTools to exclude — EVERY entry must resolve.
    const src = readFileSync(join(__dirname, '..', 'operator-mcp-tools.ts'), 'utf8');
    const names = [...new Set([...src.matchAll(/mcp__agentmcp__([a-zA-Z0-9_:.-]+)/g)].map((m) => m[1]))];
    expect(names.length).toBeGreaterThan(10);
    const missing = names.filter((n) => !isInvokable(n));
    expect(missing, `allowedTools with no registry entry: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('operator-config write-role gate (EI-2204)', () => {
  // The operator-config-mutating tools (rate_limit_config, preferences, reset-overrides,
  // migrate-policy, set-watchdog-tunables, routines:set) advertise [...SU_ROLES] for INVOKE
  // but narrow their mutating op to operator-level authority. That gate MUST go through the
  // shared `isOperatorConfigWriteRole` predicate (which includes the operator-equivalent
  // `queen`, local-hive D-001) — not a hand-rolled `ctx.role !== 'operator' && ctx.role !==
  // 'architect'` literal, which silently excluded the Queen and blocked the clean path to
  // reset a jammed concurrency ceiling (EI-2204 / EI-2186).
  const agentToolsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent-tools');

  function walkTs(dir: string): string[] {
    const out: string[] = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
        out.push(...walkTs(full));
      } else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  // Catches the anti-pattern in either ordering, with arbitrary whitespace/newlines.
  const BANNED = /ctx\.role\s*!==\s*'(operator|architect)'\s*&&\s*ctx\.role\s*!==\s*'(operator|architect)'/;

  it('no agent-tool hand-rolls the operator/architect write-gate (must use isOperatorConfigWriteRole)', () => {
    const offenders = walkTs(agentToolsDir)
      .filter((f) => BANNED.test(readFileSync(f, 'utf8')))
      .map((f) => relative(agentToolsDir, f));
    expect(
      offenders,
      `These tools re-introduced the hand-rolled operator/architect role-gate (excludes the ` +
        `operator-equivalent queen, EI-2204). Gate via isOperatorConfigWriteRole(ctx.role) instead: ` +
        offenders.join(', '),
    ).toEqual([]);
  });

  it('every known operator-config-write tool imports the shared predicate', () => {
    const tools = [
      'operator/rate_limit_config.ts',
      'operator/preferences.ts',
      'config/reset-overrides.ts',
      'db/migrate-policy.ts',
      'improvements/set-watchdog-tunables.ts',
      'routines/set.ts',
    ];
    for (const rel of tools) {
      const src = readFileSync(join(agentToolsDir, rel), 'utf8');
      expect(src, `${rel} must import isOperatorConfigWriteRole`).toMatch(/isOperatorConfigWriteRole/);
    }
  });
});
