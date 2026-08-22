/**
 * check_command.test.ts — the locks:check_command HANDLER (checkBashCommand mocked; its
 * matcher logic is covered in resource-command-match.integration.test.ts). Thin, but pins
 * that the handler resolves identity and forwards the command + coordinationDomain + owner
 * to the verdict engine, then spreads { ok:true, ...verdict } (decision + matched). A
 * regression that drops the identity scoping or the verdict spread is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/check_command.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// WI-38252: file locks resolve their default domain via readFileLockIdentity.
vi.mock('./identity', () => {
  const identity = vi.fn(() => ({ ownerId: 'me', coordinationDomain: 'dom' }));
  return { readIdentity: identity, readFileLockIdentity: identity };
});
vi.mock('./resource-command-match', () => ({ checkBashCommand: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws') }));
vi.mock('../../bash-substitution/registry', () => ({ getSubstitutionRows: vi.fn() }));

import { checkBashCommand } from './resource-command-match';
import { getSubstitutionRows } from '../../bash-substitution/registry';
import { fileLockCoordinationDomain } from './coordination-domain';
import { unsafeDependencyInstall } from '../../bash-substitution/pairs/dependency-install';
const checkM = vi.mocked(checkBashCommand);
const rowsM = vi.mocked(getSubstitutionRows);
const tool = (await import('./check_command')).default;

/** A registry row shaped as the matcher consumes it. */
const sedRow = {
  intentLabel: 'file-range-read',
  bashPattern: String.raw`sed\s+-n\s+['"]?\s*\d+\s*,\s*\d+\s*p['"]?\s+\S`,
  bashPatternFlags: '',
  toolName: 'capability:read',
  tier: 'advise' as const,
  advisoryText: 'capability:read { file_path, offset, limit } reads a line range directly.',
  equivalenceVerdict: 'equivalent' as const,
};

const dependencyRow = {
  intentLabel: unsafeDependencyInstall.intentLabel,
  bashPattern: unsafeDependencyInstall.bashPattern.source,
  bashPatternFlags: unsafeDependencyInstall.bashPattern.flags,
  toolName: unsafeDependencyInstall.toolName,
  tier: 'deny' as const,
  advisoryText: unsafeDependencyInstall.advisoryText,
  equivalenceVerdict: unsafeDependencyInstall.expectedVerdict,
};

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  rowsM.mockResolvedValue([]);
});

describe('locks:check_command handler', () => {
  it('forwards command + identity and spreads the verdict', async () => {
    checkM.mockResolvedValue({ decision: 'block', matched: ['dev-server'] } as never);
    const out = (await tool.handler({ command: 'systemctl restart papercup' } as never, {} as never)) as Out;
    expect(checkM).toHaveBeenCalledWith({ command: 'systemctl restart papercup', coordinationDomain: 'dom', ownerId: 'me' });
    expect(body(out)).toMatchObject({ ok: true, decision: 'block', matched: ['dev-server'] });
  });

  it('passes an allow verdict through', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    expect(body((await tool.handler({ command: 'ls' } as never, {} as never)) as Out)).toMatchObject({ ok: true, decision: 'allow' });
  });
});

describe('substitution verdict fold (P-015)', () => {
  it('reports the matched registry row and its tier alongside the lock verdict', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    rowsM.mockResolvedValue([sedRow]);

    const out = body((await tool.handler(
      { command: "cd /repo && sed -n '1,40p' a.ts" } as never, {} as never,
    )) as Out);

    expect(out.substitutionTier).toBe('advise');
    expect(out.substitutions).toHaveLength(1);
    expect(out.substitutions[0]).toMatchObject({
      intentLabel: 'file-range-read',
      toolName: 'capability:read',
      atom: "sed -n '1,40p' a.ts",
    });
  });

  it('NEVER lets a substitution match change the lock decision', async () => {
    // Existing consumers key on `decision === 'block'`. A registry row about
    // `cat` has nothing to say about whether a peer is mid-migration, and
    // conflating them would give a routine advisory a resource gate's power.
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    rowsM.mockResolvedValue([{ ...sedRow, tier: 'deny' as const }]);

    const out = body((await tool.handler({ command: "sed -n '1,40p' a.ts" } as never, {} as never)) as Out);
    expect(out.decision).toBe('allow');
    expect(out.substitutionTier).toBe('deny');
  });

  it('fails open: a registry read error yields no substitutions but keeps the lock verdict', async () => {
    checkM.mockResolvedValue({ decision: 'block', matched: ['dev-server'] } as never);
    rowsM.mockRejectedValue(new Error('pg down'));

    const out = body((await tool.handler({ command: "sed -n '1,40p' a.ts" } as never, {} as never)) as Out);
    expect(out).toMatchObject({ ok: true, decision: 'block', substitutions: [], substitutionTier: null });
  });

  it('scopes the registry read to the caller workspace when ctx carries one', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    await tool.handler({ command: 'ls' } as never, { workspaceId: 'other-ws' } as never);
    expect(rowsM).toHaveBeenCalledWith('other-ws');
  });

  it('falls back to the active workspace for a wildcard/absent ctx scope', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    await tool.handler({ command: 'ls' } as never, { workspaceId: '*' } as never);
    expect(rowsM).toHaveBeenCalledWith('ws');
  });

  it('uses the handler cwd to exempt an install in an independent tree', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    rowsM.mockResolvedValue([dependencyRow]);

    const out = body((await tool.handler(
      { command: 'npm install', cwd: '/tmp/wi204040-scratch' } as never,
      {} as never,
    )) as Out);

    expect(out.substitutions).toEqual([]);
    expect(out.substitutionTier).toBeNull();
  });

  it('keeps the deny for an install in the canonical file-lock tree', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    rowsM.mockResolvedValue([dependencyRow]);

    const out = body((await tool.handler(
      { command: 'npm install', cwd: fileLockCoordinationDomain() } as never,
      {} as never,
    )) as Out);

    expect(out.substitutions).toHaveLength(1);
    expect(out.substitutionTier).toBe('deny');
  });
});
