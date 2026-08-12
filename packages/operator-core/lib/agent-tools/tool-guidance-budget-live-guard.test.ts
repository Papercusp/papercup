/**
 * tool-guidance-budget-live-guard.test.ts — EI-19377066316560032.
 *
 * `namedToolWeights()` / `budgetViolations()` called with NO explicit catalog
 * read the LIVE registry (`listAllProjectedTools()`). Outside the vitest
 * bootstrap (no `import '../agent-tools/index'` side-effect having run —
 * exactly what a standalone `npx tsx -e "...listAllProjectedTools()..."` probe
 * does) that call returns `[]`, and the old code silently reported "0 tools,
 * 0 violations" — a vacuous green indistinguishable from a genuinely clean
 * 655-tool catalog. This asserts the fix: reading the live registry now
 * THROWS when the catalog looks unregistered/partial, at every plausible size
 * an under-registration failure could produce.
 *
 * An EXPLICITLY-passed fixture catalog (what every other test in this file
 * family uses, e.g. tool-weight-selfcheck.test.ts's `weights` arrays) is
 * exempt — a deliberately small fixture there is a normal, valid input, not a
 * mis-registered live registry, so the guard must not fire on it.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ProjectedTool } from '@papercusp/tooldef';

const listAllProjectedToolsMock = vi.hoisted(() => vi.fn());

vi.mock('@papercusp/tooldef', () => ({
  listAllProjectedTools: listAllProjectedToolsMock,
}));

import { namedToolWeights, budgetViolations, MIN_PLAUSIBLE_CATALOG_SIZE } from './tool-guidance-budget';

function fixtureCatalog(n: number): ProjectedTool[] {
  return Array.from({ length: n }, (_, i) => ({
    expose: { mcp: { name: `t${i}` } },
    description: 'x',
  })) as unknown as ProjectedTool[];
}

describe('reading the live registry throws on an unregistered/partial catalog (EI-19377066316560032)', () => {
  it('namedToolWeights() throws when listAllProjectedTools() returns []', () => {
    listAllProjectedToolsMock.mockReturnValue([]);
    expect(() => namedToolWeights()).toThrow(/only 0 tool\(s\)/);
    expect(() => namedToolWeights()).toThrow(/outside the vitest bootstrap/);
    expect(() => namedToolWeights()).toThrow(
      /npm run test:file -- packages\/operator-core\/lib\/__tests__\/tool-guidance-budget\.test\.ts packages\/operator-core\/lib\/agent-tools\/tool-guidance-budget-live-guard\.test\.ts/,
    );
    expect(() => namedToolWeights()).not.toThrow(/lib\/agent-tools\/tool-guidance-budget\.test\.ts/);
  });

  it('namedToolWeights() throws on an implausibly-small (partial barrel registration) catalog', () => {
    listAllProjectedToolsMock.mockReturnValue(fixtureCatalog(40));
    expect(() => namedToolWeights()).toThrow(
      new RegExp(`only 40 tool\\(s\\)[\\s\\S]*${MIN_PLAUSIBLE_CATALOG_SIZE}-tool floor`),
    );
  });

  it('namedToolWeights() does NOT throw once the live catalog clears the floor', () => {
    listAllProjectedToolsMock.mockReturnValue(fixtureCatalog(MIN_PLAUSIBLE_CATALOG_SIZE));
    expect(() => namedToolWeights()).not.toThrow();
    expect(namedToolWeights()).toHaveLength(MIN_PLAUSIBLE_CATALOG_SIZE);
  });

  it('budgetViolations() with no args inherits the same guard (it falls through to namedToolWeights())', () => {
    listAllProjectedToolsMock.mockReturnValue([]);
    expect(() => budgetViolations()).toThrow(/only 0 tool\(s\)/);
  });

  it('an EXPLICITLY-passed fixture catalog is exempt, even while the mocked live registry is empty', () => {
    listAllProjectedToolsMock.mockReturnValue([]); // the (irrelevant) live registry
    const small = fixtureCatalog(3);
    expect(() => namedToolWeights(small)).not.toThrow();
    expect(namedToolWeights(small)).toHaveLength(3);
    expect(() => budgetViolations(namedToolWeights(small))).not.toThrow();
  });
});
