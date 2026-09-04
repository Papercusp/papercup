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
// Partial mock: pin `harnessRoot` and keep every other export real — the module graph under
// test reaches the blueprint loader (`harnessRootCandidates`, `harnessPath`) through the
// orchestrator's prompt-resolve → render-stack seam (identities-v1 P-003), and a full
// replacement mock would fail collection on the first export it did not list.
vi.mock('@papercusp/harness/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/harness/paths')>()),
  harnessRoot: vi.fn(() => '/h'),
}));
// The chat-surface prompts dir for the workspace-level (harness-less) role
// branch — pointed at a temp dir each test writes persona files into.
let promptsDirValue = '/nonexistent-prompts';
vi.mock('./prompt-assembly', async (importOriginal) => ({
  // P-022: the addressed-guide composer runs the REAL budget seam (projectGuideAtBudget)
  // through this module; only promptsDir is stubbed.
  ...(await importOriginal<typeof import('./prompt-assembly')>()),
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
import {
  buildRoleLaunchSpec,
  buildLaunchSpec,
  SU_EXTRA_MCP_TOOL_NAMES,
  stewardSeedToolNames,
} from './role-launch-spec';

// WI-2140338: switchable partial mock of the projected-tool registry read, so the
// steward-seed tests are deterministic regardless of what this test process has
// registered. `listings: null` ⇒ passthrough to the real registry.
const stewardMockState = vi.hoisted(() => ({ listings: null as null | { name: string }[] }));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const realList = real.listMcpProjections as (...a: unknown[]) => { name: string }[];
  return {
    ...real,
    listMcpProjections: (...args: unknown[]) => stewardMockState.listings ?? realList(...args),
  };
});
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

  it('role=worker, contextSize omitted ⇒ uses the growable trimmed seed too', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'worker',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(spec.contextSize).toBe('trimmed');
    expect(new URL(spec.mcpUrl).searchParams.has('tools')).toBe(true);
  });

  it('legacy explicit contextSize:"full" normalizes to trimmed', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'mug',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
      contextSize: 'full',
    });
    expect(spec.contextSize).toBe('trimmed');
    expect(new URL(spec.mcpUrl).searchParams.has('tools')).toBe(true);
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
// the tail — it's a ~165k→~10k token win everywhere.
//
// There is NO opt-out any more (trimmed-only-agent-context-launch-2026-08-27 P-001/P-002).
// contextSize:'full' used to escape into the eager whole-catalog load; it is now only a
// deprecated ALIAS that normalizeSuContextSize maps to 'trimmed' before launch, so the
// `legacy full` cases below assert it produces the IDENTICAL seed rather than merely
// producing some seed — asserting only that `tools` is present would still pass if the
// alias started resolving to a different surface, which is the regression that matters.
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
    expect(u.searchParams.get('tools')!.split(',')).toContain('coord:declare-intent');
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

  it('codex + legacy full ⇒ seeds IDENTICALLY to trimmed (alias, not a mode)', async () => {
    const legacy = (await suMcpUrl('codex', { contextSize: 'full' })).searchParams.get('tools');
    const trimmed = (await suMcpUrl('codex', { contextSize: 'trimmed' })).searchParams.get('tools');
    expect(legacy).toBe(trimmed);
    expect(legacy).toBe([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','));
  });

  // dynamic-tool-surface D-004: codex now SEEDS the core spine BY DEFAULT (any tier)
  // for the token-cost win — the seed is a growable floor (tools:find → list_changed
  // re-fetch) + tools:invoke reaches the tail, so nothing is stranded. Nothing opts
  // back into the ~140k-token full catalog: for codex the eager load was not merely
  // expensive but transport-INVALID once the code-mode IPC frame exceeded its limit,
  // which is why 'full' is an alias here rather than a supported escape hatch.
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

  it('omp + legacy full ⇒ seeds IDENTICALLY to trimmed, even on a FRONTIER model', async () => {
    const legacy = (await suMcpUrl('omp', { model: FRONTIER, contextSize: 'full' })).searchParams.get('tools');
    const trimmed = (await suMcpUrl('omp', { model: FRONTIER, contextSize: 'trimmed' })).searchParams.get('tools');
    expect(legacy).toBe(trimmed);
    // The frontier tier is the case that used to resolve to 'full', so it is the one
    // where a reintroduced tier-derived branch would show up first.
    expect(legacy).toBe([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','));
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

  it('claude + legacy full ⇒ seeds IDENTICALLY to trimmed', async () => {
    const legacy = (await suMcpUrl('claude', { model: FRONTIER, contextSize: 'full' })).searchParams.get('tools');
    const trimmed = (await suMcpUrl('claude', { model: FRONTIER, contextSize: 'trimmed' })).searchParams.get('tools');
    expect(legacy).toBe(trimmed);
    expect(legacy).toBe([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','));
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

// ── WI-2140338: the 'steward' intermediate tool seed ─────────────────────────
// The steward seed derives exact names from the live projected-tool registry;
// these tests inject listings (pure fn) and switch the module mock (URL path)
// so the semantics are deterministic regardless of what the test process has
// registered.
describe('stewardSeedToolNames + the steward launch seed (WI-2140338)', () => {
  const FAKE_LISTINGS = [
    { name: 'goals:get' },
    { name: 'goals:tripwires' },
    { name: 'blender:grade-idea' },
    { name: 'work_items:checkpoint' },
    { name: 'coord:orient' }, // already in CORE — must dedupe
    { name: 'design-phase:validate_spec' }, // NOT a steward family
    { name: 'templates:list' }, // NOT a steward family
    { name: 'noColon' }, // pathological: no family separator
    { name: ':leadingColon' }, // pathological: empty family
  ];

  beforeEach(() => {
    stewardMockState.listings = null;
  });

  it('expands ONLY steward-family names from the listings, on top of CORE + SU_EXTRA', () => {
    const seed = stewardSeedToolNames(FAKE_LISTINGS);
    for (const included of ['goals:get', 'goals:tripwires', 'blender:grade-idea', 'work_items:checkpoint']) {
      expect(seed).toContain(included);
    }
    for (const excluded of ['design-phase:validate_spec', 'templates:list', 'noColon', ':leadingColon']) {
      expect(seed).not.toContain(excluded);
    }
    // The spine and the su extras ride along in full.
    for (const core of CORE_MCP_TOOL_NAMES) expect(seed).toContain(core);
    for (const extra of SU_EXTRA_MCP_TOOL_NAMES) expect(seed).toContain(extra);
  });

  it('dedupes against the spine and keeps CORE-first ordering', () => {
    const seed = stewardSeedToolNames(FAKE_LISTINGS);
    expect(seed.filter((n) => n === 'coord:orient')).toHaveLength(1);
    expect(seed.slice(0, CORE_MCP_TOOL_NAMES.length)).toEqual([...CORE_MCP_TOOL_NAMES]);
    expect(new Set(seed).size).toBe(seed.length);
  });

  it("su launch with contextSize:'steward' seeds ?tools= with the expanded steward set", async () => {
    stewardMockState.listings = FAKE_LISTINGS;
    const spec = await buildLaunchSpec({
      kind: 'su',
      agent: 'codex',
      workspaceId: 'default',
      operatorBaseUrl: 'http://localhost:3070',
      contextSize: 'steward',
    });
    const u = new URL(spec.mcpUrl);
    expect(u.searchParams.get('tools')!.split(',')).toEqual(stewardSeedToolNames(FAKE_LISTINGS));
  });

  it('su launch WITHOUT steward keeps the exact trimmed seed — no drift for existing sessions', async () => {
    stewardMockState.listings = FAKE_LISTINGS; // present, but must not be consulted
    const spec = await buildLaunchSpec({
      kind: 'su',
      agent: 'claude',
      workspaceId: 'default',
      operatorBaseUrl: 'http://localhost:3070',
    });
    const u = new URL(spec.mcpUrl);
    expect(u.searchParams.get('tools')!.split(',')).toEqual([
      ...CORE_MCP_TOOL_NAMES,
      ...SU_EXTRA_MCP_TOOL_NAMES,
    ]);
  });

  it('an explicit steward request against an unpopulated registry REFUSES loudly (never a silent trimmed downgrade)', async () => {
    stewardMockState.listings = [{ name: 'design-phase:validate_spec' }]; // zero steward-family names
    await expect(
      buildLaunchSpec({
        kind: 'su',
        agent: 'codex',
        workspaceId: 'default',
        operatorBaseUrl: 'http://localhost:3070',
        contextSize: 'steward',
      }),
    ).rejects.toThrow(/expanded no steward-family names/);
  });

  it('pipeline roles REFUSE steward — it is an su/goal-holder seed', async () => {
    await expect(
      buildRoleLaunchSpec({
        role: 'worker',
        workspaceId: 'default',
        harnessSlug: 'papercup',
        operatorBaseUrl: 'http://localhost:3070',
        contextSize: 'steward',
      }),
    ).rejects.toThrow(/not a pipeline-role mode/);
  });
});

// identities-v1-2026-08-30 P-022: the Project guide is selected by the WEARER'S STACK.
// buildLaunchSpec threads a composer into renderSuPlaybook; the composer expands the
// session's stack (su static layers + fleet posture + modes) into addressing tokens,
// reads the rows addressed to them, and splices them after the default guide.
// The read is exercised for REAL down to the SQL seam: `getOrgPg()` hands back a stub
// whose `unsafe` records the parameters (workspace, harness, doc, tokens, client axes)
// and returns whatever rows the test queued — so the assertions below are about the
// query the launch actually issues, not about a mocked reader's arguments.
const addressedReadMock = vi.hoisted(() => ({
  fn: vi.fn(async (_params: unknown[]) => [] as unknown[]),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    // The handle shape: `getOrgPg().sql` is the postgres `Sql` the reader calls `unsafe` on.
    getOrgPg: () => ({ sql: { unsafe: (_q: string, params: unknown[]) => addressedReadMock.fn(params) } }),
  };
});

describe('buildSuLaunchSpec — P-022 blueprint-addressable project guide', () => {
  const su = {
    kind: 'su' as const,
    agent: 'claude' as const,
    workspaceId: 'default',
    operatorBaseUrl: 'http://localhost:3070',
    harnessSlug: 'papercup',
  };
  type Composer = (r: { text: string; source: string }) => Promise<{ text: string; addressed: { tokens: string[]; partKeys: string[] } | null }>;
  type ReadInput = { tokens: string[]; harnessSlug: string; client: string };

  function composerFromLastRender(): Composer {
    const call = renderSuPlaybookMock.mock.calls.at(-1)?.[0] as { composeProjectGuide?: unknown };
    expect(typeof call.composeProjectGuide).toBe('function');
    return call.composeProjectGuide as Composer;
  }
  const lastRead = (): ReadInput => {
    const params = addressedReadMock.fn.mock.calls.at(-1)?.[0] as [string, string, string, string[], string[]];
    expect(params, 'the composer issued no read').toBeDefined();
    return { harnessSlug: params[1], tokens: params[3], client: params[4][0] };
  };

  it('ENGINEER profile: reads with the su static layers + role tokens; no rows ⇒ the default guide byte-identical', async () => {
    addressedReadMock.fn.mockResolvedValueOnce([]);
    await buildLaunchSpec(su);
    const out = await composerFromLastRender()({ text: '# DEFAULT GUIDE\n', source: '/repo/CLAUDE.md' });
    expect(out.text).toBe('# DEFAULT GUIDE\n');
    expect(out.addressed).toBeNull();
    const read = lastRead();
    // The engineer guide is papercusp's own CLAUDE.md, so its parts live under the projector's harness.
    expect(read.harnessSlug).toBe(process.env.PAPERCUSP_HARNESS_SLUG ?? 'papercusp');
    expect(read.client).toBe('claude');
    expect(read.tokens).toEqual(
      expect.arrayContaining(['role:su', 'blueprint:papercusp-engineer', 'slot:domain', 'blueprint:su-collaborator', 'blueprint:su.practice']),
    );
    expect(read.tokens).not.toContain('slot:fleet-posture');
  });

  it('a fleet LEADER launching with AUTO wears su.fleet-leader + su.mode-auto and receives the rows addressed to them', async () => {
    addressedReadMock.fn.mockResolvedValueOnce([
      { part_key: 'lead-1', body: 'LEADER ONLY RULE', ordinal: 1, target_section: 'Fleet', stack_scope: ['blueprint:su.fleet-leader'] },
    ]);
    await buildLaunchSpec({ ...su, fleetRole: 'leader', modes: ['auto'] });
    const out = await composerFromLastRender()({ text: '# DEFAULT GUIDE\n', source: '/repo/CLAUDE.md' });
    expect(lastRead().tokens).toEqual(
      expect.arrayContaining(['blueprint:su.fleet-leader', 'slot:fleet-posture', 'blueprint:su.mode-auto', 'slot:autonomy']),
    );
    expect(out.text.startsWith('# DEFAULT GUIDE\n\n## Addressed guidance')).toBe(true);
    expect(out.text).toContain('LEADER ONLY RULE');
    expect(out.addressed?.partKeys).toEqual(['lead-1']);
  });

  it('two launches in the same pot with different stacks are read with DIFFERENT tokens', async () => {
    await buildLaunchSpec({ ...su, fleetRole: 'leader' });
    await composerFromLastRender()({ text: 'G', source: '/g' });
    const leaderTokens = lastRead().tokens;
    await buildLaunchSpec({ ...su, fleetRole: 'member', modes: ['auto'] });
    await composerFromLastRender()({ text: 'G', source: '/g' });
    const memberTokens = lastRead().tokens;
    expect(leaderTokens).toContain('blueprint:su.fleet-leader');
    expect(memberTokens).toContain('blueprint:su.fleet-member');
    expect(memberTokens).toContain('blueprint:su.mode-auto');
    expect(leaderTokens).not.toContain('blueprint:su.mode-auto');
    expect(leaderTokens).not.toEqual(memberTokens);
  });

  it('GENERIC profile (no repo guide) threads NO composer; POWER reads under the launch harness', async () => {
    await buildLaunchSpec({ ...su, profile: 'generic' });
    expect((renderSuPlaybookMock.mock.calls.at(-1)?.[0] as { composeProjectGuide?: unknown }).composeProjectGuide).toBeUndefined();
    await buildLaunchSpec({ ...su, profile: 'power' });
    await composerFromLastRender()({ text: 'G', source: '/repo/CLAUDE.md' });
    expect(lastRead().harnessSlug).toBe('papercup');
  });
});
