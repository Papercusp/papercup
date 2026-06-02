/**
 * Unit test for the saved-prompts workspace-HOME resolver. Workspace-global
 * prompts must materialize where the launched client actually reads user-scope
 * commands — i.e. `$HOME/.claude/commands`, where `$HOME` is the HOME the
 * client inherits from the operator (no launcher remap; P-012). That is
 * `os.homedir()`: the per-workspace dir on desktop, the real home on a dev box.
 */
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { workspaceCommandsDir } from './saved-prompts-materialize';

describe('workspaceCommandsDir', () => {
  it("targets the inherited HOME's .claude/commands (where the client reads user-scope commands)", () => {
    expect(workspaceCommandsDir()).toBe(join(homedir(), '.claude', 'commands'));
  });
});
