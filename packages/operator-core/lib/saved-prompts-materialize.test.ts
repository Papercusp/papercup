/**
 * Unit test for the saved-prompts workspace-HOME resolver. Workspace-global
 * prompts must materialize where the launched client actually reads user-scope
 * commands — i.e. `$HOME/.claude/commands`, where `$HOME` is the HOME the
 * client inherits from the operator (no launcher remap; P-012). That is
 * `os.homedir()`: the per-workspace dir on desktop, the real home on a dev box.
 *
 * These tests pin the D-008 invariant from BOTH sides so a future change can't
 * silently break workspace-prompt materialization:
 *   1. the resolver: workspaceCommandsDir() === <inherited HOME>/.claude/commands
 *   2. its precondition: the launch env builder does NOT set the child's HOME,
 *      so the child inherits os.homedir() (what the resolver assumes).
 * If a launcher ever DOES remap the child's unix $HOME per-workspace, test (2)
 * fails first — at which point workspaceHomeDir() must be changed to resolve
 * the same HOME the launcher sets (see decision D-008).
 */
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { workspaceCommandsDir } from './saved-prompts-materialize';
import { resolveContextEnv } from './spawn-config';

describe('workspaceCommandsDir', () => {
  it("targets the inherited HOME's .claude/commands (where the client reads user-scope commands)", () => {
    expect(workspaceCommandsDir()).toBe(join(homedir(), '.claude', 'commands'));
  });

  it('D-008 invariant: the launch env does NOT remap the child HOME (so the inherited homedir() is correct)', () => {
    // If this fails, a launcher started setting the child's unix HOME. The
    // child no longer inherits os.homedir(), so workspaceHomeDir() must be
    // updated to resolve the same HOME the launcher now sets. See D-008.
    const env = resolveContextEnv({ slug: '', stateDir: null });
    expect(Object.keys(env)).not.toContain('HOME');
  });
});
