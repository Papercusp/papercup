// @vitest-environment node
/**
 * Drift-guard: EVERY memory:* tool must be cross-workspace (EI-177/178/210).
 *
 * The memory store is workspace-AGNOSTIC by design — its tables are scoped by
 * user-id / harness-slug, never by a workspace transaction. So a memory tool
 * that omits `crossWorkspace: true` is rejected by the projected gate with
 * `workspace_required` on any UNSCOPED psu / fleet session — which is exactly
 * the fleet-wide breakage the watchdog filed (memory:search EI-177,
 * memory:remember EI-178, memory:list EI-210). search + remember were fixed
 * earlier; list/update/forget had silently regressed/never carried it.
 *
 * This guard imports the REAL tool defs (definePrincipalGatedTool THREADS
 * crossWorkspace onto the def) and asserts the flag on each — so a NEW memory
 * tool, or a refactor that drops the flag, fails here instead of in the fleet.
 */
import { describe, it, expect } from 'vitest';
import search from './search';
import remember from './remember';
import list from './list';
import update from './update';
import forget from './forget';

describe('memory:* tools are all cross-workspace (EI-177/178/210 drift-guard)', () => {
  const tools: Array<readonly [string, unknown]> = [
    ['memory:search', search],
    ['memory:remember', remember],
    ['memory:list', list],
    ['memory:update', update],
    ['memory:forget', forget],
  ];
  for (const [name, tool] of tools) {
    it(`${name} declares crossWorkspace:true (reachable from an unscoped session)`, () => {
      expect((tool as { crossWorkspace?: boolean }).crossWorkspace).toBe(true);
    });
  }
});
