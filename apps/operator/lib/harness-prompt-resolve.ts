/**
 * 3-tier per-harness prompt resolution + D-6 seed/reset. (Phase 1b of
 * harnesses-across-workspaces, decisions D-6/D-7.)
 *
 * The live per-(workspace,harness,role) prompt override is sourced from the
 * workspace-owned PG store (lib/harness-prompt-overrides). The repo files at
 * `<path>/.harness/prompts/<role>.md` become *seed defaults*: on install they
 * are imported into the PG store; thereafter the workspace owns the live value.
 *
 * `resolveHarnessPromptOverride` keeps an **on-disk fallback** so this is
 * regression-safe: if the PG store has no override for a role, it returns the
 * repo seed file's content (exactly today's behavior). So an un-migrated /
 * un-seeded harness behaves identically until something writes to the store.
 *
 * This module is the override LAYER only; composing it with the global base
 * role prompt + workspace default (the full 3 tiers) happens where prompts are
 * assembled (the orchestrator read-repoint is the follow-up cutover).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  getPromptOverride,
  setPromptOverride,
  deletePromptOverride,
  listPromptOverrides,
} from './harness-prompt-overrides';

/** `<harnessPath>/.harness/prompts` — where repo seed prompts live. */
function seedDir(harnessPath: string): string {
  return join(harnessPath, '.harness', 'prompts');
}

/** Repo seed markdown for a role, or null when the harness ships none. */
export function readSeedPrompt(harnessPath: string, role: string): string | null {
  const p = join(seedDir(harnessPath), `${role}.md`);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** Roles that have a repo seed file (`.harness/prompts/<role>.md`). */
export function listSeedRoles(harnessPath: string): string[] {
  const d = seedDir(harnessPath);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort();
}

/**
 * The effective per-harness prompt override for a role: the workspace-owned PG
 * value if set, else the repo seed file (regression-safe fallback), else null
 * (no override — caller uses the base/workspace-default tiers).
 */
export async function resolveHarnessPromptOverride(
  workspaceId: string,
  harnessSlug: string,
  role: string,
  harnessPath: string,
): Promise<string | null> {
  const stored = await getPromptOverride(workspaceId, harnessSlug, role);
  if (stored !== null) return stored;
  return readSeedPrompt(harnessPath, role);
}

/**
 * D-6 seed: import the harness's repo `.harness/prompts/*.md` into the
 * workspace's override store. Called on install/link. By default does NOT
 * overwrite existing workspace overrides (skip-if-present) so re-installing
 * never clobbers a workspace's live tuning; pass `overwrite` to force.
 */
export async function seedPromptOverridesFromRepo(
  workspaceId: string,
  harnessSlug: string,
  harnessPath: string,
  opts: { overwrite?: boolean } = {},
): Promise<{ seeded: string[]; skipped: string[] }> {
  const seeded: string[] = [];
  const skipped: string[] = [];
  for (const role of listSeedRoles(harnessPath)) {
    if (!opts.overwrite && (await getPromptOverride(workspaceId, harnessSlug, role)) !== null) {
      skipped.push(role);
      continue;
    }
    const md = readSeedPrompt(harnessPath, role);
    if (md !== null) {
      await setPromptOverride(workspaceId, harnessSlug, role, md);
      seeded.push(role);
    }
  }
  return { seeded, skipped };
}

/**
 * D-6 reset-to-default for ONE role: re-import the repo seed (= "pull the
 * latest default"). When the harness ships no seed for the role, clear the
 * workspace override instead so the role falls back to the base/workspace tier.
 */
export async function resetPromptOverrideToDefault(
  workspaceId: string,
  harnessSlug: string,
  role: string,
  harnessPath: string,
): Promise<{ role: string; restoredFromSeed: boolean; cleared: boolean }> {
  const md = readSeedPrompt(harnessPath, role);
  if (md !== null) {
    await setPromptOverride(workspaceId, harnessSlug, role, md);
    return { role, restoredFromSeed: true, cleared: false };
  }
  const existed = await deletePromptOverride(workspaceId, harnessSlug, role);
  return { role, restoredFromSeed: false, cleared: existed };
}

/**
 * D-6 reset-all: reset every role that either ships a seed or has a workspace
 * override (the union — so the "Reset all" button on a role-group view clears
 * stray edits too). Caller confirms before invoking (it overwrites edits).
 */
export async function resetAllPromptOverridesToDefault(
  workspaceId: string,
  harnessSlug: string,
  harnessPath: string,
): Promise<{ reset: string[] }> {
  const seedRoles = listSeedRoles(harnessPath);
  const overridden = (await listPromptOverrides(workspaceId, harnessSlug)).map((o) => o.role);
  const roles = [...new Set([...seedRoles, ...overridden])].sort();
  for (const role of roles) {
    await resetPromptOverrideToDefault(workspaceId, harnessSlug, role, harnessPath);
  }
  return { reset: roles };
}
