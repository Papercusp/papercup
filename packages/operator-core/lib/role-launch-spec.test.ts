/**
 * Unit tests for buildRoleLaunchSpec (agent-launch-unification P-003).
 * Mocks the two shared leaves (assembleRolePrompt + signSpawnParams) so
 * the test asserts the COMPOSITION + the role-scoped signed-URL shape,
 * not the leaves' internals (those have their own tests).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const assembleRolePromptMock = vi.fn();
const resolvePromptFileMock = vi.fn((_ctx: unknown, role: string): string | null =>
  role === 'planner' ? '/h/prompts/planner.md' : null,
);
const resolvePromptFilesMock = vi.fn((_ctx: unknown, role: string): string[] => {
  const file = resolvePromptFileMock(_ctx, role);
  return file ? [file] : [];
});

vi.mock('@papercusp/orchestrator/role-prompt', () => ({
  assembleRolePrompt: (...args: unknown[]) => assembleRolePromptMock(...args),
  resolvePromptFile: (...args: unknown[]) =>
    resolvePromptFileMock(...(args as [unknown, string])),
  resolvePromptFiles: (...args: unknown[]) =>
    resolvePromptFilesMock(...(args as [unknown, string])),
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
import { buildRoleLaunchSpec, buildLaunchSpec } from './role-launch-spec';
import { resolveProjectDir } from './spawn-config';
import { readSuperuserToken } from './superuser-token';
// The SHARED launch-mechanics keying helper — the SAME module invoke.ts
// (orchestrator launch) + wake-executor (resume) import. Asserting the spec's
// dirs equal these proves "one HOW" across launch paths (P-005). NOT mocked.
import { sessionClaudeConfigDir, sessionMcpDir } from '@papercusp/orchestrator/session-launch-dirs';

beforeEach(() => {
  vi.clearAllMocks();
  assembleRolePromptMock.mockReturnValue({
    text: 'WORKER PROMPT BODY',
    meta: { role: 'worker', promptFile: '/h/prompts/worker.md', projectDir: '/proj/papercup', stateDir: '/proj/papercup/.papercusp', harnessDir: '/h', runId: 'worker-F-001-123' },
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
      expect.objectContaining({ slug: 'papercup', role: 'worker', mode: 'chat', featureId: 'F-001', projectDir: '/registry/papercup' }),
    );
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
      meta: { role: 'scoper', promptFile: '/h/prompts/scoper.md', projectDir: '/proj/papercup', stateDir: '', harnessDir: '/h', runId: 'scoper-123' },
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
      buildRoleLaunchSpec({ role: 'worker', workspaceId: 'default', harnessSlug: 'ghost', operatorBaseUrl: 'http://x' }),
    ).rejects.toThrow(/not registered/);
  });

  it('throws (before calling the assembler) when the harness is not in the workspace', async () => {
    // resolveProjectDir → null means the harness isn't registered in this
    // workspace; we must surface that in-process, not let the assembler fall
    // back to its workspace-blind lookup.
    vi.mocked(resolveProjectDir).mockResolvedValueOnce(null);
    await expect(
      buildRoleLaunchSpec({ role: 'scoper', workspaceId: 'papercusp-workspace', harnessSlug: 'papercup', operatorBaseUrl: 'http://x' }),
    ).rejects.toThrow(/not registered in workspace "papercusp-workspace"/);
    expect(assembleRolePromptMock).not.toHaveBeenCalled();
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
    expect(spec.promptText).toContain('# This launch');
    expect(spec.promptText).toContain('papercup');
    expect(spec.promptText).toContain('my-plan');
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
