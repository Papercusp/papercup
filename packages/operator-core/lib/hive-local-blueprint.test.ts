/**
 * hive-local-blueprint.test.ts — P-012 (domain-generic-hive-architecture-2026-06-18).
 * Pins the materialization contract: composed full persona files in a dedicated,
 * wholesale-cleaned local-tier root; null when there's no override; and — the payoff —
 * the tier-aware prompt resolver (P-014) picks the materialized file over the built-in.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  materializeHiveLocalBlueprint,
  hiveLocalBlueprintRoot,
  readFileOrNull,
} from './hive-local-blueprint';
import { resolvePromptFile } from '@papercusp/orchestrator/role-prompt';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('materializeHiveLocalBlueprint', () => {
  it('returns null and writes nothing when there are no overrides', async () => {
    const hiveDir = tempDir('hlb-none-');
    const res = await materializeHiveLocalBlueprint(
      { hiveBlueprintId: 'coding', hiveDir },
      { readOverrides: async () => ({}), readBuiltinPersona: () => null },
    );
    expect(res).toBeNull();
    expect(existsSync(hiveLocalBlueprintRoot(hiveDir))).toBe(false);
  });

  it('composes built-in persona + override delta into a complete file', async () => {
    const hiveDir = tempDir('hlb-compose-');
    const res = await materializeHiveLocalBlueprint(
      { hiveBlueprintId: 'coding', hiveDir },
      {
        readOverrides: async () => ({ mug: 'PAPERCUSP QUEEN SPECIFICS' }),
        readBuiltinPersona: (role) => (role === 'mug' ? '# Built-in Queen' : null),
      },
    );
    expect(res).not.toBeNull();
    expect(res!.materializedRoles).toEqual(['mug']);
    const file = join(res!.localRoot, 'blueprints', 'coding', 'prompts', 'mug.md');
    expect(readFileSync(file, 'utf8')).toBe('# Built-in Queen\n\n---\n\nPAPERCUSP QUEEN SPECIFICS\n');
  });

  it('writes the override alone when there is no built-in persona', async () => {
    const hiveDir = tempDir('hlb-solo-');
    const res = await materializeHiveLocalBlueprint(
      { hiveBlueprintId: 'work', hiveDir },
      { readOverrides: async () => ({ cup: 'WORK BEE' }), readBuiltinPersona: () => null },
    );
    const file = join(res!.localRoot, 'blueprints', 'work', 'prompts', 'cup.md');
    expect(readFileSync(file, 'utf8')).toBe('WORK BEE\n');
  });

  it('skips empty/blank overrides', async () => {
    const hiveDir = tempDir('hlb-blank-');
    const res = await materializeHiveLocalBlueprint(
      { hiveBlueprintId: 'coding', hiveDir },
      {
        readOverrides: async () => ({ mug: '   ', cup: 'real' }),
        readBuiltinPersona: () => null,
      },
    );
    expect(res!.materializedRoles).toEqual(['cup']);
  });

  it('is idempotent + cleans stale roles: a removed override leaves no file', async () => {
    const hiveDir = tempDir('hlb-clean-');
    await materializeHiveLocalBlueprint(
      { hiveBlueprintId: 'coding', hiveDir },
      { readOverrides: async () => ({ mug: 'q', cup: 'b' }), readBuiltinPersona: () => null },
    );
    // Re-materialize with `bee` removed.
    const res2 = await materializeHiveLocalBlueprint(
      { hiveBlueprintId: 'coding', hiveDir },
      { readOverrides: async () => ({ mug: 'q2' }), readBuiltinPersona: () => null },
    );
    const dir = join(res2!.localRoot, 'blueprints', 'coding', 'prompts');
    expect(existsSync(join(dir, 'mug.md'))).toBe(true);
    expect(existsSync(join(dir, 'cup.md'))).toBe(false);
    expect(readFileSync(join(dir, 'mug.md'), 'utf8')).toBe('q2\n');
  });

  it('does NOT touch a hand-authored .papercusp/blueprints tree (dedicated root)', async () => {
    const hiveDir = tempDir('hlb-handauthored-');
    const handDir = join(hiveDir, '.papercusp', 'blueprints', 'coding', 'prompts');
    mkdirSync(handDir, { recursive: true });
    writeFileSync(join(handDir, 'scoper.md'), 'HAND AUTHORED');
    await materializeHiveLocalBlueprint(
      { hiveBlueprintId: 'coding', hiveDir },
      { readOverrides: async () => ({ mug: 'q' }), readBuiltinPersona: () => null },
    );
    // The materialized root is separate (.materialized), so the hand-authored file survives.
    expect(readFileSync(join(handDir, 'scoper.md'), 'utf8')).toBe('HAND AUTHORED');
    expect(hiveLocalBlueprintRoot(hiveDir)).not.toContain(join('.papercusp', 'blueprints'));
  });
});

describe('end-to-end with the tier-aware resolver (P-012 + P-014)', () => {
  it('the materialized local root makes the resolver pick the hive override over built-in', async () => {
    const hiveDir = tempDir('hlb-e2e-');
    // A built-in tier with the coding blueprint + a built-in queen.
    const builtin = tempDir('hlb-e2e-builtin-');
    mkdirSync(join(builtin, 'blueprints', 'coding', 'prompts'), { recursive: true });
    writeFileSync(join(builtin, 'blueprints', 'coding', 'blueprint.yaml'), 'id: coding\nextends: base\n');
    writeFileSync(join(builtin, 'blueprints', 'coding', 'prompts', 'mug.md'), '# Built-in Queen');
    writeFileSync(join(builtin, 'blueprints', 'coding', 'prompts', 'scoper.md'), '# Built-in Scoper');

    const res = await materializeHiveLocalBlueprint(
      { hiveBlueprintId: 'coding', hiveDir },
      {
        readOverrides: async () => ({ mug: 'HIVE QUEEN DELTA' }),
        readBuiltinPersona: (role) =>
          readFileOrNull(join(builtin, 'blueprints', 'coding', 'prompts', `${role}.md`)),
      },
    );

    const ctx = {
      harnessDir: builtin,
      phase: '',
      dept: '',
      blueprintId: 'coding',
      blueprintRoots: [res!.localRoot],
    };
    // queen → the materialized local file (override applied)
    expect(resolvePromptFile(ctx, 'mug')).toBe(
      join(res!.localRoot, 'blueprints', 'coding', 'prompts', 'mug.md'),
    );
    // scoper (not overridden) → falls through to built-in
    expect(resolvePromptFile(ctx, 'scoper')).toBe(
      join(builtin, 'blueprints', 'coding', 'prompts', 'scoper.md'),
    );
  });
});
