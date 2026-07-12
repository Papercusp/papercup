/**
 * WI-3661 regression guard. The dock 🛡 Papercup pane launches via psu-sentinel.sh.
 * The persona/role was renamed sentinel→papercup (PROMPT_ROLES + the papercup.*
 * prompt set / blueprints/base/prompts/papercup.md); the launcher must pass
 * `--role=papercup`. Passing the retired `--role=sentinel` makes assembleRolePrompt
 * fail to resolve the (renamed) prompt files and the pane's psu agent errors out
 * "about the sentinel". Pin the role flag so a copy-paste or a revert can't silently
 * re-break the pane.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const script = readFileSync(join(__dirname, 'psu-sentinel.sh'), 'utf8');

describe('psu-sentinel.sh (dock Papercup pane launcher)', () => {
  it('launches the renamed papercup role, not the retired sentinel role', () => {
    // Assert on the exec LINE (not the whole file — the header comment explains
    // the retired `--role=sentinel` and would false-match a whole-file negative).
    const execLine = script.split('\n').find((l) => l.trimStart().startsWith('exec psu')) ?? '';
    expect(execLine).toMatch(/--role=papercup/);
    expect(execLine).not.toMatch(/--role=sentinel/);
  });

  // voice-public-release-readiness D-007: the pane is the papercup-fast voice
  // front-end — with no staged override it must default to a FAST model spec,
  // never fall through to the (heavy) workspace default that made voice turns
  // time out against a slow pane. Pin the default so a revert can't silently
  // re-break voice.
  it('defaults the pane model to a fast spec when no override is staged (D-007)', () => {
    expect(script).toContain("spec='sonnet:medium'");
    // model_args always carries a --model flag (default or override).
    expect(script).toContain('model_args=("--model=$spec")');
  });
});
