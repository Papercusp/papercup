/**
 * Unit tests for buildRoleLaunchSpec (agent-launch-unification P-003).
 * Mocks the two shared leaves (assembleRolePrompt + signSpawnParams) so
 * the test asserts the COMPOSITION + the role-scoped signed-URL shape,
 * not the leaves' internals (those have their own tests).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const assembleRolePromptMock = vi.fn();
const tagTurnForInjectionMock = vi.fn(({ text, sid, origin }: { text: string; sid: string; origin: string }) => ({
  taggedText: text,
  envelope: `⟦turn-origin:${origin} nonce:testnonce12345678⟧`,
  nonce: 'testnonce12345678',
  origin,
  ledgerWritten: true,
}));
const resolvePromptFileMock = vi.fn((_ctx: unknown, role: string): string | null =>
  role === 'planner' ? '/h/prompts/planner.md' : null,
);
const resolvePromptFilesMock = vi.fn((_ctx: unknown, role: string): string[] => {
  const file = resolvePromptFileMock(_ctx, role);
  return file ? [file] : [];
});

vi.mock('@papercusp/orchestrator/role-prompt', () => ({
  assembleRolePrompt: (...args: unknown[]) => assembleRolePromptMock(...args),
  resolvePromptFile: (...args: unknown[]) => resolvePromptFileMock(...(args as [unknown, string])),
  resolvePromptFiles: (...args: unknown[]) => resolvePromptFilesMock(...(args as [unknown, string])),
}));
vi.mock('@papercusp/harness/paths', () => ({
  harnessRoot: vi.fn(() => '/h'),
}));
// The chat-surface prompts dir for the workspace-level (harness-less) role
// branch — pointed at a temp dir each test writes persona files into.
let promptsDirValue = '/nonexistent-prompts';
vi.mock('./prompt-assembly', () => ({
  promptsDir: () => promptsDirValue,
}));
// Deterministic signer: append a fixed exp+sig so the URL is assertable.
vi.mock('./spawn-signing', () => ({
  signSpawnParams: vi.fn(async (params: URLSearchParams) => {
    params.set('exp', '9999999999');
    params.set('sig', 'TESTSIG');
    return { exp: 9999999999, sig: 'TESTSIG' };
  }),
}));
vi.mock('./turn-provenance/turn-provenance', () => ({
  tagTurnForInjection: (...args: unknown[]) => tagTurnForInjectionMock(...(args as [{ text: string; sid: string; origin: string }])),
}));
vi.mock('./spawn-config', () => ({
  resolveProjectDir: vi.fn(async (slug: string) => `/registry/${slug}`),
}));
// su-branch leaves: the playbook renderer, the token reader, and the
// workspace-root resolver. Mocked so the su tests assert the COMPOSITION
// (cwd + launch-context append + superuser MCP shape), not the leaves —
// renderSuPlaybook's real splice has its own coverage in papercusp-files.test.ts.
const renderSuPlaybookMock = vi.fn(async (..._args: unknown[]) => ({
  text: 'SU PLAYBOOK BODY',
  baseSource: '/prompts/papercusp-su-engineer.tools.md',
  overlaySource: '/prompts/papercusp-su.claude.md',
}));
vi.mock('./desktop-install/papercusp-files', () => ({
  renderSuPlaybook: (...args: unknown[]) => renderSuPlaybookMock(...args),
}));
vi.mock('./superuser-token', () => ({
  readSuperuserToken: vi.fn(() => 'TESTTOKEN'),
}));
// Workspace-scoped root resolver: echo the workspace id so the test asserts
// cwd is derived from the SELECTED workspace, not a global value.
vi.mock('./papercusp-root', () => ({
  papercuspPathForWorkspace: vi.fn((ws: string) => `/ws-root/${ws}`),
}));

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRoleLaunchSpec, buildLaunchSpec, SU_EXTRA_MCP_TOOL_NAMES } from './role-launch-spec';
import { resolveProjectDir } from './spawn-config';
import { readSuperuserToken } from './superuser-token';
// su-context-size-variants (WI-1282): the always-loaded core spine the codex
// 'trimmed' variant advertises via ?tools=. NOT mocked — the test pins the
// URL's tools= param to the REAL exported list so the two can't drift.
import { CORE_MCP_TOOL_NAMES } from '@papercusp/orchestrator';
// The SHARED launch-mechanics keying helper — the SAME module invoke.ts
// (orchestrator launch) + wake-executor (resume) import. Asserting the spec's
// dirs equal these proves "one HOW" across launch paths (P-005). NOT mocked.
import { sessionClaudeConfigDir, sessionMcpDir } from '@papercusp/orchestrator/session-launch-dirs';

beforeEach(() => {
  vi.clearAllMocks();
  assembleRolePromptMock.mockReturnValue({
    text: 'WORKER PROMPT BODY',
    meta: {
      role: 'worker',
      promptFile: '/h/prompts/worker.md',
      projectDir: '/proj/papercup',
      stateDir: '/proj/papercup/.papercusp',
      harnessDir: '/h',
      runId: 'worker-F-001-123',
    },
  });
});

describe('buildRoleLaunchSpec', () => {
  it('composes assembleRolePrompt + a signed role-scoped MCP URL', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'worker',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
      featureId: 'F-001',
    });

    // prompt comes from the shared assembler, in chat mode, WITH the
    // in-process workspace-aware projectDir (so the assembler skips its
    // workspace-blind lookupProjectDir / curl-to-:3055 fallback).
    expect(assembleRolePromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'papercup',
        role: 'worker',
        mode: 'chat',
        featureId: 'F-001',
        projectDir: '/registry/papercup',
      }),
    );
    expect(tagTurnForInjectionMock).toHaveBeenCalledWith({
      sid: spec.sid,
      origin: 'role-prompt',
      text: 'WORKER PROMPT BODY',
    });
    expect(spec.promptText).toBe('WORKER PROMPT BODY');
    expect(spec.runId).toBe('worker-F-001-123');
    expect(spec.cwd).toBe('/proj/papercup');

    // The MCP URL is role-scoped (role=worker, NOT ?superuser=1) + signed
    // + carries the feature/harness/workspace the dispatch layer checks.
    const u = new URL(spec.mcpUrl);
    expect(u.pathname).toBe('/api/mcp');
    expect(u.searchParams.get('role')).toBe('worker');
    expect(u.searchParams.get('harness')).toBe('papercup');
    expect(u.searchParams.get('workspace')).toBe('default');
    expect(u.searchParams.get('feature')).toBe('F-001');
    expect(u.searchParams.get('spawn')).toBe(spec.spawnId);
    expect(u.searchParams.get('sig')).toBe('TESTSIG');
    expect(u.searchParams.has('superuser')).toBe(false);

    // .mcp.json wraps the same URL.
    const mcp = JSON.parse(spec.mcpJsonContents);
    expect(mcp.mcpServers.papercusp.url).toBe(spec.mcpUrl);
    expect(mcp.mcpServers.papercusp.type).toBe('http');

    // Launch invariants the primitive now produces (unify-launch-mechanics P-002).
    expect(spec.sid).toMatch(/^role-/);
    expect(spec.nativeSessionId).toBeTruthy();
    expect(spec.nativeSessionId).not.toBe(spec.sid);
    // EI-4: the MCP url's client= IS the minted sid (URL owner === PAPERCUSP_SID).
    expect(u.searchParams.get('client')).toBe(spec.sid);
    // Per-session dirs are keyed by the sid via the SHARED helper — byte-for-byte
    // the same path the orchestrator launch (invoke.ts) + the wake-executor resume
    // leg compute for that owner. This is the P-005 "one HOW" guarantee: launch
    // and resume can't drift because they call the same function.
    expect(spec.claudeConfigDir).toBe(sessionClaudeConfigDir(spec.sid));
    expect(spec.sessionMcpDir).toBe(sessionMcpDir(spec.sid));
  });

  it('omits the feature param for a no-feature role', async () => {
    assembleRolePromptMock.mockReturnValue({
      text: 'SCOPER PROMPT',
      meta: {
        role: 'scoper',
        promptFile: '/h/prompts/scoper.md',
        projectDir: '/proj/papercup',
        stateDir: '',
        harnessDir: '/h',
        runId: 'scoper-123',
      },
    });
    const spec = await buildRoleLaunchSpec({
      role: 'scoper',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(spec.featureId).toBeNull();
    expect(new URL(spec.mcpUrl).searchParams.has('feature')).toBe(false);
  });

  it('propagates a harness-not-registered throw from assembleRolePrompt', async () => {
    assembleRolePromptMock.mockImplementation(() => {
      throw new Error('assembleRolePrompt: harness "ghost" not registered');
    });
    await expect(
      buildRoleLaunchSpec({
        role: 'worker',
        workspaceId: 'default',
        harnessSlug: 'ghost',
        operatorBaseUrl: 'http://x',
      }),
    ).rejects.toThrow(/not registered/);
  });

  it('throws (before calling the assembler) when the harness is not in the workspace', async () => {
    // resolveProjectDir → null means the harness isn't registered in this
    // workspace; we must surface that in-process, not let the assembler fall
    // back to its workspace-blind lookup.
    vi.mocked(resolveProjectDir).mockResolvedValueOnce(null);
    await expect(
      buildRoleLaunchSpec({
        role: 'scoper',
        workspaceId: 'papercusp-workspace',
        harnessSlug: 'papercup',
        operatorBaseUrl: 'http://x',
      }),
    ).rejects.toThrow(/not registered in workspace "papercusp-workspace"/);
    expect(assembleRolePromptMock).not.toHaveBeenCalled();
  });
});

describe('buildRoleLaunchSpec — WI-4608 contextSize role-based default (the mug/kettle "Prompt is too long" fix)', () => {
  it('role=mug, contextSize omitted ⇒ auto-selects trimmed and seeds ?tools=CORE_MCP_TOOL_NAMES', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'mug',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(spec.contextSize).toBe('trimmed');
    const u = new URL(spec.mcpUrl);
    expect(u.searchParams.get('tools')!.split(',')).toEqual([...CORE_MCP_TOOL_NAMES]);
  });

  it('role=kettle, contextSize omitted ⇒ auto-selects trimmed too (not just mug)', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'kettle',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(spec.contextSize).toBe('trimmed');
    expect(new URL(spec.mcpUrl).searchParams.has('tools')).toBe(true);
  });

  it('role=queen / role=overwatch (pre-rename spellings) also auto-select trimmed via canonicalCoordRole', async () => {
    const queenSpec = await buildRoleLaunchSpec({
      role: 'queen',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(queenSpec.contextSize).toBe('trimmed');
    const overwatchSpec = await buildRoleLaunchSpec({
      role: 'overwatch',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(overwatchSpec.contextSize).toBe('trimmed');
  });

  it('role=worker, contextSize omitted ⇒ stays full (byte-identical default for every non-mug/kettle role)', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'worker',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(spec.contextSize).toBe('full');
    expect(new URL(spec.mcpUrl).searchParams.has('tools')).toBe(false);
  });

  it('role=mug, explicit contextSize:"full" OVERRIDES the role-based default', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'mug',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
      contextSize: 'full',
    });
    expect(spec.contextSize).toBe('full');
    expect(new URL(spec.mcpUrl).searchParams.has('tools')).toBe(false);
  });

  it('role=worker, explicit contextSize:"trimmed" OVERRIDES the (full) role-based default', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'worker',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
      contextSize: 'trimmed',
    });
    expect(spec.contextSize).toBe('trimmed');
    expect(new URL(spec.mcpUrl).searchParams.get('tools')!.split(',')).toEqual([...CORE_MCP_TOOL_NAMES]);
  });
});

describe('buildRoleLaunchSpec — WORKSPACE-LEVEL (harness-less) role session (hive-agent-tabs P-003)', () => {
  it('operator: chat persona (+tools.md) prompt, workspace-root cwd, MCP URL signed WITHOUT a harness param', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rls-prompts-'));
    writeFileSync(join(dir, 'operator.persona.md'), 'OPERATOR PERSONA');
    writeFileSync(join(dir, 'operator.tools.md'), 'OPERATOR TOOLS PLAYBOOK');
    promptsDirValue = dir;

    const spec = await buildRoleLaunchSpec({
      role: 'operator',
      workspaceId: 'default',
      harnessSlug: null,
      operatorBaseUrl: 'http://localhost:3070',
    });

    // The shared harness assembler is NOT used — no harness to resolve.
    expect(assembleRolePromptMock).not.toHaveBeenCalled();
    expect(resolveProjectDir).not.toHaveBeenCalled();
    expect(spec.harnessSlug).toBeNull();
    // cwd = the SELECTED workspace's root (the buildSuLaunchSpec mirror).
    expect(spec.cwd).toBe('/ws-root/default');
    // The prompt is the chat-surface persona + tools playbook + runtime context
    // telling the session it is unscoped.
    expect(spec.promptText).toContain('OPERATOR PERSONA');
    expect(spec.promptText).toContain('OPERATOR TOOLS PLAYBOOK');
    expect(spec.promptText).toContain('harness_required');
    expect(spec.promptFile).toBe(join(dir, 'operator.persona.md'));
    // Signed role URL with NO harness param — ctx lands as the '*' sentinel.
    const u = new URL(spec.mcpUrl);
    expect(u.searchParams.has('harness')).toBe(false);
    expect(u.searchParams.get('role')).toBe('operator');
    expect(u.searchParams.get('workspace')).toBe('default');
    expect(u.searchParams.get('sig')).toBe('TESTSIG');
    expect(u.searchParams.get('client')).toBe(spec.sid);
    rmSync(dir, { recursive: true, force: true });
  });

  // EI-996 note: `psu --role planner` no longer REACHES this builder — the launcher
  // routes su-tier roles (SU_TIER_ROLES) to the su bootstrap instead. This test is
  // still correct and still load-bearing: buildRoleLaunchSpec is unchanged and stays
  // the path for harness-pipeline planner spawns, which do not go through psu.
  it('planner: falls back to the spawn persona (prompts/planner.md) when no chat persona exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rls-prompts-'));
    promptsDirValue = dir; // empty — no planner.persona.md
    const spawnPersona = join(dir, 'planner.md');
    writeFileSync(spawnPersona, 'PLANNER SPAWN PERSONA');
    resolvePromptFileMock.mockReturnValueOnce(spawnPersona);

    const spec = await buildRoleLaunchSpec({
      role: 'planner',
      workspaceId: 'default',
      harnessSlug: null,
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(spec.promptText).toContain('PLANNER SPAWN PERSONA');
    expect(spec.promptFile).toBe(spawnPersona);
    expect(new URL(spec.mcpUrl).searchParams.has('harness')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws for a role with no workspace-level persona at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rls-prompts-'));
    promptsDirValue = dir;
    resolvePromptFileMock.mockReturnValueOnce(null);
    await expect(
      buildRoleLaunchSpec({ role: 'worker', workspaceId: 'default', harnessSlug: null, operatorBaseUrl: 'http://x' }),
    ).rejects.toThrow(/no workspace-level persona/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('buildLaunchSpec — kind dispatch', () => {
  it("kind:'role' delegates to buildRoleLaunchSpec + tags kind, role-scoped (no superuser)", async () => {
    const spec = await buildLaunchSpec({
      kind: 'role',
      role: 'worker',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
      featureId: 'F-001',
    });
    expect(spec.kind).toBe('role');
    expect(spec.role).toBe('worker');
    expect(spec.promptText).toBe('WORKER PROMPT BODY');
    const u = new URL(spec.mcpUrl);
    expect(u.searchParams.get('role')).toBe('worker');
    expect(u.searchParams.has('superuser')).toBe(false);
    // su leaves untouched on the role path.
    expect(renderSuPlaybookMock).not.toHaveBeenCalled();
  });

  it("kind:'su' workspace-level: playbook prompt, workspace-root cwd, superuser MCP + bearer", async () => {
    const spec = await buildLaunchSpec({
      kind: 'su',
      agent: 'claude',
      workspaceId: 'default',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(spec.kind).toBe('su');
    expect(spec.role).toBe('su');
    expect(spec.featureId).toBeNull();
    expect(spec.harnessSlug).toBeNull();
    // workspace-level → papercuspPathForWorkspace(workspaceId) (mocked),
    // scoped to the SELECTED workspace, no resolveProjectDir.
    expect(spec.cwd).toBe('/ws-root/default');
    expect(resolveProjectDir).not.toHaveBeenCalled();
    // playbook rendered for the right client; no launch-context (no harness/plan).
    expect(renderSuPlaybookMock).toHaveBeenCalledWith(expect.objectContaining({ agent: 'claude' }));
    expect(spec.promptText).toBe('SU PLAYBOOK BODY');
    expect(spec.promptFile).toBe('/prompts/papercusp-su-engineer.tools.md');
    // superuser MCP door (NOT a signed role URL), workspace baked in, bearer set.
    const u = new URL(spec.mcpUrl);
    expect(u.pathname).toBe('/api/mcp');
    expect(u.searchParams.get('superuser')).toBe('1');
    expect(u.searchParams.get('workspace')).toBe('default');
    expect(u.searchParams.has('role')).toBe(false);
    const mcp = JSON.parse(spec.mcpJsonContents);
    expect(mcp.mcpServers.papercusp.url).toBe(spec.mcpUrl);
    expect(mcp.mcpServers.papercusp.headers.Authorization).toBe('Bearer TESTTOKEN');
  });

  it("kind:'su' harness+plan: cwd from registry, launch-context appended to playbook", async () => {
    const spec = await buildLaunchSpec({
      kind: 'su',
      agent: 'omp',
      workspaceId: 'default',
      operatorBaseUrl: 'http://localhost:3070',
      harnessSlug: 'papercup',
      planSlug: 'my-plan',
      planTitle: 'My Plan',
      planNow: { state: 'doing X', next: 'do Y' },
    });
    expect(spec.harnessSlug).toBe('papercup');
    expect(spec.cwd).toBe('/registry/papercup');
    expect(renderSuPlaybookMock).toHaveBeenCalledWith(expect.objectContaining({ agent: 'omp' }));
    // base playbook + the composed scope/plan addendum.
    expect(spec.promptText).toContain('SU PLAYBOOK BODY');
    expect(spec.promptText).toContain('# Operating brief — this launch');
    expect(spec.promptText).toContain('papercup');
    expect(spec.promptText).toContain('my-plan');
    expect(spec.instructionLint).toMatchObject({ markerCount: 4, clean: true });
  });

  it("kind:'su' surfaces a harness that isn't registered in the workspace", async () => {
    vi.mocked(resolveProjectDir).mockResolvedValueOnce(null);
    await expect(
      buildLaunchSpec({
        kind: 'su',
        agent: 'codex',
        workspaceId: 'ws9',
        operatorBaseUrl: 'http://x',
        harnessSlug: 'ghost',
      }),
    ).rejects.toThrow(/not registered in workspace "ws9"/);
  });

  it("kind:'su' with no installed token emits empty headers (bootstrap pending)", async () => {
    vi.mocked(readSuperuserToken).mockReturnValueOnce(null);
    const spec = await buildLaunchSpec({
      kind: 'su',
      agent: 'claude',
      workspaceId: 'default',
      operatorBaseUrl: 'http://x',
    });
    const mcp = JSON.parse(spec.mcpJsonContents);
    expect(mcp.mcpServers.papercusp.headers).toEqual({});
  });
});

// dynamic-tool-surface D-010 ("default all to trimmed"): the core-spine `?tools=` SEED
// is baked into the superuser MCP URL BY DEFAULT for EVERY client + tier. It's a
// growable floor (tools:find → notifications/tools/list_changed re-fetch; + tools:invoke
// fallback; + a compact capability map for discoverability), so seeding no longer strands
// the tail — it's a ~165k→~10k token win everywhere. Only an explicit contextSize:'full'
// opts OUT into the eager whole-catalog load (the escape hatch for latency-critical
// broad-tool tasks / a client that can't do dynamic expansion / debugging).
describe('buildSuLaunchSpec — contextSize ?tools= seed lever (trimmed-by-default)', () => {
  async function suMcpUrl(
    agent: 'claude' | 'omp' | 'codex',
    opts: { contextSize?: 'full' | 'trimmed' | null; model?: string | null } = {},
  ): Promise<URL> {
    const spec = await buildLaunchSpec({
      kind: 'su',
      agent,
      workspaceId: 'default',
      operatorBaseUrl: 'http://localhost:3070',
      contextSize: opts.contextSize,
      model: opts.model,
    });
    return new URL(spec.mcpUrl);
  }

  const WEAK = 'ollama/maxwell1500/ornith-35b:IQ3_M';
  const FRONTIER = 'anthropic/claude-opus-4-8';

  it('codex + trimmed ⇒ tools= present and EQUALS CORE_MCP_TOOL_NAMES + SU_EXTRA_MCP_TOOL_NAMES (URL-decoded)', async () => {
    const u = await suMcpUrl('codex', { contextSize: 'trimmed' });
    // URLSearchParams.get decodes the %3A/%2C-encoded colon/comma tool names.
    expect(u.searchParams.get('tools')).toBe([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','));
    // …and that round-trips back to the exact list the server allowlist decodes.
    expect(u.searchParams.get('tools')!.split(',')).toEqual([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES]);
    expect(u.searchParams.get('tools')!.split(',')).toContain('fleet:launch-on-plan');
    // P-010: every su session is seeded with chat:ask_choice too — unconditionally
    // reachable from a live GUI chat (SessionChatModal), unlike a headless role launch.
    expect(u.searchParams.get('tools')!.split(',')).toContain('chat:ask_choice');
    // The superuser door is otherwise unchanged.
    expect(u.searchParams.get('superuser')).toBe('1');
    expect(u.searchParams.get('workspace')).toBe('default');
  });

  it.each(['claude', 'codex', 'omp'] as const)('%s + trimmed ⇒ seeds the SU-only locks:release cleanup verb', async (agent) => {
    const tools = (await suMcpUrl(agent, { contextSize: 'trimmed' })).searchParams.get('tools')!.split(',');
    expect(tools).toContain('locks:release');
  });

  it('codex + full ⇒ NO tools= param (explicit opt-out into the whole catalog)', async () => {
    expect((await suMcpUrl('codex', { contextSize: 'full' })).searchParams.has('tools')).toBe(false);
  });

  // dynamic-tool-surface D-004: codex now SEEDS the core spine BY DEFAULT (any tier)
  // for the token-cost win — the seed is a growable floor (tools:find → list_changed
  // re-fetch) + tools:invoke reaches the tail, so nothing is stranded. Only an
  // explicit contextSize:'full' opts codex back into the ~140k-token full catalog.
  it('codex + omitted, no model ⇒ tools= present (seed-by-default, D-004 token win)', async () => {
    expect((await suMcpUrl('codex')).searchParams.get('tools')).toBe(
      [...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','),
    );
    expect((await suMcpUrl('codex', { contextSize: null })).searchParams.get('tools')).toBe(
      [...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','),
    );
  });

  it('codex + FRONTIER model ⇒ tools= present (seed-by-default holds on strong models too)', async () => {
    expect((await suMcpUrl('codex', { model: FRONTIER })).searchParams.get('tools')).toBe(
      [...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','),
    );
  });

  // weak-model-tool-tier: when contextSize is omitted, the tier is derived from the MODEL.
  it('omp + WEAK model ⇒ tools= present (THE OMP FIX — its native discovery is a no-op)', async () => {
    const u = await suMcpUrl('omp', { model: WEAK });
    expect(u.searchParams.get('tools')).toBe([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','));
  });

  it('omp + FRONTIER model ⇒ tools= present (D-010: trimmed is the default on ALL tiers now)', async () => {
    expect((await suMcpUrl('omp', { model: FRONTIER })).searchParams.get('tools')).toBe(
      [...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','),
    );
  });

  it('omp + full ⇒ NO tools= param (the escape hatch out of the seed)', async () => {
    expect((await suMcpUrl('omp', { model: FRONTIER, contextSize: 'full' })).searchParams.has('tools')).toBe(false);
  });

  it('codex + WEAK model ⇒ tools= present (the tier gates it, not just the manual flag)', async () => {
    expect((await suMcpUrl('codex', { model: WEAK })).searchParams.has('tools')).toBe(true);
  });

  it('omp + FRONTIER model + explicit trimmed ⇒ tools= present (explicit override on any tier)', async () => {
    expect((await suMcpUrl('omp', { model: FRONTIER, contextSize: 'trimmed' })).searchParams.has('tools')).toBe(true);
  });

  it('claude + trimmed ⇒ tools= present and EQUALS CORE_MCP_TOOL_NAMES + SU_EXTRA_MCP_TOOL_NAMES (THE FIX — ToolSearch defers only schemas, not the ~165k of names+descriptions)', async () => {
    const u = await suMcpUrl('claude', { contextSize: 'trimmed' });
    expect(u.searchParams.get('tools')).toBe([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','));
    expect(u.searchParams.get('tools')!.split(',')).toEqual([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES]);
  });

  it('claude + WEAK model ⇒ tools= present (the tier gates the trim for every client)', async () => {
    expect((await suMcpUrl('claude', { model: WEAK })).searchParams.has('tools')).toBe(true);
  });

  it('claude + FRONTIER model, no override ⇒ tools= present (D-010: claude defaults to trimmed too — the ~165k names+descriptions ToolSearch leaves inline are the waste)', async () => {
    expect((await suMcpUrl('claude', { model: FRONTIER })).searchParams.get('tools')).toBe(
      [...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','),
    );
    expect((await suMcpUrl('claude')).searchParams.get('tools')).toBe(
      [...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','),
    );
  });

  it('claude + full ⇒ NO tools= param (the escape hatch keeps native ToolSearch over the whole catalog)', async () => {
    expect((await suMcpUrl('claude', { model: FRONTIER, contextSize: 'full' })).searchParams.has('tools')).toBe(false);
  });
});

// EI-996 (owner ask 2026-06-17): "planners should be full su agents and get the full su
// prompt, but just a few lines added about their planner role." The mechanism is a
// roleAddendum appended to the rendered playbook — the SU tier (playbook + superuser MCP)
// is what makes it a "full su agent"; the addendum is the "few lines".
describe('buildSuLaunchSpec — roleAddendum (EI-996 su-tier role sessions)', () => {
  const ADDENDUM = '## You are a PLANNER\nOutput is the PLAN, not code.';

  async function suSpec(roleAddendum?: string | null) {
    return buildLaunchSpec({
      kind: 'su',
      agent: 'claude',
      workspaceId: 'default',
      operatorBaseUrl: 'http://localhost:3070',
      ...(roleAddendum === undefined ? {} : { roleAddendum }),
    });
  }

  it('appends the addendum AFTER the playbook body, so the role focus is the final word', async () => {
    const spec = await suSpec(ADDENDUM);
    expect(spec.promptText).toContain('SU PLAYBOOK BODY');
    expect(spec.promptText).toContain(ADDENDUM);
    // Ordering is the point: playbook first, role addendum after it.
    expect(spec.promptText.indexOf(ADDENDUM)).toBeGreaterThan(spec.promptText.indexOf('SU PLAYBOOK BODY'));
  });

  it('keeps the SU tier — an addendum session still gets the superuser MCP door, not a role-scoped one', async () => {
    const spec = await suSpec(ADDENDUM);
    // This is the half of EI-996 that makes it a "full su agent" rather than a reworded role.
    expect(new URL(spec.mcpUrl).searchParams.get('superuser')).toBe('1');
    expect(spec.kind).toBe('su');
    expect(spec.role).toBe('su');
  });

  it('omitted ⇒ byte-identical to a plain su launch (no regression for every existing su session)', async () => {
    const withOut = await suSpec(undefined);
    const explicitNull = await suSpec(null);
    expect(withOut.promptText).not.toContain('You are a PLANNER');
    // The null case must not diverge from the omitted case.
    expect(explicitNull.promptText).toBe(withOut.promptText);
  });

  it('blank / whitespace-only ⇒ treated as absent, with no trailing-newline drift', async () => {
    const baseline = await suSpec(undefined);
    expect((await suSpec('')).promptText).toBe(baseline.promptText);
    expect((await suSpec('   \n\t  ')).promptText).toBe(baseline.promptText);
  });
});
