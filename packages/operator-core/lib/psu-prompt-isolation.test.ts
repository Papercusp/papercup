/**
 * psu-prompt-isolation.test.ts — the cross-client regression guard for
 * "a psu session is governed ONLY by psu" (psu-isolation-and-blueprint-aware-
 * harness-ui-2026-06-09, P-005).
 *
 * Phase A isolated three client launch paths from the launching user's personal
 * config while still delivering the psu playbook + the repo project guide:
 *   - P-001 — renderSuPlaybook splices the repo CLAUDE.md at the PROJECT-GUIDE
 *     marker (engineer profile), so the guide reaches psu via the assembled
 *     prompt, NOT client auto-load.
 *   - P-002 — writeInteractiveClaudeConfig (claude) skip-links the personal
 *     memory files (CLAUDE.md/AGENTS.md) from the per-session CLAUDE_CONFIG_DIR.
 *   - P-003 — the installer sets OMP `memory.backend off` (no native memory).
 *   - P-004 — writeSuCodexHome bakes `project_doc_max_bytes = 0` + `[features]
 *     memory_tool = false` (no cwd ./AGENTS.md read, no native memory).
 *
 * The per-mechanism unit tests live beside each source (papercusp-files.test,
 * interactive-claude-config.test, role-codex-home.test) and check each launch
 * config in isolation with fixtures. THIS file is the consolidated contract over
 * the REAL repo playbook + CLAUDE.md: it asserts every client's assembled prompt
 * carries the playbook + the project guide, leaks no personal config, and ships
 * no literal marker — and that the installer no longer arms OMP native memory.
 * Deterministic (no LLM / API cost): per the su-suite design, structural prompt
 * properties are checked by deterministic assertions, not judge runs.
 */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSuPlaybook } from './desktop-install/papercusp-files';
import { SU_AGENTS } from './su-agents';

/** Walk up from cwd to the repo root (the dir carrying CLAUDE.md + the engineer
 *  playbook) — robust whether the walker runs from the package or the repo. */
function findRepoRoot(): string {
  let d = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (
      existsSync(join(d, 'CLAUDE.md')) &&
      existsSync(join(d, 'apps', 'operator', 'prompts', 'papercusp-su-engineer.tools.md'))
    ) {
      return d;
    }
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  throw new Error(`psu-prompt-isolation.test: could not locate repo root from ${process.cwd()}`);
}

const repoRoot = findRepoRoot();
const operatorAppRoot = join(repoRoot, 'apps', 'operator');

describe('psu prompt isolation — assembled engineer prompt (P-005, real playbook + CLAUDE.md)', () => {
  for (const agent of SU_AGENTS) {
    it(`${agent}: prompt = psu playbook + repo project guide, no personal config, no leaked markers`, async () => {
      const r = await renderSuPlaybook({ agent, operatorAppRoot });

      // (b) DOES see the psu playbook ...
      expect(r.text).toContain('Named workflows'); // a stable engineer-playbook section
      // ... AND the repo project guide, delivered by the P-001 splice (not auto-load).
      expect(r.text).toContain('Project guide — repo conventions'); // the splice wrapper header
      expect(r.text).toContain('nuqs'); // a CLAUDE.md sentinel (the nuqs policy)
      expect(r.projectGuideSource.endsWith('CLAUDE.md')).toBe(true);

      // (a) does NOT carry the launching user's personal config: the spliced guide
      // is the REPO's project guide, never the owner's ~/.claude/AGENTS.md memory
      // rules (whose signature line is "edit topic files / never MEMORY.md").
      expect(r.text).not.toMatch(/edit topic files/i);

      // A literal generated-section marker is never shipped.
      expect(r.text).not.toContain('<!-- PAPERCUSP-SU:');
    });
  }
});

describe('psu prompt isolation — installer no longer enables OMP native memory (P-003)', () => {
  it('install-standalone-mcp.sh sets memory.backend off, not hindsight', () => {
    const installer = readFileSync(join(operatorAppRoot, 'scripts', 'install-standalone-mcp.sh'), 'utf8');
    expect(installer).toContain('set_omp_config "memory.backend" "off"');
    expect(installer).not.toContain('"memory.backend" "hindsight"');
  });
});

/**
 * EI-148 — the repo CLAUDE.md (symlinked as AGENTS.md) is the project guide a psu
 * session gets ON PURPOSE via the P-001 splice. But self-hosting BEES whose cwd is
 * this checkout ALSO auto-load it: role spawns use --append-system-prompt, which
 * keeps the backend's default project-memory loading ON (only MCP is locked, via
 * --strict-mcp-config). A bee's supervisor is the Queen, not a human in a chat —
 * so human-interaction-with-the-USER imperatives ("deferring is the USER's call",
 * "re-surface every deferred item to the USER in every status update") must live
 * ONLY in the psu engineer playbook, never in the auto-loaded repo guide, or the
 * bee gets pointed at a human who is not in its loop. A descriptive POINTER that
 * says "those rules live in the playbook" is fine; an imperative is not.
 */
describe('repo project guide leaks no human-facing interaction rule to self-hosting bees (EI-148)', () => {
  const claudeMd = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
  const engineerPlaybook = readFileSync(
    join(operatorAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
    'utf8',
  );

  it('AGENTS.md is the same content as CLAUDE.md (symlink) — guarding one guards both', () => {
    expect(readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8')).toBe(claudeMd);
  });

  it('CLAUDE.md carries no human-to-the-USER imperative', () => {
    expect(claudeMd).not.toMatch(/the user's call/i);
    expect(claudeMd).not.toMatch(/so the user knows/i);
    expect(claudeMd).not.toMatch(/EVERY deferred item in EVERY status update/);
    // any directive aiming a status update / deferral at "the user" is a leak
    expect(claudeMd).not.toMatch(/(status update|deferred item)[^.]*\bto the user\b/i);
  });

  it('the psu engineer playbook still carries those rules (a MOVE, not a delete)', () => {
    expect(engineerPlaybook).toMatch(/Deferring is the user's call/i);
    expect(engineerPlaybook).toMatch(/Surface EVERY deferred item in EVERY status update/);
  });
});
