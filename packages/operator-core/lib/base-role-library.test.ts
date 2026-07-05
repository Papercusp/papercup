/**
 * base-role-library.test.ts — blueprint-role-bundling-2026-06-15 Phase 2/6.
 *
 * Verifies the keystone outcome: `blueprints/base/prompts/` is the shared role
 * library — every built-in spawnable role (AGENT_ROLES) resolves WITHOUT a phase
 * and WITHOUT a blueprintId (i.e. straight from base), except the handful whose
 * personas still live only in the legacy phase subdirs (tracked for the Phase 5
 * relocation). This is the durable invariant that gates deleting the global
 * `prompts/` dir (Phase 5): the day base alone resolves every role, the global
 * backstop is dead weight.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolvePromptFile, resolvePromptFiles } from '@papercusp/orchestrator';
import { AGENT_ROLES } from '@papercusp/agent-mcp';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/operator-core/lib → repo root is three up; the harness pkg holds prompts/ + blueprints/.
const HARNESS_DIR = resolve(__dirname, '../../../libs/papercusp/packages/harness');

// Chat-surface roles are answered inline, never spawned from a prompt file.
const CHAT_ROLES = new Set(['operator', 'oracle']);

// Roles whose persona still lives ONLY in a legacy phase subdir
// (prompts/{staging,testing,production}/<role>.md) and is dispatched live by the
// multi-phase orchestrator (classifyDecision). They are NOT yet in the base
// library — relocating them (or threading the harness blueprintId) is the
// Phase 5 prerequisite before the global prompts/ dir can be deleted.
const PHASE_ONLY_ROLES = new Set(['tester', 'test-writer', 'monitor']);

// Roles bundled in a SPECIFIC blueprint (not the shared base library) — Phase 3.
// `bee` is the Hive's generic worker; its persona lives at
// blueprints/coding/prompts/bee.md, resolved via the hive blueprint (or the global
// backstop until the harness blueprintId is threaded in Phase 5).
const BLUEPRINT_BUNDLED_ROLES = new Set(['cup']);

// pot-rename SLICE-2 (EXPAND): additive alias role that resolves via ROLE_ALIASES to a
// canonical WITHOUT its own base persona. `blender`→`scout`, and `scout` ships NO
// persona in base or any blueprint (the negative-space scanner's persona is
// `scanner.md`), so blender has no base-library prompt of its own. The other new
// aliases (cup/mug/papercup/kettle) DO resolve via their canonical's base persona and
// stay in the enumeration; drop only the currently-unresolvable one until the
// scout/blender persona lands in a later slice.
const UNRESOLVED_ALIAS_ROLES = new Set(['blender']);

const spawnable = AGENT_ROLES.filter((r) => !CHAT_ROLES.has(r));
const baseLibraryRoles = spawnable.filter(
  (r) => !PHASE_ONLY_ROLES.has(r) && !BLUEPRINT_BUNDLED_ROLES.has(r) && !UNRESOLVED_ALIAS_ROLES.has(r),
);

const BASE_PROMPTS = join('blueprints', 'base', 'prompts');

describe('base is the shared role library (Phase 2)', () => {
  it.each(baseLibraryRoles)(
    'role "%s" resolves ENTIRELY from base with NO phase and NO blueprintId',
    (role) => {
      const files = resolvePromptFiles({ harnessDir: HARNESS_DIR, phase: '', dept: '' }, role);
      expect(
        files.length,
        `role "${role}" must resolve with no phase/blueprintId — its persona should live under blueprints/base/prompts/`,
      ).toBeGreaterThan(0);
      // Every composed section comes from the base blueprint — no global leakage
      // when there is no phase/blueprint override. (A concrete role resolves to
      // <role>.md; a prefix-only role like orchestrator to <role>.base.md.)
      for (const f of files) {
        expect(f, `role "${role}" leaked a non-base section: ${f}`).toContain(BASE_PROMPTS);
      }
    },
  );

  it('the generic prefix roles compose [<role>.base.md, <role>.md] from base', () => {
    // worker/validator/documenter/orchestrator/summarizer carry a generic
    // "Base <Role>" prefix layer relocated to blueprints/base/prompts/<role>.base.md.
    for (const role of ['worker', 'validator', 'documenter']) {
      const files = resolvePromptFiles({ harnessDir: HARNESS_DIR, phase: '', dept: '' }, role);
      expect(files.length, `${role} should compose prefix + concrete`).toBe(2);
      expect(files[0]).toContain(join('blueprints', 'base', 'prompts', `${role}.base.md`));
      expect(files[1]).toContain(join('blueprints', 'base', 'prompts', `${role}.md`));
    }
  });

  it('the phase-only roles still resolve via their phase subdir (Phase 5 relocation pending)', () => {
    expect(resolvePromptFile({ harnessDir: HARNESS_DIR, phase: 'testing', dept: '' }, 'tester')).toBeTruthy();
    expect(resolvePromptFile({ harnessDir: HARNESS_DIR, phase: 'testing', dept: '' }, 'test-writer')).toBeTruthy();
    expect(resolvePromptFile({ harnessDir: HARNESS_DIR, phase: 'production', dept: '' }, 'monitor')).toBeTruthy();
  });
});

describe('the hive is the self-contained Queen + colony blueprint (Phase 3)', () => {
  it('the hive blueprint bundles bee/queen/operator/overwatch', () => {
    for (const role of ['cup', 'mug', 'operator', 'kettle']) {
      const p = join(HARNESS_DIR, 'blueprints', 'coding', 'prompts', `${role}.md`);
      expect(existsSync(p), `hive should bundle ${role}.md`).toBe(true);
    }
  });

  it('a hive-context spawn resolves cup from blueprints/coding/prompts/cup.md', () => {
    const found = resolvePromptFile(
      { harnessDir: HARNESS_DIR, phase: '', dept: '', blueprintId: 'coding' },
      'cup',
    );
    expect(found).toBe(join(HARNESS_DIR, 'blueprints', 'coding', 'prompts', 'cup.md'));
  });

  it('a hive-context spawn resolves the queen/overwatch OVERRIDE over the base copy', () => {
    for (const role of ['mug', 'kettle']) {
      const found = resolvePromptFile(
        { harnessDir: HARNESS_DIR, phase: '', dept: '', blueprintId: 'coding' },
        role,
      );
      expect(found, `hive ${role} should win`).toBe(
        join(HARNESS_DIR, 'blueprints', 'coding', 'prompts', `${role}.md`),
      );
    }
  });
});
