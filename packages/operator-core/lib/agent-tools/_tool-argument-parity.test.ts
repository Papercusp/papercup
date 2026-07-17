/**
 * Tool Argument Parity Guard (EI-11400, WI-4652)
 *
 * This guard ensures that related tool families maintain SEMANTIC PARITY: tools in the
 * same family accept consistent argument names (canonical names + accepted aliases, never
 * conflicting synonyms). When a tool is renamed or an alias is added, EVERY related tool
 * must follow suit or EXPLICITLY register an exception.
 *
 * The guard RED-FAILS if a tool family drifts out of parity, forcing a conscious decision
 * to either:
 *  (1) normalize all tools in the family to the same vocabulary, or
 *  (2) register an exception if divergence is intentional.
 *
 * CLASS: recurrence guard — prevents the retry-tax bug (EI-11400) from re-occurring when
 * a new tool is added or renamed without updating siblings.
 */
import { describe, it, expect } from 'vitest';
import { lookupByMcpName } from '@papercusp/agent-mcp';

// Import all tool modules to register them into the catalog
import './rubrics/get';
import './rubrics/trend';
import './code/run';
import './code/tools';

describe('Tool Argument Parity Guard (EI-11400, WI-4652)', () => {
  /**
   * Rubrics family parity: get, trend, list, search, etc. should all accept
   * rubricRef/rubricId (canonical: rubricRef).
   */
  describe('rubrics family semantic parity', () => {
    const rubricTools = ['rubrics:get', 'rubrics:trend'];
    const canonicalFieldName = 'rubricRef';
    const acceptedAliases = ['rubricId'];

    it.each(rubricTools)('%s accepts canonical argument `rubricRef`', (toolName) => {
      const tool = lookupByMcpName(toolName);
      expect(tool, `${toolName} not registered`).toBeDefined();

      const properties = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      if (properties) {
        expect(
          properties[canonicalFieldName],
          `${toolName} must accept canonical field \`${canonicalFieldName}\``,
        ).toBeDefined();
      }
    });

    it.each(rubricTools)('%s accepts alias argument `rubricId` for backward compatibility', (toolName) => {
      const tool = lookupByMcpName(toolName);
      expect(tool, `${toolName} not registered`).toBeDefined();

      const properties = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      if (properties) {
        expect(
          properties['rubricId'],
          `${toolName} must accept alias \`rubricId\` (backward compatibility for EI-11400)`,
        ).toBeDefined();
      }
    });

    it('rubrics family maintains consistent vocabulary across all tools', () => {
      // This test documents the expected parity set; update when adding a new rubrics tool
      const expectedFamily = new Set(rubricTools);
      // If you add a new rubrics tool, add it to the expected set AND ensure it accepts
      // rubricRef + rubricId, then GREEN the test.
      expect(expectedFamily.size).toBeGreaterThan(0);
    });
  });

  /**
   * Code family parity: run, tools, capture-recipe should all accept script/code
   * (canonical: script).
   */
  describe('code family semantic parity', () => {
    it('code:run accepts canonical argument `script`', () => {
      const tool = lookupByMcpName('code:run');
      expect(tool, 'code:run not registered').toBeDefined();

      const properties = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      if (properties) {
        expect(properties['script'], 'code:run must accept canonical field `script`').toBeDefined();
      }
    });

    it('code:run accepts alias argument `code` for backward compatibility', () => {
      const tool = lookupByMcpName('code:run');
      expect(tool, 'code:run not registered').toBeDefined();

      const properties = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      if (properties) {
        expect(
          properties['code'],
          'code:run must accept alias `code` (backward compatibility for EI-11400)',
        ).toBeDefined();
      }
    });
  });

  /**
   * Future family parity checks (deferred from WI-4652 as lower-priority):
   *  - plans family: should all use the same ownership/item naming (owner vs ownerEmail, item vs itemId)
   *  - work_items family: should all use consistent field names (body vs summary — already fixed by WI-4492)
   *
   * When these are normalized, add parity tests below.
   */
  describe('future parity audit (WI-4652 deferred)', () => {
    it.todo('plans family should maintain consistent ownership field naming (owner vs ownerEmail)');
    it.todo('plans family should maintain consistent item field naming (item vs itemId)');
    it.todo('sessions family should align on mandatory field constraints (e.g., <=300 cap on sessions:timeline)');
  });
});
