/**
 * DOC CLAIM — the su playbooks' hand-written mode index must list EVERY
 * registered mode (goal-mode-hardening-2026-08-10 P-008, closes
 * EI-20049215753845461).
 *
 * WHY THIS GUARD HAS TO EXIST. `modeIndexMarkdown()` in modes/registry.ts
 * derives an index from MODES, and its doc comment says that index is what
 * always-present prompts carry — but grep across packages/apps/libs finds NO
 * production consumer of it, only its own unit test. What agents actually read
 * is the index HAND-WRITTEN into each su playbook, and a hand-written list has
 * no mechanical relationship to the registry it describes.
 *
 * So it drifted, silently and in the only direction that matters: the registry
 * defined six modes while both playbooks listed five. GOAL — the mode that
 * implies AUTO + IDEATE and is the most consequential posture an agent can be
 * put into — was invisible to every agent whose knowledge of the mode system is
 * this index. Adding TEST would have made it seven against five.
 *
 * Nothing failed when that happened. A missing mode does not error; it simply
 * never gets used, which is indistinguishable from a mode nobody wanted. This
 * test is the mechanical relationship the hand-written list lacks.
 *
 * PLACEMENT IS LOAD-BEARING: it lives in packages/operator-core so that
 * `test:affected` selects it when modes/registry.ts changes. In apps/operator
 * (where the prompts live) a registry edit would not select it, and the guard
 * would only run by luck — the docs are in one workspace, the truth is in
 * another, and the change that breaks the claim happens in the second.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODES } from '../modes/registry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Every playbook that carries a hand-written mode index. */
const PLAYBOOKS = [
  'apps/operator/prompts/papercusp-su-engineer.tools.md',
  'apps/operator/prompts/papercusp-su-power.tools.md',
] as const;

/**
 * The index bullets, as the playbook actually writes them:
 *   `- **auto** (autonomy): act on your own judgment; …`
 *
 * Scoping to this shape is the whole point. A naive
 * `expect(content).toContain('goal')` passes on any playbook that says "goal"
 * anywhere in prose — and both of these say it dozens of times — so the cheap
 * assertion would have reported the drift as absent for as long as it existed.
 * A mode counts as listed only when it has its OWN bullet.
 */
const INDEX_BULLET = /^- \*\*([a-z][a-z-]*)\*\* \((autonomy|overlay)\):/gm;

function indexedModes(relPath: string): { ids: string[]; axes: Map<string, string> } {
  const content = readFileSync(resolve(ROOT, relPath), 'utf8');
  const ids: string[] = [];
  const axes = new Map<string, string>();
  for (const m of content.matchAll(INDEX_BULLET)) {
    ids.push(m[1]);
    axes.set(m[1], m[2]);
  }
  return { ids, axes };
}

describe('su playbook mode index', () => {
  for (const relPath of PLAYBOOKS) {
    describe(relPath, () => {
      /**
       * ZERO WORK IS NOT A PASS. Every assertion below iterates the parsed
       * bullets, and every one of them passes vacuously if the parse finds
       * nothing — a renamed file, a reformatted index, or a regex that stopped
       * matching would all read as green. Assert the population FIRST, so a
       * guard that measured nothing fails instead of congratulating us.
       */
      it('actually parses an index (a zero-bullet parse is a broken guard, not a pass)', () => {
        const { ids } = indexedModes(relPath);
        expect(ids.length).toBeGreaterThanOrEqual(MODES.length);
      });

      it('lists EVERY registered mode — a mode absent here is invisible to agents', () => {
        const { ids } = indexedModes(relPath);
        const missing = MODES.map((m) => m.id).filter((id) => !ids.includes(id));
        expect(missing, `not listed in ${relPath}`).toEqual([]);
      });

      it('lists no mode that the registry does not define', () => {
        const { ids } = indexedModes(relPath);
        const registryIds = new Set(MODES.map((m) => m.id));
        expect(ids.filter((id) => !registryIds.has(id))).toEqual([]);
      });

      it('states each mode on the axis the registry gives it', () => {
        const { axes } = indexedModes(relPath);
        for (const def of MODES) {
          expect(axes.get(def.id), `${def.id} axis in ${relPath}`).toBe(def.axis);
        }
      });

      it('lists each mode exactly once', () => {
        const { ids } = indexedModes(relPath);
        expect(new Set(ids).size, `duplicate bullet in ${relPath}`).toBe(ids.length);
      });
    });
  }

  /**
   * The playbooks are maintained by copy-paste between the two roles, so they
   * drift from EACH OTHER as readily as from the registry — and a per-file loop
   * cannot see that, because each file is checked in isolation.
   */
  it('keeps both playbooks in agreement with each other', () => {
    const [engineer, power] = PLAYBOOKS.map((p) => indexedModes(p).ids);
    expect(power).toEqual(engineer);
  });
});
