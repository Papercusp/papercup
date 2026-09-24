/**
 * EI-996 — su-tier role addendum resolution.
 *
 * Covers the two halves the owner ask turns on:
 *   1. the ALLOW-LIST is a closed set of role NAMES (no free-text prompt append
 *      on a superuser-tier launch path), and
 *   2. every listed role actually HAS a prompt source in the repo — otherwise a
 *      su-tier launch silently degrades to a plain su session with no role lines.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinBlueprintPath } from '@papercusp/orchestrator/blueprint';

import {
  SU_TIER_ROLES,
  isSuTierRole,
  resolveSuRoleAddendum,
} from './su-role-addendum';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const OPERATOR_APP_ROOT = join(REPO_ROOT, 'apps', 'operator');

function withPromptsDir(fn: (appRoot: string, promptsDir: string) => void): void {
  const appRoot = mkdtempSync(join(tmpdir(), 'su-role-addendum-'));
  const promptsDir = join(appRoot, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  try {
    fn(appRoot, promptsDir);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
}

describe('su-tier role allow-list', () => {
  it('planner is a su-tier role (owner ask 2026-06-17)', () => {
    expect(SU_TIER_ROLES).toContain('planner');
    expect(isSuTierRole('planner')).toBe(true);
  });

  it('rejects anything not on the list — the list is the whole security boundary', () => {
    // A su-tier launch grants the SUPERUSER MCP tier, so admission must be a
    // closed set: no prefix/suffix/case leniency, no empty-string pass.
    for (const notARole of ['worker', 'su', 'planner ', 'Planner', 'planner-x', '', null, undefined]) {
      expect(isSuTierRole(notARole as string | null | undefined)).toBe(false);
    }
  });

  it('every su-tier role has a real canonical identity prompt', () => {
    // The compatibility role still needs a real document or it would launch
    // with superuser authority but no specialization.
    for (const role of SU_TIER_ROLES) {
      const text = resolveSuRoleAddendum(role);
      expect(text, `missing identity document for ${role}`).toBeTruthy();
      expect(text!.length).toBeGreaterThan(40);
    }
  });

  it('the planner role uses exactly the authored specialist identity document', () => {
    const text = resolveSuRoleAddendum('planner')!;
    const source = join(dirname(builtinBlueprintPath('su.specialist-planner')), 'prompts', 'practice.md');
    expect(text).toBe(readFileSync(source, 'utf8').trim());
    expect(text).toContain('PLANNER');
    expect(text).toContain('plans:');
  });
});

describe('resolveSuRoleAddendum', () => {
  it('reads <appRoot>/prompts/su-role-<role>.addendum.md', () => {
    withPromptsDir((appRoot, promptsDir) => {
      writeFileSync(join(promptsDir, 'su-role-planner.addendum.md'), '## PLANNER LINES\n');
      expect(resolveSuRoleAddendum('planner', { operatorAppRoot: appRoot })).toBe('## PLANNER LINES');
    });
  });

  it('returns null for a role that is not su-tier, even if a file exists', () => {
    // Resolution must not be a second, weaker admission path around the allow-list.
    withPromptsDir((appRoot, promptsDir) => {
      writeFileSync(join(promptsDir, 'su-role-worker.addendum.md'), 'ARBITRARY PROMPT TEXT');
      expect(resolveSuRoleAddendum('worker', { operatorAppRoot: appRoot })).toBeNull();
    });
  });

  it('returns null (does not throw) when the source file is missing or blank', () => {
    // Degrade to a plain su session rather than failing the launch outright — the
    // role still gets the su tier, which is the half the owner actually asked for.
    withPromptsDir((appRoot) => {
      expect(resolveSuRoleAddendum('planner', { operatorAppRoot: appRoot })).toBeNull();
    });
    withPromptsDir((appRoot, promptsDir) => {
      writeFileSync(join(promptsDir, 'su-role-planner.addendum.md'), '   \n\n  ');
      expect(resolveSuRoleAddendum('planner', { operatorAppRoot: appRoot })).toBeNull();
    });
  });

  it('auto-discovers the prompt source WITHOUT an explicit root, independent of cwd', () => {
    // The regression this pins: bootstrap-su calls resolveSuRoleAddendum(role)
    // with no root, so resolution fell back to process.cwd()-rooted candidates.
    // Vitest runs from packages/operator-core, where those resolve NOTHING — a
    // planner would have launched at the SUPERUSER tier with no role lines at
    // all, looking configured. It only worked because the operator happens to
    // run from the repo root, which is what kept it invisible.
    expect(resolveSuRoleAddendum('planner')).toBeTruthy();
  });

  it('returns null for null/undefined/empty role', () => {
    expect(resolveSuRoleAddendum(null)).toBeNull();
    expect(resolveSuRoleAddendum(undefined)).toBeNull();
    expect(resolveSuRoleAddendum('')).toBeNull();
  });
});

describe('launcher/server share ONE role list', () => {
  it('psu-launcher.mjs imports su-tier-roles.mjs instead of declaring its own copy', () => {
    // Structural, not advisory: psu-launcher.mjs is bare-node .mjs and cannot
    // import the TS module, so the ONLY thing preventing a silently-drifting
    // second copy is that both sides import this one plain-ESM file. A launcher
    // that re-declares the list routes roles the server would reject (or vice
    // versa), and both directions fail quietly at launch time.
    const launcher = readFileSync(join(OPERATOR_APP_ROOT, 'scripts', 'psu-launcher.mjs'), 'utf8');
    // Quote-agnostic: formatting sweeps have flipped the launcher between quote styles
    // (single→double 2026-08-22) while the pinned property — ONE shared role list — held.
    expect(launcher).toMatch(
      /from ['"]\.\.\/\.\.\/\.\.\/packages\/operator-core\/lib\/su-tier-roles\.mjs['"]/,
    );
    expect(launcher).not.toMatch(/^\s*(const|let|var)\s+SU_TIER_ROLES\s*=/m);
  });
});
