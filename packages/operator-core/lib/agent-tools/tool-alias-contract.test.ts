/**
 * tool-contract-repair-2026-09-05 P-009 — the class-wide argument-contract guard.
 *
 * Two halves, deliberately:
 *
 *  - LIVE: run the scanner over the real projected catalog. This is the guard.
 *  - CONTROLS: run the same scanner over deliberately-broken synthetic tools
 *    kept permanently in this file. Without them a green here is worthless —
 *    a scanner that can never report anything is indistinguishable from a
 *    catalog that is clean. Mutating a real tool to prove the point is
 *    forbidden on this shared tree (the git-sync sweep commits whatever is on
 *    disk when it fires), so the wrong implementations live here instead.
 */
import { describe, it, expect } from 'vitest';

import './index';
import { listAllProjectedTools } from '@papercusp/tooldef';

import { MIN_PLAUSIBLE_CATALOG_SIZE } from './tool-guidance-budget';
import {
  scanToolAliases,
  toAliasScannableTool,
  formatAliasIssues,
  STRICT_ALIAS_DECLARATION_FLOOR,
  type AliasScannableTool,
} from './tool-alias-contract';

function liveScannableTools(): AliasScannableTool[] {
  const catalog = listAllProjectedTools();

  // The vacuous-green trap this whole file exists to avoid: an unregistered
  // catalog scans clean and reports zero issues, which reads exactly like a
  // healthy result. Borrow tool-guidance-budget's floor rather than inventing
  // a second one (EI-19377066316560032).
  expect(
    catalog.length,
    `listAllProjectedTools() returned only ${catalog.length} tool(s), far below the ` +
      `${MIN_PLAUSIBLE_CATALOG_SIZE}-tool floor. The agent-tools barrel did not register, so every assertion ` +
      `below would pass over an EMPTY catalog. Run this through vitest (which side-effect-imports './index'), ` +
      `not a standalone tsx probe.`,
  ).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_CATALOG_SIZE);

  return catalog.map(toAliasScannableTool).filter((t): t is AliasScannableTool => t !== null);
}

describe('tool argument aliases — class-wide contract (P-009)', () => {
  it('every documented alias names a real, usable canonical field', () => {
    const scan = scanToolAliases(liveScannableTools());

    expect(
      scan.issues,
      scan.issues.length === 0
        ? ''
        : `${scan.issues.length} tool(s) document an argument alias that a caller cannot actually rely on:\n` +
          `${formatAliasIssues(scan.issues)}\n\n` +
          `Each is the argument-contract defect class (tool-contract-repair-2026-09-05): the description promises ` +
          `a spelling the schema does not honour. Fix the schema or the description — do not delete the alias.`,
    ).toEqual([]);
  });

  it('the declared-alias population has not shrunk below its floor', () => {
    const scan = scanToolAliases(liveScannableTools());

    expect(
      scan.declarations.length,
      `Only ${scan.declarations.length} backticked alias declarations remain, below the floor of ` +
        `${STRICT_ALIAS_DECLARATION_FLOOR}. An alias repair was REMOVED — the one regression shape a scan over ` +
        `fields-that-still-exist cannot see directly. If the removal was deliberate (the tool itself was retired), ` +
        `lower STRICT_ALIAS_DECLARATION_FLOOR in tool-alias-contract.ts and say why in the commit; if it was not, ` +
        `restore the alias. Never lower the floor just to get green.`,
    ).toBeGreaterThanOrEqual(STRICT_ALIAS_DECLARATION_FLOOR);
  });

  it('reports the population it measured, so a silent collapse to zero is visible', () => {
    const scan = scanToolAliases(liveScannableTools());

    // A scan that matched nothing at all would satisfy "no issues" vacuously.
    expect(scan.toolsWithAliases).toBeGreaterThan(0);
    expect(scan.declarations.length).toBeGreaterThanOrEqual(scan.toolsWithAliases);
  });
});

/**
 * CONTROLS — the wrong implementations. Each asserts the scanner CAN fail, so
 * the live green above means something. Do not delete these to "clean up".
 */
describe('tool argument aliases — detector controls (must stay falsifiable)', () => {
  const tool = (
    name: string,
    properties: AliasScannableTool['properties'],
    required?: string[],
  ): AliasScannableTool => ({ name, properties, required });

  it('CATCHES a dangling canonical (the shape a rename leaves behind)', () => {
    const scan = scanToolAliases([
      tool('demo:renamed', {
        legacyName: { description: 'Compatibility alias for `newName`.' },
        // `newName` was renamed away and the alias was left pointing at nothing.
        currentName: { description: 'The actual field.' },
      }),
    ]);

    expect(scan.issues).toHaveLength(1);
    expect(scan.issues[0]!.kind).toBe('dangling-canonical');
    expect(scan.issues[0]!.canonical).toBe('newName');
  });

  it('CATCHES a documented-but-unusable alias whose canonical is required', () => {
    const scan = scanToolAliases([
      tool(
        'demo:unusable',
        {
          q: { description: 'Compatibility alias for `query`.' },
          query: { description: 'The search text.' },
        },
        ['query'],
      ),
    ]);

    expect(scan.issues.map((i) => i.kind)).toEqual(['canonical-required']);
  });

  it('CATCHES an alias that has itself become required', () => {
    const scan = scanToolAliases([
      tool(
        'demo:inverted',
        {
          legacy: { description: 'Compatibility alias for `canonical`.' },
          canonical: { description: 'The real one.' },
        },
        ['legacy'],
      ),
    ]);

    expect(scan.issues.map((i) => i.kind)).toEqual(['alias-required']);
  });

  it('does NOT fire on healthy aliases — the controls above are the scanner working, not noise', () => {
    const scan = scanToolAliases([
      tool('demo:healthy', {
        unanswered: { description: 'Compatibility alias for `unanswered_only`.' },
        unanswered_only: { description: 'The canonical filter.' },
      }),
    ]);

    expect(scan.issues).toEqual([]);
    expect(scan.declarations).toEqual([
      { tool: 'demo:healthy', field: 'unanswered', canonical: 'unanswered_only' },
    ]);
  });

  it('ignores prose that says "alias" without a backticked target', () => {
    // The measured false-positive shape: "alias for the persisted measurement"
    // captured `persisted` under a loose regex and would have redded the gate.
    const scan = scanToolAliases([
      tool('demo:prose', {
        measurement: { description: 'Optional alias for the persisted measurement this fact records.' },
        persisted: { description: 'Unrelated real field.' },
        other: { description: 'An alias of the thing above, loosely speaking.' },
      }),
    ]);

    expect(scan.issues).toEqual([]);
    expect(scan.declarations).toEqual([]);
    expect(scan.looseMentions).toBe(2);
  });

  it('counts declarations per tool so the floor cannot be gamed by one tool', () => {
    const scan = scanToolAliases([
      tool('demo:a', {
        x: { description: 'alias for `y`' },
        y: { description: 'canonical' },
      }),
      tool('demo:b', {
        p: { description: 'Compatibility alias of `q`.' },
        q: { description: 'canonical' },
      }),
    ]);

    expect(scan.declarations).toHaveLength(2);
    expect(scan.toolsWithAliases).toBe(2);
  });

  it('adapter refuses an unexposed or schema-less catalog entry rather than inventing a name', () => {
    expect(toAliasScannableTool({ inputSchema: { properties: {} } })).toBeNull();
    expect(toAliasScannableTool({ expose: { mcp: { name: 'demo:x' } } })).toBeNull();
    expect(toAliasScannableTool(undefined)).toBeNull();
    expect(toAliasScannableTool({ expose: { mcp: { name: 'demo:x' } }, inputSchema: { properties: {} } })).toEqual({
      name: 'demo:x',
      properties: {},
      required: undefined,
    });
  });
});
